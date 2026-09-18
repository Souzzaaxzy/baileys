/**
 * INVESTIGATION — where does the "only the target" selection stop existing?
 *
 * The real-device test answered this empirically: the log said `autorizados=1`
 * but every participant could read the message. This test captures the actual
 * stanza for a normal send and for a rotated send and compares them field by
 * field, to show exactly which layer carries the selection and which one does
 * not.
 *
 * It records STRUCTURE ONLY: tags, attributes, recipient JIDs, counts, enc
 * types, senderKeyIds. No keys, no chain keys, no plaintext, no credentials.
 *
 * Run: node tests/rotation-wire-comparison.test.js
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
import { decodeBinaryNode, binaryNodeToString } from '../lib/WABinary/index.js';
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
    return { jid: to.attrs.jid, encType: enc?.attrs?.type };
  });
};

/** Full structural view of a stanza: no key material, no plaintext. */
const describeStanza = (stanza, label) => {
  const children = (stanza.content ?? []).map(n => n.tag);
  const recipientNodes = readRecipients(stanza);
  const stanzaEncs = (stanza.content ?? [])
    .filter(n => n.tag === 'enc')
    .map(n => ({ type: n.attrs.type, v: n.attrs.v, count: n.attrs.count, decryptFail: n.attrs['decrypt-fail'], phash: n.attrs.phash }));

  return {
    label,
    topLevelAttrs: Object.keys(stanza.attrs).sort(),
    to: stanza.attrs.to,
    participantAttr: stanza.attrs.participant ?? null,
    recipientAttr: stanza.attrs.recipient ?? null,
    id: stanza.attrs.id,
    type: stanza.attrs.type,
    category: stanza.attrs.category ?? null,
    children,
    stanzaEncNodes: stanzaEncs,
    recipientNodeCount: recipientNodes.length,
    recipientJids: recipientNodes.map(r => shortUser(r.jid)).sort(),
    recipientEncTypes: [...new Set(recipientNodes.map(r => r.encType))],
    // The decisive field: is the *addressing* of the stanza restricted to anyone?
    addressedToGroup: stanza.attrs.to === GROUP,
    hasPerRecipientAddressing: Boolean(stanza.attrs.participant || stanza.attrs.recipient)
  };
};

const ADMIN = participant('5511900000010@s.whatsapp.net', [0], { lid: '100000000000010@lid', admin: 'superadmin' });
const ADMIN_B = participant('5511900000011@s.whatsapp.net', [0], { lid: '100000000000011@lid', admin: 'admin' });
const MEMBER_A = participant('5511900000012@s.whatsapp.net', [0], { lid: '100000000000012@lid' });
const MEMBER_B = participant('5511900000013@s.whatsapp.net', [0], { lid: '100000000000013@lid' });
const ALL = [ADMIN, ADMIN_B, MEMBER_A, MEMBER_B];

describe('where the selection stops existing (wire comparison)', () => {
  it('normal vs rotated: the stanza addressing is identical — only the recipient NODES differ', async () => {
    const { sock, sent } = await setupSocket({ participants: ALL });

    // A normal group message.
    let before = sent.length;
    const normal = generateWAMessageFromContent(GROUP, { conversation: 'normal' }, { userJid: ME, messageId: 'W-1' });
    await sock.relayMessage(GROUP, normal.message, { messageId: 'W-1' });
    const normalStanza = (await readMessageStanzas(sent.slice(before))).pop();

    // A rotated message, only MEMBER_A allowed.
    before = sent.length;
    const rotated = generateWAMessageFromContent(GROUP, { conversation: 'rotacionada' }, { userJid: ME, messageId: 'W-2' });
    await sock.relayGroupMessageWithSenderKeyRotation(GROUP, rotated.message, {
      allowedParticipants: [MEMBER_A.lid],
      messageId: 'W-2'
    });
    const rotatedStanza = (await readMessageStanzas(sent.slice(before))).pop();

    const normalView = describeStanza(normalStanza, 'normal');
    const rotatedView = describeStanza(rotatedStanza, 'rajar4 (rotated)');

    console.log('\n=== NORMAL ===');
    console.log(JSON.stringify(normalView, null, 2));
    console.log('\n=== RAJAR4 (rotated) ===');
    console.log(JSON.stringify(rotatedView, null, 2));

    console.log('\n=== RAW rotated stanza (structure only) ===');
    console.log(binaryNodeToString(rotatedStanza));

    // THE FINDING: both stanzas are addressed to the GROUP, with no
    // per-recipient addressing attribute. The only difference is which devices
    // got an SKDM node. The server is told the same thing in both cases.
    assert.equal(normalView.to, GROUP, 'normal is addressed to the group');
    assert.equal(rotatedView.to, GROUP, 'rotated is ALSO addressed to the group');
    assert.equal(rotatedView.participantAttr, null, 'rotated carries no participant attribute');
    assert.equal(rotatedView.recipientAttr, null, 'rotated carries no recipient attribute');
    assert.equal(rotatedView.hasPerRecipientAddressing, false, 'rotated has NO per-recipient addressing');

    // What actually differs: the number of nodes carrying the Sender Key.
    assert.ok(normalView.recipientNodeCount > rotatedView.recipientNodeCount, 'fewer SKDM nodes on the rotated send');
    assert.deepEqual(rotatedView.recipientJids, [shortUser(MEMBER_A.lid)], 'only the target got an SKDM node');

    // And the rotated stanza keeps the same group-level structure.
    assert.ok(rotatedView.children.includes('enc'), 'the group ciphertext is still on the stanza');
    assert.ok(rotatedView.stanzaEncNodes.some(e => e.type === 'skmsg'), 'and it is still a skmsg');

    await sock.ws.close().catch(() => {});
  });

  it('the server is told the same thing in both cases: one group JID', async () => {
    const { sock, sent } = await setupSocket({ participants: ALL });

    const normal = generateWAMessageFromContent(GROUP, { conversation: 'a' }, { userJid: ME, messageId: 'V-1' });
    await sock.relayMessage(GROUP, normal.message, { messageId: 'V-1' });
    const rotated = generateWAMessageFromContent(GROUP, { conversation: 'b' }, { userJid: ME, messageId: 'V-2' });
    await sock.relayGroupMessageWithSenderKeyRotation(GROUP, rotated.message, {
      allowedParticipants: [MEMBER_A.lid],
      messageId: 'V-2'
    });

    const stanzas = await readMessageStanzas(sent);
    const targets = stanzas.map(s => s.attrs.to);
    console.log('\ntargets of every message stanza sent:', targets);
    assert.deepEqual(targets, [GROUP, GROUP], 'both stanzas go to the group JID — the server sees no subset');

    await sock.ws.close().catch(() => {});
  });
});