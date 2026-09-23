/**
 * ConfidenceEngine — the only place allowed to decide "CONFIRMED".
 *
 * THE CONFIRMATION RULE (the whole point of the system)
 * -----------------------------------------------------
 * A participant is CONFIRMED only when ALL of the following hold:
 *
 *   1. the score is at or above the `confirmed` threshold;
 *   2. evidence comes from at least `minCategoriesForConfirm` DIFFERENT
 *      categories (behavior / protocol / stanza / persistence);
 *   3. the finding repeated across at least `minWindowsForConfirm` windows —
 *      a single burst never confirms;
 *   4. there is at least one NON-behavioural category present (protocol,
 *      stanza or persistence), so pure "talks a lot, very regularly" can never
 *      confirm by itself.
 *
 * Failing any of them downgrades rather than confirms. If the inputs are
 * ambiguous the engine returns the *lower* band — a false negative is the
 * desired failure mode.
 */

import {
    ANTI_BOT_STATUS,
    EVIDENCE_CATEGORY,
    DEFAULT_THRESHOLDS,
    bandForScore
} from './AntiBotTypes.js';

/** Categories that are not pure behaviour. */
const NON_BEHAVIOR = [
    EVIDENCE_CATEGORY.PROTOCOL,
    EVIDENCE_CATEGORY.STANZA,
    EVIDENCE_CATEGORY.PERSISTENCE
];

/**
 * Evaluates the confidence of a participant.
 *
 * @param {object} input
 * @param {number} input.behaviorScore
 * @param {number} input.protocolScore
 * @param {number} input.persistenceScore
 * @param {number} input.stanzaScore
 * @param {number} input.priorSuspiciousWindows
 * @param {object} [input.thresholds]
 * @returns {object} { score, band, automationScore, protocolConfidence,
 *                     behaviorConfidence, confirmed, reasons }
 */
export const evaluateConfidence = (input = {}) => {
    const thresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds || {}) };
    const behavior = Number(input.behaviorScore) || 0;
    const protocol = Number(input.protocolScore) || 0;
    const persistence = Number(input.persistenceScore) || 0;
    const stanza = Number(input.stanzaScore) || 0;

    const automationScore = behavior + protocol + persistence + stanza;
    const protocolConfidence = protocol + stanza;
    const behaviorConfidence = behavior;

    const categoriesPresent = [
        behavior > 0 ? EVIDENCE_CATEGORY.BEHAVIOR : null,
        protocol > 0 ? EVIDENCE_CATEGORY.PROTOCOL : null,
        stanza > 0 ? EVIDENCE_CATEGORY.STANZA : null,
        persistence > 0 ? EVIDENCE_CATEGORY.PERSISTENCE : null
    ].filter(Boolean);

    const reasons = [];
    let band = bandForScore(automationScore, thresholds);

    if (band === ANTI_BOT_STATUS.CONFIRMED) {
        // The band says confirmed; now check every extra requirement.
        if (categoriesPresent.length < thresholds.minCategoriesForConfirm) {
            band = ANTI_BOT_STATUS.HIGH_RISK;
            reasons.push(`confirm_denied_categories(${categoriesPresent.length}/${thresholds.minCategoriesForConfirm})`);
        }
        if (!categoriesPresent.some((c) => NON_BEHAVIOR.includes(c))) {
            band = ANTI_BOT_STATUS.HIGH_RISK;
            reasons.push('confirm_denied_behavior_only');
        }
        if ((Number(input.priorSuspiciousWindows) || 0) < thresholds.minWindowsForConfirm) {
            band = ANTI_BOT_STATUS.HIGH_RISK;
            reasons.push(`confirm_denied_persistence(${Number(input.priorSuspiciousWindows) || 0}/${thresholds.minWindowsForConfirm})`);
        }
    }

    return {
        score: automationScore,
        automationScore,
        protocolConfidence,
        behaviorConfidence,
        band,
        confirmed: band === ANTI_BOT_STATUS.CONFIRMED,
        categoriesPresent,
        categoryCount: categoriesPresent.length,
        reasons
    };
};

/**
 * Whether the current mode allows acting on a confirmed participant.
 * Only `active` does; every other mode stops at observation/quarantine.
 */
export const modeAllowsAction = (mode) => mode === 'active';
