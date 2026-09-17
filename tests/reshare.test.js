/**
 * Testes do suporte a `canBeReshared` (botão de repostar) na fork.
 *
 * Contexto: status postado por biblioteca NÃO mostra o botão de repostar no
 * cliente, mesmo com "Allow Sharing" ligado nas configurações de privacidade da
 * conta — o cliente lê essa permissão do próprio payload
 * (contextInfo.featureEligibilities.canBeReshared). Ver
 * WhiskeySockets/Baileys#2633.
 *
 * IMPORTANTE nos testes: `generateWAMessageContent` MUTA o objeto de entrada
 * (`delete message.groupStatus` / `delete message.canBeReshared`). Reusar o
 * mesmo objeto entre casos faz o teste mentir, então cada caso cria o seu.
 *
 * Run: node --test tests/reshare.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateWAMessage, generateWAMessageContent, normalizeMessageContent } from '../lib/index.js';

const GROUP = '120363000000000001@g.us';
const USER = '5511999999999@s.whatsapp.net';
const opts = { userJid: USER, upload: async () => ({ url: 'https://x/y', directPath: '/v/x' }) };

/** Objeto de mídia fresco a cada uso (a lib muta a entrada). */
const midia = {
  texto: () => ({ text: 'Bom dia' }),
  imagem: () => ({ image: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) }),
  video: () => ({ video: Buffer.from([0, 0, 0, 0x18]) }),
  audio: () => ({ audio: Buffer.from('OggS'), mimetype: 'audio/ogg' }),
};

/** Extrai o conteúdo interno e o contextInfo, mesmo encapsulado. */
function contextoDe(message) {
  const inner = normalizeMessageContent(message);
  const tipo = Object.keys(inner)[0];
  return { tipo, ci: inner[tipo]?.contextInfo };
}

describe('canBeReshared: marca a permissão no payload', () => {
  it('define featureEligibilities.canBeReshared = true', async () => {
    const content = await generateWAMessageContent(
      { text: 'oi', canBeReshared: true },
      { ...opts, jid: GROUP }
    );
    const { ci } = contextoDe(content);
    assert.equal(ci?.featureEligibilities?.canBeReshared, true);
  });

  it('não mexe no payload quando a flag não é passada', async () => {
    const content = await generateWAMessageContent({ text: 'oi' }, { ...opts, jid: GROUP });
    const { ci } = contextoDe(content);
    assert.equal(ci?.featureEligibilities, undefined);
  });

  it('remove a flag da entrada (não vaza campo desconhecido no proto)', async () => {
    const entrada = { text: 'oi', canBeReshared: true };
    await generateWAMessageContent(entrada, { ...opts, jid: GROUP });
    assert.equal('canBeReshared' in entrada, false);
  });

  it('respeita canBeReshared: false (não marca)', async () => {
    const content = await generateWAMessageContent({ text: 'oi', canBeReshared: false }, { ...opts, jid: GROUP });
    const { ci } = contextoDe(content);
    assert.equal(ci?.featureEligibilities, undefined);
  });

  it('preserva contextInfo já existente ao adicionar a flag', async () => {
    const content = await generateWAMessageContent(
      { text: 'oi', canBeReshared: true, contextInfo: { mentionedJid: [USER] } },
      { ...opts, jid: GROUP }
    );
    const { ci } = contextoDe(content);
    assert.equal(ci?.featureEligibilities?.canBeReshared, true);
    assert.deepEqual(ci?.mentionedJid, [USER], 'o mentionedJid não pode ser perdido');
  });

  it('mescla com featureEligibilities já existente, sem sobrescrever outros campos', async () => {
    const content = await generateWAMessageContent(
      {
        text: 'oi',
        canBeReshared: true,
        contextInfo: { featureEligibilities: { cannotBeRanked: true } },
      },
      { ...opts, jid: GROUP }
    );
    const { ci } = contextoDe(content);
    assert.equal(ci?.featureEligibilities?.canBeReshared, true);
    assert.equal(ci?.featureEligibilities?.cannotBeRanked, true, 'campo existente preservado');
  });
});

describe('canBeReshared: convive com os wrappers (groupStatus, spoiler, viewOnce)', () => {
  it('groupStatus: mantém o V2, o isGroupStatus E a permissão', async () => {
    const wa = await generateWAMessage(
      GROUP,
      { text: 'oi', groupStatus: true, canBeReshared: true },
      { ...opts }
    );
    assert.ok(wa.message.groupStatusMessageV2, 'encapsulado em groupStatusMessageV2');
    const { ci } = contextoDe(wa.message);
    assert.equal(ci?.isGroupStatus, true);
    assert.equal(ci?.featureEligibilities?.canBeReshared, true);
  });

  it('spoiler: idem', async () => {
    const wa = await generateWAMessage(GROUP, { text: 'oi', spoiler: true, canBeReshared: true }, { ...opts });
    assert.ok(wa.message.spoilerMessage, 'encapsulado em spoilerMessage');
    const { ci } = contextoDe(wa.message);
    assert.equal(ci?.isSpoiler, true);
    assert.equal(ci?.featureEligibilities?.canBeReshared, true);
  });

  it('viewOnce: idem', async () => {
    const wa = await generateWAMessage(
      GROUP,
      { image: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), viewOnce: true, canBeReshared: true },
      { ...opts }
    );
    const { ci } = contextoDe(wa.message);
    assert.equal(ci?.featureEligibilities?.canBeReshared, true);
  });

  it('sobrevive junto com citação (quoted)', async () => {
    const citada = {
      key: { remoteJid: GROUP, fromMe: false, id: 'CMD', participant: USER },
      message: { extendedTextMessage: { text: '!statusgrupo' } },
    };
    const wa = await generateWAMessage(
      GROUP,
      { text: 'oi', groupStatus: true, canBeReshared: true },
      { ...opts, quoted: citada }
    );
    const { ci } = contextoDe(wa.message);
    assert.equal(ci?.featureEligibilities?.canBeReshared, true, 'a citação não pode derrubar a permissão');
    assert.equal(ci?.stanzaId, 'CMD', 'a citação continua funcionando');
    assert.equal(ci?.isGroupStatus, true, 'o group status continua marcado');
  });
});

describe('canBeReshared: vale para todos os tipos que o status usa', () => {
  for (const [nome, cria] of Object.entries(midia)) {
    it(`${nome}: recebe a permissão`, async () => {
      const wa = await generateWAMessage(GROUP, { ...cria(), groupStatus: true, canBeReshared: true }, { ...opts });
      const { ci } = contextoDe(wa.message);
      assert.equal(ci?.featureEligibilities?.canBeReshared, true, `${nome} sem canBeReshared`);
    });
  }
});

describe('regressão: mensagem normal segue intacta', () => {
  it('sem a flag, nada muda no contextInfo', async () => {
    const wa = await generateWAMessage(GROUP, { text: 'mensagem comum' }, { ...opts });
    const { ci, tipo } = contextoDe(wa.message);
    assert.equal(tipo, 'extendedTextMessage', 'texto continua indo como texto');
    assert.equal(ci?.featureEligibilities, undefined, 'sem permissão de reshare');
    assert.equal(ci?.isGroupStatus, undefined, 'não vira group status');
    assert.equal(wa.message.groupStatusMessageV2 ?? undefined, undefined, 'não é encapsulado');
  });

  it('menções continuam funcionando', async () => {
    const wa = await generateWAMessage(GROUP, { text: 'oi', mentions: [USER] }, { ...opts });
    const { ci } = contextoDe(wa.message);
    assert.deepEqual(ci?.mentionedJid, [USER]);
  });
});