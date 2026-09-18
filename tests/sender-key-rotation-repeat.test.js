/**
 * EXPERIMENT — three rotated sends in a row (the !raja case).
 *
 * !raja sends N copies of the same content. Each one rotates the Sender Key and
 * reverts afterwards, so the concern is whether repeated rotation leaves the
 * group consistent and whether every send is still readable by the authorised
 * participants only.
 *
 * Run: node tests/sender-key-rotation-repeat.test.js
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
    enableRecentMessageCache: true,
    maxMsgRetryCount: 5,
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

const readMessageStanzas = async (frames) => {
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

const applySkdms = async (stanza, remotes, devices) => {
  for (const recipient of readRecipients(stanza)) {
    const user = shortUser(recipient.jid);
    const inner = await decryptFor(recipient, remotes);
    const skdm = inner.senderKeyDistributionMessage;
    if (skdm?.axolotlSenderKeyDistributionMessage && devices.has(user)) {
      await devices.get(user).processSkdm(skdm.axolotlSenderKeyDistributionMessage);
    }
  }
};

describe('repeated rotated sends (the !raja case)', () => {
  it('three rotated sends in a row: members read all, admins read none, group stays healthy', async () => {
    const { sock, sent, remotes, rawKeys } = await setupSocket({ participants: ALL });
    const devices = new Map(ALL.map(p => [shortUser(p.lid), makeDevice()]));

    // Seed: a normal message so the admin holds a key and the group is healthy.
    let before = sent.length;
    const seed = generateWAMessageFromContent(GROUP, { conversation: 'antes' }, { userJid: ME, messageId: 'REP-0' });
    await sock.relayMessage(GROUP, seed.message, { messageId: 'REP-0' });
    await applySkdms((await readMessageStanzas(sent.slice(before))).pop(), remotes, devices);

    // Three rotated sends to the two members, like `!raja 3 texto`.
    const perSend = [];
    for (let n = 1; n <= 3; n += 1) {
      before = sent.length;
      const msg = generateWAMessageFromContent(GROUP, { conversation: `RAJA_${n}` }, { userJid: ME, messageId: `REP-${n}` });
      await sock.relayGroupMessageWithSenderKeyRotation(GROUP, msg.message, {
        allowedParticipants: [MEMBER_A.lid, MEMBER_B.lid],
        messageId: `REP-${n}`
      });
      const stanza = (await readMessageStanzas(sent.slice(before))).pop();
      const skmsg = readSkmsg(stanza);
      const keyId = proto.SenderKeyMessage.decode(skmsg.ciphertext.slice(1, skmsg.ciphertext.length - 64)).id;

      await applySkdms(stanza, remotes, devices);

      const memberA = await devices.get(shortUser(MEMBER_A.lid)).tryDecrypt(skmsg.ciphertext);
      const memberB = await devices.get(shortUser(MEMBER_B.lid)).tryDecrypt(skmsg.ciphertext);
      const admin = await devices.get(shortUser(ADMIN.lid)).tryDecrypt(skmsg.ciphertext);

      perSend.push({
        n,
        keyId,
        addressed: readRecipients(stanza).map(r => shortUser(r.jid)).sort(),
        memberA: memberA.ok ? memberA.message.conversation : `FAIL`,
        memberB: memberB.ok ? memberB.message.conversation : `FAIL`,
        admin: admin.ok ? `LEAK (${admin.message.conversation})` : 'blocked'
      });
    }

    console.log('\n=== three rotated sends ===');
    for (const s of perSend) {
      console.log(`send ${s.n}: keyId=${s.keyId} addressed=${JSON.stringify(s.addressed)} memberA=${s.memberA} memberB=${s.memberB} admin=${s.admin}`);
    }

    // Every send: both members read it, the admin never does.
    for (const s of perSend) {
      assert.equal(s.memberA, `RAJA_${s.n}`, `send ${s.n}: MEMBER_A reads it`);
      assert.equal(s.memberB, `RAJA_${s.n}`, `send ${s.n}: MEMBER_B reads it`);
      assert.equal(s.admin, 'blocked', `send ${s.n}: ADMIN cannot read it`);
      assert.deepEqual(s.addressed, [shortUser(MEMBER_A.lid), shortUser(MEMBER_B.lid)], `send ${s.n}: only members addressed`);
    }

    // Each send used its own fresh key.
    assert.equal(new Set(perSend.map(s => s.keyId)).size, 3, 'each send rotated to a distinct Sender Key');

    // The sender is back to a single state (rotation is per message).
    const names = Object.keys(rawKeys._data).filter(k => k.startsWith('sender-key:')).map(k => k.slice('sender-key:'.length));
    const stored = await sock.authState.keys.get('sender-key', names);
    const states = names.map(n => SenderKeyRecord.deserialize(stored[n]).senderKeyStates.length);
    console.log('sender key states after 3 rotations:', states);
    assert.ok(states.every(n => n === 1), `sender back to one state (got ${states})`);

    // A normal message afterwards is still readable by everyone.
    before = sent.length;
    const after = generateWAMessageFromContent(GROUP, { conversation: 'depois' }, { userJid: ME, messageId: 'REP-9' });
    await sock.relayMessage(GROUP, after.message, { messageId: 'REP-9' });
    const afterStanza = (await readMessageStanzas(sent.slice(before))).pop();
    await applySkdms(afterStanza, remotes, devices);
    const afterSkmsg = readSkmsg(afterStanza);
    const results = {};
    for (const p of ALL) {
      const r = await devices.get(shortUser(p.lid)).tryDecrypt(afterSkmsg.ciphertext);
      results[shortUser(p.lid)] = r.ok ? 'OK' : 'FAIL';
    }
    console.log('after the rotations, a normal message:', results);
    assert.ok(Object.values(results).every(v => v === 'OK'), 'a normal message after 3 rotations is readable by everyone');

    await sock.ws.close().catch(() => {});
  });
});