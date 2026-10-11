/**
 * Sender Key rotation — three robustness fixes.
 *
 * 1. STATE CAP — `rotateSenderKey` appends straight to `senderKeyStates`,
 *    bypassing `SenderKeyRecord.addSenderKeyState` (which enforces
 *    `MAX_STATES = 5`). A rotation whose rollback never ran would let the
 *    record grow past the native limit.
 * 2. EMPTY-STATE PRUNE — a state restored from a malformed structure has no
 *    `senderChainKey`; a record holding one fails `decryptGroupMessage` for
 *    every participant.
 * 3. REQUIRED `messageId` — retry suppression is keyed by messageId. Without
 *    one the registry would register `undefined` and the first retry receipt
 *    would re-send the content pairwise to the excluded participant.
 *
 * Run: node --test tests/sender-key-rotation-robustness.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeMessagesRecvSocket } from '../lib/Socket/messages-recv.js';
import { makeCacheableSignalKeyStore, initAuthCreds } from '../lib/Utils/auth-utils.js';
import { generateWAMessageFromContent } from '../lib/Utils/messages.js';
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js';
import { decodeBinaryNode } from '../lib/WABinary/index.js';
import { NOISE_WA_HEADER } from '../lib/Defaults/index.js';
import { Browsers } from '../lib/Utils/browser-utils.js';
import { WebSocketClient } from '../lib/Socket/Client/index.js';
import { SenderKeyRecord, SenderKeyState } from '../lib/Signal/Group/index.js';
import { makeRemoteDevice } from './helpers/test-signal-sessions.js';
import pino from 'pino';

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
    for (const base of [p.lid, p.pn].filter(Boolean)) {
      devicesByUser.set(base.split('@')[0].split(':')[0], p.devices);
    }
  }
  return (node) => {
    if (node.attrs.xmlns === 'w:g2') {
      return {
        tag: 'iq',
        attrs: { type: 'result' },
        content: [{
          tag: 'group',
          attrs: { id: GROUP, addressing_mode: 'lid', subject: 'test group' },
          content: participants.map(p => ({
            tag: 'participant',
            attrs: { jid: p.lid ?? p.pn, ...(p.admin ? { type: p.admin } : {}) }
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
  for (const p of participants) {
    for (const base of [p.lid, p.pn].filter(Boolean)) {
      const user = base.split('@')[0].split(':')[0];
      const server = base.split('@')[1];
      for (const device of p.devices) {
        const remote = makeRemoteDevice(user, device);
        const jid = device === 0 ? base : `${user}:${device}@${server}`;
        await signalRepository.injectE2ESession({ jid, session: remote.bundle });
      }
    }
  }

  return { sock, sent, rawKeys, keys };
};

/** Sender Key ids currently stored for a group, newest last. */
const storedStateIds = (rawKeys, group) => {
  const names = Object.keys(rawKeys._data)
    .filter(k => k.startsWith('sender-key:') && k.includes(group))
    .map(k => k.slice('sender-key:'.length));
  const out = [];
  for (const name of names) {
    const record = SenderKeyRecord.deserialize(rawKeys._data[`sender-key:${name}`]);
    out.push(...record.senderKeyStates.map(s => s.getKeyId()));
  }
  return out;
};

/** The raw record stored for a group. */
const storedRecord = (rawKeys, group) => {
  const name = Object.keys(rawKeys._data)
    .find(k => k.startsWith('sender-key:') && k.includes(group));
  return SenderKeyRecord.deserialize(rawKeys._data[name]);
};

const ADMIN = participant('5511900000010@s.whatsapp.net', [0], { lid: '100000000000010@lid', admin: 'superadmin' });
const MEMBER_A = participant('5511900000012@s.whatsapp.net', [0], { lid: '100000000000012@lid' });
const MEMBER_B = participant('5511900000013@s.whatsapp.net', [0], { lid: '100000000000013@lid' });
const ALL = [ADMIN, MEMBER_A, MEMBER_B];

const seedGroup = async (sock, group, id = 'SEED') => {
  const msg = generateWAMessageFromContent(group, { conversation: 'seed' }, { userJid: ME, messageId: id });
  await sock.relayMessage(group, msg.message, { messageId: id });
};

const rotate = async (sock, id) => {
  const msg = generateWAMessageFromContent(GROUP, { conversation: 'x' }, { userJid: ME, messageId: id });
  await sock.relayGroupMessageWithSenderKeyRotation(GROUP, msg.message, {
    allowedParticipants: [MEMBER_A.lid],
    messageId: id
  });
};

describe('rotation robustness — state cap', () => {
  it('never grows past MAX_STATES even when rollbacks are skipped', async () => {
    const { sock, rawKeys } = await setupSocket({ participants: ALL });
    await seedGroup(sock, GROUP, 'SEED-CAP');

    // Simulate the failure mode the cap protects against: the rollback never
    // runs, so each rotation leaves its state behind.
    const realRollback = sock.signalRepository.rollbackSenderKeyRotation;
    sock.signalRepository.rollbackSenderKeyRotation = async () => ({ rolledBack: false, senderKeyId: null });

    for (let i = 0; i < 8; i++) {
      await rotate(sock, `CAP-${i}`);
    }
    sock.signalRepository.rollbackSenderKeyRotation = realRollback;

    const ids = storedStateIds(rawKeys, GROUP);
    console.log('\n=== states after 8 unrolled rotations ===');
    console.log('length:', ids.length, '| ids:', ids.join(','));
    assert.ok(ids.length <= 5, `record must stay at or below MAX_STATES (got ${ids.length})`);
  });

  it('rolls back cleanly under the cap (baseline survives)', async () => {
    const { sock, rawKeys } = await setupSocket({ participants: ALL });
    await seedGroup(sock, GROUP, 'SEED-CAP2');
    const baseline = storedStateIds(rawKeys, GROUP);

    await rotate(sock, 'CAP-OK');
    assert.deepEqual(storedStateIds(rawKeys, GROUP), baseline, 'baseline restored after a normal rotation');
  });
});

describe('rotation robustness — empty-state prune', () => {
  it('drops states without a chain key on rollback', async () => {
    const { sock, rawKeys, keys } = await setupSocket({ participants: ALL });
    await seedGroup(sock, GROUP, 'SEED-PRUNE');

    const name = Object.keys(rawKeys._data)
      .find(k => k.startsWith('sender-key:') && k.includes(GROUP))
      .slice('sender-key:'.length);
    console.log('\n=== stored sender-key name ===', name);
    // The sender key name is built from the identity used for the group send,
    // which is the LID when the group addresses by LID.
    const meId = name.includes(ME_LID.split('@')[0]) ? ME_LID : ME;

    // Prepend two unusable states (no senderChainKey) ahead of the real one,
    // the shape a malformed structure leaves behind. Written through the key
    // store so the cache stays coherent with what is persisted.
    const { [name]: stored } = await keys.get('sender-key', [name]);
    const record = SenderKeyRecord.deserialize(stored);
    const usable = record.senderKeyStates[record.senderKeyStates.length - 1];
    const empty = () => new SenderKeyState(null, null, null, null, null, null, {});
    let emptyThrows = false;
    try {
      empty().getSenderChainKey();
    }
    catch {
      emptyThrows = true;
    }
    assert.ok(emptyThrows, 'fixture state really has no usable chain key (getSenderChainKey throws)');

    const corrupted = new SenderKeyRecord();
    corrupted.senderKeyStates.push(empty(), empty(), usable);
    await keys.set({ 'sender-key': { [name]: Buffer.from(JSON.stringify(corrupted.serialize()), 'utf-8') } });

    const before = SenderKeyRecord.deserialize((await keys.get('sender-key', [name]))[name]).senderKeyStates.length;
    const result = await sock.signalRepository.rollbackSenderKeyRotation({ group: GROUP, meId });

    const after = SenderKeyRecord.deserialize((await keys.get('sender-key', [name]))[name]).senderKeyStates.length;
    console.log('\n=== prune on rollback ===');
    console.log('states before:', before, '| after:', after, '| rolledBack:', result.rolledBack);
    assert.ok(after < before, 'unusable states were pruned');
    assert.equal(after, 1, 'only the usable baseline state remains');
  });

  it('keeps a usable single state (does not strip the group bare)', async () => {
    const { sock, rawKeys } = await setupSocket({ participants: ALL });
    await seedGroup(sock, GROUP, 'SEED-PRUNE2');
    const before = storedStateIds(rawKeys, GROUP);

    const result = await sock.signalRepository.rollbackSenderKeyRotation({ group: GROUP, meId: ME });

    assert.equal(result.rolledBack, false, 'nothing to undo with a single state');
    assert.deepEqual(storedStateIds(rawKeys, GROUP), before, 'the only state was kept');
  });
});

describe('rotation robustness — messageId is required', () => {
  it('throws a Boom when messageId is missing', async () => {
    const { sock } = await setupSocket({ participants: ALL });
    const msg = generateWAMessageFromContent(GROUP, { conversation: 'x' }, { userJid: ME, messageId: 'NOID' });

    await assert.rejects(
      () => sock.relayGroupMessageWithSenderKeyRotation(GROUP, msg.message, { allowedParticipants: [MEMBER_A.lid] }),
      (err) => {
        assert.equal(err.isBoom, true, 'error is a Boom');
        assert.equal(err.output?.statusCode, 400, 'status 400');
        assert.match(err.message, /messageId/, 'message names the missing option');
        return true;
      }
    );
  });

  it('still works when messageId is present', async () => {
    const { sock } = await setupSocket({ participants: ALL });
    await seedGroup(sock, GROUP, 'SEED-ID');
    await assert.doesNotReject(() => rotate(sock, 'HAS-ID'));
  });
});
