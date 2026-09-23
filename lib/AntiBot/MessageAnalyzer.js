/**
 * MessageAnalyzer — turns a WebMessageInfo into a small feature sample.
 *
 * PRIVACY: the sample never contains message content. Text is reduced to a
 * length and a short digest; media to its type and declared size. That is all
 * the behavioural analysis needs, and it means the AntiBot state cannot leak a
 * conversation.
 *
 * RELIABILITY: nothing here is a bot signal by itself. Every feature is an
 * *input* to the temporal analysis; the analyzers that consume them are the ones
 * that decide whether a combination is meaningful.
 */

import { createHash } from 'crypto';

/** Message types that are trivially automatable by a human too — no special weight. */
const MEDIA_KEYS = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'];

/** Returns the first present key among the interesting message members. */
export const getMessageKind = (message = {}) => {
    if (!message || typeof message !== 'object') return 'unknown';
    const keys = Object.keys(message);
    if (!keys.length) return 'empty';
    // Wrappers are unwrapped by the caller; here the first real member wins.
    for (const key of keys) {
        if (key === 'messageContextInfo') continue;
        return key;
    }
    return 'unknown';
};

/** Raw byte length of a Buffer/Uint8Array, 0 otherwise. */
const bufLen = (v) => (v && typeof v.length === 'number' ? v.length : 0);

/**
 * Builds a compact, content-free sample from a WebMessageInfo.
 *
 * @param {object} info  WebMessageInfo (already decoded)
 * @param {object} [opts]
 * @param {number} [opts.now] injectable clock
 * @returns {object|null} sample, or null when the input is unusable
 */
export const buildSample = (info, opts = {}) => {
    if (!info || typeof info !== 'object') return null;
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const key = info.key || {};
    const message = info.message || {};
    const kind = getMessageKind(message);

    const text = extractText(message);
    // Digest is a fingerprint of the *shape* of the text, so two structurally
    // identical payloads hash the same; the text itself is discarded.
    const digest = createHash('sha1')
        .update(normaliseForDigest(text, kind))
        .digest('hex')
        .slice(0, 12);

    const ts = Number(info.messageTimestamp) * 1000 || now();

    return {
        /**
         * TIMING SOURCE: arrival time, not the message timestamp.
         *
         * `messageTimestamp` has ONE-SECOND resolution in the proto, so a sender
         * emitting ten messages per second produces identical timestamps and the
         * pacing is invisible. The honest measurement of pacing is when this
         * device actually received the message, which is what `now()` is here.
         * `msgTs` keeps the declared timestamp for the report.
         */
        ts: now(),
        msgTs: ts,
        kind,
        digest,
        textLength: text.length,
        isMedia: MEDIA_KEYS.includes(kind),
        mediaBytes: mediaBytesOf(message, kind),
        // Addressing is recorded for the report, never for scoring.
        addressingMode: key.addressingMode || null,
        hasParticipantAlt: Boolean(key.participantAlt),
        fromMe: Boolean(key.fromMe)
    };
};

/**
 * Extracts the visible text of a message without keeping it.
 * Handles the wrappers and the common text-bearing members.
 */
export const extractText = (message = {}) => {
    if (!message || typeof message !== 'object') return '';
    // Wrappers that hold another message.
    for (const wrapper of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage']) {
        if (message[wrapper]?.message) {
            return extractText(message[wrapper].message);
        }
    }
    if (typeof message.conversation === 'string') return message.conversation;
    if (typeof message.extendedTextMessage?.text === 'string') return message.extendedTextMessage.text;
    for (const cap of ['imageMessage', 'videoMessage', 'documentMessage']) {
        if (typeof message[cap]?.caption === 'string') return message[cap].caption;
    }
    return '';
};

/** Normalises text for the structural digest.
 *
 * IMPORTANT: digits are NOT collapsed. Collapsing them (`1`, `2`, `3` -> `#`)
 * groups "mensagem 1", "mensagem 2" as the same payload — which is how a bot
 * templates, but also how a human counts, dates or lists. The false-positive
 * cost is real and immediate, so the digest keeps the text as written; only
 * whitespace and case are normalised.
 */
const normaliseForDigest = (text, kind) => {
    const t = String(text || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
    return `${kind}:${t}`;
};

/** Declared media size when available (fileLength is the honest field). */
const mediaBytesOf = (message, kind) => {
    const media = message?.[kind];
    if (!media || typeof media !== 'object') return 0;
    if (typeof media.fileLength === 'number') return media.fileLength;
    if (media.fileLength && typeof media.fileLength.toNumber === 'function') {
        return media.fileLength.toNumber();
    }
    if (typeof media.fileLength === 'string') return Number(media.fileLength) || 0;
    return bufLen(media.fileSha256) ? 0 : 0;
};
