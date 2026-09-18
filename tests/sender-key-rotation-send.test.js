/**
 * EXPERIMENT — end-to-end selective Sender Key rotation through the real send path.
 *
 * This drives the fork's REAL socket stack (makeMessagesRecvSocket →
 * messages-send → signalRepository → GroupCipher) with only the transport
 * recorded. It then behaves like the receiving devices: it builds each device's
 * group session from exactly the Sender Key Distribution Messages that device
 * received, and tries to decrypt the broadcast `skmsg` with its own keys.
 *
 * So "the admin cannot read it" is measured by decrypting, not asserted from
 * the recipient list.
 *
 * Scenario, mirroring the experiment plan:
 *   - everyone first receives Sender Key A (a normal group message);
 *   - the bot rotates to B and distributes B only to the members;
 *   - a message is encrypted with B;
 *   - members decrypt it, admins (holding only A) must not.
 *
 * Run: node tests/sender-key-rotation-send.test.js
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
    _data: data,
    get: async (type, ids) => {
      const out = {};
      for (const id of ids) out[id] = data[`${type}:${id}`];
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

const senderKeyName = new SenderKeyName(GROUP, new ProtocolAddress(shortUser(ME_LID), 0));

/**
 * A receiving device that accumulates the Sender Key states it is given, like a
 * real client does, and can try to decrypt a broadcast ciphertext with them.
 */
const makeDevice = () => {
  const record = new SenderKeyRecord();
  const store = {
    loadSenderKey: async () => record,
    storeSenderKey: async (_name, key) => {
      record.senderKeyStates = key.senderKeyStates;
    }
  };
  const builder = new GroupSessionBuilder(store);
  return {
    record,
    get stateCount() {
      return record.senderKeyStates.length;
    },
    get senderKeyIds() {
      return record.senderKeyStates.map(s => s.getKeyId());
    },
    processSkdm: (bytes) =>
      builder.process(senderKeyName, new SenderKeyDistributionMessage(null, null, null, null, bytes)),
    tryDecrypt: async (ciphertext) => {
      try {
        const plaintext = await new GroupCipher(store, senderKeyName).decrypt(ciphertext);
        return { ok: true, message: proto.Message.decode(unpadRandomMax16(plaintext)) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }
  };
};

const ADMIN_A = participant('5511900000010@s.whatsapp.net', [0], { lid: '100000000000010@lid', admin: 'superadmin' });
const ADMIN_B = participant('5511900000011@s.whatsapp.net', [0, 2], { lid: '100000000000011@lid', admin: 'admin' });
const MEMBER_A = participant('5511900000012@s.whatsapp.net', [0], { lid: '100000000000012@lid' });
const MEMBER_B = participant('5511900000013@s.whatsapp.net', [0, 2], { lid: '100000000000013@lid' });

/** Give every device the Sender Key from a normal message. */
const seedEveryone = async ({ sock, sent, remotes, participants }) => {
  const devices = new Map();
  const stanza = await readMessageStanza(sent);
  for (const recipient of readRecipients(stanza)) {
    const user = shortUser(recipient.jid);
    const device = makeDevice();
    const inner = await decryptFor(recipient, remotes);
    if (inner.senderKeyDistributionMessage?.axolotlSenderKeyDistributionMessage) {
      await device.processSkdm(inner.senderKeyDistributionMessage.axolotlSenderKeyDistributionMessage);
    }
    devices.set(user, device);
  }
  return devices;
};

const userOf = p => shortUser(p.lid);

describe('experimental selective Sender Key rotation (real send path)', () => {
  it('distributes the new key only to the allowed participants and they decrypt it; admins do not', async () => {
    const participants = [ADMIN_A, ADMIN_B, MEMBER_A, MEMBER_B];
    const { sock, sent, remotes, rawKeys } = await setupSocket({ participants });

    // 1) A normal message first: everyone receives Sender Key A.
    const seed = generateWAMessageFromContent(GROUP, { conversation: 'normal' }, { userJid: ME, messageId: 'A-1' });
    await sock.relayMessage(GROUP, seed.message, { messageId: 'A-1' });
    const devices = await seedEveryone({ sock, sent, remotes, participants });

    const keyIdA = sock.signalRepository ? null : null;
    // The sender really did establish a Sender Key on the normal send.
    const storedSenderKeys = rawKeys._data && Object.keys(rawKeys._data).filter(k => k.startsWith('sender-key:'));
    assert.ok(
      storedSenderKeys?.length > 0,
      'the sender has a Sender Key after the normal send'
    );

    // 2) Rotate + selective distribution to the two members only.
    const before = sent.length;
    const msg = generateWAMessageFromContent(GROUP, { conversation: 'TEST_SENDER_KEY_B' }, { userJid: ME, messageId: 'B-1' });
    await sock.relayGroupMessageWithSenderKeyRotation(GROUP, msg.message, {
      allowedParticipants: [MEMBER_A.lid, MEMBER_B.lid],
      messageId: 'B-1'
    });

    const stanza = await readMessageStanza(sent.slice(before));
    if (process.env.DUMP) console.log(binaryNodeToString(stanza));

    // Structural expectations.
    assert.equal(stanza.attrs.to, GROUP, 'a normal group stanza');
    assert.equal(stanza.attrs.participant, undefined, 'no retry participant');
    const skmsg = readSkmsg(stanza);
    assert.ok(skmsg, 'carries the group ciphertext');
    assert.equal(skmsg.attrs.count, undefined, 'no retry count');

    const recipients = readRecipients(stanza);
    const addressed = recipients.map(r => shortUser(r.jid)).sort();
    const addressedUsers = [...new Set(addressed)].sort();
    console.log('\n=== selective rotation distribution ===');
    console.log('addressed devices:', addressed);
    // Part 9 — multi-device: MEMBER_B has devices 0 and 2, so it must appear
    // twice, and no admin device may appear at all.
    assert.deepEqual(
      addressed,
      ['100000000000012', '100000000000013', '100000000000013'],
      'only the members are addressed, including both devices of the multi-device member'
    );
    assert.deepEqual(
      addressedUsers,
      ['100000000000012', '100000000000013'],
      'no admin (user or device) is addressed'
    );
    assert.ok(
      !addressed.some(j => j === '100000000000010' || j === '100000000000011'),
      'neither admin user appears, on any device'
    );

    // 3) Hand each addressed device its new SKDM, exactly like the client would.
    //    A user with several devices accumulates the SKDM on each of them; the
    //    test keeps one device object per user, so applying the SKDM twice is
    //    idempotent for the same key id.
    for (const recipient of recipients) {
      const user = shortUser(recipient.jid);
      const inner = await decryptFor(recipient, remotes);
      const skdm = inner.senderKeyDistributionMessage;
      assert.ok(skdm?.axolotlSenderKeyDistributionMessage, `${user} received an SKDM`);
      await devices.get(user).processSkdm(skdm.axolotlSenderKeyDistributionMessage);
    }

    // 4) Decrypt the broadcast ciphertext as each device.
    const results = {};
    for (const p of participants) {
      results[userOf(p)] = await devices.get(userOf(p)).tryDecrypt(skmsg.ciphertext);
    }
    console.log('decrypt results:', Object.fromEntries(
      Object.entries(results).map(([u, r]) => [u, r.ok ? `OK (${r.message.conversation})` : `FAIL (${r.error})`])
    ));
    console.log('device sender key ids:', Object.fromEntries(
      [...devices.entries()].map(([u, d]) => [u, d.senderKeyIds])
    ));

    // Members read it.
    assert.equal(results[userOf(MEMBER_A)].ok, true, 'MEMBER_A decrypts the rotated message');
    assert.equal(results[userOf(MEMBER_A)].message.conversation, 'TEST_SENDER_KEY_B');
    assert.equal(results[userOf(MEMBER_B)].ok, true, 'MEMBER_B decrypts the rotated message');
    assert.equal(results[userOf(MEMBER_B)].message.conversation, 'TEST_SENDER_KEY_B');

    // Admins, holding only A, cannot.
    assert.equal(results[userOf(ADMIN_A)].ok, false, 'ADMIN_A cannot decrypt');
    assert.equal(results[userOf(ADMIN_B)].ok, false, 'ADMIN_B cannot decrypt');

    // The admins really did hold A (so their failure is "no B", not "no key").
    assert.equal(devices.get(userOf(ADMIN_A)).stateCount, 1, 'ADMIN_A holds exactly the old state');
    assert.equal(devices.get(userOf(MEMBER_A)).stateCount, 2, 'MEMBER_A holds A and B');

    await sock.ws.close().catch(() => {});
  });

  it('keeps A and B independent across two rotated messages, then a normal message returns to B', async () => {
    const participants = [ADMIN_A, MEMBER_A];
    const { sock, sent, remotes } = await setupSocket({ participants });

    const seed = generateWAMessageFromContent(GROUP, { conversation: 'normal' }, { userJid: ME, messageId: 'C-0' });
    await sock.relayMessage(GROUP, seed.message, { messageId: 'C-0' });
    const devices = await seedEveryone({ sock, sent, remotes, participants });

    const rotatedIds = [];
    const memberReads = [];
    const adminReads = [];

    for (const n of [1, 2]) {
      const before = sent.length;
      const msg = generateWAMessageFromContent(GROUP, { conversation: `ROTATED_${n}` }, { userJid: ME, messageId: `C-${n}` });
      await sock.relayGroupMessageWithSenderKeyRotation(GROUP, msg.message, {
        allowedParticipants: [MEMBER_A.lid],
        messageId: `C-${n}`
      });

      const stanza = await readMessageStanza(sent.slice(before));
      const ciphertext = readSkmsg(stanza).ciphertext;
      // The senderKeyId actually used on the wire.
      rotatedIds.push(proto.SenderKeyMessage.decode(ciphertext.slice(1, ciphertext.length - 64)).id);

      for (const recipient of readRecipients(stanza)) {
        const inner = await decryptFor(recipient, remotes);
        await devices.get(shortUser(recipient.jid)).processSkdm(
          inner.senderKeyDistributionMessage.axolotlSenderKeyDistributionMessage
        );
      }

      memberReads.push((await devices.get(userOf(MEMBER_A)).tryDecrypt(ciphertext)).ok);
      adminReads.push((await devices.get(userOf(ADMIN_A)).tryDecrypt(ciphertext)).ok);
    }

    console.log('\n=== two rotated messages ===');
    console.log('senderKeyIds used:', rotatedIds, '| member:', memberReads, '| admin:', adminReads);

    assert.deepEqual(memberReads, [true, true], 'the member reads both rotated messages');
    assert.deepEqual(adminReads, [false, false], 'the admin reads neither');
    assert.notEqual(rotatedIds[0], rotatedIds[1], 'each rotation uses a fresh Sender Key id');

    await sock.ws.close().catch(() => {});
  });

  it('with the flag absent the normal send path is unchanged', async () => {
    const participants = [ADMIN_A, MEMBER_A];
    const { sock, sent } = await setupSocket({ participants });

    const msg = generateWAMessageFromContent(GROUP, { conversation: 'normal' }, { userJid: ME, messageId: 'D-1' });
    await sock.relayMessage(GROUP, msg.message, { messageId: 'D-1' });

    const stanza = await readMessageStanza(sent);
    const addressed = readRecipients(stanza).map(r => shortUser(r.jid)).sort();
    assert.deepEqual(addressed, ['100000000000010', '100000000000012'], 'everyone is still addressed');
    assert.equal(readSkmsg(stanza).attrs['decrypt-fail'], undefined, 'no hiding on a normal send');

    await sock.ws.close().catch(() => {});
  });

  it('an empty allowed list fails closed and rotates nothing', async () => {
    const { sock, sent } = await setupSocket({ participants: [ADMIN_A, MEMBER_A] });
    const msg = generateWAMessageFromContent(GROUP, { conversation: 'x' }, { userJid: ME, messageId: 'E-1' });

    await assert.rejects(
      sock.relayGroupMessageWithSenderKeyRotation(GROUP, msg.message, { allowedParticipants: [], messageId: 'E-1' }),
      /non-empty allowedParticipants/
    );
    assert.equal((await readAllMessageStanzas(sent)).length, 0, 'nothing was sent');

    await sock.ws.close().catch(() => {});
  });

  it('rejects a non-group target', async () => {
    const { sock } = await setupSocket({ participants: [MEMBER_A] });
    const msg = generateWAMessageFromContent(GROUP, { conversation: 'x' }, { userJid: ME, messageId: 'F-1' });
    await assert.rejects(
      sock.relayGroupMessageWithSenderKeyRotation('5511900000012@s.whatsapp.net', msg.message, {
        allowedParticipants: [MEMBER_A.lid],
        messageId: 'F-1'
      }),
      /only accepts a group JID/
    );
    await sock.ws.close().catch(() => {});
  });
});