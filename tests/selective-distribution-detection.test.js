/**
 * EXPERIMENT — detecting a selective-distribution group message on receive.
 *
 * This is the anti side of the mechanism: a group message delivered to every
 * participant while only some can decrypt it. The signature is in the transport,
 * not the content, so it also catches other implementations of the same idea:
 *
 *   <enc type="skmsg">  +  decryption failed with "no session to decrypt"  +  decrypt-fail="hide"
 *
 * The test drives the real receive path (`decryptMessageNode`) with the real
 * signal repository: it builds a group message encrypted with a Sender Key the
 * receiving device never got, marks it `decrypt-fail="hide"`, and checks that the
 * failure is reported. It also checks the negatives — a normal readable group
 * message, and an undecryptable one WITHOUT the attribute (which is a late join
 * or key loss, not intent) must not be flagged.
 *
 * Run: node tests/selective-distribution-detection.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { proto } from '../WAProto/index.js';
import { decryptMessageNode } from '../lib/Utils/decode-wa-message.js';
import { writeRandomPadMax16 } from '../lib/Utils/generics.js';
import {
  GroupSessionBuilder,
  GroupCipher,
  SenderKeyName,
  SenderKeyRecord,
  SenderKeyState,
  SenderKeyDistributionMessage
} from '../lib/Signal/Group/index.js';
import * as keyhelper from '../lib/Signal/Group/keyhelper.js';
import {
  isSelectiveDistributionFailure,
  hasDecryptFailHide,
  buildSelectiveDistributionReport,
  DECRYPT_FAIL_HIDE
} from '../lib/Utils/selective-distribution-detector.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOGLEVEL ?? 'silent' });
const GROUP = '120363000000000001@g.us';
const ME = '5511900000001@s.whatsapp.net';
const ME_LID = '100000000000001@lid';
const AUTHOR_LID = '100000000000050@lid';

const senderKeyName = new SenderKeyName(GROUP, { toString: () => '100000000000050_1' });

/** A record-backed store, like the fork's signal storage. */
const makeStore = (seedRecord) => {
  const record = seedRecord ?? new SenderKeyRecord();
  return {
    record,
    loadSenderKey: async () => record,
    storeSenderKey: async (_name, key) => {
      record.senderKeyStates = key.senderKeyStates;
    }
  };
};

/**
 * Build a group `skmsg` stanza encrypted with a Sender Key the receiver does not
 * have, optionally carrying `decrypt-fail="hide"`.
 */
const buildSkmsgStanza = async ({ withDecryptFail, messageText }) => {
  // Sender side: a brand-new key the receiver will never be given.
  const senderStore = makeStore();
  await new GroupSessionBuilder(senderStore).create(senderKeyName);
  const ciphertext = await new GroupCipher(senderStore, senderKeyName).encrypt(
    writeRandomPadMax16(proto.Message.encode({ conversation: messageText }).finish())
  );

  const encAttrs = { v: '2', type: 'skmsg' };
  if (withDecryptFail) {
    encAttrs['decrypt-fail'] = DECRYPT_FAIL_HIDE;
  }

  return {
    tag: 'message',
    attrs: {
      id: 'MSG-DETECT-1',
      from: GROUP,
      participant: AUTHOR_LID,
      t: String(Math.floor(Date.now() / 1000)),
      type: 'text'
    },
    content: [{ tag: 'enc', attrs: encAttrs, content: ciphertext }]
  };
};

/** A repository where the receiving device has NO sender key (the technique's effect). */
const makeEmptyRepository = () => ({
  decryptGroupMessage: async () => {
    throw new Error('No session found to decrypt message');
  },
  decryptMessage: async () => {
    throw new Error('No session found to decrypt message');
  },
  processSenderKeyDistributionMessage: async () => {},
  lidMapping: {
    getPNForLID: async () => null,
    getLIDForPN: async () => null,
    storeLIDPNMappings: async () => {}
  },
  migrateSession: async () => {},
  jidToSignalProtocolAddress: (jid) => jid
});

/** A repository that CAN decrypt, for the negative case. */
const makeWorkingRepository = (plaintext) => ({
  decryptGroupMessage: async () => plaintext,
  decryptMessage: async () => plaintext,
  processSenderKeyDistributionMessage: async () => {},
  lidMapping: {
    getPNForLID: async () => null,
    getLIDForPN: async () => null,
    storeLIDPNMappings: async () => {}
  },
  migrateSession: async () => {},
  jidToSignalProtocolAddress: (jid) => jid
});

describe('selective-distribution detection', () => {
  it('flags an undecryptable group message that carries decrypt-fail="hide"', async () => {
    const stanza = await buildSkmsgStanza({ withDecryptFail: true, messageText: 'invisivel' });
    const node = decryptMessageNode(stanza, ME, ME_LID, makeEmptyRepository(), logger);
    await node.decrypt();

    const report = node.fullMessage.selectiveDistribution;
    console.log('\n=== detection report ===');
    console.log(JSON.stringify(report, null, 2));

    assert.ok(report, 'the selective distribution was reported');
    assert.equal(report.kind, 'selective-distribution');
    assert.equal(report.messageId, 'MSG-DETECT-1');
    assert.equal(report.groupJid, GROUP);
    assert.equal(report.author, AUTHOR_LID);
    assert.equal(report.encType, 'skmsg');
    assert.equal(report.decryptFail, 'hide');
    assert.match(report.reason, /no session/i, 'records why it failed');

    // It is still an undecryptable message as far as the rest of the stack cares.
    assert.equal(
      node.fullMessage.messageStubType,
      proto.WebMessageInfo.StubType.CIPHERTEXT,
      'the message is still marked as undecryptable'
    );
  });

  it('does NOT flag an undecryptable message without decrypt-fail="hide" (late join, key loss)', async () => {
    const stanza = await buildSkmsgStanza({ withDecryptFail: false, messageText: 'perdida' });
    const node = decryptMessageNode(stanza, ME, ME_LID, makeEmptyRepository(), logger);
    await node.decrypt();

    assert.equal(
      node.fullMessage.selectiveDistribution,
      undefined,
      'no attribute → no intent → not flagged'
    );
    // It is still undecryptable, just not attributed to deliberate restriction.
    assert.equal(node.fullMessage.messageStubType, proto.WebMessageInfo.StubType.CIPHERTEXT);
  });

  it('does NOT flag a readable group message', async () => {
    const plaintext = writeRandomPadMax16(proto.Message.encode({ conversation: 'normal' }).finish());
    const stanza = await buildSkmsgStanza({ withDecryptFail: true, messageText: 'normal' });
    const node = decryptMessageNode(stanza, ME, ME_LID, makeWorkingRepository(plaintext), logger);
    await node.decrypt();

    assert.equal(node.fullMessage.selectiveDistribution, undefined, 'a message that decrypts is never flagged');
    assert.equal(node.fullMessage.message?.conversation, 'normal', 'and it is readable');
  });

  it('the predicate requires all three signals together', () => {
    const base = { encType: 'skmsg', encAttrs: { 'decrypt-fail': 'hide' }, error: new Error('No session found to decrypt message') };

    assert.equal(isSelectiveDistributionFailure(base), true, 'skmsg + hide + no-session → flagged');
    assert.equal(
      isSelectiveDistributionFailure({ ...base, encType: 'msg' }),
      false,
      'a pairwise message is not group selective distribution'
    );
    assert.equal(
      isSelectiveDistributionFailure({ ...base, encAttrs: {} }),
      false,
      'without decrypt-fail there is no intent signal'
    );
    assert.equal(
      isSelectiveDistributionFailure({ ...base, error: new Error('Invalid signature!') }),
      false,
      'a different failure is not this technique'
    );
    assert.equal(
      isSelectiveDistributionFailure({ ...base, encAttrs: { 'decrypt-fail': 'show' } }),
      false,
      'only the "hide" value counts'
    );
    assert.equal(hasDecryptFailHide({ 'decrypt-fail': 'hide' }), true);
    assert.equal(hasDecryptFailHide({}), false);
    assert.equal(hasDecryptFailHide(undefined), false);
  });

  it('the report carries structure only — no keys, no plaintext', async () => {
    const stanza = await buildSkmsgStanza({ withDecryptFail: true, messageText: 'SEGREDO' });
    const report = buildSelectiveDistributionReport({ stanza, error: new Error('No session found to decrypt message') });
    const serialized = JSON.stringify(report);

    assert.ok(!serialized.includes('SEGREDO'), 'no plaintext in the report');
    assert.ok(!/chainKey|signingKey|privateKey|privKey|rootKey|seed/i.test(serialized), 'no key material in the report');
    assert.equal(report.addressedDeviceCount, 0, 'counts the addressed devices when present');
  });
});