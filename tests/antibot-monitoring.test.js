/**
 * AntiBot — o que o MONITORAMENTO deve mostrar em cada modo.
 *
 * Regressão do relato: "ativei o antibot, rodei o outro bot e ele só disse que
 * tinha 1 usuário analisado". Duas causas, ambas medidas:
 *
 *  1. o painel contava a banda EFETIVA, e em `log`/`observe` todo mundo é
 *     rebaixado a NORMAL — então as contagens apareciam zeradas justamente no
 *     modo em que o operador quer ver evidência (corrigido: o painel usa a banda
 *     RAW da análise);
 *  2. o analisado só sobe de 1 quando o SEGUNDO participante fala — que é o
 *     comportamento correto, mas o painel não deixava isso claro.
 *
 * Este teste fixa o contrato do painel e a curva de detecção por janelas.
 *
 * Run: node --test tests/antibot-monitoring.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAntiBotEngine } from '../lib/AntiBot/AntiBotEngine.js';
import { ANTI_BOT_STATUS, ANTI_BOT_MODE } from '../lib/AntiBot/AntiBotTypes.js';

const GROUP = '120363000000000001@g.us';
const A = '5511900000001@s.whatsapp.net';
const B = '5511900000002@s.whatsapp.net';

/** Engine com relógio de chegada controlado (o pacing é medido por chegada). */
const makeEngine = ({ mode = ANTI_BOT_MODE.OBSERVE, start = 1_700_000_000_000, config = {} } = {}) => {
  let clock = start;
  const engine = createAntiBotEngine({ mode, windowMs: 60_000, decayHalfLifeMs: 300_000, ...config }, { now: () => clock });
  engine.__tick = (ms) => { clock += ms; };
  engine.__clock = () => clock;
  return engine;
};

const send = (engine, { author, text = '!ping', tickMs = 1000, id = 'M' }) => {
  const r = engine.ingest({
    key: { remoteJid: GROUP, fromMe: false, id, participant: author },
    message: { extendedTextMessage: { text } },
    messageTimestamp: Math.floor(engine.__clock() / 1000)
  });
  engine.__tick(tickMs);
  return r;
};

describe('painel de monitoramento', () => {
    it('conta o participante assim que ele fala (analyzed sobe)', () => {
        const engine = makeEngine();
        let r = null;
        // O bot da Lizzy manda 6 mensagens curtas — o caso do relato.
        for (let i = 0; i < 6; i++) r = send(engine, { author: A, id: `X${i}` });
        const stats = engine.stats(GROUP);
        assert.equal(stats.analyzed, 1, `analyzed deve contar 1 (veio ${stats.analyzed})`);
        assert.equal(stats.total, 1);
        assert.ok(r, 'houve avaliação');
    });

    it('analyzed sobe quando o segundo participante fala', () => {
        const engine = makeEngine();
        for (let i = 0; i < 6; i++) send(engine, { author: A, id: `X${i}` });
        for (let i = 0; i < 6; i++) send(engine, { author: B, id: `Y${i}` });
        const stats = engine.stats(GROUP);
        assert.equal(stats.analyzed, 2, `analyzed deve contar 2 (veio ${stats.analyzed})`);
    });

    it('em OBSERVE o painel mostra a banda RAW (nao zera as contagens)', () => {
        const engine = makeEngine({ mode: ANTI_BOT_MODE.OBSERVE });
        for (let i = 0; i < 40; i++) send(engine, { author: A, id: `X${i}` });
        const stats = engine.stats(GROUP);
        // O status EFETIVO de todos em observe e' NORMAL; o painel deve revelar
        // que a ANALISE encontrou algo, senao o operador nao ve nada.
        assert.ok(
            stats.OBSERVING + stats.SUSPICIOUS + stats.HIGH_RISK + stats.CONFIRMED > 0,
            `em observe o painel deve mostrar a analise (stats=${JSON.stringify(stats)})`
        );
    });

    it('a lista de suspeitos funciona em OBSERVE', () => {
        const engine = makeEngine({ mode: ANTI_BOT_MODE.OBSERVE });
        for (let i = 0; i < 40; i++) send(engine, { author: A, id: `X${i}` });
        const lista = engine.listChat(GROUP);
        assert.equal(lista.length, 1, `a lista deve mostrar o participante analisado (veio ${lista.length})`);
        assert.equal(lista[0].participant, A);
        assert.ok(lista[0].score > 0, 'com score');
    });

    it('em LOG o painel tambem revela a analise', () => {
        const engine = makeEngine({ mode: ANTI_BOT_MODE.LOG });
        for (let i = 0; i < 40; i++) send(engine, { author: A, id: `X${i}` });
        const stats = engine.stats(GROUP);
        assert.ok(
            stats.OBSERVING + stats.SUSPICIOUS + stats.HIGH_RISK + stats.CONFIRMED > 0,
            `em log o painel deve mostrar a analise (stats=${JSON.stringify(stats)})`
        );
    });
});

describe('curva de deteccao (o que o operador deve esperar)', () => {
    it('um burst em UMA janela fica no maximo SUSPICIOUS', () => {
        const engine = makeEngine({ mode: ANTI_BOT_MODE.ACTIVE });
        let r = null;
        for (let i = 0; i < 40; i++) r = send(engine, { author: A, id: `X${i}` });
        assert.ok(r);
        assert.notEqual(r.status, ANTI_BOT_STATUS.CONFIRMED);
        assert.equal(r.actionAllowed, false, 'uma janela nao age');
    });

    it('o ritmo sustentado por varias janelas chega a CONFIRMED e libera acao', () => {
        const engine = makeEngine({ mode: ANTI_BOT_MODE.ACTIVE });
        let r = null;
        for (let w = 0; w < 6; w++) {
            for (let i = 0; i < 40; i++) r = send(engine, { author: A, id: `W${w}-${i}` });
            engine.__tick(20_000); // fecha a janela
        }
        assert.ok(r);
        assert.equal(r.status, ANTI_BOT_STATUS.CONFIRMED, `esperado CONFIRMED (veio ${r.status}, score ${r.automationScore})`);
        assert.equal(r.actionAllowed, true, 'a acao e liberada so no modo active + confirmado');
    });

    it('rajada INSTANTANEA (tudo no mesmo ms) e detectada como rajada', () => {
        // Este era o furo: com todas as chegadas no mesmo instante, o analisador
        // de intervalos via media 0 e variancia 0 e NAO reportava nada. Hoje a
        // densidade da rajada e o que detecta esse caso.
        const engine = makeEngine({ mode: ANTI_BOT_MODE.ACTIVE });
        let r = null;
        for (let i = 0; i < 30; i++) r = send(engine, { author: A, id: `I${i}`, tickMs: 0 });
        assert.ok(r);
        assert.ok(r.automationScore > 0, `a rajada instantanea deve pontuar (score ${r.automationScore})`);
        assert.ok(r.evidences.some((e) => e.type === 'burst_density'),
            `deve reportar burst_density (ev=${r.evidences.map((e) => e.type).join(',')})`);
    });

    it('rajada instantanea NAO e o mesmo que ritmo de maquina', () => {
        // Os dois casos pontuam, mas por evidencias diferentes — se a rajada
        // contasse como "regular_intervals", a explicacao estaria errada.
        const burst = makeEngine({ mode: ANTI_BOT_MODE.ACTIVE });
        let rb = null;
        for (let i = 0; i < 30; i++) rb = send(burst, { author: A, id: `B${i}`, tickMs: 0 });
        assert.ok(!rb.evidences.some((e) => e.type === 'regular_intervals'),
            'rajada sem pacing nao pode ser "intervalos regulares"');

        const paced = makeEngine({ mode: ANTI_BOT_MODE.ACTIVE });
        let rp = null;
        for (let i = 0; i < 30; i++) rp = send(paced, { author: A, id: `P${i}`, tickMs: 1000 });
        assert.ok(rp.evidences.some((e) => e.type === 'regular_intervals'),
            'ritmo constante e "intervalos regulares"');
    });

    it('uso esparso (comandos espacados) NAO sobe de banda', () => {
        const engine = makeEngine({ mode: ANTI_BOT_MODE.ACTIVE });
        let r = null;
        // 20 mensagens com 30s entre elas — humano comandando, nao bot.
        for (let i = 0; i < 20; i++) r = send(engine, { author: A, id: `S${i}`, tickMs: 30_000 });
        assert.ok(r);
        assert.equal(r.status, ANTI_BOT_STATUS.NORMAL, `esperado NORMAL (veio ${r.status}, score ${r.automationScore})`);
    });

    it('o status efetivo respeita o modo, mas a analise nao mente', () => {
        const observe = makeEngine({ mode: ANTI_BOT_MODE.OBSERVE });
        let r = null;
        for (let w = 0; w < 6; w++) {
            for (let i = 0; i < 40; i++) r = send(observe, { author: A, id: `O${w}-${i}` });
            observe.__tick(20_000);
        }
        assert.ok(r);
        // A analise concluiu; o MODO impede a acao.
        assert.equal(r.actionAllowed, false, 'observe nunca libera acao');
        const stats = observe.stats(GROUP);
        assert.ok(stats.CONFIRMED + stats.HIGH_RISK + stats.SUSPICIOUS > 0,
            'o painel continua mostrando a analise em observe');
    });
});
