/**
 * Acoes de app-state novas — teste de SCHEMA e de PATCH MONTADO.
 *
 * A fork nao expunha seis acoes de `SyncActionValue` (tags 90, 91, 94, 95, 96,
 * 97). O script `scripts/add-appstate-actions.js` as adiciona ao proto gerado e
 * `chatModificationToAppPatch` ganhou os branches correspondentes.
 *
 * O que este teste prova:
 *   1. SCHEMA: os tipos existem, o field number no pai bate com o spec interno
 *      do WhatsApp Web, e encode -> decode -> toObject sobrevive (round-trip);
 *   2. PATCH: `chatModificationToAppPatch` monta `syncAction`, `index`, `type`
 *      e `apiVersion` corretos para cada acao;
 *   3. BYTES: o patch codificado contem a acao (nao e descartado em silencio).
 *
 * O teste NAO afirma semantica do servidor (se o WhatsApp aceita a acao). Ele
 * prova estrutura, mapeamento e bytes — o resto so da para medir no aparelho.
 *
 * Run: node --test tests/appstate-actions.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { proto } from '../WAProto/index.js';
import { chatModificationToAppPatch } from '../lib/Utils/chat-utils.js';

const T = proto.SyncActionValue;

/** Le um varint (a tag do protobuf e varint para field numbers > 15). */
function readVarint(buf, pos = 0) {
  let result = 0;
  let shift = 0;
  let i = pos;
  for (;;) {
    const b = buf[i++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result, next: i };
}

/** field number do primeiro campo codificado. */
const firstFieldNumber = (obj) => readVarint(T.encode(obj).finish()).value >>> 3;

const ACOES = [
  { campo: 'bubbleLockMessageAction', valor: { locked: true }, tag: 90 },
  { campo: 'labelSublistAction', valor: { subListID: 7 }, tag: 91 },
  { campo: 'sharedDeviceAllowlistAction', valor: { allowed: true }, tag: 94 },
  { campo: 'contactManagerMetadataAction', valor: { isHidden: true }, tag: 95 },
  { campo: 'businessFolderActivationAction', valor: { activated: true }, tag: 96 },
  { campo: 'groupHistoryToggleAction', valor: { groupHistoryToggleMode: 1 }, tag: 97 },
];

describe('schema — acoes de app-state novas', () => {
  for (const { campo, valor, tag } of ACOES) {
    it(`${campo}: existe, tag ${tag} no pai e sobrevive ao round-trip`, () => {
      const obj = T.fromObject({ [campo]: valor });
      assert.ok(obj[campo], `${campo} foi mantido pelo fromObject do pai`);

      const enc = T.encode(obj).finish();
      assert.ok(enc.length > 0, 'encode produziu bytes');
      assert.equal(firstFieldNumber(obj), tag, `field number ${tag}`);

      const dec = T.decode(enc);
      assert.ok(dec[campo], `${campo} sobreviveu ao decode`);
      assert.deepEqual(
        JSON.parse(JSON.stringify(T.toObject(dec, { longs: Number })[campo])),
        valor,
        'valores preservados'
      );
    });
  }

  it('groupHistoryToggle tem o enum ON/OFF do spec', () => {
    const E = T.GroupHistoryToggleAction.GroupHistoryToggleMode;
    assert.equal(E.GROUP_HISTORY_TOGGLE_MODE_UNKNOWN, 0);
    assert.equal(E.GROUP_HISTORY_TOGGLE_MODE_ON, 1);
    assert.equal(E.GROUP_HISTORY_TOGGLE_MODE_OFF, 2);
  });

  it('os tipos ficam no namespace SyncActionValue (nao em Message)', () => {
    assert.ok(T.BubbleLockMessageAction, 'BubbleLockMessageAction');
    assert.ok(T.LabelSublistAction, 'LabelSublistAction');
    assert.ok(T.SharedDeviceAllowlistAction, 'SharedDeviceAllowlistAction');
    assert.ok(T.ContactManagerMetadataAction, 'ContactManagerMetadataAction');
    assert.ok(T.BusinessFolderActivationAction, 'BusinessFolderActivationAction');
    assert.ok(T.GroupHistoryToggleAction, 'GroupHistoryToggleAction');
  });
});

describe('patch — chatModificationToAppPatch monta index/type/apiVersion', () => {
  const JID = '5511999999999@s.whatsapp.net';

  const casos = [
    ['bubbleLockMessage', true, 'lock_message', 'regular_low', 'bubbleLockMessageAction'],
    ['labelSublist', 7, 'label_sublist', 'regular', 'labelSublistAction'],
    ['sharedDeviceAllowlist', true, 'shared_device_allowlist', 'regular_high', 'sharedDeviceAllowlistAction'],
    ['contactManagerMetadata', true, 'contact_manager_metadata', 'regular_low', 'contactManagerMetadataAction'],
    ['businessFolderActivation', true, 'business_folder_activation', 'regular_low', 'businessFolderActivationAction'],
    ['groupHistoryToggle', true, 'group_history_toggle', 'regular_low', 'groupHistoryToggleAction'],
  ];

  for (const [mod, valor, indice, tipo, campo] of casos) {
    it(`${mod} -> index "${indice}", type "${tipo}"`, () => {
      const patch = chatModificationToAppPatch({ [mod]: valor }, JID);
      assert.equal(patch.type, tipo, 'colecao (type)');
      assert.deepEqual(patch.index, [indice], 'index');
      assert.equal(patch.operation, proto.SyncdMutation.SyncdOperation.SET, 'operation SET');
      assert.ok(patch.syncAction[campo], `syncAction.${campo} presente`);
    });
  }

  it('groupHistoryToggle ON/OFF usa o enum certo', () => {
    const on = chatModificationToAppPatch({ groupHistoryToggle: true }, JID);
    const off = chatModificationToAppPatch({ groupHistoryToggle: false }, JID);
    const E = T.GroupHistoryToggleAction.GroupHistoryToggleMode;

    assert.equal(on.syncAction.groupHistoryToggleAction.groupHistoryToggleMode, E.GROUP_HISTORY_TOGGLE_MODE_ON);
    assert.equal(off.syncAction.groupHistoryToggleAction.groupHistoryToggleMode, E.GROUP_HISTORY_TOGGLE_MODE_OFF);
  });

  it('a acao nao e descartada em silencio no encode do syncAction', () => {
    for (const [mod, valor, , , campo] of casos) {
      const patch = chatModificationToAppPatch({ [mod]: valor }, JID);
      const enc = T.encode(T.fromObject(patch.syncAction)).finish();
      assert.ok(enc.length > 0, `${mod}: syncAction encode nao ficou vazio`);

      const dec = T.decode(enc);
      assert.ok(dec[campo], `${mod}: ${campo} presente apos decode`);
    }
  });
});
