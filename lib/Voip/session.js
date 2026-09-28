/**
 * Socket-side VoIP facade.
 *
 * Gives a Baileys socket the media half of calling without changing how the
 * socket is built: `makeVoipSession(sock)` returns a lazily-created session that
 * owns the `GroupCallMedia` instance (and therefore the WASM engine, the relay
 * transport and the worker pool).
 *
 * ## Why a facade and not methods on the socket itself
 *
 * The media stack is heavy — it spawns pthread workers and allocates hundreds of
 * MB. A bot that never places a call should pay none of it. Keeping it behind a
 * lazy factory means the cost is only incurred on the first real call, and the
 * socket's own surface stays exactly as it was.
 *
 * ## Usage
 *
 * ```js
 * import { makeVoipSession } from '@souzzaaxzy/baileys/lib/Voip/session.js'
 *
 * const voip = makeVoipSession(sock, { log: console.log })
 *
 * // start a group call's media (after the signaling offer exists)
 * await voip.entrarNaCall({ grupo, participantes, callId })
 *
 * // play a file into the call
 * await voip.tocarAudio(grupo, './song.mp3')
 *
 * // tear it down
 * await voip.sairDaCall(grupo)
 * ```
 *
 * @module Voip/session
 */
import { GroupCallMedia } from './group-media.js';
import { checkVoipMemory, VOIP_MIN_FREE_MB } from './index.js';

/**
 * Create a lazy VoIP session bound to one Baileys socket.
 *
 * @param sock Baileys socket (the media stack rides its existing session).
 * @param options.log optional logger, `(msg: string) => void`.
 */
export const makeVoipSession = (sock, options = {}) => {
    if (!sock) throw new Error('makeVoipSession: a Baileys socket is required');

    let media = null;
    const log = options.log ?? (() => { });
    const minFreeMb = options.minFreeMb ?? VOIP_MIN_FREE_MB;

    const ensure = () => {
        if (!media) media = new GroupCallMedia({ log });
        return media;
    };

    return {
        /** Whether the media stack has been brought up yet. */
        get started() { return media !== null; },

        /**
         * Memory pre-flight, so a call that would be OOM-killed is refused with a
         * reason instead of killing the process silently.
         */
        checkMemory: (mb = minFreeMb) => checkVoipMemory(mb),

        /** Attach to a group call as a media participant. */
        entrarNaCall: async (opts) => {
            const { minFreeMb: perCallMin, ...mediaOpts } = opts ?? {};
            const min = perCallMin ?? minFreeMb;
            const mem = checkVoipMemory(min);
            if (!mem.ok) {
                return {
                    ok: false,
                    motivo: 'memoria_baixa',
                    detalhe: `${mem.livreMb} MB livres; a pilha de mídia precisa de ~${min} MB`,
                };
            }
            const r = await ensure().entrarNaCall({ ...mediaOpts, sock });
            if (!r?.ok) log(`[VOIP] entrarNaCall falhou: ${r?.motivo ?? 'desconhecido'}`);
            return r;
        },

        /** Stage of the media stack for a group. */
        estagio: (grupo) => (media ? media.estagio(grupo) : 'parado'),

        /** Is there a live media session for this group? */
        temSessao: (grupo) => (media ? media.temSessao(grupo) : false),

        /** Play a local audio file into the group's call. */
        tocarAudio: async (grupo, arquivo) => {
            if (!media) return { ok: false, motivo: 'sem_sessao' };
            return media.tocarAudio(grupo, arquivo);
        },

        /** Stop the audio (the call keeps going). */
        pararAudio: (grupo) => (media ? media.pararAudio(grupo) : { ok: false, motivo: 'sem_sessao' }),

        /** Leave the call and tear the media stack down for this group. */
        sairDaCall: async (grupo) => {
            if (!media) return { ok: false, motivo: 'sem_sessao' };
            return media.sairDaCall(grupo);
        },

        /** Tear down every session (call on socket close). */
        destroy: async () => {
            if (!media) return;
            const grupos = typeof media.grupos === 'function' ? media.grupos() : [];
            for (const g of grupos) {
                try { await media.sairDaCall(g); } catch { /* best effort */ }
            }
            media = null;
        },
    };
};
