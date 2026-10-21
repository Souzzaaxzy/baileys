/**
 * FORMA 6 — a FRESH Sender Key per send: does it actually keep admins out?
 *
 * The sibling test (`members-only-leak.test.js`) proves the leak: restricting
 * the fan-out alone is not enough, because `GroupSessionBuilder.create()`
 * REUSES the existing Sender Key. A participant that received the key once
 * decrypts every later message, restricted or not.
 *
 * This test drives `sendGroupMessageWithFreshSenderKey`, which DISCARDS the
 * local Sender Key before sending. The next `create()` therefore mints a new
 * key id / chain key / signing pair, and only the restricted fan-out ever sees
 * it. The assertion is the mirror image of the leak test: the excluded admin
 * must FAIL to decrypt, and the intended member must SUCCEED.
 *
 * Run: node tests/fresh-sender-key.test.js
 *
 * The members-only mechanism narrows the *distribution* of the Sender Key: the
 * devices of excluded participants are not enumerated, so they receive no
 * `<to>` node with a Sender Key Distribution Message. The question this test
 * answers is whether that is enough, given that:
 *
 *   - the stanza is still addressed to the GROUP, so the `<enc type="skmsg">`
 *     ciphertext reaches every member through the server, and
 *   - `GroupSessionBuilder.create()` REUSES an existing Sender Key (it only
 *     generates one when the record is empty), and
 *   - `GroupCipher.getSenderKey()` ratchets the SAME chain forward.
 *
 * So a participant who received the Sender Key from an earlier normal message
 * still holds it, and can attempt to decrypt a later members-only message.
 *
 * This test drives the real send path twice (a normal send, then a restricted
 * send) and then, for BOTH a plain member and an excluded admin, builds the
 * receiver-side group session from what that device actually received and tries
 * to decrypt the restricted ciphertext with its own copy of the Sender Key.
 *
 * Run: node tests/members-only-leak.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

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
    // Raw access so a test can prove/observe actual key rotations.
    _data: data,
    get: async (type, ids) => {
      const out = {};
      for (const id of ids) out[id] = data[`${type}:${id}`];
      return out;
    },
    /** Drop every entry of a type (used to simulate a Sender Key rotation). */
    _clearType: (type) => {
      for (const key of Object.keys(data)) {
        if (key.startsWith(`${type}:`)) delete data[key];
      }
    },
    _keysOfType: (type) => Object.keys(data).filter(k => k.startsWith(`${type}:`)).map(k => k.slice(type.length + 1)),
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

const participant = (pn, devices, { lid, admin } = {}) => ({ pn, lid, devices, admin });

const readFrameNode = (buffer, first) => {
  const offset = first && buffer.subarray(0, NOISE_WA_HEADER.length).equals(NOISE_WA_HEADER)
    ? NOISE_WA_HEADER.length
    : 0;
  const length = buffer.readUIntBE(offset, 3);
  return decodeBinaryNode(buffer.subarray(offset + 3, offset + 3 + length));
};

const buildQueryResponder = (participants) => {
  const devicesByUser = new Map();
  for (const p of participants) {
    for (const jid of [p.lid, p.pn].filter(Boolean)) {
      devicesByUser.set(jid.split('@')[0].split(':')[0], p.devices);
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

const setupSocket = async ({ participants }) => {
  const creds = initAuthCreds();
  creds.me = { id: ME, lid: ME_LID, name: 'test' };
  const rawKeys = makeKeys();
  const keys = makeCacheableSignalKeyStore(rawKeys, logger);

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

  await new Promise(resolve => setTimeout(resolve, 20));

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

  return { sock, sent, remotes, rawKeys };
};

const readMessageStanza = async (frames) => {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const node = await readFrameNode(frames[i], i === 0);
    if (node?.tag === 'message') return node;
  }
  throw new Error('no message stanza was captured');
};

/** Every message stanza in the capture, in order. */
const readAllMessageStanzas = async (frames) => {
  const out = [];
  for (let i = 0; i < frames.length; i += 1) {
    const node = await readFrameNode(frames[i], i === 0);
    if (node?.tag === 'message') out.push(node);
  }
  return out;
};

const shortUser = jid => jid.split('@')[0].split(':')[0];

const readRecipients = (stanza) => {
  const participantsNode = (stanza.content ?? []).find(n => n.tag === 'participants');
  return (participantsNode?.content ?? []).map(to => {
    const enc = (to.content ?? []).find(n => n.tag === 'enc');
    return { jid: to.attrs.jid, type: enc?.attrs?.type, ciphertext: enc?.content };
  });
};

const readSkmsg = (stanza) => {
  const enc = (stanza.content ?? []).find(n => n.tag === 'enc' && n.attrs.type === 'skmsg');
  return enc && { attrs: enc.attrs, ciphertext: enc.content };
};

const decryptFor = async (recipient, remotes) => {
  const [user, device] = recipient.jid.split('@')[0].split(':');
  const remote = remotes.get(`${user}.${device ?? 0}`);
  assert.ok(remote, `no remote keys for ${recipient.jid}`);
  const plaintext = unpadRandomMax16(await remote.decrypt(recipient.ciphertext, recipient.type));
  return proto.Message.decode(plaintext);
};

/**
 * Structural metadata only — no keys, no plaintext, no credentials. This is the
 * "capture the stanza before sending" instrumentation from the experiment plan.
 */
const structuralMetadata = (stanza, { mode, messageId, label }) => {
  const recipients = readRecipients(stanza);
  const skmsg = readSkmsg(stanza);
  return {
    label,
    mode,
    messageId,
    to: stanza.attrs.to,
    participantAttr: stanza.attrs.participant,
    type: stanza.attrs.type,
    addressingMode: stanza.attrs.addressing_mode,
    encTypes: recipients.map(r => r.type),
    toNodeCount: recipients.length,
    toJids: recipients.map(r => shortUser(r.jid)).sort(),
    skmsgType: skmsg?.type ?? skmsg?.attrs?.type,
    skmsgDecryptFail: skmsg?.attrs?.['decrypt-fail'],
    skmsgCount: skmsg?.attrs?.count
  };
};

/**
 * Build the receiver-side group session for a device from the Sender Key
 * Distribution Message it actually received, then try to decrypt a ciphertext
 * with it — exactly what the receiving client does.
 *
 * Returns a `decrypt` that throws if the device cannot read the message.
 */
const makeReceiverSession = async (recipient, remotes) => {
  const record = new SenderKeyRecord();
  const store = {
    loadSenderKey: async () => record,
    storeSenderKey: async (_name, key) => {
      record.senderKeyStates = key.senderKeyStates;
    }
  };
  const senderName = new SenderKeyName(GROUP, new ProtocolAddress(shortUser(ME_LID), 0));
  const builder = new GroupSessionBuilder(store);

  const inner = await decryptFor(recipient, remotes);
  const skdm = inner.senderKeyDistributionMessage;
  if (!skdm?.axolotlSenderKeyDistributionMessage) {
    return {
      gotSkdm: false,
      decrypt: async () => {
        throw new Error('no sender key');
      }
    };
  }
  await builder.process(
    senderName,
    new SenderKeyDistributionMessage(null, null, null, null, skdm.axolotlSenderKeyDistributionMessage)
  );
  return {
    gotSkdm: true,
    keyId: record.getSenderKeyState()?.getKeyId?.(),
    decrypt: async (ciphertext) => {
      const plaintext = await new GroupCipher(store, senderName).decrypt(ciphertext);
      return proto.Message.decode(unpadRandomMax16(plaintext));
    }
  };
};

const ADMIN = participant('5511900000002@s.whatsapp.net', [0], { lid: '100000000000002@lid', admin: 'admin' });
const MEMBER = participant('5511900000003@s.whatsapp.net', [0], { lid: '100000000000003@lid' });

describe('FORMA 6: fresh Sender Key per send keeps the excluded admin out', () => {
  it('the excluded admin CANNOT decrypt, and the intended member CAN', async () => {
    const { sock, sent, remotes } = await setupSocket({ participants: [ADMIN, MEMBER] });

    // 1) A NORMAL send first: this is what hands the Sender Key to the admin.
    //    Without this step there would be no key to leak in the first place.
    const first = generateWAMessageFromContent(GROUP, { conversation: 'mensagem normal' }, { userJid: ME, messageId: 'F-1' });
    await sock.relayMessage(GROUP, first.message, { messageId: 'F-1' });
    const firstStanza = await readMessageStanza(sent);

    const adminRecipient = readRecipients(firstStanza).find(r => shortUser(r.jid) === shortUser(ADMIN.lid));
    const memberRecipient = readRecipients(firstStanza).find(r => shortUser(r.jid) === shortUser(MEMBER.lid));
    assert.ok(adminRecipient, 'the admin got a Sender Key Distribution Message on the normal send');
    assert.ok(memberRecipient, 'the member got one too');

    const adminSession = await makeReceiverSession(adminRecipient, remotes);
    const memberSession = await makeReceiverSession(memberRecipient, remotes);
    assert.ok(adminSession.gotSkdm && memberSession.gotSkdm);
    const adminKeyIdBefore = adminSession.keyId;

    // 2) The restricted send, now with a FRESH key.
    const before = sent.length;
    const second = generateWAMessageFromContent(GROUP, { conversation: 'SEGREDO so membros' }, { userJid: ME, messageId: 'F-2' });
    const result = await sock.sendGroupMessageWithFreshSenderKey(GROUP, second.message, {
      messageId: 'F-2',
      recipientMode: 'members-only'
    });
    assert.ok(result, 'the helper returns a result');

    const restrictedStanza = await readMessageStanza(sent.slice(before));
    const skmsg = readSkmsg(restrictedStanza);
    assert.ok(skmsg, 'the restricted stanza carries the group ciphertext');
    assert.equal(restrictedStanza.attrs.to, GROUP, 'still addressed to the group, not to a device');
    assert.equal(restrictedStanza.attrs.participant, undefined, 'not a retry stanza');

    // Only the member is addressed in the distribution list.
    const jids = readRecipients(restrictedStanza).map(r => shortUser(r.jid));
    assert.deepEqual(jids, [shortUser(MEMBER.lid)], 'only the member is addressed');

    // 3) The intended member reads it — they got the NEW key. The receiver-side
    //    session is rebuilt from the SKDM delivered in THIS stanza, which is what
    //    the member's client would do when it sees a new distribution message.
    const memberRecipient2 = readRecipients(restrictedStanza).find(r => shortUser(r.jid) === shortUser(MEMBER.lid));
    assert.ok(memberRecipient2, 'the member is addressed in the restricted send');
    const memberSession2 = await makeReceiverSession(memberRecipient2, remotes);
    assert.ok(memberSession2.gotSkdm, 'the member received the NEW Sender Key Distribution Message');
    assert.notEqual(memberSession2.keyId, memberSession.keyId, 'the member key id changed (fresh key)');
    const memberPlain = await memberSession2.decrypt(skmsg.ciphertext);
    assert.equal(memberPlain.conversation, 'SEGREDO so membros', 'the member reads the restricted message');

    // 4) The excluded admin does NOT. This is the whole point of FORMA 6 and
    //    the exact opposite of what the leak test measured.
    let adminPlain = null;
    let adminError = null;
    try {
      adminPlain = await adminSession.decrypt(skmsg.ciphertext);
    } catch (err) {
      adminError = err;
    }

    console.log('\n=== FORMA 6 (fresh Sender Key) probe ===');
    console.log('admin key id before restricted send:', adminKeyIdBefore);
    console.log('member key id (old -> new)         :', memberSession.keyId, '->', memberSession2.keyId);
    console.log('admin decrypt of restricted msg    :', adminPlain ? `LEAKED: ${adminPlain.conversation}` : `blocked (${adminError?.message})`);
    console.log('member decrypt of restricted msg   :', memberPlain.conversation);

    assert.equal(adminPlain, null, 'the excluded admin CANNOT decrypt the restricted message');
    assert.ok(adminError, 'and the failure is an actual decryption error');

    await sock.ws.close().catch(() => {});
  });

  it('a fresh key is minted per send (the key id changes)', async () => {
    const { sock, rawKeys } = await setupSocket({ participants: [ADMIN, MEMBER] });

    const keyIdsOfGroup = () => rawKeys._keysOfType('sender-key')
      .filter(k => k.startsWith(GROUP))
      .map(k => {
        const stored = rawKeys._data[`sender-key:${k}`];
        return stored ? SenderKeyRecord.deserialize(stored).getSenderKeyState()?.getKeyId?.() : null;
      });

    const msg1 = generateWAMessageFromContent(GROUP, { conversation: 'um' }, { userJid: ME, messageId: 'K-1' });
    await sock.sendGroupMessageWithFreshSenderKey(GROUP, msg1.message, { messageId: 'K-1', recipientMode: 'members-only' });
    const id1 = keyIdsOfGroup()[0];

    const msg2 = generateWAMessageFromContent(GROUP, { conversation: 'dois' }, { userJid: ME, messageId: 'K-2' });
    await sock.sendGroupMessageWithFreshSenderKey(GROUP, msg2.message, { messageId: 'K-2', recipientMode: 'members-only' });
    const id2 = keyIdsOfGroup()[0];

    console.log('\nkey id apos envio 1:', id1, '| apos envio 2:', id2);
    assert.ok(id1 != null && id2 != null, 'both sends left a Sender Key state');
    assert.notEqual(id1, id2, 'the second send minted a DIFFERENT key id (fresh, not reused)');

    await sock.ws.close().catch(() => {});
  });
});
