#!/usr/bin/env node
/**
 * Adiciona ChatAnimatedWallpaper ao WAProto gerado da fork.
 *
 * POR QUE ISTO EXISTE (evidencia, nao suposicao)
 *
 * A fonte da verdade e o spec INTERNO do WhatsApp Web
 * (`Message$ChatAnimatedWallpaper` em WAWebProtobufsE2E_pb.js):
 *
 *     animatedWallpaperId: [1, STRING]
 *     dimLevel:            [2, FLOAT]
 *
 * e, no pai `ChatThemeSetting`, a variante do oneof `wallpaper`:
 *
 *     animatedWallpaper: [14, MESSAGE]
 *
 * O WAProto DESTA fork nao gerou essa message nem essa variante — medido:
 * `proto.Message.ChatAnimatedWallpaper` e `undefined`, e encodar
 * `{ animatedWallpaper: ... }` produz **0 bytes** (o campo e silenciosamente
 * ignorado). As outras 4 variantes (10..13) existem.
 *
 * Como o WAProto e ARTEFATO GERADO e a fork nao guarda o `.proto` nem o `pbjs`,
 * o delta e aplicado de forma DETERMINISTICA e idempotente, reproduzindo o mesmo
 * estilo que o gerador usa nas messages vizinhas (`ChatStockImageWallpaper`).
 *
 * Uso:
 *   node scripts/add-chat-animated-wallpaper.js          # aplica
 *   node scripts/add-chat-animated-wallpaper.js --check  # so verifica
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const JS = path.join(ROOT, 'WAProto', 'index.js');
const DTS = path.join(ROOT, 'WAProto', 'index.d.ts');

const CHECK_ONLY = process.argv.includes('--check');

const onlyOnce = (source, needle, label) => {
  const n = source.split(needle).length - 1;
  if (n !== 1) {
    throw new Error(`[chat-theme] esperava 1 ocorrencia de ${label}, achei ${n}`);
  }
};

/** Message nova, no mesmo estilo do ChatStockImageWallpaper. */
const buildMessageBlock = () => `        Message.ChatAnimatedWallpaper = (function() {

            function ChatAnimatedWallpaper(p) {
                if (p)
                    for (var ks = Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            }

            ChatAnimatedWallpaper.prototype.animatedWallpaperId = null;
            ChatAnimatedWallpaper.prototype.dimLevel = null;

            let $oneOfFields;

            // Virtual OneOf for proto3 optional field
            Object.defineProperty(ChatAnimatedWallpaper.prototype, "_animatedWallpaperId", {
                get: $util.oneOfGetter($oneOfFields = ["animatedWallpaperId"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            // Virtual OneOf for proto3 optional field
            Object.defineProperty(ChatAnimatedWallpaper.prototype, "_dimLevel", {
                get: $util.oneOfGetter($oneOfFields = ["dimLevel"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            ChatAnimatedWallpaper.create = function create(properties) {
                return new ChatAnimatedWallpaper(properties);
            };

            ChatAnimatedWallpaper.encode = function encode(m, w) {
                if (!w)
                    w = $Writer.create();
                if (m.animatedWallpaperId != null && Object.hasOwnProperty.call(m, "animatedWallpaperId"))
                    w.uint32(10).string(m.animatedWallpaperId);
                if (m.dimLevel != null && Object.hasOwnProperty.call(m, "dimLevel"))
                    w.uint32(21).float(m.dimLevel);
                return w;
            };

            ChatAnimatedWallpaper.encodeDelimited = function encodeDelimited(m, w) {
                return this.encode(m, w).ldelim();
            };

            ChatAnimatedWallpaper.decode = function decode(r, l, e, n) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (n === undefined)
                    n = 0;
                if (n > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var c = l === undefined ? r.len : r.pos + l, m = new $root.proto.Message.ChatAnimatedWallpaper();
                while (r.pos < c) {
                    var t = r.uint32();
                    if (t === e)
                        break;
                    switch (t >>> 3) {
                    case 1: {
                            m.animatedWallpaperId = r.string();
                            break;
                        }
                    case 2: {
                            m.dimLevel = r.float();
                            break;
                        }
                    default:
                        r.skipType(t & 7, n);
                        break;
                    }
                }
                return m;
            };

            ChatAnimatedWallpaper.decodeDelimited = function decodeDelimited(r) {
                if (!(r instanceof $Reader))
                    r = new $Reader(r);
                return this.decode(r, r.uint32());
            };

            ChatAnimatedWallpaper.verify = function verify(m) {
                if (typeof m !== "object" || m === null)
                    return "object expected";
                var properties = {};
                if (m.animatedWallpaperId != null && m.hasOwnProperty("animatedWallpaperId")) {
                    properties._animatedWallpaperId = 1;
                    if (!$util.isString(m.animatedWallpaperId))
                        return "animatedWallpaperId: string expected";
                }
                if (m.dimLevel != null && m.hasOwnProperty("dimLevel")) {
                    properties._dimLevel = 1;
                    if (typeof m.dimLevel !== "number")
                        return "dimLevel: number expected";
                }
                return null;
            };

            ChatAnimatedWallpaper.fromObject = function fromObject(o) {
                if (o instanceof $root.proto.Message.ChatAnimatedWallpaper)
                    return o;
                var m = new $root.proto.Message.ChatAnimatedWallpaper();
                if (o.animatedWallpaperId != null)
                    m.animatedWallpaperId = String(o.animatedWallpaperId);
                if (o.dimLevel != null)
                    m.dimLevel = Number(o.dimLevel);
                return m;
            };

            ChatAnimatedWallpaper.toObject = function toObject(m, o) {
                if (!o)
                    o = {};
                var d = {};
                if (m.animatedWallpaperId != null && m.hasOwnProperty("animatedWallpaperId")) {
                    d.animatedWallpaperId = m.animatedWallpaperId;
                    if (o.oneofs)
                        d._animatedWallpaperId = "animatedWallpaperId";
                }
                if (m.dimLevel != null && m.hasOwnProperty("dimLevel")) {
                    d.dimLevel = o.defaults ? m.dimLevel : m.dimLevel;
                    if (o.oneofs)
                        d._dimLevel = "dimLevel";
                }
                return d;
            };

            ChatAnimatedWallpaper.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            ChatAnimatedWallpaper.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/proto.Message.ChatAnimatedWallpaper";
            };

            return ChatAnimatedWallpaper;
        })();

`;

const editsJs = (src) => {
  let out = src;

  // 1) prototype do pai: entra logo depois do customImage
  const protoNeedle = `            ChatThemeSetting.prototype.customImage = null;`;
  onlyOnce(out, protoNeedle, 'ChatThemeSetting.prototype.customImage');
  out = out.replace(protoNeedle, `${protoNeedle}\n            ChatThemeSetting.prototype.animatedWallpaper = null;`);

  // 2) oneOf virtual do campo novo.
  //
  // ATENCAO: neste bloco o gerador NAO emite um `_customImage` individual, so o
  // GRUPO do oneof `wallpaper` (passo 3). Por isso o campo novo nao ganha um
  // `Object.defineProperty` proprio — ele entra no grupo, exatamente como os
  // outros membros. (Medido: `grep _customImage` no bloco -> 0 ocorrencias.)

  // 3) o GRUPO do oneof `wallpaper` declarado pelo gerador (unico em ChatThemeSetting)
  onlyOnce(out, `Object.defineProperty(ChatThemeSetting.prototype, "wallpaper", {
                get: $util.oneOfGetter($oneOfFields = ["defaultWallpaper", "solidColor", "stockImage", "customImage"]),`,
    'oneOfGetter do wallpaper');
  out = out.replace(
    `get: $util.oneOfGetter($oneOfFields = ["defaultWallpaper", "solidColor", "stockImage", "customImage"]),`,
    `get: $util.oneOfGetter($oneOfFields = ["defaultWallpaper", "solidColor", "stockImage", "customImage", "animatedWallpaper"]),`
  );

  // 4) encode: campo 14 -> tag (14<<3)|2 = 114
  const encNeedle = `                if (m.customImage != null && Object.hasOwnProperty.call(m, "customImage"))
                    $root.proto.Message.ChatCustomImageWallpaper.encode(m.customImage, w.uint32(106).fork()).ldelim();`;
  onlyOnce(out, encNeedle, 'customImage (encode)');
  out = out.replace(encNeedle, `${encNeedle}
                if (m.animatedWallpaper != null && Object.hasOwnProperty.call(m, "animatedWallpaper"))
                    $root.proto.Message.ChatAnimatedWallpaper.encode(m.animatedWallpaper, w.uint32(114).fork()).ldelim();`);

  // 5) decode: case 14
  const decNeedle = `                    case 13: {
                            m.customImage = $root.proto.Message.ChatCustomImageWallpaper.decode(r, r.uint32(), undefined, n + 1);
                            break;
                        }`;
  onlyOnce(out, decNeedle, 'customImage (decode)');
  out = out.replace(decNeedle, `${decNeedle}
                    case 14: {
                            m.animatedWallpaper = $root.proto.Message.ChatAnimatedWallpaper.decode(r, r.uint32(), undefined, n + 1);
                            break;
                        }`);

  // 6) toObject — aqui o membro do oneof usa `d.wallpaper`, nao `d._customImage`
  const toNeedle = `                if (m.customImage != null && m.hasOwnProperty("customImage")) {
                    d.customImage = $root.proto.Message.ChatCustomImageWallpaper.toObject(m.customImage, o);
                    if (o.oneofs)
                        d.wallpaper = "customImage";
                }`;
  onlyOnce(out, toNeedle, 'customImage (toObject)');
  out = out.replace(toNeedle, `${toNeedle}
                if (m.animatedWallpaper != null && m.hasOwnProperty("animatedWallpaper")) {
                    d.animatedWallpaper = $root.proto.Message.ChatAnimatedWallpaper.toObject(m.animatedWallpaper, o);
                    if (o.oneofs)
                        d.wallpaper = "animatedWallpaper";
                }`);

  // 7) a message nova, antes do pai que a referencia
  const declNeedle = `        Message.ChatThemeSetting = (function() {`;
  onlyOnce(out, declNeedle, 'Message.ChatThemeSetting (declaracao)');
  out = out.replace(declNeedle, `${buildMessageBlock()}${declNeedle}`);

  return out;
};

const buildInterfaceDts = () => `        interface IChatAnimatedWallpaper {
            animatedWallpaperId?: (string|null);
            dimLevel?: (number|null);
        }

        class ChatAnimatedWallpaper implements IChatAnimatedWallpaper {
            constructor(p?: proto.Message.IChatAnimatedWallpaper);
            public animatedWallpaperId?: (string|null);
            public dimLevel?: (number|null);
            public static create(properties?: proto.Message.IChatAnimatedWallpaper): proto.Message.ChatAnimatedWallpaper;
            public static encode(m: proto.Message.IChatAnimatedWallpaper, w?: $protobuf.Writer): $protobuf.Writer;
            public static decode(r: ($protobuf.Reader|Uint8Array), l?: number): proto.Message.ChatAnimatedWallpaper;
            public static fromObject(d: { [k: string]: any }): proto.Message.ChatAnimatedWallpaper;
            public static toObject(m: proto.Message.ChatAnimatedWallpaper, o?: $protobuf.IConversionOptions): { [k: string]: any };
            public toJSON(): { [k: string]: any };
            public static getTypeUrl(typeUrlPrefix?: string): string;
        }

`;

const editsDts = (src) => {
  let out = src;

  const fieldNeedle = `            customImage?: (proto.Message.IChatCustomImageWallpaper|null);`;
  onlyOnce(out, fieldNeedle, 'customImage (d.ts interface)');
  out = out.replace(fieldNeedle, `${fieldNeedle}\n            animatedWallpaper?: (proto.Message.IChatAnimatedWallpaper|null);`);

  const classNeedle = `            public customImage?: (proto.Message.IChatCustomImageWallpaper|null);`;
  onlyOnce(out, classNeedle, 'customImage (d.ts class)');
  out = out.replace(classNeedle, `${classNeedle}\n            public animatedWallpaper?: (proto.Message.IChatAnimatedWallpaper|null);`);

  const oneofNeedle = `            public wallpaper?: ("defaultWallpaper"|"solidColor"|"stockImage"|"customImage");`;
  onlyOnce(out, oneofNeedle, 'wallpaper oneof (d.ts)');
  out = out.replace(oneofNeedle, `            public wallpaper?: ("defaultWallpaper"|"solidColor"|"stockImage"|"customImage"|"animatedWallpaper");`);

  const nsNeedle = `        interface IChatThemeSetting {`;
  onlyOnce(out, nsNeedle, 'IChatThemeSetting (d.ts)');
  out = out.replace(nsNeedle, `${buildInterfaceDts()}${nsNeedle}`);

  return out;
};

const aplicar = (file, transform) => {
  const before = fs.readFileSync(file, 'utf8');
  if (before.includes('ChatAnimatedWallpaper')) {
    console.log(`[chat-theme] ${path.basename(file)}: ja contem (nada a fazer)`);
    return false;
  }
  const after = transform(before);
  if (CHECK_ONLY) {
    console.log(`[chat-theme] ${path.basename(file)}: delta calculado OK (--check)`);
    return false;
  }
  fs.writeFileSync(file, after);
  console.log(`[chat-theme] ${path.basename(file)}: atualizado`);
  return true;
};

try {
  const a = aplicar(JS, editsJs);
  const b = aplicar(DTS, editsDts);
  console.log(`[chat-theme] ${a || b ? 'aplicado' : 'nada a aplicar'}`);
} catch (e) {
  console.error(`[chat-theme] ERRO: ${e.message}`);
  process.exit(1);
}
