/**
 * EvidenceEngine — turns analysis candidates into weighted evidence.
 *
 * Two rules make this engine safe to reason about:
 *
 *  1. WEIGHTS COME FROM THE CATALOG, not from the caller. A candidate cannot
 *     invent its own weight; unknown types are dropped.
 *  2. EACH TYPE IS COUNTED ONCE PER EVALUATION. Flooding the analysers cannot
 *     inflate the score: ten "regular interval" candidates still weigh what one
 *     weighs. This is the concrete defence against a participant crafting
 *     messages to push their own score up or down.
 *
 * The engine also enforces a **per-category cap**, so stacking many weak
 * behavioural signals can never reach the confirmation band on its own.
 */

import { EVIDENCE_CATALOG, EVIDENCE_CATEGORY, DEFAULT_CONFIG } from './AntiBotTypes.js';

/**
 * Max total weight any single category may contribute.
 *
 * Calibrated against the bands: 34 sits above `suspicious` (30) so a pure
 * behavioural window can be genuinely suspicious, and below `highRisk` (50) so
 * it can never be actioned. Crossing the confirmation band always requires a
 * second category (persistence, or a repeated protocol contradiction).
 */
export const DEFAULT_CATEGORY_CAP = 34;

/**
 * Builds weighted evidence objects from candidate descriptors.
 *
 * @param {Array<{type:string, detail?:object, weight?:number, source?:string}>} candidates
 * @param {object} [opts]
 * @param {Function} [opts.now]
 * @param {number} [opts.categoryCap]
 * @param {Array} [opts.extra] additional candidates merged in (e.g. correlation)
 * @returns {Array<object>} evidence records
 */
export const buildEvidence = (candidates = [], opts = {}) => {
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const categoryCap = Number.isFinite(opts.categoryCap) ? opts.categoryCap : DEFAULT_CATEGORY_CAP;
    const all = [...candidates, ...(opts.extra || [])];

    const seenTypes = new Set();
    const perCategory = new Map();
    const out = [];

    for (const cand of all) {
        const type = cand?.type;
        const def = EVIDENCE_CATALOG[type];
        // Unknown evidence is ignored outright — never scored on a guess.
        if (!def) continue;
        // Deduplicate by type: repetition must not multiply the weight.
        if (seenTypes.has(type)) continue;
        seenTypes.add(type);

        // A signal explicitly marked unusable is kept for the report at weight 0.
        const rawWeight = def.usable === false ? 0 : def.weight;

        const usedSoFar = perCategory.get(def.category) || 0;
        const remaining = Math.max(0, categoryCap - usedSoFar);
        const weight = Math.min(rawWeight, remaining);
        perCategory.set(def.category, usedSoFar + weight);

        out.push({
            type,
            weight,
            category: def.category,
            level: def.level,
            timestamp: cand.timestamp ?? now(),
            source: cand.source || 'AntiBotEngine',
            confidence: def.usable === false ? 0 : 1,
            explanation: def.explanation,
            detail: cand.detail || null
        });
    }

    return out;
};

/** Sums evidence weights, optionally filtered by category. */
export const sumEvidence = (evidences = [], category = null) => {
    let total = 0;
    for (const ev of evidences) {
        if (category && ev.category !== category) continue;
        total += Number(ev.weight) || 0;
    }
    return total;
};

/**
 * Per-category scores plus the category count. The count is the input to the
 * multi-signal requirement.
 */
export const scoreByCategory = (evidences = []) => {
    const out = {
        [EVIDENCE_CATEGORY.BEHAVIOR]: 0,
        [EVIDENCE_CATEGORY.PROTOCOL]: 0,
        [EVIDENCE_CATEGORY.STANZA]: 0,
        [EVIDENCE_CATEGORY.PERSISTENCE]: 0
    };
    let categories = 0;
    for (const ev of evidences) {
        const w = Number(ev.weight) || 0;
        if (ev.category in out) out[ev.category] += w;
        if (w > 0) categories += 1;
    }
    // `categories` here counts *weighted evidence entries*; the distinct-class
    // count is derived from the map below.
    const distinct = Object.values(out).filter((v) => v > 0).length;
    return { perCategory: out, weightedEntries: categories, distinctCategories: distinct };
};

/** Convenience predicate used by the UI to decide what to show. */
export const hasUsableEvidence = (evidences = []) =>
    evidences.some((e) => (Number(e.weight) || 0) > 0);

/** Default knobs re-exported for callers configuring the engine. */
export { DEFAULT_CONFIG };
