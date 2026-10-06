/**
 * Envio de GIF (`gif: <buffer|url>`) — alias de conveniência da fork.
 *
 * Um `.gif` cru enviado como imagem/vídeo NÃO anima no WhatsApp: o app exige um
 * MP4 (H.264) em loop com `gifPlayback: true`. Antes desta mudança a lib não
 * conhecia o tipo `gif`, então um card (ex.: as capas do EmuGames) que mandava
 * `.gif` caía para texto ou saía como imagem estática.
 *
 * O teste roda o caminho REAL (`generateWAMessageContent` → `prepareWAMessageMedia`),
 * com o upload instrumentado, e confere o proto montado:
 *   - `gif: <gif>`  → `videoMessage` com `gifPlayback: true`, mediaType "video";
 *   - `gif: <gif>` + `caption`/`footer` + `nativeFlow` → `interactiveMessage`
 *     com header de VÍDEO (o formato do card do bot);
 *   - um `gif:` que não é GIF é recusado com erro claro.
 *
 * O fixture é um GIF animado de verdade (gerado pelo ffmpeg). Sem ffmpeg os
 * testes que convertem são pulados; o de formato (`isGif`) roda sempre.
 *
 * Run: node --test tests/gif-message.test.js
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { proto } from '../WAProto/index.js';
import { generateWAMessageContent } from '../lib/Utils/messages.js';
import { isGif } from '../lib/Utils/sticker-convert.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const temFfmpeg = () => {
    try {
        return spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0;
    } catch {
        return false;
    }
};
const HAS_FFMPEG = temFfmpeg();

let FIXTURE;
/** GIF animado real (10 frames 160x120 @ 10fps) gerado pelo ffmpeg. */
function gifAnimado() {
    if (FIXTURE) {
        return FIXTURE;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-fix-'));
    const file = path.join(dir, 'anim.gif');
    const res = spawnSync(FFMPEG, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1',
        '-loop', '0', file
    ], { stdio: 'ignore' });
    if (res.status !== 0 || !fs.existsSync(file)) {
        return null;
    }
    FIXTURE = fs.readFileSync(file);
    return FIXTURE;
}

const USER = '5511999999999@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';

const makeUpload = () => {
    const calls = [];
    const upload = async (_filePath, opts) => {
        calls.push(opts?.mediaType);
        return { url: 'https://mmg.whatsapp.net/fake', directPath: '/v/fake' };
    };
    return { upload, calls };
};

async function build(content) {
    const { upload, calls } = makeUpload();
    const message = await generateWAMessageContent(content, {
        userJid: USER,
        upload,
        jid: GROUP,
        ffmpegPath: FFMPEG
    });
    return { message, calls };
}

describe('isGif reconhece o formato', () => {
    it('GIF87a/GIF89a sim, o resto não', () => {
        assert.equal(isGif(Buffer.from('GIF89a....')), true, 'GIF89a');
        assert.equal(isGif(Buffer.from('GIF87a....')), true, 'GIF87a');
        assert.equal(isGif(Buffer.from('nao é gif')), false, 'texto');
        assert.equal(isGif(Buffer.from('RIFF....WEBPVP8 ')), false, 'webp');
        assert.equal(isGif(Buffer.alloc(0)), false, 'vazio');
    });
});

describe('gif: vira MP4 com gifPlayback', () => {
    it('gera videoMessage com gifPlayback e sobe como mediaType "video"', { skip: !HAS_FFMPEG }, async () => {
        const { message, calls } = await build({ gif: gifAnimado() });

        const video = message?.videoMessage;
        assert.ok(video, 'tem videoMessage');
        assert.equal(video.gifPlayback, true, 'gifPlayback ligado');
        assert.equal(video.mimetype, 'video/mp4', 'mimetype de vídeo');
        assert.ok(video.fileLength > 0, 'tem conteúdo');
        assert.deepEqual(calls, ['video'], 'o GIF foi para o pipeline como "video"');
        assert.ok(!message.imageMessage, 'não saiu como imagem');
    });

    it('card interativo (caption + footer + nativeFlow) usa header de VÍDEO', { skip: !HAS_FFMPEG }, async () => {
        const { message, calls } = await build({
            gif: gifAnimado(),
            caption: '🏎️ *Top Gear 2*',
            footer: 'Lizzy · EmuGames',
            nativeFlow: [{ text: '🎮 JOGAR', url: 'https://exemplo.com/?jogo=topgear2', useWebview: true }]
        });

        const interactive = message?.interactiveMessage;
        assert.ok(interactive, 'tem interactiveMessage');
        assert.ok(interactive.header?.videoMessage, 'header é vídeo (animado)');
        assert.equal(interactive.header.videoMessage.gifPlayback, true, 'gifPlayback ligado');
        assert.equal(interactive.header.hasMediaAttachment, true);
        assert.equal(interactive.body.text, '🏎️ *Top Gear 2*');
        assert.equal(interactive.footer.text, 'Lizzy · EmuGames');
        const btn = interactive.nativeFlowMessage?.buttons?.[0];
        assert.equal(btn?.name, 'cta_url', 'botão cta_url');
        assert.equal(JSON.parse(btn?.buttonParamsJson || '{}').webview_interaction, true, 'abre no webview');
        assert.deepEqual(calls, ['video'], 'o header subiu como "video"');
    });

    it('o card sobrevive ao round-trip do proto', { skip: !HAS_FFMPEG }, async () => {
        const { message } = await build({
            gif: gifAnimado(),
            caption: 'c',
            nativeFlow: [{ text: 'JOGAR', url: 'https://exemplo.com' }]
        });

        const decoded = proto.Message.InteractiveMessage.decode(
            proto.Message.InteractiveMessage.encode(message.interactiveMessage).finish()
        );
        assert.ok(decoded.header?.videoMessage, 'header.videoMessage sobrevive');
        assert.equal(decoded.header.videoMessage.gifPlayback, true);
        assert.equal(decoded.body.text, 'c');
    });
});

describe('gif: entradas inválidas', () => {
    it('conteúdo que não é GIF é recusado com erro claro', async () => {
        await assert.rejects(
            () => build({ gif: Buffer.from('nao é um gif de verdade') }),
            /não é um GIF válido/i
        );
    });
});
