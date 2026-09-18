/**
 * EXPERIMENTAL — selective Sender Key rotation for group messages.
 *
 * Hypothesis under test: if a message is encrypted with a NEW Sender Key state
 * B, and only the intended members receive B, then participants that hold only
 * the previous state A cannot decrypt that message.
 *
 * The cryptographic half of that hypothesis is proven in
 * `tests/sender-key-rotation.test.js` against this fork's real Group
 * implementation. Whether the **WhatsApp server** accepts such a message, and
 * how real clients render it, is **not** proven here — see the limitations.
 *
 * Why appending a state is the only correct way to rotate here:
 *
 *   - `SenderKeyRecord.addSenderKeyState(id, iteration, chainKey, signatureKey)`
 *     puts `signatureKey` into the *public* slot and leaves the private signing
 *     key empty. That shape is for states learned from a received SKDM (a
 *     receiver never signs). Using it to create a *sending* state would produce
 *     a state that cannot sign.
 *   - `SenderKeyRecord.setSenderKeyState(...)` does `senderKeyStates.length = 0`,
 *     i.e. it DESTROYS the previous state. Losing A is not acceptable: it would
 *     break every other member who still relies on A.
 *   - `GroupCipher.encrypt()` uses `getSenderKeyState()` with no id, which
 *     returns the **last** state in the record. So appending a fully-formed
 *     `SenderKeyState(id, 0, chainKey, keyPair)` (both keys) makes subsequent
 *     encryption use the new state while A stays available for decryption.
 *
 * The module keeps rotation opt-in and reversible: it never runs unless a
 * caller asks, and it can snapshot/restore the whole record.
 */

import { Boom } from '@hapi/boom';

import { jidDecode } from '../WABinary/index.js';

/**
 * Option name that turns the experimental rotation on. Present and true is the
 * only way to reach the rotation branch; anything else leaves the normal send
 * path untouched.
 */
export const EXPERIMENTAL_SENDER_KEY_ROTATION = 'experimentalSenderKeyRotation';

/**
 * Validate the arguments of the experimental rotation API before any crypto
 * runs. Fails closed: a missing or unusable participant list is an error, never
 * a silent fallback to the whole group.
 */
export const assertExperimentalRotationTarget = ({ groupJid, message, allowedParticipants }) => {
    const group = jidDecode(groupJid);
    if (!group || group.server !== 'g.us') {
        throw new Boom('relayGroupMessageWithSenderKeyRotation only accepts a group JID', { statusCode: 400 });
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new Boom('relayGroupMessageWithSenderKeyRotation needs a message object', { statusCode: 400 });
    }
    if (!Array.isArray(allowedParticipants) || allowedParticipants.length === 0) {
        throw new Boom('relayGroupMessageWithSenderKeyRotation needs a non-empty allowedParticipants list', {
            statusCode: 400
        });
    }
    const jids = [...new Set(allowedParticipants)];
    for (const jid of jids) {
        const decoded = jidDecode(jid);
        if (!decoded?.user || !decoded?.server) {
            throw new Boom(`Invalid participant JID "${jid}" in allowedParticipants`, { statusCode: 400 });
        }
    }
    return { jids };
};

/**
 * Emit the diagnostic line for one rotation.
 *
 * Only addressing and sizing metadata: no chain key, no signing key, no Sender
 * Key material, no plaintext, no credentials. The point is to prove which
 * senderKeyId a message used and which devices were addressed.
 */
export const logSenderKeyRotation = (logger, info) => {
    const line = [
        '[SENDER-KEY-ROTATION]',
        `groupJid=${info.groupJid}`,
        `messageId=${info.messageId}`,
        `previousSenderKeyId=${info.previousSenderKeyId ?? 'none'}`,
        `newSenderKeyId=${info.newSenderKeyId}`,
        `allowedParticipants=${info.allowedParticipants}`,
        `addressedDevices=${info.addressedDevices}`,
        `totalGroupDevices=${info.totalGroupDevices ?? 'unknown'}`,
        `skmsgType=${info.skmsgType}`,
        `skmsgCount=${info.skmsgCount ?? 'none'}`,
        `retryUsed=${info.retryUsed}`,
        `pairwiseUsed=${info.pairwiseUsed}`,
        `restored=${info.restored ?? false}`
    ].join(' ');
    logger?.info?.(line);
};

/**
 * Read the current Sender Key id from a record, or `null` when it has no state.
 * Reads the newest state — the one `GroupCipher.encrypt()` will use.
 */
export const currentSenderKeyId = (record) => {
    const state = record?.getSenderKeyState?.();
    return state ? state.getKeyId() : null;
};

/**
 * Restore a record from a snapshot taken by `snapshotSenderKeyRecord`.
 *
 * Used by the experimental flow so a failed or interrupted rotation cannot
 * leave the group's Sender Key in a state the normal send path cannot use.
 * `snapshot` is the array produced by `record.serialize()`.
 */
export const restoreSenderKeyRecord = (record, snapshot) => {
    if (!record || !Array.isArray(snapshot)) {
        throw new Boom('restoreSenderKeyRecord needs a record and a snapshot array', { statusCode: 500 });
    }
    const { SenderKeyState } = record.senderKeyStates?.[0]?.constructor
        ? { SenderKeyState: record.senderKeyStates[0].constructor }
        : {};
    if (!SenderKeyState) {
        throw new Boom('cannot restore: no SenderKeyState constructor available', { statusCode: 500 });
    }
    record.senderKeyStates = snapshot.map(structure => new SenderKeyState(null, null, null, null, null, null, structure));
    return record;
};

/** How long a rotated message stays protected against retry resends. */
const SUPPRESSED_RETRY_TTL_MS = 10 * 60 * 1000;

/**
 * Tracks rotated messages whose retry resends must not be answered.
 *
 * This is the local equivalent of the PoC's `PreRetryCallback`. Without it the
 * isolation is undone by the retry path: a participant that cannot decrypt the
 * rotated message replies with a retry receipt, and `sendMessagesAgain` answers
 * it with `relayMessage({ participant })` — which re-sends the message
 * **pairwise encrypted to that device**. The excluded participant then reads the
 * content it was not meant to read, which is exactly what a real-device test
 * showed happening.
 *
 * Withholding the resend leaves the participant with a message it cannot
 * decrypt and no way to ask for it again. It still knows the message exists
 * (the stanza reached it, so a quote/reply can reference it) — it simply cannot
 * render the content.
 *
 * The registry is per socket and TTL-bounded so it cannot grow without limit;
 * `getMessage`-based retries for ordinary messages are untouched.
 */
export const createSuppressedRetryRegistry = (logger) => {
    const entries = new Map();

    const prune = (now) => {
        for (const [id, expiresAt] of entries) {
            if (now > expiresAt) {
                entries.delete(id);
            }
        }
    };

    return {
        /** Mark a rotated message: its retries must not be answered. */
        register(messageId) {
            if (!messageId) {
                return;
            }
            const now = Date.now();
            if (entries.size > 512) {
                prune(now);
            }
            entries.set(messageId, now + SUPPRESSED_RETRY_TTL_MS);
            logger?.debug?.({ messageId }, 'registered a rotated message for retry suppression');
        },
        /** Whether a retry receipt for this message should be ignored. */
        isSuppressed(messageId) {
            if (!messageId) {
                return false;
            }
            const expiresAt = entries.get(messageId);
            if (expiresAt === undefined) {
                return false;
            }
            if (Date.now() > expiresAt) {
                entries.delete(messageId);
                return false;
            }
            return true;
        },
        clear() {
            entries.clear();
        },
        get size() {
            return entries.size;
        }
    };
};

/** Diagnostic line for a suppressed retry. Structure only, no key material. */
export const logSuppressedRetry = (logger, info) => {
    logger?.info?.(
        [
            '[SENDER-KEY-ROTATION] retry suppressed',
            `messageId=${info.messageId}`,
            `participant=${info.participant}`,
            `groupJid=${info.groupJid}`,
            'reason=rotated-message-content-withheld'
        ].join(' ')
    );
};