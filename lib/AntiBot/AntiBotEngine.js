/**
 * AntiBotEngine — orchestration of the AntiBot core.
 *
 * FLOW
 * ----
 *   message ─▶ buildSample ─▶ ParticipantState
 *                                   │
 *   evaluate() ─────────────────────┼─▶ BehaviorAnalyzer ─┐
 *                                   └─▶ correlate         ├─▶ EvidenceEngine
 *                                                        ─▶ ConfidenceEngine
 *                                                        ─▶ RiskDecay
 *                                                        ─▶ AntiBotResult
 *
 * The engine is *passive by design*: it never sends, never removes anyone and
 * never touches the connection. It returns a result; the bot decides.
 *
 * The engine is also pure enough to unit-test: it takes an injectable clock and
 * never performs I/O. The only optional I/O is the logger passed in `opts`.
 */

import {
    ANTI_BOT_MODE,
    ANTI_BOT_STATUS,
    DEFAULT_CONFIG,
    EVIDENCE_CATEGORY,
    EVIDENCE_TYPE,
    resolveConfig
} from './AntiBotTypes.js';
import { createParticipantState } from './ParticipantState.js';
import { buildSample } from './MessageAnalyzer.js';
import { analyzeProto, findInconsistencies, isUndecryptableStub } from './ProtoAnalyzer.js';
import { buildFingerprint, describeFingerprint } from './FingerprintEngine.js';
import { buildEvidence, scoreByCategory, sumEvidence } from './EvidenceEngine.js';
import { evaluateConfidence, modeAllowsAction } from './ConfidenceEngine.js';
import { combineScores, countPriorSuspiciousWindows, persistenceWeightFor, shouldForget } from './RiskDecay.js';
import { createCorrelationEngine } from './EventCorrelationEngine.js';
import { observeStanzas } from './StanzaObserver.js';

/** Extracts only the identifiers AntiBot needs from a WebMessageInfo. */
const idsOf = (info) => {
    const key = info?.key || {};
    const chat = key.remoteJid || null;
    // The participant is the author in a group; in a 1:1 it is the chat itself.
    const participant = key.participant || key.participantAlt || (key.fromMe ? null : key.remoteJid);
    return { chat, participant: participant || null, fromMe: Boolean(key.fromMe) };
};

/**
 * Creates an AntiBot engine instance.
 *
 * @param {object} [config] see resolveConfig / DEFAULT_CONFIG
 * @param {object} [opts]
 * @param {object} [opts.logger] pino-like logger (optional)
 * @param {Function} [opts.now]  injectable clock
 */
export const createAntiBotEngine = (config = {}, opts = {}) => {
    const cfg = resolveConfig({ ...DEFAULT_CONFIG, ...config });
    const logger = opts.logger;
    const now = typeof opts.now === 'function' ? opts.now : Date.now;

    const state = createParticipantState({
        maxParticipants: cfg.maxParticipants,
        maxSamples: cfg.maxSamples,
        now
    });
    const correlation = createCorrelationEngine({ now });

    /** The observer handle, once attached to a socket. */
    let observer = null;
    /** chat\0participant -> timestamp of the last evaluation (for decay). */
    const lastEvaluated = new Map();
    /**
     * chat\0participant -> timestamp the current analysis WINDOW started.
     *
     * A window is a span of TIME (`config.windowMs`), not a number of messages.
     * Recording a window per message would make a burst of 40 messages look like
     * 40 windows of persistence — inflating exactly the evidence that is
     * supposed to prove the behaviour is sustained. This was a real false-positive
     * source caught by the corpus test.
     */
    const windowStartedAt = new Map();
    /** chat\0participant -> last evaluation result of the OPEN window. */
    const lastResult = new Map();

    const log = (level, payload, msg) => {
        if (logger?.[level]) logger[level](payload, msg);
    };

    const stateKey = (chat, participant) => `${chat}\u0000${participant}`;

    /**
     * Feeds one received message into the engine.
     * Returns the (possibly partial) evaluation for that participant, or null
     * when the message carries nothing to analyse.
     */
    const ingest = (info) => {
        if (!info || typeof info !== 'object') return null;
        const { chat, participant, fromMe } = idsOf(info);
        if (!chat || !participant) return null;
        // Our own messages are not analysed: the engine watches other people.
        if (fromMe) return null;
        // An undecryptable stub has no behaviour to measure.
        if (isUndecryptableStub(info)) return null;

        const protoFacts = analyzeProto(info);
        const sample = buildSample(info, { now });
        if (!sample) return null;

        // Correlation is attempted BEFORE the sample is added, so a stanza fact
        // waiting for this author is consumed by this message. (The pending
        // record is keyed by chat+author, not by message id, and is one entry
        // deep — see EventCorrelationEngine for the rationale.)
        const { promoted } = correlation.correlate(chat, participant, protoFacts, findInconsistencies);

        state.addSample(chat, participant, sample);

        if (promoted.length) {
            const pState = state.get(chat, participant);
            state.setEvidence(chat, participant, [
                ...(pState?.evidence || []),
                ...promoted.map((p) => ({
                    type: EVIDENCE_TYPE.PROTOCOL_INCONSISTENCY,
                    detail: { field: p.field, count: p.count }
                }))
            ]);
        }

        return evaluate(chat, participant);
    };

    /**
     * Runs a full evaluation for one participant and records the window.
     * This is the only function that can produce a CONFIRMED result.
     */
    const evaluate = (chat, participant) => {
        const pState = state.get(chat, participant);
        if (!pState) return null;

        const fp = buildFingerprint(pState, {
            minSamples: cfg.minSamplesForAnalysis,
            windowMs: cfg.windowMs,
            windowStart: windowStartedAt.get(stateKey(chat, participant)),
            now
        });
        const candidates = fp.candidates || [];

        // Evidence already accumulated (e.g. promoted correlations) is merged,
        // then rebuilt so stale entries expire with the window.
        const carried = pState.evidence || [];
        const evidences = buildEvidence(candidates, {
            now,
            extra: carried.filter((e) => e.type === EVIDENCE_TYPE.PROTOCOL_INCONSISTENCY)
        });
        state.setEvidence(chat, participant, evidences);

        const priorWindows = countPriorSuspiciousWindows(pState.windows, cfg.thresholds.observing);
        const lastScore = Number(pState.score) || 0;

        // Persistence evidence is computed from the *prior* windows before the
        // current score is finalised, so the tiers reflect sustained behaviour.
        const persistence = persistenceWeightFor(priorWindows);
        if (persistence) {
            evidences.push(...buildEvidence([{
                type: EVIDENCE_TYPE[persistence.type] || persistence.type,
                source: 'RiskDecay',
                detail: { priorWindows }
            }], { now }).filter((e) => !evidences.some((x) => x.type === e.type)));
            // Persistence weight is a tier, not a constant, so override the
            // catalog weight with the computed one.
            for (const e of evidences) {
                if (e.source === 'RiskDecay') e.weight = persistence.weight;
            }
            state.setEvidence(chat, participant, evidences);
        }

        const scored = scoreByCategory(evidences);
        const raw = scored.perCategory[EVIDENCE_CATEGORY.BEHAVIOR]
            + scored.perCategory[EVIDENCE_CATEGORY.PROTOCOL]
            + scored.perCategory[EVIDENCE_CATEGORY.STANZA]
            + scored.perCategory[EVIDENCE_CATEGORY.PERSISTENCE];

        const key = stateKey(chat, participant);
        const prevTs = lastEvaluated.get(key);
        const elapsedMs = prevTs === undefined ? 0 : Math.max(0, now() - prevTs);

        const score = combineScores({
            carried: lastScore,
            fresh: raw,
            elapsedMs,
            halfLifeMs: cfg.decayHalfLifeMs
        });

        const finalScores = scoreByCategory(evidences);
        const confidence = evaluateConfidence({
            behaviorScore: finalScores.perCategory[EVIDENCE_CATEGORY.BEHAVIOR],
            protocolScore: finalScores.perCategory[EVIDENCE_CATEGORY.PROTOCOL],
            stanzaScore: finalScores.perCategory[EVIDENCE_CATEGORY.STANZA],
            persistenceScore: finalScores.perCategory[EVIDENCE_CATEGORY.PERSISTENCE],
            priorSuspiciousWindows: priorWindows,
            thresholds: cfg.thresholds
        });

        pState.score = score;
        pState.band = confidence.band;
        lastEvaluated.set(key, now());

        // In LOG mode we never escalate state, only report.
        const effectiveBand = cfg.mode === ANTI_BOT_MODE.LOG ? ANTI_BOT_STATUS.NORMAL : confidence.band;

        const result = {
            candidate: participant,
            groupJid: chat,
            status: effectiveBand,
            automationScore: Math.round(confidence.automationScore),
            protocolConfidence: Math.round(confidence.protocolConfidence),
            behaviorConfidence: Math.round(confidence.behaviorConfidence),
            confidence: confidence.confirmed ? 1 : Number((confidence.score / 100).toFixed(2)),
            evidences,
            fingerprint: fp,
            fingerprintSummary: describeFingerprint(fp),
            firstSeen: new Date(pState.firstSeen).toISOString(),
            lastSeen: new Date(pState.lastSeen).toISOString(),
            categoryCount: finalScores.distinctCategories,
            reasons: confidence.reasons,
            actionAllowed: modeAllowsAction(cfg.mode) && confidence.confirmed
        };

        // One window entry per `windowMs`, never one per message, and recorded
        // when the window CLOSES — recording at open time stored a partial score
        // and made the persistence tier lag by a full window (corpus-test bug).
        const wKey = stateKey(chat, participant);
        const wStart = windowStartedAt.get(wKey);
        const isNewWindow = wStart === undefined || (now() - wStart) >= cfg.windowMs;
        if (isNewWindow) {
            if (wStart !== undefined) {
                // Close the previous window with the score IT finished on — the
                // score of the previous evaluation, not of the one starting now.
                // Recording the current score made the persistence tier lag.
                const prev = lastResult.get(wKey);
                state.recordWindow(chat, participant, {
                    ts: wStart,
                    score: Number(prev?.automationScore) || 0,
                    band: prev?.status || effectiveBand
                });
            }
            windowStartedAt.set(wKey, now());
        }
        lastResult.set(wKey, result);

        if (result.status !== ANTI_BOT_STATUS.NORMAL) {
            log('debug', {
                group: chat,
                participant,
                status: result.status,
                automation: result.automationScore,
                protocol: result.protocolConfidence,
                behavior: result.behaviorConfidence,
                fp: result.fingerprintSummary
            }, 'antibot evaluation');
        }

        return result;
    };

    return {
        /** The resolved configuration (read-only copy). */
        config: { ...cfg },

        /** Feeds a decoded message. */
        ingest,

        /** Re-evaluates a participant on demand. */
        evaluate,

        /** All participants currently above NORMAL in a chat. */
        listChat(chat) {
            const out = [];
            for (const s of state.list(chat)) {
                if (s.band && s.band !== ANTI_BOT_STATUS.NORMAL) {
                    out.push({
                        participant: s.id,
                        status: s.band,
                        score: Math.round(s.score),
                        samples: s.samples.length,
                        firstSeen: new Date(s.firstSeen).toISOString(),
                        lastSeen: new Date(s.lastSeen).toISOString()
                    });
                }
            }
            return out.sort((a, b) => b.score - a.score);
        },

        /** Diagnostic counters for the bot UI. */
        stats(chat) {
            const all = chat ? state.list(chat) : [];
            const counts = { total: state.size() };
            for (const band of Object.values(ANTI_BOT_STATUS)) counts[band] = 0;
            for (const s of all) {
                if (counts[s.band] !== undefined) counts[s.band] += 1;
            }
            return {
                ...counts,
                correlation: correlation.stats(),
                observer: observer ? observer.stats() : { attached: false, events: [] }
            };
        },

        /** Forgets a participant (group exit). */
        forget(chat, participant) {
            correlation.forget(chat, participant);
            lastEvaluated.delete(stateKey(chat, participant));
            windowStartedAt.delete(stateKey(chat, participant));
            lastResult.delete(stateKey(chat, participant));
            return state.forget(chat, participant);
        },

        /**
         * Attaches the passive stanza observer to a socket and wires its facts
         * into the correlation engine. Additive: removes only its own listeners.
         */
        attach(sock) {
            if (observer) observer.unobserve();
            observer = observeStanzas(sock, {
                onMessageStanza(facts) {
                    const participant = facts.attrs.participant || facts.attrs.from;
                    const chat = facts.attrs.from;
                    if (chat && participant) {
                        correlation.noteStanza(chat, participant, {
                            remoteJid: chat,
                            participant,
                            addressingMode: facts.attrs.addressing_mode || null,
                            timestamp: Number(facts.attrs.t) || null
                        });
                    }
                },
                onError(err) {
                    log('debug', { err }, 'antibot observer error');
                }
            }, { logger });
            return observer;
        },

        /** Detaches the observer. */
        detach() {
            observer?.unobserve();
            observer = null;
        },

        /** Housekeeping: drops participants that have been quiet for too long. */
        prune(ttlMs = 30 * 60 * 1000) {
            const t = now();
            let removed = 0;
            for (const chat of new Set([...lastEvaluated.keys()].map((k) => k.split('\u0000')[0]))) {
                for (const s of state.list(chat)) {
                    if (shouldForget(s.lastSeen, t, ttlMs)) {
                        this.forget(chat, s.id);
                        removed += 1;
                    }
                }
            }
            return removed;
        },

        /** Exposed for tests and advanced callers. */
        internals: { state, correlation, sumEvidence }
    };
};

export default createAntiBotEngine;
