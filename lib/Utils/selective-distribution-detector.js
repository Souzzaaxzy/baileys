/**
 * EXPERIMENTAL — detection of selective-distribution group messages.
 *
 * A group message can be delivered to every participant while only some of them
 * can decrypt it: the sender rotates the Sender Key, distributes the new key to
 * a subset, and marks the ciphertext `decrypt-fail="hide"` so the clients that
 * cannot read it hide the entry instead of showing a placeholder.
 *
 * From the receiving side that has a signature, and it is a **transport**
 * signature — it does not depend on what the message contains, so it also
 * catches other implementations of the same idea, not just ours:
 *
 *   1. `<enc type="skmsg">` — a group Sender Key message;
 *   2. the decryption failed with "no Sender Key for this sender" — this device
 *      was not given the key, which is the point of the technique;
 *   3. `decrypt-fail="hide"` is present — the sender explicitly told clients to
 *      hide the undecryptable entry.
 *
 * (2) alone is not enough: a device that simply joined late, or a genuine key
 * loss, produces the same error. (3) is what marks intent — the attribute only
 * appears when a sender deliberately restricts the fan-out, and it is set by the
 * same code path that withholds the key. Requiring both keeps false positives
 * down.
 *
 * What this does NOT do: decide what to do about it. It reports; the caller
 * decides.
 */

/** The `<enc>` attribute the technique sets to suppress the failure UI. */
export const DECRYPT_FAIL_ATTR = 'decrypt-fail';

/** The value meaning "hide the entry instead of showing a placeholder". */
export const DECRYPT_FAIL_HIDE = 'hide';

/** Whether an `<enc>` node carries `decrypt-fail="hide"`. */
export const hasDecryptFailHide = (attrs) => attrs?.[DECRYPT_FAIL_ATTR] === DECRYPT_FAIL_HIDE;

/**
 * Whether a failed group decryption looks like a selective-distribution message.
 *
 * `encType` is the `<enc>` type, `encAttrs` its attributes, and `error` the
 * failure from the decryption attempt.
 */
export const isSelectiveDistributionFailure = ({ encType, encAttrs, error }) => {
    if (encType !== 'skmsg') {
        return false;
    }
    if (!hasDecryptFailHide(encAttrs)) {
        return false;
    }
    const message = String(error?.message || error || '');
    // The Sender Key was never delivered to this device: the receiver has no
    // state to decrypt with. These are the errors the technique produces —
    // `GroupCipher` throws "No session found to decrypt message" when it has no
    // state for the message's key id, and "No SenderKeyRecord found" when the
    // group record is empty.
    return /no session (found )?to decrypt|no senderkeyrecord|senderkey/i.test(message);
};

/**
 * Build the structured report handed to the caller.
 *
 * Structure only: no key material, no plaintext, no session data. The caller
 * receives enough to log, warn, and act (remove the author, warn the group),
 * and nothing that could leak a secret.
 */
export const buildSelectiveDistributionReport = ({ stanza, error }) => {
    const enc = Array.isArray(stanza?.content)
        ? stanza.content.find(child => child.tag === 'enc' && child.attrs?.type === 'skmsg')
        : undefined;
    const participantsNode = Array.isArray(stanza?.content)
        ? stanza.content.find(child => child.tag === 'participants')
        : undefined;
    const addressed = Array.isArray(participantsNode?.content)
        ? participantsNode.content.map(node => node.attrs?.jid).filter(Boolean)
        : [];

    return {
        kind: 'selective-distribution',
        messageId: stanza?.attrs?.id,
        groupJid: stanza?.attrs?.from,
        author: stanza?.attrs?.participant,
        encType: enc?.attrs?.type,
        decryptFail: enc?.attrs?.[DECRYPT_FAIL_ATTR],
        addressedDeviceCount: addressed.length,
        reason: error?.message?.toString() ?? String(error ?? 'unknown')
    };
};