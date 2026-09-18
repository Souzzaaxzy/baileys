/**
 * EXPERIMENTAL — pairwise group message retransmission (research only).
 *
 * This module exists to study the "retransmit a group message pairwise" flow
 * described in the WhatsApp transcript-consistency PoC (sbaresearch/
 * transcript-consistency, code/whatsapp/poc-client). It is **not** part of the
 * normal send path and it changes nothing unless a caller explicitly opts in
 * with `experimentalPairwiseRetry` **and** names a single `participant`.
 *
 * Background — what the PoC does (and what it does not do):
 *
 *   The PoC's `ByteFlip` mode corrupts the Sender Key ciphertext of a group
 *   message before sending it. Existing session holders fail to decrypt, which
 *   makes their clients emit a retry receipt. The sender's retry-response
 *   handler (`whatsmeow.handleRetryReceipt`) then re-encrypts the message
 *   **pairwise** for the requesting device — `<enc type="msg" count="N">` on a
 *   `<message>` stanza addressed to the group but attributed with
 *   `participant="<device>"` — optionally substituting different content for
 *   that one recipient (`PlaintextModifierCallback`).
 *
 *   That retry-response path is what this module exposes. It is **equivalent
 *   to Baileys' own `sendMessagesAgain` → `relayMessage({ participant })`
 *   branch**, which already builds the pairwise `enc` with
 *   `signalRepository.encryptMessage`, sets `count` and addresses the stanza to
 *   the single device. The only capability the PoC has that Baileys did not
 *   expose is the per-recipient content substitution, which is added here
 *   behind the experimental flag.
 *
 * What this is NOT:
 *   - It is not a second retry system. It reuses `relayMessage`.
 *   - It is not a second Sender Key architecture. The SKDM attached to the
 *     retry still comes from `signalRepository.getSenderKeyDistributionMessage`.
 *   - It is not the "invisible message" behaviour. It does not touch
 *     `recipientMode` and does not restrict normal fan-out.
 */

import { Boom } from '@hapi/boom';

import { jidDecode } from '../WABinary/index.js';

/**
 * Name of the option that turns the pairwise retry on. Present and `true` is
 * the only way to reach the experimental branch; every other value (including
 * `undefined`) leaves `relayMessage` behaving exactly as before.
 */
export const EXPERIMENTAL_PAIRWISE_RETRY = 'experimentalPairwiseRetry';

/**
 * Validate the arguments of the experimental API before any crypto runs.
 *
 * Fails closed: a target that cannot be addressed is an error, never a silent
 * fallback to the whole group. Returns the normalized JID and device id.
 */
export const assertExperimentalPairwiseTarget = ({ groupJid, message, participant }) => {
    const group = jidDecode(groupJid);
    if (!group || group.server !== 'g.us') {
        throw new Boom('relayGroupMessagePairwiseExperimental only accepts a group JID', { statusCode: 400 });
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new Boom('relayGroupMessagePairwiseExperimental needs a message object', { statusCode: 400 });
    }
    const jid = typeof participant === 'string' ? participant : participant?.jid;
    if (!jid || typeof jid !== 'string' || !jid.includes('@')) {
        throw new Boom('relayGroupMessagePairwiseExperimental needs a valid participant JID', { statusCode: 400 });
    }
    const decoded = jidDecode(jid);
    if (!decoded?.user || !decoded?.server) {
        throw new Boom(`Invalid participant JID "${jid}"`, { statusCode: 400 });
    }
    return { jid, user: decoded.user, device: decoded.device };
};

/**
 * Replace the pairwise plaintext content for this one recipient.
 *
 * Mirrors the PoC's per-recipient override: the retransmitted content may
 * differ from the stored message, but only here and only when a caller asked
 * for it. The retry envelope is preserved explicitly — the Sender Key
 * distribution message and `messageContextInfo` are part of the retry
 * transport, not of the content being substituted.
 *
 * Returns `messageToSend` untouched when no payload was supplied, so the
 * default retry content remains byte-identical to the original message.
 */
export const applyExperimentalPairwisePlaintext = ({ messageToSend, experimentalPayload }) => {
    if (!experimentalPayload || typeof experimentalPayload !== 'object') {
        return messageToSend;
    }
    const substituted = { ...experimentalPayload };
    if (messageToSend?.messageContextInfo) {
        substituted.messageContextInfo = messageToSend.messageContextInfo;
    }
    if (messageToSend?.senderKeyDistributionMessage) {
        substituted.senderKeyDistributionMessage = messageToSend.senderKeyDistributionMessage;
    }
    return substituted;
};

/**
 * Emit the diagnostic line for one experimental retransmission.
 *
 * Deliberately limited to addressing and sizing metadata. No private keys, no
 * Signal session material, no Sender Key secrets, no plaintext and no
 * credentials are logged — the point is to prove which device the pairwise
 * stanza went to and what was built, not to leak the contents.
 */
export const logPairwiseExperiment = (logger, info) => {
    const line = [
        '[PAIRWISE-EXPERIMENT]',
        `groupJid=${info.groupJid}`,
        `messageId=${info.messageId}`,
        `participant=${info.participant}`,
        `participantDevice=${info.participantDevice}`,
        `retryCount=${info.retryCount}`,
        `isRetryResend=${info.isRetryResend}`,
        `remoteJid=${info.remoteJid}`,
        `stanzaType=${info.stanzaType}`,
        `encType=${info.encType}`,
        `messageSize=${info.messageSize}`,
        `senderKeyUsed=${info.senderKeyUsed}`,
        `pairwiseEncryptionUsed=${info.pairwiseEncryptionUsed}`,
        `payloadSubstituted=${info.payloadSubstituted}`
    ].join(' ');
    logger?.info?.(line);
};
