/**
 * Join request (pedido de entrada em grupo com aprovação) — parsing do stub.
 *
 * O evento `group.join-request` carrega o pedido de entrada E quem o resolveu.
 * O stub do WhatsApp traz três coisas que se confundem facilmente:
 *
 *   - **afetado** (`<participant jid phone_number>`): quem pediu para entrar;
 *   - **ator** (`participant` / `participant_pn` da stanza): quem AGIU — quem
 *     aprovou ou recusou. Quando o próprio usuário cancela, ator e afetado são
 *     a mesma pessoa (é assim que a fork distingue `revoked` de `rejected`);
 *   - **action**: `created` (novo pedido) | `revoked` (o usuário cancelou o
 *     próprio pedido) | `rejected` (um admin recusou).
 *
 * A `action` só era derivada para `revoked_membership_requests`. Nos outros
 * caminhos do stub o valor ficava `undefined`, então um consumidor não tinha
 * como distinguir "pedido novo" de "pedido resolvido" — e tratava os dois
 * como se fossem o mesmo. Este módulo deriva a action SEMPRE, a partir dos
 * dados que a stanza já traz, sem inventar nada.
 */

/** Actions canônicas de um pedido de entrada (as mesmas do upstream). */
export const JOIN_REQUEST_ACTIONS = ['created', 'revoked', 'rejected']

/**
 * O stub não trouxe a `action`? Deriva dos participantes.
 *
 * `revoked` é o cancelamento pelo próprio solicitante (ator === afetado). Um
 * ator diferente do afetado é um admin resolvendo o pedido — tratado como
 * `rejected`, que é o que um consumidor precisa saber para não reenviar o
 * card de solicitação.
 *
 * @param {string|undefined} action  valor cru vindo da stanza
 * @param {{lid?: string, pn?: string}} affected  quem pediu para entrar
 * @param {string|undefined} actingLid  quem agiu (LID)
 * @param {string|undefined} actingPn   quem agiu (PN)
 * @returns {'created'|'revoked'|'rejected'}
 */
export function deriveJoinRequestAction(action, affected, actingLid, actingPn) {
    if (action === 'created' || action === 'revoked' || action === 'rejected') {
        return action
    }

    const affectedLid = affected?.lid
    const affectedPn = affected?.pn
    if (!affectedLid && !affectedPn) {
        // Sem saber quem foi afetado, não há como dizer que alguém cancelou.
        return 'created'
    }

    const sameLid = Boolean(actingLid && affectedLid && areSameUser(actingLid, affectedLid))
    const samePn = Boolean(actingPn && affectedPn && areSameUser(actingPn, affectedPn))
    return sameLid || samePn ? 'revoked' : 'rejected'
}

/**
 * Compara duas identidades ignorando o device (`:N`), mas MANTENDO o servidor.
 *
 * Comparar só os dígitos juntaria `222@lid` com `222@s.whatsapp.net` — que são
 * pessoas/namespaces diferentes. Aqui só se compara LID com LID e PN com PN.
 */
function areSameUser(a, b) {
    const norm = (jid) => {
        const [user, server] = String(jid || '').split('@')
        if (!user || !server) return ''
        return `${user.split(':')[0]}@${server}`
    }
    const x = norm(a)
    return Boolean(x) && x === norm(b)
}
