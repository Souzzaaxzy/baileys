/**
 * EXPERIMENT — Sender Key rotation, isolated cryptographic proof.
 *
 * Hypothesis: if a message is encrypted with a NEW Sender Key state B, and only
 * the authorised members receive B, then a device that holds only the older
 * state A cannot decrypt it.
 *
 * This file proves or disproves that using the fork's REAL Group implementation
 * (lib/Signal/Group/*) and libsignal's curve primitives — no invented crypto.
 * It answers, concretely:
 *
 *   - Can one SenderKeyRecord hold A and B at the same time?
 *   - Do they have different senderKeyIds, chain keys and signing keys?
 *   - Which state does GroupCipher.encrypt() pick?
 *   - Does a device holding only A fail to decrypt a B ciphertext?
 *   - Does a device holding A and B decrypt B, and continue across two messages?
 *
 * What this CANNOT prove: whether the WhatsApp server accepts a message whose
 * Sender Key only some group members received, and how real clients render it.
 * That needs a real device, and nothing here claims it.
 *
 * Run: node tests/sender-key-rotation.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { proto } from '../WAProto/index.js';
import { unpadRandomMax16, writeRandomPadMax16 } from '../lib/Utils/generics.js';
import {
  GroupSessionBuilder,
  GroupCipher,
  SenderKeyName,
  SenderKeyRecord,
  SenderKeyState,
  SenderKeyDistributionMessage
} from '../lib/Signal/Group/index.js';
import * as keyhelper from '../lib/Signal/Group/keyhelper.js';

const GROUP = '120363000000000001@g.us';
const ALICE = '100000000000001_1'; // the sender's signal address

const senderName = new SenderKeyName(GROUP, { toString: () => ALICE });

/**
 * A store backed by a real SenderKeyRecord, mirroring what
 * `signalStorage.storeSenderKey`/`loadSenderKey` do in the fork.
 */
const makeStore = () => {
  const record = new SenderKeyRecord();
  return {
    record,
    loadSenderKey: async () => record,
    storeSenderKey: async (_name, key) => {
      record.senderKeyStates = key.senderKeyStates;
    }
  };
};

/** Encrypt exactly like the fork's GroupCipher path does. */
const encryptWith = async (store, data) => {
  const cipher = new GroupCipher(store, senderName);
  // The fork pads group plaintext before encrypting (`encodeWAMessage` uses
  // `writeRandomPadMax16`), so the receiver can unpad. Mirror that here.
  return cipher.encrypt(writeRandomPadMax16(Buffer.from(data)));
};

/** The receiving end: process an SKDM, then decrypt. */
const makeReceiver = () => {
  const store = makeStore();
  const builder = new GroupSessionBuilder(store);
  return {
    store,
    processSkdm: (skdmBytes) =>
      builder.process(senderName, new SenderKeyDistributionMessage(null, null, null, null, skdmBytes)),
    decrypt: async (ciphertext) => {
      const plaintext = await new GroupCipher(store, senderName).decrypt(ciphertext);
      // `unpadRandomMax16` returns a Uint8Array; normalise to a Buffer.
      return Buffer.from(unpadRandomMax16(plaintext));
    }
  };
};

describe('Sender Key rotation — isolated cryptographic proof', () => {
  it('STATE A/B: a record holds both, with distinct id, chain key and signing key', async () => {
    const store = makeStore();
    const builder = new GroupSessionBuilder(store);

    // STATE A — the normal `GroupSessionBuilder.create()` path.
    const skdmA = await builder.create(senderName);
    const stateA = store.record.getSenderKeyState();
    const idA = stateA.getKeyId();
    const chainA = Buffer.from(stateA.getSenderChainKey().getSeed());
    const signA = Buffer.from(stateA.getSigningKeyPublic());

    // A second create() must REUSE A (this is the reuse that caused the leak).
    const skdmA2 = await builder.create(senderName);
    assert.equal(skdmA2.getId(), idA, 'create() reuses the existing state');
    assert.equal(store.record.senderKeyStates.length, 1, 'still a single state');

    // STATE B — a genuine new state, appended without destroying A. Constructed
    // from the library's own SenderKeyState with the library's own key helpers,
    // so this is the real cryptographic structure, not a stand-in.
    const idB = keyhelper.generateSenderKeyId();
    const chainB = keyhelper.generateSenderKey();
    const signingB = keyhelper.generateSenderSigningKey();
    store.record.senderKeyStates.push(new SenderKeyState(idB, 0, chainB, signingB));

    const stateB = store.record.getSenderKeyState();
    assert.equal(stateB.getKeyId(), idB, 'getSenderKeyState() returns the newest state');
    assert.equal(store.record.senderKeyStates.length, 2, 'A and B coexist');
    assert.notEqual(idA, idB, 'B has a different senderKeyId than A');
    assert.notEqual(chainA.toString('hex'), chainB.toString('hex'), 'different chain keys');
    assert.notEqual(signA.toString('hex'), Buffer.from(stateB.getSigningKeyPublic()).toString('hex'), 'different signing keys');

    // The state is addressable by id — the receiving side depends on this.
    assert.ok(store.record.getSenderKeyState(idA), 'A is still retrievable by id');
    assert.ok(store.record.getSenderKeyState(idB), 'B is retrievable by id');

    console.log('\n=== sender key states ===');
    console.log('A id:', idA, '| B id:', idB, '| distinct:', idA !== idB);
    console.log('A chain == B chain:', chainA.equals(chainB));
    console.log('record holds states:', store.record.senderKeyStates.length);
  });

  it('encrypt uses the NEWEST state (B) and the ciphertext carries B\'s senderKeyId', async () => {
    const store = makeStore();
    await new GroupSessionBuilder(store).create(senderName);
    const idA = store.record.getSenderKeyState().getKeyId();

    const idB = keyhelper.generateSenderKeyId();
    store.record.senderKeyStates.push(
      new SenderKeyState(idB, 0, keyhelper.generateSenderKey(), keyhelper.generateSenderSigningKey())
    );

    const ciphertext = await encryptWith(store, 'TEST_SENDER_KEY_B');

    // The SenderKeyMessage on the wire carries the key id — decode it for real.
    const message = proto.SenderKeyMessage.decode(ciphertext.slice(1, ciphertext.length - 64));
    console.log('ciphertext senderKeyId:', message.id, '(A =', idA, ')');
    assert.equal(message.id, idB, 'the message is bound to B');
    assert.notEqual(message.id, idA, 'and not to A');
  });

  it('MANDATORY: a device holding only A cannot decrypt a B ciphertext; holders of B can', async () => {
    // The sender rotates to B.
    const senderStore = makeStore();
    const builder = new GroupSessionBuilder(senderStore);

    // Everyone gets A first (the normal group history).
    const skdmA = await builder.create(senderName);
    const idA = senderStore.record.getSenderKeyState().getKeyId();

    // Admins keep only A.
    const admin = makeReceiver();
    await admin.processSkdm(skdmA.serialize());

    // Rotate: append B and distribute it ONLY to the members.
    const idB = keyhelper.generateSenderKeyId();
    const chainB = keyhelper.generateSenderKey();
    const signingB = keyhelper.generateSenderSigningKey();
    senderStore.record.senderKeyStates.push(new SenderKeyState(idB, 0, chainB, signingB));
    const skdmB = new SenderKeyDistributionMessage(idB, 0, chainB, signingB.public).serialize();

    const memberA = makeReceiver();
    const memberB = makeReceiver();
    await memberA.processSkdm(skdmB);
    await memberB.processSkdm(skdmB);

    // Encrypt with B (the newest state).
    const ciphertext = await encryptWith(senderStore, 'TEST_SENDER_KEY_B');

    // Members decrypt.
    assert.equal((await memberA.decrypt(ciphertext)).toString(), 'TEST_SENDER_KEY_B', 'MEMBER_A decrypts');
    assert.equal((await memberB.decrypt(ciphertext)).toString(), 'TEST_SENDER_KEY_B', 'MEMBER_B decrypts');

    // The admin cannot: it has no state for B's id.
    await assert.rejects(
      admin.decrypt(ciphertext),
      /No session found to decrypt message/,
      'ADMIN (holding only A) cannot decrypt the B message'
    );

    console.log('\n=== selective distribution (B to members only) ===');
    console.log('A id:', idA, '| B id:', idB);
    console.log('MEMBER_A: decrypted | MEMBER_B: decrypted | ADMIN: failed as expected');
  });

  it('independent states: a message encrypted with A fails on a B-only device and vice versa', async () => {
    const senderStore = makeStore();
    const builder = new GroupSessionBuilder(senderStore);
    const skdmA = await builder.create(senderName);

    const idB = keyhelper.generateSenderKeyId();
    const chainB = keyhelper.generateSenderKey();
    const signingB = keyhelper.generateSenderSigningKey();
    senderStore.record.senderKeyStates.push(new SenderKeyState(idB, 0, chainB, signingB));
    const skdmB = new SenderKeyDistributionMessage(idB, 0, chainB, signingB.public).serialize();

    const aOnly = makeReceiver();
    await aOnly.processSkdm(skdmA.serialize());
    const bOnly = makeReceiver();
    await bOnly.processSkdm(skdmB);

    // Encrypt with A explicitly, by selecting A's state as the newest.
    const aStore = makeStore();
    aStore.record.senderKeyStates = [senderStore.record.getSenderKeyState(senderStore.record.getSenderKeyState().getKeyId())];
    // Simpler: temporarily put A last so encrypt() picks it.
    const bState = senderStore.record.senderKeyStates.pop();
    const ciphertextA = await encryptWith(senderStore, 'MSG_WITH_A');
    senderStore.record.senderKeyStates.push(bState);

    // A-holders read it, B-only holders do not.
    assert.equal((await aOnly.decrypt(ciphertextA)).toString(), 'MSG_WITH_A', 'A-holder decrypts the A message');
    await assert.rejects(
      bOnly.decrypt(ciphertextA),
      /No session found to decrypt message/,
      'B-only device cannot decrypt an A-encrypted message'
    );

    console.log('\n=== state independence ===');
    console.log('A message: A-holder OK, B-only FAILED as expected');
  });

  it('reuse of B across two messages: same id, chain advances, members read both, admins neither', async () => {
    const senderStore = makeStore();
    const builder = new GroupSessionBuilder(senderStore);
    const skdmA = await builder.create(senderName);

    const admin = makeReceiver();
    await admin.processSkdm(skdmA.serialize());

    const idB = keyhelper.generateSenderKeyId();
    const chainB = keyhelper.generateSenderKey();
    const signingB = keyhelper.generateSenderSigningKey();
    senderStore.record.senderKeyStates.push(new SenderKeyState(idB, 0, chainB, signingB));
    const skdmB = new SenderKeyDistributionMessage(idB, 0, chainB, signingB.public).serialize();

    const member = makeReceiver();
    await member.processSkdm(skdmB);

    const c1 = await encryptWith(senderStore, 'MSG_B_1');
    const c2 = await encryptWith(senderStore, 'MSG_B_2');

    const ids = [c1, c2].map(c => proto.SenderKeyMessage.decode(c.slice(1, c.length - 64)).id);
    const iterations = [c1, c2].map(c => proto.SenderKeyMessage.decode(c.slice(1, c.length - 64)).iteration);
    assert.equal(ids[0], idB, 'first B message uses B');
    assert.equal(ids[1], idB, 'second B message uses the same B');
    assert.ok(iterations[1] > iterations[0], `the chain advanced (${iterations[0]} -> ${iterations[1]})`);

    assert.equal((await member.decrypt(c1)).toString(), 'MSG_B_1', 'member reads message 1');
    assert.equal((await member.decrypt(c2)).toString(), 'MSG_B_2', 'member reads message 2');
    await assert.rejects(admin.decrypt(c1), /No session found to decrypt message/);
    await assert.rejects(admin.decrypt(c2), /No session found to decrypt message/);

    console.log('\n=== B reuse across two messages ===');
    console.log('ids:', ids, '| iterations:', iterations, '| member 2/2, admin 0/2');
  });
});