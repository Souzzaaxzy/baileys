/**
 * VoIP media stack — WASM calling on the SAME Baileys session.
 *
 * This is the media half of WhatsApp calling, ported from `lizzy-call` (a fork
 * of `baileys-caller` by ShellTear, MIT) into this package. It carries the part
 * the signaling layer deliberately does not: real audio over the relay.
 *
 * ## The split, and why it exists
 *
 * `Utils/call-signaling.js` + the socket's `offerCall`/`offerGroupCall`/
 * `terminateCall` only build the `<call>` stanzas. A stanza makes a call
 * *exist* — it rings, it can be answered, it can be ended — but it carries no
 * sound. Media is RTP/SRTP over UDP to a relay, with keys negotiated separately
 * and the codec (Opus) driven by WhatsApp Web's own VoIP WASM engine.
 *
 * | Piece | What it does |
 * |---|---|
 * | `wasm-engine` | wraps `startVoipGroupCall` / `joinVoipOngoingCall` / `startCall` |
 * | `worker-bootstrap` | the Emscripten pthread workers the WASM engine spawns |
 * | `relay-transport` | UDP relay transport (TURN-style) for the media path |
 * | `signaling` | encrypts/decrypts the call stanzas, TC tokens, device routing |
 * | `group-bridge` | parses `group_update` (roster, per-device PIDs, relay allocation) |
 * | `group-media` | per-group session: join, wait for media, play a file |
 * | `audio-feeder` | ffmpeg → 16 kHz mono PCM → engine uplink |
 * | `client` | standalone `VoipClient` (its own socket) for 1:1 calls |
 *
 * ## Two entry points
 *
 * - **Group calls** (what a bot needs): `GroupCallMedia` rides the socket you
 *   already have — `media.entrarNaCall({ grupo, sock, participantes })`.
 * - **1:1 calls**: `VoipClient` opens its own connection with its own auth dir.
 *
 * The WASM binary and its loader live in `assets/wasm/` (whatsapp.wasm,
 * loader.js, worker-modules.js) and are loaded from the package root.
 *
 * @module Voip
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { GroupCallMedia, buildCallRoster, podeAlimentarCaptura, setupDaCallFalhou } from './group-media.js';
export { WasmEngine } from './wasm-engine.js';
export { SignalingBridge } from './signaling.js';
export { RelayRtcTransport } from './relay-transport.js';
export { AudioFeeder } from './audio-feeder.js';
export { parseGroupUpdate, applyGroupUpdate, applyKeyEpoch, buildParticipantLists, bareJid, generateCallId } from './group-bridge.js';
export { VoipClient, ActiveCall, CallState } from './client.js';
export { makeVoipSession } from './session.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to this package's root (where `assets/wasm` lives). */
export const VOIP_PACKAGE_ROOT = path.resolve(HERE, '..', '..');

/** Absolute path to the WASM resources directory. */
export const VOIP_WASM_DIR = path.join(VOIP_PACKAGE_ROOT, 'assets', 'wasm');

/**
 * How much free RAM the media stack wants before a call is worth attempting.
 *
 * Measured (see `wasm-engine.js`): ~45 MB per pthread worker, and a single call
 * holds a pool of them. On a small VPS the OOM killer then sends `SIGKILL` —
 * which surfaces as "the bot restarted by itself", with no log, because SIGKILL
 * cannot be caught.
 */
export const VOIP_MIN_FREE_MB = 700;

/**
 * Whether there is enough free memory to bring the media stack up.
 *
 * Honest about its own limits: returns `{ ok: true }` when the check itself
 * cannot run, so a missing `os.freemem` never blocks a call.
 */
export const checkVoipMemory = (minFreeMb = VOIP_MIN_FREE_MB) => {
    try {
        const livreMb = Math.round(os.freemem() / 1048576);
        return { ok: livreMb >= minFreeMb, livreMb, minFreeMb };
    } catch {
        return { ok: true, livreMb: null, minFreeMb };
    }
};
