import { platform, release } from 'os';
import { proto } from '../../WAProto/index.js';
const PLATFORM_MAP = {
    aix: 'AIX',
    darwin: 'Mac OS',
    win32: 'Windows',
    android: 'Android',
    freebsd: 'FreeBSD',
    openbsd: 'OpenBSD',
    sunos: 'Solaris',
    linux: undefined,
    haiku: undefined,
    cygwin: undefined,
    netbsd: undefined
};
export const Browsers = {
    ubuntu: browser => ['Ubuntu', browser, '22.04.4'],
    macOS: browser => ['Mac OS', browser, '14.4.1'],
    baileys: browser => ['Baileys', browser, '6.5.0'],
    windows: browser => ['Windows', browser, '10.0.22631'],
    android: browser => [browser, 'Android', ''],
    /** The appropriate browser based on your OS & release */
    appropriate: browser => [PLATFORM_MAP[platform()] || 'Ubuntu', browser, release()],
    /**
     * Desktop/UWP identity — the client WhatsApp enables the VOICE stack for.
     *
     * ## Why this exists
     *
     * WhatsApp only turns on the calling media stack (the WASM VoIP engine, the
     * relay path, RTP) when the device advertises itself as a desktop/UWP client.
     * A plain `macOS('Chrome')` identity — the package default — gets **signaling
     * only**: the call rings and can be answered, but no audio ever flows. The
     * symptom is the call stuck on "connecting" and then dropping.
     *
     * This is a documented requirement of every working Baileys calling stack:
     * `voice-calls-baileys` calls the matching `validate-connection.js` patch
     * "mandatory — without it, calls won't get voice through", and ships
     * `browser: Browsers.windows("UWP")` in its example.
     *
     * `getPlatformType` in `Utils/validate-connection.js` maps `UWP`/`DESKTOP` to
     * the real `DeviceProps.PlatformType` enum values, so this preset is what
     * actually flips the server's decision.
     */
    desktopUWP: browser => ['Windows', browser, '10.0.22631'],
    /**
     * The full advertising tuple for a voice-capable client, including the
     * 5-part build id WhatsApp expects from a desktop/UWP app.
     *
     * WhatsApp accepts a 5-part `version` (`[2, 3000, <build>, <build>, 0]`) and
     * `validate-connection.js` folds the 4th part into `quaternary`, so a 3-part
     * version is not the same advertisement. Use this when you intend to place
     * calls.
     */
    voiceCapable: browser => ({
        browser: Browsers.desktopUWP(browser),
        version: VOICE_CAPABLE_VERSION
    })
};
/**
 * The 5-part WhatsApp Web build id used by working calling integrations.
 *
 * Pinned on purpose: the value the server has already accepted for desktop/UWP
 * voice clients. Overriding it with an arbitrary build can get the client
 * rejected, which is why this is a named constant and not inlined.
 */
export const VOICE_CAPABLE_VERSION = [2, 3000, 1039498983, 261700, 0];
/**
 * Does this socket config advertise a client WhatsApp gives VOICE to?
 *
 * The failure this guards against is silent: with a Chrome/macOS identity the
 * call still signals and rings, so nothing looks wrong until you notice no audio
 * ever flows. Calling code can assert this before promising a call.
 *
 * @returns {{ ok: boolean, reason?: string, platform?: string }}
 */
export const isVoiceCapableConfig = (config = {}) => {
    const browser = config.browser;
    if (!Array.isArray(browser) || browser.length < 2) {
        return { ok: false, reason: 'browser ausente ou em formato inesperado' };
    }
    const platformType = String(browser[1] || '').toUpperCase();
    if (platformType !== 'UWP' && platformType !== 'DESKTOP') {
        return {
            ok: false,
            reason: `browser "${browser[1]}" nao e UWP/DESKTOP — o WhatsApp nao habilita a midia da call (voz fica muda)`,
            platform: platformType
        };
    }
    const v = config.version;
    if (!Array.isArray(v) || v.length < 5) {
        return {
            ok: false,
            reason: `version precisa das 5 partes do build id (recebido: ${Array.isArray(v) ? '[' + v.join(', ') + ']' : typeof v})`,
            platform: platformType
        };
    }
    return { ok: true, platform: platformType };
};
export const getPlatformId = (browser) => {
    const platformType = proto.DeviceProps.PlatformType[browser.toUpperCase()];
    return platformType ? platformType.toString() : '1'; //chrome
};
//# sourceMappingURL=browser-utils.js.map