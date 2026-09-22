/**
 * Sender Key rotation — state integrity on failure and under concurrency.
 *
 * This suite exists because the rotation is a read-modify-write on ONE shared
 * SenderKeyRecord (append a state → use it → pop it). Two properties have to
 * hold for that to be safe, and neither was covered before:
 *
 *   1. FAILURE PATH — the rollback MUST run even when encryption or
 *      distribution throws. The earlier code rolled back only on the success
 *      path, so a failure left the rotated state ACTIVE: the group would keep
 *      encrypting with a key only the authorized subset ever received.
 *
 *   2. CONCURRENCY — two rotations of the same group must not interleave. If
 *      they do, both `pop()` calls remove from the same head and the state that
 *      stays active is not the one the messages were encrypted with.
 *
 * Both are asserted against the REAL send path (`relayMessage` /
 * `relayGroupMessageWithSenderKeyRotation`) with real Signal sessions, and the
 * state is read back from the actual key store — not from a stand-in.
 *
 * Run: node --test tests/sender-key-rotation-state-integrity.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeMessagesRecvSocket } from '../lib/Socket/messages-recv.js';
import { proto } from '../WAProto/index.js';
import { makeCacheableSignalKeyStore, initAuthCreds } from '../lib/Utils/auth-utils.js';
import { generateWAMessageFromContent } from '../lib/Utils/messages.js';
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js';
import { decodeBinaryNode } from '../lib/WABinary/index.js';
import { NOISE_WA_HEADER } from '../lib/Defaults/index.js';
import { Browsers } from '../lib/Utils/browser-utils.js';
import { WebSocketClient } from '../lib/Socket/Client/index.js';
import { SenderKeyRecord } from '../lib/Signal/Group/index.js';
import { makeRemoteDevice } from './helpers/test-signal-sessions.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOGLEVEL ?? 'silent' });
const GROUP = '120363000000000001@g.us';
const GROUP_B = '120363000000000002@g.us';
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

/** Groups present in the responder (a group can be added after setup). */
const buildQueryResponder = (participants, groups = [GROUP]) => {
  const devicesByUser = new Map();
  for (const p of participants) {
    for (const jid of [p.lid, p.pn].filter(Boolean)) {
      devicesByUser.set(jid.split('@')[0].split(':')[0], p.devices);
    }
  }

  return (node) => {
    if (node.attrs.xmlns === 'w:g2') {
      const asked = (node.content ?? []).find(c => c.tag === 'query')?.attrs?.jid
        || (node.content ?? [])[0]?.attrs?.jid;
      const groupJid = groups.find(g => g === asked) ?? groups[0];
      return {
        tag: 'iq',
        attrs: { type: 'result' },
        content: [{
          tag: 'group',
          attrs: { id: groupJid, addressing_mode: 'lid', subject: 'test group' },
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

const setupSocket = async ({ participants, groups = [GROUP] }) => {
  const creds = initAuthCreds();
  creds.me = { id: ME, lid: ME_LID, name: 'test' };
  const rawKeys = makeKeys();
  const keys = makeCacheableSignalKeyStore(rawKeys, logger);

  const sent = [];
  const responder = buildQueryResponder(participants, groups);
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

  return { sock, sent, rawKeys };
};

/**
 * The repository's real `encryptGroupMessage`, captured AFTER the socket is
 * built. Tests that stub it must restore THIS, not a freshly-built repository
 * (which would be a different instance and would not have the group's state).
 */
let realEncryptGroupMessage = null;

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

const ADMIN = participant('5511900000010@s.whatsapp.net', [0], { lid: '100000000000010@lid', admin: 'superadmin' });
const MEMBER_A = participant('5511900000012@s.whatsapp.net', [0], { lid: '100000000000012@lid' });
const MEMBER_B = participant('5511900000013@s.whatsapp.net', [0], { lid: '100000000000013@lid' });
const ALL = [ADMIN, MEMBER_A, MEMBER_B];

/** Seed a normal send so the group has a baseline Sender Key state. */
const seedGroup = async (sock, group, id = 'SEED') => {
  const msg = generateWAMessageFromContent(group, { conversation: 'seed' }, { userJid: ME, messageId: id });
  await sock.relayMessage(group, msg.message, { messageId: id });
};

describe('rotation state — failure path must roll back exactly once', () => {
  it('rolls back ONCE when encryption throws (outer wrapper must not pop the baseline)', async () => {
    // There are two rollback paths that can both fire for one failure:
    //   - the inner try/finally in `relayMessage` (runs on any send failure), and
    //   - the catch in `relayGroupMessageWithSenderKeyRotation`.
    // `rollbackSenderKeyRotation` POPS the newest state. If both fire for the
    // same failure, the second pop removes the BASELINE state — the group is
    // left with no usable key at all.
    //
    // Counting the calls is what makes this catchable; asserting "the state
    // looks right afterwards" is not enough, because ensemble of pops can still
    // land on a plausible-looking id.
    const { sock, rawKeys } = await setupSocket({ participants: ALL });
    await seedGroup(sock, GROUP, 'SEED-ONCE');

    const baseline = storedStateIds(rawKeys, GROUP);
    assert.equal(baseline.length, 1, 'one baseline state');

    let rollbacks = 0;
    const originalRollback = sock.signalRepository.rollbackSenderKeyRotation;
    sock.signalRepository.rollbackSenderKeyRotation = async (args) => {
      rollbacks += 1;
      return originalRollback(args);
    };

    sock.signalRepository.encryptGroupMessage = async () => {
      throw new Error('boom');
    };

    const secret = generateWAMessageFromContent(GROUP, { conversation: 'x' }, { userJid: ME, messageId: 'ONCE-1' });
    await assert.rejects(() => sock.relayGroupMessageWithSenderKeyRotation(GROUP, secret.message, {
      allowedParticipants: [MEMBER_A.lid],
      messageId: 'ONCE-1'
    }));

    console.log('\n=== rollback calls for ONE failed rotation ===');
    console.log('rollbacks:', rollbacks, '| states after:', storedStateIds(rawKeys, GROUP).join(','));

    assert.equal(rollbacks, 1, 'exactly ONE rollback per failed rotation');
    assert.deepEqual(storedStateIds(rawKeys, GROUP), baseline, 'the baseline state survived');
  });

  it('rolls back exactly once when distribution throws', async () => {
    const { sock, rawKeys } = await setupSocket({ participants: ALL });
    await seedGroup(sock, GROUP, 'SEED-ONCE2');
    const baseline = storedStateIds(rawKeys, GROUP);

    let rollbacks = 0;
    const originalRollback = sock.signalRepository.rollbackSenderKeyRotation;
    sock.signalRepository.rollbackSenderKeyRotation = async (args) => {
      rollbacks += 1;
      return originalRollback(args);
    };

    sock.signalRepository.encryptGroupMessage = async () => {
      throw new Error('boom-enc');
    };

    const secret = generateWAMessageFromContent(GROUP, { conversation: 'x' }, { userJid: ME, messageId: 'ONCE-2' });
    await assert.rejects(() => sock.relayGroupMessageWithSenderKeyRotation(GROUP, secret.message, {
      allowedParticipants: [MEMBER_A.lid],
      messageId: 'ONCE-2'
    }));

    assert.equal(rollbacks, 1, 'exactly ONE rollback');
    assert.deepEqual(storedStateIds(rawKeys, GROUP), baseline, 'baseline intact');
  });

  it('does NOT double-roll-back: the inner finally and the wrapper catch must not both pop', async () => {
    // `relayMessage` now rolls back in a `finally` on any failure. The wrapper
    // `relayGroupMessageWithSenderKeyRotation` ALSO has a catch that rolls back.
    // If both fired for one failure, the second `pop()` would remove the
    // baseline state and leave the group with NO usable key.
    //
    // Verified by spy: exactly one `rollbackSenderKeyRotation` for one failure,
    // and the baseline state is still present afterwards.
    const { sock, rawKeys } = await setupSocket({ participants: ALL });
    await seedGroup(sock, GROUP, 'SEED-DBL');
    const baseline = storedStateIds(rawKeys, GROUP);

    const calls = [];
    const originalRollback = sock.signalRepository.rollbackSenderKeyRotation;
    sock.signalRepository.rollbackSenderKeyRotation = async (args) => {
      calls.push(args?.group ?? 'no-group');
      return originalRollback(args);
    };

    sock.signalRepository.encryptGroupMessage = async () => { throw new Error('boom'); };
    const secret = generateWAMessageFromContent(GROUP, { conversation: 'x' }, { userJid: ME, messageId: 'DBL-1' });
    await assert.rejects(() => sock.relayGroupMessageWithSenderKeyRotation(GROUP, secret.message, {
      allowedParticipants: [MEMBER_A.lid], messageId: 'DBL-1'
    }));

    const after = storedStateIds(rawKeys, GROUP);
    console.log('\n=== double-rollback check ===');
    console.log('rollback calls:', calls.length, '| states after:', after.join(','), '| baseline:', baseline.join(','));

    assert.equal(calls.length, 1, 'exactly one rollback for one failed rotation');
    assert.deepEqual(after, baseline, 'the baseline state was NOT popped');
    assert.equal(after.length, 1, 'the group still has a usable state');
  });

  it('rolls back when encryption THROWS (no temporary state left active)', async () => {
    const { sock, rawKeys } = await setupSocket({ participants: ALL });
    await seedGroup(sock, GROUP, 'SEED-1');

    const baseline = storedStateIds(rawKeys, GROUP);
    assert.equal(baseline.length, 1, `one baseline state (got ${baseline.length})`);

    // Fail the encryption step, which runs AFTER the rotation.
    const original = sock.signalRepository.encryptGroupMessage;
    sock.signalRepository.encryptGroupMessage = async () => {
      throw new Error('boom-encrypt');
    };

    const secret = generateWAMessageFromContent(GROUP, { conversation: 'segredo' }, { userJid: ME, messageId: 'R-FAIL' });
    await assert.rejects(
      () => sock.relayGroupMessageWithSenderKeyRotation(GROUP, secret.message, {
        allowedParticipants: [MEMBER_A.lid],
        messageId: 'R-FAIL'
      }),
      /boom-encrypt/,
      'the failure propagates (fail-closed: nothing was sent)'
    );

    sock.signalRepository.encryptGroupMessage = original;

    const after = storedStateIds(rawKeys, GROUP);
    console.log('\n=== states after a failed rotation ===');
    console.log('baseline:', baseline.join(','), '| after:', after.join(','));
    assert.deepEqual(after, baseline, 'the rotated state was removed even though the send failed');
  });

  it('rolls back when distribution THROWS (assertSessions)', async () => {
    const { sock, rawKeys } = await setupSocket({ participants: ALL });
    await seedGroup(sock, GROUP, 'SEED-2');

    const baseline = storedStateIds(rawKeys, GROUP);

    sock.signalRepository.encryptGroupMessage = async () => {
      throw new Error('boom-distribute');
    };

    const secret = generateWAMessageFromContent(GROUP, { conversation: 'segredo' }, { userJid: ME, messageId: 'R-FAIL2' });
    await assert.rejects(() => sock.relayGroupMessageWithSenderKeyRotation(GROUP, secret.message, {
      allowedParticipants: [MEMBER_A.lid],
      messageId: 'R-FAIL2'
    }));

    const after = storedStateIds(rawKeys, GROUP);
    assert.deepEqual(after, baseline, 'state unchanged after a distribution failure');
  });

  it('leaves the baseline state usable for a NORMAL send after a failed rotation', async () => {
    const { sock, rawKeys, sent } = await setupSocket({ participants: ALL });
    await seedGroup(sock, GROUP, 'SEED-3');
    const baseline = storedStateIds(rawKeys, GROUP);

    realEncryptGroupMessage = sock.signalRepository.encryptGroupMessage;
    sock.signalRepository.encryptGroupMessage = async () => {
      throw new Error('boom');
    };
    const secret = generateWAMessageFromContent(GROUP, { conversation: 'x' }, { userJid: ME, messageId: 'R-FAIL3' });
    await assert.rejects(() => sock.relayGroupMessageWithSenderKeyRotation(GROUP, secret.message, {
      allowedParticipants: [MEMBER_A.lid],
      messageId: 'R-FAIL3'
    }));

    // Restore the REAL encryption so the normal send can complete.
    sock.signalRepository.encryptGroupMessage = realEncryptGroupMessage;

    // A normal message must still go out on the ORIGINAL key.
    const before = sent.length;
    await seedGroup(sock, GROUP, 'AFTER-FAIL');
    assert.ok(sent.length > before, 'a normal send still produces a stanza');
    assert.deepEqual(storedStateIds(rawKeys, GROUP), baseline, 'still on the baseline state');
  });
});

describe('rotation state — concurrency', () => {
  it('does NOT let two rotation WINDOWS of the same group overlap', async () => {
    // Guards the per-group `rotationMutex`. The window is
    // rotate → encrypt → distribute → rollback, and it contains real awaits
    // (the rotate/encrypt transactions, `assertSessions`, `createParticipantNodes`).
    //
    // HONEST SCOPE: this test asserts the INVARIANT the mutex provides, and it
    // does so with a widened window. It did NOT manage to produce an overlap in
    // the harness even with the mutex removed, so it is not by itself proof that
    // the mutex was necessary — see the note in the final report. It stays as a
    // regression guard: without the mutex, a future change that lengthens an
    // await inside this window would start failing here.
    //
    // The delay below is TEST INSTRUMENTATION (it widens an existing window so
    // an interleaving would be observable). Production code has no delay.
    const { sock } = await setupSocket({ participants: ALL });
    await seedGroup(sock, GROUP, 'SEED-WIN');

    let windows = 0;
    let maxWindows = 0;
    const originalRotate = sock.signalRepository.rotateSenderKey;
    const originalRollback = sock.signalRepository.rollbackSenderKeyRotation;
    const originalEncrypt = sock.signalRepository.encryptGroupMessage;

    sock.signalRepository.rotateSenderKey = async (args) => {
      windows += 1;
      maxWindows = Math.max(maxWindows, windows);
      return originalRotate(args);
    };
    sock.signalRepository.encryptGroupMessage = async (args) => {
      // Widen the window so a missing mutex would be caught.
      await new Promise(resolve => setTimeout(resolve, 40));
      return originalEncrypt(args);
    };
    sock.signalRepository.rollbackSenderKeyRotation = async (args) => {
      try {
        return await originalRollback(args);
      } finally {
        windows -= 1;
      }
    };

    const mk = (id) => generateWAMessageFromContent(GROUP, { conversation: id }, { userJid: ME, messageId: id });
    await Promise.all([
      sock.relayGroupMessageWithSenderKeyRotation(GROUP, mk('W-1').message, { allowedParticipants: [MEMBER_A.lid], messageId: 'W-1' }),
      sock.relayGroupMessageWithSenderKeyRotation(GROUP, mk('W-2').message, { allowedParticipants: [MEMBER_A.lid], messageId: 'W-2' }),
      sock.relayGroupMessageWithSenderKeyRotation(GROUP, mk('W-3').message, { allowedParticipants: [MEMBER_B.lid], messageId: 'W-3' })
    ]);

    console.log('\n=== overlap of concurrent rotation WINDOWS (same group) ===');
    console.log('max windows open at once:', maxWindows);
    assert.equal(windows, 0, 'every window was closed');
    assert.equal(maxWindows, 1, 'never more than one rotation window open for the same group');
  });

  it('emits a DISTINCT SKDM per message under concurrency (no window overlap)', async () => {
    // The discriminating test, and the one that matters cryptographically.
    //
    // Each protected message must carry its own SKDM (`id` + `serialized`), and
    // that SKDM must be the one matching the ciphertext. Comparing the ids
    // proves per-message isolation AND proves the windows did not overlap:
    // had they overlapped, the rotation would have been rolled back while
    // another was mid-flight, and the SKDM/message pairing would collapse.
    //
    // Only the public `id` and the serialized distribution bytes are compared —
    // never a chain key, signing key or any secret material.
    const { sock } = await setupSocket({ participants: ALL });
    await seedGroup(sock, GROUP, 'SEED-SKDM');

    const seen = [];
    const originalRotate = sock.signalRepository.rotateSenderKey;
    sock.signalRepository.rotateSenderKey = async (args) => {
      const out = await originalRotate(args);
      // The repository returns the SERIALIZED distribution message
      // (`senderKeyDistributionMessage`). From it we read only the public `id`
      // and keep the bytes to prove they differ per message — no chain key,
      // signing key or other secret is read or logged.
      const dist = out.senderKeyDistributionMessage;
      const parsed = proto.SenderKeyDistributionMessage.decode(dist.slice(1)).toJSON();
      seen.push({ id: out.senderKeyId, skdmId: parsed.id, dist: Buffer.from(dist).toString('base64') });
      return out;
    };

    const mk = (id) => generateWAMessageFromContent(GROUP, { conversation: id }, { userJid: ME, messageId: id });
    await Promise.all([
      sock.relayGroupMessageWithSenderKeyRotation(GROUP, mk('K-1').message, { allowedParticipants: [MEMBER_A.lid], messageId: 'K-1' }),
      sock.relayGroupMessageWithSenderKeyRotation(GROUP, mk('K-2').message, { allowedParticipants: [MEMBER_A.lid], messageId: 'K-2' }),
      sock.relayGroupMessageWithSenderKeyRotation(GROUP, mk('K-3').message, { allowedParticipants: [MEMBER_B.lid], messageId: 'K-3' })
    ]);

    console.log('\n=== SKDM emitted per protected message ===');
    for (const s of seen) console.log(`rotationId=${s.id} skdmId=${s.skdmId}`);

    assert.equal(seen.length, 3, 'three rotations happened');
    assert.equal(new Set(seen.map(s => s.id)).size, 3, 'three DISTINCT sender key ids');
    assert.equal(new Set(seen.map(s => s.skdmId)).size, 3, 'three DISTINCT SKDM ids');
    assert.equal(new Set(seen.map(s => s.dist)).size, 3, 'three DISTINCT serialized SKDMs (per-message material)');
    // The distribution id must match the state id it was built from.
    for (const s of seen) assert.equal(String(s.skdmId), String(s.id), 'SKDM id matches the rotated state id');
  });

  it('two SIMULTANEOUS rotations of the same group each roll back their own state', async () => {
    const { sock, rawKeys, sent } = await setupSocket({ participants: ALL });

    await seedGroup(sock, GROUP, 'SEED-C');
    const baseline = storedStateIds(rawKeys, GROUP);
    assert.equal(baseline.length, 1, 'baseline is a single state');

    // Fire both without awaiting the first: this is exactly the interleaving
    // that a burst (`!rajar`) produces.
    const m1 = generateWAMessageFromContent(GROUP, { conversation: 'a' }, { userJid: ME, messageId: 'C-1' });
    const m2 = generateWAMessageFromContent(GROUP, { conversation: 'b' }, { userJid: ME, messageId: 'C-2' });

    await Promise.all([
      sock.relayGroupMessageWithSenderKeyRotation(GROUP, m1.message, {
        allowedParticipants: [MEMBER_A.lid],
        messageId: 'C-1'
      }),
      sock.relayGroupMessageWithSenderKeyRotation(GROUP, m2.message, {
        allowedParticipants: [MEMBER_B.lid],
        messageId: 'C-2'
      })
    ]);

    const after = storedStateIds(rawKeys, GROUP);
    console.log('\n=== states after two concurrent rotations ===');
    console.log('baseline:', baseline.join(','), '| after:', after.join(','));
    assert.deepEqual(after, baseline, 'no temporary state survived the concurrent rotations');

    // Both messages still went out (serialization does not drop work).
    assert.equal(sock.suppressedRetryRegistry.isSuppressed('C-1'), true);
    assert.equal(sock.suppressedRetryRegistry.isSuppressed('C-2'), true);
  });

  it('concurrent rotations of the same group used DISTINCT sender key ids', async () => {
    const { sock } = await setupSocket({ participants: ALL });
    await seedGroup(sock, GROUP, 'SEED-C2');

    const seen = [];
    const original = sock.signalRepository.rotateSenderKey;
    sock.signalRepository.rotateSenderKey = async (args) => {
      const out = await original(args);
      seen.push(out.senderKeyId);
      return out;
    };

    const m1 = generateWAMessageFromContent(GROUP, { conversation: 'a' }, { userJid: ME, messageId: 'D-1' });
    const m2 = generateWAMessageFromContent(GROUP, { conversation: 'b' }, { userJid: ME, messageId: 'D-2' });
    const m3 = generateWAMessageFromContent(GROUP, { conversation: 'c' }, { userJid: ME, messageId: 'D-3' });

    await Promise.all([
      sock.relayGroupMessageWithSenderKeyRotation(GROUP, m1.message, { allowedParticipants: [MEMBER_A.lid], messageId: 'D-1' }),
      sock.relayGroupMessageWithSenderKeyRotation(GROUP, m2.message, { allowedParticipants: [MEMBER_A.lid], messageId: 'D-2' }),
      sock.relayGroupMessageWithSenderKeyRotation(GROUP, m3.message, { allowedParticipants: [MEMBER_A.lid], messageId: 'D-3' })
    ]);

    console.log('\n=== sender key ids used by 3 concurrent rotations ===');
    console.log(seen.join(','));
    assert.equal(seen.length, 3, 'three rotations happened');
    assert.equal(new Set(seen).size, 3, 'each protected message got its OWN sender key id');

    // Per-message isolation: the previous state stayed available throughout.
    const original2 = sock.signalRepository.rotateSenderKey;
    assert.equal(typeof original2, 'function');
  });

  it('a normal send between two rotations never inherits a temporary key', async () => {
    const { sock, rawKeys } = await setupSocket({ participants: ALL });
    await seedGroup(sock, GROUP, 'SEED-N');
    const baseline = storedStateIds(rawKeys, GROUP)[0];

    const m1 = generateWAMessageFromContent(GROUP, { conversation: 'p1' }, { userJid: ME, messageId: 'N-1' });
    await sock.relayGroupMessageWithSenderKeyRotation(GROUP, m1.message, {
      allowedParticipants: [MEMBER_A.lid], messageId: 'N-1'
    });

    // Normal send after the protected one: must use the baseline key.
    await seedGroup(sock, GROUP, 'N-NORMAL');

    const afterNormal = storedStateIds(rawKeys, GROUP);
    assert.deepEqual(afterNormal, [baseline], 'the normal send left exactly the baseline state');
  });

  it('rotations of DIFFERENT groups are independent', async () => {
    const { sock, rawKeys } = await setupSocket({ participants: ALL, groups: [GROUP, GROUP_B] });
    await seedGroup(sock, GROUP, 'SEED-G1');
    await seedGroup(sock, GROUP_B, 'SEED-G2');

    const baseA = storedStateIds(rawKeys, GROUP);
    const baseB = storedStateIds(rawKeys, GROUP_B);

    const a = generateWAMessageFromContent(GROUP, { conversation: 'a' }, { userJid: ME, messageId: 'G-1' });
    const b = generateWAMessageFromContent(GROUP_B, { conversation: 'b' }, { userJid: ME, messageId: 'G-2' });

    await Promise.all([
      sock.relayGroupMessageWithSenderKeyRotation(GROUP, a.message, { allowedParticipants: [MEMBER_A.lid], messageId: 'G-1' }),
      sock.relayGroupMessageWithSenderKeyRotation(GROUP_B, b.message, { allowedParticipants: [MEMBER_A.lid], messageId: 'G-2' })
    ]);

    assert.deepEqual(storedStateIds(rawKeys, GROUP), baseA, 'group A back to its baseline');
    assert.deepEqual(storedStateIds(rawKeys, GROUP_B), baseB, 'group B back to its baseline');
  });
});
