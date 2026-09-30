/**
 * Testes do `group.join-request` — a `action` é SEMPRE derivada.
 *
 * Motivo: o stub do WhatsApp só define a action no caminho de
 * `revoked_membership_requests` (`revoked` quando o próprio solicitante cancela,
 * `rejected` quando um admin recusa). Nos demais caminhos ela chegava
 * `undefined`, então um consumidor não tinha como separar "pedido novo" de
 * "pedido resolvido" — e reenviava o card de solicitação ao recusar.
 *
 * O teste roda o caminho REAL (`processMessage`) com o stub, e não a função
 * pura isolada — foi justamente um dublê mais permissivo que a realidade que
 * escondeu o defeito em outras correções.
 *
 * Run: node --test tests/join-request-action.test.js
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import processMessage from '../lib/Utils/process-message.js';
import { WAMessageStubType } from '../lib/index.js';
import { deriveJoinRequestAction, JOIN_REQUEST_ACTIONS } from '../lib/Utils/join-request.js';

const GRUPO = '120363400000000001@g.us';
const SOLICITANTE_LID = '222222222222222@lid';
const SOLICITANTE_PN = '5511888888888@s.whatsapp.net';
const ADMIN_LID = '333333333333333@lid';
const ADMIN_PN = '5511777777777@s.whatsapp.net';

const logger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return this } };

/**
 * Dispara o stub pelo caminho real e devolve o evento emitido.
 * `stubParams` é o que a fork monta em `messages-recv.js` para cada caso.
 */
async function emitir(acaoDoStub, atorLid, atorPn, afetado = { lid: SOLICITANTE_LID, pn: SOLICITANTE_PN }) {
    const ev = new EventEmitter();
    const capturados = [];
    ev.on('group.join-request', (inf) => capturados.push(inf));

    const params = [JSON.stringify(afetado)];
    if (acaoDoStub !== undefined) params.push(acaoDoStub);

    await processMessage({
        key: {
            remoteJid: GRUPO,
            fromMe: false,
            id: 'STUB-1',
            participant: atorLid,
            participantAlt: atorPn,
        },
        messageStubType: WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD,
        messageStubParameters: params,
        messageTimestamp: Math.floor(Date.now() / 1000),
    }, {
        ev,
        creds: { me: { id: '5599999999999@s.whatsapp.net', lid: '111111111111111@lid' } },
        logger,
        options: {},
        shouldProcessHistoryMsg: false,
        placeholderResendCache: null,
        signalRepository: null,
        keyStore: null,
        getMessage: async () => undefined,
    });

    return capturados[0] || null;
}

describe('deriveJoinRequestAction (função pura)', () => {
    it('preserva as actions canônicas', () => {
        for (const a of JOIN_REQUEST_ACTIONS) {
            assert.equal(deriveJoinRequestAction(a, { lid: SOLICITANTE_LID }, ADMIN_LID, ADMIN_PN), a);
        }
    });

    it('ator diferente do afetado => rejected (um admin resolveu)', () => {
        assert.equal(deriveJoinRequestAction(undefined, { lid: SOLICITANTE_LID }, ADMIN_LID, ADMIN_PN), 'rejected');
    });

    it('ator igual ao afetado => revoked (o próprio cancelou)', () => {
        assert.equal(deriveJoinRequestAction(undefined, { lid: SOLICITANTE_LID }, SOLICITANTE_LID, undefined), 'revoked');
        assert.equal(deriveJoinRequestAction(undefined, { pn: SOLICITANTE_PN }, undefined, SOLICITANTE_PN), 'revoked');
    });

    it('casa por PN também, e ignora o device', () => {
        // O afetado real traz LID e PN (é o que a stanza monta).
        const afetado = { lid: SOLICITANTE_LID, pn: SOLICITANTE_PN };
        assert.equal(deriveJoinRequestAction(undefined, afetado, undefined, SOLICITANTE_PN), 'revoked');
        assert.equal(
            deriveJoinRequestAction(undefined, afetado, '222222222222222:7@lid', undefined),
            'revoked',
            'o sufixo :device não pode mudar a conclusão'
        );
        assert.equal(
            deriveJoinRequestAction(undefined, afetado, SOLICITANTE_LID.replace('@lid', '@s.whatsapp.net'), undefined),
            'rejected',
            'LID e PN são namespaces diferentes — não podem ser confundidos'
        );
    });

    it('sem afetado não inventa "revoked"', () => {
        assert.equal(deriveJoinRequestAction(undefined, {}, ADMIN_LID, ADMIN_PN), 'created');
        assert.equal(deriveJoinRequestAction(undefined, null, ADMIN_LID, ADMIN_PN), 'created');
    });

    it('nunca devolve undefined', () => {
        const casos = [
            [undefined, { lid: SOLICITANTE_LID }, ADMIN_LID, ADMIN_PN],
            [undefined, {}, undefined, undefined],
            [null, { lid: SOLICITANTE_LID }, SOLICITANTE_LID, undefined],
        ];
        for (const [a, afetado, lid, pn] of casos) {
            const r = deriveJoinRequestAction(a, afetado, lid, pn);
            assert.ok(JOIN_REQUEST_ACTIONS.includes(r), `action inválida: ${r}`);
        }
    });
});

describe('group.join-request pelo caminho real (processMessage)', () => {
    it('stub "created" entrega action=created + quem pediu', async () => {
        const evt = await emitir('created', undefined, undefined);
        assert.ok(evt, 'evento emitido');
        assert.equal(evt.action, 'created');
        assert.equal(evt.participant, SOLICITANTE_LID);
        assert.equal(evt.participantPn, SOLICITANTE_PN);
    });

    it('stub de recusa por admin entrega action=rejected + QUEM RECUSOU', async () => {
        // É exatamente o caso do bot: o admin recusa e o ator é o admin.
        const evt = await emitir('rejected', ADMIN_LID, ADMIN_PN);
        assert.ok(evt, 'evento emitido');
        assert.equal(evt.action, 'rejected', 'recusa identificada');
        assert.equal(evt.author, ADMIN_LID, 'quem recusou (LID)');
        assert.equal(evt.authorPn, ADMIN_PN, 'quem recusou (PN)');
        assert.notEqual(evt.author, evt.participant, 'o ator não é o solicitante');
    });

    it('cancelamento pelo próprio solicitante entrega action=revoked', async () => {
        const evt = await emitir('revoked', SOLICITANTE_LID, SOLICITANTE_PN);
        assert.ok(evt, 'evento emitido');
        assert.equal(evt.action, 'revoked');
        assert.equal(evt.author, evt.participant, 'ator e afetado são a mesma pessoa');
    });

    it('SEM action no stub, a recusa por admin ainda é derivada (o defeito)', async () => {
        // Este é o caso que antes saía `undefined` — e que fazia o consumidor
        // tratar uma recusa como se fosse um pedido novo.
        const evt = await emitir(undefined, ADMIN_LID, ADMIN_PN);
        assert.ok(evt, 'evento emitido');
        assert.equal(evt.action, 'rejected', 'derivado, não undefined');
        assert.equal(evt.author, ADMIN_LID, 'o ator continua disponível');
    });

    it('SEM action e com ator == solicitante => revoked', async () => {
        const evt = await emitir(undefined, SOLICITANTE_LID, SOLICITANTE_PN);
        assert.ok(evt, 'evento emitido');
        assert.equal(evt.action, 'revoked');
    });

    it('a action nunca é undefined, em nenhum caminho', async () => {
        const variantes = [
            ['created', ADMIN_LID, ADMIN_PN],
            ['rejected', ADMIN_LID, ADMIN_PN],
            ['revoked', SOLICITANTE_LID, SOLICITANTE_PN],
            [undefined, ADMIN_LID, ADMIN_PN],
            [undefined, SOLICITANTE_LID, SOLICITANTE_PN],
            [undefined, undefined, undefined],
        ];
        for (const [acao, lid, pn] of variantes) {
            const evt = await emitir(acao, lid, pn);
            assert.ok(evt, `evento emitido (${acao}/${lid})`);
            assert.ok(
                JOIN_REQUEST_ACTIONS.includes(evt.action),
                `action inválida em ${acao}/${lid}: ${evt.action}`
            );
        }
    });
});
