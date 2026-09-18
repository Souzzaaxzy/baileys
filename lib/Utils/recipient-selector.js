/**
 * Selective recipient resolution for group messages.
 *
 * The group send path (`relayMessage`) encrypts one Sender Key message
 * (`<enc type="skmsg">`) and fans it out to a device list. By default that list
 * is every participant of the group. This module lets a caller narrow the list
 * to a subset of participants, so the Sender Key material is only distributed
 * to them.
 *
 * Scope of the guarantee: recipients outside the subset do not receive the
 * Sender Key distribution message or the ciphertext, so they cannot decrypt the
 * message with any key they hold. They can still see that a message exists —
 * the server knows the group and the stanza — and the `decrypt-fail` attribute
 * is set so their client hides the undecryptable entry instead of rendering a
 * "waiting for this message" placeholder.
 *
 * This is not a confidentiality boundary against the server, and it is not
 * intended as one.
 */

/** Recipient modes accepted by the group send path. */
export const GROUP_RECIPIENT_MODES = {
    ALL: 'all',
    ADMINS_ONLY: 'admins-only',
    MEMBERS_ONLY: 'members-only'
};

const VALID_MODES = new Set(Object.values(GROUP_RECIPIENT_MODES));

/**
 * Whether a group participant entry is an administrator.
 *
 * `admin` is the field WhatsApp actually sends in the group metadata: it is
 * `'admin'` for a promoted admin, `'superadmin'` for the group creator, and
 * absent/`null` for everyone else. Only these two strings are admin — no name,
 * number or position heuristic.
 */
export const isGroupAdminParticipant = (participant) => {
    const role = participant?.admin;
    return role === 'admin' || role === 'superadmin';
};

/**
 * Pick the participant JIDs that should receive a message for the given mode.
 *
 * Returns a de-duplicated array preserving metadata order. Entries without an
 * `id` are dropped.
 */
export const selectGroupRecipients = (participants, mode) => {
    if (!Array.isArray(participants)) {
        return [];
    }
    const keep = mode === GROUP_RECIPIENT_MODES.MEMBERS_ONLY
        ? p => !isGroupAdminParticipant(p)
        : mode === GROUP_RECIPIENT_MODES.ADMINS_ONLY
            ? p => isGroupAdminParticipant(p)
            : () => true;
    const seen = new Set();
    const recipients = [];
    for (const participant of participants) {
        const id = participant?.id;
        if (!id || seen.has(id)) {
            continue;
        }
        if (keep(participant)) {
            seen.add(id);
            recipients.push(id);
        }
    }
    return recipients;
};

/**
 * Normalize the send options into a restricted recipient set.
 *
 * Accepts either an explicit `recipientParticipants` list (used as-is) or a
 * `recipientMode` naming one of GROUP_RECIPIENT_MODES. Returns `null` when the
 * message should go to every participant, so the caller keeps the default path.
 *
 * Throws when a restriction was requested but resolves to nothing: silently
 * falling back to the full group would send the message to exactly the people
 * it was meant to exclude.
 */
export const resolveGroupRecipients = ({ options, groupData, jid }) => {
    const explicit = options?.recipientParticipants;
    const mode = options?.recipientMode;
    if (!explicit?.length && !mode) {
        return null;
    }
    if (mode && !VALID_MODES.has(mode)) {
        throw new Error(`Unknown recipientMode "${mode}" (expected one of: ${[...VALID_MODES].join(', ')})`);
    }
    const participants = groupData?.participants;
    if (!Array.isArray(participants)) {
        throw new Error('Recipient restriction requested but the group metadata has no participant list');
    }
    const jids = explicit?.length
        ? [...new Set(explicit)]
        : selectGroupRecipients(participants, mode);
    if (!jids.length) {
        throw new Error(`Recipient restriction "${explicit?.length ? 'recipientParticipants' : mode}" matched no participant of ${jid}`);
    }
    return { mode: explicit?.length ? 'explicit' : mode, jids };
};
