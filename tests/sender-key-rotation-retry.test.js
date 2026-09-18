/**
 * EXPERIMENT — can an excluded admin recover the rotated message via retry?
 *
 * This is the Part 12 question, and the one that decides whether the rotation is
 * real isolation or just a delay. A device that cannot decrypt a group message
 * replies with a retry receipt, and Baileys answers it in
 * `sendMessagesAgain` → `relayMessage({ participant })`, which attaches
 * `signalRepository.getSenderKeyDistributionMessage(...)` — the SENDER'S CURRENT
 * key at that moment.
 *
 * Rather than hand-crafting the receipt plumbing (the harness's inbound path is
 * not a real noise connection), this reproduces exactly the stanza the retry
 * branch builds: `relayMessage` with a `participant`, which is the same code the
 * receipt handler calls. The question is whether the payload carries the rotated
 * key or the group's current key.
 *
 * Run: node tests/sender-key-rotation-retry.test.js
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
  let inbound;
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
    shouldIgnoreMessage: () => false,
    getMessage: async () => undefined,
    patchMessageBeforeSending: msg => msg,
    browser: Browsers.macOS('Chrome'),
    shouldSyncHistoryMessage: () => false,
    keepAliveIntervalMs: 60_000,
    enableRecentMessageCache: true,
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

/** The senderKeyId the group is currently encrypting with, read from the store. */
const currentGroupKeyId = async (sock, rawKeys) => {
  const names = Object.keys(rawKeys._data || {})
    .filter(k => k.startsWith('sender-key:'))
    .map(k => k.slice('sender-key:'.length));
  assert.ok(names.length > 0, 'the sender has a Sender Key');
  const stored = await sock.authState.keys.get('sender-key', names);
  const ids = names.map(n => SenderKeyRecord.deserialize(stored[n]).getSenderKeyState().getKeyId());
  return ids.length === 1 ? ids[0] : ids;
};

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
const ALL = [ADMIN, MEMBER_A];

/**
 * A captured retry receipt, as the excluded admin's device would send it after
 * failing to decrypt a group message.
 */
const buildRetryReceiptNode = ({ messageId, from, participantJid, count, retryId }) => ({
  tag: 'receipt',
  attrs: {
    id: messageId,
    type: 'retry',
    from,
    participant: participantJid,
    t: String(Math.floor(Date.now() / 1000))
  },
  content: [
    {
      tag: 'retry',
      attrs: {
        count: String(count),
        id: retryId ?? messageId,
        t: String(Math.floor(Date.now() / 1000)),
        v: '1'
      }
    }
  ]
});

describe('experimental rotation — retry must not hand the key to an excluded admin', () => {
  it('the retry resend to an excluded admin carries the group key, not the rotated one', async () => {
    const { sock, sent, remotes, rawKeys } = await setupSocket({ participants: ALL });
    const devices = new Map(ALL.map(p => [shortUser(p.lid), makeDevice()]));

    // Seed: a normal message, everyone (admin included) gets key A.
    let before = sent.length;
    const seed = generateWAMessageFromContent(GROUP, { conversation: 'antes' }, { userJid: ME, messageId: 'R-0' });
    await sock.relayMessage(GROUP, seed.message, { messageId: 'R-0' });
    let stanza = (await readMessageStanzas(sent.slice(before))).pop();
    for (const recipient of readRecipients(stanza)) {
      const inner = await decryptFor(recipient, remotes);
      await devices.get(shortUser(recipient.jid)).processSkdm(
        inner.senderKeyDistributionMessage.axolotlSenderKeyDistributionMessage
      );
    }
    const groupKeyId = await currentGroupKeyId(sock, rawKeys);

    // The rotated message: only MEMBER_A receives B.
    before = sent.length;
    const rotated = generateWAMessageFromContent(GROUP, { conversation: 'SEGREDO ROTACIONADO' }, { userJid: ME, messageId: 'R-1' });
    await sock.relayGroupMessageWithSenderKeyRotation(GROUP, rotated.message, {
      allowedParticipants: [MEMBER_A.lid],
      messageId: 'R-1'
    });
    stanza = (await readMessageStanzas(sent.slice(before))).pop();
    const rotatedCiphertext = readSkmsg(stanza).ciphertext;
    const rotatedKeyId = proto.SenderKeyMessage.decode(
      rotatedCiphertext.slice(1, rotatedCiphertext.length - 64)
    ).id;

    // The admin fails to decrypt it — that is the whole point.
    const adminBefore = await devices.get(shortUser(ADMIN.lid)).tryDecrypt(rotatedCiphertext);
    assert.equal(adminBefore.ok, false, 'the admin cannot decrypt the rotated message');

    // Now the admin's client asks for a retry. Baileys answers with
    // `relayMessage({ participant })`, which is exactly this call.
    before = sent.length;
    await sock.relayMessage(GROUP, rotated.message, {
      messageId: 'R-1',
      participant: { jid: ADMIN.lid, count: 1 }
    });
    const retryStanza = (await readMessageStanzas(sent.slice(before))).pop();
    assert.ok(retryStanza, 'a retry resend was produced');

    const retryRecipients = readRecipients(retryStanza);
    const adminNode = retryRecipients.find(r => shortUser(r.jid) === shortUser(ADMIN.lid));
    assert.ok(adminNode, 'the retry is addressed to the admin device');

    // What key does the retry hand over?
    const inner = await decryptFor(adminNode, remotes);
    const skdm = inner.senderKeyDistributionMessage;
    const deliveredKeyId = skdm?.axolotlSenderKeyDistributionMessage
      ? proto.SenderKeyDistributionMessage.decode(
        Buffer.from(skdm.axolotlSenderKeyDistributionMessage).slice(1)
      ).id
      : null;

    console.log('\n=== retry resend after a rotation ===');
    console.log('rotated (message) key id :', rotatedKeyId);
    console.log('group current key id     :', groupKeyId);
    console.log('retry delivered key id   :', deliveredKeyId);

    if (skdm?.axolotlSenderKeyDistributionMessage) {
      await devices.get(shortUser(ADMIN.lid)).processSkdm(skdm.axolotlSenderKeyDistributionMessage);
    }
    const adminAfter = await devices.get(shortUser(ADMIN.lid)).tryDecrypt(rotatedCiphertext);
    console.log('admin key ids after retry:', devices.get(shortUser(ADMIN.lid)).senderKeyIds);
    console.log('admin reads rotated msg after retry:', adminAfter.ok ? 'YES (LEAK)' : 'NO');

    // The finding: after the per-message rotation reverts, the retry hands the
    // admin the group's current key (A), not the rotated one (B). So the retry
    // does NOT reveal the rotated message.
    assert.equal(adminAfter.ok, false, 'the retry must not let the admin read the rotated message');
    assert.notEqual(deliveredKeyId, rotatedKeyId, 'the retry did not deliver the rotated key');

    await sock.ws.close().catch(() => {});
  });
});