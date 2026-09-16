/**
 * Tests for the call signalling surface.
 *
 * Run: node --test tests/
 *
 * These cover the pure pieces: the wire-tag -> status mapping and the call
 * status constants. Building a real `call` event needs a socket, so that path
 * is exercised indirectly through getCallStatusFromNode (handleCall is a thin
 * wrapper that only reads attributes off the node).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CallStatus, CALL_OFFER_EVICTED_STATUSES, isCallEnded, isMissedCall } from '../lib/Types/Call.js';
import { getCallStatusFromNode } from '../lib/Utils/generics.js';

describe('getCallStatusFromNode', () => {
    it('maps offer and offer_notice to offer', () => {
        assert.equal(getCallStatusFromNode({ tag: 'offer', attrs: {} }), 'offer');
        assert.equal(getCallStatusFromNode({ tag: 'offer_notice', attrs: {} }), 'offer');
    });

    it('maps the simple control stanzas', () => {
        assert.equal(getCallStatusFromNode({ tag: 'preaccept', attrs: {} }), 'preaccept');
        assert.equal(getCallStatusFromNode({ tag: 'transport', attrs: {} }), 'transport');
        assert.equal(getCallStatusFromNode({ tag: 'relaylatency', attrs: {} }), 'relaylatency');
        assert.equal(getCallStatusFromNode({ tag: 'reject', attrs: {} }), 'reject');
        assert.equal(getCallStatusFromNode({ tag: 'accept', attrs: {} }), 'accept');
    });

    it('splits terminate on reason=timeout', () => {
        assert.equal(getCallStatusFromNode({ tag: 'terminate', attrs: { reason: 'timeout' } }), 'timeout');
        assert.equal(getCallStatusFromNode({ tag: 'terminate', attrs: { reason: 'busy' } }), 'terminate');
        assert.equal(getCallStatusFromNode({ tag: 'terminate', attrs: { reason: 'declined' } }), 'terminate');
        assert.equal(getCallStatusFromNode({ tag: 'terminate', attrs: { reason: 'connection_lost' } }), 'terminate');
        assert.equal(getCallStatusFromNode({ tag: 'terminate', attrs: {} }), 'terminate');
    });

    it('falls back to ringing for unknown tags', () => {
        assert.equal(getCallStatusFromNode({ tag: 'something-new', attrs: {} }), 'ringing');
        assert.equal(getCallStatusFromNode({ tag: '', attrs: {} }), 'ringing');
    });

    it('does not throw on a node without attrs', () => {
        // A malformed node should still classify rather than crash the handler.
        assert.equal(getCallStatusFromNode({ tag: 'terminate' }), 'terminate');
    });

    it('covers every status in CallStatus', () => {
        const fromTags = [
            getCallStatusFromNode({ tag: 'offer', attrs: {} }),
            getCallStatusFromNode({ tag: 'unknown', attrs: {} }),
            getCallStatusFromNode({ tag: 'preaccept', attrs: {} }),
            getCallStatusFromNode({ tag: 'transport', attrs: {} }),
            getCallStatusFromNode({ tag: 'relaylatency', attrs: {} }),
            getCallStatusFromNode({ tag: 'accept', attrs: {} }),
            getCallStatusFromNode({ tag: 'reject', attrs: {} }),
            getCallStatusFromNode({ tag: 'terminate', attrs: { reason: 'busy' } }),
            getCallStatusFromNode({ tag: 'terminate', attrs: { reason: 'timeout' } })
        ];
        assert.deepEqual(fromTags.slice().sort(), Object.values(CallStatus).slice().sort());
    });
});

describe('CallStatus constants', () => {
    it('matches the strings emitted by getCallStatusFromNode', () => {
        assert.equal(CallStatus.Offer, 'offer');
        assert.equal(CallStatus.Ringing, 'ringing');
        assert.equal(CallStatus.PreAccept, 'preaccept');
        assert.equal(CallStatus.Transport, 'transport');
        assert.equal(CallStatus.RelayLatency, 'relaylatency');
        assert.equal(CallStatus.Accept, 'accept');
        assert.equal(CallStatus.Reject, 'reject');
        assert.equal(CallStatus.Terminate, 'terminate');
        assert.equal(CallStatus.Timeout, 'timeout');
    });

    it('is frozen so consumers cannot mutate shared state', () => {
        assert.throws(() => {
            CallStatus.Offer = 'tampered';
        }, TypeError);
    });

    it('lists exactly the four statuses that evict the cached offer', () => {
        // Mirrors the eviction condition in handleCall().
        assert.deepEqual([...CALL_OFFER_EVICTED_STATUSES].slice().sort(),
            ['accept', 'reject', 'terminate', 'timeout']);
    });
});

describe('call status helpers', () => {
    it('isCallEnded is true only for reject/timeout/terminate', () => {
        assert.equal(isCallEnded('reject'), true);
        assert.equal(isCallEnded('timeout'), true);
        assert.equal(isCallEnded('terminate'), true);
        assert.equal(isCallEnded('offer'), false);
        assert.equal(isCallEnded('accept'), false);
        assert.equal(isCallEnded(undefined), false);
    });

    it('isMissedCall is true only for timeout', () => {
        assert.equal(isMissedCall('timeout'), true);
        assert.equal(isMissedCall('terminate'), false);
        assert.equal(isMissedCall('reject'), false);
        assert.equal(isMissedCall(undefined), false);
    });
});
