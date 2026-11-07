/**
 * Group Status — perguntas e respostas (protocolo).
 *
 * Reúne, num lugar só, a construção e a leitura dos tipos de proto que o
 * Group Status usa para perguntas e respostas. Tudo aqui é PURO: monta/desmonta
 * objetos de proto e não toca em socket, disco ou credenciais — por isso é
 * testável por `encode`/`decode` sem abrir conexão.
 *
 * ## Os tipos, medidos no proto (não presumidos)
 *
 * | tipo | campo em `Message` | papel |
 * |---|---|---|
 * | `groupStatusMessageV2` | 103 (`FutureProofMessage`) | envelope do status de grupo |
 * | `statusNotificationMessage` | 98 | **gerada pelo SERVIDOR**, entregue ao AUTOR |
 * | `statusQuestionAnswerMessage` | 105 | resposta de quem VIU o status |
 * | `questionReplyMessage` | 106 (`FutureProofMessage`) | resposta a uma resposta |
 * | `questionResponseMessage` | 107 | resposta dentro de enquete/pergunta |
 * | `statusQuotedMessage` | 109 | citação com prévia do status |
 * | `statusStickerInteractionMessage` | 110 | reação por figurinha |
 *
 * E, em `ContextInfo`: `isQuestion` (63, bool) e `questionReplyQuotedMessage`
 * (68). O `QuestionReplyQuotedMessage` tem `serverQuestionId` (1),
 * `quotedQuestion` (2) e `quotedResponse` (3).
 *
 * ## A distinção que importa (e que muda o desenho)
 *
 * `StatusQuestionAnswerMessage` é a resposta de quem viu o status para o
 * AUTOR. Já o `StatusNotificationMessage` é **emitido pelo servidor**: o autor
 * o recebe quando alguém interage com o status dele, e é ele que carrega
 * `responseMessageKey` + `originalMessageKey` + `type`. Ou seja: para o BOT
 * (que é o autor da pergunta) **quem chega é a notificação**, não a resposta.
 *
 * ## `STATUS_GROUP_STATUS_REPLY`
 *
 * O enum do proto local (`StatusNotificationMessage.StatusNotificationType`)
 * declara só `UNKNOWN=0`, `STATUS_ADD_YOURS=1`, `STATUS_RESHARE=2`,
 * `STATUS_QUESTION_ANSWER_RESHARE=3`. O valor **4** — o reply a um status de
 * GRUPO — não está no enum gerado, mas é usado por clientes reais (consta no
 * fork `rexxzyid/elaina-baileys` como `STATUS_GROUP_STATUS_REPLY: 4`).
 * Proto3 trata valor de enum desconhecido como o próprio número, então
 * `type === 4` chega intacto. Aqui ele é exposto como constante **sem**
 * alterar o WAProto gerado.
 */

import { proto } from '../../WAProto/index.js';

/** Valor de `StatusNotificationType` para reply em Group Status (não está no enum gerado). */
export const STATUS_GROUP_STATUS_REPLY = 4;

/**
 * O enum local, com a extensão de Group Status acrescentada.
 *
 * Mantém os valores originais do proto e só ADICIONA o 4 — nada é
 * sobrescrito, então quem já usava os outros valores continua igual.
 */
export const StatusNotificationType = Object.freeze({
    ...proto.Message.StatusNotificationMessage.StatusNotificationType,
    STATUS_GROUP_STATUS_REPLY
});

/** Tipos de interação que representam uma resposta a uma pergunta de status. */
const TIPOS_DE_RESPOSTA = new Set([
    StatusNotificationType.STATUS_QUESTION_ANSWER_RESHARE,
    STATUS_GROUP_STATUS_REPLY
]);

/**
 * Diz se um `type` de `StatusNotificationType` representa uma resposta.
 *
 * Aceita número (o que chega no fio) ou o nome do enum. Valores desconhecidos
 * devolvem `false` em vez de lançar — uma notificação de tipo novo não pode
 * derrubar o handler.
 *
 * @param {number|string|undefined|null} type
 * @returns {boolean}
 */
export const isStatusAnswerNotification = (type) => {
    if (type == null) return false;
    if (typeof type === 'string') return TIPOS_DE_RESPOSTA.has(StatusNotificationType[type]);
    return TIPOS_DE_RESPOSTA.has(type);
};

/**
 * Valida uma `MessageKey` mínima e devolve uma cópia limpa.
 *
 * O `remoteJid` e o `id` são o que identifica a mensagem; `fromMe` e
 * `participant` são opcionais. Rejeitar cedo evita mandar ao servidor uma
 * referência que ele descartaria em silêncio.
 *
 * @param {object} key
 * @param {string} rotulo nome do campo, só para a mensagem de erro
 * @returns {{remoteJid: string, fromMe: boolean, id: string, participant?: string}}
 */
export const normalizeStatusKey = (key, rotulo = 'key') => {
    if (!key || typeof key !== 'object') {
        throw new TypeError(`${rotulo} must be an object`);
    }
    if (typeof key.remoteJid !== 'string' || !key.remoteJid) {
        throw new TypeError(`${rotulo}.remoteJid is required`);
    }
    if (typeof key.id !== 'string' || !key.id) {
        throw new TypeError(`${rotulo}.id is required`);
    }
    const out = { remoteJid: key.remoteJid, fromMe: !!key.fromMe, id: key.id };
    if (key.participant) out.participant = key.participant;
    return out;
};

/**
 * Monta o conteúdo de uma PERGUNTA de Group Status.
 *
 * O que faz a pergunta ser pergunta (e não texto com interrogação) é o
 * `contextInfo.isQuestion = true` — medido no `ContextInfo` (campo 63) e
 * documentado na referência do cliente oficial como *"whether this message is
 * a question that expects a reply"*. O `groupStatus: true` é o mesmo marcador
 * que o Group Status já usa na fork (põe `isGroupStatus` e encapsula em
 * `groupStatusMessageV2`).
 *
 * Devolve o objeto pronto para `sendMessage`, sem chamar nada.
 *
 * @param {string} text pergunta
 * @returns {object} conteúdo de mensagem
 */
export const buildGroupStatusQuestionContent = (text) => {
    if (typeof text !== 'string' || !text.trim()) {
        throw new TypeError('buildGroupStatusQuestionContent: text is required');
    }
    return {
        text,
        groupStatus: true,
        contextInfo: {
            isQuestion: true
        }
    };
};

/**
 * Monta o conteúdo de uma RESPOSTA a uma resposta recebida.
 *
 * Usa o mecanismo NATIVO: `contextInfo.questionReplyQuotedMessage`, com
 * `serverQuestionId`, `quotedQuestion` e `quotedResponse` — é o que o cliente
 * lê para renderizar a resposta ancorada na pergunta original. **Não** é uma
 * mensagem comum citando texto.
 *
 * @param {object} params
 * @param {string} params.text            resposta do administrador
 * @param {object} [params.quotedQuestion] `Message` da pergunta original
 * @param {object} [params.quotedResponse] `Message` da resposta sendo respondida
 * @param {number} [params.serverQuestionId]
 * @param {boolean} [params.groupStatus]  marca como status de grupo (padrão `true`)
 * @returns {object} conteúdo de mensagem
 */
export const buildQuestionReplyContent = ({
    text,
    quotedQuestion,
    quotedResponse,
    serverQuestionId,
    groupStatus = true
} = {}) => {
    if (typeof text !== 'string' || !text.trim()) {
        throw new TypeError('buildQuestionReplyContent: text is required');
    }
    if (!quotedQuestion && !quotedResponse) {
        throw new TypeError(
            'buildQuestionReplyContent: quotedQuestion or quotedResponse is required'
        );
    }
    const questionReplyQuotedMessage = {};
    if (serverQuestionId != null) questionReplyQuotedMessage.serverQuestionId = serverQuestionId;
    if (quotedQuestion) questionReplyQuotedMessage.quotedQuestion = quotedQuestion;
    if (quotedResponse) questionReplyQuotedMessage.quotedResponse = quotedResponse;

    const content = {
        text,
        contextInfo: { questionReplyQuotedMessage }
    };
    if (groupStatus) content.groupStatus = true;
    return content;
};

/**
 * Lê uma `StatusNotificationMessage` recebida e devolve os dados da resposta.
 *
 * Não inventa nada: campo ausente vira `null` (nunca `undefined`, para o
 * consumidor não precisar checar os dois). `isAnswer` diz se o `type` é de
 * resposta — um `Add Yours` ou um reshare também chegam por aqui e não devem
 * ser tratados como resposta.
 *
 * @param {object} notification `Message.StatusNotificationMessage`
 * @returns {{isAnswer: boolean, type: number|null, statusId: string|null,
 *            statusRemoteJid: string|null, statusParticipant: string|null,
 *            responseId: string|null, responseRemoteJid: string|null,
 *            responseParticipant: string|null}}
 */
export const parseStatusNotification = (notification) => {
    const vazio = {
        isAnswer: false,
        type: null,
        statusId: null,
        statusRemoteJid: null,
        statusParticipant: null,
        responseId: null,
        responseRemoteJid: null,
        responseParticipant: null
    };
    if (!notification || typeof notification !== 'object') return vazio;

    const original = notification.originalMessageKey || null;
    const response = notification.responseMessageKey || null;
    const type = notification.type ?? null;

    return {
        isAnswer: isStatusAnswerNotification(type),
        type,
        statusId: original?.id ?? null,
        statusRemoteJid: original?.remoteJid ?? null,
        statusParticipant: original?.participant ?? null,
        responseId: response?.id ?? null,
        responseRemoteJid: response?.remoteJid ?? null,
        responseParticipant: response?.participant ?? null
    };
};

/**
 * Desembrulha wrappers até achar o `Message` "de verdade".
 *
 * O que chega pelo fio costuma vir encapsulado (`ephemeralMessage`,
 * `viewOnceMessage`, `viewOnceMessageV2`, `documentWithCaptionMessage`, …).
 * Sem descer isso, um `statusNotificationMessage` aninhado passa batido.
 *
 * @param {object} message `Message` cru
 * @param {number} [maxDepth]
 * @returns {object|null} o `Message` folha, ou `null`
 */
export const unwrapStatusMessage = (message, maxDepth = 5) => {
    let atual = message;
    for (let i = 0; i < maxDepth && atual && typeof atual === 'object'; i++) {
        if (atual.statusNotificationMessage || atual.statusQuestionAnswerMessage) return atual;
        const wrapper =
            atual.ephemeralMessage?.message ||
            atual.viewOnceMessage?.message ||
            atual.viewOnceMessageV2?.message ||
            atual.viewOnceMessageV2Extension?.message ||
            atual.documentWithCaptionMessage?.message;
        if (!wrapper) return atual;
        atual = wrapper;
    }
    return atual || null;
};

/**
 * Extrai, de um `Message` cru, a notificação de resposta de status — se houver.
 *
 * Devolve `null` quando a mensagem não é uma notificação (o caso comum), então
 * serve de guarda barata antes de qualquer trabalho.
 *
 * @param {object} message `Message` cru (pode vir encapsulado)
 * @returns {ReturnType<typeof parseStatusNotification>|null}
 */
export const extractStatusAnswerNotification = (message) => {
    const folha = unwrapStatusMessage(message);
    if (!folha?.statusNotificationMessage) return null;
    const parsed = parseStatusNotification(folha.statusNotificationMessage);
    return parsed.isAnswer ? parsed : null;
};

/**
 * Lê uma resposta de Group Status de um `Message` cru, nos DOIS caminhos.
 *
 * Tenta primeiro a notificação que o SERVIDOR entrega ao autor
 * (`statusNotificationMessage`) — o caso do bot, que é quem publica — e depois
 * a resposta que o espectador envia (`statusQuestionAnswerMessage`).
 *
 * É a versão PURA do que o socket expõe como `getGroupStatusAnswer`, para
 * poder ser usada em camadas que não enxergam o socket (o `chats.js`, por
 * onde toda mensagem passa).
 *
 * @param {object} message `Message` cru
 * @returns {{source: 'notification'|'answer', statusId: string|null,
 *            statusRemoteJid: string|null, responseId: string|null,
 *            participant: string|null, text: string|null,
 *            type: number|null}|null}
 */
export const parseGroupStatusAnswer = (message) => {
    const notif = extractStatusAnswerNotification(message);
    if (notif) {
        return {
            source: 'notification',
            statusId: notif.statusId,
            statusRemoteJid: notif.statusRemoteJid,
            responseId: notif.responseId,
            participant: notif.responseParticipant,
            text: null,
            type: notif.type
        };
    }
    const answer = extractQuestionAnswer(message);
    if (answer) {
        return {
            source: 'answer',
            statusId: answer.statusId,
            statusRemoteJid: null,
            responseId: null,
            participant: null,
            text: answer.text,
            type: null
        };
    }
    return null;
};

/**
 * Extrai uma resposta de quem VIU o status (`StatusQuestionAnswerMessage`).
 *
 * Complementa `extractStatusAnswerNotification`: aquele lê a notificação que o
 * SERVIDOR manda ao autor; este lê a resposta que o espectador envia. Os dois
 * podem chegar em cenários diferentes, então o bot tenta os dois.
 *
 * @param {object} message `Message` cru
 * @returns {{statusId: string|null, text: string|null}|null}
 */
export const extractQuestionAnswer = (message) => {
    const folha = unwrapStatusMessage(message);
    const answer = folha?.statusQuestionAnswerMessage;
    if (!answer) return null;
    return {
        statusId: answer.key?.id ?? null,
        text: answer.text ?? null
    };
};
