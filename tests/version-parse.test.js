/**
 * The version fetcher must not silently DROP the voice build id.
 *
 * `fetchLatestBaileysVersion()` reads `const version = [...]` from the repo's
 * `Defaults/index.js`. It used to parse exactly three numbers, so a 5-part
 * desktop/UWP build id — the one that makes WhatsApp enable call VOICE — was
 * truncated to 3 parts for every caller doing
 * `version: (await fetchLatestBaileysVersion()).version`.
 *
 * The result was the worst kind of failure: the call still signalled and rang,
 * but no audio ever flowed.
 *
 * This test drives the REAL function against a stubbed HTTP response, so it
 * exercises the parsing (and the fallback) rather than a copy of the regex.
 *
 * Usage: node tests/version-parse.test.js
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const check = (cond, msg) => {
    if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
    else { failed += 1; console.log(`  FAIL ${msg}`); }
};

console.log('version parse — o build id de voz nao pode ser truncado\n');

const { fetchLatestBaileysVersion } = await import(new URL('../lib/Utils/generics.js', import.meta.url).href);
const { DEFAULT_CONNECTION_CONFIG } = await import(new URL('../lib/Defaults/index.js', import.meta.url).href);
const { isVoiceCapableConfig } = await import(new URL('../lib/Utils/browser-utils.js', import.meta.url).href);

// ── the default shipped with the package is voice-capable ───────────────────
const defVersion = DEFAULT_CONNECTION_CONFIG.version;
check(Array.isArray(defVersion) && defVersion.length === 5, `o default tem 5 partes (${JSON.stringify(defVersion)})`);
check(
    isVoiceCapableConfig({ browser: ['Windows', 'UWP', '10.0.22631'], version: defVersion }).ok === true,
    'o default + browser UWP passa no isVoiceCapableConfig',
);

// ── stub the network so the real parser runs on a 5-part line ───────────────
const realFetch = globalThis.fetch;
const stub = (body) => {
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => body,
    });
};

const line5 = (arr) => `line1\nline2\nline3\nline4\nconst version = ${arr}`;

// 5 parts must survive intact
stub(line5('[2, 3000, 1041589577, 261700, 0]'));
{
    const { version, isLatest } = await fetchLatestBaileysVersion();
    check(isLatest === true, 'parse bem-sucedido marca isLatest');
    check(version.length === 5, `NAO trunca o build id de 5 partes (recebido: ${JSON.stringify(version)})`);
    check(version[3] === 261700 && version[4] === 0, 'os dois ultimos campos (build id) sao preservados');
    check(
        isVoiceCapableConfig({ browser: ['Windows', 'UWP', '10.0.22631'], version }).ok === true,
        'o resultado do fetch continua voice-capable',
    );
}

// 3 parts still work (backwards compatible)
stub(line5('[2, 3000, 1041589577]'));
{
    const { version } = await fetchLatestBaileysVersion();
    check(version.length === 3 && version[2] === 1041589577, `3 partes continuam funcionando (${JSON.stringify(version)})`);
}

// 4 parts too
stub(line5('[2, 3000, 1041589577, 261700]'));
{
    const { version } = await fetchLatestBaileysVersion();
    check(version.length === 4, `4 partes preservadas (${JSON.stringify(version)})`);
}

// spaces / newline variants do not break it
stub(line5('[2,3000,1041589577,261700,0]'));
{
    const { version } = await fetchLatestBaileysVersion();
    check(version.length === 5, 'sem espacos tambem funciona');
}

// garbage line: falls back to the shipped version instead of throwing
stub('nothing useful here\nat all\nreally\nnothing\nconst version = "nope"');
{
    const r = await fetchLatestBaileysVersion();
    check(Array.isArray(r.version) && r.version.length >= 3, 'linha invalida cai no fallback (nao estoura)');
    check(r.isLatest === false, 'o fallback marca isLatest=false');
    check(
        Array.isArray(r.version) && r.version.length === 5,
        `o fallback tambem carrega o build id de 5 partes (${JSON.stringify(r.version)})`,
    );
}

globalThis.fetch = realFetch;

console.log(`\nRESULTADO: ${passed} ok, ${failed} falhas`);
process.exit(failed === 0 ? 0 : 1);
