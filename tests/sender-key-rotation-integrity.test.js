/**
 * EXPERIMENT — does a rotation leave the group readable afterwards?
 *
 * This is the "não funcionou" check. The rotation writes
 * `sender-key-memory[group]` while only the allowed participants are in the
 * device list, so it can leave the memory claiming that devices we never gave
 * the new key to already have it. If that happens, the NEXT normal message
 * skips their Sender Key Distribution Message while still encrypting with the
 * rotated key — and the whole group goes unreadable except the rotation target.
 *
 * The test drives the real send path: normal message → rotation → normal
 * message, then decrypts the last message as every participant, exactly like
 * the receiving clients would.
 *
 * Run: node tests/sender-key-rotation-integrity.test.js
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
import { decodeBinaryNode } from '../lib/WABinary/index.js';
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

const ADMIN = participant('5511900000010@s.whatsapp.net', [0], { lid: '100000000000010@lid', admin: 'superadmin' });
const MEMBER_A = participant('5511900000012@s.whatsapp.net', [0], { lid: '100000000000012@lid' });
const MEMBER_B = participant('5511900000013@s.whatsapp.net', [0], { lid: '100000000000013@lid' });
const ALL = [ADMIN, MEMBER_A, MEMBER_B];

/** Apply, per device, every SKDM that device actually received in a stanza. */
const applyReceivedSkdms = async (stanza, remotes, devices) => {
  for (const recipient of readRecipients(stanza)) {
    const user = shortUser(recipient.jid);
    const inner = await decryptFor(recipient, remotes);
    const skdm = inner.senderKeyDistributionMessage;
    if (skdm?.axolotlSenderKeyDistributionMessage && devices.has(user)) {
      await devices.get(user).processSkdm(skdm.axolotlSenderKeyDistributionMessage);
    }
  }
};

const sendAndApply = async ({ sock, sent, remotes, devices, messageId, text, rotation }) => {
  const before = sent.length;
  const msg = generateWAMessageFromContent(GROUP, { conversation: text }, { userJid: ME, messageId });
  if (rotation) {
    await sock.relayGroupMessageWithSenderKeyRotation(GROUP, msg.message, {
      allowedParticipants: rotation,
      messageId
    });
  } else {
    await sock.relayMessage(GROUP, msg.message, { messageId });
  }
  const stanza = await readMessageStanza(sent.slice(before));
  await applyReceivedSkdms(stanza, remotes, devices);
  return stanza;
};
describe('rotation integrity — the group must stay readable afterwards', () => {
  it('a normal message after a rotation is still readable by everyone', async () => {
    const { sock, sent, remotes, rawKeys } = await setupSocket({ participants: ALL });
    const devices = new Map(ALL.map(p => [shortUser(p.lid), makeDevice()]));

    // 1) normal
    await sendAndApply({ sock, sent, remotes, devices, messageId: 'I-1', text: 'antes' });
    // 2) rotation to MEMBER_A only
    await sendAndApply({
      sock, sent, remotes, devices,
      messageId: 'I-2',
      text: 'rotacionada',
      rotation: [MEMBER_A.lid]
    });
    // 3) a NORMAL message again — everyone must still be able to read it
    const stanza = await sendAndApply({ sock, sent, remotes, devices, messageId: 'I-3', text: 'depois' });

    const skmsg = readSkmsg(stanza);
    const results = {};
    for (const p of ALL) {
      const user = shortUser(p.lid);
      const r = await devices.get(user).tryDecrypt(skmsg.ciphertext);
      results[user] = r.ok ? `OK (${r.message.conversation})` : `FAIL (${r.error})`;
    }
    console.log('\n=== after rotation: who can read the next normal message ===');
    console.log(results);
    console.log('addressed devices:', readRecipients(stanza).map(r => shortUser(r.jid)));
    console.log('device keys:', Object.fromEntries([...devices.entries()].map(([u, d]) => [u, d.senderKeyIds])));

    // The sender must be back on a single state: the rotated key is per message.
    // Read the real stored name rather than guessing it.
    const storedNames = rawKeys._data
      ? Object.keys(rawKeys._data).filter(k => k.startsWith('sender-key:')).map(k => k.slice('sender-key:'.length))
      : [];
    assert.ok(storedNames.length > 0, 'the sender has a Sender Key to inspect');
    const storedTypes = await sock.authState.keys.get('sender-key', storedNames);
    const statesAfter = storedNames.map(name => SenderKeyRecord.deserialize(storedTypes[name]).senderKeyStates.length);
    console.log('sender key states after rotation:', statesAfter);
    assert.ok(
      statesAfter.every(n => n === 1),
      `after a rotated send the sender is back to one state (got: ${statesAfter})`
    );

    assert.equal(
      results[shortUser(ADMIN.lid)].startsWith('OK'),
      true,
      `ADMIN must still read normal group messages after a rotation (got: ${results[shortUser(ADMIN.lid)]})`
    );
    assert.equal(
      results[shortUser(MEMBER_B.lid)].startsWith('OK'),
      true,
      `MEMBER_B must still read normal group messages after a rotation (got: ${results[shortUser(MEMBER_B.lid)]})`
    );
    assert.equal(results[shortUser(MEMBER_A.lid)].startsWith('OK'), true, 'MEMBER_A reads it too');

    await sock.ws.close().catch(() => {});
  });

  it('the rotated message itself is readable only by its target', async () => {
    const { sock, sent, remotes } = await setupSocket({ participants: ALL });
    const devices = new Map(ALL.map(p => [shortUser(p.lid), makeDevice()]));

    await sendAndApply({ sock, sent, remotes, devices, messageId: 'J-1', text: 'antes' });
    const stanza = await sendAndApply({
      sock, sent, remotes, devices,
      messageId: 'J-2',
      text: 'SO O ALVO',
      rotation: [MEMBER_A.lid]
    });

    const skmsg = readSkmsg(stanza);
    const results = {};
    for (const p of ALL) {
      const user = shortUser(p.lid);
      const r = await devices.get(user).tryDecrypt(skmsg.ciphertext);
      results[user] = r.ok ? 'OK' : 'FAIL';
    }
    console.log('\n=== rotated message readability ===', results);

    assert.equal(results[shortUser(MEMBER_A.lid)], 'OK', 'the target reads the rotated message');
    assert.equal(results[shortUser(ADMIN.lid)], 'FAIL', 'the admin does not');
    assert.equal(results[shortUser(MEMBER_B.lid)], 'FAIL', 'another member does not either');

    await sock.ws.close().catch(() => {});
  });
});