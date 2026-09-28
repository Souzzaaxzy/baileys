/**
 * Testes da conversão de FIGURINHA para GIF/MP4 (`sticker-convert`).
 *
 * Contexto: o decoder de WebP do FFmpeg **ignora** `ANIM`/`ANMF` (medido), então
 * FFmpeg sozinho não converte figurinha animada. O módulo usa o `sharp` para ler
 * os frames e, no caso do MP4, entrega raw RGBA ao FFmpeg por `pipe:0`.
 *
 * O fixture é um webp ANIMADO de verdade (gerado pelo ffmpeg `libwebp_anim`);
 * se não houver ffmpeg, os testes que precisam dele são pulados, mas os de
 * estrutura (`isWebP`/`isAnimatedWebP`) rodam sempre.
 *
 * Run: node --test tests/sticker-convert.test.js
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { convertSticker, getStickerFramesInfo, isAnimatedWebP, isWebP, stickerToGif, stickerToMp4 } from '../lib/Utils/sticker-convert.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

function temFfmpeg() {
    try {
        return spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0;
    } catch {
        return false;
    }
}
const HAS_FFMPEG = temFfmpeg();

let FIXTURE;
/** Gera um webp animado real (10 frames 128x128 @ 8fps). */
function fixtureAnimado() {
    if (FIXTURE) {
        return FIXTURE;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-fix-'));
    const file = path.join(dir, 'anim.webp');
    const res = spawnSync(FFMPEG, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=128x128:rate=8:duration=1',
        '-loop', '0', '-c:v', 'libwebp_anim', '-q:v', '70', file
    ], { stdio: 'ignore' });
    if (res.status !== 0 || !fs.existsSync(file)) {
        return null;
    }
    FIXTURE = fs.readFileSync(file);
    return FIXTURE;
}

describe('sticker → gif/mp4', () => {
    it('isWebP / isAnimatedWebP reconhecem o formato', () => {
        const animado = fixtureAnimado();
        assert.equal(isWebP(Buffer.from('nao é webp')), false, 'texto não é webp');
        assert.equal(isAnimatedWebP(Buffer.from('RIFF....WEBPVP8 ')), false, 'webp sem ANIM não é animado');
        if (animado) {
            assert.equal(isWebP(animado), true, 'fixture é webp');
            assert.equal(isAnimatedWebP(animado), true, 'fixture é animado');
        }
    });

    it('lê os frames (pages/pageHeight/delay) da figurinha animada', { skip: !HAS_FFMPEG }, async () => {
        const info = await getStickerFramesInfo(fixtureAnimado());
        assert.equal(info.pages, 8, '8 frames');
        assert.equal(info.width, 128);
        assert.equal(info.height, 128);
        assert.ok(info.delayMs > 0, 'tem delay');
        assert.ok(info.fps >= 1 && info.fps <= 50, 'fps dentro do teto');
    });

    it('figurinha animada → GIF animado (sharp, sem ffmpeg)', { skip: !HAS_FFMPEG }, async () => {
        const out = await stickerToGif(fixtureAnimado());
        assert.equal(out.mime, 'image/gif');
        assert.equal(out.ext, 'gif');
        assert.equal(out.buffer.slice(0, 3).toString('latin1'), 'GIF', 'magic GIF');
        assert.equal(out.pages, 8);
    });

    it('figurinha animada → MP4 (frames via sharp + H.264)', { skip: !HAS_FFMPEG }, async () => {
        const out = await stickerToMp4(fixtureAnimado());
        assert.equal(out.mime, 'video/mp4');
        assert.equal(out.ext, 'mp4');
        // `ftyp` no offset 4 = container MP4.
        assert.equal(out.buffer.slice(4, 8).toString('latin1'), 'ftyp', 'container MP4');
        assert.ok(out.buffer.length > 500, 'tem conteúdo');
    });

    it('convertSticker escolhe o formato e recusa o inválido', { skip: !HAS_FFMPEG }, async () => {
        const gif = await convertSticker(fixtureAnimado(), 'gif');
        assert.equal(gif.mime, 'image/gif');
        const mp4 = await convertSticker(fixtureAnimado(), 'mp4');
        assert.equal(mp4.mime, 'video/mp4');
        const video = await convertSticker(fixtureAnimado(), 'video');
        assert.equal(video.mime, 'video/mp4');
        await assert.rejects(() => convertSticker(fixtureAnimado(), 'webm'), /não suportado/i);
    });

    it('buffer vazio é recusado com erro claro', async () => {
        await assert.rejects(() => stickerToGif(Buffer.alloc(0)), /vazia/i);
        await assert.rejects(() => stickerToMp4(Buffer.alloc(0)), /vazia/i);
    });

    it('entrada que não é imagem falha (não trava)', async () => {
        await assert.rejects(() => stickerToGif(Buffer.from('nao é imagem')), /.*/);
    });

    it('teto de frames protege animações gigantes', { skip: !HAS_FFMPEG }, async () => {
        await assert.rejects(
            () => stickerToGif(fixtureAnimado(), { maxFrames: 2 }),
            /longa demais/i
        );
    });

    it('FFmpeg ausente no MP4 vira erro controlado', { skip: !HAS_FFMPEG }, async () => {
        await assert.rejects(
            () => stickerToMp4(fixtureAnimado(), { ffmpegPath: '/nao/existe/ffmpeg' }),
            /FFmpeg não disponível/i
        );
    });
});
