/**
 * End-to-end test of the EXPERIMENTAL pairwise group retransmission flow.
 *
 * Like members-only-send.test.js, this drives the REAL socket stack — real
 * group metadata query, real USync device discovery, real Signal pairwise and
 * Sender Key encryption, real binary encoding — with only the transport
 * recorded. Pairwise sessions are real: the test injects each device's public
 * bundle and later decrypts the retransmission with that device's own private
 * keys, so "this device could read the pairwise payload" is measured, not
 * assumed.
 *
 * The scenarios map to the task's A–G checklist. Where a scenario cannot be
 * proven in this harness (the live client's rendering), the test says so
 * instead of asserting a behaviour it cannot observe.
 *
 * Run: node tests/pairwise-experimental.test.js
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

  return { sock, sent, remotes };
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
    return { jid: to.attrs.jid, type: enc?.attrs?.type, count: enc?.attrs?.count, ciphertext: enc?.content };
  });
};

/** The `<enc>` carried on the stanza itself (the retry pairwise node). */
const readRetryEnc = (stanza) => {
  const enc = (stanza.content ?? []).find(n => n.tag === 'enc');
  return enc && { type: enc.attrs.type, attrs: enc.attrs, ciphertext: enc.content };
};

const readSkmsg = (stanza) => {
  const enc = (stanza.content ?? []).find(n => n.tag === 'enc');
  return enc && { type: enc.attrs.type, attrs: enc.attrs, ciphertext: enc.content };
};

/** Decrypt a pairwise payload with the recipient device's own session. */
const decryptPairwiseFor = async (jid, ciphertext, type, remotes) => {
  const [user, device] = jid.split('@')[0].split(':');
  const remote = remotes.get(`${user}.${device ?? 0}`);
  assert.ok(remote, `no remote keys for ${jid}`);
  const plaintext = unpadRandomMax16(await remote.decrypt(ciphertext, type));
  return proto.Message.decode(plaintext);
};

describe('experimental pairwise group retry', () => {
  // TEST A — a normal group message keeps behaving exactly as before.
  it('A. normal group message still fans out to everyone and uses skmsg', async () => {
    const participants = [
      participant('5511900000110@s.whatsapp.net', [0], { lid: '100000000000110@lid', admin: 'admin' }),
      participant('5511900000111@s.whatsapp.net', [0], { lid: '100000000000111@lid' })
    ];
    const { sock, sent } = await setupSocket({ participants });
    const msg = generateWAMessageFromContent(GROUP, { conversation: 'normal' }, { userJid: ME, messageId: 'A-1' });
    await sock.relayMessage(GROUP, msg.message, { messageId: 'A-1' });
    const stanza = await readMessageStanza(sent);
    if (process.env.DUMP) console.log(binaryNodeToString(stanza));

    const targets = readRecipients(stanza).map(r => shortUser(r.jid)).sort();
    assert.deepEqual(targets, ['100000000000110', '100000000000111'], 'everyone is addressed');
    assert.equal(readSkmsg(stanza).type, 'skmsg', 'still a Sender Key message');
    assert.equal(readSkmsg(stanza).attrs['decrypt-fail'], undefined, 'no hiding on normal sends');
    await sock.ws.close().catch(() => {});
  });

  // TEST B — recipientMode keeps its existing semantics.
  it('B. recipientMode members-only is unchanged', async () => {
    const participants = [
      participant('5511900000120@s.whatsapp.net', [0], { lid: '100000000000120@lid', admin: 'admin' }),
      participant('5511900000121@s.whatsapp.net', [0], { lid: '100000000000121@lid' })
    ];
    const { sock, sent } = await setupSocket({ participants });
    const msg = generateWAMessageFromContent(GROUP, { conversation: 'members' }, { userJid: ME, messageId: 'B-1' });
    await sock.relayMessage(GROUP, msg.message, { messageId: 'B-1', recipientMode: 'members-only' });
    const stanza = await readMessageStanza(sent);
    const targets = readRecipients(stanza).map(r => shortUser(r.jid)).sort();
    assert.deepEqual(targets, ['100000000000121'], 'only the non-admin member');
    assert.equal(readSkmsg(stanza).attrs['decrypt-fail'], 'hide');
    await sock.ws.close().catch(() => {});
  });

  // TEST C — the stock retry resend path is untouched.
  it('C. normal retry resend still builds a pairwise msg without substitution', async () => {
    const participants = [
      participant('5511900000130@s.whatsapp.net', [0], { lid: '100000000000130@lid', admin: 'admin' }),
      participant('5511900000131@s.whatsapp.net', [0], { lid: '100000000000131@lid' })
    ];
    const { sock, sent, remotes } = await setupSocket({ participants });
    // Seed a Sender Key so the retry attaches an SKDM.
    await sock.relayMessage(GROUP, { conversation: 'seed' }, { messageId: 'C-SEED' });
    const msg = generateWAMessageFromContent(GROUP, { conversation: 'original' }, { userJid: ME, messageId: 'C-1' });
    await sock.relayMessage(GROUP, msg.message, {
      messageId: 'C-1',
      participant: { jid: '100000000000131@lid', count: 1 }
    });

    const stanza = await readMessageStanza(sent);
    if (process.env.DUMP) console.log(binaryNodeToString(stanza));
    assert.equal(stanza.attrs.participant, '100000000000131@lid', 'addressed to one device');
    const enc = readRetryEnc(stanza);
    assert.ok(enc, 'the retry carries a pairwise enc');
    assert.equal(enc.attrs.count, '1', 'retry count is carried');
    assert.ok(['msg', 'pkmsg'].includes(enc.type), 'pairwise type, not skmsg');

    const inner = await decryptPairwiseFor('100000000000131@lid', enc.ciphertext, enc.type, remotes);
    assert.equal(inner.conversation, 'original', 'the stock retry sends the original content');
    assert.ok(inner.senderKeyDistributionMessage, 'and still attaches the Sender Key distribution');
    await sock.ws.close().catch(() => {});
  });

  // TEST D — the new experimental entry point reaches the pairwise path.
  it('D. experimental API retransmits pairwise to the named participant', async () => {
    const participants = [
      participant('5511900000140@s.whatsapp.net', [0], { lid: '100000000000140@lid', admin: 'admin' }),
      participant('5511900000141@s.whatsapp.net', [0], { lid: '100000000000141@lid' })
    ];
    const { sock, sent, remotes } = await setupSocket({ participants });
    await sock.relayMessage(GROUP, { conversation: 'seed' }, { messageId: 'D-SEED' });

    const msg = generateWAMessageFromContent(GROUP, { conversation: 'grupo original' }, { userJid: ME, messageId: 'D-1' });
    const result = await sock.relayGroupMessagePairwiseExperimental(GROUP, msg.message, {
      participant: '100000000000141@lid',
      messageId: 'D-1',
      retryCount: 2
    });
    assert.equal(result.participant, '100000000000141@lid');

    const stanza = await readMessageStanza(sent);
    if (process.env.DUMP) console.log(binaryNodeToString(stanza));
    assert.equal(stanza.attrs.to, GROUP, 'the stanza is addressed to the group');
    assert.equal(stanza.attrs.participant, '100000000000141@lid', 'with the participant attribute');

    const enc = readRetryEnc(stanza);
    assert.ok(enc, 'a pairwise enc node exists');
    assert.ok(['msg', 'pkmsg'].includes(enc.type), 'encrypted with the pairwise session, not skmsg');
    assert.equal(enc.attrs.count, '2', 'the retry count reaches the stanza');
    assert.ok(enc.ciphertext?.length > 0, 'ciphertext present');

    const inner = await decryptPairwiseFor('100000000000141@lid', enc.ciphertext, enc.type, remotes);
    assert.equal(inner.conversation, 'grupo original', 'the target device decrypts the pairwise payload');
    assert.ok(inner.senderKeyDistributionMessage, 'the retry still carries the Sender Key distribution');
    await sock.ws.close().catch(() => {});
  });

  // TEST D2 — the per-recipient content substitution (the PoC's modifier).
  it('D2. experimentalPayload swaps the content for that one recipient only', async () => {
    const participants = [
      participant('5511900000150@s.whatsapp.net', [0], { lid: '100000000000150@lid', admin: 'admin' }),
      participant('5511900000151@s.whatsapp.net', [0], { lid: '100000000000151@lid' })
    ];
    const { sock, sent, remotes } = await setupSocket({ participants });
    await sock.relayMessage(GROUP, { conversation: 'seed' }, { messageId: 'D2-SEED' });

    const msg = generateWAMessageFromContent(GROUP, { conversation: 'conteudo do grupo' }, { userJid: ME, messageId: 'D2-1' });
    await sock.relayGroupMessagePairwiseExperimental(GROUP, msg.message, {
      participant: '100000000000151@lid',
      messageId: 'D2-1',
      experimentalPayload: { conversation: 'conteudo so para esse dispositivo' }
    });

    const enc = readRetryEnc(await readMessageStanza(sent));
    const inner = await decryptPairwiseFor('100000000000151@lid', enc.ciphertext, enc.type, remotes);
    assert.equal(inner.conversation, 'conteudo so para esse dispositivo', 'the substitute content was delivered');
    assert.notEqual(inner.conversation, 'conteudo do grupo', 'and it is not the original content');
    await sock.ws.close().catch(() => {});
  });

  // TEST E — with the flag absent, the experimental branch is never taken.
  it('E. without experimentalPairwiseRetry the relay behaves identically', async () => {
    const participants = [
      participant('5511900000160@s.whatsapp.net', [0], { lid: '100000000000160@lid', admin: 'admin' }),
      participant('5511900000161@s.whatsapp.net', [0], { lid: '100000000000161@lid' })
    ];
    const { sock, sent, remotes } = await setupSocket({ participants });
    await sock.relayMessage(GROUP, { conversation: 'seed' }, { messageId: 'E-SEED' });

    const msg = generateWAMessageFromContent(GROUP, { conversation: 'flagless' }, { userJid: ME, messageId: 'E-1' });
    // experimentalPayload supplied but the flag omitted: must be ignored.
    await sock.relayMessage(GROUP, msg.message, {
      messageId: 'E-1',
      participant: { jid: '100000000000161@lid', count: 1 },
      experimentalPayload: { conversation: 'NAO DEVERIA APARECER' }
    });

    const enc = readRetryEnc(await readMessageStanza(sent));
    const inner = await decryptPairwiseFor('100000000000161@lid', enc.ciphertext, enc.type, remotes);
    assert.equal(inner.conversation, 'flagless', 'without the flag the payload substitution is inert');
    await sock.ws.close().catch(() => {});
  });

  // TEST F — an invalid participant is a controlled error.
  it('F. invalid participant fails closed', async () => {
    const participants = [
      participant('5511900000170@s.whatsapp.net', [0], { lid: '100000000000170@lid' })
    ];
    const { sock } = await setupSocket({ participants });
    const msg = generateWAMessageFromContent(GROUP, { conversation: 'x' }, { userJid: ME, messageId: 'F-1' });

    await assert.rejects(
      sock.relayGroupMessagePairwiseExperimental(GROUP, msg.message, {
        participant: 'not-a-jid',
        messageId: 'F-1'
      }),
      /valid participant JID/
    );
    await assert.rejects(
      sock.relayGroupMessagePairwiseExperimental(GROUP, msg.message, { messageId: 'F-1' }),
      /valid participant JID/
    );
    await sock.ws.close().catch(() => {});
  });

  // TEST G — a non-group target is a controlled error.
  it('G. non-group target fails closed', async () => {
    const participants = [
      participant('5511900000180@s.whatsapp.net', [0], { lid: '100000000000180@lid' })
    ];
    const { sock } = await setupSocket({ participants });
    const msg = generateWAMessageFromContent(GROUP, { conversation: 'x' }, { userJid: ME, messageId: 'G-1' });

    await assert.rejects(
      sock.relayGroupMessagePairwiseExperimental('5511900000180@s.whatsapp.net', msg.message, {
        participant: '100000000000180@lid',
        messageId: 'G-1'
      }),
      /only accepts a group JID/
    );
    await sock.ws.close().catch(() => {});
  });
});