/**
 * Types for the `call` event.
 *
 * The shape below is taken directly from `handleCall()` in
 * `lib/Socket/messages-recv.js`, which is the only place a call event is built.
 *
 * This covers call *signalling*. Media (audio/video) is not implemented by this
 * library, so nothing here relates to carrying a call.
 */

/** Every `status` a call event can carry. See `Call.js` for the runtime values. */
export type CallStatusValue =
    | 'offer'
    | 'ringing'
    | 'preaccept'
    | 'transport'
    | 'relaylatency'
    | 'accept'
    | 'reject'
    | 'terminate'
    | 'timeout';

export const CallStatus: {
    /** Incoming call offer. Carries `isVideo`, `isGroup` and `groupJid`. */
    readonly Offer: 'offer';
    /** Ringing, or any unmapped wire tag. */
    readonly Ringing: 'ringing';
    /** The callee device is preparing to answer. */
    readonly PreAccept: 'preaccept';
    /** Media transport negotiation. */
    readonly Transport: 'transport';
    /** Relay latency report. Carries `latencyMs`. */
    readonly RelayLatency: 'relaylatency';
    /** The call was answered. */
    readonly Accept: 'accept';
    /** The call was declined. */
    readonly Reject: 'reject';
    /** The call ended for a reason other than a timeout. */
    readonly Terminate: 'terminate';
    /** The call ended with `reason=timeout` — nobody answered. */
    readonly Timeout: 'timeout';
};

/** Statuses that drop the cached offer state. Mirrors `handleCall()`. */
export const CALL_OFFER_EVICTED_STATUSES: readonly CallStatusValue[];

/** True when `status` means the call is finished. */
export function isCallEnded(status: CallStatusValue): boolean;

/** True when `status` means the call was never answered. */
export function isMissedCall(status: CallStatusValue): boolean;

/**
 * A call signalling event, emitted as `ev.on('call', ([call]) => ...)`.
 *
 * Note the payload is wrapped in an array, matching every other Baileys event.
 */
export interface Call {
    /** JID of the chat the call belongs to (the `from` attr of the `<call>` stanza). */
    chatId: string;
    /** JID of the device that originated the event. */
    from: string;
    /** Logical call session id, used to correlate every stanza of one call. */
    id: string;
    /** When the stanza was received, from the `t` attribute. */
    date: Date;
    /** True when the stanza arrived as part of the offline backlog. */
    offline: boolean;
    /** Which point of the call lifecycle this event represents. */
    status: CallStatusValue;
    /**
     * Phone-number JID of the caller, when the wire provides it.
     * Populated from the cached offer on follow-up events.
     */
    callerPn?: string;
    /** Present on `relaylatency` events: measured relay latency. */
    latencyMs?: number;
    /** Present on `offer` (and follow-ups enriched from the cache). */
    isVideo?: boolean;
    /** Present on `offer` (and follow-ups enriched from the cache). */
    isGroup?: boolean;
    /** JID of the group, for group calls. */
    groupJid?: string;
}

/** Media type accepted by `createCallLink`. */
export type CallLinkMedia = 'audio' | 'video';
//# sourceMappingURL=Call.d.ts.map
