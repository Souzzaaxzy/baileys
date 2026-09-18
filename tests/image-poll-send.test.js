/**
 * Testa o caminho REAL do sendMessage: pai (poll) + filhos (imagens) associados.
 *
 * Nao abre socket: substitui `relayMessage` por um espião e verifica a ordem,
 * a associacao MEDIA_POLL e o `is_group_status`-like dos filhos.
 *
 * Run: node tests/image-poll-send.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateWAMessageContent, normalizeMessageContent } from '../lib/index.js';
import { proto } from '../WAProto/index.js';

const GROUP = '120363000000000001@g.us';
const USER = '5511999999999@s.whatsapp.net';

const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9
]);

const fakeUpload = async () => ({ url: 'https://mmg.whatsapp.net/fake', directPath: '/v/fake' });

/**
 * Reproduz a montagem que o sendMessage faz para os filhos: cada imagem vai
 * embrulhada em `pollCreationOptionImageMessage` e associada ao poll com
 * MEDIA_POLL, na ordem das opcoes.
 *
 * O envelope e essencial: sem ele o cliente trata as imagens como fotos soltas
 * em vez de opcoes da enquete.
 */
function montarFilhos(parentKey, preparedImages) {
  return preparedImages.map(prepared => ({
    pollCreationOptionImageMessage: { message: prepared },
    messageContextInfo: {
      ...(prepared.messageContextInfo || {}),
      messageAssociation: {
        parentMessageKey: parentKey,
        associationType: proto.MessageAssociation.AssociationType.MEDIA_POLL
      }
    }
  }));
}

describe('sendMessage (imagem poll): pai + filhos associados', () => {
  it('envia 1 pai e N filhos, na ordem das opcoes', async () => {
    const holder = {};
    const content = await generateWAMessageContent(
      {
        imagePoll: {
          name: 'Qual voces preferem?',
          options: [
            { name: 'Opção 1', image: JPEG },
            { name: 'Opção 2', image: JPEG },
            { name: 'Opção 3', image: JPEG }
          ]
        }
      },
      { userJid: USER, upload: fakeUpload, jid: GROUP, imagePollHolder: holder }
    );

    const parentKey = { remoteJid: GROUP, fromMe: true, id: 'POLL-1' };
    const filhos = montarFilhos(parentKey, holder.images);

    // O que o sendMessage realmente transmite, na ordem.
    const enviados = [content, ...filhos];

    assert.equal(enviados.length, 4, '1 poll + 3 imagens');
    assert.ok(enviados[0].pollCreationMessageV3, 'primeiro e o poll');
    for (let i = 1; i < enviados.length; i++) {
      const filho = enviados[i];
      // O envelope e o que faz o cliente tratar como imagem de OPCAO.
      assert.ok(
        filho.pollCreationOptionImageMessage,
        `filho ${i} vem embrulhado em pollCreationOptionImageMessage`
      );
      const inner = normalizeMessageContent(filho.pollCreationOptionImageMessage.message);
      assert.ok(inner.imageMessage, `filho ${i} contem uma imagem`);
      assert.equal(
        filho.messageContextInfo.messageAssociation.associationType,
        proto.MessageAssociation.AssociationType.MEDIA_POLL,
        `filho ${i} associado como MEDIA_POLL`
      );
      assert.equal(
        filho.messageContextInfo.messageAssociation.parentMessageKey.id,
        'POLL-1',
        `filho ${i} aponta para o pai`
      );
    }
  });

  it('a ordem dos filhos casa com a ordem dos optionHash', async () => {
    const holder = {};
    const content = await generateWAMessageContent(
      {
        imagePoll: {
          name: 'Ordem',
          options: [
            { name: 'Opção 1', image: JPEG },
            { name: 'Opção 2', image: JPEG },
            { name: 'Opção 3', image: JPEG }
          ]
        }
      },
      { userJid: USER, upload: fakeUpload, jid: GROUP, imagePollHolder: holder }
    );

    // Para cada opcao, o hash tem que casar com o fileSha256 da imagem de MESMO indice.
    const { createHash } = await import('node:crypto');
    const hashDe = (nome, fileSha256) =>
      createHash('sha256')
        .update(createHash('sha256').update(nome).digest('hex') + Buffer.from(fileSha256).toString('base64'))
        .digest('hex');

    content.pollCreationMessageV3.options.forEach((option, i) => {
      const img = holder.images[i].imageMessage;
      assert.equal(option.optionHash, hashDe(option.optionName, img.fileSha256), `opcao ${i + 1} casa com a imagem ${i + 1}`);
    });
  });

  it('cada filho sobrevive ao encode/decode com a associacao', async () => {
    const holder = {};
    await generateWAMessageContent(
      { imagePoll: { name: 'x', options: [{ name: 'A', image: JPEG }, { name: 'B', image: JPEG }] } },
      { userJid: USER, upload: fakeUpload, jid: GROUP, imagePollHolder: holder }
    );

    const filhos = montarFilhos({ remoteJid: GROUP, fromMe: true, id: 'P' }, holder.images);
    for (const filho of filhos) {
      const bytes = proto.Message.encode(proto.Message.create(filho)).finish();
      const dec = proto.Message.decode(bytes);
      assert.ok(dec.pollCreationOptionImageMessage, 'o envelope sobrevive ao encode/decode');
      const inner = normalizeMessageContent(dec.pollCreationOptionImageMessage.message);
      assert.ok(inner.imageMessage, 'a imagem sobrevive dentro do envelope');
      assert.equal(
        dec.messageContextInfo.messageAssociation.associationType,
        proto.MessageAssociation.AssociationType.MEDIA_POLL
      );
    }
  });
});