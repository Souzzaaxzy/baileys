/**
 * P3 — teardown must not leak the socket hook.
 *
 * `SignalingBridge.init()` wraps `sock.authState.keys.set` to observe TC tokens.
 * That wrapper closes over the bridge, so every call cycle that is not disposed
 * leaves one more closure chained on the socket's key store — and keeps the
 * whole bridge (its token map, its session cache) alive. Asserted here on a
 * fake socket, with no WASM and no network.
 *
 * Usage: node tests/voip-signaling-dispose.test.js
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const { SignalingBridge } = await import(new URL('../lib/Voip/signaling.js', import.meta.url).href);

let passed = 0;
let failed = 0;
const check = (cond, msg) => {
    if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
    else { failed += 1; console.log(`  FAIL ${msg}`); }
};

console.log('P3 — dispose da signaling (sem vazar o gancho do socket)\n');

const makeSock = () => {
    const calls = [];
    const originalSet = async (data) => { calls.push(data); return { ok: true }; };
    return {
        calls,
        authState: { keys: { set: originalSet } },
        sock: {
            authState: { keys: { set: originalSet } },
        },
    };
};

// ── init installs a wrapper ─────────────────────────────────────────────────
const holder = makeSock();
const sock = holder.sock;
const originalSet = sock.authState.keys.set;

const bridge = new SignalingBridge({ sock });
await bridge.init();
check(sock.authState.keys.set !== originalSet, 'init() instala um wrapper em sock.authState.keys.set');

// the wrapper still forwards to the original (no behaviour lost)
sock.authState.keys.set({ tctoken: {} });
check(holder.calls.length === 1, 'o wrapper ainda chama o setter original (nao engole a escrita)');

// ── dispose restores it ─────────────────────────────────────────────────────
bridge.dispose();
check(sock.authState.keys.set === originalSet, 'dispose() RESTAURA o setter original');

// ── repeated cycles do not stack ────────────────────────────────────────────
for (let i = 0; i < 5; i += 1) {
    const b = new SignalingBridge({ sock });
    await b.init();
    b.dispose();
}
check(sock.authState.keys.set === originalSet, '5 ciclos init/dispose NAO empilham wrappers no socket');

// ── dispose is idempotent and safe on a dead socket ─────────────────────────
bridge.dispose();
check(sock.authState.keys.set === originalSet, 'dispose() e idempotente');

const deadSock = { authState: { keys: {} } };
const b2 = new SignalingBridge({ sock: deadSock });
let threw = false;
try { b2.dispose(); } catch { threw = true; }
check(threw === false, 'dispose() sem init nao estoura');

console.log(`\nRESULTADO: ${passed} ok, ${failed} falhas`);
process.exit(failed === 0 ? 0 : 1);
