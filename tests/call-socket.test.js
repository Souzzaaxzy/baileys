/**
 * Call signaling over the REAL socket path.
 *
 * `call-signaling.test.js` checks the node shapes in isolation. This test drives
 * `sock.offerGroupCall` / `sock.terminateCall` on a `makeMessagesRecvSocket`
 * instance with a fake WebSocket, so it proves the wiring too: that the methods
 * exist on the socket, that they reach `query`, and that what goes on the wire
 * is a `<call>` stanza with the expected shape.
 *
 * The fake socket answers `query` with the `<ack class="call">` the server would
 * send, keyed by the stanza id — the same mechanism the real ack uses.
 *
 * Run: node tests/call-socket.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

import { makeMessagesRecvSocket } from '../lib/Socket/messages-recv.js';
import { makeCacheableSignalKeyStore, initAuthCreds } from '../lib/Utils/auth-utils.js';
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js';
import { decodeBinaryNode } from '../lib/WABinary/index.js';
import { NOISE_WA_HEADER } from '../lib/Defaults/index.js';
import { Browsers } from '../lib/Utils/browser-utils.js';
import { WebSocketClient } from '../lib/Socket/Client/index.js';
import { makeRemoteDevice } from './helpers/test-signal-sessions.js';
import pino from 'pino';

const require = createRequire(import.meta.url);
void require;

const logger = pino({ level: process.env.LOGLEVEL ?? 'silent' });
const GROUP = '120363000000000001@g.us';
const ME = '5511900000001@s.whatsapp.net';
const ME_LID = '100000000000001@lid';
const PEERS = [
    { lid: '200000000000001@lid', pn: '5511900000002@s.whatsapp.net', devices: [0, 2] },
    { lid: '200000000000002@lid', pn: '5511900000003@s.whatsapp.net', devices: [0] }
];

const makeKeys = () => {
    const data = {};
    return {
        get: async (type, ids) => {
            const out = {};
            for (const id of ids) out[id] = data[`${type}:${id}`];
            return out;
        },
        set: async (patch) => {
            for (const [type, entries] of Object.entries(patch)) {
                for (const [id, value] of Object.entries(entries)) {
                    if (value === null) delete data[`${type}:${id}`];
                    else data[`${type}:${id}`] = value;
                }
            }
        }
    };
};

/**
 * Read one encoded frame back into a node.
 *
 * A frame is `[noise header][3-byte big-endian length][payload]`; the length
 * prefix is easy to forget and makes the decode return garbage (which silently
 * swallows the ack and hangs the query).
 */
const readFrameNode = (frame, first = false) => {
    const offset = first && frame.subarray(0, NOISE_WA_HEADER.length).equals(NOISE_WA_HEADER)
        ? NOISE_WA_HEADER.length
        : 0;
    const length = frame.readUIntBE(offset, 3);
    return decodeBinaryNode(frame.subarray(offset + 3, offset + 3 + length));
};

/**
 * Answer a `usync` device query with a `<device-list>` for each requested user,
 * the shape `USyncDeviceProtocol` parses. Without this the device discovery
 * would go to the network (which this fake socket does not have).
 */
const buildUsyncReply = (requestNode) => {
    const usync = requestNode.content?.find((c) => c.tag === 'usync');
    const list = usync?.content?.find((c) => c.tag === 'list');
    const users = (list?.content || []).map((userNode) => {
        const jid = userNode.attrs?.jid;
        if (!jid) return null;
        const user = jid.split('@')[0].split(':')[0];
        const devices = DEVICE_INDEX[user] || [0];
        return {
            tag: 'user',
            attrs: { jid },
            content: [
                {
                    tag: 'devices',
                    attrs: {},
                    content: [
                        {
                            tag: 'device-list',
                            attrs: {},
                            // Non-zero devices MUST carry a `key-index`, otherwise the
                            // library discards them (see `extractDeviceJids`).
                            content: devices.map((id) => ({
                                tag: 'device',
                                attrs: { id: String(id), 'key-index': String(id) }
                            }))
                        }
                    ]
                }
            ]
        };
    }).filter(Boolean);
    return {
        tag: 'iq',
        attrs: { type: 'result', from: 's.whatsapp.net', id: requestNode.attrs.id },
        content: [{ tag: 'usync', attrs: {}, content: [{ tag: 'list', attrs: {}, content: users }] }]
    };
};

/** Which devices each account has, for the fake usync reply. */
const DEVICE_INDEX = {};
for (const peer of PEERS) {
    DEVICE_INDEX[peer.lid.split('@')[0]] = peer.devices;
    DEVICE_INDEX[peer.pn.split('@')[0]] = peer.devices;
}
DEVICE_INDEX[ME_LID.split('@')[0]] = [0];
DEVICE_INDEX[ME.split('@')[0]] = [0];

/**
 * Build a socket with a fake WebSocket that records every frame, answers `query`
 * with a `<ack>` carrying the same stanza id, and serves device queries locally.
 */
const makeSock = async ({ ackCall = true } = {}) => {
    const creds = initAuthCreds();
    creds.me = { id: ME, lid: ME_LID, name: 'test' };
    const keys = makeKeys();
    const sent = [];

    // The library builds its own WebSocketClient; patching `connect` on the
    // prototype is how the existing socket tests swap in a fake transport.
    WebSocketClient.prototype.connect = function connect() {
        const client = this;
        this.socket = {
            readyState: 1,
            send: (frame, cb) => {
                const bytes = Buffer.from(frame);
                sent.push(bytes);
                cb?.(null);
                // Only the first frame on a fresh socket carries the noise header.
                void readFrameNode(bytes, sent.length === 1).then((node) => {
                    if (!node?.attrs?.id) return;
                    if (node.tag === 'iq' && node.attrs.xmlns === 'usync') {
                        client.emit(`TAG:${node.attrs.id}`, buildUsyncReply(node));
                        return;
                    }
                    // The server acks every `<call>` with a matching id.
                    if (node.tag === 'call' && ackCall) {
                        client.emit(`TAG:${node.attrs.id}`, {
                            tag: 'ack',
                            attrs: { id: node.attrs.id, class: 'call', from: 's.whatsapp.net' }
                        });
                    }
                });
                return true;
            },
            on: () => {},
            off: () => {},
            setMaxListeners: () => {},
            close: () => {},
            once: (event, cb) => {
                if (event === 'close') setImmediate(cb);
            }
        };
    };

    const sock = makeMessagesRecvSocket({
        logger,
        auth: { creds, keys: makeCacheableSignalKeyStore(keys, logger) },
        waWebSocketUrl: 'ws://127.0.0.1:9/',
        makeSignalRepository: makeLibSignalRepository,
        shouldIgnoreJid: () => false,
        getMessage: async () => undefined,
        patchMessageBeforeSending: (msg) => msg,
        browser: Browsers.macOS('Chrome'),
        shouldSyncHistoryMessage: () => false,
        keepAliveIntervalMs: 60_000,
        transactionOpts: { maxCommitRetries: 2, delayBetweenTriesMs: 1 },
        connectTimeoutMs: 5_000,
        options: {}
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Device discovery is served by the fake WebSocket (see buildUsyncReply), so
    // it exercises the real `getUSyncDevices` path. Only the Signal handshake is
    // stubbed, since the point here is the stanza, not the encryption.
    const repository = sock.signalRepository;
    repository.validateSession = async () => ({ exists: true });
    for (const peer of PEERS) {
        for (const base of [peer.lid, peer.pn]) {
            const user = base.split('@')[0];
            const server = base.split('@')[1];
            for (const device of peer.devices) {
                const remote = makeRemoteDevice(user, device);
                const jid = device === 0 ? base : `${user}:${device}@${server}`;
                await repository.injectE2ESession({ jid, session: remote.bundle });
            }
        }
    }

    return { sock, sent };
};

const callStanza = async (frames) => {
    for (let i = frames.length - 1; i >= 0; i -= 1) {
        const node = await readFrameNode(frames[i], i === 0);
        if (node?.tag === 'call') return node;
    }
    return null;
};

describe('socket call methods', () => {
    it('exposes offerCall / offerGroupCall / terminateCall on the socket', async () => {
        const { sock } = await makeSock();
        assert.equal(typeof sock.offerCall, 'function');
        assert.equal(typeof sock.offerGroupCall, 'function');
        assert.equal(typeof sock.terminateCall, 'function');
    });

    it('offerGroupCall sends a <call><offer> and resolves on the ack', async () => {
        const { sock, sent } = await makeSock();
        const result = await sock.offerGroupCall(GROUP, PEERS.map((p) => p.lid));

        assert.ok(result.id, 'returns the call id');
        assert.equal(result.groupJid, GROUP);
        assert.equal(result.participants, 3, 'self + 2 peers');

        const node = await callStanza(sent);
        assert.ok(node, 'a <call> stanza was sent');
        // Group offers are addressed to the call object.
        assert.equal(node.attrs.to, `${result.id}@call`);
        const offer = node.content.find((c) => c.tag === 'offer');
        assert.equal(offer.attrs['call-id'], result.id);
        assert.equal(offer.attrs['group-jid'], GROUP);
        assert.equal(offer.attrs['call-creator'], ME_LID);
        assert.deepEqual(
            offer.content.map((c) => c.tag),
            ['audio', 'audio', 'net', 'group_info']
        );
    });

    it('the group offer roster lists every invited device', async () => {
        const { sock, sent } = await makeSock();
        await sock.offerGroupCall(GROUP, PEERS.map((p) => p.lid));
        const node = await callStanza(sent);
        const offer = node.content.find((c) => c.tag === 'offer');
        const groupInfo = offer.content.find((c) => c.tag === 'group_info');
        const users = groupInfo.content;
        // self + 2 peers
        assert.equal(users.length, 3);
        const peer = users.find((u) => u.attrs.jid === PEERS[0].lid);
        assert.ok(peer, 'peer appears in the roster');
        assert.equal(peer.content.length, 2, 'peer with two devices lists both');
        const self = users.find((u) => u.attrs.jid === ME_LID);
        assert.ok(self, 'the caller is in the roster');
    });

    it('rejects a non-group JID', async () => {
        const { sock } = await makeSock();
        await assert.rejects(() => sock.offerGroupCall('5511900000002@s.whatsapp.net'), /group JID/);
    });

    it('FAILS when the server does not ack (silence is not success)', async () => {
        // The socket layer turns a query timeout into `undefined` (or lets the
        // outer timeout throw); either way it must NOT be read as success. If it
        // were, the caller would report a placed call while nothing rings.
        const { sock } = await makeSock({ ackCall: false });
        await assert.rejects(
            () => sock.offerGroupCall(GROUP, PEERS.map((p) => p.lid), { timeoutMs: 1500 }),
            /not acknowledged|Timed Out|timed out/i
        );
    });

    it('terminateCall sends a <call><terminate>', async () => {
        const { sock, sent } = await makeSock();
        const { id } = await sock.offerGroupCall(GROUP, PEERS.map((p) => p.lid));
        sent.length = 0;
        await sock.terminateCall(id);
        const node = await callStanza(sent);
        assert.ok(node, 'a <call> stanza was sent');
        assert.equal(node.attrs.to, `${id}@call`);
        const terminate = node.content.find((c) => c.tag === 'terminate');
        assert.equal(terminate.attrs['call-id'], id);
        assert.equal('reason' in terminate.attrs, false, 'no reason on a plain hang-up');
    });
});
