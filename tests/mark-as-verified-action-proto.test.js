/**
 * MarkAsVerifiedAction — teste de SCHEMA e SERIALIZACAO (Nivel 1).
 *
 * Prova que a estrutura adicionada ao WAProto gerado:
 *   - existe com o caminho correto (Message.MarkAsVerifiedAction);
 *   - o enum do pai tem MARK_AS_VERIFIED_ACTION = 36;
 *   - os field numbers batem com o spec interno do WhatsApp Web;
 *   - encode -> decode -> toObject sobrevive (round-trip);
 *   - `verify` rejeita tipos errados;
 *   - o campo do PAI (32) viaja dentro de uma ProtocolMessage real.
 *
 * O teste NAO afirma semantica. Ele prova apenas estrutura e bytes.
 *
 * Run: node tests/mark-as-verified-action-proto.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { proto } from '../WAProto/index.js';

const M = proto.Message;

describe('schema — MarkAsVerifiedAction', () => {
  it('existe em proto.Message e no namespace do pai', () => {
    assert.ok(M.MarkAsVerifiedAction, 'Message.MarkAsVerifiedAction existe');
    assert.equal(typeof M.MarkAsVerifiedAction.encode, 'function');
    assert.equal(typeof M.MarkAsVerifiedAction.decode, 'function');
    assert.equal(M.MarkAsVerifiedAction.getTypeUrl(), 'type.googleapis.com/proto.Message.MarkAsVerifiedAction');
  });

  it('protocol message type MARK_AS_VERIFIED_ACTION = 36', () => {
    assert.equal(M.ProtocolMessage.Type.MARK_AS_VERIFIED_ACTION, 36);
    assert.equal(M.ProtocolMessage.Type[36], 'MARK_AS_VERIFIED_ACTION');
  });

  it('field numbers batem com o spec interno do WhatsApp Web', () => {
    // Encoda cada campo isoladamente e confere a TAG produzida.
    const tagFor = (obj) => Array.from(M.MarkAsVerifiedAction.encode(obj).finish()).slice(0, 1)[0];

    // id 1, wireType 2 (string) -> (1<<3)|2 = 10
    assert.equal(tagFor({ userJidString: 'x' }), 10, 'userJidString = campo 1');
    // id 2, wireType 0 (bool) -> (2<<3)|0 = 16
    assert.equal(tagFor({ verified: true }), 16, 'verified = campo 2');
    // id 3, wireType 2 (bytes) -> (3<<3)|2 = 26
    assert.equal(tagFor({ verifiedIdentityKey: Buffer.from([1]) }), 26, 'verifiedIdentityKey = campo 3');
    // id 4, wireType 0 (uint64) -> (4<<3)|0 = 32
    assert.equal(tagFor({ actionSeq: 7 }), 32, 'actionSeq = campo 4');
  });

  it('a ProtocolMessage carrega o campo 32 (markAsVerifiedAction)', () => {
    // id 32, wireType 2 (message) -> (32<<3)|2 = 258 -> varint 0x82 0x02.
    // A tag do campo vem DEPOIS dos campos de numero menor que estiverem
    // presentes, entao encodamos SO o campo novo para isolar a tag.
    const bytes = M.ProtocolMessage.encode({
      markAsVerifiedAction: { userJidString: 'a@s.whatsapp.net', verified: true }
    }).finish();
    assert.deepEqual(Array.from(bytes).slice(0, 2), [0x82, 0x02], 'campo 32 tem a tag esperada (258)');

    // E continua sendo o campo 32 quando ha outros campos antes dele.
    const withType = M.ProtocolMessage.encode({
      type: M.ProtocolMessage.Type.MARK_AS_VERIFIED_ACTION,
      markAsVerifiedAction: { verified: true }
    }).finish();
    const dec = M.ProtocolMessage.decode(withType);
    assert.equal(dec.type, M.ProtocolMessage.Type.MARK_AS_VERIFIED_ACTION);
    assert.equal(dec.markAsVerifiedAction.verified, true, 'campo aninhado sobrevive ao round-trip');
  });
});

describe('serializacao — round-trip', () => {
  it('encode -> decode preserva os 4 campos', () => {
    const original = {
      userJidString: '5511999999999@s.whatsapp.net',
      verified: true,
      verifiedIdentityKey: Buffer.from('chave-de-teste', 'utf-8'),
      actionSeq: 42
    };
    const bytes = M.MarkAsVerifiedAction.encode(original).finish();
    const dec = M.MarkAsVerifiedAction.decode(bytes);

    assert.equal(dec.userJidString, original.userJidString);
    assert.equal(dec.verified, true);
    assert.deepEqual(Buffer.from(dec.verifiedIdentityKey), original.verifiedIdentityKey);
    assert.equal(Number(dec.actionSeq), 42);
  });

  it('verified=false e preservado como FALSO (nao vira ausente)', () => {
    const bytes = M.MarkAsVerifiedAction.encode({ verified: false }).finish();
    const dec = M.MarkAsVerifiedAction.decode(bytes);
    assert.equal(dec.verified, false);
    // `null` (default) e diferente de `false` (presente): a distincao importa
    // porque so um dos dois foi realmente enviado.
    assert.ok(M.MarkAsVerifiedAction.toObject(dec).hasOwnProperty('verified'));
  });

  it('round-trip dentro da ProtocolMessage', () => {
    const msg = {
      type: M.ProtocolMessage.Type.MARK_AS_VERIFIED_ACTION,
      markAsVerifiedAction: { userJidString: 'x@lid', verified: true, actionSeq: 1 }
    };
    const dec = M.ProtocolMessage.decode(M.ProtocolMessage.encode(msg).finish());
    assert.equal(dec.type, M.ProtocolMessage.Type.MARK_AS_VERIFIED_ACTION);
    assert.ok(dec.markAsVerifiedAction, 'o campo aninhado sobrevive');
    assert.equal(dec.markAsVerifiedAction.userJidString, 'x@lid');
    assert.equal(dec.markAsVerifiedAction.verified, true);
  });

  it('actionSeq grande (uint64) nao perde precisao', () => {
    const big = '18446744073709551615'; // 2^64-1
    const bytes = M.MarkAsVerifiedAction.encode({ actionSeq: big }).finish();
    const dec = M.MarkAsVerifiedAction.decode(bytes);
    assert.equal(dec.actionSeq.toString(), big, 'uint64 preservado como string pelo Long');
  });

  it('campos ausentes continuam ausentes (nao inventa default)', () => {
    const bytes = M.MarkAsVerifiedAction.encode({}).finish();
    assert.equal(bytes.length, 0, 'sem campos, zero bytes');
    const dec = M.MarkAsVerifiedAction.decode(bytes);
    assert.equal(dec.userJidString, null);
    assert.equal(dec.verified, null);
    assert.equal(dec.verifiedIdentityKey, null);
    assert.equal(dec.actionSeq, null);
  });
});

describe('validacao', () => {
  it('verify aceita os tipos corretos', () => {
    assert.equal(M.MarkAsVerifiedAction.verify({
      userJidString: 'a@b',
      verified: true,
      verifiedIdentityKey: Buffer.from([1, 2]),
      actionSeq: 5
    }), null);
  });

  it('verify rejeita tipos errados', () => {
    assert.match(M.MarkAsVerifiedAction.verify({ userJidString: 123 }), /userJidString/);
    assert.match(M.MarkAsVerifiedAction.verify({ verified: 'sim' }), /verified/);
    assert.match(M.MarkAsVerifiedAction.verify({ verifiedIdentityKey: 5 }), /verifiedIdentityKey/);
    assert.match(M.MarkAsVerifiedAction.verify({ actionSeq: {} }), /actionSeq/);
  });

  it('fromObject converte tipos (bool, base64, uint64)', () => {
    const obj = M.MarkAsVerifiedAction.fromObject({
      userJidString: 'x',
      verified: 1,
      verifiedIdentityKey: Buffer.from([9]).toString('base64'),
      actionSeq: '10'
    });
    assert.equal(obj.verified, true, '1 -> true');
    assert.deepEqual(Buffer.from(obj.verifiedIdentityKey), Buffer.from([9]), 'base64 -> bytes');
    assert.equal(Number(obj.actionSeq), 10, 'string -> uint64');
  });
});
