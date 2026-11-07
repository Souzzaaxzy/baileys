/**
 * Group Status — perguntas e respostas: o que dá para provar SEM WhatsApp.
 *
 * O que este teste cobre, e por quê:
 *   - a `MessageKey` é validada (mandar referência pela metade é descartado
 *     em silêncio pelo servidor — melhor falhar aqui);
 *   - a pergunta carrega `contextInfo.isQuestion = true` (campo 63) e o
 *     marcador `groupStatus` que a fork já usa;
 *   - a resposta usa `contextInfo.questionReplyQuotedMessage` (campo 68) com
 *     `quotedQuestion`/`quotedResponse` — o mecanismo NATIVO, não uma citação
 *     de texto;
 *   - TUDO sobrevive a `encode`/`decode` do proto (é o que prova que os campos
 *     existem de verdade no fio, e não só no objeto em memória);
 *   - a leitura da notificação do servidor, inclusive o tipo 4
 *     (`STATUS_GROUP_STATUS_REPLY`) e o desembrulho de encapsulamento.
 *
 * O que este teste NÃO prova (e não dá para provar aqui): que o cliente
 * oficial RENDERIZA o card, e que responder a ele gera o tipo 4. Isso exige
 * duas contas reais — ver a seção de limitações no README.
 *
 * Run: node --test tests/group-status.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { proto } from '../WAProto/index.js';
import {
    STATUS_GROUP_STATUS_REPLY,
    StatusNotificationType,
    isStatusAnswerNotification,
    normalizeStatusKey,
    buildGroupStatusQuestionContent,
    buildQuestionReplyContent,
    parseStatusNotification,
    unwrapStatusMessage,
    extractStatusAnswerNotification,
    extractQuestionAnswer
} from '../lib/Utils/group-status.js';

const GRUPO = '120363000000000001@g.us';
const AUTOR = '5511900000001@s.whatsapp.net';
const STATUS_ID = '3EB0A9C9AFB76E7451EA1D';
const RESP_ID = '3EB0B1B2C3D4E5F6071829';

const key = (id, participant) => ({
    remoteJid: GRUPO,
    fromMe: false,
    id,
    ...(participant ? { participant } : {})
});

const roundTrip = (content) => proto.Message.decode(proto.Message.encode(content).finish());

describe('group-status: enum e tipos', () => {
    it('STATUS_GROUP_STATUS_REPLY é 4 e convive com o enum do proto', () => {
        assert.equal(STATUS_GROUP_STATUS_REPLY, 4);
        // os valores originais continuam intactos
        assert.equal(StatusNotificationType.UNKNOWN, 0);
        assert.equal(StatusNotificationType.STATUS_ADD_YOURS, 1);
        assert.equal(StatusNotificationType.STATUS_RESHARE, 2);
        assert.equal(StatusNotificationType.STATUS_QUESTION_ANSWER_RESHARE, 3);
        // e o 4 foi ACRESCENTADO, não sobrescrito
        assert.equal(StatusNotificationType.STATUS_GROUP_STATUS_REPLY, 4);
    });

    it('reconhece os tipos de RESPOSTA e recusa os outros', () => {
        assert.equal(isStatusAnswerNotification(STATUS_GROUP_STATUS_REPLY), true);
        assert.equal(isStatusAnswerNotification(3), true); // STATUS_QUESTION_ANSWER_RESHARE
        assert.equal(isStatusAnswerNotification('STATUS_GROUP_STATUS_REPLY'), true);
        assert.equal(isStatusAnswerNotification(1), false); // ADD_YOURS
        assert.equal(isStatusAnswerNotification(2), false); // RESHARE
        assert.equal(isStatusAnswerNotification(0), false); // UNKNOWN
        // entrada inesperada não derruba
        assert.equal(isStatusAnswerNotification(undefined), false);
        assert.equal(isStatusAnswerNotification(null), false);
        assert.equal(isStatusAnswerNotification('NAO_EXISTE'), false);
    });

    it('normalizeStatusKey valida e limpa', () => {
        assert.deepEqual(normalizeStatusKey(key(STATUS_ID)), {
            remoteJid: GRUPO,
            fromMe: false,
            id: STATUS_ID
        });
        // participant só entra quando existe
        assert.equal(normalizeStatusKey(key(STATUS_ID, AUTOR)).participant, AUTOR);
        // e recusa referência incompleta
        assert.throws(() => normalizeStatusKey(null), /must be an object/);
        assert.throws(() => normalizeStatusKey({ id: STATUS_ID }), /remoteJid is required/);
        assert.throws(() => normalizeStatusKey({ remoteJid: GRUPO }), /id is required/);
    });
});

describe('group-status: pergunta', () => {
    it('a pergunta carrega isQuestion no contextInfo', () => {
        const c = buildGroupStatusQuestionContent('Qual música vocês querem?');
        assert.equal(c.text, 'Qual música vocês querem?');
        assert.equal(c.groupStatus, true);
        assert.equal(c.contextInfo.isQuestion, true);
    });

    it('recusa pergunta vazia', () => {
        assert.throws(() => buildGroupStatusQuestionContent(''), /text is required/);
        assert.throws(() => buildGroupStatusQuestionContent('   '), /text is required/);
        assert.throws(() => buildGroupStatusQuestionContent(), /text is required/);
    });

    it('isQuestion (campo 63) sobrevive ao encode/decode', () => {
        const c = buildGroupStatusQuestionContent('Pergunta de teste');
        const msg = proto.Message.create({
            extendedTextMessage: {
                text: c.text,
                contextInfo: c.contextInfo
            }
        });
        const dec = roundTrip(msg);
        assert.equal(dec.extendedTextMessage.text, 'Pergunta de teste');
        assert.equal(dec.extendedTextMessage.contextInfo.isQuestion, true);
    });
});

describe('group-status: resposta a uma resposta', () => {
    it('monta questionReplyQuotedMessage com pergunta e resposta', () => {
        const pergunta = { extendedTextMessage: { text: 'Qual música?' } };
        const resposta = { extendedTextMessage: { text: 'Rock!' } };
        const c = buildQuestionReplyContent({
            text: 'Boa sugestão!',
            quotedQuestion: pergunta,
            quotedResponse: resposta,
            serverQuestionId: 42
        });
        assert.equal(c.text, 'Boa sugestão!');
        assert.equal(c.groupStatus, true);
        const q = c.contextInfo.questionReplyQuotedMessage;
        assert.equal(q.serverQuestionId, 42);
        assert.equal(q.quotedQuestion.extendedTextMessage.text, 'Qual música?');
        assert.equal(q.quotedResponse.extendedTextMessage.text, 'Rock!');
    });

    it('exige texto e ao menos uma referência', () => {
        assert.throws(() => buildQuestionReplyContent({ text: '' }), /text is required/);
        assert.throws(() => buildQuestionReplyContent({ text: 'oi' }), /quotedQuestion or quotedResponse/);
        // só a resposta já basta
        const c = buildQuestionReplyContent({ text: 'ok', quotedResponse: { extendedTextMessage: { text: 'x' } } });
        assert.ok(c.contextInfo.questionReplyQuotedMessage.quotedResponse);
    });

    it('questionReplyQuotedMessage (campo 68) sobrevive ao encode/decode', () => {
        const c = buildQuestionReplyContent({
            text: 'Anotado!',
            quotedQuestion: { extendedTextMessage: { text: 'Pergunta original' } },
            quotedResponse: { extendedTextMessage: { text: 'Resposta do membro' } },
            serverQuestionId: 7
        });
        const msg = proto.Message.create({
            extendedTextMessage: { text: c.text, contextInfo: c.contextInfo }
        });
        const dec = roundTrip(msg);
        const q = dec.extendedTextMessage.contextInfo.questionReplyQuotedMessage;
        assert.ok(q, 'questionReplyQuotedMessage precisa sobreviver ao fio');
        assert.equal(q.serverQuestionId, 7);
        assert.equal(q.quotedQuestion.extendedTextMessage.text, 'Pergunta original');
        assert.equal(q.quotedResponse.extendedTextMessage.text, 'Resposta do membro');
    });

    it('o `groupStatus` encapsula em groupStatusMessageV2', () => {
        // o mesmo caminho que o groupStatus já usa na fork
        const c = buildQuestionReplyContent({
            text: 'Resposta',
            quotedResponse: { extendedTextMessage: { text: 'x' } }
        });
        const inner = proto.Message.create({
            extendedTextMessage: { text: c.text, contextInfo: c.contextInfo }
        });
        const wrapped = proto.Message.create({ groupStatusMessageV2: { message: inner } });
        const dec = roundTrip(wrapped);
        assert.ok(dec.groupStatusMessageV2, 'deve virar groupStatusMessageV2');
        assert.ok(dec.groupStatusMessageV2.message.extendedTextMessage.contextInfo.questionReplyQuotedMessage);
    });
});

describe('group-status: leitura da notificação', () => {
    it('parseStatusNotification extrai os dois lados', () => {
        const n = {
            responseMessageKey: key(RESP_ID, AUTOR),
            originalMessageKey: key(STATUS_ID),
            type: STATUS_GROUP_STATUS_REPLY
        };
        const p = parseStatusNotification(n);
        assert.equal(p.isAnswer, true);
        assert.equal(p.type, 4);
        assert.equal(p.statusId, STATUS_ID);
        assert.equal(p.responseId, RESP_ID);
        assert.equal(p.responseParticipant, AUTOR);
    });

    it('NÃO trata Add Yours / reshare como resposta', () => {
        for (const type of [1, 2, 3]) {
            const p = parseStatusNotification({
                responseMessageKey: key(RESP_ID),
                originalMessageKey: key(STATUS_ID),
                type
            });
            // 3 (question answer reshare) É resposta; 1 e 2 não
            assert.equal(p.isAnswer, type === 3, `type=${type}`);
        }
    });

    it('campo ausente vira null (nunca undefined)', () => {
        const p = parseStatusNotification({ type: STATUS_GROUP_STATUS_REPLY });
        for (const [k, v] of Object.entries(p)) {
            assert.notEqual(v, undefined, `${k} não pode ser undefined`);
        }
        assert.equal(p.statusId, null);
        assert.equal(p.responseId, null);
    });

    it('entrada inválida não lança', () => {
        assert.equal(parseStatusNotification(null).isAnswer, false);
        assert.equal(parseStatusNotification('lixo').isAnswer, false);
        assert.equal(parseStatusNotification(123).isAnswer, false);
    });

    it('o tipo 4 sobrevive ao encode/decode do proto', () => {
        const msg = proto.Message.create({
            statusNotificationMessage: {
                responseMessageKey: key(RESP_ID, AUTOR),
                originalMessageKey: key(STATUS_ID),
                type: STATUS_GROUP_STATUS_REPLY
            }
        });
        const dec = roundTrip(msg);
        const p = parseStatusNotification(dec.statusNotificationMessage);
        assert.equal(p.type, STATUS_GROUP_STATUS_REPLY);
        assert.equal(p.isAnswer, true);
        assert.equal(p.statusId, STATUS_ID);
        assert.equal(p.responseId, RESP_ID);
    });
});

describe('group-status: desembrulho e extração', () => {
    it('extractStatusAnswerNotification acha dentro de wrapper', () => {
        const notif = {
            statusNotificationMessage: {
                responseMessageKey: key(RESP_ID, AUTOR),
                originalMessageKey: key(STATUS_ID),
                type: STATUS_GROUP_STATUS_REPLY
            }
        };
        // aninhado em efêmera (o caso de grupo com mensagens temporárias)
        const aninhado = { ephemeralMessage: { message: notif } };
        const p = extractStatusAnswerNotification(aninhado);
        assert.ok(p, 'precisa achar dentro do wrapper');
        assert.equal(p.statusId, STATUS_ID);
        assert.equal(p.responseId, RESP_ID);
    });

    it('mensagem comum devolve null (guarda barata)', () => {
        assert.equal(extractStatusAnswerNotification({ conversation: 'oi' }), null);
        assert.equal(extractStatusAnswerNotification(null), null);
        assert.equal(extractStatusAnswerNotification(undefined), null);
        // notificação que NÃO é resposta também devolve null
        assert.equal(
            extractStatusAnswerNotification({
                statusNotificationMessage: {
                    responseMessageKey: key(RESP_ID),
                    originalMessageKey: key(STATUS_ID),
                    type: 1 // ADD_YOURS
                }
            }),
            null
        );
    });

    it('extractQuestionAnswer lê a resposta de quem viu o status', () => {
        const msg = { statusQuestionAnswerMessage: { key: key(STATUS_ID), text: 'Quero rock!' } };
        const a = extractQuestionAnswer(msg);
        assert.equal(a.statusId, STATUS_ID);
        assert.equal(a.text, 'Quero rock!');
        assert.equal(extractQuestionAnswer({ conversation: 'oi' }), null);
    });

    it('unwrapStatusMessage para no tipo de status', () => {
        const notif = { statusNotificationMessage: { type: 4 } };
        assert.equal(unwrapStatusMessage({ ephemeralMessage: { message: notif } }), notif);
        // e não desce infinito
        assert.equal(unwrapStatusMessage({ conversation: 'oi' }).conversation, 'oi');
    });
});

// ============================================================================
// O EVENTO `group-status.answer` — no caminho por onde TODA mensagem passa
// ============================================================================
//
// Emitir dentro do `upsertMessage` só vale se o evento sair de verdade. Aqui o
// socket é montado como nos outros testes da fork (WebSocket falso) e o
// `upsertMessage` é exercitado com uma notificação real de resposta.

describe('group-status: evento no upsert', () => {
    const montarSocket = async () => {
        const { makeMessagesRecvSocket } = await import('../lib/Socket/messages-recv.js');
        const { makeLibSignalRepository } = await import('../lib/Signal/libsignal.js');
        const { initAuthCreds, makeCacheableSignalKeyStore } = await import('../lib/Utils/auth-utils.js');
        const { Browsers } = await import('../lib/Utils/browser-utils.js');
        const pino = (await import('pino')).default;

        const creds = initAuthCreds();
        creds.me = { id: AUTOR, name: 'Lizzy', lid: AUTOR };
        const store = {};
        const keys = {
            get: async (type, ids) => {
                const out = {};
                for (const id of ids) out[id] = store[`${type}:${id}`];
                return out;
            },
            set: async (patch) => {
                for (const [type, entries] of Object.entries(patch)) {
                    for (const [id, value] of Object.entries(entries)) {
                        if (value === null) delete store[`${type}:${id}`];
                        else store[`${type}:${id}`] = value;
                    }
                }
            }
        };
        const ws = {
            isOpen: true, isClosed: false, isConnecting: false,
            send: () => true,
            on: () => {}, off: () => {}, setMaxListeners: () => {}, close: () => {},
            once: (event, cb) => { if (event === 'close') setImmediate(cb); }
        };
        const sock = makeMessagesRecvSocket({
            logger: pino({ level: 'silent' }),
            auth: { creds, keys: makeCacheableSignalKeyStore(keys, pino({ level: 'silent' })) },
            waWebSocketUrl: 'ws://127.0.0.1:9/',
            makeSignalRepository: makeLibSignalRepository,
            shouldIgnoreJid: () => false,
            getMessage: async () => undefined,
            patchMessageBeforeSending: msg => msg,
            browser: Browsers.macOS('Chrome'),
            shouldSyncHistoryMessage: () => false,
            keepAliveIntervalMs: 60_000,
            transactionOpts: { maxCommitRetries: 2, delayBetweenTriesMs: 1 },
            connectTimeoutMs: 5_000,
            options: {}
        });
        await new Promise(r => setTimeout(r, 20));
        return sock;
    };

    it('o socket expõe os três métodos', async () => {
        const sock = await montarSocket();
        try {
            assert.equal(typeof sock.sendGroupStatusQuestion, 'function');
            assert.equal(typeof sock.replyGroupStatusAnswer, 'function');
            assert.equal(typeof sock.getGroupStatusAnswer, 'function');
        } finally {
            await sock.end(undefined).catch(() => {});
        }
    });

    it('getGroupStatusAnswer lê a notificação (e devolve null no resto)', async () => {
        const sock = await montarSocket();
        try {
            const msg = proto.Message.create({
                statusNotificationMessage: {
                    responseMessageKey: key(RESP_ID, AUTOR),
                    originalMessageKey: key(STATUS_ID),
                    type: STATUS_GROUP_STATUS_REPLY
                }
            });
            const a = sock.getGroupStatusAnswer(msg);
            assert.ok(a, 'deve reconhecer a resposta');
            assert.equal(a.statusId, STATUS_ID);
            assert.equal(a.responseId, RESP_ID);
            assert.equal(a.participant, AUTOR);
            assert.equal(a.source, 'notification');
            // e uma mensagem comum devolve null
            assert.equal(sock.getGroupStatusAnswer(proto.Message.create({ conversation: 'oi' })), null);
        } finally {
            await sock.end(undefined).catch(() => {});
        }
    });

    it('o evento group-status.answer SAI no upsert (e não sai para mensagem comum)', async () => {
        const sock = await montarSocket();
        try {
            // O buffer de eventos consolida e so libera no flush; `ev.process` e' o
            // canal por onde o lote consolidado passa. Escutar aqui garante que o
            // teste mede a EMISSAO, e nao o timing do buffer.
            const lotes = [];
            sock.ev.process(async (map) => { lotes.push(map); });
            const recebidos = [];
            sock.ev.on('group-status.answer', (d) => recebidos.push(d));

            const notif = proto.Message.create({
                statusNotificationMessage: {
                    responseMessageKey: key(RESP_ID, AUTOR),
                    originalMessageKey: key(STATUS_ID),
                    type: STATUS_GROUP_STATUS_REPLY
                }
            });
            await sock.upsertMessage({
                key: key(RESP_ID, AUTOR),
                message: notif,
                pushName: 'Fulano',
                messageTimestamp: 1790108013
            }, 'notify');
            await new Promise(r => setTimeout(r, 250));

            // o evento aparece no lote consolidado
            const nomes = lotes.flatMap((m) => Object.keys(m));
            assert.ok(nomes.includes('group-status.answer'), 'o evento precisa sair no lote');
            const doLote = lotes.flatMap((m) => m['group-status.answer'] ? [m['group-status.answer']] : []);
            assert.equal(doLote.length, 1, 'exatamente um evento');
            assert.equal(doLote[0].statusId, STATUS_ID);
            assert.equal(doLote[0].responseId, RESP_ID);
            assert.equal(doLote[0].participant, AUTOR);
            assert.equal(doLote[0].pushName, 'Fulano');

            // mensagem comum NÃO emite
            const antes = lotes.flatMap((m) => Object.keys(m)).filter((n) => n === 'group-status.answer').length;
            await sock.upsertMessage({
                key: key('3EB0COMMON', AUTOR),
                message: proto.Message.create({ conversation: 'bom dia' })
            }, 'notify');
            await new Promise(r => setTimeout(r, 250));
            const depois = lotes.flatMap((m) => Object.keys(m)).filter((n) => n === 'group-status.answer').length;
            assert.equal(depois, antes, 'mensagem comum não emite o evento');
        } finally {
            await sock.end(undefined).catch(() => {});
        }
    });
});

describe('group-status: parseGroupStatusAnswer (pura)', () => {
    it('cobre os dois caminhos e recusa o resto', async () => {
        const { parseGroupStatusAnswer } = await import('../lib/Utils/group-status.js');
        // caminho 1: notificação do servidor
        const n = parseGroupStatusAnswer({
            statusNotificationMessage: {
                responseMessageKey: key(RESP_ID, AUTOR),
                originalMessageKey: key(STATUS_ID),
                type: STATUS_GROUP_STATUS_REPLY
            }
        });
        assert.equal(n.source, 'notification');
        assert.equal(n.statusId, STATUS_ID);
        // caminho 2: resposta do espectador
        const a = parseGroupStatusAnswer({
            statusQuestionAnswerMessage: { key: key(STATUS_ID), text: 'Quero rock!' }
        });
        assert.equal(a.source, 'answer');
        assert.equal(a.text, 'Quero rock!');
        assert.equal(a.statusId, STATUS_ID);
        // e o resto
        assert.equal(parseGroupStatusAnswer({ conversation: 'oi' }), null);
        assert.equal(parseGroupStatusAnswer(null), null);
    });
});
