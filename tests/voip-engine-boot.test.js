/**
 * Boot the WASM VoIP engine for real and prove the worker prewarm no longer
 * hangs.
 *
 * Before the fix, `#loadWasmModuleToAllWorkers` used a bare `Promise.all` over
 * every prewarmed worker: one worker that never emits `cmd:"loaded"` (measured
 * on Linux in baileys-caller issue #1 — worker #17) hangs `initialize()`
 * forever. The symptom on the bot is "stuck on connecting".
 *
 * This test boots the engine with a short worker-load timeout and asserts that
 * `initialize()` RESOLVES (or fails loudly), instead of hanging. It also prints
 * the memory delta, because the OOM kill is the other half of the bug.
 *
 * Usage: node tests/voip-engine-boot.test.js
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Keep the pool tiny and the timeout short so the test is fast and cheap.
process.env.CALL_PTHREAD_POOL_SIZE = process.env.CALL_PTHREAD_POOL_SIZE || '4';
process.env.CALL_WORKER_LOAD_TIMEOUT_MS = process.env.CALL_WORKER_LOAD_TIMEOUT_MS || '12000';

const { WasmEngine } = await import(new URL('../lib/Voip/wasm-engine.js', import.meta.url).href);

let passed = 0;
let failed = 0;
const check = (cond, msg) => {
    if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
    else { failed += 1; console.log(`  FAIL ${msg}`); }
};

const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);

console.log('VoIP engine boot (worker prewarm tolerance)\n');
const before = rssMb();
console.log(`rss antes: ${before} MB`);

const logs = [];
const engine = new WasmEngine({
    resourcesPath: ROOT,
    enableLogs: false,
    callbacks: {
        onLog: (level, msg) => logs.push(`${level}: ${msg}`),
        onSignalingXmpp: () => {},
        onCallEvent: () => {},
        sendDataToRelay: () => 0,
        onAudioCaptureInit: () => {},
        onAudioCaptureStart: () => {},
        onAudioCaptureStop: () => {},
        onAudioPlaybackData: () => {},
        cryptoHkdf: () => new Uint8Array(32),
        hmacSha256: () => new Uint8Array(32),
    },
});

// The whole point: this must SETTLE. A hang here is the production bug.
const HARD_DEADLINE_MS = 90_000;
let outcome = 'pending';
const started = Date.now();

try {
    const result = await Promise.race([
        engine.initialize().then(() => 'initialized'),
        new Promise((res) => setTimeout(() => res('deadline'), HARD_DEADLINE_MS)),
    ]);
    outcome = result;
} catch (e) {
    outcome = `threw: ${e?.message || e}`;
}

const elapsedMs = Date.now() - started;
const after = rssMb();

console.log(`\ninitialize() -> ${outcome} em ${elapsedMs} ms`);
console.log(`rss depois: ${after} MB (delta ${after - before} MB)`);
if (logs.length) console.log(`logs: ${logs.slice(-6).join(' | ')}`);

check(outcome !== 'deadline', 'initialize() NAO travou (a correcao do prewarm funciona)');
check(elapsedMs < HARD_DEADLINE_MS, `initialize() terminou dentro do prazo (${elapsedMs} ms)`);

// A real init may legitimately fail in a sandbox with no network; that is a
// loud failure, not a hang. Either way the deadline check above is the gate.
if (outcome === 'initialized') {
    check(engine.isInitialized(), 'engine.isInitialized() e true apos sucesso');
}

try { engine.destroy(); } catch { /* ignore */ }

console.log(`\nRESULTADO: ${passed} ok, ${failed} falhas`);
process.exit(failed === 0 ? 0 : 1);
