/**
 * Conversão de FIGURINHA para mídia reproduzível (GIF / MP4).
 *
 * Por que existe: a lib não expõe nenhuma forma de ler os frames de uma
 * figurinha animada. O decoder de WebP do FFmpeg **ignora** os chunks
 * `ANIM`/`ANMF` (medido: "skipping unsupported chunk: ANIM/ANMF") e devolve 0
 * frames — ou seja, FFmpeg sozinho não converte figurinha animada. O `sharp`
 * (libvips) **decodifica** os frames corretamente (`metadata.pages`,
 * `metadata.pageHeight`, `metadata.delay`), então:
 *
 *   - GIF  : o `sharp` gera o GIF animado direto (`sharp(buf,{animated}).gif()`);
 *   - MP4  : extraímos os frames crus RGBA pelo `sharp` e alimentamos o FFmpeg
 *            via `pipe:0` (rawvideo rgba), que codifica H.264 — sem depender do
 *            decoder de WebP do FFmpeg (que é o que falta).
 *
 * As mesmas conversões servem para qualquer imagem (estática vira 1 frame).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Boom } from '@hapi/boom';
import { getImageProcessingLibrary } from './messages-media.js';

const DEFAULT_FPS = 15;
const MAX_FPS = 50;
const DEFAULT_MAX_FRAMES = 600;

/** É um WebP? */
export const isWebP = (buf) =>
    Buffer.isBuffer(buf) && buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;

/** WebP **animado** (tem o chunk `ANIM`)? */
export const isAnimatedWebP = (buf) => {
    if (!isWebP(buf)) {
        return false;
    }
    let offset = 12;
    while (offset + 8 <= buf.length) {
        const fourCC = buf.toString('ascii', offset, offset + 4);
        const size = buf.readUInt32LE(offset + 4);
        if (fourCC === 'ANIM') {
            return true;
        }
        // `VP8X` tem flags de animação no bit 1 do primeiro byte de flags.
        if (fourCC === 'VP8X' && (buf[offset + 8] & 0x02)) {
            return true;
        }
        offset += 8 + size + (size & 1);
    }
    return false;
};

const clampFps = (fps) => {
    const n = Math.round(Number(fps));
    if (!Number.isFinite(n) || n < 1) {
        return DEFAULT_FPS;
    }
    return Math.min(n, MAX_FPS);
};

/** sharp obrigatório para a conversão — erro claro se não houver. */
async function requireSharp() {
    const lib = await getImageProcessingLibrary();
    if (!('sharp' in lib) || !lib.sharp?.default) {
        throw new Boom('Conversão de figurinha precisa do sharp instalado (libvips). Instale "sharp".');
    }
    return lib.sharp.default;
}

/** Metadados da animação (frames, dimensões e delay por frame). */
export async function getStickerFramesInfo(buffer) {
    const sharp = await requireSharp();
    const meta = await sharp(buffer, { animated: true }).metadata();
    const pages = Math.max(1, meta.pages || 1);
    const width = meta.width || 0;
    const pageHeight = meta.pageHeight || meta.height || 0;
    const delays = Array.isArray(meta.delay) && meta.delay.length ? meta.delay : Array(pages).fill(100);
    const delayMs = delays[0] || 100;
    return {
        pages,
        width,
        height: pageHeight,
        delays,
        delayMs,
        fps: clampFps(1000 / delayMs),
        loop: meta.loop ?? 0
    };
}

/**
 * Figurinha/imagem -> **GIF animado** (Buffer).
 *
 * @param {Buffer} buffer  webp (animado ou estático), png, jpg, gif...
 * @param {object} [opts]
 * @param {number} [opts.fps]       largura de quadro alvo (1..50, default 15)
 * @param {number} [opts.width]     redimensiona (mantém proporção)
 * @param {number} [opts.maxFrames] teto de frames (default 600)
 * @param {number} [opts.loop]      0 = infinito
 * @returns {Promise<{ buffer: Buffer, mime: string, ext: string, pages: number, fps: number }>}
 */
export async function stickerToGif(buffer, opts = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Boom('Figurinha vazia: nada para converter');
    }
    const sharp = await requireSharp();
    const info = await getStickerFramesInfo(buffer);
    const maxFrames = Number(opts.maxFrames) > 0 ? Number(opts.maxFrames) : DEFAULT_MAX_FRAMES;
    if (info.pages > maxFrames) {
        throw new Boom(`Animação longa demais (${info.pages} frames; máximo ${maxFrames})`);
    }
    // O delay do GIF é em ms e aceita array (respeita o ritmo original).
    const delay = info.pages > 1 ? info.delays : undefined;
    let img = sharp(buffer, { animated: true });
    if (Number(opts.width) > 0) {
        img = img.resize({ width: Math.round(Number(opts.width)) });
    }
    // O `sharp` gera o GIF animado preservando os frames.
    const gif = await img.gif({ loop: opts.loop ?? 0, delay }).toBuffer();
    if (!gif?.length) {
        throw new Boom('Falha ao gerar o GIF');
    }
    return { buffer: gif, mime: 'image/gif', ext: 'gif', pages: info.pages, fps: opts.fps ? clampFps(opts.fps) : info.fps };
}

/**
 * Figurinha/imagem -> **MP4** (H.264) (Buffer).
 *
 * Extrai os frames crus RGBA pelo `sharp` e os entrega ao FFmpeg por
 * `pipe:0` (`-f rawvideo -pix_fmt rgba`). Não usa o decoder de WebP do
 * FFmpeg (que ignora `ANIM`/`ANMF`).
 *
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @param {string} [opts.ffmpegPath] executável (default `process.env.FFMPEG_PATH` || `ffmpeg`)
 * @param {number} [opts.fps]
 * @param {number} [opts.width]
 * @param {number} [opts.maxFrames]
 * @param {number} [opts.crf]         qualidade H.264 (0..51, default 23)
 * @param {number} [opts.timeoutMs]  cancela o processo (default 60s)
 * @returns {Promise<{ buffer: Buffer, mime: string, ext: string, pages: number, fps: number }>}
 */
export async function stickerToMp4(buffer, opts = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Boom('Figurinha vazia: nada para converter');
    }
    const sharp = await requireSharp();
    const info = await getStickerFramesInfo(buffer);
    const maxFrames = Number(opts.maxFrames) > 0 ? Number(opts.maxFrames) : DEFAULT_MAX_FRAMES;
    if (info.pages > maxFrames) {
        throw new Boom(`Animação longa demais (${info.pages} frames; máximo ${maxFrames})`);
    }
    const fps = clampFps(opts.fps || info.fps);
    // Frames crus RGBA (o vips já entrega tudo em um buffer contíguo).
    const { data, info: raw } = await sharp(buffer, { animated: true })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const width = raw.width;
    const height = raw.height / info.pages; // pageHeight aplicado no buffer final
    const channels = raw.channels;
    const frameSize = width * height * channels;
    if (!width || !height || data.length < frameSize) {
        throw new Boom('Não foi possível ler os frames da figurinha');
    }
    const ffmpegPath = opts.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
    const crf = Number.isFinite(Number(opts.crf)) ? Math.min(51, Math.max(0, Number(opts.crf))) : 23;
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60_000;
    // O muxer MP4 exige saída SEEKABLE (não aceita `pipe:1`), então escrevemos
    // num arquivo temporário e lemos o buffer de volta. O temp é sempre limpo.
    const dir = await mkdtemp(path.join(tmpdir(), 'baileys-sticker-'));
    const outFile = path.join(dir, 'sticker.mp4');
    const args = [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps),
        '-i', 'pipe:0',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf),
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
        outFile
    ];
    try {
        await runFfmpeg(ffmpegPath, args, data, info.pages, frameSize, timeoutMs);
        const mp4 = await readFile(outFile);
        if (!mp4?.length) {
            throw new Boom('Falha ao gerar o MP4');
        }
        return { buffer: mp4, mime: 'video/mp4', ext: 'mp4', pages: info.pages, fps };
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => { });
    }
}

/** Toca o FFmpeg com os frames em `stdin`; saída vai para o arquivo em `args`. */
function runFfmpeg(ffmpegPath, args, data, pages, frameSize, timeoutMs) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
        } catch (error) {
            reject(new Boom(`Não foi possível executar o FFmpeg: ${error?.message || error}`));
            return;
        }
        let err = '';
        let done = false;
        const fail = (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { child.kill('SIGKILL'); } catch { /* já morto */ }
            reject(error);
        };
        const timer = setTimeout(() => fail(new Boom(`FFmpeg excedeu ${timeoutMs}ms`)), timeoutMs);
        child.on('error', (e) => fail(new Boom(`FFmpeg não disponível (${e?.code || e?.message})`)));
        child.stderr?.on('data', (chunk) => { err += chunk; });
        child.on('close', (code) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Boom(`FFmpeg terminou com código ${code}: ${String(err).slice(0, 300)}`));
                return;
            }
            resolve();
        });
        // Escreve um frame por vez; respeita o backpressure.
        let i = 0;
        const writeNext = () => {
            if (done) return;
            if (i >= pages) {
                child.stdin.end();
                return;
            }
            const slice = data.subarray(i * frameSize, (i + 1) * frameSize);
            i += 1;
            if (child.stdin.write(slice)) {
                setImmediate(writeNext);
            } else {
                child.stdin.once('drain', writeNext);
            }
        };
        child.stdin.on('error', () => { /* EPIPE quando o ffmpeg falha: o close já rejeita */ });
        writeNext();
    });
}

/**
 * Atalho: converte conforme o formato pedido e devolve `{ buffer, mime, ext }`.
 * @param {Buffer} buffer
 * @param {'gif'|'mp4'} format
 */
export async function convertSticker(buffer, format = 'gif', opts = {}) {
    const fmt = String(format).toLowerCase();
    if (fmt === 'gif') {
        return stickerToGif(buffer, opts);
    }
    if (fmt === 'mp4' || fmt === 'video') {
        return stickerToMp4(buffer, opts);
    }
    throw new Boom(`Formato não suportado: ${format} (use "gif" ou "mp4")`);
}
