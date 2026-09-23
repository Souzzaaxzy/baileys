/**
 * AntiBotTypes — shared vocabulary of the AntiBot core.
 *
 * WHAT THIS DETECTS, AND WHAT IT DOES NOT
 * ---------------------------------------
 * This core looks for ONE thing: *unauthorised automated behaviour*, built from
 * **correlated, persistent, independent evidence**. It deliberately does NOT
 * treat any of the following as proof, because every one of them happens to
 * ordinary humans using ordinary clients:
 *
 *   - talking a lot, or talking fast;
 *   - being online without sending presence, or sending no read receipts;
 *   - using LID, PN, or any particular addressing mode;
 *   - using WhatsApp Web / Desktop, or reconnecting;
 *   - sending media, stickers, audio or edited messages;
 *   - carrying an unfamiliar stanza attribute or an unusual payload shape.
 *
 * Those may at most contribute small, capped "weak" weight, and several of them
 * are explicitly listed as NOT_USABLE. See EVIDENCE_CATALOG.
 *
 * Evidence classes (`category`) exist so the ConfidenceEngine can require
 * signals from *different* classes before confirming. One very strong signal is
 * never enough.
 */

/** Risk bands produced by the ConfidenceEngine. */
export const ANTI_BOT_STATUS = Object.freeze({
    NORMAL: 'NORMAL',
    OBSERVING: 'OBSERVING',
    SUSPICIOUS: 'SUSPICIOUS',
    HIGH_RISK: 'HIGH_RISK',
    CONFIRMED: 'CONFIRMED'
});

/** Where an evidence came from — used for the multi-category requirement. */
export const EVIDENCE_CATEGORY = Object.freeze({
    /** Message timing / repetition / payload shape. */
    BEHAVIOR: 'behavior',
    /** Structure of the message as the protocol presents it. */
    PROTOCOL: 'protocol',
    /** Low-level stanza attributes observed on receive. */
    STANZA: 'stanza',
    /** Repetition across time windows. */
    PERSISTENCE: 'persistence'
});

/** How much an evidence is worth. Weights live in EVIDENCE_CATALOG, not here. */
export const EVIDENCE_LEVEL = Object.freeze({
    WEAK: 'WEAK',
    MEDIUM: 'MEDIUM',
    STRONG: 'STRONG',
    CRITICAL: 'CRITICAL'
});

/**
 * Every evidence type the engine can emit.
 *
 * The strings are stable: they go into logs and into the report the bot
 * receives, so renaming one is a breaking change.
 */
export const EVIDENCE_TYPE = Object.freeze({
    /** Inter-message intervals are near-constant (machine pacing). */
    REGULAR_INTERVALS: 'regular_intervals',
    /** The same payload shape repeats across many messages. */
    PAYLOAD_SIMILARITY: 'payload_similarity',
    /** The same message types in a repeating cycle. */
    REPEATING_SEQUENCE: 'repeating_sequence',
    /** Message length distribution is by machine, not human (near-identical). */
    UNIFORM_LENGTH: 'uniform_length',
    /** Suspicious behaviour observed again in a LATER window. */
    PERSISTENT_BEHAVIOR: 'persistent_behavior',
    /** Behaviour that survived a decay evaluation. */
    PERSISTENT_RISK: 'persistent_risk',
    /** Unresolvable inconsistency between stanza and WebMessageInfo. */
    PROTOCOL_INCONSISTENCY: 'protocol_inconsistency',
    /** Narrative-only: some structural oddity was seen (weight 0). */
    STRUCTURAL_ANOMALY: 'structural_anomaly'
});

/**
 * Evidence catalog: the single source of truth for weights.
 *
 * `weight` semantics — a message's total score is the sum of distinct active
 * evidence weights, capped per category. Bands are calibrated in
 * ConfidenceEngine against the test corpus, not guessed:
 *
 *   - WEAK     1-2   observed alone, never actionable
 *   - MEDIUM   3-5   needs corroboration
 *   - STRONG   6-9   strong on its own, still needs another category
 *   - CRITICAL 10+   never emitted alone; always paired with corroboration
 *
 * `usable: false` marks a signal that is documented as NOT reliable enough for
 * scoring at all (it is narrative-only, weight 0, for the report).
 */
export const EVIDENCE_CATALOG = Object.freeze({
    [EVIDENCE_TYPE.REGULAR_INTERVALS]: {
        category: EVIDENCE_CATEGORY.BEHAVIOR,
        level: EVIDENCE_LEVEL.STRONG,
        weight: 6,
        usable: true,
        explanation: 'Inter-message intervals are near-constant.'
    },
    [EVIDENCE_TYPE.PAYLOAD_SIMILARITY]: {
        category: EVIDENCE_CATEGORY.BEHAVIOR,
        level: EVIDENCE_LEVEL.MEDIUM,
        weight: 4,
        usable: true,
        explanation: 'Repeated payload shape across many messages.'
    },
    [EVIDENCE_TYPE.REPEATING_SEQUENCE]: {
        category: EVIDENCE_CATEGORY.BEHAVIOR,
        level: EVIDENCE_LEVEL.MEDIUM,
        weight: 4,
        usable: true,
        explanation: 'Repeating cycle of message types.'
    },
    [EVIDENCE_TYPE.UNIFORM_LENGTH]: {
        category: EVIDENCE_CATEGORY.BEHAVIOR,
        level: EVIDENCE_LEVEL.WEAK,
        weight: 2,
        usable: true,
        explanation: 'Message lengths are near-identical.'
    },
    [EVIDENCE_TYPE.PERSISTENT_BEHAVIOR]: {
        category: EVIDENCE_CATEGORY.PERSISTENCE,
        level: EVIDENCE_LEVEL.MEDIUM,
        weight: 4,
        usable: true,
        explanation: 'Suspicious behaviour repeated in a later window.'
    },
    [EVIDENCE_TYPE.PERSISTENT_RISK]: {
        category: EVIDENCE_CATEGORY.PERSISTENCE,
        level: EVIDENCE_LEVEL.STRONG,
        weight: 6,
        usable: true,
        explanation: 'Elevated risk survived decay and re-evaluation.'
    },
    [EVIDENCE_TYPE.PROTOCOL_INCONSISTENCY]: {
        category: EVIDENCE_CATEGORY.PROTOCOL,
        level: EVIDENCE_LEVEL.MEDIUM,
        weight: 4,
        usable: true,
        explanation: 'Stanza and WebMessageInfo disagree on a field.'
    },
    [EVIDENCE_TYPE.STRUCTURAL_ANOMALY]: {
        category: EVIDENCE_CATEGORY.STANZA,
        level: EVIDENCE_LEVEL.WEAK,
        weight: 0,
        usable: false,
        explanation: 'Unfamiliar structure — reported, never scored.'
    }
});

/** Safety modes. The default is the safest one that still gathers data. */
export const ANTI_BOT_MODE = Object.freeze({
    /** Record evidence only, no state escalation. */
    LOG: 'log',
    /** Analyse and surface evidence; escalates state but never punishes. */
    OBSERVE: 'observe',
    /** Marks the participant as quarantined. Still no action. */
    QUARANTINE: 'quarantine',
    /** Allows the caller to act, only after CONFIRMED. */
    ACTIVE: 'active'
});

/** Default thresholds (score bands). Calibrated against the test corpus.
 *
 * The bands are display/scheduling hints. Only `confirmed` can lead to an
 * action, and reaching it additionally requires multiple categories and
 * multiple windows — see ConfidenceEngine. Because of that, the intermediate
 * bands can be generous without risk.
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
    observing: 10,
    suspicious: 20,
    highRisk: 38,
    confirmed: 65,
    /** Distinct evidence categories required before CONFIRMED is allowed. */
    minCategoriesForConfirm: 3,
    /** Distinct windows a suspicious finding must recur in before CONFIRMED. */
    minWindowsForConfirm: 2
});

/** Config knobs for the engine. Everything is optional. */
export const DEFAULT_CONFIG = Object.freeze({
    mode: ANTI_BOT_MODE.OBSERVE,
    thresholds: DEFAULT_THRESHOLDS,
    /** Rolling analysis window, in ms. */
    windowMs: 60 * 1000,
    /** Half-life of the decay, in ms. Set <=0 to disable decay. */
    decayHalfLifeMs: 10 * 60 * 1000,
    /** Hard cap of tracked participants per chat. */
    maxParticipants: 512,
    /** Hard cap of samples kept per participant. */
    maxSamples: 60,
    /** Ignore participants with fewer samples than this (never judge a newcomer). */
    minSamplesForAnalysis: 8
});

/**
 * Severity ordering for any UI that lists evidence.
 * Kept as a plain object (not a Map) so it survives JSON round-trips.
 */
export const EVIDENCE_ORDER = Object.freeze({
    [EVIDENCE_LEVEL.WEAK]: 1,
    [EVIDENCE_LEVEL.MEDIUM]: 2,
    [EVIDENCE_LEVEL.STRONG]: 3,
    [EVIDENCE_LEVEL.CRITICAL]: 4
});

/** Resolves a config with defaults applied, validating every field. */
export const resolveConfig = (config = {}) => {
    const thresholds = { ...DEFAULT_THRESHOLDS, ...(config.thresholds || {}) };
    return {
        mode: Object.values(ANTI_BOT_MODE).includes(config.mode) ? config.mode : DEFAULT_CONFIG.mode,
        thresholds,
        windowMs: Number.isFinite(config.windowMs) && config.windowMs > 0
            ? config.windowMs
            : DEFAULT_CONFIG.windowMs,
        decayHalfLifeMs: Number.isFinite(config.decayHalfLifeMs)
            ? config.decayHalfLifeMs
            : DEFAULT_CONFIG.decayHalfLifeMs,
        maxParticipants: Number.isFinite(config.maxParticipants) && config.maxParticipants > 0
            ? config.maxParticipants
            : DEFAULT_CONFIG.maxParticipants,
        maxSamples: Number.isFinite(config.maxSamples) && config.maxSamples > 0
            ? config.maxSamples
            : DEFAULT_CONFIG.maxSamples,
        minSamplesForAnalysis: Number.isFinite(config.minSamplesForAnalysis) && config.minSamplesForAnalysis > 0
            ? config.minSamplesForAnalysis
            : DEFAULT_CONFIG.minSamplesForAnalysis
    };
};

/** Band for a score, using the resolved thresholds. */
export const bandForScore = (score, thresholds = DEFAULT_THRESHOLDS) => {
    const s = Number(score) || 0;
    if (s >= thresholds.confirmed) return ANTI_BOT_STATUS.CONFIRMED;
    if (s >= thresholds.highRisk) return ANTI_BOT_STATUS.HIGH_RISK;
    if (s >= thresholds.suspicious) return ANTI_BOT_STATUS.SUSPICIOUS;
    if (s >= thresholds.observing) return ANTI_BOT_STATUS.OBSERVING;
    return ANTI_BOT_STATUS.NORMAL;
};
