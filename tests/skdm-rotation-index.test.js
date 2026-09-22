/**
 * S-KDM index + corroborating structure of the selective-distribution report.
 *
 * Scope: the *structure* of the signals, and the window semantics that decide
 * whether an undecryptable group message is corroborated as a rotation. No
 * crypto, no socket, no keys.
 *
 * The point of these tests is not "does it flag" but "can it tell the two
 * causes of an identical decryption error apart":
 *
 *   - late joiner / genuinely lost Sender Key  -> NO fresh SKDM  -> not corroborated
 *   - rotation distributed to a subset         -> fresh SKDM     -> corroborated
 *
 * Run: node --test tests/skdm-rotation-index.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { proto } from '../WAProto/index.js';
import { buildSelectiveDistributionReport, isSelectiveDistributionFailure } from '../lib/Utils/selective-distribution-detector.js';
import { createSkdmIndex, DEFAULT_SKDM_WINDOW_MS } from '../lib/Utils/skdm-rotation-index.js';

const GROUP = '120363000000000001@g.us';
const AUTHOR = '5511900000001@s.whatsapp.net';

/** A `<message>` stanza shaped like the rotation produces: skmsg + hide. */
const rotationStanza = ({ withPhash = false, addressed = 3, groupDevices = 50 } = {}) => {
    const skmsgAttrs = { type: 'skmsg', v: '2', 'decrypt-fail': 'hide' };
    if (withPhash) skmsgAttrs.phash = '2:AAAAAA';
    return {
        tag: 'message',
        attrs: {
            id: 'MSG-1',
            from: GROUP,
            participant: AUTHOR,
            ...(groupDevices ? { participant_count: String(groupDevices) } : {})
        },
        content: [
            {
                tag: 'participants',
                attrs: {},
                content: Array.from({ length: addressed }, (_, i) => ({
                    tag: 'to',
                    attrs: { jid: `55119000000${i}@s.whatsapp.net` },
                    content: [{ tag: 'enc', attrs: { type: 'skmsg' } }]
                }))
            },
            { tag: 'enc', attrs: skmsgAttrs, content: new Uint8Array([1, 2, 3]) }
        ]
    };
};

const decryptError = () => new Error('No session found to decrypt message');

describe('S-KDM index — window semantics', () => {
    it('records and reports an SKDM inside the window', () => {
        let t = 1_000_000;
        const idx = createSkdmIndex({ now: () => t });
        assert.equal(idx.recentlySeen(GROUP, AUTHOR), false, 'nada registrado ainda');
        idx.record(GROUP, AUTHOR);
        assert.equal(idx.recentlySeen(GROUP, AUTHOR), true, 'registrado e recente');
        t += 1000;
        assert.equal(idx.recentlySeen(GROUP, AUTHOR), true, 'ainda dentro da janela');
    });

    it('expires the SKDM after the window', () => {
        let t = 1_000_000;
        const idx = createSkdmIndex({ now: () => t, windowMs: 5000 });
        idx.record(GROUP, AUTHOR);
        t += 5001;
        assert.equal(idx.recentlySeen(GROUP, AUTHOR), false, 'fora da janela NÃO corrobora');
    });

    it('ageOf expõe o delta usado no report', () => {
        let t = 1_000_000;
        const idx = createSkdmIndex({ now: () => t });
        assert.equal(idx.ageOf(GROUP, AUTHOR), null, 'sem registro -> null');
        idx.record(GROUP, AUTHOR);
        t += 1500;
        assert.equal(idx.ageOf(GROUP, AUTHOR), 1500, 'delta em ms');
    });

    it('isola por (grupo, autor) — SKDM de outro autor não corrobora', () => {
        const idx = createSkdmIndex({ now: () => 1_000_000 });
        idx.record(GROUP, AUTHOR);
        assert.equal(idx.recentlySeen(GROUP, '5511900000002@s.whatsapp.net'), false, 'outro autor');
        assert.equal(idx.recentlySeen('120363000000000002@g.us', AUTHOR), false, 'outro grupo');
    });

    it('identificador vazio NUNCA é registrado (evita falso match global)', () => {
        const idx = createSkdmIndex({ now: () => 1_000_000 });
        assert.equal(idx.record('', AUTHOR), false, 'grupo vazio');
        assert.equal(idx.record(GROUP, ''), false, 'autor vazio');
        assert.equal(idx.size(), 0, 'nada foi indexado');
    });

    it('memória é limitada (teto) e expira sozinha', () => {
        let t = 1_000_000;
        const idx = createSkdmIndex({ now: () => t, maxEntries: 3, windowMs: 1000 });
        for (let i = 0; i < 10; i++) {
            idx.record(`g${i}@g.us`, AUTHOR);
            t += 100;
        }
        assert.ok(idx.size() <= 3, `teto respeitado (size=${idx.size()})`);
        // Avança muito: tudo expira -> volta a zero.
        t += 10_000;
        assert.equal(idx.size(), 0, 'tudo expirado');
    });
});

describe('Report — corroborating structure', () => {
    it('a stanza rotacionada é reportada com os campos de estrutura', () => {
        const r = buildSelectiveDistributionReport({ stanza: rotationStanza(), error: decryptError(), skdmRecentMs: 900 });
        assert.equal(r.kind, 'selective-distribution');
        assert.equal(r.decryptFail, 'hide');
        assert.equal(r.addressedDeviceCount, 3, 'destinatários contados');
        assert.equal(r.hasPhash, false, 'rotacionada NÃO tem phash');
        assert.equal(r.skdmRecentMs, 900, 'idade do SKDM propagada');
        assert.equal(r.groupDeviceCount, 50);
        assert.ok(Math.abs(r.density - 3 / 50) < 1e-9, 'densidade = endereçados/dispositivos');
    });

    it('um fan-out NORMAL (com phash) se distingue da rotacionada', () => {
        const normal = buildSelectiveDistributionReport({ stanza: rotationStanza({ withPhash: true, addressed: 50 }), error: decryptError() });
        assert.equal(normal.hasPhash, true, 'normal carrega phash');
        assert.equal(normal.density, 1, 'densidade cheia');
        const rot = buildSelectiveDistributionReport({ stanza: rotationStanza(), error: decryptError() });
        assert.equal(rot.hasPhash, false);
        assert.ok(rot.density < 0.5, 'densidade baixa na rotacionada');
    });

    it('densidade é null quando o total de dispositivos é desconhecido', () => {
        const r = buildSelectiveDistributionReport({ stanza: rotationStanza({ groupDevices: 0 }), error: decryptError() });
        assert.equal(r.groupDeviceCount, null, 'sem participant_count');
        assert.equal(r.density, null, 'densidade não é inventada');
    });

    it('skdmRecentMs inválido vira null (não inventa corroboração)', () => {
        for (const v of [undefined, null, NaN, 'x']) {
            const r = buildSelectiveDistributionReport({ stanza: rotationStanza(), error: decryptError(), skdmRecentMs: v });
            assert.equal(r.skdmRecentMs, null, `valor inválido -> null (${String(v)})`);
        }
    });

    it('o report NÃO vaza material sensível', () => {
        const r = buildSelectiveDistributionReport({ stanza: rotationStanza(), error: decryptError(), skdmRecentMs: 10 });
        const json = JSON.stringify(r).toLowerCase();
        for (const proibido of ['chainkey', 'chain key', 'privatekey', 'signingkey', 'senderkeyrecord', 'plaintext']) {
            assert.equal(json.includes(proibido), false, `não vaza "${proibido}"`);
        }
        // A mensagem de erro é texto de diagnóstico do GroupCipher, não material.
        assert.equal(typeof r.reason, 'string');
    });
});

describe('isSelectiveDistributionFailure — o gate continua estrito', () => {
    it('exige os três sinais (skmsg + decrypt-fail=hide + erro de sessão)', () => {
        const base = { encType: 'skmsg', encAttrs: { 'decrypt-fail': 'hide' }, error: decryptError() };
        assert.equal(isSelectiveDistributionFailure(base), true, 'os três -> true');
        assert.equal(isSelectiveDistributionFailure({ ...base, encType: 'msg' }), false, 'sem skmsg -> false');
        assert.equal(isSelectiveDistributionFailure({ ...base, encAttrs: {} }), false, 'sem decrypt-fail -> false');
        assert.equal(isSelectiveDistributionFailure({ ...base, error: new Error('other') }), false, 'sem erro de sessão -> false');
    });

    it('um erro de sessão SEM decrypt-fail não é ataque (entrou tarde)', () => {
        // Este é o caso benigno que importa: perder a Sender Key dá o MESMO erro.
        assert.equal(
            isSelectiveDistributionFailure({ encType: 'skmsg', encAttrs: { type: 'skmsg' }, error: decryptError() }),
            false,
            'sem a marca de intenção não classifica — evita punir quem entrou tarde'
        );
    });
});

describe('phash no wire — o que o envio produz', () => {
    it('generateParticipantHashV2 marca o conjunto endereçado', async () => {
        const { generateParticipantHashV2 } = await import('../lib/Utils/generics.js');
        const h = generateParticipantHashV2(['a@s.whatsapp.net', 'b@s.whatsapp.net']);
        assert.match(h, /^2:[A-Za-z0-9+/]{6}$/, 'formato 2:xxxxxx');
        // Ordem não importa (o gerador ordena).
        const h2 = generateParticipantHashV2(['b@s.whatsapp.net', 'a@s.whatsapp.net']);
        assert.equal(h, h2, 'ordem não altera o hash');
        // Conjuntos diferentes -> hashes diferentes.
        assert.notEqual(h, generateParticipantHashV2(['a@s.whatsapp.net']), 'conjunto menor difere');
    });
});
