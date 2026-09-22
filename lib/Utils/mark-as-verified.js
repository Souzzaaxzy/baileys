/**
 * EXPERIMENTAL — MarkAsVerifiedAction (research only).
 *
 * WHAT THIS ACTUALLY IS (evidence, not the name)
 * ----------------------------------------------
 *
 * 1. The message lives in `proto.Message.MarkAsVerifiedAction` — the same
 *    namespace as `Message`, i.e. an E2E message structure. Verified against
 *    WhatsApp Web's own internal spec (`Message$MarkAsVerifiedAction`):
 *
 *      userJidString        = 1  STRING
 *      verified             = 2  BOOL
 *      verifiedIdentityKey  = 3  BYTES
 *      actionSeq            = 4  UINT64
 *
 * 2. Its PARENT is `Message.ProtocolMessage`, field **32**:
 *
 *      optional MarkAsVerifiedAction markAsVerifiedAction = 32;
 *
 *    with `ProtocolMessage.type = MARK_AS_VERIFIED_ACTION` (enum value **36**).
 *
 * 3. It is **NOT** an App State action. There is no `markAsVerified*` field in
 *    `SyncActionValue`, so no `SyncdPatch` / `SyncdMutation` / LTHash path
 *    applies. Building one would be inventing a transport the schema does not
 *    describe.
 *
 * 4. Direction is NOT established by the schema. There is no public evidence of
 *    a client legitimately ORIGINATING this action. The reference client
 *    implementation only *receives* it (it turns an inbound action into a
 *    chat-level update). So sending is, at this point, an EXPERIMENT: it may be
 *    ignored or rejected by the server.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Builds the correct `ProtocolMessage` envelope and sends it through the
 * EXISTING send path (`relayMessage`). It does not create a socket, a
 * serializer, an App State, a session or a retry system.
 *
 * It deliberately does NOT fabricate `verifiedIdentityKey`: if the caller
 * cannot supply a legitimate identity key, the field is simply omitted rather
 * than filled with random bytes or another account's key.
 */

import { Boom } from '@hapi/boom';

import { jidDecode, jidNormalizedUser } from '../WABinary/index.js';

/** ProtocolMessage.Type.MARK_AS_VERIFIED_ACTION — see the proto enum. */
export const MARK_AS_VERIFIED_ACTION_TYPE = 36;

/** ProtocolMessage field 32: `markAsVerifiedAction`. */
export const MARK_AS_VERIFIED_ACTION_FIELD = 32;

/**
 * Normalize a target JID for `userJidString`.
 *
 * The action expects a JID **string**. The schema does not say whether it is a
 * PN or a LID, so this helper accepts either and normalizes the device suffix
 * away (`:12@…` -> `@…`) without converting between PN and LID. Converting
 * would be a guess the evidence does not support.
 *
 * @param {string} jid
 * @returns {string}
 */
export const normalizeActionJid = jid => {
    if (typeof jid !== 'string' || !jid.trim()) {
        throw new Boom('MarkAsVerifiedAction needs a JID string', { statusCode: 400 });
    }
    const decoded = jidDecode(jid.trim());
    if (!decoded?.user || !decoded?.server) {
        throw new Boom(`MarkAsVerifiedAction got an invalid JID: ${jid}`, { statusCode: 400 });
    }
    return jidNormalizedUser(jid.trim());
};

/**
 * Validate the payload before anything is built.
 *
 * Fails closed: a bad target or a bad `actionSeq` is an error, never silently
 * coerced — a malformed protocol message is worse than no message.
 *
 * @param {{userJidString?: string, verified?: boolean, verifiedIdentityKey?: Uint8Array|string, actionSeq?: number|string|bigint}} input
 */
export const assertMarkAsVerifiedPayload = input => {
    const payload = input && typeof input === 'object' ? input : {};

    const userJidString = normalizeActionJid(payload.userJidString);

    if (payload.verified !== undefined && typeof payload.verified !== 'boolean') {
        throw new Boom('MarkAsVerifiedAction: `verified` must be a boolean when present', { statusCode: 400 });
    }

    if (payload.actionSeq !== undefined && payload.actionSeq !== null) {
        const seq = payload.actionSeq;
        const ok =
            (typeof seq === 'number' && Number.isInteger(seq) && seq >= 0) ||
            (typeof seq === 'bigint' && seq >= 0n) ||
            (typeof seq === 'string' && /^\d+$/.test(seq));
        if (!ok) {
            throw new Boom('MarkAsVerifiedAction: `actionSeq` must be a non-negative integer', { statusCode: 400 });
        }
    }

    if (payload.verifiedIdentityKey !== undefined && payload.verifiedIdentityKey !== null) {
        const key = payload.verifiedIdentityKey;
        const isBytes = key instanceof Uint8Array || Buffer.isBuffer(key);
        if (!isBytes && typeof key !== 'string') {
            throw new Boom('MarkAsVerifiedAction: `verifiedIdentityKey` must be bytes or a base64 string', { statusCode: 400 });
        }
        if (isBytes && key.length === 0) {
            throw new Boom('MarkAsVerifiedAction: `verifiedIdentityKey` was empty', { statusCode: 400 });
        }
    }

    return {
        userJidString,
        verified: payload.verified,
        verifiedIdentityKey: payload.verifiedIdentityKey,
        actionSeq: payload.actionSeq
    };
};

/**
 * Build the `ProtocolMessage` content (NOT sent yet).
 *
 * Only the fields the caller actually provided are set — omitted fields stay
 * absent on the wire, which is meaningfully different from sending a `false`.
 *
 * @returns {{type: number, markAsVerifiedAction: object}}
 */
export const buildMarkAsVerifiedProtocolMessage = input => {
    const clean = assertMarkAsVerifiedPayload(input);

    const action = { userJidString: clean.userJidString };
    if (clean.verified !== undefined) {
        action.verified = clean.verified;
    }
    if (clean.verifiedIdentityKey !== undefined && clean.verifiedIdentityKey !== null) {
        action.verifiedIdentityKey = clean.verifiedIdentityKey;
    }
    if (clean.actionSeq !== undefined && clean.actionSeq !== null) {
        action.actionSeq = clean.actionSeq;
    }

    return {
        type: MARK_AS_VERIFIED_ACTION_TYPE,
        markAsVerifiedAction: action
    };
};

/**
 * Diagnostic line for one attempt.
 *
 * Structure only. `verifiedIdentityKey` is reported as a byte LENGTH, never as
 * content — the key must not end up in a log, an event or an error message.
 */
export const logMarkAsVerifiedAttempt = (logger, info) => {
    logger?.info?.(
        [
            '[MARK-AS-VERIFIED]',
            `chatJid=${info.chatJid}`,
            `messageId=${info.messageId}`,
            `userJidString=${info.userJidString}`,
            `jidType=${String(info.userJidString || '').endsWith('@lid') ? 'lid' : 'pn'}`,
            `verified=${info.verified}`,
            `actionSeq=${info.actionSeq ?? 'none'}`,
            `identityKeyBytes=${info.identityKeyBytes ?? 0}`,
            `sent=${info.sent}`
        ].join(' ')
    );
};

/**
 * Options name that lets `relayMessage` carry a pre-built mark-as-verified
 * protocol message. Present and an object is the only way in; anything else
 * leaves every other send untouched.
 */
export const MARK_AS_VERIFIED_EXPERIMENTAL = 'markAsVerifiedExperimental';

/**
 * Send a MarkAsVerifiedAction through the existing relay path.
 *
 * @param {object} params
 * @param {Function} params.relayMessage the socket's `relayMessage`
 * @param {string} params.chatJid conversation to send in
 * @param {string} params.userJidString target JID for the action
 * @param {boolean} [params.verified]
 * @param {Uint8Array|string} [params.verifiedIdentityKey]
 * @param {number|string|bigint} [params.actionSeq]
 * @param {string} [params.messageId]
 * @param {object} [params.logger]
 * @returns {Promise<{ok: boolean, built: object, messageId: string|undefined, error?: string, reason?: string}>}
 */
export const sendMarkAsVerifiedAction = async params => {
    const {
        relayMessage,
        chatJid,
        userJidString,
        verified,
        verifiedIdentityKey,
        actionSeq,
        messageId,
        logger
    } = params || {};

    if (typeof relayMessage !== 'function') {
        return { ok: false, built: null, messageId: undefined, error: 'relay indisponível', reason: 'sem_relay' };
    }

    // `chatJid` é opcional: sem ele, a conversa é o próprio alvo. Fazer o
    // default AQUI (e não só na fachada do socket) mantém o helper utilizável
    // direto — foi um bug real quando o default só existia na fachada.
    let chat;
    try {
        chat = normalizeActionJid(chatJid || userJidString);
    } catch (e) {
        return { ok: false, built: null, messageId: undefined, error: e?.message || String(e), reason: 'payload_invalido' };
    }

    let built;
    try {
        built = buildMarkAsVerifiedProtocolMessage({ userJidString, verified, verifiedIdentityKey, actionSeq });
    } catch (e) {
        // Falha ao VALIDAR: nada é enviado (fail-closed).
        return { ok: false, built: null, messageId: undefined, error: e?.message || String(e), reason: 'payload_invalido' };
    }

    try {
        await relayMessage(chat, built, { messageId });
        logMarkAsVerifiedAttempt(logger, {
            chatJid: chat,
            messageId,
            userJidString: built.markAsVerifiedAction.userJidString,
            verified: built.markAsVerifiedAction.verified,
            actionSeq: built.markAsVerifiedAction.actionSeq != null ? String(built.markAsVerifiedAction.actionSeq) : null,
            identityKeyBytes: built.markAsVerifiedAction.verifiedIdentityKey
                ? built.markAsVerifiedAction.verifiedIdentityKey.length
                : 0,
            sent: true
        });
        return { ok: true, built, messageId };
    } catch (e) {
        logMarkAsVerifiedAttempt(logger, {
            chatJid: chat,
            messageId,
            userJidString: built.markAsVerifiedAction.userJidString,
            verified: built.markAsVerifiedAction.verified,
            actionSeq: built.markAsVerifiedAction.actionSeq != null ? String(built.markAsVerifiedAction.actionSeq) : null,
            identityKeyBytes: 0,
            sent: false
        });
        return { ok: false, built, messageId, error: e?.message || String(e), reason: 'transporte' };
    }
};
