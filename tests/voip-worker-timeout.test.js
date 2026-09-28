/**
 * The regression this fixes: a worker that never emits `cmd:"loaded"` must not
 * hang the whole engine.
 *
 * Force the worker-load timeout down to 1 ms so EVERY worker "times out". The
 * old code (`Promise.all` over the raw load promises) would then wait forever on
 * the one that never answers. The fixed code must still settle — degraded, with
 * zero ready workers, which the engine reports — instead of hanging.
 *
 * This is the offline reproduction of `baileys-caller` issue #1 (worker #17
 * never sends `loaded` on Linux), whose only visible symptom was the bot stuck
 * on "connecting".
 *
 * Usage: node tests/voip-worker-timeout.test.js
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

process.env.CALL_PTHREAD_POOL_SIZE = '3';
process.env.CALL_WORKER_LOAD_TIMEOUT_MS = '1'; // every worker "never answers"

const { WasmEngine } = await import(new URL('../lib/Voip/wasm-engine.js', import.meta.url).href);

let passed = 0;
let failed = 0;
const check = (cond, msg) => {
    if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
    else { failed += 1; console.log(`  FAIL ${msg}`); }
};

console.log('VoIP worker timeout tolerance (offline repro of the hang)\n');

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

const DEADLINE_MS = 60_000;
const started = Date.now();
let outcome = 'pending';
try {
    const result = await Promise.race([
        engine.initialize().then(() => 'settled'),
        new Promise((res) => setTimeout(() => res('HUNG'), DEADLINE_MS)),
    ]);
    outcome = result;
} catch (e) {
    outcome = `threw: ${e?.message || e}`;
}
const elapsedMs = Date.now() - started;

console.log(`initialize() -> ${outcome} em ${elapsedMs} ms`);
const warned = logs.filter((l) => l.includes('worker nao carregou'));
console.log(`avisos de worker descartado: ${warned.length}`);

check(outcome !== 'HUNG', 'initialize() NAO travou mesmo com TODOS os workers estourando');
check(elapsedMs < DEADLINE_MS, `settlou dentro do prazo (${elapsedMs} ms)`);
check(warned.length > 0, 'o descarte do worker foi REPORTADO (nao falha silenciosa)');

try { engine.destroy(); } catch { /* ignore */ }

console.log(`\nRESULTADO: ${passed} ok, ${failed} falhas`);
process.exit(failed === 0 ? 0 : 1);
