/**
 * A RESTRICTED message (recipientMode / fresh Sender Key) must survive the
 * retry path too — not only the rotated one.
 *
 * Field symptom this locks down: of 10 restricted messages, 7 reached only the
 * members and 3 also reached the admin. The crypto was fine (the fresh key
 * excludes the admin); what leaked was the RETRY path. The excluded device
 * cannot decrypt, asks for a retry, and `sendMessagesAgain` answers it pairwise
 * — handing over exactly what the restriction withheld. The suppression used to
 * be registered only inside the rotation branch, so `recipientMode` sends were
 * never registered.
 *
 * Run: node tests/restricted-retry-withhold.test.js
 *
 * --- original header follows ---
 *
 * EXPERIMENT — does the rotated message survive the retry path now?
 *
 * This is the behaviour a real-device test asked for: the message is delivered
 * to everyone (so an excluded participant knows it exists and can quote it), but
 * only the intended participants can read it. Before the fix, an excluded
 * participant's retry receipt was answered with the content re-sent pairwise,
 * which handed over exactly what the rotation withheld.
 *
 * The test drives the real retry gate in `handleReceipt` by emitting the
 * decoded receipt node the socket's own dispatch expects, and checks whether a
 * resend is produced.
 *
 * Run: node tests/sender-key-rotation-retry-withhold.test.js
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
import { makeRemoteDevice } from './helpers/test-signal-sessions.js';
import pino from 'pino';

const require = createRequire(import.meta.url);

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
    // Required by `willSendMessageAgain`: without it the gate is
    // `retryCount < undefined` → false, no resend ever happens, and a test of
    // the retry path would silently prove nothing.
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

const ADMIN = participant('5511900000010@s.whatsapp.net', [0], { lid: '100000000000010@lid', admin: 'superadmin' });
const MEMBER_A = participant('5511900000012@s.whatsapp.net', [0], { lid: '100000000000012@lid' });
const ALL = [ADMIN, MEMBER_A];

/**
 * A retry receipt as the server delivers it for a GROUP message: `from` is the
 * group, `participant` is the device asking.
 */
const retryReceipt = ({ messageId, participantJid }) => ({
  tag: 'receipt',
  attrs: {
    id: messageId,
    type: 'retry',
    from: GROUP,
    participant: participantJid,
    t: String(Math.floor(Date.now() / 1000))
  },
  content: [
    {
      tag: 'retry',
      attrs: {
        count: '1',
        id: messageId,
        t: String(Math.floor(Date.now() / 1000)),
        v: '1'
      }
    }
  ]
});

/**
 * Feed a decoded node through the socket's own inbound dispatch.
 *
 * The receipt handler is registered on the websocket client
 * (`ws.on('CB:receipt', …)` in messages-recv.js), which is the same path a real
 * inbound frame takes after noise decoding. Emitting on `sock.ws` therefore
 * exercises the real `processNode` → `handleReceipt` chain, not a stand-in.
 */
const dispatchNode = async (sock, node) => {
  await sock.ws.emit('CB:receipt', node);
  await new Promise(resolve => setTimeout(resolve, 250));
};


describe('restricted message (recipientMode) — the retry must not hand the content over', () => {
  it('registers the restricted message, so the excluded admin gets NO resend', async () => {
    const { sock, sent } = await setupSocket({ participants: ALL });

    // 1) A normal message first: the admin gets the Sender Key here.
    let before = sent.length;
    const seed = generateWAMessageFromContent(GROUP, { conversation: 'antes' }, { userJid: ME, messageId: 'R-0' });
    await sock.relayMessage(GROUP, seed.message, { messageId: 'R-0' });
    assert.ok((await readMessageStanzas(sent.slice(before))).length > 0, 'the normal send produced a stanza');
    assert.equal(sock.suppressedRetryRegistry.isSuppressed('R-0'), false, 'a normal send is NOT suppressed');

    // 2) The RESTRICTED message, via the plain recipientMode path.
    before = sent.length;
    const secret = generateWAMessageFromContent(GROUP, { conversation: 'SEGREDO so membros' }, { userJid: ME, messageId: 'R-1' });
    await sock.relayMessage(GROUP, secret.message, { messageId: 'R-1', recipientMode: 'members-only' });
    assert.ok((await readMessageStanzas(sent.slice(before))).length > 0, 'the restricted send produced a stanza');

    // THE FIX: the restricted message must be registered, like a rotated one.
    // Before this it was not — and the admin's retry handed it over.
    assert.equal(
      sock.suppressedRetryRegistry.isSuppressed('R-1'),
      true,
      'the restricted message is registered for retry suppression'
    );

    // 3) The excluded admin asks for a retry.
    before = sent.length;
    await dispatchNode(sock, retryReceipt({ messageId: 'R-1', participantJid: ADMIN.lid }));
    const afterRetry = await readMessageStanzas(sent.slice(before));
    console.log('\n=== retry after a RESTRICTED message ===');
    console.log('message stanzas produced by the retry:', afterRetry.length);
    assert.equal(afterRetry.length, 0, 'the retry produced NO resend — the content stays withheld');

    // 4) A normal message's retry is still answered: the suppression is scoped
    //    and the dispatch really reaches the handler.
    before = sent.length;
    await dispatchNode(sock, retryReceipt({ messageId: 'R-0', participantJid: ADMIN.lid }));
    const afterNormalRetry = await readMessageStanzas(sent.slice(before));
    assert.ok(afterNormalRetry.length > 0, 'a normal message retry IS answered (so step 3 is meaningful)');

    await sock.ws.close().catch(() => {});
  });

  it('the FORMA 6 send (fresh Sender Key) is registered too', async () => {
    const { sock, sent } = await setupSocket({ participants: ALL });

    const before = sent.length;
    const secret = generateWAMessageFromContent(GROUP, { conversation: 'SEGREDO F6' }, { userJid: ME, messageId: 'R-2' });
    await sock.sendGroupMessageWithFreshSenderKey(GROUP, secret.message, {
      messageId: 'R-2',
      recipientMode: 'members-only'
    });
    assert.ok((await readMessageStanzas(sent.slice(before))).length > 0, 'the fresh-key send produced a stanza');
    assert.equal(sock.suppressedRetryRegistry.isSuppressed('R-2'), true, 'the fresh-key send is registered');

    const beforeRetry = sent.length;
    await dispatchNode(sock, retryReceipt({ messageId: 'R-2', participantJid: ADMIN.lid }));
    const afterRetry = await readMessageStanzas(sent.slice(beforeRetry));
    assert.equal(afterRetry.length, 0, 'no resend for the excluded admin');

    await sock.ws.close().catch(() => {});
  });
});
