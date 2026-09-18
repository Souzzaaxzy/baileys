/**
 * Real pairwise Signal sessions for tests.
 *
 * A test that only checks "the stanza has a `<to>` node for this device" proves
 * nothing about what the device can read. This helper gives the test the remote
 * device's private keys, so the test can build a genuine receiving session and
 * actually decrypt what the socket addressed to that device — the same
 * `SessionCipher` path a real client runs.
 *
 * The remote's public bundle is injected into the socket through the real
 * `signalRepository.injectE2ESession`, so the sending side is real too.
 */

import { createRequire } from 'node:module';
import { generateSignalPubKey } from '../../lib/Utils/crypto.js';

// libsignal is a CommonJS package, the same way the fork consumes it.
const require = createRequire(import.meta.url);
const { SessionCipher, ProtocolAddress } = require('libsignal');
const keyhelper = require('libsignal/src/keyhelper.js');

/**
 * A fictional remote device: key material, the public bundle to inject into the
 * socket, and a `decrypt` that uses its own private keys.
 *
 * @param {string} user   the user part of the JID, as the signal address uses it
 * @param {number} device the device id
 */
export const makeRemoteDevice = (user, device) => {
  const identityKeyPair = keyhelper.generateIdentityKeyPair();
  const signedPreKey = keyhelper.generateSignedPreKey(identityKeyPair, 1);
  const preKey = keyhelper.generatePreKey(2);
  const registrationId = keyhelper.generateRegistrationId();

  let record = null;
  const store = {
    loadSession: async () => record,
    storeSession: async (_addr, session) => {
      record = session;
    },
    isTrustedIdentity: () => true,
    loadIdentityKey: async () => identityKeyPair.pubKey,
    saveIdentity: async () => false,
    // The ids match the bundle below (preKey 2, signedPreKey 1).
    loadPreKey: async (id) => (id === 2 ? preKey.keyPair : undefined),
    loadSignedPreKey: () => signedPreKey.keyPair,
    getOurRegistrationId: () => registrationId,
    getOurIdentity: () => ({ privKey: identityKeyPair.privKey, pubKey: identityKeyPair.pubKey }),
    removePreKey: async () => {}
  };

  const address = new ProtocolAddress(user, device);

  return {
    bundle: {
      registrationId,
      identityKey: generateSignalPubKey(identityKeyPair.pubKey),
      signedPreKey: {
        keyId: signedPreKey.keyId,
        publicKey: generateSignalPubKey(signedPreKey.keyPair.pubKey),
        signature: signedPreKey.signature
      },
      preKey: {
        keyId: preKey.keyId,
        publicKey: generateSignalPubKey(preKey.keyPair.pubKey)
      }
    },
    /** Decrypt an `<enc>` payload exactly like the receiving client does. */
    decrypt: async (ciphertext, type) => {
      const cipher = new SessionCipher(store, address);
      const plaintext = type === 'pkmsg'
        ? await cipher.decryptPreKeyWhisperMessage(ciphertext)
        : await cipher.decryptWhisperMessage(ciphertext);
      return Buffer.from(plaintext);
    }
  };
};