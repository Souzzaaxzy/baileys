/**
 * Cache de CONTATOS + resolução de NOME.
 *
 * Por que existe: a Baileys emite `contacts.upsert` / `contacts.update`, mas não
 * guarda nada e não oferece nenhuma forma de perguntar "qual é o nome deste
 * contato?". Sem isto, o único nome disponível era o `pushName` da mensagem —
 * e comandos que nomeiam pessoas (rankings, `!cf`, etc.) acabavam mostrando o
 * número ou o LID cru.
 *
 * `getName` resolve na ordem:
 *   1. nome salvo na agenda (`name`) — o mais confiável;
 *   2. `notify` (pushName observado);
 *   3. `verifiedName` (nome verificado de conta business);
 *   4. `username` (`@handle`);
 *   5. `undefined` (o chamador decide o fallback).
 *
 * A chave é sempre o JID BARE. Em multi-device a mesma pessoa pode aparecer como
 * `x@lid` e `x@s.whatsapp.net`; quando o registro traz o par (`lid` +
 * `phoneNumber`) o cache guarda os DOIS apelidos, apontando para o mesmo nome.
 */

const GENERICO = /^(usu[aá]rio|user|unknown|desconhecido|sem nome)$/i;
const JID_RE = /^\d+@(s\.whatsapp\.net|lid)$/;

/** JID "bare": sem device (`:14`) e sem `@...`. */
const jidUser = (jid) => String(jid || '').split('@')[0].split(':')[0];

/** Normaliza para `<user>@<server>` quando reconhecível; senão devolve como veio. */
function normalizeJid(jid) {
    if (!jid) {
        return '';
    }
    const str = String(jid);
    const server = str.includes('@lid') ? '@lid' : str.includes('@s.whatsapp.net') ? '@s.whatsapp.net' : null;
    if (!server) {
        return str.split(':')[0];
    }
    return `${jidUser(str)}${server}`;
}

/** `true` quando o valor é genérico, um JID cru ou um número — não serve de nome. */
function nomeUtil(valor) {
    const texto = String(valor ?? '').trim();
    if (!texto) {
        return false;
    }
    if (GENERICO.test(texto)) {
        return false;
    }
    if (/^\+?\d+$/.test(texto)) {
        return false;
    }
    if (JID_RE.test(texto)) {
        return false;
    }
    return true;
}

/** Melhor nome disponível num registro de contato. */
function melhorNome(contact) {
    if (!contact) {
        return undefined;
    }
    for (const cand of [contact.name, contact.notify, contact.verifiedName, contact.username]) {
        if (nomeUtil(cand)) {
            return String(cand).trim();
        }
    }
    return undefined;
}

/**
 * Cria o cache de contatos.
 *
 * @param {object} [opts]
 * @param {object} [opts.ev]      event emitter da Baileys (auto-assina
 *                                `contacts.upsert`/`contacts.update`).
 * @param {number} [opts.max]     teto de registros (default 5000).
 * @param {number} [opts.ttlMs]   TTL de um registro sem atualização
 *                                (default 7 dias). `0` desliga a expiração.
 * @param {() => number} [opts.now] relógio injetável (testes).
 */
export function makeContactStore(opts = {}) {
    const { ev, max = 5000, ttlMs = 7 * 24 * 60 * 60 * 1000, now = () => Date.now() } = opts;
    /** `jidApelido -> jidCanônico` */
    const alias = new Map();
    /** `jidCanônico -> { contact, at }` */
    const store = new Map();

    const evictIfNeeded = () => {
        while (store.size > max) {
            // Map preserva ordem de inserção: derruba os mais antigos.
            const first = store.keys().next().value;
            const dados = store.get(first);
            store.delete(first);
            if (dados?.contact) {
                for (const j of [dados.contact.id, dados.contact.lid, dados.contact.phoneNumber]) {
                    alias.delete(normalizeJid(j));
                }
            }
        }
    };

    const expirar = (jid) => {
        if (!ttlMs) {
            return;
        }
        const dados = store.get(jid);
        if (dados && now() - dados.at > ttlMs) {
            store.delete(jid);
        }
    };

    const upsert = (contact) => {
        if (!contact) {
            return;
        }
        const id = normalizeJid(contact.id || contact.lid || contact.phoneNumber);
        if (!id) {
            return;
        }
        const anterior = store.get(id)?.contact || {};
        // Só sobrescreve com o que veio preenchido (senão um `update` parcial,
        // como o de trocar a foto, apagaria o nome já conhecido).
        const merged = { ...anterior, ...Object.fromEntries(Object.entries(contact).filter(([, v]) => v !== undefined && v !== null)) };
        merged.id = id;
        store.set(id, { contact: merged, at: now() });
        for (const j of [merged.id, merged.lid, merged.phoneNumber]) {
            const norm = normalizeJid(j);
            if (norm) {
                alias.set(norm, id);
            }
        }
        // Apelidos já vistas apontando para este id continuam válidos.
        for (const [k, v] of alias.entries()) {
            if (v === id) {
                alias.set(k, id);
            }
        }
        evictIfNeeded();
    };

    const resolve = (jid) => {
        if (!jid) {
            return undefined;
        }
        const norm = normalizeJid(jid);
        let canon = alias.get(norm);
        if (!canon) {
            // Número cru (sem @) e variações: casa pelo usuário, preferindo PN.
            const user = jidUser(jid);
            canon = alias.get(`${user}@s.whatsapp.net`) || alias.get(`${user}@lid`);
            if (!canon) {
                for (const [k, v] of alias.entries()) {
                    if (jidUser(k) === user) {
                        canon = v;
                        break;
                    }
                }
            }
        }
        if (!canon) {
            canon = norm;
        }
        expirar(canon);
        return store.get(canon)?.contact;
    };

    /**
     * Nome do contato.
     * @returns {string|undefined} `undefined` quando não há nome confiável.
     */
    const getName = (jid) => melhorNome(resolve(jid));

    /** Registro completo (name/notify/verifiedName/username/lid/phoneNumber). */
    const getContact = (jid) => resolve(jid);

    /** Todos os contatos conhecidos (cópia). */
    const getAll = () => [...store.values()].map(v => v.contact);

    /** Remove um contato (e seus apelidos). */
    const remove = (jid) => {
        const canon = alias.get(normalizeJid(jid)) || normalizeJid(jid);
        const dados = store.get(canon);
        if (dados?.contact) {
            for (const j of [dados.contact.id, dados.contact.lid, dados.contact.phoneNumber]) {
                alias.delete(normalizeJid(j));
            }
        }
        return store.delete(canon);
    };

    /** Limpa tudo. */
    const clear = () => {
        store.clear();
        alias.clear();
    };

    if (ev && typeof ev.on === 'function') {
        ev.on('contacts.upsert', (contacts) => contacts?.forEach(upsert));
        ev.on('contacts.update', (updates) => updates?.forEach(upsert));
    }

    return { upsert, getName, getContact, getAll, remove, clear, _size: () => store.size, _resolve: resolve };
}
