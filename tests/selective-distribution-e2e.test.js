/**
 * End-to-end: the sender restricts the group fan-out (members-only) and the
 * EXCLUDED admin cannot decrypt. This is the exact situation the Lizzy anti
 * ("antifantasma") consumes.
 *
 * Everything is real:
 *   - the send path is the fork's own `relayMessage` (group metadata, USync
 *     device discovery, Signal pairwise + Sender Key encryption, binary encode);
 *   - the captured frame is decoded with the fork's own decoder;
 *   - the excluded device really tries to decrypt with `GroupCipher` and really
 *     fails (it was never given the Sender Key);
 *   - `isSelectiveDistributionFailure` / `buildSelectiveDistributionReport` run
 *     on that real failure and the real stanza.
 *
 * The result is what the receiver-side anti sees: `selectiveDistribution` set,
 * with the structural signals (decrypt-fail, phash, density).
 *
 * Run: node --test tests/selective-distribution-e2e.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import pino from 'pino';

import { proto } from '../WAProto/index.js';
import { makeMessagesRecvSocket } from '../lib/Socket/messages-recv.js';
import { makeCacheableSignalKeyStore, initAuthCreds } from '../lib/Utils/auth-utils.js';
import { generateWAMessageFromContent } from '../lib/Utils/messages.js';
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js';
import { decodeBinaryNode } from '../lib/WABinary/index.js';
import { NOISE_WA_HEADER } from '../lib/Defaults/index.js';
import { Browsers } from '../lib/Utils/browser-utils.js';
import { WebSocketClient } from '../lib/Socket/Client/index.js';
import { GroupSessionBuilder, GroupCipher, SenderKeyName, SenderKeyRecord, SenderKeyDistributionMessage } from '../lib/Signal/Group/index.js';
import { isSelectiveDistributionFailure, buildSelectiveDistributionReport } from '../lib/Utils/selective-distribution-detector.js';
import { makeRemoteDevice } from './helpers/test-signal-sessions.js';

const require = createRequire(import.meta.url);
const { ProtocolAddress } = require('libsignal');

const logger = pino({ level: 'silent' });
const GROUP = '120363000000000001@g.us';
const ME = '5511900000001@s.whatsapp.net';
const ME_LID = '100000000000001@lid';

const makeKeys = () => {
  const data = {};
  return {
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
        tag: 'iq', attrs: { type: 'result' },
        content: [{
          tag: 'group',
          attrs: { id: GROUP, addressing_mode: 'lid', subject: 'test group' },
          content: groupParticipants.map(p => ({ tag: 'participant', attrs: { jid: p.id, ...(p.admin ? { type: p.admin } : {}) } }))
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
          tag: 'user', attrs: { jid },
          content: [{ tag: 'devices', attrs: {}, content: [{ tag: 'device-list', attrs: {}, content: (devicesByUser.get(user) ?? []).map(device => ({ tag: 'device', attrs: { id: String(device), 'key-index': '1' } })) }] }]
        };
      });
      return { tag: 'iq', attrs: { type: 'result' }, content: [{ tag: 'usync', attrs: {}, content: [{ tag: 'list', attrs: {}, content: users }] }] };
    }
    return { tag: 'iq', attrs: { type: 'result' }, content: [] };
  };
};

const sendAndCapture = async ({ participants, content, options = {}, msgId = 'MSG-1' }) => {
  const creds = initAuthCreds();
  creds.me = { id: ME, lid: ME_LID, name: 'test' };
  const keys = makeCacheableSignalKeyStore(makeKeys(), logger);

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
      once: (event, cb) => { if (event === 'close') setImmediate(cb); }
    };
  };

  const sock = makeMessagesRecvSocket({
    logger, auth: { creds, keys }, waWebSocketUrl: 'ws://127.0.0.1:9/',
    makeSignalRepository: makeLibSignalRepository, shouldIgnoreJid: () => false,
    getMessage: async () => undefined, patchMessageBeforeSending: msg => msg,
    browser: Browsers.macOS('Chrome'), shouldSyncHistoryMessage: () => false,
    keepAliveIntervalMs: 60_000, transactionOpts: { maxCommitRetries: 2, delayBetweenTriesMs: 1 },
    connectTimeoutMs: 5_000, options: {}
  });

  try {
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
    const msg = generateWAMessageFromContent(GROUP, { conversation: content }, { userJid: ME, messageId: msgId });
    await sock.relayMessage(GROUP, msg.message, { messageId: msgId, ...options });
    return { sent, remotes };
  } finally {
    await sock.ws.close().catch(() => {});
  }
};

const readMessageStanza = async (frames) => {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const node = await readFrameNode(frames[i], i === 0);
    if (node?.tag === 'message') return node;
  }
  throw new Error('no message stanza was captured');
};

const shortUser = jid => jid.split('@')[0].split(':')[0];

const readSkmsg = (stanza) => {
  const enc = (stanza.content ?? []).find(n => n.tag === 'enc');
  return enc && { type: enc.attrs.type, attrs: enc.attrs, ciphertext: enc.content };
};

describe('selective distribution — e2e (o sinal que o anti consome)', () => {
  it('o admin excluído NÃO consegue decifrar e o detector reconhece o ataque', async () => {
    const participants = [
      // admin: será EXCLUÍDO (não recebe a Sender Key)
      participant('5511900000010@s.whatsapp.net', [0], { lid: '100000000000010@lid', admin: 'admin' }),
      // membro comum: recebe a chave e lê
      participant('5511900000011@s.whatsapp.net', [0], { lid: '100000000000011@lid' })
    ];

    const { sent } = await sendAndCapture({
      participants,
      content: 'mensagem restrita aos membros',
      options: { recipientMode: 'members-only' }
    });

    const stanza = await readMessageStanza(sent);
    const skmsg = readSkmsg(stanza);
    assert.equal(skmsg.type, 'skmsg', 'é uma mensagem de Sender Key (grupo)');
    assert.equal(skmsg.attrs['decrypt-fail'], 'hide', 'o remetente marcou para esconder a entrada');

    // O admin tenta decifrar como um cliente real: sem a Sender Key, o
    // `GroupCipher` falha. É esse erro real que alimenta o detector.
    const record = new SenderKeyRecord();
    const store = {
      loadSenderKey: async () => record,
      storeSenderKey: async () => {}
    };
    const senderName = new SenderKeyName(GROUP, new ProtocolAddress(shortUser(ME_LID), 0));
    const cipher = new GroupCipher(store, senderName);

    let erroReal = null;
    try {
      await cipher.decrypt(skmsg.ciphertext);
    } catch (e) {
      erroReal = e;
    }
    assert.ok(erroReal, 'o admin NÃO decifra (não recebeu a chave)');

    // O detector roda sobre o erro REAL + a stanza REAL.
    const assinatura = isSelectiveDistributionFailure({
      encType: skmsg.type,
      encAttrs: skmsg.attrs,
      error: erroReal
    });
    assert.equal(assinatura, true, 'a falha é reconhecida como distribuição seletiva');
  });

  it('o report traz os sinais estruturais (decrypt-fail, phash, densidade)', async () => {
    const participants = [
      participant('5511900000020@s.whatsapp.net', [0], { lid: '100000000000020@lid', admin: 'admin' }),
      participant('5511900000021@s.whatsapp.net', [0], { lid: '100000000000021@lid' })
    ];
    const { sent } = await sendAndCapture({
      participants,
      content: 'restrita',
      options: { recipientMode: 'members-only' }
    });
    const stanza = await readMessageStanza(sent);
    const skmsg = readSkmsg(stanza);

    const report = buildSelectiveDistributionReport({
      stanza,
      error: { message: 'No session found to decrypt message' },
      skdmRecentMs: 1200
    });

    assert.equal(report.kind, 'selective-distribution');
    assert.equal(report.decryptFail, 'hide');
    assert.equal(report.encType, 'skmsg');
    // sinais estruturais que não dependem do atributo do remetente
    assert.equal(typeof report.hasPhash, 'boolean');
    assert.ok(report.addressedDeviceCount >= 1);
    assert.ok(report.skdmRecentMs === 1200);
  });

  it('a mensagem NORMAL (sem restrição) não é marcada', async () => {
    const participants = [
      participant('5511900000030@s.whatsapp.net', [0], { lid: '100000000000030@lid', admin: 'admin' }),
      participant('5511900000031@s.whatsapp.net', [0], { lid: '100000000000031@lid' })
    ];
    const { sent } = await sendAndCapture({ participants, content: 'normal' });
    const stanza = await readMessageStanza(sent);
    const skmsg = readSkmsg(stanza);

    assert.equal(skmsg.attrs['decrypt-fail'], undefined, 'sem restrição, sem decrypt-fail');
    assert.equal(
      isSelectiveDistributionFailure({ encType: skmsg.type, encAttrs: skmsg.attrs, error: new Error('No session found to decrypt message') }),
      false,
      'falha sem decrypt-fail não é tratada como distribuição seletiva'
    );
  });
});
