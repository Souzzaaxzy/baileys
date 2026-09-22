#!/usr/bin/env node
/**
 * Adiciona MarkAsVerifiedAction ao WAProto gerado da fork.
 *
 * POR QUE UM SCRIPT E NAO EDICAO A MAO
 *
 * `WAProto/index.js` e `index.d.ts` sao ARTEFATOS GERADOS (protobufjs). A fork
 * nao guarda o `.proto` de origem nem o gerador (nao ha `pbjs` no projeto e o
 * pacote publica apenas `WAProto/**`). Editar o artefato a mao e o caminho que
 * sobra — entao ele e feito de forma DETERMINISTICA, idempotente e verificavel,
 * aplicando exatamente as unidades que o gerador produziria.
 *
 * Fonte da verdade do schema: o spec INTERNO do WhatsApp Web
 * (`Message$MarkAsVerifiedAction` em WAWebProtobufsE2E_pb.js):
 *
 *   1  userJidString        STRING
 *   2  verified             BOOL
 *   3  verifiedIdentityKey  BYTES
 *   4  actionSeq            UINT64
 *
 * e, no pai:
 *
 *   32 markAsVerifiedAction MESSAGE (MarkAsVerifiedAction)
 *
 * Uso:
 *   node scripts/add-mark-as-verified-action.js         # aplica
 *   node scripts/add-mark-as-verified-action.js --check # so verifica
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
    throw new Error(`[proto] esperava 1 ocorrencia de ${label}, achei ${n}`);
  }
};

const buildMessageBlock = () => `        Message.MarkAsVerifiedAction = (function() {

            function MarkAsVerifiedAction(p) {
                if (p)
                    for (var ks = Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            }

            MarkAsVerifiedAction.prototype.userJidString = null;
            MarkAsVerifiedAction.prototype.verified = null;
            MarkAsVerifiedAction.prototype.verifiedIdentityKey = null;
            MarkAsVerifiedAction.prototype.actionSeq = null;

            let $oneOfFields;

            // Virtual OneOf for proto3 optional field
            Object.defineProperty(MarkAsVerifiedAction.prototype, "_userJidString", {
                get: $util.oneOfGetter($oneOfFields = ["userJidString"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            // Virtual OneOf for proto3 optional field
            Object.defineProperty(MarkAsVerifiedAction.prototype, "_verified", {
                get: $util.oneOfGetter($oneOfFields = ["verified"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            // Virtual OneOf for proto3 optional field
            Object.defineProperty(MarkAsVerifiedAction.prototype, "_verifiedIdentityKey", {
                get: $util.oneOfGetter($oneOfFields = ["verifiedIdentityKey"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            // Virtual OneOf for proto3 optional field
            Object.defineProperty(MarkAsVerifiedAction.prototype, "_actionSeq", {
                get: $util.oneOfGetter($oneOfFields = ["actionSeq"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            MarkAsVerifiedAction.create = function create(properties) {
                return new MarkAsVerifiedAction(properties);
            };

            MarkAsVerifiedAction.encode = function encode(m, w) {
                if (!w)
                    w = $Writer.create();
                if (m.userJidString != null && Object.hasOwnProperty.call(m, "userJidString"))
                    w.uint32(10).string(m.userJidString);
                if (m.verified != null && Object.hasOwnProperty.call(m, "verified"))
                    w.uint32(16).bool(m.verified);
                if (m.verifiedIdentityKey != null && Object.hasOwnProperty.call(m, "verifiedIdentityKey"))
                    w.uint32(26).bytes(m.verifiedIdentityKey);
                if (m.actionSeq != null && Object.hasOwnProperty.call(m, "actionSeq"))
                    w.uint32(32).uint64(m.actionSeq);
                return w;
            };

            MarkAsVerifiedAction.encodeDelimited = function encodeDelimited(m, w) {
                return this.encode(m, w).ldelim();
            };

            MarkAsVerifiedAction.decode = function decode(r, l, e, n) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (n === undefined)
                    n = 0;
                if (n > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var c = l === undefined ? r.len : r.pos + l, m = new $root.proto.Message.MarkAsVerifiedAction();
                while (r.pos < c) {
                    var t = r.uint32();
                    if (t === e)
                        break;
                    switch (t >>> 3) {
                    case 1: {
                            m.userJidString = r.string();
                            break;
                        }
                    case 2: {
                            m.verified = r.bool();
                            break;
                        }
                    case 3: {
                            m.verifiedIdentityKey = r.bytes();
                            break;
                        }
                    case 4: {
                            m.actionSeq = r.uint64();
                            break;
                        }
                    default:
                        r.skipType(t & 7, n);
                        break;
                    }
                }
                return m;
            };

            MarkAsVerifiedAction.decodeDelimited = function decodeDelimited(r) {
                if (!(r instanceof $Reader))
                    r = new $Reader(r);
                return this.decode(r, r.uint32());
            };

            MarkAsVerifiedAction.verify = function verify(m) {
                if (typeof m !== "object" || m === null)
                    return "object expected";
                var properties = {};
                if (m.userJidString != null && m.hasOwnProperty("userJidString")) {
                    properties._userJidString = 1;
                    if (!$util.isString(m.userJidString))
                        return "userJidString: string expected";
                }
                if (m.verified != null && m.hasOwnProperty("verified")) {
                    properties._verified = 1;
                    if (typeof m.verified !== "boolean")
                        return "verified: boolean expected";
                }
                if (m.verifiedIdentityKey != null && m.hasOwnProperty("verifiedIdentityKey")) {
                    properties._verifiedIdentityKey = 1;
                    if (!(m.verifiedIdentityKey && typeof m.verifiedIdentityKey.length === "number" || $util.isString(m.verifiedIdentityKey)))
                        return "verifiedIdentityKey: buffer expected";
                }
                if (m.actionSeq != null && m.hasOwnProperty("actionSeq")) {
                    properties._actionSeq = 1;
                    if (!$util.isInteger(m.actionSeq) && !(m.actionSeq && $util.isInteger(m.actionSeq.low) && $util.isInteger(m.actionSeq.high)))
                        return "actionSeq: integer|Long expected";
                }
                return null;
            };

            MarkAsVerifiedAction.fromObject = function fromObject(o) {
                if (o instanceof $root.proto.Message.MarkAsVerifiedAction)
                    return o;
                var m = new $root.proto.Message.MarkAsVerifiedAction();
                if (o.userJidString != null)
                    m.userJidString = String(o.userJidString);
                if (o.verified != null)
                    m.verified = Boolean(o.verified);
                if (o.verifiedIdentityKey != null)
                    if (typeof o.verifiedIdentityKey === "string")
                        $util.base64.decode(o.verifiedIdentityKey, m.verifiedIdentityKey = $util.newBuffer($util.base64.length(o.verifiedIdentityKey)), 0);
                    else if (o.verifiedIdentityKey.length >= 0)
                        m.verifiedIdentityKey = o.verifiedIdentityKey;
                if (o.actionSeq != null)
                    if ($util.Long)
                        (m.actionSeq = $util.Long.fromValue(o.actionSeq)).unsigned = true;
                    else if (typeof o.actionSeq === "string")
                        m.actionSeq = parseInt(o.actionSeq, 10);
                    else if (typeof o.actionSeq === "number")
                        m.actionSeq = o.actionSeq;
                    else if (typeof o.actionSeq === "object")
                        m.actionSeq = new $util.LongBits(o.actionSeq.low >>> 0, o.actionSeq.high >>> 0).toNumber(true);
                return m;
            };

            MarkAsVerifiedAction.toObject = function toObject(m, o) {
                if (!o)
                    o = {};
                var d = {};
                if (m.userJidString != null && m.hasOwnProperty("userJidString")) {
                    d.userJidString = m.userJidString;
                    if (o.oneofs)
                        d._userJidString = "userJidString";
                }
                if (m.verified != null && m.hasOwnProperty("verified")) {
                    d.verified = m.verified;
                    if (o.oneofs)
                        d._verified = "verified";
                }
                if (m.verifiedIdentityKey != null && m.hasOwnProperty("verifiedIdentityKey")) {
                    d.verifiedIdentityKey = o.bytes === String ? $util.base64.encode(m.verifiedIdentityKey, 0, m.verifiedIdentityKey.length) : o.bytes === Array ? Array.prototype.slice.call(m.verifiedIdentityKey) : m.verifiedIdentityKey;
                    if (o.oneofs)
                        d._verifiedIdentityKey = "verifiedIdentityKey";
                }
                if (m.actionSeq != null && m.hasOwnProperty("actionSeq")) {
                    if (typeof m.actionSeq === "number")
                        d.actionSeq = o.longs === String ? String(m.actionSeq) : m.actionSeq;
                    else
                        d.actionSeq = o.longs === String ? $util.Long.prototype.toString.call(m.actionSeq) : o.longs === Number ? new $util.LongBits(m.actionSeq.low >>> 0, m.actionSeq.high >>> 0).toNumber(true) : m.actionSeq;
                    if (o.oneofs)
                        d._actionSeq = "actionSeq";
                }
                return d;
            };

            MarkAsVerifiedAction.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            MarkAsVerifiedAction.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/proto.Message.MarkAsVerifiedAction";
            };

            return MarkAsVerifiedAction;
        })();

`;

const editsJs = (src) => {
  let out = src;

  const enumNeedle = `                values[valuesById[35] = "AI_METADATA_OPERATION"] = 35;`;
  onlyOnce(out, enumNeedle, 'AI_METADATA_OPERATION (enum)');
  out = out.replace(enumNeedle, `${enumNeedle}\n                values[valuesById[36] = "MARK_AS_VERIFIED_ACTION"] = 36;`);

  const protoNeedle = `            ProtocolMessage.prototype.aiMetadataOperation = null;`;
  onlyOnce(out, protoNeedle, 'aiMetadataOperation (prototype)');
  out = out.replace(protoNeedle, `${protoNeedle}\n            ProtocolMessage.prototype.markAsVerifiedAction = null;`);

  const oneOfNeedle = `            // Virtual OneOf for proto3 optional field
            Object.defineProperty(ProtocolMessage.prototype, "_aiMetadataOperation", {
                get: $util.oneOfGetter($oneOfFields = ["aiMetadataOperation"]),
                set: $util.oneOfSetter($oneOfFields)
            });`;
  onlyOnce(out, oneOfNeedle, '_aiMetadataOperation (oneOf)');
  out = out.replace(oneOfNeedle, `${oneOfNeedle}

            // Virtual OneOf for proto3 optional field
            Object.defineProperty(ProtocolMessage.prototype, "_markAsVerifiedAction", {
                get: $util.oneOfGetter($oneOfFields = ["markAsVerifiedAction"]),
                set: $util.oneOfSetter($oneOfFields)
            });`);

  const encNeedle = `                if (m.aiMetadataOperation != null && Object.hasOwnProperty.call(m, "aiMetadataOperation"))
                    $root.proto.AIMetadataOperation.encode(m.aiMetadataOperation, w.uint32(250).fork()).ldelim();`;
  onlyOnce(out, encNeedle, 'aiMetadataOperation (encode)');
  out = out.replace(encNeedle, `${encNeedle}
                if (m.markAsVerifiedAction != null && Object.hasOwnProperty.call(m, "markAsVerifiedAction"))
                    $root.proto.Message.MarkAsVerifiedAction.encode(m.markAsVerifiedAction, w.uint32(258).fork()).ldelim();`);

  const decNeedle = `                    case 31: {
                            m.aiMetadataOperation = $root.proto.AIMetadataOperation.decode(r, r.uint32(), undefined, n + 1);
                            break;
                        }`;
  onlyOnce(out, decNeedle, 'aiMetadataOperation (decode)');
  out = out.replace(decNeedle, `${decNeedle}
                    case 32: {
                            m.markAsVerifiedAction = $root.proto.Message.MarkAsVerifiedAction.decode(r, r.uint32(), undefined, n + 1);
                            break;
                        }`);

  const toNeedle = `                if (m.aiMetadataOperation != null && m.hasOwnProperty("aiMetadataOperation")) {
                    d.aiMetadataOperation = $root.proto.AIMetadataOperation.toObject(m.aiMetadataOperation, o);
                    if (o.oneofs)
                        d._aiMetadataOperation = "aiMetadataOperation";
                }`;
  onlyOnce(out, toNeedle, 'aiMetadataOperation (toObject)');
  out = out.replace(toNeedle, `${toNeedle}
                if (m.markAsVerifiedAction != null && m.hasOwnProperty("markAsVerifiedAction")) {
                    d.markAsVerifiedAction = $root.proto.Message.MarkAsVerifiedAction.toObject(m.markAsVerifiedAction, o);
                    if (o.oneofs)
                        d._markAsVerifiedAction = "markAsVerifiedAction";
                }`);

  const declNeedle = `        Message.ProtocolMessage = (function() {`;
  onlyOnce(out, declNeedle, 'Message.ProtocolMessage (declaracao)');
  out = out.replace(declNeedle, `${buildMessageBlock()}${declNeedle}`);

  return out;
};

const buildInterfaceDts = () => `        interface IMarkAsVerifiedAction {
            userJidString?: (string|null);
            verified?: (boolean|null);
            verifiedIdentityKey?: (Uint8Array|null);
            actionSeq?: (number|Long|null);
        }

        class MarkAsVerifiedAction implements IMarkAsVerifiedAction {
            constructor(p?: proto.Message.IMarkAsVerifiedAction);
            public userJidString?: (string|null);
            public verified?: (boolean|null);
            public verifiedIdentityKey?: (Uint8Array|null);
            public actionSeq?: (number|Long|null);
            public static create(properties?: proto.Message.IMarkAsVerifiedAction): proto.Message.MarkAsVerifiedAction;
            public static encode(m: proto.Message.IMarkAsVerifiedAction, w?: $protobuf.Writer): $protobuf.Writer;
            public static decode(r: ($protobuf.Reader|Uint8Array), l?: number): proto.Message.MarkAsVerifiedAction;
            public static fromObject(d: { [k: string]: any }): proto.Message.MarkAsVerifiedAction;
            public static toObject(m: proto.Message.MarkAsVerifiedAction, o?: $protobuf.IConversionOptions): { [k: string]: any };
            public toJSON(): { [k: string]: any };
            public static getTypeUrl(typeUrlPrefix?: string): string;
        }

`;

const editsDts = (src) => {
  let out = src;

  const enumNeedle = `                AI_METADATA_OPERATION = 35`;
  onlyOnce(out, enumNeedle, 'AI_METADATA_OPERATION (d.ts enum)');
  out = out.replace(enumNeedle, `${enumNeedle},\n                MARK_AS_VERIFIED_ACTION = 36`);

  const fieldNeedle = `            aiMetadataOperation?: (proto.IAIMetadataOperation|null);`;
  onlyOnce(out, fieldNeedle, 'aiMetadataOperation (d.ts interface)');
  out = out.replace(fieldNeedle, `${fieldNeedle}\n            markAsVerifiedAction?: (proto.Message.IMarkAsVerifiedAction|null);`);

  const classNeedle = `            public aiMetadataOperation?: (proto.IAIMetadataOperation|null);`;
  onlyOnce(out, classNeedle, 'aiMetadataOperation (d.ts class)');
  out = out.replace(classNeedle, `${classNeedle}\n            public markAsVerifiedAction?: (proto.Message.IMarkAsVerifiedAction|null);`);

  const nsNeedle = `        interface IProtocolMessage {`;
  onlyOnce(out, nsNeedle, 'IProtocolMessage (d.ts)');
  out = out.replace(nsNeedle, `${buildInterfaceDts()}${nsNeedle}`);

  return out;
};

const aplicar = (file, transform) => {
  const before = fs.readFileSync(file, 'utf8');
  if (before.includes('markAsVerifiedAction')) {
    console.log(`[proto] ${path.basename(file)}: ja contem o campo (nada a fazer)`);
    return false;
  }
  const after = transform(before);
  if (CHECK_ONLY) {
    console.log(`[proto] ${path.basename(file)}: delta calculado OK (--check)`);
    return false;
  }
  fs.writeFileSync(file, after);
  console.log(`[proto] ${path.basename(file)}: atualizado`);
  return true;
};

try {
  const a = aplicar(JS, editsJs);
  const b = aplicar(DTS, editsDts);
  console.log(`[proto] ${a || b ? 'aplicado' : 'nada a aplicar'}`);
} catch (e) {
  console.error(`[proto] ERRO: ${e.message}`);
  process.exit(1);
}
