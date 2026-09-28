/**
 * The socket-side VoIP facade: lazy creation, memory pre-flight, and honest
 * answers when there is no session.
 *
 * No WASM is booted here — the point is the CONTRACT around it: a bot that never
 * calls must not pay for the media stack, and a call that would be OOM-killed
 * must be refused with a reason instead of taking the process down.
 *
 * Usage: node tests/voip-session.test.js
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const { makeVoipSession, VOIP_MIN_FREE_MB } = await import(new URL('../lib/Voip/index.js', import.meta.url).href);

let passed = 0;
let failed = 0;
const check = (cond, msg) => {
    if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
    else { failed += 1; console.log(`  FAIL ${msg}`); }
};

console.log('VoIP session facade\n');

const fakeSock = { authState: { creds: { me: { id: '5511999999999@s.whatsapp.net', lid: '111@lid' } } } };

// ── guard ────────────────────────────────────────────────────────────────────
let threw = false;
try { makeVoipSession(null); } catch { threw = true; }
check(threw, 'exige um socket (falha alto sem socket)');

// ── lazy: nothing is built until the first call ──────────────────────────────
const voip = makeVoipSession(fakeSock, { log: () => {} });
check(voip.started === false, 'NAO sobe a pilha de midia antes da primeira call');
check(voip.estagio('g@g.us') === 'parado', 'estagio e "parado" sem sessao');
check(voip.temSessao('g@g.us') === false, 'temSessao e false sem sessao');

// ── honest answers with no session ───────────────────────────────────────────
const semSessao = await voip.tocarAudio('g@g.us', '/tmp/x.mp3');
check(semSessao.ok === false && semSessao.motivo === 'sem_sessao', 'tocarAudio sem sessao responde sem_sessao (nao mente)');
const parar = voip.pararAudio('g@g.us');
check(parar.ok === false && parar.motivo === 'sem_sessao', 'pararAudio sem sessao responde sem_sessao');
const sair = await voip.sairDaCall('g@g.us');
check(sair.ok === false && sair.motivo === 'sem_sessao', 'sairDaCall sem sessao responde sem_sessao');

// ── memory pre-flight ────────────────────────────────────────────────────────
const mem = voip.checkMemory();
check(typeof mem.ok === 'boolean' && typeof mem.livreMb === 'number', 'checkMemory informa memoria livre real');
check(voip.checkMemory(Number.MAX_SAFE_INTEGER).ok === false, 'checkMemory recusa quando o minimo e impossivel');
check(VOIP_MIN_FREE_MB > 0, `VOIP_MIN_FREE_MB definido (${VOIP_MIN_FREE_MB} MB)`);

// A call that cannot fit in RAM must be refused, not attempted (OOM = SIGKILL).
const refused = await voip.entrarNaCall({ grupo: 'g@g.us', participantes: [], minFreeMb: Number.MAX_SAFE_INTEGER });
check(refused.ok === false && refused.motivo === 'memoria_baixa', 'entrarNaCall recusa com motivo quando a memoria e insuficiente');
check(typeof refused.detalhe === 'string' && refused.detalhe.length > 0, 'a recusa traz o detalhe (MB livres vs necessario)');
check(voip.started === false, 'a recusa NAO subiu a pilha de midia (nao desperdica memoria)');

// ── teardown is safe with nothing running ────────────────────────────────────
await voip.destroy();
check(true, 'destroy() e seguro sem sessao ativa');

console.log(`\nRESULTADO: ${passed} ok, ${failed} falhas`);
process.exit(failed === 0 ? 0 : 1);
