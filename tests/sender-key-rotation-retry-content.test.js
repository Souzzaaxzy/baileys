/**
 * EXPERIMENT — does the retry hand the CONTENT to the excluded admin?
 *
 * The rotation's SKDM study showed the retry does not deliver the rotated key.
 * But Baileys answers a group retry with `relayMessage({ participant })`, which
 * re-sends the message **pairwise encrypted to that device** — the content is in
 * that pairwise node, not only the Sender Key. If so, an excluded admin recovers
 * the text through the ordinary retry flow regardless of the rotation.
 *
 * This test decrypts the retry node as the admin and prints the content.
 *
 * Run: node tests/sender-key-rotation-retry-content.test.js
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

/** The `<enc>` carried directly on the stanza (the retry node is here). */
const readStanzaEnc = (stanza) => {
  const enc = (stanza.content ?? []).find(n => n.tag === 'enc' && n.attrs.type !== 'skmsg');
  return enc && { attrs: enc.attrs, type: enc.attrs.type, ciphertext: enc.content };
};

const decryptWith = async (jid, ciphertext, type, remotes) => {
  const [user, device] = jid.split('@')[0].split(':');
  const remote = remotes.get(`${user}.${device ?? 0}`);
  assert.ok(remote, `no remote keys for ${jid}`);
  const plaintext = unpadRandomMax16(await remote.decrypt(ciphertext, type));
  return proto.Message.decode(plaintext);
};

const ADMIN = participant('5511900000010@s.whatsapp.net', [0], { lid: '100000000000010@lid', admin: 'superadmin' });
const MEMBER_A = participant('5511900000012@s.whatsapp.net', [0], { lid: '100000000000012@lid' });
const ALL = [ADMIN, MEMBER_A];

describe('rotation — can the excluded admin get the CONTENT through retry?', () => {
  it('measures what the retry node actually delivers to the admin', async () => {
    const { sock, sent, remotes } = await setupSocket({ participants: ALL });

    // A normal send, so the admin has key A and the group is healthy.
    let before = sent.length;
    const seed = generateWAMessageFromContent(GROUP, { conversation: 'antes' }, { userJid: ME, messageId: 'X-0' });
    await sock.relayMessage(GROUP, seed.message, { messageId: 'X-0' });
    void (await readMessageStanzas(sent.slice(before)));

    // The rotated message: only MEMBER_A is allowed.
    before = sent.length;
    const secret = generateWAMessageFromContent(GROUP, { conversation: 'SEGREDO ROTACIONADO' }, { userJid: ME, messageId: 'X-1' });
    await sock.relayGroupMessageWithSenderKeyRotation(GROUP, secret.message, {
      allowedParticipants: [MEMBER_A.lid],
      messageId: 'X-1'
    });
    const rotatedStanza = (await readMessageStanzas(sent.slice(before))).pop();
    const skmsg = readSkmsg(rotatedStanza);

    // Does the rotated stanza advertise phash / decrypt-fail?
    console.log('\n=== rotated stanza attributes ===');
    console.log('stanza attrs:', rotatedStanza.attrs);
    console.log('skmsg attrs  :', skmsg?.attrs);
    console.log('has phash    :', skmsg?.attrs?.phash !== undefined);
    console.log('decrypt-fail :', skmsg?.attrs?.['decrypt-fail'] ?? 'absent');

    // Now the admin's client asks for the retry — the ordinary flow.
    before = sent.length;
    await sock.relayMessage(GROUP, secret.message, {
      messageId: 'X-1',
      participant: { jid: ADMIN.lid, count: 1 }
    });
    const retryStanza = (await readMessageStanzas(sent.slice(before))).pop();
    assert.ok(retryStanza, 'the retry produced a stanza');

    console.log('\n=== retry stanza ===');
    console.log('to:', retryStanza.attrs.to, '| participant:', retryStanza.attrs.participant);

    // The pairwise enc on the stanza is what the admin decrypts.
    const stanzaEnc = readStanzaEnc(retryStanza);
    assert.ok(stanzaEnc, 'the retry carries a pairwise enc on the stanza');

    const inner = await decryptWith(ADMIN.lid, stanzaEnc.ciphertext, stanzaEnc.type, remotes);
    const content = inner.conversation ?? inner.extendedTextMessage?.text ?? null;
    console.log('admin decrypted retry enc, content:', JSON.stringify(content));

    // Report what this means for the isolation.
    //
    // This is a LIMITATION, recorded deliberately: Baileys answers a group
    // retry with `relayMessage({ participant })`, which re-sends the message
    // pairwise-encrypted to the asking device. So an excluded admin that retries
    // recovers the text, and the rotation does not hide the content from it. If
    // the retry path is ever made to withhold content for rotated messages, this
    // assertion will fail and should be updated then.
    assert.equal(
      content,
      'SEGREDO ROTACIONADO',
      'KNOWN LIMITATION: the retry re-sends the content pairwise to the excluded admin'
    );
    console.log('>>> LIMITATION: the retry re-sends the CONTENT pairwise — the admin recovers the text');

    // The stanza does carry `decrypt-fail=hide` (inherited from the rotation's
    // recipient restriction), so the client is told to hide the entry. Whether
    // that also suppresses the retry is a client behaviour this harness cannot
    // observe — and it is the deciding factor for the isolation.
    assert.equal(skmsg?.attrs?.['decrypt-fail'], 'hide', 'the client is told to hide the entry');
    // The rotated stanza carries no phash, unlike a normal skmsg fan-out.
    assert.equal(skmsg?.attrs?.phash, undefined, 'rotated stanza carries no phash');

    await sock.ws.close().catch(() => {});
  });
});