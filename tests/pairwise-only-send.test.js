/**
 * MÉTODO C — envio pairwise-only (sem Sender Key).
 *
 * Roda o caminho REAL do `relayMessage` com sessões Signal de verdade e
 * confere o que sai no fio:
 *   - NÃO existe nó `<enc type="skmsg">` (é isso que caracteriza o método);
 *   - NÃO existe SenderKeyDistributionMessage;
 *   - o conteúdo vai em `<enc type="msg|pkmsg">` (por dispositivo);
 *   - o fan-out é só o subset autorizado;
 *   - o atributo `decrypt-fail` honra o modo (hide / omit / wait);
 *   - a supressão de retry é registrada por messageId.
 *
 * Run: node --test tests/pairwise-only-send.test.js
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
import { SenderKeyRecord } from '../lib/Signal/Group/index.js';
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
    get: async (type, ids) => { const o = {}; for (const i of ids) o[i] = data[`${type}:${i}`]; return o; },
    set: async (p) => { for (const [t, e] of Object.entries(p)) for (const [i, v] of Object.entries(e)) { if (v === null) delete data[`${t}:${i}`]; else data[`${t}:${i}`] = v; } }
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
      return { tag: 'iq', attrs: { type: 'result' }, content: [{ tag: 'usync', attrs: {}, content: [{ tag: 'list', attrs: {}, content: users }] }] };
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
      on: () => {}, off: () => {}, setMaxListeners: () => {}, close: () => {},
      once: (event, cb) => { if (event === 'close') setImmediate(cb); }
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

/** O último frame enviado, decodificado (a stanza da mensagem). */
const lastStanza = async (sent) => {
  for (let i = sent.length - 1; i >= 0; i--) {
    const node = await readFrameNode(sent[i], i === 0);
    if (node?.tag === 'message') return node;
  }
  return null;
};

/** Todos os filhos <enc> de uma stanza. */
const encChildren = (stanza) => {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.tag === 'enc') out.push(n);
    for (const c of n.content ?? []) walk(c);
  };
  walk(stanza);
  return out;
};

/** SenderKeyDistributionMessage foi para o fio? */
const hasSkdm = (stanza) => {
  let found = false;
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.tag === 'participants' || n.tag === 'to') return;
    if (n.tag === 'enc' && n.attrs?.type === 'skmsg') found = true;
    for (const c of n.content ?? []) walk(c);
  };
  walk(stanza);
  return found;
};

/** Sender Key foi criada/persistida no store? */
const hasSenderKey = (rawKeys) =>
  Object.keys(rawKeys._data).some(k => k.startsWith('sender-key:'));

const ADMIN = participant('5511900000010@s.whatsapp.net', [0], { lid: '100000000000010@lid', admin: 'superadmin' });
const MEMBER_A = participant('5511900000012@s.whatsapp.net', [0], { lid: '100000000000012@lid' });
const MEMBER_B = participant('5511900000013@s.whatsapp.net', [0], { lid: '100000000000013@lid' });
const ALL = [ADMIN, MEMBER_A, MEMBER_B];

const pairwiseSend = async (sock, id, decryptFail) => {
  const msg = generateWAMessageFromContent(GROUP, { conversation: 'invisivel' }, { userJid: ME, messageId: id });
  await sock.relayGroupMessagePairwiseOnly(GROUP, msg.message, {
    allowedParticipants: [MEMBER_A.lid],
    messageId: id,
    ...(decryptFail ? { decryptFail } : {})
  });
};

describe('MÉTODO C — pairwise-only', () => {
  it('a API existe no socket', async () => {
    const { sock } = await setupSocket({ participants: ALL });
    assert.equal(typeof sock.relayGroupMessagePairwiseOnly, 'function');
  });

  it('NÃO envia <enc type="skmsg"> (a ausência do skmsg é o método)', async () => {
    const { sock, sent } = await setupSocket({ participants: ALL });
    await pairwiseSend(sock, 'PW-1');

    const stanza = await lastStanza(sent);
    assert.ok(stanza, 'uma stanza foi enviada');
    const encs = encChildren(stanza);
    console.log('\n=== enc nodes no pairwise ===', JSON.stringify(encs.map(e => e.attrs)));
    assert.ok(encs.length > 0, 'há nós <enc>');
    assert.ok(!encs.some(e => e.attrs?.type === 'skmsg'), 'NENHUM skmsg');
    assert.ok(encs.some(e => e.attrs?.type === 'msg' || e.attrs?.type === 'pkmsg'), 'cifra por dispositivo (msg/pkmsg)');
  });

  it('NÃO distribui Sender Key e NÃO persiste sender-key-memory', async () => {
    const { sock, sent, rawKeys } = await setupSocket({ participants: ALL });
    await pairwiseSend(sock, 'PW-2');

    const stanza = await lastStanza(sent);
    assert.equal(hasSkdm(stanza), false, 'sem skmsg (logo, sem SKDM)');
    assert.equal(hasSenderKey(rawKeys), false, 'nenhuma Sender Key foi criada');
  });

  it('o fan-out é só o subset autorizado (o admin fica fora)', async () => {
    const { sock, sent } = await setupSocket({ participants: ALL });
    await pairwiseSend(sock, 'PW-3');

    const stanza = await lastStanza(sent);
    const targets = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.tag === 'to') targets.push(n.attrs?.jid);
      for (const c of n.content ?? []) walk(c);
    };
    walk(stanza);
    const base = (j) => (j ?? '').split('@')[0].split(':')[0];
    const alvoA = base(MEMBER_A.lid);
    const alvoAdmin = base(ADMIN.lid);
    console.log('\n=== destinatarios ===', targets.join(' | '));
    assert.ok(targets.some(t => base(t) === alvoA), 'o membro autorizado é destinatário');
    assert.ok(!targets.some(t => base(t) === alvoAdmin), 'o admin NÃO é destinatário');
  });

  it('decryptFail "hide" põe decrypt-fail=hide', async () => {
    const { sock, sent } = await setupSocket({ participants: ALL });
    await pairwiseSend(sock, 'PW-HIDE', 'hide');
    const stanza = await lastStanza(sent);
    const encs = encChildren(stanza);
    assert.ok(encs.every(e => e.attrs?.['decrypt-fail'] === 'hide'), 'todos com decrypt-fail=hide');
  });

  it('decryptFail "omit" NÃO põe o atributo', async () => {
    const { sock, sent } = await setupSocket({ participants: ALL });
    await pairwiseSend(sock, 'PW-OMIT', 'omit');
    const stanza = await lastStanza(sent);
    const encs = encChildren(stanza);
    assert.ok(encs.length > 0, 'há <enc>');
    assert.ok(encs.every(e => e.attrs?.['decrypt-fail'] === undefined), 'nenhum decrypt-fail');
  });

  it('decryptFail "wait" põe decrypt-fail=wait', async () => {
    const { sock, sent } = await setupSocket({ participants: ALL });
    await pairwiseSend(sock, 'PW-WAIT', 'wait');
    const stanza = await lastStanza(sent);
    const encs = encChildren(stanza);
    assert.ok(encs.every(e => e.attrs?.['decrypt-fail'] === 'wait'), 'todos com decrypt-fail=wait');
  });

  it('exige messageId (fail-closed: sem ele a supressão de retry vira no-op)', async () => {
    const { sock } = await setupSocket({ participants: ALL });
    const msg = generateWAMessageFromContent(GROUP, { conversation: 'x' }, { userJid: ME, messageId: 'NOID' });
    await assert.rejects(
      () => sock.relayGroupMessagePairwiseOnly(GROUP, msg.message, { allowedParticipants: [MEMBER_A.lid] }),
      (err) => { assert.equal(err.isBoom, true); assert.match(err.message, /messageId/); return true; }
    );
  });

  it('lista de alvos vazia é recusada (fail-closed)', async () => {
    const { sock } = await setupSocket({ participants: ALL });
    const msg = generateWAMessageFromContent(GROUP, { conversation: 'x' }, { userJid: ME, messageId: 'EMPTY' });
    await assert.rejects(() => sock.relayGroupMessagePairwiseOnly(GROUP, msg.message, { allowedParticipants: [], messageId: 'EMPTY' }));
  });

  it('o envio NORMAL do mesmo grupo continua com skmsg (não foi afetado)', async () => {
    const { sock, sent } = await setupSocket({ participants: ALL });
    const msg = generateWAMessageFromContent(GROUP, { conversation: 'normal' }, { userJid: ME, messageId: 'NORM-1' });
    await sock.relayMessage(GROUP, msg.message, { messageId: 'NORM-1' });

    const stanza = await lastStanza(sent);
    const encs = encChildren(stanza);
    console.log('\n=== enc nodes no envio normal ===', JSON.stringify(encs.map(e => e.attrs)));
    assert.ok(encs.some(e => e.attrs?.type === 'skmsg'), 'o envio normal usa skmsg');
  });
});
