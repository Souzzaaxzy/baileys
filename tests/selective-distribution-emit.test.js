/**
 * EXPERIMENT — the detection must reach the application IMMEDIATELY.
 *
 * This drives the REAL inbound path: a decoded `message` node goes through the
 * socket's own listener, `handleMessage`, the real signal repository and the
 * `messages.upsert` event the bot consumes. That is the only way to cover the
 * actual fix, because the delay lived in `handleMessage`'s retry block (a global
 * mutex held for `retryRequestDelayMs`, 5s in Lizzy).
 *
 * Run: node tests/selective-distribution-emit.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { proto } from '../WAProto/index.js';
import { makeMessagesRecvSocket } from '../lib/Socket/messages-recv.js';
import { makeCacheableSignalKeyStore, initAuthCreds } from '../lib/Utils/auth-utils.js';
import { writeRandomPadMax16 } from '../lib/Utils/generics.js';
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js';
import { Browsers } from '../lib/Utils/browser-utils.js';
import { WebSocketClient } from '../lib/Socket/Client/index.js';
import { GroupSessionBuilder, GroupCipher, SenderKeyName, SenderKeyRecord } from '../lib/Signal/Group/index.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOGLEVEL ?? 'silent' });
const GROUP = '120363000000000001@g.us';
const ME = '5511900000001@s.whatsapp.net';
const ME_LID = '100000000000001@lid';
const AUTHOR = '100000000000050@lid';

const senderKeyName = new SenderKeyName(GROUP, { toString: () => '100000000000050_1' });

const makeKeys = () => {
  const data = {};
  return {
    _data: data,
    get: async (type, ids) => { const o = {}; for (const id of ids) o[id] = data[`${type}:${id}`]; return o; },
    set: async (p) => {
      for (const [t, es] of Object.entries(p)) {
        for (const [id, v] of Object.entries(es)) {
          if (v === null) delete data[`${t}:${id}`];
          else data[`${t}:${id}`] = v;
        }
      }
    }
  };
};

/** Boot the real recv socket with a recorded transport. */
const setupSocket = async ({ retryRequestDelayMs }) => {
  const creds = initAuthCreds();
  creds.me = { id: ME, lid: ME_LID, name: 'test' };
  const rawKeys = makeKeys();
  const keys = makeCacheableSignalKeyStore(rawKeys, logger);
  const sent = [];

  WebSocketClient.prototype.connect = function connect() {
    this.socket = {
      readyState: 1,
      send: (frame, cb) => { sent.push(Buffer.from(frame)); cb?.(null); return true; },
      on: () => {}, off: () => {}, setMaxListeners: () => {}, close: () => {},
      once: (e, cb) => { if (e === 'close') setImmediate(cb); }
    };
  };

  const sock = makeMessagesRecvSocket({
    logger,
    auth: { creds, keys },
    waWebSocketUrl: 'ws://127.0.0.1:9/',
    makeSignalRepository: makeLibSignalRepository,
    shouldIgnoreJid: () => false,
    getMessage: async () => undefined,
    patchMessageBeforeSending: m => m,
    browser: Browsers.macOS('Chrome'),
    shouldSyncHistoryMessage: () => false,
    keepAliveIntervalMs: 60_000,
    enableRecentMessageCache: true,
    maxMsgRetryCount: 5,
    // The Lizzy value: this is what used to serialize the handler.
    retryRequestDelayMs,
    transactionOpts: { maxCommitRetries: 2, delayBetweenTriesMs: 1 },
    connectTimeoutMs: 5_000,
    options: {}
  });
  await new Promise(r => setTimeout(r, 20));
  sock.signalRepository.validateSession = async () => ({ exists: true });
  return { sock, sent };
};

/** A group skmsg whose Sender Key the receiving device never gets. */
const buildGhostNode = async ({ id, withDecryptFail }) => {
  const record = new SenderKeyRecord();
  const store = {
    loadSenderKey: async () => record,
    storeSenderKey: async (_n, k) => { record.senderKeyStates = k.senderKeyStates; }
  };
  await new GroupSessionBuilder(store).create(senderKeyName);
  const ciphertext = await new GroupCipher(store, senderKeyName).encrypt(
    writeRandomPadMax16(proto.Message.encode({ conversation: 'fantasma' }).finish())
  );
  const encAttrs = { v: '2', type: 'skmsg' };
  if (withDecryptFail) encAttrs['decrypt-fail'] = 'hide';
  return {
    tag: 'message',
    attrs: { id, from: GROUP, participant: AUTHOR, t: String(Math.floor(Date.now() / 1000)), type: 'text' },
    content: [{ tag: 'enc', attrs: encAttrs, content: ciphertext }]
  };
};

const collectDetections = (sock) => {
  const upserts = [];
  sock.ev.on('messages.upsert', (m) => {
    for (const msg of m.messages ?? []) {
      if (msg.selectiveDistribution) upserts.push(msg);
    }
  });
  return upserts;
};

describe('selective distribution — immediate delivery through the real path', () => {
  it('emits the detection promptly even with a 5s retryRequestDelayMs (the Lizzy setup)', async () => {
    const { sock } = await setupSocket({ retryRequestDelayMs: 5000 });
    const upserts = collectDetections(sock);

    const t0 = Date.now();
    sock.ws.emit('CB:message', await buildGhostNode({ id: 'LAT-1', withDecryptFail: true }));

    // With the bug (delay inside the mutex AND the emit at the end of the handler)
    // this would take ~5s or not arrive within this window at all.
    const deadline = t0 + 2500;
    while (Date.now() < deadline && upserts.length === 0) {
      await new Promise(r => setTimeout(r, 50));
    }
    const elapsed = upserts.length ? Date.now() - t0 : null;

    console.log(`\n=== deteccao pelo caminho real (retryRequestDelayMs=5000) ===`);
    console.log(`upserts com deteccao: ${upserts.length} | tempo: ${elapsed}ms`);

    assert.ok(upserts.length >= 1, 'the detection reached the application');
    assert.ok(elapsed < 2000, `it arrived in ${elapsed}ms, not serialized behind the 5s retry delay`);
    assert.equal(upserts[0].messageStubType, proto.WebMessageInfo.StubType.CIPHERTEXT);

    await sock.ws.close().catch(() => {});
  });

  it('emits each detected message EXACTLY once (no duplicate punishment)', async () => {
    const { sock } = await setupSocket({ retryRequestDelayMs: 0 });
    const upserts = collectDetections(sock);

    sock.ws.emit('CB:message', await buildGhostNode({ id: 'ONCE-1', withDecryptFail: true }));
    await new Promise(r => setTimeout(r, 900));

    const forThis = upserts.filter(m => m.key?.id === 'ONCE-1');
    console.log('upserts para ONCE-1:', forThis.length);
    assert.equal(forThis.length, 1, 'emitted exactly once');

    await sock.ws.close().catch(() => {});
  });

  it('does not flag an undecryptable message without decrypt-fail', async () => {
    const { sock } = await setupSocket({ retryRequestDelayMs: 0 });
    const upserts = collectDetections(sock);

    sock.ws.emit('CB:message', await buildGhostNode({ id: 'NOFLAG-1', withDecryptFail: false }));
    await new Promise(r => setTimeout(r, 900));

    const forThis = upserts.filter(m => m.key?.id === 'NOFLAG-1');
    assert.equal(forThis.length, 0, 'no intent signal → no detection');

    await sock.ws.close().catch(() => {});
  });
});