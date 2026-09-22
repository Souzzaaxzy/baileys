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
export const buildSelectiveDistributionReport = ({ stanza, error, skdmRecentMs = null }) => {
    const enc = Array.isArray(stanza?.content)
        ? stanza.content.find(child => child.tag === 'enc' && child.attrs?.type === 'skmsg')
        : undefined;
    const participantsNode = Array.isArray(stanza?.content)
        ? stanza.content.find(child => child.tag === 'participants')
        : undefined;
    const addressed = Array.isArray(participantsNode?.content)
        ? participantsNode.content.map(node => node.attrs?.jid).filter(Boolean)
        : [];

    // ── Signals that do not depend on the sender's own attribute ─────────────
    //
    // `decrypt-fail` is set by the sender, so a report built only from it proves
    // intent but can be gamed. These three are structural and corroborate it:
    //
    //  1. `phash` — a normal group Sender Key fan-out advertises a participant
    //     hash of the addressed set. A restricted fan-out that builds its
    //     recipient list differently (the rotation path) does not. Absence is
    //     therefore informative, and it is NOT under the sender's control in
    //     the same way the attribute is.
    //  2. `density` — addressed devices / total group devices. A deliberate
    //     subset shows up as a low density on a group far larger than the set.
    //  3. `skdmRecentMs` — a Sender Key Distribution Message from this same
    //     author for this same group arrived this recently. A device that simply
    //     joined late, or lost the key, does NOT receive one for a group it is
    //     already in; a rotation does. This is the signal that separates the two
    //     causes of an identical decryption error.
    //
    // All three are reported as structure only: counts, booleans and a time
    // delta. No keys, no chain keys, no session data, no plaintext.
    const hasPhash = enc?.attrs?.phash !== undefined && enc?.attrs?.phash !== null;
    const addressedDeviceCount = addressed.length;
    const groupDeviceCount = Number(stanza?.attrs?.participant_count ?? NaN);
    const groupDeviceCountKnown = Number.isFinite(groupDeviceCount);
    const density = groupDeviceCountKnown && groupDeviceCount > 0
        ? addressedDeviceCount / groupDeviceCount
        : null;

    return {
        kind: 'selective-distribution',
        messageId: stanza?.attrs?.id,
        groupJid: stanza?.attrs?.from,
        author: stanza?.attrs?.participant,
        encType: enc?.attrs?.type,
        decryptFail: enc?.attrs?.[DECRYPT_FAIL_ATTR],
        addressedDeviceCount,
        // ── corroborating structure (independent of `decrypt-fail`) ──────────
        hasPhash,
        groupDeviceCount: groupDeviceCountKnown ? groupDeviceCount : null,
        density,
        skdmRecentMs: Number.isFinite(skdmRecentMs) ? skdmRecentMs : null,
        reason: error?.message?.toString() ?? String(error ?? 'unknown')
    };
};