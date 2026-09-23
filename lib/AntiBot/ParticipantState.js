/**
 * ParticipantState — bounded per-participant sample and evidence state.
 *
 * Bounded memory is a hard requirement: the engine sees every message of every
 * group, and keeping unbounded history would leak. Two caps apply:
 *
 *   - `maxSamples`     — a rolling window of message samples per participant;
 *   - `maxParticipants`— an LRU cap per chat, so an idle chat cannot grow.
 *
 * A ring-buffer would be marginally cheaper, but a plain array with `shift()`
 * of at most `maxSamples` (default 60) is O(60) worst case and far easier to
 * reason about; the dominant cost is the analysis itself, which is O(n) on the
 * same small n.
 */

import { EVIDENCE_CATALOG } from './AntiBotTypes.js';

/**
 * Creates the state store.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxParticipants]
 * @param {number} [opts.maxSamples]
 * @param {Function} [opts.now] injectable clock
 */
export const createParticipantState = (opts = {}) => {
    const maxParticipants = Number.isFinite(opts.maxParticipants) ? opts.maxParticipants : 512;
    const maxSamples = Number.isFinite(opts.maxSamples) ? opts.maxSamples : 60;
    const now = typeof opts.now === 'function' ? opts.now : Date.now;

    /** chatJid -> Map(participantId -> state) */
    const chats = new Map();

    /**
     * A sample is deliberately small: we keep *features*, never full content.
     * `shape` is an 8-char fingerprint of the normalised payload, not the text.
     */
    const makeState = (id, chatJid = null) => ({
        id,
        /**
         * Chat this state belongs to. Kept on the state so a caller holding only
         * the state can key back to (chat, participant) without an auxiliary map.
         */
        chat: chatJid,
        firstSeen: now(),
        lastSeen: now(),
        samples: [],
        evidence: [],
        windows: [],
        score: 0,
        band: 'NORMAL',
        quarantinedAt: null
    });

    const evictIfNeeded = (chatMap) => {
        while (chatMap.size > maxParticipants) {
            // Map preserves insertion order; the first key is the oldest *insert*.
            // We refresh on every touch (delete+set) so it behaves as LRU.
            const oldest = chatMap.keys().next().value;
            if (oldest === undefined) break;
            chatMap.delete(oldest);
        }
    };

    return {
        /** Returns the state for (chat, participant), creating it on demand. */
        get(chatJid, participantId) {
            if (!chatJid || !participantId) return null;
            let chatMap = chats.get(chatJid);
            if (!chatMap) {
                chatMap = new Map();
                chats.set(chatJid, chatMap);
            }
            let state = chatMap.get(participantId);
            if (!state) {
                state = makeState(participantId, chatJid);
                chatMap.set(participantId, state);
            } else {
                // Touch for LRU ordering.
                chatMap.delete(participantId);
                chatMap.set(participantId, state);
            }
            evictIfNeeded(chatMap);
            return state;
        },

        /** Pushes a feature sample, trimming to `maxSamples`. */
        addSample(chatJid, participantId, sample) {
            const state = this.get(chatJid, participantId);
            if (!state) return null;
            state.samples.push(sample);
            if (state.samples.length > maxSamples) {
                state.samples.splice(0, state.samples.length - maxSamples);
            }
            state.lastSeen = sample?.ts ?? now();
            return state;
        },

        /**
         * Replaces the active evidence set. Evidence is *recomputed*, not
         * accumulated: an accumulation model would let a one-off anomaly live
         * forever, which is exactly what the decay requirement forbids.
         */
        setEvidence(chatJid, participantId, evidences) {
            const state = this.get(chatJid, participantId);
            if (!state) return null;
            state.evidence = Array.isArray(evidences) ? evidences.slice() : [];
            return state;
        },

        /**
         * Records a window summary (score + band) so persistence can be judged
         * across windows. Bounded by `maxSamples` windows as well.
         */
        recordWindow(chatJid, participantId, entry) {
            const state = this.get(chatJid, participantId);
            if (!state) return null;
            state.windows.push(entry);
            if (state.windows.length > maxSamples) {
                state.windows.splice(0, state.windows.length - maxSamples);
            }
            return state;
        },

        /** Convenience: the last recorded window for a participant. */
        lastWindow(chatJid, participantId) {
            const state = chats.get(chatJid)?.get(participantId);
            if (!state || !state.windows.length) return null;
            return state.windows[state.windows.length - 1];
        },

        /** All participants currently tracked in a chat. */
        list(chatJid) {
            const chatMap = chats.get(chatJid);
            if (!chatMap) return [];
            return Array.from(chatMap.values());
        },

        /** Drops a participant (on group exit, to bound memory further). */
        forget(chatJid, participantId) {
            const chatMap = chats.get(chatJid);
            if (!chatMap) return false;
            return chatMap.delete(participantId);
        },

        /** Drops a whole chat. */
        forgetChat(chatJid) {
            return chats.delete(chatJid);
        },

        /** Test/diagnostic helper: total tracked pairs. */
        size() {
            let total = 0;
            for (const chatMap of chats.values()) total += chatMap.size;
            return total;
        },

        /** Counts of evidence present, by catalog category — for the UI. */
        categoryCount(chatJid, participantId) {
            const state = chats.get(chatJid)?.get(participantId);
            const out = {};
            for (const ev of state?.evidence || []) {
                const cat = EVIDENCE_CATALOG[ev.type]?.category || 'unknown';
                out[cat] = (out[cat] || 0) + 1;
            }
            return out;
        }
    };
};
