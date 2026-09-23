/**
 * StanzaObserver — passive, additive observation of the low-level stream.
 *
 * DESIGN CONSTRAINTS (all of them matter)
 * ---------------------------------------
 *  1. PURELY OBSERVATIONAL. It never mutates the node, never acks, never
 *     blocks, never sends. It attaches `listener` functions to `sock.ws`, the
 *     same emitter the fork's own handlers use, and it returns an `unobserve()`
 *     that removes exactly the listeners it added.
 *  2. ADDITIVE. `EventEmitter` allows many listeners per event; the fork's
 *     handlers are registered first and are unaffected. We do not touch
 *     `removeAllListeners` and we do not re-emit anything.
 *  3. FAIL-SAFE. Each listener body is wrapped: an exception inside the observer
 *     must never propagate into the socket's dispatch loop, because that loop
 *     awaits the emit result and a throw would abort message processing.
 *  4. NON-BLOCKING. The listener copies a handful of attributes and returns; all
 *     analysis happens later, driven by the caller.
 *
 * The observed events are the ones the fork itself subscribes to:
 *   CB:message, CB:receipt, CB:notification, CB:presence, CB:chatstate.
 * Their attribute names come from the fork's own code (`messages-recv.js`), not
 * from guesswork.
 */

/** Attributes worth copying from a received <message> stanza. */
const MESSAGE_ATTRS = ['id', 'from', 'participant', 't', 'addressing_mode', 'category', 'offline', 'type'];

/** Attributes worth copying from a <receipt> stanza. */
const RECEIPT_ATTRS = ['id', 'from', 'participant', 'type', 't', 'recipient'];

/** Attributes worth copying from a <notification>/<presence>/<chatstate>. */
const GENERIC_ATTRS = ['id', 'from', 'participant', 'type', 't', 'category'];

const pick = (attrs = {}, names = []) => {
    const out = {};
    for (const name of names) {
        if (attrs[name] !== undefined) out[name] = attrs[name];
    }
    return out;
};

/** Copies only the listed attributes; never keeps the node itself. */
const factsOf = (node, names) => {
    if (!node || typeof node !== 'object') return null;
    return {
        tag: node.tag || null,
        attrs: pick(node.attrs, names),
        childTags: Array.isArray(node.content)
            ? node.content.map((c) => c?.tag).filter(Boolean).slice(0, 8)
            : []
    };
};

/**
 * Attaches the observer to a socket.
 *
 * @param {object} sock        the socket returned by makeWASocket
 * @param {object} handlers    callbacks: { onMessageStanza(facts), onReceipt(facts),
 *                             onNotification(facts), onPresence(facts), onError(err) }
 * @param {object} [opts]
 * @param {object} [opts.logger] a pino-like logger; optional
 * @returns {{unobserve: Function, attached: boolean, reason?: string}}
 */
export const observeStanzas = (sock, handlers = {}, opts = {}) => {
    const logger = opts.logger;
    const ws = sock?.ws;
    if (!ws || typeof ws.on !== 'function') {
        return { unobserve: () => {}, attached: false, reason: 'no_ws_emitter' };
    }

    const listeners = [];

    /** Registers one listener, wrapped so it can never throw into the socket. */
    const attach = (event, build) => {
        const listener = (node) => {
            try {
                const facts = build(node);
                if (facts) handlers[build.handlerName]?.(facts);
            } catch (err) {
                // Never let observation break the connection.
                if (logger?.debug) logger.debug({ err, event }, 'antibot stanza observer error');
                handlers.onError?.(err);
            }
        };
        ws.on(event, listener);
        listeners.push([event, listener]);
    };

    const makeBuild = (names, handlerName) => {
        const fn = (node) => factsOf(node, names);
        fn.handlerName = handlerName;
        return fn;
    };

    attach('CB:message', makeBuild(MESSAGE_ATTRS, 'onMessageStanza'));
    attach('CB:receipt', makeBuild(RECEIPT_ATTRS, 'onReceipt'));
    attach('CB:notification', makeBuild(GENERIC_ATTRS, 'onNotification'));
    attach('CB:presence', makeBuild(GENERIC_ATTRS, 'onPresence'));
    attach('CB:chatstate', makeBuild(GENERIC_ATTRS, 'onPresence'));

    return {
        attached: true,
        /** Removes exactly the listeners this call added. */
        unobserve() {
            for (const [event, listener] of listeners) {
                ws.off?.(event, listener);
            }
            listeners.length = 0;
        },
        /** Diagnostics for the bot UI. */
        stats() {
            return { attached: listeners.length > 0, events: listeners.map(([e]) => e) };
        }
    };
};
