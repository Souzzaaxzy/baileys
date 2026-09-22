/**
 * Protected messages — burst size, per-message isolation and crypto proof.
 *
 * For each burst size (1, 5, 10, 25, 50) this drives the REAL send path and then
 * behaves like the receiving devices: it builds each device's group session from
 * exactly the SKDMs that device received and tries to decrypt every broadcast
 * ciphertext with its own keys.
 *
 * So "the admin cannot read it" is MEASURED by failing to decrypt, and "each
 * message has its own state" is MEASURED by decrypting each ciphertext with the
 * SKDM that accompanied it — not asserted from the recipient list.
 *
 * Timings are recorded so the burst cost can be stated without guessing.
 *
 * Run: node --test tests/sender-key-rotation-burst.test.js
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
    get: async (type, ids) => { const o = {}; for (const id of ids) o[id] = data[`${type}:${id}`]; return o; },
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
const shortUser = jid => jid.split('@')[0].split(':')[0];

const readFrameNode = (buffer, first) => {
  const offset = first && buffer.subarray(0, NOISE_WA_HEADER.length).equals(NOISE_WA_HEADER) ? NOISE_WA_HEADER.length : 0;
  const length = buffer.readUIntBE(offset, 3);
  return decodeBinaryNode(buffer.subarray(offset + 3, offset + 3 + length));
};

const buildQueryResponder = (participants) => {
  const devicesByUser = new Map();
  for (const p of participants) for (const jid of [p.lid, p.pn].filter(Boolean)) devicesByUser.set(shortUser(jid), p.devices);
  return (node) => {
    if (node.attrs.xmlns === 'w:g2') {
      return {
        tag: 'iq', attrs: { type: 'result' },
        content: [{
          tag: 'group', attrs: { id: GROUP, addressing_mode: 'lid', subject: 'g' },
          content: participants.map(p => ({ tag: 'participant', attrs: { jid: p.lid ?? p.pn, ...(p.admin ? { type: p.admin } : {}) } }))
        }]
      };
    }
    if (node.attrs.xmlns === 'usync') {
      const u = (node.content ?? []).find(c => c.tag === 'usync');
      const l = (u?.content ?? []).find(c => c.tag === 'list');
      return {
        tag: 'iq', attrs: { type: 'result' },
        content: [{
          tag: 'usync', attrs: {},
          content: [{
            tag: 'list', attrs: {},
            content: (l?.content ?? []).map(n => {
              const jid = n.attrs.jid;
              return {
                tag: 'user', attrs: { jid },
                content: [{
                  tag: 'devices', attrs: {},
                  content: [{
                    tag: 'device-list', attrs: {},
                    content: (devicesByUser.get(shortUser(jid)) ?? []).map(d => ({ tag: 'device', attrs: { id: String(d), 'key-index': '1' } }))
                  }]
                }]
              };
            })
          }]
        }]
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
          if (node?.tag === 'iq' && node.attrs?.id) client.emit(`TAG:${node.attrs.id}`, responder(node));
        });
        return true;
      },
      on: () => {}, off: () => {}, setMaxListeners: () => {}, close: () => {},
      once: (e, cb) => { if (e === 'close') setImmediate(cb); }
    };
  };

  const sock = makeMessagesRecvSocket({
    logger, auth: { creds, keys }, waWebSocketUrl: 'ws://127.0.0.1:9/',
    makeSignalRepository: makeLibSignalRepository,
    shouldIgnoreJid: () => false,
    getMessage: async () => undefined,
    patchMessageBeforeSending: m => m,
    browser: Browsers.macOS('Chrome'),
    shouldSyncHistoryMessage: () => false,
    keepAliveIntervalMs: 60_000,
    enableRecentMessageCache: true,
    maxMsgRetryCount: 5,
    transactionOpts: { maxCommitRetries: 2, delayBetweenTriesMs: 1 },
    connectTimeoutMs: 5000,
    options: {}
  });

  await new Promise(r => setTimeout(r, 20));
  sock.signalRepository.validateSession = async () => ({ exists: true });

  const remotes = new Map();
  for (const p of participants) {
    for (const base of [p.lid, p.pn].filter(Boolean)) {
      const user = shortUser(base);
      const server = base.split('@')[1];
      for (const device of p.devices) {
        const remote = makeRemoteDevice(user, device);
        remotes.set(`${user}.${device}`, remote);
        await sock.signalRepository.injectE2ESession({ jid: device === 0 ? base : `${user}:${device}@${server}`, session: remote.bundle });
      }
    }
  }
  return { sock, sent, remotes, rawKeys };
};

const readStanzas = async (frames) => {
  const out = [];
  for (let i = 0; i < frames.length; i += 1) {
    const node = await readFrameNode(frames[i], i === 0);
    if (node?.tag === 'message') out.push(node);
  }
  return out;
};

const readRecipients = (stanza) => {
  // The `<to>` nodes live INSIDE the `<participants>` node (not at the top
  // level of the stanza) — reading `stanza.content` directly finds none.
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

/** A receiving device that accumulates the Sender Key states it is handed. */
const makeDevice = () => {
  const record = new SenderKeyRecord();
  const store = {
    loadSenderKey: async () => record,
    storeSenderKey: async (_n, key) => { record.senderKeyStates = key.senderKeyStates; }
  };
  const builder = new GroupSessionBuilder(store);
  return {
    get senderKeyIds() { return record.senderKeyStates.map(s => s.getKeyId()); },
    processSkdm: (bytes) => builder.process(senderKeyName, new SenderKeyDistributionMessage(null, null, null, null, bytes)),
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
const PARTICIPANTS = [ADMIN, MEMBER_A, MEMBER_B];
const MEMBERS = [MEMBER_A.lid, MEMBER_B.lid];

/** Everyone gets the baseline Sender Key from one normal message. */
const seedDevices = async ({ sock, sent, remotes }) => {
  const before = sent.length;
  const msg = generateWAMessageFromContent(GROUP, { conversation: 'seed' }, { userJid: ME, messageId: 'SEED' });
  await sock.relayMessage(GROUP, msg.message, { messageId: 'SEED' });

  const stanza = (await readStanzas(sent.slice(before)))[0];
  const devices = new Map();
  for (const recipient of readRecipients(stanza)) {
    const device = makeDevice();
    const inner = await decryptFor(recipient, remotes);
    const skdm = inner.senderKeyDistributionMessage?.axolotlSenderKeyDistributionMessage;
    if (skdm) device.processSkdm(skdm);
    devices.set(shortUser(recipient.jid), device);
  }
  return devices;
};

describe('protected burst — per-message isolation and crypto proof', () => {
  for (const count of [1, 5, 10, 25, 50]) {
    it(`${count} protected message(s): members decrypt each, admin decrypts none`, async () => {
      const t0 = process.hrtime.bigint();
      const { sock, sent, remotes } = await setupSocket({ participants: PARTICIPANTS });
      const devices = await seedDevices({ sock, sent, remotes });

      const mk = (id) => generateWAMessageFromContent(GROUP, { conversation: `SEGREDO-${id}` }, { userJid: ME, messageId: id });
      const before = sent.length;

      const tBurst = process.hrtime.bigint();
      await Promise.all(Array.from({ length: count }, (_, i) => {
        const id = `B-${i}`;
        return sock.relayGroupMessageWithSenderKeyRotation(GROUP, mk(id).message, { allowedParticipants: MEMBERS, messageId: id });
      }));
      const burstMs = Number(process.hrtime.bigint() - tBurst) / 1e6;

      const stanzas = (await readStanzas(sent.slice(before))).filter(s => readSkmsg(s) && String(s.attrs.id).startsWith('B-'));
      assert.equal(stanzas.length, count, `${count} protected stanzas sent (got ${stanzas.length})`);

      // The admin is never addressed → it can never hold the rotated key.
      for (const stanza of stanzas) {
        const addressed = readRecipients(stanza).map(r => shortUser(r.jid));
        assert.ok(!addressed.includes(shortUser(ADMIN.lid)), 'admin never addressed');
      }

      // PER-MESSAGE ISOLATION, measured: a FRESH member device, fed ONLY the
      // SKDM that accompanied message N, must decrypt ciphertext N.
      let decrypted = 0;
      const memberIds = new Set();
      for (const stanza of stanzas) {
        const memberRecipient = readRecipients(stanza).find(r => shortUser(r.jid) === shortUser(MEMBER_A.lid));
        assert.ok(memberRecipient, 'member addressed');

        const fresh = makeDevice();
        const inner = await decryptFor(memberRecipient, remotes);
        const skdm = inner.senderKeyDistributionMessage?.axolotlSenderKeyDistributionMessage;
        assert.ok(skdm, 'the SKDM is attached to the protected message');
        await fresh.processSkdm(skdm);
        const ids = fresh.senderKeyIds;
        memberIds.add(String(ids[ids.length - 1]));

        const skmsg = readSkmsg(stanza);
        const out = await fresh.tryDecrypt(skmsg.ciphertext);
        assert.equal(out.ok, true, `member decrypts ${stanza.attrs.id} with that message's own SKDM`);
        decrypted += 1;
      }
      assert.equal(decrypted, count, 'every protected message was decrypted from its own SKDM');

      // Distinct sender key id per protected message → no shared state.
      assert.equal(memberIds.size, count, 'each protected message used its OWN sender key id');

      // The ADMIN holds the baseline key only (never given the rotated one), so
      // the rotated ciphertexts must fail for it.
      const adminDevice = devices.get(shortUser(ADMIN.lid));
      assert.ok(adminDevice, 'admin device has the baseline key');
      let adminRead = 0;
      for (const stanza of stanzas) {
        const out = await adminDevice.tryDecrypt(readSkmsg(stanza).ciphertext);
        if (out.ok) adminRead += 1;
      }
      assert.equal(adminRead, 0, 'the admin decrypted ZERO protected messages');

      const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log(`burst=${count} stanzas=${stanzas.length} uniqueKeys=${memberIds.size} adminRead=${adminRead} burstMs=${burstMs.toFixed(1)} avgMs=${(burstMs / count).toFixed(1)} totalMs=${totalMs.toFixed(1)}`);
    });
  }
});

describe('protected bursts do not break normal messages', () => {
  it('protected → normal → protected → normal keeps normal messages readable', async () => {
    const { sock, sent, remotes } = await setupSocket({ participants: PARTICIPANTS });
    const devices = await seedDevices({ sock, sent, remotes });
    const memberDevice = devices.get(shortUser(MEMBER_A.lid));
    const mk = (id) => generateWAMessageFromContent(GROUP, { conversation: id }, { userJid: ME, messageId: id });

    const outcomes = [];
    for (const step of ['P1', 'N1', 'P2', 'N2']) {
      const before = sent.length;
      if (step.startsWith('P')) {
        await sock.relayGroupMessageWithSenderKeyRotation(GROUP, mk(step).message, { allowedParticipants: MEMBERS, messageId: step });
      } else {
        await sock.relayMessage(GROUP, mk(step).message, { messageId: step });
      }
      const stanza = (await readStanzas(sent.slice(before)))[0];
      assert.ok(stanza, `${step} produced a stanza`);
      const skmsg = readSkmsg(stanza);
      if (!skmsg) continue;
      // A normal message is encrypted with the BASELINE key, so a device that
      // holds the baseline must read it — including AFTER a protected send.
      const out = await memberDevice.tryDecrypt(skmsg.ciphertext);
      outcomes.push({ step, ok: out.ok });
    }

    console.log('\n=== protected/normal alternation ===');
    for (const o of outcomes) console.log(`${o.step}: memberDecrypt=${o.ok}`);

    const normals = outcomes.filter(o => o.step.startsWith('N'));
    assert.equal(normals.length, 2, 'two normal messages checked');
    for (const n of normals) assert.equal(n.ok, true, `normal message ${n.step} decrypts for the member (baseline key still active)`);
  });
});
