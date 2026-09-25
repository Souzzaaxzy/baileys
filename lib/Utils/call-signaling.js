/**
 * Call signaling builders — WhatsApp `<call>` stanza construction.
 *
 * This module is PURE: it builds WABinary nodes. It does not open sockets, touch
 * disk, or hold state. The socket wiring lives in `Socket/messages-recv.js`,
 * which is the only layer that can reach `query`, `getUSyncDevices` and
 * `createParticipantNodes`.
 *
 * ## Scope
 *
 * This covers **call signaling**: the `<call>` nodes that open a call, ring the
 * peer, answer, negotiate transport and hang up. It does NOT carry call media —
 * audio/video travel over SRTP/UDP with keys negotiated separately, which is a
 * different stack. Building these nodes makes a call *exist* (it rings, it can
 * be answered, it can be ended); it does not put sound on the wire.
 *
 * ## Where the shapes come from
 *
 * - WhatsApp Calls Research Group (wacrg) `docs/signaling/stanza-reference.md`
 *   for the envelope, the mandatory child order of `<offer>`, and the
 *   terminate / accept / preaccept layouts.
 * - The reference group-call reconstruction (`BuildInitialGroupOffer`,
 *   `BuildGroupInviteOffer`) for the group-bound offer: wrapper addressed to
 *   `<call-id>@call`, `group-jid` on the offer, and a `<group_info>` roster.
 *
 * ## The child order is load-bearing
 *
 * The server rejects a mis-ordered `<offer>` with **error 439**. The order is:
 *   privacy -> audio(8000) -> audio(16000) -> [video] -> net -> capability
 *   -> (destination | enc) -> encopt -> device-identity
 * For the group offer the tail is `group_info` instead of `destination`/`enc`.
 */

import { randomBytes } from 'crypto';
import { jidEncode } from '../WABinary/index.js';

/** `<offer>`/`<accept>` capability blob (ver=1). */
export const CAPABILITY_OFFER = Object.freeze([0x01, 0x05, 0xf7, 0x09, 0xe0, 0xbb, 0x13]);

/** `<preaccept>` capability blob — differs only in the last byte. */
export const CAPABILITY_PREACCEPT = Object.freeze([0x01, 0x05, 0xf7, 0x09, 0xe0, 0xbb, 0x07]);

/** Domain of a call object: `<call-id>@call`. */
export const CALL_SERVER = 'call';

/** `to` JID of the call object for a given call id. */
export const callObjectJid = (callId) => `${callId}@${CALL_SERVER}`;

/** Fresh call id: 16 random bytes, uppercase hex (same shape as WhatsApp Web). */
export const generateCallId = () => randomBytes(16).toString('hex').toUpperCase();

/** `<audio enc="opus" rate="…"/>`. */
const audioNode = (rate) => ({
    tag: 'audio',
    attrs: { enc: 'opus', rate: String(rate) },
    content: undefined
});

/** `<video …/>` — advertised only for video calls. */
const videoNode = () => ({
    tag: 'video',
    attrs: {
        enc: 'vp8',
        dec: 'vp8',
        orientation: '0',
        screen_width: '1920',
        screen_height: '1080',
        device_orientation: '0'
    },
    content: undefined
});

/** `<capability ver="1">blob</capability>`. */
const capabilityNode = (blob) => ({
    tag: 'capability',
    attrs: { ver: '1' },
    content: new Uint8Array(blob)
});

/**
 * `<destination>` wrapping one `<to jid>` per device, each carrying its own
 * `<enc>` — the multi-device fan-out of the call key.
 *
 * `encNodes` comes from `createParticipantNodes()`, which already emits
 * `{ tag: 'to', attrs: { jid }, content: [<enc>] }`, so it is passed through
 * unchanged.
 */
export const destinationNode = (encNodes) => ({
    tag: 'destination',
    attrs: {},
    content: encNodes
});

/**
 * `<group_info>` roster: one `<user>` per participant, one `<device>` per linked
 * device. Only the creator's own device advertises a capability blob — that is
 * what the reference group-call reconstruction does.
 *
 * @param participants `[{ jid, devices: [{ jid, capability? }] }]`
 */
export const groupInfoNode = (participants) => ({
    tag: 'group_info',
    attrs: {},
    content: (participants || []).map(({ jid, devices }) => ({
        tag: 'user',
        attrs: { jid },
        content: (devices || []).map((device) => {
            const deviceJid = typeof device === 'string' ? device : device.jid;
            const capability = typeof device === 'string' ? null : device.capability;
            return {
                tag: 'device',
                attrs: { jid: deviceJid },
                content: capability ? [capabilityNode(capability)] : []
            };
        })
    }))
});

/**
 * Wrap an action in the top-level `<call>` envelope.
 *
 * `to` is either a peer JID (1:1) or the call object (`<call-id>@call`). `id` is
 * the stanza id used to correlate the server ack.
 */
export const callEnvelope = (to, id, action) => ({
    tag: 'call',
    attrs: { to, ...(id ? { id } : {}) },
    content: [action]
});

/** Shared media head of an `<offer>`. */
const offerHead = ({ video }) => {
    const children = [audioNode(8000), audioNode(16000)];
    if (video) children.push(videoNode());
    return children;
};

/**
 * Build a 1:1 `<call><offer>` — the "I am calling you" stanza.
 *
 * The call key is delivered per recipient device as `<enc>` nodes inside
 * `<destination>`; `encNodes` must come from `createParticipantNodes()` so the
 * payload is encrypted with the existing Signal sessions.
 */
export const buildOffer = ({ callId, callCreator, to, encNodes, stanzaId, video = false, deviceIdentity }) => {
    const children = offerHead({ video });
    children.push({ tag: 'net', attrs: { medium: '3' }, content: undefined });
    children.push(capabilityNode(CAPABILITY_OFFER));
    children.push(destinationNode(encNodes || []));
    children.push({ tag: 'encopt', attrs: { keygen: '2' }, content: undefined });
    if (deviceIdentity) {
        children.push({ tag: 'device-identity', attrs: {}, content: deviceIdentity });
    }
    return callEnvelope(to, stanzaId, {
        tag: 'offer',
        attrs: { 'call-id': callId, 'call-creator': callCreator },
        content: children
    });
};

/**
 * Build a group-bound `<call><offer>` — "start a call in this group".
 *
 * Differences from the 1:1 offer, all load-bearing:
 *   - the wrapper is addressed to the CALL OBJECT (`<call-id>@call`), not a peer;
 *   - `group-jid` binds the call to the group;
 *   - the roster travels in `<group_info>` and there is NO `<destination>`/`<enc>`
 *     (the group key arrives later, per epoch, via `enc_rekey`).
 */
export const buildGroupOffer = ({ callId, callCreator, groupJid, participants, stanzaId, video = false }) => {
    const children = offerHead({ video });
    children.push({ tag: 'net', attrs: { medium: '3' }, content: undefined });
    children.push(groupInfoNode(participants));
    return callEnvelope(callObjectJid(callId), stanzaId, {
        tag: 'offer',
        attrs: {
            'call-id': callId,
            'call-creator': callCreator,
            ...(groupJid ? { 'group-jid': groupJid } : {})
        },
        content: children
    });
};

/**
 * Build `<call><preaccept>` — "your offer arrived, I am ringing".
 *
 * Not an answer: it does not commit to the call. Child order:
 * audio* -> [video] -> encopt -> capability (preaccept blob).
 */
export const buildPreaccept = ({ callId, callCreator, to, stanzaId, video = false, audioRates = [16000] }) => {
    const children = audioRates.map(audioNode);
    if (video) children.push(videoNode());
    children.push({ tag: 'encopt', attrs: { keygen: '2' }, content: undefined });
    children.push(capabilityNode(CAPABILITY_PREACCEPT));
    return callEnvelope(to, stanzaId, {
        tag: 'preaccept',
        attrs: { 'call-id': callId, 'call-creator': callCreator },
        content: children
    });
};

/**
 * Build `<call><accept>` — the callee answers.
 *
 * Child order: audio* -> [video] -> te -> net -> encopt -> capability.
 * `transportEndpoint` is the relay `<te priority="2">` blob when available.
 */
export const buildAccept = ({
    callId,
    callCreator,
    to,
    stanzaId,
    video = false,
    audioRates = [16000],
    transportEndpoint
}) => {
    const children = audioRates.map(audioNode);
    if (video) children.push(videoNode());
    if (transportEndpoint) {
        children.push({ tag: 'te', attrs: { priority: '2' }, content: transportEndpoint });
    }
    children.push({ tag: 'net', attrs: { medium: '2' }, content: undefined });
    children.push({ tag: 'encopt', attrs: { keygen: '2' }, content: undefined });
    children.push(capabilityNode(CAPABILITY_OFFER));
    return callEnvelope(to, stanzaId, {
        tag: 'accept',
        attrs: { 'call-id': callId, 'call-creator': callCreator },
        content: children
    });
};

/**
 * Build `<call><terminate>` — end the call (either direction).
 *
 * `reason` is omitted entirely when absent: an empty `reason=""` is not the same
 * as no reason (absence means a normal hang-up).
 */
export const buildTerminate = ({ callId, callCreator, to, stanzaId, reason }) => {
    const attrs = { 'call-id': callId, 'call-creator': callCreator };
    if (reason) attrs.reason = reason;
    return callEnvelope(to || callObjectJid(callId), stanzaId, {
        tag: 'terminate',
        attrs,
        content: undefined
    });
};

/** Build `<call><reject>` — decline an incoming call. */
export const buildReject = ({ callId, callCreator, to, stanzaId, count = '0' }) =>
    callEnvelope(to, stanzaId, {
        tag: 'reject',
        attrs: { 'call-id': callId, 'call-creator': callCreator, count: String(count) },
        content: undefined
    });

/**
 * Normalise a `getUSyncDevices()` result into a `group_info` roster.
 *
 * One `<user>` per account with one `<device>` per linked device. Devices are
 * re-encoded from `{ user, server, device }` because that is the shape the
 * device query returns. The local device is the only one advertising a
 * capability blob.
 *
 * @param jids     accounts to include
 * @param devices  raw device records
 * @param selfJid  the local device
 */
export const buildRoster = (jids, devices, selfJid) => {
    const selfUser = selfJid ? selfJid.split('@')[0].split(':')[0] : null;
    const byUser = new Map();
    for (const device of devices || []) {
        if (!device?.user) continue;
        const server = device.server || 's.whatsapp.net';
        const full = jidEncode(device.user, server, device.device);
        const key = `${device.user}@${server}`;
        if (!byUser.has(key)) byUser.set(key, { jid: key, devices: [] });
        byUser.get(key).devices.push({
            jid: full,
            capability: selfUser && device.user === selfUser ? CAPABILITY_OFFER : null
        });
    }
    if (selfJid) {
        const selfKey = selfJid.includes('@') ? selfJid : `${selfJid}@s.whatsapp.net`;
        if (!byUser.has(selfKey)) {
            byUser.set(selfKey, { jid: selfKey, devices: [{ jid: selfJid, capability: CAPABILITY_OFFER }] });
        }
    }
    const wanted = new Set((jids || []).map((jid) => (jid.includes('@') ? jid : `${jid}@s.whatsapp.net`)));
    const selfKey = selfJid ? (selfJid.includes('@') ? selfJid : `${selfJid}@s.whatsapp.net`) : null;
    // The local participant is always part of the roster: it is the call creator,
    // and filtering it out would produce a roster without the caller.
    const roster = [...byUser.values()].filter((entry) => !wanted.size || wanted.has(entry.jid) || entry.jid === selfKey);
    for (const jid of wanted) {
        if (!roster.some((entry) => entry.jid === jid)) {
            roster.push({ jid, devices: [{ jid, capability: null }] });
        }
    }
    return roster;
};
