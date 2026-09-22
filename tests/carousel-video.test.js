/**
 * Carousel com VÍDEO (e robustez das cards).
 *
 * Antes desta mudança o carrossel só aceitava imagem/produto de forma confiável,
 * e três caminhos quebravam ou descartavam mídia em silêncio:
 *
 *   1. card de vídeo com `ptv: true` era recusado ("Invalid media type for
 *      carousel card") porque o preparo devolve `ptvMessage`, que
 *      `hasValidCarouselHeader` não conhecia;
 *   2. card de mídia SEM `caption` estourava "Cannot convert undefined or null
 *      to object" no `Object.assign(carouselCard.header, ...)`, porque o header
 *      só era criado dentro do `if (caption)`;
 *   3. card sem `nativeFlow` estourava "Cannot read properties of undefined
 *      (reading 'buttons')" em `prepareNativeFlowButtons`;
 *   4. card com mídia usando `text` (em vez de `caption`) perdia a mídia: o
 *      ramo do `text` nem olhava o header.
 *
 * O teste roda o caminho REAL (`generateWAMessageContent`), com o upload
 * instrumentado, e confere o proto montado — não só que "não lançou".
 *
 * Run: node --test tests/carousel-video.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { proto } from '../WAProto/index.js';
import {
  hasValidCarouselHeader,
  resolveCarouselHeader,
  generateWAMessageContent,
  generateWAMessageFromContent
} from '../lib/Utils/messages.js';

const USER = '5511999999999@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';

/** JPEG mínimo (assinatura + EOI) para os cards de imagem. */
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9
]);

/** Buffer com um box `ftyp` no início, como um MP4 real começa. */
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isom'),
  Buffer.alloc(64)
]);

/** Upload falso: registra o mediaType de cada arquivo enviado. */
const makeUpload = () => {
  const calls = [];
  const upload = async (_filePath, opts) => {
    calls.push(opts?.mediaType);
    return { url: 'https://mmg.whatsapp.net/fake', directPath: '/v/fake' };
  };
  return { upload, calls };
};

/** Monta o conteúdo pelo caminho real da fork. */
async function build(content, jid = GROUP) {
  const { upload, calls } = makeUpload();
  const message = await generateWAMessageContent(content, { userJid: USER, upload, jid });
  return { message, calls, carousel: message?.interactiveMessage?.carouselMessage };
}

const mediaOf = (card) => {
  const header = card?.header || {};
  if (header.videoMessage) return 'video';
  if (header.imageMessage) return 'image';
  if (header.productMessage) return 'product';
  if (header.locationMessage) return 'location';
  return 'NONE';
};

const cardTypeName = (carousel) =>
  proto.Message.InteractiveMessage.CarouselMessage.CarouselCardType[carousel?.carouselCardType];

describe('carousel — card de vídeo', () => {
  it('vídeo + caption vira header.videoMessage e sobe como mediaType "video"', async () => {
    const { carousel, calls } = await build({
      text: 'Carrossel com vídeo',
      cards: [{ video: MP4, mimetype: 'video/mp4', caption: '🎬 Clipe 1' }]
    });

    assert.equal(carousel.cards.length, 1);
    assert.equal(mediaOf(carousel.cards[0]), 'video');
    assert.equal(carousel.cards[0].header.hasMediaAttachment, true);
    assert.equal(carousel.cards[0].body.text, '🎬 Clipe 1');
    assert.deepEqual(calls, ['video'], 'o vídeo foi para o pipeline como "video"');
  });

  it('o vídeo chega ao proto (encode/decode) dentro do header da card', async () => {
    const { carousel } = await build({
      text: 't',
      cards: [{ video: MP4, mimetype: 'video/mp4', caption: 'v' }]
    });

    const decoded = proto.Message.InteractiveMessage.CarouselMessage.decode(
      proto.Message.InteractiveMessage.CarouselMessage.encode(carousel).finish()
    );

    assert.ok(decoded.cards[0].header.videoMessage, 'header.videoMessage sobrevive ao round-trip');
    assert.equal(decoded.cards[0].header.hasMediaAttachment, true);
    assert.equal(decoded.cards[0].body.text, 'v');
  });

  it('preserva mimetype, gifPlayback e seconds do card', async () => {
    const { carousel } = await build({
      text: 't',
      cards: [{
        video: MP4,
        mimetype: 'video/mp4',
        gifPlayback: true,
        seconds: 9,
        caption: 'gif'
      }]
    });

    const video = carousel.cards[0].header.videoMessage;
    assert.equal(video.mimetype, 'video/mp4');
    assert.equal(video.gifPlayback, true);
    assert.equal(video.seconds, 9);
  });

  it('vídeo com `ptv: true` também é aceito (vira header.videoMessage)', async () => {
    const { carousel } = await build({
      text: 't',
      cards: [{ video: MP4, mimetype: 'video/mp4', ptv: true, caption: 'nota de vídeo' }]
    });

    assert.equal(mediaOf(carousel.cards[0]), 'video');
    assert.equal(carousel.cards[0].header.videoMessage.ptv, undefined,
      'o ptvMessage não vaza cru no header');
  });

  it('carrossel MISTO: imagem, vídeo e imagem, na ordem original', async () => {
    const { carousel, calls } = await build({
      text: 'misto',
      cards: [
        { image: JPEG, caption: '🖼️ imagem 1' },
        { video: MP4, mimetype: 'video/mp4', caption: '🎬 vídeo' },
        { image: JPEG, caption: '🖼️ imagem 2' }
      ]
    });

    assert.equal(carousel.cards.length, 3);
    assert.deepEqual(carousel.cards.map(mediaOf), ['image', 'video', 'image']);
    assert.deepEqual(carousel.cards.map((c) => c.body.text), ['🖼️ imagem 1', '🎬 vídeo', '🖼️ imagem 2']);
    assert.deepEqual(calls, ['image', 'video', 'image']);
  });
});

describe('carousel — cards antes quebravam (regressão)', () => {
  it('card de vídeo SEM caption não estoura mais (header sempre criado)', async () => {
    const { carousel } = await build({
      text: 't',
      cards: [{ video: MP4, mimetype: 'video/mp4' }]
    });

    assert.equal(mediaOf(carousel.cards[0]), 'video');
    assert.equal(carousel.cards[0].header.hasMediaAttachment, true);
    assert.equal(carousel.cards[0].body, undefined, 'sem caption, sem body de texto');
  });

  it('card de imagem SEM caption também monta o header', async () => {
    const { carousel } = await build({
      text: 't',
      cards: [{ image: JPEG }]
    });

    assert.equal(mediaOf(carousel.cards[0]), 'image');
    assert.equal(carousel.cards[0].header.hasMediaAttachment, true);
  });

  it('card sem nativeFlow não derruba o carrossel', async () => {
    const { carousel } = await build({
      text: 't',
      cards: [
        { image: JPEG, caption: 'a' },
        { video: MP4, mimetype: 'video/mp4', caption: 'b' }
      ]
    });

    assert.equal(carousel.cards.length, 2);
    assert.equal(carousel.cards[0].nativeFlowMessage.buttons.length, 0);
    assert.equal(carousel.cards[1].nativeFlowMessage.buttons.length, 0);
  });

  it('card com mídia e `text` (em vez de caption) NÃO perde a mídia', async () => {
    const { carousel } = await build({
      text: 't',
      cards: [{ video: MP4, mimetype: 'video/mp4', text: 'corpo pelo text' }]
    });

    assert.equal(mediaOf(carousel.cards[0]), 'video', 'a mídia continua no header');
    assert.equal(carousel.cards[0].body.text, 'corpo pelo text');
  });

  it('card de texto puro continua sem header (nada de header vazio inventado)', async () => {
    const { carousel } = await build({
      text: 't',
      cards: [{ text: 'só texto' }]
    });

    assert.equal(mediaOf(carousel.cards[0]), 'NONE');
    assert.equal(carousel.cards[0].header, undefined);
    assert.equal(carousel.cards[0].body.text, 'só texto');
  });

  it('mídia inválida continua recusada com erro claro', async () => {
    await assert.rejects(
      () => build({ text: 't', cards: [{ document: Buffer.from('x'), mimetype: 'application/pdf', caption: 'd' }] }),
      /Invalid media type for carousel card/
    );
  });

  it('titulo/subtitle do card sobrevivem junto com o vídeo', async () => {
    const { carousel } = await build({
      text: 't',
      cards: [{ video: MP4, mimetype: 'video/mp4', title: 'Título', subtitle: 'Subtítulo', caption: 'c' }]
    });

    assert.equal(carousel.cards[0].header.title, 'Título');
    assert.equal(carousel.cards[0].header.subtitle, 'Subtítulo');
    assert.equal(mediaOf(carousel.cards[0]), 'video');
  });
});

describe('carousel — forma do exemplo do README', () => {
  it('o exemplo de imagem do README continua montando igual', async () => {
    const { carousel, calls } = await build({
      text: '🗂️ Interactive with Carousel!',
      footer: '@souzzaaxzy/baileys',
      cards: [
        {
          image: JPEG,
          caption: '🖼️ Image 1',
          footer: '🏷️ Pinterest',
          nativeFlow: [{ text: '🌐 Source', url: 'https://github.com/Souzzaaxzy/baileys', useWebview: true }]
        },
        {
          image: JPEG,
          caption: '🖼️ Image 2',
          footer: '🏷️ Pinterest',
          nativeFlow: [{ text: '🌐 Source', url: 'https://github.com/Souzzaaxzy/baileys' }]
        }
      ]
    });

    assert.equal(carousel.cards.length, 2);
    assert.deepEqual(carousel.cards.map(mediaOf), ['image', 'image']);
    assert.equal(carousel.cards[0].nativeFlowMessage.buttons.length, 1);
    assert.equal(carousel.cards[0].footer.text, '🏷️ Pinterest');
    assert.deepEqual(calls, ['image', 'image']);
  });

  it('carouselCardType/messageVersion continuam como antes', async () => {
    const { carousel } = await build({ text: 't', cards: [{ video: MP4, mimetype: 'video/mp4', caption: 'v' }] });

    assert.equal(cardTypeName(carousel), 'UNKNOWN');
    assert.equal(carousel.messageVersion, 1);
  });

  it('generateWAMessageFromContent monta o carrossel de vídeo inteiro', async () => {
    const content = {
      text: 'lista',
      cards: [{ video: MP4, mimetype: 'video/mp4', caption: '🎬' }]
    };
    const waMessage = generateWAMessageFromContent(GROUP, await build(content).then((b) => b.message), {
      userJid: USER,
      messageId: 'TEST-CAROUSEL-VIDEO'
    });

    const carousel = waMessage.message.interactiveMessage.carouselMessage;
    assert.equal(mediaOf(carousel.cards[0]), 'video');
    assert.equal(waMessage.key.id, 'TEST-CAROUSEL-VIDEO');
  });
});

describe('carousel — helpers', () => {
  it('resolveCarouselHeader mapeia ptvMessage -> videoMessage', () => {
    const out = resolveCarouselHeader({ ptvMessage: { mimetype: 'video/mp4' } });
    assert.deepEqual(out.videoMessage, { mimetype: 'video/mp4' });
    assert.equal(out.ptvMessage, undefined);
  });

  it('resolveCarouselHeader não mexe em imageMessage/videoMessage normais', () => {
    const image = resolveCarouselHeader({ imageMessage: { a: 1 } });
    assert.deepEqual(image.imageMessage, { a: 1 });
    const video = resolveCarouselHeader({ videoMessage: { b: 2 } });
    assert.deepEqual(video.videoMessage, { b: 2 });
  });

  it('resolveCarouselHeader tolera vazio/undefined', () => {
    assert.deepEqual(resolveCarouselHeader(undefined), {});
    assert.deepEqual(resolveCarouselHeader(null), {});
    assert.deepEqual(resolveCarouselHeader({}), {});
  });

  it('hasValidCarouselHeader aceita vídeo', () => {
    assert.equal(hasValidCarouselHeader({ videoMessage: {} }), true);
    assert.equal(hasValidCarouselHeader({ imageMessage: {} }), true);
    assert.equal(hasValidCarouselHeader({ productMessage: {} }), true);
    assert.equal(hasValidCarouselHeader({ documentMessage: {} }), false);
    assert.equal(hasValidCarouselHeader({}), false);
  });
});
