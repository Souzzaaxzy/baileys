/**
 * AntiBot core — public surface.
 *
 * Layered so each piece is usable and testable on its own:
 *
 *   AntiBotTypes          vocabulary: statuses, categories, weights, thresholds
 *   ParticipantState      bounded per-participant state (samples, evidence, windows)
 *   MessageAnalyzer       WebMessageInfo -> content-free feature sample
 *   ProtoAnalyzer         decoded proto facts + stanza/message contradictions
 *   BehaviorAnalyzer      temporal + structural metrics (with human guards)
 *   FingerprintEngine     per-window behaviour fingerprint
 *   EvidenceEngine        candidates -> weighted evidence (dedup + per-category cap)
 *   EventCorrelationEngine stanza <-> message join
 *   ConfidenceEngine      the ONLY place that can say CONFIRMED
 *   RiskDecay             half-life decay + persistence counting
 *   StanzaObserver        passive CB: listener attachment
 *   AntiBotEngine         orchestration
 *
 * See README-ANTIBOT in this directory for the design rationale, the reliability
 * classification of every signal, and the false-positive guarantees.
 */

export * from './AntiBotTypes.js';
export * from './ParticipantState.js';
export * from './MessageAnalyzer.js';
export * from './ProtoAnalyzer.js';
export * from './BehaviorAnalyzer.js';
export * from './FingerprintEngine.js';
export * from './EvidenceEngine.js';
export * from './EventCorrelationEngine.js';
export * from './ConfidenceEngine.js';
export * from './RiskDecay.js';
export * from './StanzaObserver.js';
export { createAntiBotEngine, createAntiBotEngine as default } from './AntiBotEngine.js';
