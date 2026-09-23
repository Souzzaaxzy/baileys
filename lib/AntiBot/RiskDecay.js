/**
 * RiskDecay — evidence expires; nobody stays marked forever.
 *
 * The requirement is explicit: if a participant returns to normal behaviour,
 * the score must fall, and an old occurrence must not keep them flagged. Two
 * mechanisms do that:
 *
 *  1. **Evidence is recomputed each window** (see ParticipantState.setEvidence),
 *     so a signal that stopped occurring simply stops being counted.
 *  2. **Exponential half-life decay** on the *persisted* score, applied when the
 *     evaluation runs. `decayHalfLifeMs <= 0` disables it.
 *
 * The decay is applied to the score carried from the previous window, not to the
 * fresh score of the current window: fresh evidence is by definition current and
 * must not be halved before it is even considered.
 */

/** Default half-life: 10 minutes. A quiet participant is clean again in ~30. */
export const DEFAULT_HALF_LIFE_MS = 10 * 60 * 1000;

/**
 * Applies exponential decay to a carried score.
 *
 * @param {number} score       previous score
 * @param {number} elapsedMs   time since the score was last updated
 * @param {number} [halfLifeMs]
 * @returns {number} decayed score (never negative)
 */
export const decayScore = (score, elapsedMs, halfLifeMs = DEFAULT_HALF_LIFE_MS) => {
    const s = Number(score) || 0;
    if (s <= 0) return 0;
    if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return s;
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return s;
    return s * Math.pow(0.5, elapsedMs / halfLifeMs);
};

/**
 * Combines the decayed carry-over with the freshly observed score.
 * The fresh score is authoritative for "what is happening now"; the carry-over
 * only preserves *persistence*. Taking the max is deliberate: a participant who
 * was at 70 and now shows 60 is still at 60, not 65 — we neither invent risk nor
 * erase it, and the decay handles the rest.
 */
export const combineScores = ({ carried = 0, fresh = 0, elapsedMs = 0, halfLifeMs = DEFAULT_HALF_LIFE_MS } = {}) => {
    const decayed = decayScore(carried, elapsedMs, halfLifeMs);
    return Math.max(decayed, Number(fresh) || 0);
};

/**
 * Whether a state should be dropped entirely. Called on housekeeping so the
 * store does not hold participants that went quiet long ago.
 */
export const shouldForget = (lastSeenTs, nowTs, ttlMs = 30 * 60 * 1000) => {
    if (!Number.isFinite(lastSeenTs)) return false;
    return (nowTs - lastSeenTs) > ttlMs;
};

/**
 * Persistence check: how many windows already showed at least OBSERVING-level
 * risk?
 *
 * The threshold used here is deliberately the *observing* band, not the
 * suspicious one. Behaviour alone is capped (12) and therefore can never reach
 * the suspicious band on its own — counting only suspicious windows would make
 * the persistence evidence unreachable for a purely behavioural offender, which
 * is exactly the case persistence exists to catch. A window at OBSERVING means
 * "something was already off here", and recurrence is what upgrades it.
 */
export const countPriorSuspiciousWindows = (windows = [], threshold) => {
    const t = Number.isFinite(threshold) ? threshold : 10;
    return windows.filter((w) => (Number(w?.score) || 0) >= t).length;
};

/**
 * Weight of the persistence evidence for a number of prior risky windows.
 * Escalates in tiers so a long-running offender is not stuck at the floor, and
 * is capped so persistence alone can never dominate the score.
 */
export const persistenceWeightFor = (priorWindows) => {
    const n = Number(priorWindows) || 0;
    if (n <= 0) return 0;
    if (n >= 5) return { weight: 12, type: 'PERSISTENT_RISK' };
    if (n >= 3) return { weight: 9, type: 'PERSISTENT_RISK' };
    if (n >= 1) return { weight: 5, type: 'PERSISTENT_BEHAVIOR' };
    return 0;
};
