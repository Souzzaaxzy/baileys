/**
 * Testes do suporte experimental a enquetes com imagens ("photo poll").
 *
 * O formato no fio e:
 *   - um pai `pollCreationMessageV3` com `pollContentType: IMAGE` e um
 *     `optionHash` por opcao;
 *   - um `imageMessage` por opcao, cada um associado ao pai via
 *     `messageContextInfo.messageAssociation` (MEDIA_POLL).
 *
 * IMPORTANTE nos testes: `generateWAMessageContent` MUTA a entrada
 * (`delete message.imagePoll`), entao cada caso cria o seu proprio objeto.
 *
 * Run: node --test tests/image-poll.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generatePollOptionHash, generateWAMessageContent, normalizeMessageContent } from '../lib/index.js';
import { proto } from '../WAProto/index.js';

const GROUP = '120363000000000001@g.us';
const USER = '5511999999999@s.whatsapp.net';

// Imagem minima valida (JPEG) para o pipeline de midia aceitar.
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9
]);

const fakeUpload = async () => ({ url: 'https://mmg.whatsapp.net/fake', directPath: '/v/fake' });

/** options com o holder que o sendMessage usa para receber as imagens. */
const opts = () => ({
  userJid: USER,
  upload: fakeUpload,
  jid: GROUP,
  imagePollHolder: {}
});

/** Objeto de imagePoll fresco (a lib muta a entrada). */
const imagePoll = (names, extra = {}) => ({
  name: 'Qual voces preferem?',
  options: names.map(name => ({ name, image: JPEG })),
  ...extra
});

describe('image poll: monta o poll com pollContentType IMAGE', () => {
  it('usa pollCreationMessageV3 com pollContentType IMAGE', async () => {
    const content = await generateWAMessageContent({ imagePoll: imagePoll(['A', 'B']) }, opts());

    const poll = content.pollCreationMessageV3;
    assert.ok(poll, 'deve ser pollCreationMessageV3');
    assert.equal(poll.pollContentType, proto.Message.PollContentType.IMAGE);
    assert.equal(poll.name, 'Qual voces preferem?');
    assert.equal(poll.options.length, 2);
    assert.equal(poll.selectableOptionsCount, 1, 'default single select');
  });

  it('cada opcao tem optionName e optionHash', async () => {
    const content = await generateWAMessageContent({ imagePoll: imagePoll(['A', 'B']) }, opts());

    for (const option of content.pollCreationMessageV3.options) {
      assert.ok(option.optionName, 'optionName presente');
      assert.ok(option.optionHash, 'optionHash presente');
      assert.match(option.optionHash, /^[0-9a-f]{64}$/, 'optionHash e sha256 em hex');
    }
  });

  it('gera o messageSecret do poll', async () => {
    const content = await generateWAMessageContent({ imagePoll: imagePoll(['A', 'B']) }, opts());
    assert.ok(content.messageContextInfo?.messageSecret, 'messageSecret presente');
    assert.equal(content.messageContextInfo.messageSecret.length, 32);
  });

  it('preserva a ORDEM das opcoes', async () => {
    const content = await generateWAMessageContent(
      { imagePoll: imagePoll(['terceira', 'primeira', 'segunda']) },
      opts()
    );
    const names = content.pollCreationMessageV3.options.map(o => o.optionName);
    assert.deepEqual(names, ['terceira', 'primeira', 'segunda'], 'nao reordena');
  });

  it('preserva acentos e emojis no nome da opcao e da pergunta', async () => {
    const content = await generateWAMessageContent(
      { imagePoll: { name: 'Qual e o melhor? 🤔', options: [{ name: 'Opcao ção', image: JPEG }, { name: 'Opcao 💜', image: JPEG }] } },
      opts()
    );
    assert.equal(content.pollCreationMessageV3.name, 'Qual e o melhor? 🤔');
    assert.deepEqual(
      content.pollCreationMessageV3.options.map(o => o.optionName),
      ['Opcao ção', 'Opcao 💜']
    );
  });
});

describe('image poll: as imagens saem como filhos associados', () => {
  it('devolve uma imagem preparada por opcao, na ordem', async () => {
    const o = opts();
    await generateWAMessageContent({ imagePoll: imagePoll(['A', 'B', 'C']) }, o);

    assert.equal(o.imagePollHolder.images.length, 3, 'uma imagem por opcao');
    for (const prepared of o.imagePollHolder.images) {
      assert.ok(prepared.imageMessage, 'e um imageMessage');
      assert.ok(prepared.imageMessage.fileSha256, 'tem fileSha256');
    }
  });

  it('o optionHash combina o nome da opcao com o fileSha256 da SUA imagem', async () => {
    const o = opts();
    const content = await generateWAMessageContent({ imagePoll: imagePoll(['A', 'B']) }, o);

    const [imgA, imgB] = o.imagePollHolder.images.map(p => p.imageMessage);
    assert.equal(
      content.pollCreationMessageV3.options[0].optionHash,
      generatePollOptionHash('A', imgA.fileSha256),
      'opcao 1 ligada a imagem 1'
    );
    assert.equal(
      content.pollCreationMessageV3.options[1].optionHash,
      generatePollOptionHash('B', imgB.fileSha256),
      'opcao 2 ligada a imagem 2'
    );
    assert.notEqual(
      content.pollCreationMessageV3.options[0].optionHash,
      content.pollCreationMessageV3.options[1].optionHash,
      'imagens diferentes geram hashes diferentes'
    );
  });

  it('o hash do cliente: hex(sha256(hex(sha256(nome)) + base64(fileSha256)))', async () => {
    const o = opts();
    const content = await generateWAMessageContent({ imagePoll: imagePoll(['A', 'B']) }, o);

    // Reimplementacao independente da formula, direto com node:crypto.
    const { createHash } = await import('node:crypto');
    const imgA = o.imagePollHolder.images[0].imageMessage;
    const nameHashHex = createHash('sha256').update('A').digest('hex');
    const fileHashB64 = Buffer.from(imgA.fileSha256).toString('base64');
    const esperado = createHash('sha256').update(nameHashHex + fileHashB64).digest('hex');

    assert.equal(content.pollCreationMessageV3.options[0].optionHash, esperado);
  });
});

describe('image poll: sobrevive ao encode/decode do proto', () => {
  it('o pai vai no fio com pollContentType IMAGE e os hashes', async () => {
    const o = opts();
    const content = await generateWAMessageContent({ imagePoll: imagePoll(['A', 'B']) }, o);

    const bytes = proto.Message.encode(proto.Message.create(content)).finish();
    const dec = proto.Message.decode(bytes);
    const poll = dec.pollCreationMessageV3;

    assert.ok(poll, 'continua pollCreationMessageV3 depois do round-trip');
    assert.equal(poll.pollContentType, proto.Message.PollContentType.IMAGE);
    assert.equal(poll.options.length, 2);
    assert.equal(poll.options[0].optionName, 'A');
    assert.match(poll.options[0].optionHash, /^[0-9a-f]{64}$/);
    assert.ok(dec.messageContextInfo?.messageSecret, 'messageSecret sobrevive');
  });

  it('o filho vai no fio como imageMessage com a associacao MEDIA_POLL', async () => {
    const o = opts();
    await generateWAMessageContent({ imagePoll: imagePoll(['A', 'B']) }, o);

    // Mesmo caminho que o sendMessage usa para os filhos.
    const child = o.imagePollHolder.images[0];
    const inner = normalizeMessageContent(child);
    assert.ok(inner.imageMessage, 'filho e um imageMessage');

    const comAssociacao = {
      ...child,
      messageContextInfo: {
        ...(child.messageContextInfo || {}),
        messageAssociation: {
          parentMessageKey: { remoteJid: GROUP, fromMe: true, id: 'PARENT' },
          associationType: proto.MessageAssociation.AssociationType.MEDIA_POLL
        }
      }
    };

    const bytes = proto.Message.encode(proto.Message.create(comAssociacao)).finish();
    const dec = proto.Message.decode(bytes);
    assert.ok(dec.imageMessage, 'imageMessage sobrevive');
    assert.equal(
      dec.messageContextInfo.messageAssociation.associationType,
      proto.MessageAssociation.AssociationType.MEDIA_POLL
    );
    assert.equal(dec.messageContextInfo.messageAssociation.parentMessageKey.id, 'PARENT');
  });
});

describe('image poll: validacoes', () => {
  it('recusa menos de 2 opcoes', async () => {
    await assert.rejects(
      () => generateWAMessageContent({ imagePoll: imagePoll(['A']) }, opts()),
      /at least 2 options/
    );
  });

  it('recusa opcao sem nome', async () => {
    await assert.rejects(
      () => generateWAMessageContent(
        { imagePoll: { name: 'x', options: [{ name: '', image: JPEG }, { name: 'B', image: JPEG }] } },
        opts()
      ),
      /needs a name/
    );
  });

  it('recusa opcao sem imagem', async () => {
    await assert.rejects(
      () => generateWAMessageContent(
        { imagePoll: { name: 'x', options: [{ name: 'A' }, { name: 'B', image: JPEG }] } },
        opts()
      ),
      /needs an image/
    );
  });

  it('recusa selectableCount fora do intervalo', async () => {
    await assert.rejects(
      () => generateWAMessageContent(
        { imagePoll: { name: 'x', selectableCount: 5, options: [{ name: 'A', image: JPEG }, { name: 'B', image: JPEG }] } },
        opts()
      ),
      /selectableCount/
    );
  });

  it('aceita multipla selecao dentro do limite', async () => {
    const content = await generateWAMessageContent(
      { imagePoll: imagePoll(['A', 'B', 'C'], { selectableCount: 2 }) },
      opts()
    );
    assert.equal(content.pollCreationMessageV3.selectableOptionsCount, 2);
  });
});

describe('regressao: enquete normal segue intacta', () => {
  it('poll de texto continua virando pollCreationMessage (sem pollContentType)', async () => {
    const content = await generateWAMessageContent(
      { poll: { name: 'Escolha', values: ['A', 'B', 'C'], selectableCount: 1 } },
      { userJid: USER, upload: fakeUpload, jid: GROUP }
    );

    assert.ok(content.pollCreationMessageV3, 'single select usa V3');
    assert.equal(content.pollCreationMessageV3.pollContentType, undefined, 'sem pollContentType');
    for (const option of content.pollCreationMessageV3.options) {
      assert.equal(option.optionHash, undefined, 'poll normal nao tem optionHash');
    }
  });

  it('multipla escolha continua em pollCreationMessage', async () => {
    const content = await generateWAMessageContent(
      { poll: { name: 'Escolha', values: ['A', 'B', 'C'], selectableCount: 2 } },
      { userJid: USER, upload: fakeUpload, jid: GROUP }
    );
    assert.ok(content.pollCreationMessage, 'multipla escolha usa pollCreationMessage');
    assert.equal(content.pollCreationMessage.pollContentType, undefined);
  });
});