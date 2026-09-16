/**
 * Call signalling constants.
 *
 * The values here mirror `getCallStatusFromNode()` in `lib/Utils/generics.js`,
 * which is the single place where the wire tags are translated into a status
 * string. Keep both in sync: a new tag mapped there must be added here too.
 *
 * These are signalling concepts only. This library does not carry call media.
 */

/**
 * Every `status` a `call` event can carry.
 *
 * `offer` covers both the `offer` and `offer_notice` wire tags, and `ringing`
 * is the fallback for any tag that is not explicitly mapped.
 */
export const CallStatus = Object.freeze({
    /** Incoming call offer. Carries `isVideo`, `isGroup` and `groupJid`. */
    Offer: 'offer',
    /** Ringing, or any tag not explicitly mapped. */
    Ringing: 'ringing',
    /** The callee device is preparing to answer. */
    PreAccept: 'preaccept',
    /** Media transport negotiation. */
    Transport: 'transport',
    /** Relay latency report. Carries `latencyMs`. */
    RelayLatency: 'relaylatency',
    /** The call was answered. */
    Accept: 'accept',
    /** The call was declined. */
    Reject: 'reject',
    /** The call ended for a reason other than a timeout. */
    Terminate: 'terminate',
    /** The call ended with `reason=timeout` — i.e. nobody answered. */
    Timeout: 'timeout'
});

/**
 * Statuses that drop the cached offer state for the call.
 *
 * Mirrors the eviction condition in `handleCall()`. Note that `accept` is in
 * this list even though the call is live at that point: the cached offer is
 * only needed to enrich events *before* the call connects.
 */
export const CALL_OFFER_EVICTED_STATUSES = Object.freeze([
    CallStatus.Reject,
    CallStatus.Accept,
    CallStatus.Timeout,
    CallStatus.Terminate
]);

/** True when `status` means the call is finished. */
export const isCallEnded = (status) =>
    status === CallStatus.Reject || status === CallStatus.Timeout || status === CallStatus.Terminate;

/**
 * True when `status` means the call was never answered.
 *
 * This is the condition under which the library synthesises a missed-call stub
 * message (`CALL_MISSED_*`).
 */
export const isMissedCall = (status) => status === CallStatus.Timeout;
