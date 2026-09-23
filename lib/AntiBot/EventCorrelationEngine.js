/**
 * EventCorrelationEngine — joins independent streams about the same message.
 *
 * WHY CORRELATION, AND WHY IT IS NOT ANOTHER SOURCE OF WEIGHT
 * ----------------------------------------------------------
 * The stanza observer sees transport facts (ids, participants, timing, receipts,
 * presence). The decoded message sees protocol facts. Neither is trustworthy
 * alone — but a *contradiction between them* is exactly the kind of independent
 * evidence the design asks for.
 *
 * The engine is intentionally conservative:
 *
 *   - a contradiction is only recorded when BOTH sides supplied a value;
 *   - a single contradiction never scores; it is upgraded to
 *     PROTOCOL_INCONSISTENCY only once the same field contradicted itself
 *     `repeatsBeforeEvidence` times.
 *
 * Memory is bounded by a small per-participant pending map with TTL, because the
 * join is between a stanza and a message that arrive milliseconds apart.
 */

/** How long a stanza fact waits for its message before being dropped. */
export const DEFAULT_PENDING_TTL_MS = 30 * 1000;

/** His many times a field must contradict itself before it becomes evidence. */
export const DEFAULT_REPEATS_BEFORE_EVIDENCE = 3;

/** Hard cap of pending correlated facts. */
export const DEFAULT_MAX_PENDING = 256;

/**
 * Creates the correlation engine.
 *
 * @param {object} [opts]
 * @param {number} [opts.pendingTtlMs]
 * @param {number} [opts.repeatsBeforeEvidence]
 * @param {number} [opts.maxPending]
 * @param {Function} [opts.now]
 */
export const createCorrelationEngine = (opts = {}) => {
    const ttl = Number.isFinite(opts.pendingTtlMs) ? opts.pendingTtlMs : DEFAULT_PENDING_TTL_MS;
    const repeats = Number.isFinite(opts.repeatsBeforeEvidence)
        ? opts.repeatsBeforeEvidence
        : DEFAULT_REPEATS_BEFORE_EVIDENCE;
    const maxPending = Number.isFinite(opts.maxPending) ? opts.maxPending : DEFAULT_MAX_PENDING;
    const now = typeof opts.now === 'function' ? opts.now : Date.now;

    /** chat\0participant -> { stanzaFacts, ts } */
    const pending = new Map();
    /** chat\0participant\0field -> count of contradictions */
    const contradictionCounts = new Map();

    const prune = () => {
        const t = now();
        for (const [k, v] of pending) {
            if (t - v.ts > ttl) pending.delete(k);
        }
        while (pending.size > maxPending) {
            const oldest = pending.keys().next().value;
            if (oldest === undefined) break;
            pending.delete(oldest);
        }
    };

    const keyOf = (chat, participant) => `${chat}\u0000${participant}`;

    return {
        /** Records a stanza fact, waiting to be joined with its message. */
        noteStanza(chat, participant, facts) {
            if (!chat || !participant || !facts) return;
            prune();
            pending.set(keyOf(chat, participant), { facts, ts: now() });
        },

        /**
         * Joins a decoded message with the stanza facts recorded for the same
         * (chat, participant) and returns the inconsistencies found.
         *
         * @param {string} chat
         * @param {string} participant
         * @param {object} protoFacts
         * @param {Function} findInconsistencies injected comparison (keeps this module pure)
         */
        correlate(chat, participant, protoFacts, findInconsistencies) {
            const k = keyOf(chat, participant);
            const entry = pending.get(k);
            if (!entry) return { found: [], promoted: [] };
            pending.delete(k);

            const found = typeof findInconsistencies === 'function'
                ? findInconsistencies(entry.facts, protoFacts)
                : [];
            const promoted = [];

            for (const inc of found) {
                const ck = `${k}\u0000${inc.field}`;
                const n = (contradictionCounts.get(ck) || 0) + 1;
                contradictionCounts.set(ck, n);
                // Only a REPEATED contradiction becomes evidence. One mismatch
                // between a stanza and its decode is clock skew or a rebuild.
                if (n >= repeats) promoted.push({ field: inc.field, count: n, sample: inc });
            }

            return { found, promoted };
        },

        /** Clears counts for a participant (on exit, or after a clean window). */
        forget(chat, participant) {
            const prefix = keyOf(chat, participant);
            for (const key of contradictionCounts.keys()) {
                if (key.startsWith(prefix)) contradictionCounts.delete(key);
            }
            pending.delete(prefix);
        },

        /** Diagnostics. */
        stats() {
            return { pending: pending.size, trackedContradictions: contradictionCounts.size };
        }
    };
};
