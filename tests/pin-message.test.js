/**
 * Pin / Unpin — caminho REAL de envio (sendMessage -> relayMessage -> stanza).
 *
 * Nao verifica so o objeto em memoria: envia por um socket real (WebSocket
 * falso), captura a stanza do grupo, DECIFRA o ciphertext com a Sender Key que
 * o recebedor efetivamente recebeu e confere o `pinInChatMessage` que chega no
 * fio. Prova:
 *   - `{ pin, type, time }` vira `pinInChatMessage` com `key`, `type` e
 *     `senderTimestampMs`;
 *   - `type = PIN_FOR_ALL` (1) / `UNPIN_FOR_ALL` (2) — os valores do WAProto
 *     local, nao numeros magicos;
 *   - `messageContextInfo.messageAddOnDurationInSecs` = duracao so na fixacao;
 *   - a `WAMessageKey` (remoteJid/fromMe/id/participant) e preservada;
 *   - a stanza leva `edit=2` e o no `<meta content_type="add_on">`.
 *
 * Run: node --test tests/pin-message.test.js
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

const PIN_FOR_ALL = proto.Message.PinInChatMessage.Type.PIN_FOR_ALL;
const UNPIN_FOR_ALL = proto.Message.PinInChatMessage.Type.UNPIN_FOR_ALL;

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

/** Constroi a sessao de grupo do recebedor a partir do SKDM que ele recebeu. */
const makeReceiverSession = async (recipient, remotes) => {
  const record = new SenderKeyRecord();
  const store = {
    loadSenderKey: async () => record,
    storeSenderKey: async (_name, key) => {
      record.senderKeyStates = key.senderKeyStates;
    }
  };
  const senderName = new SenderKeyName(GROUP, new ProtocolAddress(shortUser(ME_LID), 0));
  const builder = new GroupSessionBuilder(store);

  const inner = await decryptFor(recipient, remotes);
  const skdm = inner.senderKeyDistributionMessage;
  assert.ok(skdm?.axolotlSenderKeyDistributionMessage, 'recipient received a Sender Key Distribution Message');

  await builder.process(
    senderName,
    new SenderKeyDistributionMessage(null, null, null, null, skdm.axolotlSenderKeyDistributionMessage)
  );
  return {
    decrypt: async (ciphertext) => {
      const plaintext = await new GroupCipher(store, senderName).decrypt(ciphertext);
      return proto.Message.decode(unpadRandomMax16(plaintext));
    }
  };
};

const MEMBER = participant('5511900000002@s.whatsapp.net', [0], { lid: '100000000000002@lid' });

/** Envia um pin pelo caminho completo e devolve o que o recebedor decifra. */
const sendPinAndDecode = async (content, messageId) => {
  const { sock, sent, remotes } = await setupSocket({ participants: [MEMBER] });

  await sock.sendMessage(GROUP, content, { messageId });

  const stanza = await readMessageStanza(sent);
  // Destrava a sessao de grupo: a primeira mensagem carrega o SKDM. Para o pin
  // nao ha mensagem anterior, entao montamos a sessao a partir dos nos <to>
  // (que e exatamente como o cliente faz).
  const recipient = readRecipients(stanza).find(r => shortUser(r.jid) === shortUser(MEMBER.lid));
  assert.ok(recipient, 'member is addressed');
  const session = await makeReceiverSession(recipient, remotes);

  const skmsg = readSkmsg(stanza);
  assert.ok(skmsg?.ciphertext, 'group message carries an skmsg');
  const decoded = await session.decrypt(skmsg.ciphertext);
  return { stanza, decoded };
};

const TARGET_KEY = {
  remoteJid: GROUP,
  fromMe: false,
  id: 'ORIGINAL-MSG-ID',
  participant: '5511900000009@s.whatsapp.net'
};

describe('pin: { pin, type, time } -> pinInChatMessage', () => {
  it('PIN_FOR_ALL preserva key, marca senderTimestampMs e poe a duracao', async () => {
    const before = Date.now();
    const { stanza, decoded } = await sendPinAndDecode(
      { pin: TARGET_KEY, type: PIN_FOR_ALL, time: 86400 },
      'PIN-24H'
    );
    const after = Date.now();

    assert.ok(decoded.pinInChatMessage, 'chega um pinInChatMessage');
    assert.equal(decoded.pinInChatMessage.type, PIN_FOR_ALL, 'type = PIN_FOR_ALL');
    assert.equal(decoded.pinInChatMessage.type, proto.Message.PinInChatMessage.Type.PIN_FOR_ALL, 'bate com o enum do WAProto');
    assert.deepEqual(
      JSON.parse(JSON.stringify(decoded.pinInChatMessage.key)),
      TARGET_KEY,
      'a WAMessageKey e preservada inteira'
    );
    const ts = Number(decoded.pinInChatMessage.senderTimestampMs);
    assert.ok(ts >= before && ts <= after, `senderTimestampMs preenchido (${ts})`);
    assert.equal(decoded.messageContextInfo.messageAddOnDurationInSecs, 86400, 'duracao 24h');

    // A stanza do grupo e um add-on: edit=2 + <meta content_type="add_on">.
    assert.equal(stanza.attrs.edit, '2', 'stanza leva edit=2');
    const meta = (stanza.content ?? []).find(n => n.tag === 'meta');
    assert.ok(meta, 'stanza leva um no <meta>');
    assert.equal(meta.attrs.content_type, 'add_on', 'meta.content_type = add_on');
  });

  it('UNPIN_FOR_ALL usa o enum correto e nao fixa duracao', async () => {
    const { stanza, decoded } = await sendPinAndDecode(
      { pin: TARGET_KEY, type: UNPIN_FOR_ALL },
      'UNPIN-1'
    );

    assert.equal(decoded.pinInChatMessage.type, UNPIN_FOR_ALL, 'type = UNPIN_FOR_ALL');
    assert.equal(decoded.pinInChatMessage.type, proto.Message.PinInChatMessage.Type.UNPIN_FOR_ALL, 'bate com o enum do WAProto');
    assert.deepEqual(
      JSON.parse(JSON.stringify(decoded.pinInChatMessage.key)),
      TARGET_KEY,
      'mesma key preservada'
    );
    assert.equal(
      decoded.messageContextInfo.messageAddOnDurationInSecs,
      0,
      'unpin nao carrega duracao (0)'
    );
    assert.equal(stanza.attrs.edit, '2', 'stanza de unpin tambem e add-on');
  });
});

describe('pin: duracoes nativas', () => {
  for (const [seconds, label] of [[86400, '24h'], [604800, '7d'], [2592000, '30d']]) {
    it(`time=${seconds} (${label}) chega intacto no fio`, async () => {
      const { decoded } = await sendPinAndDecode(
        { pin: TARGET_KEY, type: PIN_FOR_ALL, time: seconds },
        `PIN-${seconds}`
      );
      assert.equal(decoded.messageContextInfo.messageAddOnDurationInSecs, seconds, `duracao ${seconds}`);
      assert.equal(decoded.pinInChatMessage.type, PIN_FOR_ALL, 'continua sendo fixacao');
    });
  }

  it('sem time explicito, o padrao e 86400 (24h)', async () => {
    const { decoded } = await sendPinAndDecode(
      { pin: TARGET_KEY, type: PIN_FOR_ALL },
      'PIN-DEFAULT'
    );
    assert.equal(decoded.messageContextInfo.messageAddOnDurationInSecs, 86400, 'padrao 24h');
  });
});

describe('pin: chaves de grupo e de mensagem propria', () => {
  it('key de mensagem do PROPRIO bot (fromMe true) nao inventa participant', async () => {
    const ownKey = { remoteJid: GROUP, fromMe: true, id: 'OWN-MSG' };
    const { decoded } = await sendPinAndDecode(
      { pin: ownKey, type: PIN_FOR_ALL, time: 604800 },
      'PIN-OWN'
    );
    assert.equal(decoded.pinInChatMessage.key.fromMe, true, 'fromMe true preservado');
    assert.equal(decoded.pinInChatMessage.key.id, 'OWN-MSG', 'id preservado');
    assert.ok(!decoded.pinInChatMessage.key.participant, 'sem participant inventado');
  });

  it('key com participant LID e preservada como LID', async () => {
    const lidKey = {
      remoteJid: GROUP,
      fromMe: false,
      id: 'LID-MSG',
      participant: '100000000000002@lid'
    };
    const { decoded } = await sendPinAndDecode(
      { pin: lidKey, type: PIN_FOR_ALL, time: 86400 },
      'PIN-LID'
    );
    assert.equal(decoded.pinInChatMessage.key.participant, '100000000000002@lid', 'LID preservado');
  });
});

describe('pin: round-trip do proto', () => {
  it('pinInChatMessage sobrevive a encode -> decode', () => {
    const original = {
      pinInChatMessage: { key: TARGET_KEY, type: PIN_FOR_ALL, senderTimestampMs: 1790000000000 },
      messageContextInfo: { messageAddOnDurationInSecs: 2592000 }
    };
    const enc = proto.Message.encode(original).finish();
    const dec = proto.Message.decode(enc);

    assert.equal(dec.pinInChatMessage.type, PIN_FOR_ALL);
    assert.equal(dec.pinInChatMessage.key.id, TARGET_KEY.id);
    assert.equal(dec.pinInChatMessage.key.participant, TARGET_KEY.participant);
    assert.equal(Number(dec.pinInChatMessage.senderTimestampMs), 1790000000000);
    assert.equal(dec.messageContextInfo.messageAddOnDurationInSecs, 2592000);
  });
});
