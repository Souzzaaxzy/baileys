/**
 * Call signaling builder tests (fork).
 *
 * Pure builders: no socket, no network. Asserts the wire shapes against the
 * wacrg stanza reference and the group-call reconstruction.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    CAPABILITY_OFFER,
    CAPABILITY_PREACCEPT,
    callObjectJid,
    generateCallId,
    buildOffer,
    buildGroupOffer,
    buildPreaccept,
    buildAccept,
    buildTerminate,
    buildReject,
    buildRoster,
    groupInfoNode
} from '../lib/Utils/call-signaling.js';
import { encodeBinaryNode } from '../lib/WABinary/encode.js';

const tags = (node) => (node.content || []).map((c) => c.tag);
const child = (node, tag) => (node.content || []).find((c) => c.tag === tag);

describe('call id and call object', () => {
    it('generates a 32-char uppercase hex call id', () => {
        const id = generateCallId();
        assert.match(id, /^[0-9A-F]{32}$/);
        assert.notEqual(id, generateCallId());
    });

    it('addresses the call object as <call-id>@call', () => {
        assert.equal(callObjectJid('ABC'), 'ABC@call');
    });
});

describe('buildOffer (1:1)', () => {
    const node = buildOffer({
        callId: 'CID',
        callCreator: 'me@s.whatsapp.net',
        to: 'peer@s.whatsapp.net',
        encNodes: [{ tag: 'to', attrs: { jid: 'peer:2@s.whatsapp.net' }, content: [{ tag: 'enc', attrs: { v: '2', type: 'pkmsg' }, content: new Uint8Array([1, 2, 3]) }] }],
        stanzaId: 'STANZA'
    });

    it('wraps the offer in a <call> addressed to the peer', () => {
        assert.equal(node.tag, 'call');
        assert.equal(node.attrs.to, 'peer@s.whatsapp.net');
        assert.equal(node.attrs.id, 'STANZA');
    });

    it('keeps the mandatory child order (error 439 otherwise)', () => {
        const offer = child(node, 'offer');
        assert.deepEqual(tags(offer), ['audio', 'audio', 'net', 'capability', 'destination', 'encopt']);
        assert.equal(offer.content[0].attrs.rate, '8000');
        assert.equal(offer.content[1].attrs.rate, '16000');
        assert.equal(child(offer, 'net').attrs.medium, '3');
    });

    it('carries the call key per device inside <destination>', () => {
        const destination = child(child(node, 'offer'), 'destination');
        assert.equal(destination.content.length, 1);
        assert.equal(destination.content[0].tag, 'to');
        assert.equal(destination.content[0].content[0].tag, 'enc');
    });

    it('advertises video when asked, after the audio nodes', () => {
        const withVideo = buildOffer({ callId: 'C', callCreator: 'm', to: 'p', encNodes: [], stanzaId: 'S', video: true });
        assert.deepEqual(tags(child(withVideo, 'offer')).slice(0, 3), ['audio', 'audio', 'video']);
    });
});

describe('buildGroupOffer', () => {
    const node = buildGroupOffer({
        callId: 'CID',
        callCreator: 'me@lid',
        groupJid: '123@g.us',
        participants: [{ jid: 'me@lid', devices: [{ jid: 'me@lid', capability: CAPABILITY_OFFER }] }],
        stanzaId: 'S'
    });

    it('addresses the call object, not a peer', () => {
        assert.equal(node.attrs.to, 'CID@call');
    });

    it('binds the call to the group', () => {
        assert.equal(child(node, 'offer').attrs['group-jid'], '123@g.us');
    });

    it('uses group_info instead of destination/enc', () => {
        const offer = child(node, 'offer');
        assert.deepEqual(tags(offer), ['audio', 'audio', 'net', 'group_info']);
        assert.equal(child(offer, 'destination'), undefined);
        assert.equal(child(offer, 'enc'), undefined);
    });

    it('advertises video before net', () => {
        const v = buildGroupOffer({ callId: 'C', callCreator: 'm', groupJid: 'g@g.us', participants: [], stanzaId: 'S', video: true });
        assert.deepEqual(tags(child(v, 'offer')), ['audio', 'audio', 'video', 'net', 'group_info']);
    });
});

describe('group_info roster', () => {
    it('maps one <user> per account and one <device> per device', () => {
        const info = groupInfoNode([
            { jid: 'a@lid', devices: [{ jid: 'a@lid', capability: CAPABILITY_OFFER }] },
            { jid: 'b@s.whatsapp.net', devices: [{ jid: 'b:1@s.whatsapp.net' }, { jid: 'b:2@s.whatsapp.net' }] }
        ]);
        assert.equal(info.content.length, 2);
        assert.equal(info.content[0].content.length, 1);
        assert.equal(info.content[1].content.length, 2);
        assert.deepEqual(info.content[1].content.map((d) => d.attrs.jid), ['b:1@s.whatsapp.net', 'b:2@s.whatsapp.net']);
    });

    it('puts capability only on the creator device', () => {
        const info = groupInfoNode([
            { jid: 'me@lid', devices: [{ jid: 'me@lid', capability: CAPABILITY_OFFER }] },
            { jid: 'b@s.whatsapp.net', devices: [{ jid: 'b@s.whatsapp.net' }] }
        ]);
        const creatorCap = info.content[0].content[0].content.find((c) => c.tag === 'capability');
        assert.ok(creatorCap);
        assert.deepEqual(Array.from(creatorCap.content), Array.from(CAPABILITY_OFFER));
        assert.equal(info.content[1].content[0].content.length, 0);
    });
});

describe('buildRoster', () => {
    it('uses the BARE jid on <user> and the device jid on <device>', () => {
        // Captured shape: <user jid="156535032389744@lid"> with
        // <device jid="156535032389744:14@lid">. The qualified jid belongs on the
        // device, never on the user.
        const roster = buildRoster(
            ['b@s.whatsapp.net'],
            [
                { user: 'b', server: 's.whatsapp.net', device: 0 },
                { user: 'b', server: 's.whatsapp.net', device: 2 }
            ],
            'me:14@lid'
        );
        const b = roster.find((r) => r.jid === 'b@s.whatsapp.net');
        assert.ok(b, 'user key is bare');
        assert.deepEqual(b.devices.map((d) => d.jid), ['b@s.whatsapp.net', 'b:2@s.whatsapp.net']);

        const self = roster.find((r) => r.jid === 'me@lid');
        assert.ok(self, 'self is bare on the user key');
        assert.deepEqual(self.devices.map((d) => d.jid), ['me:14@lid'], 'self device keeps its device');
        assert.equal(roster[0].jid, 'me@lid', 'creator is listed first');
    });

    it('adds an entry for a requested account with no device data', () => {
        const roster = buildRoster(['x@s.whatsapp.net'], [], 'me@lid');
        assert.ok(roster.some((r) => r.jid === 'x@s.whatsapp.net'));
    });
});

describe('captured initial group offer shape', () => {
    // Reproduces the authoritative initial-group-call capture, so a regression in
    // any of these fields fails here instead of in production.
    const node = buildGroupOffer({
        callId: '00DD63A26643DC3496FCBD161E6E2AB1',
        callCreator: '156535032389744:14@lid',
        groupJid: null,
        participants: buildRoster(
            ['242653052539031@lid', '74170125783269@lid'],
            [
                { user: '156535032389744', server: 'lid', device: 14 },
                { user: '242653052539031', server: 'lid', device: 0 },
                { user: '242653052539031', server: 'lid', device: 1 },
                { user: '74170125783269', server: 'lid', device: 0 }
            ],
            '156535032389744:14@lid'
        ),
        stanzaId: '20350.27209-809'
    });

    it('is addressed to the call object and carries call-id/call-creator', () => {
        assert.equal(node.attrs.to, '00DD63A26643DC3496FCBD161E6E2AB1@call');
        const offer = child(node, 'offer');
        assert.equal(offer.attrs['call-id'], '00DD63A26643DC3496FCBD161E6E2AB1');
        assert.equal(offer.attrs['call-creator'], '156535032389744:14@lid');
    });

    it('has no group-jid on an ad-hoc call', () => {
        assert.equal('group-jid' in child(node, 'offer').attrs, false);
    });

    it('orders children exactly as captured', () => {
        assert.deepEqual(tags(child(node, 'offer')), ['audio', 'audio', 'net', 'group_info']);
        assert.equal(child(node, 'offer').content[0].attrs.rate, '8000');
        assert.equal(child(node, 'offer').content[1].attrs.rate, '16000');
        assert.equal(child(node, 'offer').content[2].attrs.medium, '3');
    });

    it('lists bare user jids with device-qualified children', () => {
        const groupInfo = child(child(node, 'offer'), 'group_info');
        assert.deepEqual(groupInfo.content.map((u) => u.attrs.jid), [
            '156535032389744@lid',
            '242653052539031@lid',
            '74170125783269@lid'
        ]);
        const first = groupInfo.content[0];
        assert.deepEqual(first.content.map((d) => d.attrs.jid), ['156535032389744:14@lid']);
    });

    it('puts capability only on the creator device', () => {
        const groupInfo = child(child(node, 'offer'), 'group_info');
        const creatorCap = groupInfo.content[0].content[0].content[0];
        assert.equal(creatorCap.tag, 'capability');
        assert.equal(creatorCap.attrs.ver, '1');
        for (const user of groupInfo.content.slice(1)) {
            for (const device of user.content) {
                assert.equal(device.content.length, 0, `${device.attrs.jid} must have no capability`);
            }
        }
    });
});

describe('preaccept / accept / terminate / reject', () => {
    it('preaccept uses its own capability blob and no group_info', () => {
        const node = buildPreaccept({ callId: 'C', callCreator: 'm', to: 'p', stanzaId: 'S' });
        const action = node.content[0];
        assert.equal(action.tag, 'preaccept');
        assert.deepEqual(tags(action), ['audio', 'encopt', 'capability']);
        const cap = child(action, 'capability');
        assert.deepEqual(Array.from(cap.content), Array.from(CAPABILITY_PREACCEPT));
    });

    it('accept follows audio -> te -> net -> encopt -> capability', () => {
        const node = buildAccept({ callId: 'C', callCreator: 'm', to: 'p', stanzaId: 'S', transportEndpoint: new Uint8Array([9]) });
        assert.deepEqual(tags(node.content[0]), ['audio', 'te', 'net', 'encopt', 'capability']);
        assert.equal(child(node.content[0], 'net').attrs.medium, '2');
    });

    it('terminate omits reason when absent and includes it when given', () => {
        const plain = buildTerminate({ callId: 'C', callCreator: 'm' });
        assert.equal(plain.attrs.to, 'C@call');
        assert.equal(plain.content[0].tag, 'terminate');
        assert.equal('reason' in plain.content[0].attrs, false);
        const reason = buildTerminate({ callId: 'C', callCreator: 'm', reason: 'timeout' });
        assert.equal(reason.content[0].attrs.reason, 'timeout');
    });

    it('reject carries count', () => {
        const node = buildReject({ callId: 'C', callCreator: 'm', to: 'p' });
        assert.equal(node.content[0].tag, 'reject');
        assert.equal(node.content[0].attrs.count, '0');
    });
});

describe('wire encoding', () => {
    it('encodes a group offer to bytes without throwing', () => {
        const node = buildGroupOffer({
            callId: 'CID',
            callCreator: 'me@lid',
            groupJid: '123@g.us',
            participants: [{ jid: 'me@lid', devices: [{ jid: 'me@lid', capability: CAPABILITY_OFFER }] }],
            stanzaId: 'S'
        });
        const bytes = encodeBinaryNode(node);
        assert.ok(bytes.length > 0);
        assert.ok(bytes instanceof Uint8Array);
    });
});
