/**
 * EXPERIMENTAL — Chat theme / wallpaper (research only).
 *
 * WHAT THIS IS (evidence, not the name)
 * -------------------------------------
 *
 * The theme travels as a `ProtocolMessage`:
 *
 *   ProtocolMessage.type = CHAT_THEME_SETTING (34)
 *   ProtocolMessage.chatThemeSetting            (field 30)
 *
 * and `ChatThemeSetting` carries:
 *
 *   1  settingTimestampMs  INT64
 *   2  clearTheme          BOOL
 *   3  colorSchemeId       STRING
 *   10 defaultWallpaper    MESSAGE  }
 *   11 solidColor          MESSAGE  }  oneof `wallpaper`
 *   12 stockImage          MESSAGE  }
 *   13 customImage         MESSAGE  }
 *   14 animatedWallpaper   MESSAGE  }
 *
 * It is **NOT** a common message: sending `{ chatTheme: ... }` at the top level
 * would not be the wire format. It is also **not** an App State action — there
 * is no `chatTheme*` in `SyncActionValue`.
 *
 * Direction is NOT established. Public reporting describes chat themes as
 * personal (each side chooses their own); a synchronized variant has been seen
 * in testing. So sending is an EXPERIMENT: the client may ignore it.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Builds the envelope and sends it through the EXISTING relay. No second
 * socket, serializer, App State or pipeline.
 *
 * IMPORTANT — the oneof is NOT enforced by the generated `encode` (it uses
 * `hasOwnProperty`). Setting two wallpaper members writes BOTH to the wire and
 * the receiver resolves by the last one. `buildChatThemeSetting` therefore
 * enforces exclusivity itself.
 */

import { Boom } from '@hapi/boom';
import { generateMessageID } from './generics.js';

/** ProtocolMessage.Type.CHAT_THEME_SETTING */
export const CHAT_THEME_SETTING_TYPE = 34;

/** ProtocolMessage field 30: `chatThemeSetting`. */
export const CHAT_THEME_SETTING_FIELD = 30;

/** Wallpaper variants of the `wallpaper` oneof. */
export const WALLPAPER_VARIANTS = Object.freeze([
    'defaultWallpaper',
    'solidColor',
    'stockImage',
    'customImage',
    'animatedWallpaper'
]);

/**
 * Build a `ChatThemeSetting` value, enforcing the oneof.
 *
 * @param {object} input
 * @param {number|string|bigint} [input.settingTimestampMs]
 * @param {boolean} [input.clearTheme]
 * @param {string} [input.colorSchemeId]
 * @param {object} [input.wallpaper] `{ <variant>: {...} }` — no maximo UMA variante
 * @returns {object} o valor de `chatThemeSetting` (sem o envelope)
 */
export const buildChatThemeSetting = (input = {}) => {
    const setting = {};

    if (input.settingTimestampMs !== undefined && input.settingTimestampMs !== null) {
        const ts = input.settingTimestampMs;
        const ok =
            (typeof ts === 'number' && Number.isFinite(ts)) ||
            (typeof ts === 'bigint') ||
            (typeof ts === 'string' && /^\d+$/.test(ts));
        if (!ok) {
            throw new Boom('chatTheme: settingTimestampMs deve ser um inteiro (ou string de digitos)', { statusCode: 400 });
        }
        setting.settingTimestampMs = ts;
    }

    if (input.clearTheme !== undefined) {
        if (typeof input.clearTheme !== 'boolean') {
            throw new Boom('chatTheme: clearTheme deve ser boolean', { statusCode: 400 });
        }
        setting.clearTheme = input.clearTheme;
    }

    if (input.colorSchemeId !== undefined && input.colorSchemeId !== null) {
        if (typeof input.colorSchemeId !== 'string' || !input.colorSchemeId.trim()) {
            throw new Boom('chatTheme: colorSchemeId deve ser string nao vazia', { statusCode: 400 });
        }
        setting.colorSchemeId = input.colorSchemeId.trim();
    }

    // ── oneof: no maximo UMA variante ────────────────────────────────────────
    const wallpaper = input.wallpaper && typeof input.wallpaper === 'object' ? input.wallpaper : null;
    if (wallpaper) {
        const setadas = Object.keys(wallpaper).filter((k) => wallpaper[k] !== undefined && wallpaper[k] !== null);
        const invalidas = setadas.filter((k) => !WALLPAPER_VARIANTS.includes(k));
        if (invalidas.length) {
            throw new Boom(`chatTheme: variante de wallpaper desconhecida: ${invalidas.join(', ')}`, { statusCode: 400 });
        }
        if (setadas.length > 1) {
            // Falha fechado: o `encode` nao resolve o oneof, entao dois membros
            // iriam os DOIS no wire. Melhor recusar do que mandar lixo.
            throw new Boom(`chatTheme: o oneof aceita UMA variante de wallpaper (recebi: ${setadas.join(', ')})`, { statusCode: 400 });
        }
        if (setadas.length === 1) {
            setting[setadas[0]] = wallpaper[setadas[0]];
        }
    }

    if (!Object.keys(setting).length) {
        throw new Boom('chatTheme: nada para enviar (informe ao menos um campo)', { statusCode: 400 });
    }

    return setting;
};

/**
 * Build the `ProtocolMessage` content (NOT sent yet).
 *
 * @param {object} input mesmo de `buildChatThemeSetting`
 * @returns {{type: number, chatThemeSetting: object}}
 */
export const buildChatThemeProtocolMessage = (input = {}) => ({
    type: CHAT_THEME_SETTING_TYPE,
    chatThemeSetting: buildChatThemeSetting(input)
});

/**
 * Diagnostic line. Structure only — never a secret. `customImage` carries
 * `mediaKey`/`file*Sha256`, which are reported as LENGTH, never as content.
 */
export const logChatThemeAttempt = (logger, info) => {
    logger?.info?.(
        [
            '[CHAT-THEME]',
            `testId=${info.testId}`,
            `jid=${info.jid}`,
            `chatType=${info.chatType}`,
            `variant=${info.variant ?? 'none'}`,
            `wallpaperId=${info.wallpaperId ?? 'none'}`,
            `dimLevel=${info.dimLevel ?? 'none'}`,
            `colorSchemeId=${info.colorSchemeId ?? 'none'}`,
            `clearTheme=${info.clearTheme ?? 'none'}`,
            `timestampMs=${info.timestampMs ?? 'none'}`,
            `mediaKeyBytes=${info.mediaKeyBytes ?? 0}`,
            `messageId=${info.messageId}`,
            `send=${info.sent ? 'OK' : 'ERROR'}`,
            `result=${info.result ?? ''}`
        ].join(' ')
    );
};

/** Which variant (if any) a built setting carries. */
export const variantOf = (setting) =>
    WALLPAPER_VARIANTS.find((v) => setting && setting[v] !== undefined && setting[v] !== null) ?? null;

/**
 * Send a chat theme change through the existing relay path.
 *
 * @param {object} params
 * @param {Function} params.relayMessage socket's `relayMessage`
 * @param {string} params.jid conversation
 * @param {number|string} [params.settingTimestampMs]
 * @param {boolean} [params.clearTheme]
 * @param {string} [params.colorSchemeId]
 * @param {object} [params.wallpaper]
 * @param {string} [params.messageId]
 * @param {string} [params.testId]
 * @param {object} [params.logger]
 * @returns {Promise<{ok: boolean, built: object|null, messageId: string|undefined, variant: string|null, error?: string, reason?: string}>}
 */
export const sendChatTheme = async (params = {}) => {
    const { relayMessage, jid, testId = 'AUTO', logger } = params;

    // The id is generated HERE so it is returned to the caller. `relayMessage`
    // also accepts one, but when it generates the id itself the caller never
    // learns it — which is why the laboratory could not report it.
    const messageId = params.messageId || generateMessageID();

    if (typeof relayMessage !== 'function') {
        return { ok: false, built: null, messageId: undefined, variant: null, error: 'relay indisponivel', reason: 'sem_relay' };
    }
    if (typeof jid !== 'string' || !jid.trim()) {
        return { ok: false, built: null, messageId: undefined, variant: null, error: 'jid ausente', reason: 'sem_jid' };
    }

    let built;
    try {
        built = buildChatThemeProtocolMessage(params);
    } catch (e) {
        return { ok: false, built: null, messageId: undefined, variant: null, error: e?.message || String(e), reason: 'payload_invalido' };
    }

    const variant = variantOf(built.chatThemeSetting);
    const setting = built.chatThemeSetting;
    const wp = variant ? setting[variant] : null;
    const chatType = String(jid).endsWith('@g.us') ? 'group' : 'private';

    try {
        await relayMessage(jid, built, { messageId });
        logChatThemeAttempt(logger, {
            testId,
            jid,
            chatType,
            variant,
            wallpaperId: wp?.stockImageId ?? wp?.animatedWallpaperId ?? null,
            dimLevel: wp?.dimLevel ?? null,
            colorSchemeId: setting.colorSchemeId ?? null,
            clearTheme: setting.clearTheme ?? null,
            timestampMs: setting.settingTimestampMs != null ? String(setting.settingTimestampMs) : null,
            mediaKeyBytes: wp?.mediaKey ? wp.mediaKey.length : 0,
            messageId,
            sent: true,
            result: 'ENVIADO'
        });
        return { ok: true, built, messageId, variant };
    } catch (e) {
        logChatThemeAttempt(logger, {
            testId, jid, chatType, variant,
            messageId, sent: false,
            result: `ERRO_DE_TRANSPORTE: ${e?.message || e}`
        });
        return { ok: false, built, messageId, variant, error: e?.message || String(e), reason: 'transporte' };
    }
};
