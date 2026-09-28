/**
 * P3/P4 — the call must not go silent (and must not drop).
 *
 * Two behaviours are under test, both about what happens when a file ENDS:
 *
 *  - `keepAlive` (P3): after the source plays out, keep emitting silence so the
 *    RTP stream stays continuous. A dead stream is what makes the relay treat
 *    the leg as idle and drop it — the "call that does not hold".
 *  - `loop` (P4): replay the file, so music keeps playing instead of stopping
 *    after one pass.
 *
 * Both are exercised against the real `AudioFeeder` with a real ffmpeg, feeding
 * a local generated audio file. If ffmpeg is missing the test fails loudly
 * rather than skipping silently.
 *
 * Usage: node tests/voip-audio-continuity.test.js
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const { AudioFeeder } = await import(new URL('../lib/Voip/audio-feeder.js', import.meta.url).href);

let passed = 0;
let failed = 0;
const check = (cond, msg) => {
    if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
    else { failed += 1; console.log(`  FAIL ${msg}`); }
};

// ── ffmpeg must exist: the feeder is useless without it ─────────────────────
const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
if (ff.error || ff.status !== 0) {
    console.log('  FAIL ffmpeg nao encontrado no PATH — o teste nao pode validar o feeder');
    console.log('\nRESULTADO: 0 ok, 1 falhas');
    process.exit(1);
}

// ── a short, real audio file (0.4 s of a tone) ──────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voip-audio-'));
const tone = path.join(tmp, 'tone.wav');
const gen = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4',
    '-ar', '16000', '-ac', '1', tone,
], { encoding: 'utf8' });
check(gen.status === 0 && fs.existsSync(tone), 'gerou um audio real de 0.4 s para testar');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Samples/rate mirrored from the WASM capture config (320 frames @ 16 kHz).
const RATE = 16000;
const CHANNELS = 1;
const FRAMES = 320;

const runFeeder = (source, options, runMs) => new Promise((resolve) => {
    const chunks = [];
    let nonSilent = 0;
    const feeder = new AudioFeeder(RATE, CHANNELS, FRAMES, (chunk) => {
        chunks.push(chunk);
        for (let i = 0; i < chunk.length; i += 1) {
            if (chunk[i] !== 0) { nonSilent += 1; break; }
        }
    }, source, null, options);
    feeder.start();
    setTimeout(() => {
        const stats = {
            chunks: chunks.length,
            nonSilentChunks: nonSilent,
            underflow: feeder.underflowChunks,
            loops: feeder.loops,
            feeder,
        };
        resolve(stats);
    }, runMs);
});

console.log('\nP3/P4 — continuidade de audio na call\n');

// ── P3: keepAlive keeps the stream alive after the file ends ────────────────
// The file is 0.4 s; we watch for 1.6 s. Without keepAlive the feeder stops at
// ~0.4 s and the last ~1.2 s produce nothing at all.
{
    const keep = await runFeeder(tone, { keepAlive: true }, 1600);
    keep.feeder.stop();
    check(keep.chunks > 40, `keepAlive: continuou emitindo chunks depois do fim do arquivo (${keep.chunks} chunks em 1.6 s)`);
    check(keep.nonSilentChunks > 0, 'keepAlive: tocou o audio real (chunks nao-silenciosos)');
    check(keep.chunks > keep.nonSilentChunks, `keepAlive: alternou audio real e silencio (${keep.nonSilentChunks} com audio, ${keep.chunks} no total)`);
}

// ── control: without keepAlive the stream goes dead ─────────────────────────
{
    const dead = await runFeeder(tone, { keepAlive: false }, 1600);
    dead.feeder.stop();
    check(
        dead.chunks < 40,
        `sem keepAlive: PARA quando o arquivo acaba (${dead.chunks} chunks) — e' a call que fica muda`,
    );
}

// ── P4: loop replays the file ───────────────────────────────────────────────
{
    const looped = await runFeeder(tone, { loop: true }, 1600);
    looped.feeder.stop();
    check(looped.loops >= 1, `loop: repetiu o arquivo (${looped.loops} loops em 1.6 s de um audio de 0.4 s)`);
    check(looped.nonSilentChunks > 40, `loop: audio real em varios chunks (${looped.nonSilentChunks})`);
}

// ── stop() is final: a loop must not resurrect the feeder ───────────────────
{
    const chunks = [];
    const feeder = new AudioFeeder(RATE, CHANNELS, FRAMES, (c) => chunks.push(c), tone, null, { loop: true });
    feeder.start();
    await sleep(600);
    feeder.stop();
    const atStop = chunks.length;
    await sleep(700);
    check(chunks.length === atStop, `stop() encerra de vez (nenhum chunk novo: ${atStop} -> ${chunks.length})`);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\nRESULTADO: ${passed} ok, ${failed} falhas`);
process.exit(failed === 0 ? 0 : 1);
