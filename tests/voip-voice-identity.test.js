/**
 * P2 — voice-capable identity.
 *
 * WhatsApp only enables the calling media stack for a client that advertises
 * itself as desktop/UWP with a 5-part build id. The package default is
 * `Browsers.macOS('Chrome')` with a 3-part version, which signals calls but
 * never gets voice — a silent failure, because the call still rings.
 *
 * These tests lock in the preset AND the assertion helper that makes the
 * mistake loud.
 *
 * Usage: node tests/voip-voice-identity.test.js
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const { Browsers, VOICE_CAPABLE_VERSION, isVoiceCapableConfig, getPlatformId } = await import(
    new URL('../lib/Utils/browser-utils.js', import.meta.url).href
);
const { DEFAULT_CONNECTION_CONFIG } = await import(new URL('../lib/Defaults/index.js', import.meta.url).href);
const { proto } = await import(new URL('../WAProto/index.js', import.meta.url).href);

let passed = 0;
let failed = 0;
const check = (cond, msg) => {
    if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
    else { failed += 1; console.log(`  FAIL ${msg}`); }
};

console.log('P2 — identidade de voz (desktop/UWP)\n');

// ── the preset itself ────────────────────────────────────────────────────────
const uwp = Browsers.desktopUWP('UWP');
check(Array.isArray(uwp) && uwp.length === 3, 'desktopUWP devolve a tupla [os, browser, version]');
check(uwp[1] === 'UWP', 'o segundo elemento e "UWP" (o que getPlatformType le)');

const vc = Browsers.voiceCapable('UWP');
check(vc.browser[1] === 'UWP', 'voiceCapable usa browser UWP');
check(vc.version === VOICE_CAPABLE_VERSION, 'voiceCapable usa o build id de 5 partes');
check(Array.isArray(vc.version) && vc.version.length === 5, `version tem 5 partes (${vc.version.length})`);

// ── the enum actually resolves (not just a string we invented) ──────────────
const platformId = getPlatformId('UWP');
check(platformId === String(proto.DeviceProps.PlatformType.UWP), 'getPlatformId("UWP") bate com o enum real do proto');
check(proto.DeviceProps.PlatformType.UWP !== undefined, 'proto.DeviceProps.PlatformType.UWP existe');

// ── the assertion helper: accepts the good, refuses the silent-bad ──────────
check(isVoiceCapableConfig(vc).ok === true, 'isVoiceCapableConfig aceita UWP + 5 partes');

const macChrome = { browser: Browsers.macOS('Chrome'), version: [2, 3000, 123] };
const bad = isVoiceCapableConfig(macChrome);
check(bad.ok === false, 'isVoiceCapableConfig RECUSA macOS/Chrome (voz ficaria muda)');
check(/UWP|DESKTOP|midia/.test(bad.reason || ''), 'a recusa explica o motivo (UWP/DESKTOP/midia)');

const threePart = isVoiceCapableConfig({ browser: Browsers.desktopUWP('UWP'), version: [2, 3000, 123] });
check(threePart.ok === false, 'isVoiceCapableConfig RECUSA build id de 3 partes');
check(/5 partes/.test(threePart.reason || ''), 'a recusa do build id cita as 5 partes');

check(isVoiceCapableConfig({}).ok === false, 'config vazia e recusada (nao passa por omissao)');

// ── the package default is NOT voice-capable (documents the trap) ───────────
const def = isVoiceCapableConfig(DEFAULT_CONNECTION_CONFIG);
check(def.ok === false, 'o default do pacote NAO e voice-capable — por isso o preset existe');
console.log(`       (default: browser=${JSON.stringify(DEFAULT_CONNECTION_CONFIG.browser)}, version=${JSON.stringify(DEFAULT_CONNECTION_CONFIG.version)})`);

console.log(`\nRESULTADO: ${passed} ok, ${failed} falhas`);
process.exit(failed === 0 ? 0 : 1);
