/**
 * End-to-end test of the members-only group send path.
 *
 * The test drives the REAL socket stack — makeSocket → messages-recv →
 * messages-send — with only the transport swapped for a recorder. That means
 * `relayMessage` runs unmodified: real group metadata query, real USync device
 * discovery, real Signal pairwise and Sender Key encryption, real binary
 * encoding. The recorded frames are decoded with the fork's own decoder.
 *
 * Pairwise sessions are real too: the test generates a device's key material,
 * injects the public bundle through `signalRepository.injectE2ESession`, and
 * later decrypts what was addressed to that device with its own private keys.
 * So "the member got the Sender Key and the admin did not" is measured, not
 * assumed.
 *
 * Run: node tests/members-only-send.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { proto } from '../WAProto/index.js';
import { makeMessagesRecvSocket } from '../lib/Socket/messages-recv.js';
import { makeCacheableSignalKeyStore, initAuthCreds } from '../lib/Utils/auth-utils.js';
import { generateWAMessageFromContent } from '../lib/Utils/messages.js';
import { unpadRandomMax16 } from '../lib/Utils/generics.js';
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js';
import { decodeBinaryNode, binaryNodeToString } from '../lib/WABinary/index.js';
import { NOISE_WA_HEADER } from '../lib/Defaults/index.js';
import { Browsers } from '../lib/Utils/browser-utils.js';
import { WebSocketClient } from '../lib/Socket/Client/index.js';
import { GroupSessionBuilder, GroupCipher, SenderKeyName, SenderKeyRecord, SenderKeyDistributionMessage } from '../lib/Signal/Group/index.js';
import { makeRemoteDevice } from './helpers/test-signal-sessions.js';
import { createRequire } from 'node:module';
import pino from 'pino';

const require = createRequire(import.meta.url);
const { ProtocolAddress } = require('libsignal');

const logger = pino({ level: process.env.LOGLEVEL ?? 'silent' });
const GROUP = '120363000000000001@g.us';
const ME = '5511900000001@s.whatsapp.net';
const ME_LID = '100000000000001@lid';

const makeKeys = () => {
  const data = {};
  return {
    get: async (type, ids) => {
      const out = {};
      for (const id of ids) {
        out[id] = data[`${type}:${id}`];
      }
      return out;
    },
    set: async (patch) => {
      for (const [type, entries] of Object.entries(patch)) {
        for (const [id, value] of Object.entries(entries)) {
          if (value === null) delete data[`${type}:${id}`];
          else data[`${type}:${id}`] = value;
        }
      }
    }
  };
};

/** A group participant: PN, LID, device ids and optional admin role. */
const participant = (pn, devices, { lid, admin } = {}) => ({ pn, lid, devices, admin });

/**
 * Decode a frame the library wrote: `[intro header][3-byte length][node]`.
 * The intro header is only present on the first frame of a connection, and this
 * socket never completes a Noise handshake, so that is simply frame index 0.
 */
const readFrameNode = (buffer, first) => {
  const offset = first && buffer.subarray(0, NOISE_WA_HEADER.length).equals(NOISE_WA_HEADER)
    ? NOISE_WA_HEADER.length
    : 0;
  const length = buffer.readUIntBE(offset, 3);
  return decodeBinaryNode(buffer.subarray(offset + 3, offset + 3 + length));
};

/**
 * Answers the IQs the send path issues. They are fed back through the socket's
 * own message loop, so `query`, `sendNode` and the codec all stay real.
 */
const buildQueryResponder = (participants) => {
  const devicesByUser = new Map();
  for (const p of participants) {
    for (const jid of [p.lid, p.pn].filter(Boolean)) {
      const user = jid.split('@')[0].split(':')[0];
      devicesByUser.set(user, p.devices);
    }
  }
  const groupParticipants = participants.map(p => ({
    id: p.lid ?? p.pn,
    phoneNumber: p.pn,
    ...(p.admin ? { admin: p.admin } : {})
  }));

  return (node) => {
    if (node.attrs.xmlns === 'w:g2') {
      return {
        tag: 'iq',
        attrs: { type: 'result' },
        content: [{
          tag: 'group',
          attrs: { id: GROUP, addressing_mode: 'lid', subject: 'test group' },
          content: groupParticipants.map(p => ({
            tag: 'participant',
            attrs: { jid: p.id, ...(p.admin ? { type: p.admin } : {}) }
          }))
        }]
      };
    }
    if (node.attrs.xmlns === 'usync') {
      const usyncNode = (node.content ?? []).find(c => c.tag === 'usync');
      const listNode = (usyncNode?.content ?? []).find(c => c.tag === 'list');
      const users = (listNode?.content ?? []).map(userNode => {
        const jid = userNode.attrs.jid;
        const user = jid.split('@')[0].split(':')[0];
        return {
          tag: 'user',
          attrs: { jid },
          content: [{
            tag: 'devices',
            attrs: {},
            content: [{
              tag: 'device-list',
              attrs: {},
              // `key-index` is required by the library for every listed device.
              content: (devicesByUser.get(user) ?? []).map(device => ({
                tag: 'device',
                attrs: { id: String(device), 'key-index': '1' }
              }))
            }]
          }]
        };
      });
      return {
        tag: 'iq',
        attrs: { type: 'result' },
        content: [{ tag: 'usync', attrs: {}, content: [{ tag: 'list', attrs: {}, content: users }] }]
      };
    }
    return { tag: 'iq', attrs: { type: 'result' }, content: [] };
  };
};

/**
 * Boot the real socket stack, wire real pairwise sessions, send one message, and
 * return the captured frames plus the remote device key material.
 */
const sendAndCapture = async ({ participants, content, options = {}, msgId = 'MSG-1' }) => {
  const creds = initAuthCreds();
  creds.me = { id: ME, lid: ME_LID, name: 'test' };
  const keys = makeCacheableSignalKeyStore(makeKeys(), logger);

  const sent = [];
  const responder = buildQueryResponder(participants);
  WebSocketClient.prototype.connect = function connect() {
    const client = this;
    this.socket = {
      readyState: 1,
      send: (frame, cb) => {
        const bytes = Buffer.from(frame);
        sent.push(bytes);
        cb?.(null);
        // Decoding is async, and a real server answers on a later tick anyway.
        void readFrameNode(bytes, sent.length === 1).then(node => {
          if (node?.tag === 'iq' && node.attrs?.id) {
            const response = responder(node);
            if (response) client.emit(`TAG:${node.attrs.id}`, response);
          }
        });
        return true;
      },
      on: () => {},
      off: () => {},
      setMaxListeners: () => {},
      close: () => {},
      once: (event, cb) => {
        if (event === 'close') setImmediate(cb);
      }
    };
  };

  const sock = makeMessagesRecvSocket({
    logger,
    auth: { creds, keys },
    waWebSocketUrl: 'ws://127.0.0.1:9/',
    makeSignalRepository: makeLibSignalRepository,
    shouldIgnoreJid: () => false,
    getMessage: async () => undefined,
    patchMessageBeforeSending: msg => msg,
    browser: Browsers.macOS('Chrome'),
    shouldSyncHistoryMessage: () => false,
    keepAliveIntervalMs: 60_000,
    transactionOpts: { maxCommitRetries: 2, delayBetweenTriesMs: 1 },
    connectTimeoutMs: 5_000,
    options: {}
  });

  try {
    await new Promise(resolve => setTimeout(resolve, 20));

    // Devices come back addressed by LID (the group's addressing mode), so a
    // session must exist for the LID form of each device.
    const signalRepository = sock.signalRepository;
    signalRepository.validateSession = async () => ({ exists: true });
    const remotes = new Map();
    for (const p of participants) {
      for (const base of [p.lid, p.pn].filter(Boolean)) {
        const user = base.split('@')[0].split(':')[0];
        const server = base.split('@')[1];
        for (const device of p.devices) {
          const remote = makeRemoteDevice(user, device);
          remotes.set(`${user}.${device}`, remote);
          const jid = device === 0 ? base : `${user}:${device}@${server}`;
          await signalRepository.injectE2ESession({ jid, session: remote.bundle });
        }
      }
    }

    const msg = generateWAMessageFromContent(GROUP, { conversation: content }, {
      userJid: ME,
      messageId: msgId
    });
    await sock.relayMessage(GROUP, msg.message, { messageId: msgId, ...options });

    return { sent, remotes };
  } finally {
    await sock.ws.close().catch(() => {});
  }
};

/** The `<message>` stanza among the captured frames (IQ frames are ignored). */
const readMessageStanza = async (frames) => {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const node = await readFrameNode(frames[i], i === 0);
    if (node?.tag === 'message') return node;
  }
  throw new Error('no message stanza was captured');
};

const shortUser = jid => jid.split('@')[0].split(':')[0];

/** `{ jid, type, ciphertext }` for every `<to>` node inside `<participants>`. */
const readRecipients = (stanza) => {
  const participantsNode = (stanza.content ?? []).find(n => n.tag === 'participants');
  return (participantsNode?.content ?? []).map(to => {
    const enc = (to.content ?? []).find(n => n.tag === 'enc');
    return { jid: to.attrs.jid, type: enc?.attrs?.type, ciphertext: enc?.content };
  });
};

/** The type-`skmsg` `<enc>` carried on the stanza itself. */
const readSkmsg = (stanza) => {
  const enc = (stanza.content ?? []).find(n => n.tag === 'enc');
  return enc && { type: enc.attrs.type, attrs: enc.attrs, ciphertext: enc.content };
};

/** Decrypt a `<to>` node with the recipient device's own pairwise session. */
const decryptFor = async (recipient, remotes) => {
  const [user, device] = recipient.jid.split('@')[0].split(':');
  const remote = remotes.get(`${user}.${device ?? 0}`);
  assert.ok(remote, `no remote keys for ${recipient.jid}`);
  const plaintext = unpadRandomMax16(await remote.decrypt(recipient.ciphertext, recipient.type));
  return proto.Message.decode(plaintext);
};

describe('members-only group message', () => {
  it('addresses only the non-admin participants, never the admins', async () => {
    const participants = [
      participant('5511900000010@s.whatsapp.net', [0], { lid: '100000000000010@lid', admin: 'superadmin' }),
      participant('5511900000011@s.whatsapp.net', [0], { lid: '100000000000011@lid', admin: 'admin' }),
      participant('5511900000012@s.whatsapp.net', [0], { lid: '100000000000012@lid' }),
      participant('5511900000013@s.whatsapp.net', [0], { lid: '100000000000013@lid' })
    ];

    const { sent } = await sendAndCapture({
      participants,
      content: 'membros apenas',
      options: { recipientMode: 'members-only' }
    });

    const stanza = await readMessageStanza(sent);
    if (process.env.DUMP) console.log(binaryNodeToString(stanza));
    const targets = readRecipients(stanza).map(r => shortUser(r.jid)).sort();

    assert.deepEqual(
      targets,
      ['100000000000012', '100000000000013'],
      'exactly the two members — neither admin is addressed'
    );
  });

  it('gives members the Sender Key distribution and admins nothing', async () => {
    const participants = [
      participant('5511900000020@s.whatsapp.net', [0], { lid: '100000000000020@lid', admin: 'admin' }),
      participant('5511900000021@s.whatsapp.net', [0], { lid: '100000000000021@lid' })
    ];

    const { sent, remotes } = await sendAndCapture({
      participants,
      content: 'oi membros',
      options: { recipientMode: 'members-only' }
    });

    const stanza = await readMessageStanza(sent);
    const recipients = readRecipients(stanza);

    assert.equal(
      recipients.find(r => shortUser(r.jid) === '100000000000020'),
      undefined,
      'the admin is not addressed at all'
    );

    const member = recipients.find(r => shortUser(r.jid) === '100000000000021');
    assert.ok(member, 'the member is addressed');

    // Decrypting with the member's private keys proves the node really carries
    // the sender key distribution message.
    const inner = await decryptFor(member, remotes);
    const skdm = inner.senderKeyDistributionMessage;
    assert.ok(skdm, 'the member received a senderKeyDistributionMessage');
    assert.equal(skdm.groupId, GROUP);
    assert.ok(skdm.axolotlSenderKeyDistributionMessage?.length > 0, 'with an axolotl payload');

    assert.equal(
      remotes.has('100000000000020.0'),
      true,
      'the admin has key material, so the only reason it is silent is the recipient list'
    );
  });

  it('carries the group ciphertext as skmsg with decrypt-fail set', async () => {
    const participants = [
      participant('5511900000030@s.whatsapp.net', [0], { lid: '100000000000030@lid', admin: 'admin' }),
      participant('5511900000031@s.whatsapp.net', [0], { lid: '100000000000031@lid' })
    ];
    const { sent } = await sendAndCapture({
      participants,
      content: 'x',
      options: { recipientMode: 'members-only' }
    });
    const skmsg = readSkmsg(await readMessageStanza(sent));
    assert.equal(skmsg.type, 'skmsg');
    assert.equal(skmsg.attrs['decrypt-fail'], 'hide', 'clients hide the undecryptable entry');
    assert.ok(skmsg.ciphertext?.length > 0);
  });

  it('lets the member decrypt the group ciphertext with the delivered Sender Key', async () => {
    const participants = [
      participant('5511900000040@s.whatsapp.net', [0], { lid: '100000000000040@lid', admin: 'admin' }),
      participant('5511900000041@s.whatsapp.net', [0], { lid: '100000000000041@lid' })
    ];
    const { sent, remotes } = await sendAndCapture({
      participants,
      content: 'conteudo reservado',
      options: { recipientMode: 'members-only' }
    });
    const stanza = await readMessageStanza(sent);
    const member = readRecipients(stanza).find(r => shortUser(r.jid) === '100000000000041');
    assert.ok(member, 'member addressed');

    const skdm = (await decryptFor(member, remotes)).senderKeyDistributionMessage;
    assert.ok(skdm, 'member got the Sender Key');

    // Feed the SKDM into a group session and decrypt the skmsg — the flow the
    // receiving client performs. The group is in LID addressing mode, so the
    // sender is our own LID address.
    const record = new SenderKeyRecord();
    const store = {
      loadSenderKey: async () => record,
      storeSenderKey: async (_name, key) => {
        record.senderKeyStates = key.senderKeyStates;
      }
    };
    const senderName = new SenderKeyName(GROUP, new ProtocolAddress(shortUser(ME_LID), 0));
    const builder = new GroupSessionBuilder(store);
    await builder.process(senderName, new SenderKeyDistributionMessage(
      null, null, null, null, skdm.axolotlSenderKeyDistributionMessage
    ));
    const plaintext = await new GroupCipher(store, senderName).decrypt(readSkmsg(stanza).ciphertext);
    const message = proto.Message.decode(unpadRandomMax16(plaintext));
    assert.equal(message.conversation, 'conteudo reservado', 'the member reads the message');
  });

  it('leaves a normal group message reaching everyone', async () => {
    const participants = [
      participant('5511900000050@s.whatsapp.net', [0], { lid: '100000000000050@lid', admin: 'admin' }),
      participant('5511900000051@s.whatsapp.net', [0], { lid: '100000000000051@lid' })
    ];
    const { sent } = await sendAndCapture({ participants, content: 'normal' });
    const stanza = await readMessageStanza(sent);
    const targets = readRecipients(stanza).map(r => shortUser(r.jid)).sort();
    assert.deepEqual(targets, ['100000000000050', '100000000000051']);
    assert.equal(readSkmsg(stanza).attrs['decrypt-fail'], undefined, 'no hiding on normal messages');
  });

  it('supports admins-only as the inverse', async () => {
    const participants = [
      participant('5511900000060@s.whatsapp.net', [0], { lid: '100000000000060@lid', admin: 'admin' }),
      participant('5511900000061@s.whatsapp.net', [0], { lid: '100000000000061@lid' })
    ];
    const { sent } = await sendAndCapture({
      participants,
      content: 'so admins',
      options: { recipientMode: 'admins-only' }
    });
    const targets = readRecipients(await readMessageStanza(sent)).map(r => shortUser(r.jid)).sort();
    assert.deepEqual(targets, ['100000000000060']);
  });

  it('supports an explicit recipient list', async () => {
    const participants = [
      participant('5511900000070@s.whatsapp.net', [0], { lid: '100000000000070@lid', admin: 'admin' }),
      participant('5511900000071@s.whatsapp.net', [0], { lid: '100000000000071@lid' }),
      participant('5511900000072@s.whatsapp.net', [0], { lid: '100000000000072@lid' })
    ];
    const { sent } = await sendAndCapture({
      participants,
      content: 'so um',
      options: { recipientParticipants: ['100000000000072@lid'] }
    });
    const targets = readRecipients(await readMessageStanza(sent)).map(r => shortUser(r.jid)).sort();
    assert.deepEqual(targets, ['100000000000072']);
  });

  it('refuses rather than falling back when the restriction matches nobody', async () => {
    const participants = [
      participant('5511900000080@s.whatsapp.net', [0], { lid: '100000000000080@lid', admin: 'admin' })
    ];
    await assert.rejects(
      sendAndCapture({ participants, content: 'x', options: { recipientMode: 'members-only' } }),
      /matched no participant/
    );
  });
});
