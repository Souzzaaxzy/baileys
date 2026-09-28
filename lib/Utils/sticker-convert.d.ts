export type StickerConvertResult = {
    buffer: Buffer;
    mime: string;
    ext: string;
    pages: number;
    fps: number;
};
export declare const isWebP: (buf: Buffer) => boolean;
export declare const isAnimatedWebP: (buf: Buffer) => boolean;
export declare function getStickerFramesInfo(buffer: Buffer): Promise<{
    pages: number;
    width: number;
    height: number;
    delays: number[];
    delayMs: number;
    fps: number;
    loop: number;
}>;
export declare function stickerToGif(buffer: Buffer, opts?: {
    fps?: number;
    width?: number;
    maxFrames?: number;
    loop?: number;
}): Promise<StickerConvertResult>;
export declare function stickerToMp4(buffer: Buffer, opts?: {
    ffmpegPath?: string;
    fps?: number;
    width?: number;
    maxFrames?: number;
    crf?: number;
    timeoutMs?: number;
}): Promise<StickerConvertResult>;
export declare function convertSticker(buffer: Buffer, format?: 'gif' | 'mp4' | 'video', opts?: object): Promise<StickerConvertResult>;
//# sourceMappingURL=sticker-convert.d.ts.map
