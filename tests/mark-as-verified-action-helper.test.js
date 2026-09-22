/**
 * MarkAsVerifiedAction — helper de envio (validacao, fail-closed, transporte).
 *
 * O helper NAO decide semantica: ele constroi o envelope correto, valida o que
 * da para validar, envia pelo caminho existente e relata. Este teste fixa esse
 * contrato:
 *   - payload valido -> envelope com type 36 e campo 32;
 *   - payload invalido -> ERRO e NADA e enviado (fail-closed);
 *   - campos omitidos continuam AUSENTES no envelope (nao viram `false`);
 *   - a identity key nunca aparece em log/erro (so a LENGTH);
 *   - falha de transporte e reportada, nao engolida.
 *
 * Run: node --test tests/mark-as-verified-action-helper.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { proto } from '../WAProto/index.js';
import {
  buildMarkAsVerifiedProtocolMessage,
  sendMarkAsVerifiedAction,
  assertMarkAsVerifiedPayload,
  normalizeActionJid,
  MARK_AS_VERIFIED_ACTION_TYPE,
  MARK_AS_VERIFIED_ACTION_FIELD
} from '../lib/Utils/mark-as-verified.js';

const PN = '5511999999999@s.whatsapp.net';
const LID = '100000000000001@lid';

describe('MarkAsVerifiedAction — constantes do schema', () => {
  it('tipo e field number batem com o enum e o pai', () => {
    assert.equal(MARK_AS_VERIFIED_ACTION_TYPE, 36);
    assert.equal(proto.Message.ProtocolMessage.Type.MARK_AS_VERIFIED_ACTION, MARK_AS_VERIFIED_ACTION_TYPE);
    assert.equal(MARK_AS_VERIFIED_ACTION_FIELD, 32);
  });
});

describe('MarkAsVerifiedAction — normalizacao de JID', () => {
  it('aceita PN e LID sem converter entre eles', () => {
    assert.equal(normalizeActionJid(PN), PN, 'PN preservado');
    assert.equal(normalizeActionJid(LID), LID, 'LID preservado (nao converte para PN)');
  });

  it('remove o sufixo de dispositivo', () => {
    assert.equal(normalizeActionJid('5511999999999:12@s.whatsapp.net'), PN);
  });

  it('rejeita JID invalido', () => {
    assert.throws(() => normalizeActionJid(''), /JID string/);
    assert.throws(() => normalizeActionJid('nao-e-jid'), /invalid JID/);
    assert.throws(() => normalizeActionJid('123'), /invalid JID/);
  });
});

describe('MarkAsVerifiedAction — envelope', () => {
  it('constroi type 36 + campo markAsVerifiedAction', () => {
    const built = buildMarkAsVerifiedProtocolMessage({ userJidString: PN, verified: true, actionSeq: 1 });
    assert.equal(built.type, 36);
    assert.equal(built.markAsVerifiedAction.userJidString, PN);
    assert.equal(built.markAsVerifiedAction.verified, true);
    assert.equal(built.markAsVerifiedAction.actionSeq, 1);
  });

  it('campos OMITIDOS continuam ausentes (nao viram false/zero)', () => {
    const built = buildMarkAsVerifiedProtocolMessage({ userJidString: PN });
    assert.ok(!('verified' in built.markAsVerifiedAction), 'verified ausente quando nao informado');
    assert.ok(!('actionSeq' in built.markAsVerifiedAction), 'actionSeq ausente quando nao informado');
    assert.ok(!('verifiedIdentityKey' in built.markAsVerifiedAction), 'identity key ausente quando nao informada');
  });

  it('verified=false e PRESERVADO (presente, nao ausente)', () => {
    const built = buildMarkAsVerifiedProtocolMessage({ userJidString: PN, verified: false });
    assert.equal(built.markAsVerifiedAction.verified, false);
    assert.ok('verified' in built.markAsVerifiedAction);
  });

  it('o envelope serializa e volta igual (round-trip real)', () => {
    const built = buildMarkAsVerifiedProtocolMessage({ userJidString: LID, verified: true, actionSeq: 9 });
    const dec = proto.Message.ProtocolMessage.decode(proto.Message.ProtocolMessage.encode(built).finish());
    assert.equal(dec.type, 36);
    assert.equal(dec.markAsVerifiedAction.userJidString, LID);
    assert.equal(dec.markAsVerifiedAction.verified, true);
    assert.equal(Number(dec.markAsVerifiedAction.actionSeq), 9);
  });
});

describe('MarkAsVerifiedAction — validacao (fail-closed)', () => {
  it('rejeita verified nao-booleano', () => {
    assert.throws(() => assertMarkAsVerifiedPayload({ userJidString: PN, verified: 'sim' }), /verified/);
    assert.throws(() => assertMarkAsVerifiedPayload({ userJidString: PN, verified: 1 }), /verified/);
  });

  it('rejeita actionSeq invalido', () => {
    assert.throws(() => assertMarkAsVerifiedPayload({ userJidString: PN, actionSeq: -1 }), /actionSeq/);
    assert.throws(() => assertMarkAsVerifiedPayload({ userJidString: PN, actionSeq: 1.5 }), /actionSeq/);
    assert.throws(() => assertMarkAsVerifiedPayload({ userJidString: PN, actionSeq: 'abc' }), /actionSeq/);
  });

  it('rejeita identity key de tipo errado ou vazia', () => {
    assert.throws(() => assertMarkAsVerifiedPayload({ userJidString: PN, verifiedIdentityKey: 123 }), /verifiedIdentityKey/);
    assert.throws(() => assertMarkAsVerifiedPayload({ userJidString: PN, verifiedIdentityKey: Buffer.alloc(0) }), /verifiedIdentityKey/);
  });

  it('NAO envia nada quando o payload e invalido', async () => {
    let called = false;
    const res = await sendMarkAsVerifiedAction({
      relayMessage: async () => { called = true; },
      chatJid: PN,
      userJidString: '' // invalido
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'payload_invalido');
    assert.equal(called, false, 'o relay NAO foi chamado (fail-closed)');
  });
});

describe('MarkAsVerifiedAction — envio', () => {
  it('envia pelo relay e devolve sucesso + o envelope usado', async () => {
    const calls = [];
    const res = await sendMarkAsVerifiedAction({
      relayMessage: async (jid, content, opts) => { calls.push({ jid, content, opts }); },
      chatJid: PN,
      userJidString: PN,
      verified: true,
      messageId: 'MVA-1'
    });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1, 'exatamente um relay');
    assert.equal(calls[0].jid, PN);
    assert.equal(calls[0].content.type, 36);
    assert.equal(calls[0].content.markAsVerifiedAction.verified, true);
    assert.equal(calls[0].opts.messageId, 'MVA-1');
  });

  it('usa o alvo como conversa quando chatJid nao e informado', async () => {
    const calls = [];
    await sendMarkAsVerifiedAction({
      relayMessage: async (jid) => { calls.push(jid); },
      userJidString: LID
    });
    assert.equal(calls[0], LID);
  });

  it('erro de transporte e reportado, nao engolido', async () => {
    const res = await sendMarkAsVerifiedAction({
      relayMessage: async () => { throw new Error('rede caiu'); },
      chatJid: PN,
      userJidString: PN
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'transporte');
    assert.match(res.error, /rede caiu/);
    assert.ok(res.built, 'o envelope construido continua disponivel para inspecao');
  });

  it('sem relay disponivel: falha controlada', async () => {
    const res = await sendMarkAsVerifiedAction({ chatJid: PN, userJidString: PN });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'sem_relay');
  });
});

describe('MarkAsVerifiedAction — a chave NUNCA vaza', () => {
  it('o log reporta LENGTH, nunca o conteudo da identity key', async () => {
    const lines = [];
    const fakeLogger = { info: (...args) => lines.push(args) };
    const secret = Buffer.from('CHAVE-SUPER-SECRETA-QUE-NAO-PODE-VAZAR');

    const res = await sendMarkAsVerifiedAction({
      relayMessage: async () => {},
      chatJid: PN,
      userJidString: PN,
      verified: true,
      verifiedIdentityKey: secret,
      messageId: 'MVA-SECRET',
      logger: fakeLogger
    });

    assert.equal(res.ok, true);
    const dump = JSON.stringify(lines);
    assert.ok(!dump.includes('CHAVE-SUPER-SECRETA'), 'o conteúdo da chave não aparece no log');
    assert.ok(!dump.includes(secret.toString('base64')), 'nem em base64');
    assert.ok(dump.includes(`identityKeyBytes=${secret.length}`), 'o log traz apenas o tamanho');
  });

  it('erro de validacao da chave nao ecoa o valor', async () => {
    try {
      assertMarkAsVerifiedPayload({ userJidString: PN, verifiedIdentityKey: 12345 });
      assert.fail('deveria ter lançado');
    } catch (e) {
      assert.ok(!String(e.message).includes('12345'), 'a mensagem nao carrega o valor enviado');
    }
  });
});
