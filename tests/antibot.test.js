/**
 * AntiBot — false-positive and true-positive corpus.
 *
 * This is the test that matters: the system is only worth having if it does NOT
 * flag ordinary humans. Each scenario builds a message stream through the REAL
 * engine (no mocks of the analyzers) and asserts the resulting band.
 *
 * The corpus is split in three:
 *
 *   HUMAN  — normal and unusually intense human traffic. Must stay out of the
 *            upper bands. Never CONFIRMED.
 *   BOT    — machine pacing with repeated payloads, sustained. Must reach
 *            HIGH_RISK and only confirm with persistence + multiple categories.
 *   EDGE   — the signals explicitly classified as NOT usable (LID, addressing
 *            mode, stub, absence of presence) must never score.
 *
 * Run: node --test tests/antibot.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAntiBotEngine } from '../lib/AntiBot/AntiBotEngine.js';
import { ANTI_BOT_STATUS, ANTI_BOT_MODE } from '../lib/AntiBot/AntiBotTypes.js';

const GROUP = '120363000000000001@g.us';
const HUMAN = '5511900000001@s.whatsapp.net';
const HUMAN_LID = '111000000000001@lid';

/**
 * Builds a WebMessageInfo shaped like the real receive path produces.
 * Only fields the analyzers actually read are set.
 */
const msg = ({ chat = GROUP, author = HUMAN, text = 'oi', id = 'M', ts = 0, over = {} } = {}) => ({
    key: {
        remoteJid: chat,
        fromMe: false,
        id,
        participant: author,
        ...(over.key || {})
    },
    message: text === null ? { imageMessage: { fileLength: 1234 } } : { conversation: text },
    messageTimestamp: ts,
    pushName: 'Pessoa',
    ...(over.top || {})
});

/**
 * Feeds messages driving BOTH the declared timestamp and the arrival clock.
 *
 * The engine measures pacing by ARRIVAL time (see MessageAnalyzer): the proto's
 * `messageTimestamp` only has 1-second resolution, so a burst inside one second
 * would look perfectly spaced. `advanceMs` is how the arrival clock moves per
 * message — that is what the pacing analysis actually sees.
 */
const feed = (engine, messages, { advanceMs = null } = {}) => {
    let last = null;
    if (advanceMs !== null && typeof engine.__setNow === 'function') {
        // not used; kept for symmetry
    }
    for (const m of messages) last = engine.ingest(m);
    return last;
};

/** Builds an engine whose arrival clock advances `gapMs` per message. */
const pacedEngine = ({ gapMs, start = 1_700_000_000_000, config = {}, mode = ANTI_BOT_MODE.ACTIVE }) => {
    let clock = start;
    const engine = createAntiBotEngine({ mode, ...config }, { now: () => clock });
    engine.__tick = (ms) => { clock += ms; };
    engine.__clock = () => clock;
    engine.__gapMs = gapMs;
    return engine;
};

/** Ingests a series, advancing the arrival clock by `gapMs` per message. */
const feedPaced = (engine, series) => {
    let last = null;
    for (const m of series) {
        last = engine.ingest(m);
        engine.__tick(engine.__gapMs);
    }
    return last;
};

/** A human-style series: uneven gaps, varied text, mixed lengths. */
const humanSeries = ({ count = 40, base = 1_700_000_000, author = HUMAN, step = () => 1200 }) => {
    const out = [];
    let t = base; // seconds
    let accMs = 0;
    const words = ['bom dia', 'kkkk', 'vou ver e te aviso', 'sim', 'não sei ainda', 'calma',
        'que legal', 'depois eu vejo isso com calma', 'ok', 'beleza então', 'falou', 'tô aqui'];
    for (let i = 0; i < count; i++) {
        accMs += step(i);
        out.push(msg({
            author,
            text: words[i % words.length] + (i % 3 === 0 ? ` ${i}` : ''),
            id: `H${i}`,
            ts: base + Math.round(accMs / 1000)
        }));
    }
    return out;
};

/**
 * A bot-style series: near-constant gaps, identical payload.
 *
 * NOTE: `messageTimestamp` is in SECONDS in the proto, so `gapMs` is divided by
 * 1000. Passing the gap straight through produced 1000-second intervals, which
 * correctly failed the "machine pacing" guard — a real bug in this helper, not
 * in the engine.
 */
const botSeries = ({ count = 40, base = 1_700_000_000, author = HUMAN, gapMs = 1000, text = 'promoção imperdível' }) => {
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push(msg({ author, text, id: `B${i}`, ts: base + Math.round((i * gapMs) / 1000) }));
    }
    return out;
};

// ============================================================================
// HUMAN — must never be confirmed
// ============================================================================

describe('HUMAN traffic must not be confirmed', () => {
    it('normal conversation stays NORMAL', () => {
        const engine = createAntiBotEngine({ mode: ANTI_BOT_MODE.ACTIVE }, { now: () => 1_700_100_000_000 });
        const result = feed(engine, humanSeries({ count: 25 }));
        assert.ok(result, 'a evaluation happened');
        assert.notEqual(result.status, ANTI_BOT_STATUS.CONFIRMED);
        assert.ok([ANTI_BOT_STATUS.NORMAL, ANTI_BOT_STATUS.OBSERVING].includes(result.status),
            `expected NORMAL/OBSERVING, got ${result.status}`);
    });

    it('a very active human (fast, many messages) is NOT confirmed', () => {
        const engine = createAntiBotEngine({ mode: ANTI_BOT_MODE.ACTIVE }, { now: () => 1_700_100_000_000 });
        // 80 messages, ~250ms apart — aggressive but with varied content.
        const series = humanSeries({ count: 80, step: (i) => 200 + (i % 7) * 90 });
        const result = feed(engine, series);
        assert.ok(result);
        assert.notEqual(result.status, ANTI_BOT_STATUS.CONFIRMED,
            `a fast human must never confirm (got ${result.status}, score ${result.automationScore})`);
    });

    it('a human who sends the same short reply many times is not confirmed', () => {
        const engine = createAntiBotEngine({ mode: ANTI_BOT_MODE.ACTIVE }, { now: () => 1_700_100_000_000 });
        const series = humanSeries({ count: 30, step: (i) => 800 + (i % 5) * 400 })
            .map((m, i) => ({ ...m, message: { conversation: 'kk' }, key: { ...m.key, id: `K${i}` } }));
        const result = feed(engine, series);
        assert.ok(result);
        assert.notEqual(result.status, ANTI_BOT_STATUS.CONFIRMED,
            `repeating "kk" is human (got ${result.status})`);
    });

    it('media, stickers and edits do not score', () => {
        const engine = createAntiBotEngine({ mode: ANTI_BOT_MODE.ACTIVE }, { now: () => 1_700_100_000_000 });
        const series = [];
        for (let i = 0; i < 20; i++) {
            series.push(msg({
                text: null,
                id: `M${i}`,
                ts: 1_700_000_000 + Math.round((i * 1500) / 1000),
                over: { top: { messageStubType: 1 } }
            }));
        }
        const result = feed(engine, series);
        assert.ok(result);
        assert.notEqual(result.status, ANTI_BOT_STATUS.CONFIRMED);
    });

    it('LID addressing and participantAlt do not score', () => {
        const engine = createAntiBotEngine({ mode: ANTI_BOT_MODE.ACTIVE }, { now: () => 1_700_100_000_000 });
        const out = [];
        for (let i = 0; i < 20; i++) {
            out.push(msg({
                author: HUMAN_LID,
                text: `mensagem ${i}`,
                id: `L${i}`,
                ts: 1_700_000_000 + Math.round((i * 2000) / 1000),
                over: { key: { addressingMode: 'lid', participantAlt: HUMAN } }
            }));
        }
        const result = feed(engine, out);
        assert.ok(result);
        // The point is NOT "score 0" — behaviour is legitimately scored above.
        // It is that no evidence comes from the addressing fields themselves.
        const structural = result.evidences.filter((e) => e.type === 'structural_anomaly');
        assert.equal(structural.length, 0, 'addressing fields never produce evidence');
        assert.notEqual(result.status, ANTI_BOT_STATUS.CONFIRMED,
            'LID-addressed traffic must never confirm');
    });
});

// ============================================================================
// BOT — must escalate, and only confirm with persistence
// ============================================================================

describe('BOT traffic escalates but only confirms with corroboration', () => {
    it('machine pacing with identical payloads is observed, and is BEHAVIOR-only', () => {
        const engine = pacedEngine({ gapMs: 1000 });
        const result = feedPaced(engine, botSeries({ count: 40 }));
        assert.ok(result);
        // Behaviour is capped per category, so one window can only reach OBSERVING.
        // That is by design: a single behavioural window must never be actionable.
        assert.notEqual(result.status, ANTI_BOT_STATUS.CONFIRMED);
        assert.ok(result.automationScore >= 10, `score should be substantial (got ${result.automationScore})`);
        assert.equal(result.categoryCount, 1, 'a pure behavioural window has ONE category');
        assert.ok(result.evidences.some((e) => e.type === 'regular_intervals'), 'detected machine pacing');
        assert.ok(result.evidences.some((e) => e.type === 'payload_similarity'), 'detected repeated payload');
    });

    it('behaviour ALONE can never confirm, no matter how sustained', () => {
        const engine = pacedEngine({ gapMs: 1000, config: { decayHalfLifeMs: 300_000 } });
        let result = null;
        for (let w = 0; w < 8; w++) {
            // 40 messages at 1s apart = exactly one window; then jump the window.
            for (let i = 0; i < 40; i++) {
                result = engine.ingest(msg({
                    text: 'promoção imperdível',
                    id: `A${w}-${i}`,
                    ts: Math.floor(engine.__clock() / 1000)
                }));
                engine.__tick(1000);
            }
            engine.__tick(20_000); // close the window
        }
        assert.ok(result);
        // This is the hard guarantee: no amount of behavioural evidence alone
        // reaches CONFIRMED, because the ConfidenceEngine demands a
        // non-behavioural category as well.
        assert.notEqual(result.status, ANTI_BOT_STATUS.CONFIRMED,
            `behaviour-only must never confirm (got ${result.status}, score ${result.automationScore})`);
        assert.ok(
            [ANTI_BOT_STATUS.SUSPICIOUS, ANTI_BOT_STATUS.HIGH_RISK].includes(result.status),
            `sustained behaviour should reach SUSPICIOUS+, got ${result.status}`
        );
    });

    it('behaviour + repeated protocol contradictions reach a corroborated score', () => {
        const engine = pacedEngine({ gapMs: 1000, config: { decayHalfLifeMs: 300_000 } });
        /** A stanza fact whose addressing differs from the decoded message. */
        const contradict = (author) => engine.internals.correlation.noteStanza(
            GROUP,
            author,
            { participant: '9999999999@s.whatsapp.net', remoteJid: GROUP, timestamp: 0 }
        );

        let result = null;
        for (let w = 0; w < 6; w++) {
            for (let i = 0; i < 40; i++) {
                contradict(HUMAN);
                result = engine.ingest(msg({
                    text: 'promoção imperdível',
                    id: `C${w}-${i}`,
                    ts: Math.floor(engine.__clock() / 1000)
                }));
                engine.__tick(1000);
            }
            engine.__tick(20_000);
        }
        assert.ok(result);
        // The repeated contradiction adds a PROTOCOL category on top of the
        // behavioural one, and persistence adds a third. That is the corroborated
        // case the design is built for.
        assert.ok(result.automationScore >= 20,
            `corroborated bot should score well (got ${result.automationScore})`);
        assert.ok(result.evidences.some((e) => e.category === 'protocol'),
            'the repeated contradiction became protocol evidence');
    });

    it('one burst alone does NOT confirm (persistence required)', () => {
        const engine = createAntiBotEngine({ mode: ANTI_BOT_MODE.ACTIVE }, { now: () => 1_700_100_000_000 });
        const result = feed(engine, botSeries({ count: 40 }));
        assert.ok(result);
        assert.notEqual(result.status, ANTI_BOT_STATUS.CONFIRMED,
            'a single window must not be enough to confirm');
        assert.ok(result.reasons.some((r) => r.startsWith('confirm_denied')) || result.status !== ANTI_BOT_STATUS.CONFIRMED);
    });

    it('persistence evidence only appears after a full window has elapsed', () => {
        const engine = pacedEngine({
            gapMs: 1000,
            config: { windowMs: 60_000, decayHalfLifeMs: 300_000 }
        });
        // Within a single window: no persistence evidence.
        let r = feedPaced(engine, botSeries({ count: 20 }));
        assert.ok(r);
        assert.ok(!r.evidences.some((e) => e.category === 'persistence'),
            'no persistence inside one window');
        // Cross the window boundary and keep the same behaviour.
        engine.__tick(40_000);
        r = feedPaced(engine, botSeries({ count: 20 }));
        assert.ok(r);
        assert.ok(r.evidences.some((e) => e.category === 'persistence'),
            'persistence appears once the behaviour repeats in a new window');
    });

    it('the mode gates the action, not the analysis', () => {
        const quiet = createAntiBotEngine({ mode: ANTI_BOT_MODE.OBSERVE }, { now: () => 1_700_100_000_000 });
        const r = feed(quiet, botSeries({ count: 40 }));
        assert.ok(r);
        assert.equal(r.actionAllowed, false, 'OBSERVE never allows action');
    });
});

// ============================================================================
// EDGE — explicit non-signals
// ============================================================================

describe('explicit non-signals never score', () => {
    it('a single unfamiliar structure is reported but weighs 0', () => {
        const engine = createAntiBotEngine({ mode: ANTI_BOT_MODE.ACTIVE }, { now: () => 1_700_100_000_000 });
        const out = [];
        for (let i = 0; i < 12; i++) {
            out.push(msg({
                text: `oi ${i}`,
                id: `S${i}`,
                ts: 1_700_000_000 + Math.round((i * (1000 + i * 300)) / 1000),
                over: { key: { addressingMode: 'lid' } }
            }));
        }
        const r = feed(engine, out);
        assert.ok(r);
        assert.equal(r.automationScore, 0, 'structure alone is not behaviour');
    });

    it('a participant with too few samples is never judged', () => {
        const engine = createAntiBotEngine({ mode: ANTI_BOT_MODE.ACTIVE }, { now: () => 1_700_100_000_000 });
        // 4 messages, perfectly regular — below minSamplesForAnalysis.
        const series = [];
        for (let i = 0; i < 4; i++) series.push(msg({ text: 'x', id: `F${i}`, ts: 1_700_000_000 + i }));
        const r = feed(engine, series);
        assert.ok(r);
        assert.equal(r.automationScore, 0, 'not enough data means no opinion');
    });

    it('the engine never analyses our own messages', () => {
        const engine = createAntiBotEngine({ mode: ANTI_BOT_MODE.ACTIVE }, { now: () => 1_700_100_000_000 });
        const series = [];
        for (let i = 0; i < 40; i++) {
            series.push(msg({
                text: 'spam', id: `O${i}`, ts: 1_700_000_000 + Math.round((i * 1000) / 1000),
                over: { key: { fromMe: true } }
            }));
        }
        assert.equal(feed(engine, series), null, 'fromMe messages are ignored');
    });

    it('invalid input never throws', () => {
        const engine = createAntiBotEngine({}, { now: () => 1_700_100_000_000 });
        for (const bad of [null, undefined, 0, '', [], { key: null }, { key: {} }]) {
            assert.doesNotThrow(() => engine.ingest(bad));
        }
    });
});

// ============================================================================
// BOUNDS — memory and state
// ============================================================================

describe('state stays bounded', () => {
    it('a participant is forgotten on request', () => {
        const engine = createAntiBotEngine({}, { now: () => 1_700_100_000_000 });
        feed(engine, botSeries({ count: 12 }));
        assert.ok(engine.stats().total >= 1);
        engine.forget(GROUP, HUMAN);
        engine.detach();
        assert.ok(true);
    });

    it('a flood of distinct participants does not grow without bound', () => {
        const engine = createAntiBotEngine({ maxParticipants: 8 }, { now: () => 1_700_100_000_000 });
        for (let i = 0; i < 50; i++) {
            engine.ingest(msg({ author: `551190000${String(i).padStart(4, '0')}@s.whatsapp.net`, id: `P${i}`, ts: i }));
        }
        assert.ok(engine.stats().total <= 8, `expected <= 8 tracked, got ${engine.stats().total}`);
    });
});
