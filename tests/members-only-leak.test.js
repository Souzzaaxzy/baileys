/**
 * EXPERIMENT — does `recipientMode: 'members-only'` actually keep admins out?
 *
 * The members-only mechanism narrows the *distribution* of the Sender Key: the
 * devices of excluded participants are not enumerated, so they receive no
 * `<to>` node with a Sender Key Distribution Message. The question this test
 * answers is whether that is enough, given that:
 *
 *   - the stanza is still addressed to the GROUP, so the `<enc type="skmsg">`
 *     ciphertext reaches every member through the server, and
 *   - `GroupSessionBuilder.create()` REUSES an existing Sender Key (it only
 *     generates one when the record is empty), and
 *   - `GroupCipher.getSenderKey()` ratchets the SAME chain forward.
 *
 * So a participant who received the Sender Key from an earlier normal message
 * still holds it, and can attempt to decrypt a later members-only message.
 *
 * This test drives the real send path twice (a normal send, then a restricted
 * send) and then, for BOTH a plain member and an excluded admin, builds the
 * receiver-side group session from what that device actually received and tries
 * to decrypt the restricted ciphertext with its own copy of the Sender Key.
 *
 * Run: node tests/members-only-leak.test.js
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
    // Raw access so a test can prove/observe actual key rotations.
    _data: data,
    get: async (type, ids) => {
      const out = {};
      for (const id of ids) out[id] = data[`${type}:${id}`];
      return out;
    },
    /** Drop every entry of a type (used to simulate a Sender Key rotation). */
    _clearType: (type) => {
      for (const key of Object.keys(data)) {
        if (key.startsWith(`${type}:`)) delete data[key];
      }
    },
    _keysOfType: (type) => Object.keys(data).filter(k => k.startsWith(`${type}:`)).map(k => k.slice(type.length + 1)),
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

/** Every message stanza in the capture, in order. */
const readAllMessageStanzas = async (frames) => {
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

const decryptFor = async (recipient, remotes) => {
  const [user, device] = recipient.jid.split('@')[0].split(':');
  const remote = remotes.get(`${user}.${device ?? 0}`);
  assert.ok(remote, `no remote keys for ${recipient.jid}`);
  const plaintext = unpadRandomMax16(await remote.decrypt(recipient.ciphertext, recipient.type));
  return proto.Message.decode(plaintext);
};

/**
 * Structural metadata only — no keys, no plaintext, no credentials. This is the
 * "capture the stanza before sending" instrumentation from the experiment plan.
 */
const structuralMetadata = (stanza, { mode, messageId, label }) => {
  const recipients = readRecipients(stanza);
  const skmsg = readSkmsg(stanza);
  return {
    label,
    mode,
    messageId,
    to: stanza.attrs.to,
    participantAttr: stanza.attrs.participant,
    type: stanza.attrs.type,
    addressingMode: stanza.attrs.addressing_mode,
    encTypes: recipients.map(r => r.type),
    toNodeCount: recipients.length,
    toJids: recipients.map(r => shortUser(r.jid)).sort(),
    skmsgType: skmsg?.type ?? skmsg?.attrs?.type,
    skmsgDecryptFail: skmsg?.attrs?.['decrypt-fail'],
    skmsgCount: skmsg?.attrs?.count
  };
};

/**
 * Build the receiver-side group session for a device from the Sender Key
 * Distribution Message it actually received, then try to decrypt a ciphertext
 * with it — exactly what the receiving client does.
 *
 * Returns a `decrypt` that throws if the device cannot read the message.
 */
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
  if (!skdm?.axolotlSenderKeyDistributionMessage) {
    return {
      gotSkdm: false,
      decrypt: async () => {
        throw new Error('no sender key');
      }
    };
  }
  await builder.process(
    senderName,
    new SenderKeyDistributionMessage(null, null, null, null, skdm.axolotlSenderKeyDistributionMessage)
  );
  return {
    gotSkdm: true,
    keyId: record.getSenderKeyState()?.getKeyId?.(),
    decrypt: async (ciphertext) => {
      const plaintext = await new GroupCipher(store, senderName).decrypt(ciphertext);
      return proto.Message.decode(unpadRandomMax16(plaintext));
    }
  };
};

const ADMIN = participant('5511900000002@s.whatsapp.net', [0], { lid: '100000000000002@lid', admin: 'admin' });
const MEMBER = participant('5511900000003@s.whatsapp.net', [0], { lid: '100000000000003@lid' });

describe('members-only: does an already-keyed admin still read it?', () => {
  // PART 2 — trace the recipient list all the way to the Sender Key distribution.
  // Not just what `resolveGroupRecipients()` returns: which devices actually got
  // a `<to>` node carrying the Sender Key Distribution Message.
  it('traces the effective distribution list: MEMBER_A/B included, ADMIN_A/B not addressed', async () => {
    const ADMIN_A = participant('5511900000010@s.whatsapp.net', [0], { lid: '100000000000010@lid', admin: 'superadmin' });
    const ADMIN_B = participant('5511900000011@s.whatsapp.net', [0], { lid: '100000000000011@lid', admin: 'admin' });
    const MEMBER_A = participant('5511900000012@s.whatsapp.net', [0], { lid: '100000000000012@lid' });
    const MEMBER_B = participant('5511900000013@s.whatsapp.net', [0], { lid: '100000000000013@lid' });

    const { sock, sent, remotes } = await setupSocket({
      participants: [ADMIN_A, ADMIN_B, MEMBER_A, MEMBER_B]
    });

    const msg = generateWAMessageFromContent(GROUP, { conversation: 'somente membros' }, { userJid: ME, messageId: 'T-1' });
    await sock.relayMessage(GROUP, msg.message, { messageId: 'T-1', recipientMode: 'members-only' });

    const stanza = await readMessageStanza(sent);
    const meta = structuralMetadata(stanza, { mode: 'members-only', messageId: 'T-1', label: 'trace' });
    if (process.env.DUMP) console.log(JSON.stringify(meta, null, 2));

    const recipients = readRecipients(stanza);
    const jids = recipients.map(r => shortUser(r.jid)).sort();

    // The whole point of the mechanism: admins are not even addressed.
    assert.deepEqual(
      jids,
      ['100000000000012', '100000000000013'],
      'only MEMBER_A and MEMBER_B appear in the distribution list'
    );
    assert.equal(recipients.length, 2, 'exactly two devices are addressed');
    assert.ok(meta.encTypes.every(t => t === 'pkmsg'), 'those two nodes carry a pairwise SKDM');

    // ...but the list is empty precisely because everyone already had the key?
    // (that is what the next test measures). Here we confirm what each of the
    // four devices actually received on THIS send.
    const receivedSkdm = [];
    for (const r of recipients) {
      const inner = await decryptFor(r, remotes);
      receivedSkdm.push({ jid: shortUser(r.jid), gotSkdm: !!inner.senderKeyDistributionMessage });
    }
    assert.deepEqual(
      receivedSkdm.sort((a, b) => a.jid.localeCompare(b.jid)),
      [
        { jid: '100000000000012', gotSkdm: true },
        { jid: '100000000000013', gotSkdm: true }
      ],
      'only the two members received a Sender Key Distribution Message on this send'
    );

    // The skmsg is still addressed to the group, so the server can deliver it to
    // everyone — including the admins, who are not in the list above.
    assert.equal(meta.to, GROUP, 'the stanza targets the group, not a device');
    assert.equal(meta.participantAttr, undefined, 'and carries no retry participant attribute');
    assert.equal(meta.skmsgType, 'skmsg', 'the group ciphertext is present');
    assert.equal(meta.skmsgCount, undefined, 'no retry count on a normal send');

    await sock.ws.close().catch(() => {});
  });

  it('reuses the Sender Key across sends (no fresh key for the restricted send)', async () => {
    const { sock, sent } = await setupSocket({ participants: [ADMIN, MEMBER] });

    const first = generateWAMessageFromContent(GROUP, { conversation: 'mensagem normal' }, { userJid: ME, messageId: 'M-1' });
    await sock.relayMessage(GROUP, first.message, { messageId: 'M-1' });
    const second = generateWAMessageFromContent(GROUP, { conversation: 'so membros' }, { userJid: ME, messageId: 'M-2' });
    await sock.relayMessage(GROUP, second.message, { messageId: 'M-2', recipientMode: 'members-only' });

    const stanzas = await readAllMessageStanzas(sent);
    assert.equal(stanzas.length, 2, 'two message stanzas were sent');

    const meta1 = structuralMetadata(stanzas[0], { mode: 'all', messageId: 'M-1', label: 'normal' });
    const meta2 = structuralMetadata(stanzas[1], { mode: 'members-only', messageId: 'M-2', label: 'restricted' });
    if (process.env.DUMP) {
      console.log('--- stanza 1 (normal) ---');
      console.log(JSON.stringify(meta1, null, 2));
      console.log('--- stanza 2 (members-only) ---');
      console.log(JSON.stringify(meta2, null, 2));
      console.log('--- stanza 2 raw ---');
      console.log(binaryNodeToString(stanzas[1]));
    }

    // The normal send addresses every device and distributes the Sender Key.
    assert.deepEqual(meta1.toJids, ['100000000000002', '100000000000003']);
    assert.ok(meta1.encTypes.every(t => t === 'pkmsg'), 'SKDM delivered pairwise');

    // The restricted send addresses nobody: no <to> node at all, so no SKDM.
    // The ciphertext is still there, on the stanza addressed to the group.
    assert.equal(meta2.participantAttr, undefined, 'not a retry stanza');
    assert.equal(meta2.toJids.length, 0, 'no device is addressed in the restricted send');
    assert.equal(meta2.skmsgType, 'skmsg', 'the group ciphertext is still present');
    assert.ok(meta2.skmsgType, 'skmsg present');

    await sock.ws.close().catch(() => {});
  });

  it('an excluded admin decrypts the restricted message with the Sender Key it already holds', async () => {
    const { sock, sent, remotes } = await setupSocket({ participants: [ADMIN, MEMBER] });

    const first = generateWAMessageFromContent(GROUP, { conversation: 'mensagem normal' }, { userJid: ME, messageId: 'N-1' });
    await sock.relayMessage(GROUP, first.message, { messageId: 'N-1' });
    const firstStanza = await readMessageStanza(sent);

    // Both the admin and the member receive the Sender Key on the normal send.
    const adminRecipient = readRecipients(firstStanza).find(r => shortUser(r.jid) === shortUser(ADMIN.lid));
    const memberRecipient = readRecipients(firstStanza).find(r => shortUser(r.jid) === shortUser(MEMBER.lid));
    assert.ok(adminRecipient, 'the admin received a Sender Key Distribution Message');
    assert.ok(memberRecipient, 'the member received one too');

    const adminSession = await makeReceiverSession(adminRecipient, remotes);
    const memberSession = await makeReceiverSession(memberRecipient, remotes);
    assert.ok(adminSession.gotSkdm && memberSession.gotSkdm);

    // Now the restricted send. Neither device is addressed, so neither gets a
    // new distribution message — but the ciphertext goes to the group.
    const before = sent.length;
    const second = generateWAMessageFromContent(GROUP, { conversation: 'SEGREDO so membros' }, { userJid: ME, messageId: 'N-2' });
    await sock.relayMessage(GROUP, second.message, { messageId: 'N-2', recipientMode: 'members-only' });
    const restrictedStanza = await readMessageStanza(sent.slice(before));
    const skmsg = readSkmsg(restrictedStanza);
    assert.ok(skmsg, 'the restricted stanza carries the group ciphertext');

    // The member (intended recipient) reads it.
    const memberPlain = await memberSession.decrypt(skmsg.ciphertext);
    assert.equal(memberPlain.conversation, 'SEGREDO so membros', 'the member reads the restricted message');

    // The question: does the EXCLUDED admin also read it?
    let adminPlain = null;
    let adminError = null;
    try {
      adminPlain = await adminSession.decrypt(skmsg.ciphertext);
    } catch (err) {
      adminError = err;
    }

    console.log('\n=== members-only confidentiality probe ===');
    console.log('admin got SKDM on the normal send :', adminSession.gotSkdm);
    console.log('admin addressed in restricted send:', readRecipients(restrictedStanza).length > 0);
    console.log('admin decrypt of restricted msg   :', adminPlain ? adminPlain.conversation : `FAILED (${adminError?.message})`);
    console.log('admin sender key id               :', adminSession.keyId);
    console.log('member sender key id              :', memberSession.keyId);

    assert.equal(
      adminPlain?.conversation,
      'SEGREDO so membros',
      'FINDING: the excluded admin decrypts the restricted message with its existing Sender Key'
    );

    await sock.ws.close().catch(() => {});
  });

  // PART 4 — the restricted send must not go through any retry path.
  it('uses no retry mechanism: no participant attr, no count, no sendMessagesAgain', async () => {
    const { sock, sent } = await setupSocket({ participants: [ADMIN, MEMBER] });

    // Instrument the retry entry points to prove they are never called.
    let sendMessagesAgainCalls = 0;
    const originalSendRetryRequest = sock.sendRetryRequest;
    if (typeof originalSendRetryRequest === 'function') {
      sock.sendRetryRequest = async (...args) => {
        sendMessagesAgainCalls += 1;
        return originalSendRetryRequest.apply(sock, args);
      };
    }

    const msg = generateWAMessageFromContent(GROUP, { conversation: 'sem retry' }, { userJid: ME, messageId: 'R-1' });
    await sock.relayMessage(GROUP, msg.message, { messageId: 'R-1', recipientMode: 'members-only' });

    const stanza = await readMessageStanza(sent);

    // A retry resend would set `participant` and an `<enc count=…>`.
    assert.equal(stanza.attrs.participant, undefined, 'no participant attribute (not a retry resend)');
    assert.equal(stanza.attrs.recipient, undefined, 'no recipient attribute');
    assert.equal(readSkmsg(stanza).attrs.count, undefined, 'no retry count on the ciphertext');

    // The retry request sender was never invoked.
    assert.equal(sendMessagesAgainCalls, 0, 'sendRetryRequest was never called');

    // And the message is still a normal group send: the skmsg is the only enc.
    const encNodes = (stanza.content ?? []).filter(n => n.tag === 'enc');
    assert.equal(encNodes.length, 1, 'exactly one enc node — the group skmsg');
    assert.equal(encNodes[0].attrs.type, 'skmsg');
    assert.equal(encNodes[0].attrs.v, '2');

    await sock.ws.close().catch(() => {});
  });

  it('an admin who never received the Sender Key cannot decrypt', async () => {
    // Here the FIRST send is already restricted, so the admin never gets a key.
    const { sock, sent, remotes } = await setupSocket({ participants: [ADMIN, MEMBER] });

    const only = generateWAMessageFromContent(GROUP, { conversation: 'primeira e so membros' }, { userJid: ME, messageId: 'O-1' });
    await sock.relayMessage(GROUP, only.message, { messageId: 'O-1', recipientMode: 'members-only' });

    const stanza = await readMessageStanza(sent);
    const memberRecipient = readRecipients(stanza).find(r => shortUser(r.jid) === shortUser(MEMBER.lid));
    assert.ok(memberRecipient, 'the member is addressed and gets the Sender Key');

    const memberSession = await makeReceiverSession(memberRecipient, remotes);
    const skmsg = readSkmsg(stanza);
    const memberPlain = await memberSession.decrypt(skmsg.ciphertext);
    assert.equal(memberPlain.conversation, 'primeira e so membros');

    // The admin has key material but was never given the Sender Key.
    assert.ok(remotes.has(`${shortUser(ADMIN.lid)}.0`), 'the admin has pairwise key material');
    const adminRecord = new SenderKeyRecord();
    const adminStore = {
      loadSenderKey: async () => adminRecord,
      storeSenderKey: async () => {}
    };
    const senderName = new SenderKeyName(GROUP, new ProtocolAddress(shortUser(ME_LID), 0));
    await assert.rejects(
      new GroupCipher(adminStore, senderName).decrypt(skmsg.ciphertext),
      'the admin cannot decrypt without ever having received the Sender Key'
    );

    await sock.ws.close().catch(() => {});
  });

  // ROOT-CAUSE ISOLATION — the leak is key REUSE, not a flaw in the recipient
  // filter. This is the experiment that identifies the next technical step:
  // if the Sender Key is rotated before the restricted send, the old key is
  // useless for the new ciphertext.
  it('rotating the Sender Key before the restricted send removes the admin\'s ability to read it', async () => {
    const { sock, sent, remotes, rawKeys } = await setupSocket({ participants: [ADMIN, MEMBER] });

    // 1) A normal send: both devices get the Sender Key (chain starts here).
    const first = generateWAMessageFromContent(GROUP, { conversation: 'normal' }, { userJid: ME, messageId: 'K-1' });
    await sock.relayMessage(GROUP, first.message, { messageId: 'K-1' });
    const firstStanza = await readMessageStanza(sent);
    const adminRecipient = readRecipients(firstStanza).find(r => shortUser(r.jid) === shortUser(ADMIN.lid));
    const adminSession = await makeReceiverSession(adminRecipient, remotes);

    // 2) Simulate a Sender Key rotation for the group. Clearing the sender key
    //    alone is NOT enough: `sender-key-memory` still records that each device
    //    already has a key, so nobody would be sent the new distribution message
    //    (the first version of this test proved exactly that). A real rotation
    //    must clear the memory too, so the subset receives the new key.
    //
    //    The clear goes through the socket's own key store (which is what the
    //    send path reads); clearing only the raw backing store would be defeated
    //    by the store's cache layer. The names are taken from the store itself
    //    rather than guessed, so this really targets the live entries.
    const liveSenderKeys = rawKeys._keysOfType('sender-key');
    assert.ok(liveSenderKeys.length > 0, 'a sender key exists after the normal send');
    const rotatePatch = { 'sender-key': {}, 'sender-key-memory': { [GROUP]: null } };
    for (const name of liveSenderKeys) rotatePatch['sender-key'][name] = null;
    await sock.authState.keys.set(rotatePatch);
    // The socket's store is cached separately from the raw store; clear the raw
    // copy as well so both layers agree.
    rawKeys._clearType('sender-key');
    rawKeys._clearType('sender-key-memory');

    // 3) The restricted send now uses the NEW key.
    const before = sent.length;
    const second = generateWAMessageFromContent(GROUP, { conversation: 'AGORA so membros' }, { userJid: ME, messageId: 'K-2' });
    await sock.relayMessage(GROUP, second.message, { messageId: 'K-2', recipientMode: 'members-only' });
    const restrictedStanza = await readMessageStanza(sent.slice(before));
    const skmsg = readSkmsg(restrictedStanza);

    // The member receives the new Sender Key and reads it.
    const memberRecipient = readRecipients(restrictedStanza).find(r => shortUser(r.jid) === shortUser(MEMBER.lid));
    assert.ok(memberRecipient, 'the member still gets the (new) Sender Key on the restricted send');
    const memberSession = await makeReceiverSession(memberRecipient, remotes);
    const memberPlain = await memberSession.decrypt(skmsg.ciphertext);
    assert.equal(memberPlain.conversation, 'AGORA so membros');

    // The admin still holds the OLD key — and it no longer matches.
    let adminPlain = null;
    let adminError = null;
    try {
      adminPlain = await adminSession.decrypt(skmsg.ciphertext);
    } catch (err) {
      adminError = err;
    }
    console.log('\n=== root-cause probe: Sender Key rotation ===');
    console.log('sender-key entries before rotation:', liveSenderKeys);
    console.log('admin key id (old)      :', adminSession.keyId);
    console.log('member key id (new)     :', memberSession.keyId);
    console.log('admin decrypt after rotation:', adminPlain ? `LEAKED (${adminPlain.conversation})` : `BLOCKED (${adminError?.message})`);

    assert.equal(adminPlain, null, 'with a rotated Sender Key the admin cannot decrypt');
    assert.notEqual(adminError, null, 'the admin decryption throws');
    assert.notEqual(adminSession.keyId, memberSession.keyId, 'the restricted send used a different Sender Key id');

    await sock.ws.close().catch(() => {});
  });
});