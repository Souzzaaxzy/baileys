/**
 * BehaviorAnalyzer — temporal and structural behaviour of a participant.
 *
 * THE CENTRAL WARNING
 * -------------------
 * High message volume is NOT a bot signal. A lively human in a busy group
 * easily sends 40 messages in a minute with tight intervals. Every metric here
 * is therefore evaluated with an explicit guard for that case, and the results
 * are *evidence candidates* — the EvidenceEngine decides whether the combination
 * is meaningful, and the ConfidenceEngine requires corroboration from another
 * category before anything is confirmed.
 *
 * What actually separates machine pacing from a fast human, in the tests we ran:
 *
 *   - a machine clusters its intervals in a narrow band and, crucially, does it
 *     with LOW relative variance AND a high message count for the window;
 *   - a human is bursty: intervals swing from sub-second to tens of seconds,
 *     and their payloads differ each time;
 *   - a fast human writes *different* things; a bot repeats the same shape.
 *
 * So the two signals that carry real weight are `REGULAR_INTERVALS` **combined
 * with** `PAYLOAD_SIMILARITY` / `UNIFORM_LENGTH`. Regularity alone stays usable
 * but is capped, and it cannot confirm anything on its own.
 */

import { EVIDENCE_TYPE } from './AntiBotTypes.js';

/** Coefficient of variation below this is "machine regular" (0 = perfectly regular). */
export const DEFAULT_CV_THRESHOLD = 0.18;

/** Minimum intervals before variance is meaningful at all. */
export const DEFAULT_MIN_INTERVALS = 8;

/** Fraction of identical payload digests that counts as repetition. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.75;

/**
 * Coefficient of variation of the intervals of a sample list.
 * Returns null when there are too few intervals to judge — never a number
 * invented from two data points.
 */
export const intervalStats = (samples) => {
    const ts = samples.map((s) => s.ts).sort((a, b) => a - b);
    const intervals = [];
    for (let i = 1; i < ts.length; i++) intervals.push(ts[i] - ts[i - 1]);
    if (intervals.length < 2) return { count: intervals.length, mean: null, sd: null, cv: null };
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (mean <= 0) return { count: intervals.length, mean, sd: null, cv: null };
    const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
    const sd = Math.sqrt(variance);
    return { count: intervals.length, mean, sd, cv: sd / mean };
};

/** Fraction of the most common digest among the samples. */
export const payloadSimilarity = (samples) => {
    if (!samples.length) return { top: null, ratio: 0, distinct: 0 };
    const counts = new Map();
    for (const s of samples) counts.set(s.digest, (counts.get(s.digest) || 0) + 1);
    let top = null;
    let max = 0;
    for (const [digest, n] of counts) {
        if (n > max) { max = n; top = digest; }
    }
    return { top, ratio: max / samples.length, distinct: counts.size };
};

/** Fraction of messages whose text length equals the modal length. */
export const lengthUniformity = (samples) => {
    const withText = samples.filter((s) => s.textLength > 0);
    if (withText.length < 3) return { ratio: 0, modal: null, count: withText.length };
    const counts = new Map();
    for (const s of withText) counts.set(s.textLength, (counts.get(s.textLength) || 0) + 1);
    let modal = null;
    let max = 0;
    for (const [len, n] of counts) {
        if (n > max) { max = n; modal = len; }
    }
    return { ratio: max / withText.length, modal, count: withText.length };
};

/** Longest repeating period (in messages) of the kind sequence, or null.
 *
 * Requires at least TWO distinct kinds. A stream where every message is the same
 * kind trivially "repeats with period 1", but that is not a sequence — it is a
 * uniform stream, already covered by payload similarity. Reporting it as a
 * *sequence* would fire on any human who happens to send only text.
 */
export const repeatingSequence = (samples) => {
    const kinds = samples.map((s) => s.kind);
    if (kinds.length < 6) return null;
    if (new Set(kinds).size < 2) return null;
    for (let period = 1; period <= 4; period++) {
        let matches = 0;
        let compared = 0;
        for (let i = period; i < kinds.length; i++) {
            compared++;
            if (kinds[i] === kinds[i - period]) matches++;
        }
        if (compared > 0 && matches / compared >= 0.95) return period;
    }
    return null;
};

/**
 * Analyses a participant's samples.
 *
 * @param {Array<object>} samples
 * @param {object} [opts]
 * @param {number} [opts.cvThreshold]
 * @param {number} [opts.minIntervals]
 * @param {number} [opts.similarityThreshold]
 * @param {number} [opts.minSamples] below this, no conclusions at all
 * @returns {object} metrics plus a list of evidence candidates
 */
export const analyzeBehavior = (samples = [], opts = {}) => {
    const cvThreshold = Number.isFinite(opts.cvThreshold) ? opts.cvThreshold : DEFAULT_CV_THRESHOLD;
    const minIntervals = Number.isFinite(opts.minIntervals) ? opts.minIntervals : DEFAULT_MIN_INTERVALS;
    const similarityThreshold = Number.isFinite(opts.similarityThreshold)
        ? opts.similarityThreshold
        : DEFAULT_SIMILARITY_THRESHOLD;
    const minSamples = Number.isFinite(opts.minSamples) ? opts.minSamples : 8;

    const metrics = {
        sampleCount: samples.length,
        intervals: intervalStats(samples),
        similarity: payloadSimilarity(samples),
        uniformity: lengthUniformity(samples),
        sequence: null,
        messageRate: null
    };

    // A newcomer is never judged: not enough data means no opinion.
    if (samples.length < minSamples) {
        return { metrics, candidates: [], sufficient: false };
    }

    const span = samples.length > 1
        ? (Math.max(...samples.map((s) => s.ts)) - Math.min(...samples.map((s) => s.ts))) || 1
        : 1;
    metrics.messageRate = (samples.length / span) * 1000;
    metrics.sequence = repeatingSequence(samples);

    const candidates = [];

    // Regular intervals require BOTH enough intervals and low variance. A human
    // who fires off several messages quickly has a *low mean* but a HIGH cv,
    // because the gaps are uneven — which is exactly the case this rejects.
    const { count, mean, cv } = metrics.intervals;
    const enoughIntervals = count >= minIntervals;
    if (enoughIntervals && cv !== null && cv <= cvThreshold && mean !== null && mean <= 5000) {
        candidates.push({
            type: EVIDENCE_TYPE.REGULAR_INTERVALS,
            detail: { cv, meanIntervalMs: Math.round(mean), samples: count }
        });
    }

    // Repetition is only meaningful together with volume. A human saying "ok"
    // three times in a conversation is not a bot; forty times in a minute is
    // worth reporting as a candidate.
    if (metrics.similarity.ratio >= similarityThreshold && samples.length >= 12) {
        candidates.push({
            type: EVIDENCE_TYPE.PAYLOAD_SIMILARITY,
            detail: {
                ratio: Number(metrics.similarity.ratio.toFixed(3)),
                distinct: metrics.similarity.distinct,
                samples: samples.length
            }
        });
    }

    if (metrics.uniformity.ratio >= 0.85 && metrics.uniformity.count >= 10) {
        candidates.push({
            type: EVIDENCE_TYPE.UNIFORM_LENGTH,
            detail: { ratio: Number(metrics.uniformity.ratio.toFixed(3)), modalLength: metrics.uniformity.modal }
        });
    }

    if (metrics.sequence && samples.length >= 10) {
        candidates.push({
            type: EVIDENCE_TYPE.REPEATING_SEQUENCE,
            detail: { period: metrics.sequence, samples: samples.length }
        });
    }

    return { metrics, candidates, sufficient: true };
};
