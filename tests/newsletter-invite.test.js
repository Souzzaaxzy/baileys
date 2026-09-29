/**
 * Card de CONVITE PARA SEGUIR CANAL (`newsletterFollowerInviteMessageV2`).
 *
 * Antes desta mudança o tipo existia só no proto: o `generateWAMessageContent`
 * não o conhecia, caía no `prepareWAMessageMedia` e lançava
 * "Invalid media type". O único caminho era o `raw: true` — um passthrough que
 * não monta nem valida nada, e que exigia o app conhecer o proto na mão.
 *
 * Agora existe o formato nativo:
 *
 *   { newsletterInvite: { jid, name, text?, thumbnail? } }
 *
 * O teste roda o caminho REAL (`generateWAMessageContent`/`generateWAMessage`) e
 * confere o proto montado — inclusive o `contextInfo` do cabeçalho "Ver canal"
 * e o `encode`/`decode` —, não só que "não lançou".
 *
 * Run: node --test tests/newsletter-invite.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { proto } from '../WAProto/index.js';
import { generateWAMessageContent } from '../lib/Utils/messages.js';

const USER = '5511999999999@s.whatsapp.net';
const CANAL = '120363410980452460@newsletter';
const CANAL_NOME = 'Lizzy';

const upload = async () => ({ url: 'https://mmg.whatsapp.net/fake', directPath: '/v/fake' });

const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

const HEADER = {
  forwardingScore: 999,
  isForwarded: true,
  forwardedNewsletterMessageInfo: { newsletterJid: CANAL, newsletterName: CANAL_NOME },
};

function gerar(content) {
  return generateWAMessageContent(content, { userJid: USER, upload });
}

describe('newsletter follower invite (card de seguir canal)', () => {
  it('monta o card com jid, nome e legenda', async () => {
    const m = await gerar({ newsletterInvite: { jid: CANAL, name: CANAL_NOME, text: 'Siga o canal!' } });
    const card = m.newsletterFollowerInviteMessageV2;
    assert.ok(card, 'newsletterFollowerInviteMessageV2 presente');
    assert.equal(card.newsletterJid, CANAL);
    assert.equal(card.newsletterName, CANAL_NOME);
    assert.equal(card.caption, 'Siga o canal!');
  });

  it('sem legenda, o campo caption fica de fora', async () => {
    const m = await gerar({ newsletterInvite: { jid: CANAL, name: CANAL_NOME } });
    assert.equal(m.newsletterFollowerInviteMessageV2.caption, undefined);
  });

  it('leva o thumbnail quando o chamador traz a foto', async () => {
    const m = await gerar({ newsletterInvite: { jid: CANAL, name: CANAL_NOME, thumbnail: JPEG } });
    const thumb = m.newsletterFollowerInviteMessageV2.jpegThumbnail;
    assert.ok(thumb, 'tem thumbnail');
    assert.equal(Buffer.from(thumb).length, JPEG.length);
  });

  it('busca a foto pelo getProfilePicUrl quando nao vem pronta', async () => {
    let pedido = null;
    const m = await generateWAMessageContent(
      { newsletterInvite: { jid: CANAL, name: CANAL_NOME } },
      {
        userJid: USER,
        upload,
        getProfilePicUrl: async (jid, tipo) => { pedido = { jid, tipo }; return `data:image/jpeg;base64,${JPEG.toString('base64')}`; },
        options: {},
      }
    );
    assert.deepEqual(pedido, { jid: CANAL, tipo: 'preview' }, 'pediu o preview do canal');
    assert.ok(m.newsletterFollowerInviteMessageV2.jpegThumbnail, 'thumb veio do preview');
  });

  it('sem foto, o card sai mesmo assim (thumbnail e opcional)', async () => {
    const m = await generateWAMessageContent(
      { newsletterInvite: { jid: CANAL, name: CANAL_NOME } },
      {
        userJid: USER,
        upload,
        getProfilePicUrl: async () => { throw new Error('sem foto'); },
        options: {},
      }
    );
    assert.ok(m.newsletterFollowerInviteMessageV2, 'montou o card');
    assert.equal(m.newsletterFollowerInviteMessageV2.jpegThumbnail, undefined);
  });

  it('o contextInfo do cabecalho "Ver canal" chega no card', async () => {
    const m = await gerar({ newsletterInvite: { jid: CANAL, name: CANAL_NOME }, contextInfo: HEADER });
    const ci = m.newsletterFollowerInviteMessageV2.contextInfo;
    assert.equal(ci.forwardedNewsletterMessageInfo.newsletterJid, CANAL);
    assert.equal(ci.forwardingScore, 999);
    assert.equal(ci.isForwarded, true);
  });

  it('sobrevive ao encode/decode do proto', async () => {
    const m = await gerar({ newsletterInvite: { jid: CANAL, name: CANAL_NOME, text: 'oi', thumbnail: JPEG } });
    const dec = proto.Message.decode(proto.Message.encode(m).finish());
    const card = dec.newsletterFollowerInviteMessageV2;
    assert.equal(card.newsletterJid, CANAL);
    assert.equal(card.caption, 'oi');
    assert.equal(Buffer.from(card.jpegThumbnail).length, JPEG.length);
    // campo 113 do proto (o numero do fio) continua o mesmo
    assert.equal(proto.Message.decode(proto.Message.encode(m).finish()).newsletterFollowerInviteMessageV2.newsletterName, CANAL_NOME);
  });

  it('NAO cai mais no prepareWAMessageMedia ("Invalid media type")', async () => {
    // o formato antigo (sem o branch) lancava; agora tem que montar
    let erro = null;
    try {
      await gerar({ newsletterInvite: { jid: CANAL, name: CANAL_NOME } });
    } catch (e) { erro = e; }
    assert.equal(erro, null, 'nao lancou');
  });

  it('o formato `raw: true` continua funcionando (compatibilidade)', async () => {
    const m = await gerar({
      raw: true,
      newsletterFollowerInviteMessageV2: { newsletterJid: CANAL, newsletterName: CANAL_NOME },
    });
    assert.equal(m.newsletterFollowerInviteMessageV2.newsletterJid, CANAL);
  });

  it('o card e reconhecido como future-proof message (leitura)', async () => {
    const m = await gerar({ newsletterInvite: { jid: CANAL, name: CANAL_NOME } });
    // extractMessageContent desembrulha wrappers; o card e folha (nao muda)
    const { extractMessageContent } = await import('../lib/Utils/messages.js');
    const extraido = extractMessageContent(m);
    assert.ok(extraido.newsletterFollowerInviteMessageV2, 'o card sobrevive ao extract');
  });
});
