/**
 * Business Profile + Catálogo Business.
 *
 * Cobre as duas frentes pedidas, no caminho REAL da fork (nada de tipos soltos):
 *
 *   1. Business Profile (`w:biz` / `business_profile`):
 *      - builder do payload de update (`toBusinessProfileNode`),
 *      - node de capa (`toCoverPhotoNode`),
 *      - parser da resposta (`parseBusinessProfileNode`), que é o mesmo usado por
 *        `getBusinessProfile` (chats) e `getBusinessProfileV2` (business socket).
 *
 *   2. Catálogo Business:
 *      - `productListInfo` (MPM) ida e volta,
 *      - `ProductMessage.catalog` (CatalogSnapshot) pelo `generateWAMessageContent`,
 *      - `ProductSnapshot` (SPM) preservado,
 *      - serialização/deserialização real dos protos (`encode`/`decode`).
 *
 * Os BinaryNodes são construídos à mão no formato que o servidor usa
 * (`{ tag, attrs, content }`), como o resto da suíte faz.
 *
 * Run: node tests/business-catalog.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { proto } from '../WAProto/index.js';
import {
  parseBusinessProfileNode,
  parseProductListInfo,
  toBusinessProfileNode,
  toCoverPhotoNode,
  toProductListInfo
} from '../lib/Utils/business.js';
import { generateWAMessageContent } from '../lib/Utils/messages.js';
import { shouldIncludeBizBinaryNode } from '../lib/Utils/messages.js';

const USER = '5511999999999@s.whatsapp.net';
const BIZ = '5511888888888@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';

const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9
]);

const fakeUpload = async () => ({ url: 'https://mmg.whatsapp.net/fake', directPath: '/v/fake' });

/** BinaryNode with string content, as the server sends it. */
const node = (tag, content, attrs = {}) => ({ tag, attrs, content });

/** Wraps profile children the way `<business_profile><profile>` does. */
const profileIq = (children, attrs = { jid: BIZ }) => node('iq', [
  node('business_profile', [node('profile', children, attrs)])
]);

describe('Business Profile — builder do payload (`w:biz`)', () => {
  it('emite só os campos informados (update parcial não apaga o resto)', () => {
    const only = toBusinessProfileNode({ description: 'Loja de testes' });
    assert.equal(only.length, 1);
    assert.equal(only[0].tag, 'description');
    assert.equal(only[0].content, 'Loja de testes');
    assert.deepEqual(only[0].attrs, {});
  });

  it('emite address, email e vários websites', () => {
    const nodes = toBusinessProfileNode({
      address: 'Rua 1',
      email: 'a@b.com',
      websites: ['https://a.com', 'https://b.com']
    });
    const tags = nodes.map(n => n.tag);
    assert.deepEqual(tags, ['address', 'email', 'website', 'website']);
    assert.equal(nodes.filter(n => n.tag === 'website').length, 2, 'os dois sites saem');
  });

  it('ignora null/undefined sem gerar node vazio', () => {
    const nodes = toBusinessProfileNode({ address: null, email: undefined, description: '' });
    // `description: ''` é um valor presente (limpar a descrição), null/undefined não.
    assert.deepEqual(nodes.map(n => n.tag), ['description']);
  });

  it('monta business_hours com modo específico e 24h', () => {
    const nodes = toBusinessProfileNode({
      hours: {
        timezone: 'America/Sao_Paulo',
        days: [
          { day: 'mon', mode: 'specific_hours', openTimeInMinutes: 480, closeTimeInMinutes: 1080 },
          { day: 'sun', mode: 'closed' }
        ]
      }
    });
    const hours = nodes.find(n => n.tag === 'business_hours');
    assert.equal(hours.attrs.timezone, 'America/Sao_Paulo');
    assert.equal(hours.content.length, 2);
    assert.deepEqual(hours.content[0].attrs, {
      day_of_week: 'mon',
      mode: 'specific_hours',
      open_time: 480,
      close_time: 1080
    });
    assert.deepEqual(hours.content[1].attrs, { day_of_week: 'sun', mode: 'closed' });
  });
});

describe('Business Profile — node da capa (cover_photo)', () => {
  it('update leva id, token e ts', () => {
    const n = toCoverPhotoNode({ op: 'update', id: 123, token: 'abc', ts: 456 });
    assert.equal(n.tag, 'cover_photo');
    assert.deepEqual(n.attrs, { op: 'update', id: '123', token: 'abc', ts: '456' });
  });

  it('delete leva apenas op e id', () => {
    const n = toCoverPhotoNode({ op: 'delete', id: 'fb-9' });
    assert.deepEqual(n.attrs, { op: 'delete', id: 'fb-9' });
  });
});

describe('Business Profile — parser da resposta', () => {
  it('lê os campos do perfil', () => {
    const perfil = parseBusinessProfileNode(profileIq([
      node('address', Buffer.from('Rua 1, 100')),
      node('description', Buffer.from('Loja de testes')),
      node('email', Buffer.from('a@b.com')),
      node('categories', [node('category', Buffer.from('RETAIL'))])
    ]));
    assert.equal(perfil.wid, BIZ);
    assert.equal(perfil.address, 'Rua 1, 100');
    assert.equal(perfil.description, 'Loja de testes');
    assert.equal(perfil.email, 'a@b.com');
    assert.equal(perfil.category, 'RETAIL');
  });

  it('lê TODOS os websites (não só o primeiro)', () => {
    const perfil = parseBusinessProfileNode(profileIq([
      node('website', Buffer.from('https://a.com')),
      node('website', Buffer.from('https://b.com'))
    ]));
    assert.deepEqual(perfil.website, ['https://a.com', 'https://b.com']);
  });

  it('lê todas as categorias e mantém `category` como a primeira', () => {
    const perfil = parseBusinessProfileNode(profileIq([
      node('categories', [
        node('category', Buffer.from('RETAIL')),
        node('category', Buffer.from('FOOD'))
      ])
    ]));
    assert.deepEqual(perfil.categories, ['RETAIL', 'FOOD']);
    assert.equal(perfil.category, 'RETAIL');
  });

  it('lê o horário comercial com o timezone', () => {
    const perfil = parseBusinessProfileNode(profileIq([
      node('business_hours', [
        node('business_hours_config', undefined, { day_of_week: 'mon', mode: 'specific_hours' })
      ], { timezone: 'America/Sao_Paulo' })
    ]));
    assert.equal(perfil.business_hours.timezone, 'America/Sao_Paulo');
    assert.deepEqual(perfil.business_hours.business_config, [
      { day_of_week: 'mon', mode: 'specific_hours' }
    ]);
  });

  it('lê o id da capa quando existe', () => {
    const perfil = parseBusinessProfileNode(profileIq([
      node('cover_photo', undefined, { id: 'fb-77' })
    ]));
    assert.equal(perfil.coverPhotoId, 'fb-77');
  });

  it('devolve undefined quando o número não tem perfil comercial', () => {
    // O servidor responde com `<business_profile/>` vazio nesse caso.
    assert.equal(parseBusinessProfileNode(node('iq', [node('business_profile', [])])), undefined);
    assert.equal(parseBusinessProfileNode(node('iq', [])), undefined);
    assert.equal(parseBusinessProfileNode(undefined), undefined);
  });

  it('não quebra com perfil só com description (campos ausentes viram undefined/[])', () => {
    const perfil = parseBusinessProfileNode(profileIq([node('description', Buffer.from('só isso'))]));
    assert.equal(perfil.description, 'só isso');
    assert.equal(perfil.address, undefined);
    assert.deepEqual(perfil.website, []);
    assert.deepEqual(perfil.categories, []);
  });
});

describe('Catálogo — productListInfo (MPM)', () => {
  it('monta seções e produtos', () => {
    const info = toProductListInfo({
      businessOwnerJid: BIZ,
      productSections: [
        { title: 'Promoções', products: [{ productId: 'P1' }, { productId: 'P2' }] },
        { title: 'Novidades', products: [{ id: 'P3' }] }
      ]
    });
    assert.equal(info.businessOwnerJid, BIZ);
    assert.equal(info.productSections.length, 2);
    assert.deepEqual(info.productSections[0].products, [{ productId: 'P1' }, { productId: 'P2' }]);
    assert.deepEqual(info.productSections[1].products, [{ productId: 'P3' }], 'aceita `id` como atalho');
  });

  it('inclui headerImage quando informado', () => {
    const info = toProductListInfo({
      businessOwnerJid: BIZ,
      productSections: [],
      headerImage: { productId: 'P1', jpegThumbnail: JPEG }
    });
    assert.equal(info.headerImage.productId, 'P1');
    assert.deepEqual(info.headerImage.jpegThumbnail, JPEG);
  });

  it('ida e volta preserva o conteúdo', () => {
    const original = toProductListInfo({
      businessOwnerJid: BIZ,
      productSections: [{ title: 'S', products: [{ productId: 'P9' }] }]
    });
    const volta = parseProductListInfo(original);
    assert.equal(volta.businessOwnerJid, BIZ);
    assert.deepEqual(volta.productSections, [{ title: 'S', products: [{ productId: 'P9' }] }]);
  });

  it('sobrevive ao encode/decode real do proto ListMessage (PRODUCT_LIST)', () => {
    const listMessage = proto.Message.ListMessage.fromObject({
      title: 'Catálogo',
      description: 'Confira os produtos',
      buttonText: 'Ver catálogo',
      footerText: 'Rodapé',
      listType: proto.Message.ListMessage.ListType.PRODUCT_LIST,
      productListInfo: toProductListInfo({
        businessOwnerJid: BIZ,
        productSections: [{ title: 'S', products: [{ productId: 'P1' }] }]
      })
    });
    const decoded = proto.Message.ListMessage.decode(
      proto.Message.ListMessage.encode(listMessage).finish()
    );
    assert.equal(decoded.listType, proto.Message.ListMessage.ListType.PRODUCT_LIST);
    assert.equal(decoded.productListInfo.businessOwnerJid, BIZ);
    assert.equal(decoded.productListInfo.productSections[0].products[0].productId, 'P1');
  });
});

describe('Catálogo — envio pelo generateWAMessageContent', () => {
  it('monta o catalog card (CatalogSnapshot) com a imagem enviada', async () => {
    const content = await generateWAMessageContent(
      {
        catalog: { title: 'Minha loja', description: 'Tudo em um só lugar', catalogImage: JPEG },
        businessOwnerJid: BIZ,
        body: 'Dá uma olhada',
        footer: 'Obrigado'
      },
      { userJid: USER, upload: fakeUpload, jid: GROUP }
    );
    assert.ok(content.productMessage, 'virou productMessage');
    assert.equal(content.productMessage.businessOwnerJid, BIZ);
    assert.equal(content.productMessage.catalog.title, 'Minha loja');
    assert.equal(content.productMessage.catalog.description, 'Tudo em um só lugar');
    assert.ok(content.productMessage.catalog.catalogImage, 'a imagem do catálogo foi preparada');
    assert.equal(content.productMessage.body, 'Dá uma olhada');
  });

  it('aceita `image` como alias da imagem do catálogo', async () => {
    const content = await generateWAMessageContent(
      { catalog: { title: 'L', image: JPEG }, businessOwnerJid: BIZ },
      { userJid: USER, upload: fakeUpload, jid: GROUP }
    );
    assert.ok(content.productMessage.catalog.catalogImage);
    assert.equal(content.productMessage.catalog.image, undefined, 'o alias não vaza pro proto');
  });

  it('o CatalogSnapshot sobrevive ao encode/decode', async () => {
    const content = await generateWAMessageContent(
      { catalog: { title: 'T', description: 'D', catalogImage: JPEG }, businessOwnerJid: BIZ },
      { userJid: USER, upload: fakeUpload, jid: GROUP }
    );
    const decoded = proto.Message.ProductMessage.decode(
      proto.Message.ProductMessage.encode(content.productMessage).finish()
    );
    assert.equal(decoded.catalog.title, 'T');
    assert.equal(decoded.catalog.description, 'D');
    assert.equal(decoded.businessOwnerJid, BIZ);
  });

  it('preserva o SPM (ProductSnapshot) que já funcionava', async () => {
    const content = await generateWAMessageContent(
      {
        product: {
          productId: 'P1',
          title: 'Produto',
          description: 'Desc',
          currencyCode: 'BRL',
          priceAmount1000: 5000,
          productImage: JPEG
        },
        businessOwnerJid: BIZ
      },
      { userJid: USER, upload: fakeUpload, jid: GROUP }
    );
    assert.ok(content.productMessage.product, 'o snapshot do produto continua');
    assert.equal(content.productMessage.product.productId, 'P1');
    assert.equal(content.productMessage.product.priceAmount1000, 5000);
    assert.ok(content.productMessage.product.productImage);
  });

  it('o MPM sai como listMessage PRODUCT_LIST', async () => {
    const content = await generateWAMessageContent(
      {
        productList: {
          businessOwnerJid: BIZ,
          productSections: [{ title: 'S', products: [{ productId: 'P1' }] }]
        },
        title: 'Catálogo',
        text: 'Escolha',
        buttonText: 'Abrir',
        footer: 'Rodapé'
      },
      { userJid: USER, upload: fakeUpload, jid: GROUP }
    );
    assert.ok(content.listMessage, 'virou listMessage');
    assert.equal(content.listMessage.listType, proto.Message.ListMessage.ListType.PRODUCT_LIST);
    assert.equal(content.listMessage.productListInfo.businessOwnerJid, BIZ);
    assert.equal(content.listMessage.title, 'Catálogo');
    assert.equal(content.listMessage.description, 'Escolha');
  });

  it('sem businessOwnerJid o productMessage falha fechado (Boom 400)', async () => {
    await assert.rejects(
      () => generateWAMessageContent(
        { catalog: { title: 'x', catalogImage: JPEG } },
        { userJid: USER, upload: fakeUpload, jid: GROUP }
      ),
      (err) => err && err.output && err.output.statusCode === 400
    );
  });
});

describe('Catálogo — biz node nas mensagens de catálogo', () => {
  it('o MPM (listMessage) entra na regra do biz node', () => {
    assert.equal(shouldIncludeBizBinaryNode({ listMessage: {} }), true);
  });
});
