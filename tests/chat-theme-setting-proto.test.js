/**
 * ChatThemeSetting — schema e serializacao (laboratorio, FASE 14).
 *
 * Fixa o contrato do schema REAL desta fork (nao o que o prompt supunha):
 *
 *   ChatThemeSetting (campo 30 de ProtocolMessage, type 34)
 *     1  settingTimestampMs  INT64
 *     2  clearTheme          BOOL
 *     3  colorSchemeId       STRING
 *     10 defaultWallpaper    MESSAGE  }
 *     11 solidColor          MESSAGE  }  oneof `wallpaper`
 *     12 stockImage          MESSAGE  }
 *     13 customImage         MESSAGE  }
 *     14 animatedWallpaper   MESSAGE  }  (AUSENTE nesta fork — ver abaixo)
 *
 * Wallpapers:
 *   defaultWallpaper  { isDoodleEnabled:1 }
 *   solidColor        { colorLight:1, colorDark:2, isDoodleEnabled:3 }
 *   stockImage        { stockImageId:1 string, dimLevel:2 float }
 *   customImage       { directPath:1, mediaKey:2, fileEncSha256:3, fileSha256:4, dimLevel:5 float }
 *   animatedWallpaper { animatedWallpaperId:1 string, dimLevel:2 float }  (WA Web)
 *
 * O teste NAO afirma efeito no cliente. Prova estrutura e bytes.
 *
 * Run: node --test tests/chat-theme-setting-proto.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { proto } from '../WAProto/index.js';

const M = proto.Message;

describe('ChatThemeSetting — schema', () => {
  it('existe e e filho da ProtocolMessage no campo 30', () => {
    assert.equal(typeof M.ChatThemeSetting, 'function');
    // type 34 no enum do pai
    assert.equal(M.ProtocolMessage.Type.CHAT_THEME_SETTING, 34);

    // tag do campo 30, wireType 2 -> (30<<3)|2 = 242 -> varint 0xf2 0x01
    const bytes = M.ProtocolMessage.encode({
      chatThemeSetting: { colorSchemeId: 'x' }
    }).finish();
    assert.deepEqual(Array.from(bytes).slice(0, 2), [0xf2, 0x01], 'campo 30 tem a tag 242');
  });

  it('campos base com os numeros e tipos do schema', () => {
    const tag = (obj) => Array.from(M.ChatThemeSetting.encode(obj).finish())[0];

    // 1 int64 -> (1<<3)|0 = 8
    assert.equal(tag({ settingTimestampMs: 1 }), 8, 'settingTimestampMs = campo 1 (int64)');
    // 2 bool -> (2<<3)|0 = 16
    assert.equal(tag({ clearTheme: true }), 16, 'clearTheme = campo 2 (bool)');
    // 3 string -> (3<<3)|2 = 26
    assert.equal(tag({ colorSchemeId: 'a' }), 26, 'colorSchemeId = campo 3 (string)');
  });

  it('o oneof `wallpaper` tem as variantes que a fork conhece', () => {
    const enc = (obj) => Array.from(M.ChatThemeSetting.encode(obj).finish())[0];
    // 10 -> (10<<3)|2 = 82
    assert.equal(enc({ defaultWallpaper: {} }), 82, 'defaultWallpaper = campo 10');
    // 11 -> 90
    assert.equal(enc({ solidColor: {} }), 90, 'solidColor = campo 11');
    // 12 -> 98
    assert.equal(enc({ stockImage: {} }), 98, 'stockImage = campo 12');
    // 13 -> 106
    assert.equal(enc({ customImage: {} }), 106, 'customImage = campo 13');
  });

  it('MEDIDO: o encode NAO consulta o oneof — setar dois membros escreve os DOIS', () => {
    // Fato do gerador (protobufjs): o `encode` usa `hasOwnProperty`, nao o
    // getter do oneof. Entao dois membros setados na INSTANCIA saem ambos no
    // wire, e o receptor fica com o ULTIMO (semantica de oneof do protobuf).
    //
    // Consequencia pratica (e o motivo deste teste existir): o HELPER precisa
    // impor a exclusividade por conta propria — nao da para confiar no schema.
    const t = new M.ChatThemeSetting();
    t.stockImage = { stockImageId: 'a' };
    t.solidColor = { colorLight: '#fff', colorDark: '#000' };

    const dec = M.ChatThemeSetting.decode(M.ChatThemeSetting.encode(t).finish());
    assert.ok(dec.stockImage, 'stockImage TAMBEM foi encodado');
    assert.ok(dec.solidColor, 'solidColor TAMBEM foi encodado (dois membros no wire)');
    assert.equal(dec.wallpaper, 'stockImage', 'o receptor resolve pelo ULTIMO campo do oneof');
  });

  it('um unico membro do oneof encoda exatamente um campo', () => {
    const dec = M.ChatThemeSetting.decode(
      M.ChatThemeSetting.encode({ solidColor: { colorLight: '#fff' } }).finish()
    );
    assert.equal(dec.wallpaper, 'solidColor');
    // Campos nao setados ficam `null` (o pbjs declara como null no prototype),
    // nao `undefined` — medido, para o teste nao afirmar o que nao acontece.
    assert.equal(dec.stockImage, null, 'nada de outro membro');
    assert.equal(dec.customImage, null);
    assert.equal(dec.defaultWallpaper, null);
  });
});

describe('ChatThemeSetting — serializacao', () => {
  it('round-trip preserva timestamp, clearTheme e colorSchemeId', () => {
    const orig = { settingTimestampMs: 1757900000000, clearTheme: false, colorSchemeId: 'Tonal' };
    const dec = M.ChatThemeSetting.decode(M.ChatThemeSetting.encode(orig).finish());

    // int64 vem como Long -> compara a string
    assert.equal(String(dec.settingTimestampMs), '1757900000000', 'timestamp preservado (int64)');
    assert.equal(dec.clearTheme, false, 'clearTheme=false preservado (nao vira ausente)');
    assert.equal(dec.colorSchemeId, 'Tonal');
  });

  it('timestamp grande nao perde precisao', () => {
    const big = '9223372036854775807'; // int64 max
    const dec = M.ChatThemeSetting.decode(M.ChatThemeSetting.encode({ settingTimestampMs: big }).finish());
    assert.equal(String(dec.settingTimestampMs), big);
  });

  it('stockImage: string + float sobrevivem', () => {
    const dec = M.ChatThemeSetting.decode(
      M.ChatThemeSetting.encode({ stockImage: { stockImageId: 'wall-1', dimLevel: 0.25 } }).finish()
    );
    assert.equal(dec.stockImage.stockImageId, 'wall-1');
    assert.equal(dec.stockImage.dimLevel, 0.25, 'dimLevel float preservado');
  });

  it('float de dimLevel mantem precisao suficiente', () => {
    for (const v of [0, 1, 0.5, 0.25, 0.75, 0.1]) {
      const dec = M.ChatThemeSetting.decode(
        M.ChatThemeSetting.encode({ stockImage: { stockImageId: 'x', dimLevel: v } }).finish()
      );
      assert.ok(Math.abs(dec.stockImage.dimLevel - v) < 1e-6, `dimLevel ${v} preservado`);
    }
  });

  it('customImage: os 4 campos + float', () => {
    const dec = M.ChatThemeSetting.decode(M.ChatThemeSetting.encode({
      customImage: {
        directPath: '/v/t123',
        mediaKey: Buffer.from([1, 2, 3]),
        fileEncSha256: Buffer.from([4, 5]),
        fileSha256: Buffer.from([6]),
        dimLevel: 0.5
      }
    }).finish());

    assert.equal(dec.customImage.directPath, '/v/t123');
    assert.deepEqual(Buffer.from(dec.customImage.mediaKey), Buffer.from([1, 2, 3]), 'mediaKey (bytes)');
    assert.deepEqual(Buffer.from(dec.customImage.fileEncSha256), Buffer.from([4, 5]));
    assert.deepEqual(Buffer.from(dec.customImage.fileSha256), Buffer.from([6]));
    assert.equal(dec.customImage.dimLevel, 0.5);
  });

  it('solidColor: dois hex + bool', () => {
    const dec = M.ChatThemeSetting.decode(M.ChatThemeSetting.encode({
      solidColor: { colorLight: '#FFFFFFFF', colorDark: '#FF000000', isDoodleEnabled: true }
    }).finish());
    assert.equal(dec.solidColor.colorLight, '#FFFFFFFF');
    assert.equal(dec.solidColor.colorDark, '#FF000000');
    assert.equal(dec.solidColor.isDoodleEnabled, true);
  });

  it('round-trip dentro da ProtocolMessage', () => {
    const msg = {
      type: M.ProtocolMessage.Type.CHAT_THEME_SETTING,
      chatThemeSetting: {
        settingTimestampMs: 1757900000000,
        colorSchemeId: 'Tonal',
        stockImage: { stockImageId: 'w', dimLevel: 0.5 }
      }
    };
    const dec = M.ProtocolMessage.decode(M.ProtocolMessage.encode(msg).finish());
    assert.equal(dec.type, 34);
    assert.ok(dec.chatThemeSetting, 'o campo aninhado sobrevive');
    assert.equal(dec.chatThemeSetting.colorSchemeId, 'Tonal');
    assert.equal(dec.chatThemeSetting.stockImage.stockImageId, 'w');
  });

  it('payload vazio da zero bytes (nao inventa campo)', () => {
    assert.equal(M.ChatThemeSetting.encode({}).finish().length, 0);
    const dec = M.ChatThemeSetting.decode(Buffer.alloc(0));
    assert.equal(dec.settingTimestampMs, null);
    assert.equal(dec.clearTheme, null);
    assert.equal(dec.colorSchemeId, null);
    assert.equal(dec.wallpaper, undefined, 'sem variante de wallpaper');
  });
});

describe('ChatThemeSetting — animatedWallpaper (variante ADICIONADA nesta fork)', () => {
  it('animatedWallpaper existe no campo 14 e faz round-trip', () => {
    // A fork original NAO tinha esta variante (era ausente no WAProto gerado).
    // Ver "scripts/add-chat-animated-wallpaper.js" para a origem do delta.
    assert.equal(typeof M.ChatAnimatedWallpaper, 'function', 'ChatAnimatedWallpaper existe agora');

    // 14 -> (14<<3)|2 = 114
    const bytes = M.ChatThemeSetting.encode({ animatedWallpaper: { animatedWallpaperId: 'a' } }).finish();
    assert.equal(Array.from(bytes)[0], 114, 'campo 14 tem a tag 114');

    const dec = M.ChatThemeSetting.decode(
      M.ChatThemeSetting.encode({ animatedWallpaper: { animatedWallpaperId: 'wall-9', dimLevel: 0.3 } }).finish()
    );
    assert.equal(dec.animatedWallpaper.animatedWallpaperId, 'wall-9');
    // float 32 bits: 0.3 nao e exato — compara com tolerancia
    assert.ok(Math.abs(dec.animatedWallpaper.dimLevel - 0.3) < 1e-6, 'dimLevel float preservado');
    assert.equal(dec.wallpaper, 'animatedWallpaper', 'o oneof reconhece a variante nova');
  });

  it('os 5 membros do oneof estao declarados', () => {
    // O grupo do oneof e o que o gerador usa para resolver qual variante vale.
    const proto = M.ChatThemeSetting.prototype;
    for (const v of ['defaultWallpaper', 'solidColor', 'stockImage', 'customImage', 'animatedWallpaper']) {
      assert.ok(v in proto, `membro do oneof presente: ${v}`);
    }
  });
});
