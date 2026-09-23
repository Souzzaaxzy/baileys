/**
 * FingerprintEngine — the evidence input a participant produces each window.
 *
 * A fingerprint is a *summary of behaviour*, not an identity. It contains no
 * message content and no stable per-device identifier, so it cannot be used to
 * single out a person across chats, and it is discarded with the participant
 * state.
 *
 * The multi-signal requirement lives downstream (ConfidenceEngine), but the
 * requirement is prepared here: the fingerprint explicitly reports which
 * evidence **categories** are present, so a caller can never accidentally treat
 * a single-category fingerprint as confirmation.
 */

import { EVIDENCE_CATALOG, EVIDENCE_CATEGORY } from './AntiBotTypes.js';
import { analyzeBehavior } from './BehaviorAnalyzer.js';
import { payloadSimilarity, intervalStats, lengthUniformity } from './BehaviorAnalyzer.js';

/**
 * Builds the fingerprint of one participant's current window.
 *
 * @param {object} state participant state (samples + evidence)
 * @param {object} [opts]
 * @param {number} [opts.minSamples]
 * @param {number} [opts.windowStart] exact ms timestamp the current window began
 * @param {number} [opts.windowMs]    fallback: window length, used if no start
 * @param {Function} [opts.now]
 */
export const buildFingerprint = (state, opts = {}) => {
    const all = Array.isArray(state?.samples) ? state.samples : [];
    // Analyse the CURRENT window only. Mixing samples across windows would put
    // the gap between two windows into the interval distribution, which inflates
    // the variance and hides real machine pacing (found by the corpus test).
    //
    // The cut is by the window's exact START, not by `now - windowMs`: the latter
    // is fuzzy at the boundary and drags in the idle gap sample, which was enough
    // to hide the pacing.
    const nowFn = typeof opts.now === 'function' ? opts.now : Date.now;
    let samples = all;
    const start = Number.isFinite(opts.windowStart) ? opts.windowStart : null;
    if (start !== null && all.length) {
        const windowed = all.filter((s) => s.ts >= start);
        if (windowed.length >= 2) samples = windowed;
    } else if (Number.isFinite(opts.windowMs) && opts.windowMs > 0 && all.length) {
        const cutoff = nowFn() - opts.windowMs;
        const windowed = all.filter((s) => s.ts > cutoff);
        if (windowed.length >= 2) samples = windowed;
    }
    const { metrics, candidates, sufficient } = analyzeBehavior(samples, opts);

    const evidenceTypes = (state?.evidence || []).map((e) => e.type);
    const categories = new Set();
    for (const type of evidenceTypes) {
        const cat = EVIDENCE_CATALOG[type]?.category;
        if (cat) categories.add(cat);
    }
    // Behavioural candidates count as BEHAVIOR even before EvidenceEngine weighs
    // them, so "how many independent classes do we have" is honest.
    if (candidates.length) categories.add(EVIDENCE_CATEGORY.BEHAVIOR);

    const sim = payloadSimilarity(samples);
    const iv = intervalStats(samples);
    const uni = lengthUniformity(samples);

    // Normalised characteristics, 0..1, for logs and for the bot UI. These are
    // the *inputs*; they are deliberately not the score.
    return {
        sampleCount: samples.length,
        sufficient,
        messageRate: metrics.messageRate,
        intervalVariance: iv.cv,
        meanIntervalMs: iv.mean === null ? null : Math.round(iv.mean),
        payloadSimilarity: sim.ratio,
        distinctPayloads: sim.distinct,
        lengthUniformity: uni.ratio,
        repeatingPeriod: metrics.sequence,
        evidenceTypes,
        categories: Array.from(categories),
        categoryCount: categories.size,
        candidates
    };
};

/**
 * A short, log-safe rendering of the fingerprint. Numbers are clipped so a log
 * line cannot become a data dump. No content, ever.
 */
export const describeFingerprint = (fp) => {
    if (!fp) return 'n/a';
    const fmt = (v, digits = 2) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(digits));
    return [
        `n=${fp.sampleCount}`,
        `rate=${fmt(fp.messageRate)}/s`,
        `cv=${fmt(fp.intervalVariance)}`,
        `sim=${fmt(fp.payloadSimilarity)}`,
        `uni=${fmt(fp.lengthUniformity)}`,
        `cats=${fp.categoryCount}`
    ].join(' ');
};
