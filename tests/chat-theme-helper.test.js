/**
 * Chat theme — helper de envio (laboratorio).
 *
 * Fixa o contrato do helper e, sobretudo, os testes NEGATIVOS (FASE 26): o
 * `encode` gerado NAO resolve o oneof, entao o helper precisa impor a
 * exclusividade — e este teste prova que ele faz isso.
 *
 * O teste NAO afirma efeito no cliente.
 *
 * Run: node --test tests/chat-theme-helper.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { proto } from '../WAProto/index.js';
import {
  buildChatThemeSetting,
  buildChatThemeProtocolMessage,
  sendChatTheme,
  variantOf,
  CHAT_THEME_SETTING_TYPE,
  CHAT_THEME_SETTING_FIELD
} from '../lib/Utils/chat-theme.js';

const M = proto.Message;
const JID = '5511999999999@s.whatsapp.net';

describe('chat theme — constantes do schema', () => {
  it('type 34 e campo 30', () => {
    assert.equal(CHAT_THEME_SETTING_TYPE, 34);
    assert.equal(M.ProtocolMessage.Type.CHAT_THEME_SETTING, CHAT_THEME_SETTING_TYPE);
    assert.equal(CHAT_THEME_SETTING_FIELD, 30);
  });
});

describe('chat theme — construcao', () => {
  it('monta os campos base', () => {
    const s = buildChatThemeSetting({
      settingTimestampMs: 1757900000000,
      clearTheme: false,
      colorSchemeId: 'Tonal'
    });
    assert.equal(String(s.settingTimestampMs), '1757900000000');
    assert.equal(s.clearTheme, false);
    assert.equal(s.colorSchemeId, 'Tonal');
  });

  it('monta stockImage e animatedWallpaper', () => {
    assert.deepEqual(
      buildChatThemeSetting({ wallpaper: { stockImage: { stockImageId: 'w1', dimLevel: 0.5 } } }).stockImage,
      { stockImageId: 'w1', dimLevel: 0.5 }
    );
    assert.deepEqual(
      buildChatThemeSetting({ wallpaper: { animatedWallpaper: { animatedWallpaperId: 'a1', dimLevel: 0.25 } } }).animatedWallpaper,
      { animatedWallpaperId: 'a1', dimLevel: 0.25 }
    );
  });

  it('o envelope tem type 34 + campo 30', () => {
    const built = buildChatThemeProtocolMessage({ colorSchemeId: 'X' });
    assert.equal(built.type, 34);
    assert.ok(built.chatThemeSetting);

    const bytes = M.ProtocolMessage.encode(built).finish();
    // type 34 -> tag (2<<3)|0 = 16, valor 34 -> 0x10 0x22
    // chatThemeSetting campo 30 -> tag 242 -> 0xf2 0x01
    const arr = Array.from(bytes);
    assert.ok(arr.includes(0xf2) && arr.includes(0x01), 'campo 30 presente no envelope');
  });

  it('variantOf identifica a variante', () => {
    assert.equal(variantOf({ stockImage: {} }), 'stockImage');
    assert.equal(variantOf({ animatedWallpaper: {} }), 'animatedWallpaper');
    assert.equal(variantOf({ colorSchemeId: 'x' }), null);
  });
});

describe('chat theme — validacao (fail-closed)', () => {
  it('recusa uma SEGUNDA variante de wallpaper (o encode nao resolve o oneof)', () => {
    assert.throws(
      () => buildChatThemeSetting({ wallpaper: { stockImage: { stockImageId: 'a' }, solidColor: { colorLight: '#fff' } } }),
      /UMA variante/,
      'dois membros seriam os DOIS no wire — o helper recusa'
    );
  });

  it('recusa variante desconhecida', () => {
    assert.throws(() => buildChatThemeSetting({ wallpaper: { gifWallpaper: { id: 'x' } } }), /desconhecida/);
  });

  it('recusa payload vazio', () => {
    assert.throws(() => buildChatThemeSetting({}), /nada para enviar/);
  });

  it('recusa clearTheme nao-booleano', () => {
    assert.throws(() => buildChatThemeSetting({ clearTheme: 'sim' }), /boolean/);
  });

  it('recusa colorSchemeId vazio', () => {
    assert.throws(() => buildChatThemeSetting({ colorSchemeId: '   ' }), /string nao vazia/);
  });

  it('recusa timestamp invalido', () => {
    assert.throws(() => buildChatThemeSetting({ settingTimestampMs: 'abc' }), /inteiro/);
    assert.throws(() => buildChatThemeSetting({ settingTimestampMs: NaN }), /inteiro/);
  });

  it('NAO envia quando o payload e invalido', async () => {
    let chamou = false;
    const res = await sendChatTheme({ relayMessage: async () => { chamou = true; }, jid: JID });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'payload_invalido');
    assert.equal(chamou, false, 'o relay NAO foi chamado (fail-closed)');
  });
});

describe('chat theme — envio', () => {
  it('envia pelo relay com o envelope correto', async () => {
    const calls = [];
    const res = await sendChatTheme({
      relayMessage: async (jid, content, opts) => { calls.push({ jid, content, opts }); },
      jid: JID,
      wallpaper: { stockImage: { stockImageId: 'w', dimLevel: 0.5 } },
      colorSchemeId: 'Tonal',
      messageId: 'CT-1',
      testId: 'T1'
    });
    assert.equal(res.ok, true);
    assert.equal(res.variant, 'stockImage');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].jid, JID);
    assert.equal(calls[0].content.type, 34);
    assert.equal(calls[0].content.chatThemeSetting.stockImage.stockImageId, 'w');
    assert.equal(calls[0].opts.messageId, 'CT-1');
  });

  it('erro de transporte e reportado, nao engolido', async () => {
    const res = await sendChatTheme({
      relayMessage: async () => { throw new Error('rede caiu'); },
      jid: JID,
      colorSchemeId: 'X'
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'transporte');
    assert.match(res.error, /rede caiu/);
  });

  it('sem relay: falha controlada', async () => {
    const res = await sendChatTheme({ jid: JID, colorSchemeId: 'X' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'sem_relay');
  });

  it('sem jid: falha controlada', async () => {
    const res = await sendChatTheme({ relayMessage: async () => {}, colorSchemeId: 'X' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'sem_jid');
  });

  it('detecta grupo vs privado no log', async () => {
    const linhas = [];
    const fakeLogger = { info: (...a) => linhas.push(a) };
    await sendChatTheme({
      relayMessage: async () => {}, jid: '120363@g.us', colorSchemeId: 'X',
      messageId: 'G1', testId: 'G', logger: fakeLogger
    });
    assert.ok(JSON.stringify(linhas).includes('chatType=group'), 'reconheceu grupo');
  });
});

describe('chat theme — nada de material secreto no log', () => {
  it('customImage reporta LENGTH, nunca os bytes da mediaKey', async () => {
    const linhas = [];
    const fakeLogger = { info: (...a) => linhas.push(a) };
    const segredo = Buffer.from('MEDIA-KEY-SUPER-SECRETA');

    await sendChatTheme({
      relayMessage: async () => {},
      jid: JID,
      wallpaper: {
        customImage: {
          directPath: '/v/t1',
          mediaKey: segredo,
          fileEncSha256: Buffer.from([1]),
          fileSha256: Buffer.from([2]),
          dimLevel: 0.5
        }
      },
      messageId: 'SEC-1',
      testId: 'SEC',
      logger: fakeLogger
    });

    const dump = JSON.stringify(linhas);
    assert.ok(!dump.includes('MEDIA-KEY-SUPER-SECRETA'), 'o conteudo da mediaKey nao aparece');
    assert.ok(!dump.includes(segredo.toString('base64')), 'nem em base64');
    assert.ok(dump.includes(`mediaKeyBytes=${segredo.length}`), 'so o tamanho');
  });
});
