import { isLidUser, isPnUser } from '../WABinary/index.js';

/**
 * Mapeia um nó `<participant>` do metadata de grupo/comunidade para o objeto
 * que o resto da lib (e quem a consome) espera.
 *
 * ## O defeito que isto corrige
 *
 * A lib mapeava `id`, `phoneNumber`, `lid`, `username` e `admin` — e **descartava
 * o `notify`**, que é o **nome que o WhatsApp mostra** (o pushName do contato).
 * O campo vem no fio em todo `<participant notify="...">` e era jogado fora,
 * então quem consumia o metadata só tinha JID/LID e número: qualquer coisa que
 * nomeasse alguém caía no número.
 *
 * Era por isso que uma lista de admins montada a partir do metadata não tinha
 * nome nenhum — e por que o nome só aparecia quando o contato estava salvo na
 * agenda do bot.
 *
 * Fonte ÚNICA: os três pontos de parse (grupos, comunidades e o update de
 * participantes) usam esta função. Antes eram três cópias do mesmo objeto, e
 * bastava uma delas esquecer um campo para o comportamento divergir.
 *
 * Puro de propósito: dá para testar o mapeamento sem abrir socket.
 *
 * @param {object} attrs atributos do nó `<participant>`
 * @returns {{id: string, phoneNumber?: string, lid?: string, username?: string, notify?: string, name?: string, admin: string|null}}
 */
export function mapParticipantAttrs(attrs) {
    // O parse sempre passa um objeto, mas a função é exportada: `null` cai no
    // default também (o default de parâmetro só cobre `undefined`).
    const a = attrs || {};
    return {
        id: a.jid,
        // O `phoneNumber` só faz sentido quando o `jid` é um LID (aí o número é
        // a identidade alternativa). A regra é a mesma de antes.
        phoneNumber: isLidUser(a.jid) && isPnUser(a.phone_number) ? a.phone_number : undefined,
        lid: isPnUser(a.jid) && isLidUser(a.lid) ? a.lid : undefined,
        username: a.participant_username || a.username || undefined,
        // O NOME DO CONTATO: `notify` é o que o WhatsApp exibe; `name` aparece
        // quando o contato está salvo na agenda do usuário.
        notify: a.notify || undefined,
        name: a.name || undefined,
        admin: a.type || null
    };
}
