#!/usr/bin/env node
/**
 * Adiciona as acoes de app-state novas ao WAProto gerado da fork.
 *
 * POR QUE UM SCRIPT E NAO EDICAO A MAO
 *
 * `WAProto/index.js` e `index.d.ts` sao ARTEFATOS GERADOS (protobufjs). A fork
 * nao guarda o `.proto` de origem nem o gerador. Editar o artefato a mao e o
 * caminho que sobra -- entao ele e feito de forma DETERMINISTICA, idempotente e
 * verificavel, aplicando exatamente as unidades que o gerador produziria.
 * Mesmo padrao de `scripts/add-mark-as-verified-action.js`.
 *
 * FONTE DA VERDADE DO SCHEMA
 *
 * Spec interno do WhatsApp Web (`WAWebProtobufsSyncAction.proto`, extraido pelo
 * whatsmeow), com o field number de cada acao no `SyncActionValue`:
 *
 *   90  bubbleLockMessageAction        -> BubbleLockMessageAction      { locked BOOL }
 *   91  labelSublistAction             -> LabelSublistAction           { subListID INT32 }
 *   94  sharedDeviceAllowlistAction    -> SharedDeviceAllowlistAction  { allowed BOOL }
 *   95  contactManagerMetadataAction   -> ContactManagerMetadataAction { isHidden BOOL }
 *   96  businessFolderActivationAction -> BusinessFolderActivationAction { activated BOOL }
 *   97  groupHistoryToggleAction       -> GroupHistoryToggleAction    { groupHistoryToggleMode ENUM }
 *
 * Uso:
 *   node scripts/add-appstate-actions.js         # aplica
 *   node scripts/add-appstate-actions.js --check # so verifica (nao escreve)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const JS = path.join(HERE, 'WAProto', 'index.js');
const DTS = path.join(HERE, 'WAProto', 'index.d.ts');

const CHECK_ONLY = process.argv.includes('--check');

/** Ancora: ultima acao que a fork JA tem (tag 89). Tudo entra depois dela. */
const ANCHOR = 'wasaRootSecretAction';
const ANCHOR_TAG = 714; // 89 << 3 | 2 (wire type 2 = length-delimited)
const ANCHOR_DECODE_CASE = 89;

const ACOES = [
  {
    campo: 'bubbleLockMessageAction',
    tipo: 'BubbleLockMessageAction',
    tag: 90,
    wire: (90 << 3) | 2,
    campos: [{ nome: 'locked', tipo: 'bool', id: 1 }],
  },
  {
    campo: 'labelSublistAction',
    tipo: 'LabelSublistAction',
    tag: 91,
    wire: (91 << 3) | 2,
    campos: [{ nome: 'subListID', tipo: 'int32', id: 1 }],
  },
  {
    campo: 'sharedDeviceAllowlistAction',
    tipo: 'SharedDeviceAllowlistAction',
    tag: 94,
    wire: (94 << 3) | 2,
    campos: [{ nome: 'allowed', tipo: 'bool', id: 1 }],
  },
  {
    campo: 'contactManagerMetadataAction',
    tipo: 'ContactManagerMetadataAction',
    tag: 95,
    wire: (95 << 3) | 2,
    campos: [{ nome: 'isHidden', tipo: 'bool', id: 1 }],
  },
  {
    campo: 'businessFolderActivationAction',
    tipo: 'BusinessFolderActivationAction',
    tag: 96,
    wire: (96 << 3) | 2,
    campos: [{ nome: 'activated', tipo: 'bool', id: 1 }],
  },
  {
    campo: 'groupHistoryToggleAction',
    tipo: 'GroupHistoryToggleAction',
    tag: 97,
    wire: (97 << 3) | 2,
    campos: [{ nome: 'groupHistoryToggleMode', tipo: 'enum', id: 1 }],
    enums: [
      ['GROUP_HISTORY_TOGGLE_MODE_UNKNOWN', 0],
      ['GROUP_HISTORY_TOGGLE_MODE_ON', 1],
      ['GROUP_HISTORY_TOGGLE_MODE_OFF', 2],
    ],
  },
];

const onlyOnce = (source, needle, label) => {
  const n = source.split(needle).length - 1;
  if (n !== 1) {
    throw new Error(`[proto] esperava 1 ocorrencia de ${label}, achei ${n}`);
  }
};

/** Bloco `SyncActionValue.<Tipo> = (function(){...})()` no formato do gerador. */
const buildMessageBlock = ({ tipo, campos, enums }) => {
  const props = campos
    .map((c) => `            ${tipo}.prototype.${c.nome} = null;`)
    .join('\n');

  const oneOfs = campos
    .map(
      (c) => `
            // Virtual OneOf for proto3 optional field
            Object.defineProperty(${tipo}.prototype, "_${c.nome}", {
                get: $util.oneOfGetter($oneOfFields = ["${c.nome}"]),
                set: $util.oneOfSetter($oneOfFields)
            });`
    )
    .join('\n');

  const create = campos
    .map(
      (c) => `                if (p.${c.nome} != null)
                    m.${c.nome} = p.${c.nome};`
    )
    .join('\n');

  const enc = campos
    .map((c) => {
      const w =
        c.tipo === 'bool'
          ? `w.uint32(${(c.id << 3) | 0}).bool(m.${c.nome})`
          : c.tipo === 'int32'
            ? `w.uint32(${(c.id << 3) | 0}).int32(m.${c.nome})`
            : `w.uint32(${(c.id << 3) | 0}).int32(m.${c.nome})`;
      return `                if (m.${c.nome} != null && Object.hasOwnProperty.call(m, "${c.nome}"))
                    ${w};`;
    })
    .join('\n');

  const dec = campos
    .map(
      (c) => `                    case ${c.id}: {
                            m.${c.nome} = r.${c.tipo === 'bool' ? 'bool' : 'int32'}();
                            break;
                        }`
    )
    .join('\n');

  const to = campos
    .map(
      (c) => `                if (m.${c.nome} != null && m.hasOwnProperty("${c.nome}")) {
                    d.${c.nome} = m.${c.nome};
                    if (o.oneofs)
                        d._${c.nome} = "${c.nome}";
                }`
    )
    .join('\n');

  const enumBlock = enums
    ? `
            ${tipo}.GroupHistoryToggleMode = (function() {
                const valuesById = {}, values = Object.create(valuesById);
${enums.map(([n, v]) => `                values[valuesById[${v}] = "${n}"] = ${v};`).join('\n')}
                return values;
            })();
`
    : '';

  const enumRef = enums ? `${tipo}.GroupHistoryToggleMode` : null;
  const encEnum = enumRef
    ? `                if (m.groupHistoryToggleMode != null && Object.hasOwnProperty.call(m, "groupHistoryToggleMode"))
                    w.uint32(8).int32(m.groupHistoryToggleMode);`
    : null;

  return `        SyncActionValue.${tipo} = (function() {

            function ${tipo}(p) {
                if (p)
                    for (var ks = Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            }
${enumBlock}
${props}

            let $oneOfFields;
${oneOfs}

            ${tipo}.create = function create(properties) {
                return new ${tipo}(properties);
            };

            ${tipo}.encode = function encode(m, w) {
                if (!w)
                    w = $Writer.create();
${encEnum || enc}
                return w;
            };

            ${tipo}.decode = function decode(r, l, e, n) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                var c = l === undefined ? r.len : r.pos + l, m = new $root.proto.SyncActionValue.${tipo}();
                while (r.pos < c) {
                    var t = r.uint32();
                    if (t === e)
                        break;
                    switch (t >>> 3) {
${dec}
                        default:
                            r.skipType(t & 7);
                            break;
                    }
                }
                return m;
            };

            ${tipo}.fromObject = function fromObject(d) {
                if (d instanceof $root.proto.SyncActionValue.${tipo})
                    return d;
                var m = new $root.proto.SyncActionValue.${tipo}();
                if (d.${campos[0].nome} != null) {
                    m.${campos[0].nome} = d.${campos[0].nome};
                }
                return m;
            };

            ${tipo}.toObject = function toObject(m, o) {
                if (!o)
                    o = {};
                var d = {};
${to}
                return d;
            };

            ${tipo}.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            ${tipo}.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/proto.SyncActionValue.${tipo}";
            };

            return ${tipo};
        })();

`;
};

const editsJs = (src) => {
  let out = src;

  for (const acao of ACOES) {
    const { campo, tipo, tag, wire } = acao;

    // 1) prototype
    const protoNeedle = `        SyncActionValue.prototype.${ANCHOR} = null;`;
    onlyOnce(out, protoNeedle, `${ANCHOR} (prototype)`);
    out = out.replace(
      protoNeedle,
      `${protoNeedle}\n        SyncActionValue.prototype.${campo} = null;`
    );

    // 2) oneOf virtual
    const oneOfNeedle = `        Object.defineProperty(SyncActionValue.prototype, "_${ANCHOR}", {
            get: $util.oneOfGetter($oneOfFields = ["${ANCHOR}"]),
            set: $util.oneOfSetter($oneOfFields)
        });`;
    onlyOnce(out, oneOfNeedle, `_${ANCHOR} (oneOf)`);
    out = out.replace(
      oneOfNeedle,
      `${oneOfNeedle}

        Object.defineProperty(SyncActionValue.prototype, "_${campo}", {
            get: $util.oneOfGetter($oneOfFields = ["${campo}"]),
            set: $util.oneOfSetter($oneOfFields)
        });`
    );

    // 3) encode
    const encNeedle = `            if (m.${ANCHOR} != null && Object.hasOwnProperty.call(m, "${ANCHOR}"))
                $root.proto.SyncActionValue.WASARootSecretAction.encode(m.${ANCHOR}, w.uint32(${ANCHOR_TAG}).fork()).ldelim();`;
    onlyOnce(out, encNeedle, `${ANCHOR} (encode)`);
    out = out.replace(
      encNeedle,
      `${encNeedle}
            if (m.${campo} != null && Object.hasOwnProperty.call(m, "${campo}"))
                $root.proto.SyncActionValue.${tipo}.encode(m.${campo}, w.uint32(${wire}).fork()).ldelim();`
    );

    // 4) decode
    const decNeedle = `                case ${ANCHOR_DECODE_CASE}: {
                        m.${ANCHOR} = $root.proto.SyncActionValue.WASARootSecretAction.decode(r, r.uint32(), undefined, n + 1);
                        break;
                    }`;
    onlyOnce(out, decNeedle, `${ANCHOR} (decode)`);
    out = out.replace(
      decNeedle,
      `${decNeedle}
                case ${tag}: {
                        m.${campo} = $root.proto.SyncActionValue.${tipo}.decode(r, r.uint32(), undefined, n + 1);
                        break;
                    }`
    );

    // 5) toObject
    const toNeedle = `            if (m.${ANCHOR} != null && m.hasOwnProperty("${ANCHOR}")) {
                d.${ANCHOR} = $root.proto.SyncActionValue.WASARootSecretAction.toObject(m.${ANCHOR}, o);
                if (o.oneofs)
                    d._${ANCHOR} = "${ANCHOR}";
            }`;
    onlyOnce(out, toNeedle, `${ANCHOR} (toObject)`);
    out = out.replace(
      toNeedle,
      `${toNeedle}
            if (m.${campo} != null && m.hasOwnProperty("${campo}")) {
                d.${campo} = $root.proto.SyncActionValue.${tipo}.toObject(m.${campo}, o);
                if (o.oneofs)
                    d._${campo} = "${campo}";
            }`
    );

    // 6) fromObject do PAI (sem isso o campo e descartado em silencio)
    const fromNeedle = `            if (d.${ANCHOR} != null) {
                if (typeof d.${ANCHOR} !== "object")
                    throw TypeError(".proto.SyncActionValue.${ANCHOR}: object expected");
                m.${ANCHOR} = $root.proto.SyncActionValue.WASARootSecretAction.fromObject(d.${ANCHOR}, n + 1);
            }`;
    onlyOnce(out, fromNeedle, `${ANCHOR} (fromObject)`);
    out = out.replace(
      fromNeedle,
      `${fromNeedle}
            if (d.${campo} != null) {
                if (typeof d.${campo} !== "object")
                    throw TypeError(".proto.SyncActionValue.${campo}: object expected");
                m.${campo} = $root.proto.SyncActionValue.${tipo}.fromObject(d.${campo}, n + 1);
            }`
    );

    // 7) declaracao do tipo
    const declNeedle = `        SyncActionValue.WASARootSecretAction = (function() {`;
    onlyOnce(out, declNeedle, 'WASARootSecretAction (declaracao)');
    out = out.replace(declNeedle, `${buildMessageBlock(acao)}${declNeedle}`);
  }

  return out;
};

const buildInterfaceDts = (acao) => {
  const iface = acao.campos
    .map((c) => {
      const t = c.tipo === 'bool' ? 'boolean' : 'number';
      return `            ${c.nome}?: (${t}|null);`;
    })
    .join('\n');

  const cls = acao.campos
    .map((c) => {
      const t = c.tipo === 'bool' ? 'boolean' : 'number';
      return `            public ${c.nome}?: (${t}|null);`;
    })
    .join('\n');

  const enumDts = acao.enums
    ? `
            enum GroupHistoryToggleMode {
${acao.enums.map(([n, v]) => `                ${n} = ${v}`).join(',\n')}
            }
`
    : '';

  return `        interface I${acao.tipo} {
${iface}
        }

        class ${acao.tipo} implements I${acao.tipo} {
            constructor(p?: proto.SyncActionValue.I${acao.tipo});
${cls}
            public static create(properties?: proto.SyncActionValue.I${acao.tipo}): proto.SyncActionValue.${acao.tipo};
            public static encode(m: proto.SyncActionValue.I${acao.tipo}, w?: $protobuf.Writer): $protobuf.Writer;
            public static decode(r: ($protobuf.Reader|Uint8Array), l?: number): proto.SyncActionValue.${acao.tipo};
            public static fromObject(d: { [k: string]: any }): proto.SyncActionValue.${acao.tipo};
            public static toObject(m: proto.SyncActionValue.${acao.tipo}, o?: $protobuf.IConversionOptions): { [k: string]: any };
            public toJSON(): { [k: string]: any };
            public static getTypeUrl(typeUrlPrefix?: string): string;
${enumDts}        }

`;
};

const editsDts = (src) => {
  let out = src;

  for (const acao of ACOES) {
    const { campo, tipo } = acao;

    // interface + class do campo no SyncActionValue
    const fieldNeedle = `        ${ANCHOR}?: (proto.SyncActionValue.IWASARootSecretAction|null);`;
    onlyOnce(out, fieldNeedle, `${ANCHOR} (d.ts interface)`);
    out = out.replace(
      fieldNeedle,
      `${fieldNeedle}\n        ${campo}?: (proto.SyncActionValue.I${tipo}|null);`
    );

    const classNeedle = `        public ${ANCHOR}?: (proto.SyncActionValue.IWASARootSecretAction|null);`;
    onlyOnce(out, classNeedle, `${ANCHOR} (d.ts class)`);
    out = out.replace(
      classNeedle,
      `${classNeedle}\n        public ${campo}?: (proto.SyncActionValue.I${tipo}|null);`
    );

    // bloco do tipo, antes do IWASARootSecretAction
    const nsNeedle = `        interface IWASARootSecretAction {`;
    onlyOnce(out, nsNeedle, 'IWASARootSecretAction (d.ts)');
    out = out.replace(nsNeedle, `${buildInterfaceDts(acao)}${nsNeedle}`);
  }

  return out;
};

const aplicar = (file, transform, marca) => {
  const before = fs.readFileSync(file, 'utf8');
  if (before.includes(marca)) {
    console.log(`[proto] ${path.basename(file)}: ja contem ${marca} (nada a fazer)`);
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
  const a = aplicar(JS, editsJs, 'bubbleLockMessageAction');
  const b = aplicar(DTS, editsDts, 'bubbleLockMessageAction');
  console.log(`[proto] ${a || b ? 'aplicado' : 'nada a aplicar'}`);
} catch (e) {
  console.error(`[proto] ERRO: ${e.message}`);
  process.exit(1);
}
