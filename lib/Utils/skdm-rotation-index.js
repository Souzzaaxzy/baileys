/**
 * EXPERIMENTAL — Sender Key Distribution Message index (rotation corroboration).
 *
 * WHY THIS EXISTS
 * ---------------
 * A group message that does not decrypt has (at least) two very different
 * causes, and the ciphertext alone cannot tell them apart:
 *
 *   (a) this device joined the group late, or genuinely lost the Sender Key —
 *       the sender did nothing wrong;
 *   (b) the sender ROTATED the Sender Key and distributed the new one to a
 *       SUBSET, so this device was deliberately left out.
 *
 * Both produce the same decryption error. The `decrypt-fail="hide"` attribute
 * helps, but it is a sender-controlled attribute and it also appears in benign
 * flows (for example WhatsApp's own `rereg_recovery_request`, which carries
 * `decrypt-fail="hide"` and still decrypts successfully).
 *
 * The signal that separates them is **presence of a fresh Sender Key
 * Distribution Message for the same (group, author) in the same window**:
 *
 *   - a late joiner / key loss does NOT bring an SKDM for a group it is
 *     already a member of;
 *   - a rotation DOES — the rotated state has to be delivered, and this is the
 *     delivery that was withheld from the excluded devices.
 *
 * So: an undecryptable group message from author A, in group G, shortly after
 * an SKDM from A for G, is a strong corroboration of (b) — and it is NOT
 * satisfiable by (a). That is what makes it worth recording.
 *
 * SCOPE AND HONEST LIMITS
 * -----------------------
 * - It is a HEURISTIC with a time window (`windowMs`). A slow, quiet group can
 *   in principle produce an unrelated SKDM close in time; the window is the
 *   knob that trades recall for precision.
 * - It is *corroboration*, not proof. The caller decides what to do with it.
 * - Memory is bounded: one entry per (group, author) and a hard cap on keys,
 *   with lazy pruning by timestamp.
 *
 * This module is pure (no I/O, no socket, no logger) so it can be unit tested
 * and its windows measured directly.
 */

/** Default window: an SKDM this recent makes an undecryptable message suspicious. */
export const DEFAULT_SKDM_WINDOW_MS = 60 * 1000;

/** Hard cap on tracked (group, author) pairs, so the map cannot grow unbounded. */
export const DEFAULT_SKDM_MAX_ENTRIES = 512;

const SEP = '\u0000';

const keyOf = (group, author) => `${group}${SEP}${author}`;

/**
 * Creates an index of Sender Key Distribution Messages seen on receive.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowMs] how long an SKDM stays relevant
 * @param {number} [opts.maxEntries] hard cap on tracked pairs
 * @param {Function} [opts.now] injectable clock (tests)
 */
export const createSkdmIndex = (opts = {}) => {
    const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : DEFAULT_SKDM_WINDOW_MS;
    const maxEntries = Number.isFinite(opts.maxEntries) ? opts.maxEntries : DEFAULT_SKDM_MAX_ENTRIES;
    const now = typeof opts.now === 'function' ? opts.now : Date.now;

    /** group\0author -> timestamp (ms) of the most recent SKDM */
    const seen = new Map();

    /** Prune stale entries. Called on write, so the map self-cleans. */
    const prune = () => {
        const t = now();
        for (const [k, ts] of seen) {
            if (t - ts > windowMs) seen.delete(k);
        }
    };

    return {
        /**
         * Record that an SKDM from `author` for `group` arrived.
         * Invalid identifiers are ignored (never recorded as "unknown author",
         * which would create a cross-author false match).
         */
        record(group, author) {
            if (!group || !author) return false;
            prune();
            if (seen.size >= maxEntries) {
                // Still too many after pruning: drop the oldest to stay bounded.
                let oldestKey = null;
                let oldestTs = Infinity;
                for (const [k, ts] of seen) {
                    if (ts < oldestTs) { oldestTs = ts; oldestKey = k; }
                }
                if (oldestKey) seen.delete(oldestKey);
            }
            seen.set(keyOf(group, author), now());
            return true;
        },

        /**
         * Was there an SKDM from `author` for `group` inside the window?
         * @returns {boolean}
         */
        recentlySeen(group, author) {
            if (!group || !author) return false;
            const ts = seen.get(keyOf(group, author));
            if (ts === undefined) return false;
            if (now() - ts > windowMs) {
                seen.delete(keyOf(group, author));
                return false;
            }
            return true;
        },

        /** Age in ms of the most recent SKDM for this pair, or null. */
        ageOf(group, author) {
            const ts = seen.get(keyOf(group, author));
            if (ts === undefined) return null;
            return now() - ts;
        },

        /** Number of currently tracked pairs (for diagnostics/tests). */
        size() {
            prune();
            return seen.size;
        },

        /** Forget everything (tests, or a hard reset). */
        clear() {
            seen.clear();
        },

        /** The configured window, exposed so callers/tests can assert on it. */
        windowMs
    };
};
