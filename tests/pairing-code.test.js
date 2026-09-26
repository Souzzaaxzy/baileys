/**
 * Pairing code: canonical platform display + pair-device readiness.
 *
 * Two defects made a generated code be rejected on the phone:
 *
 *   1. `companion_platform_display` was built as `${browser[1]} (${browser[0]})`.
 *      With the UWP browser identity the bot uses for calls, that produced
 *      "UWP (Windows)" — a label WhatsApp rejects (the QR path tolerates it,
 *      which is why QR worked and pairing did not).
 *   2. `requestPairingCode` fired the `link_code_companion_reg` immediately. The
 *      server only accepts it after answering `pair-device`, so requesting too
 *      early yielded a dead code.
 *
 * This test drives the REAL `requestPairingCode` on a socket with a fake
 * WebSocket, so it proves both the wire shape and the readiness ordering.
 *
 * Run: node tests/pairing-code.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeSocket } from '../lib/Socket/socket.js';
import { makeCacheableSignalKeyStore, initAuthCreds } from '../lib/Utils/auth-utils.js';
import { makeLibSignalRepository } from '../lib/Signal/libsignal.js';
import { decodeBinaryNode } from '../lib/WABinary/index.js';
import { NOISE_WA_HEADER } from '../lib/Defaults/index.js';
import { getPairingCodePlatform } from '../lib/Utils/companion-reg-client-utils.js';
import { WebSocketClient } from '../lib/Socket/Client/index.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });
const ME = '5511900000001@s.whatsapp.net';

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

const readFrameNode = async (frame, first = false) => {
    const offset = first && frame.subarray(0, NOISE_WA_HEADER.length).equals(NOISE_WA_HEADER)
        ? NOISE_WA_HEADER.length
        : 0;
    const length = frame.readUIntBE(offset, 3);
    return decodeBinaryNode(frame.subarray(offset + 3, offset + 3 + length));
};

/** Find the child tag of a `<link_code_companion_reg>` node, decoded to a string. */
const companionChild = (node, tag) => {
    if (!Array.isArray(node?.content)) return undefined;
    const reg = node.content.find((child) => child.tag === 'link_code_companion_reg');
    if (!Array.isArray(reg?.content)) return undefined;
    const found = reg.content.find((child) => child.tag === tag);
    return found?.content?.toString('utf-8');
};

/**
 * Build a socket with a fake WebSocket. Every sent frame is recorded, and the
 * fake client can be driven to emit the server stanzas a real connection would.
 */
const makeSock = async () => {
    const creds = initAuthCreds();
    const keys = makeKeys();
    const sent = [];
    let client;

    WebSocketClient.prototype.connect = function connect() {
        client = this;
        this.socket = {
            readyState: 1,
            send: (frame, cb) => {
                sent.push(Buffer.from(frame));
                cb?.(null);
                // The server acks every `set` iq (including the pairing
                // link_code_companion_reg) with a matching id. Without it the
                // query would time out, which is what the real flow relies on.
                void readFrameNode(Buffer.from(frame), sent.length === 1).then((node) => {
                    if (node?.tag === 'iq' && node.attrs.type === 'set' && node.attrs.id) {
                        client.emit(`TAG:${node.attrs.id}`, {
                            tag: 'iq',
                            attrs: { type: 'result', id: node.attrs.id, from: 's.whatsapp.net' }
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

    const sock = makeSocket({
        logger,
        auth: { creds, keys: makeCacheableSignalKeyStore(keys, logger) },
        waWebSocketUrl: 'ws://127.0.0.1:9/',
        makeSignalRepository: makeLibSignalRepository,
        // The browser identity the bot uses for the voice-call stack.
        browser: ['Windows', 'UWP', '10.0.22631'],
        shouldSyncHistoryMessage: () => false,
        keepAliveIntervalMs: 60_000,
        transactionOpts: { maxCommitRetries: 2, delayBetweenTriesMs: 1 },
        connectTimeoutMs: 5_000,
        defaultQueryTimeoutMs: 2_000,
        options: {}
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { sock, sent, getClient: () => client };
};

/** The server's readiness stanza: a `set` iq carrying `<pair-device>` refs. */
const emitPairDevice = (client) => {
    client.emit('CB:iq,type:set,pair-device', {
        tag: 'iq',
        attrs: { type: 'set', id: 'pair-device-1' },
        content: [{
            tag: 'pair-device',
            attrs: {},
            content: [{ tag: 'ref', attrs: {}, content: Buffer.from('ref-1') }]
        }]
    });
};

describe('pairing code platform', () => {
    it('normalizes a UWP browser label to a canonical display', () => {
        assert.deepEqual(getPairingCodePlatform(['Windows', 'UWP', '10.0.22631']), {
            id: '1',
            display: 'Chrome (Windows)'
        });
    });

    it('keeps a canonical browser name but normalizes an unknown OS', () => {
        assert.deepEqual(getPairingCodePlatform(['Plan9', 'Firefox', '1.0']), {
            id: '2',
            display: 'Firefox (Mac OS)'
        });
    });
});

describe('requestPairingCode', () => {
    it('waits for pair-device before sending link_code_companion_reg', async () => {
        const { sock, sent, getClient } = await makeSock();

        let resolved = false;
        const pending = sock.requestPairingCode('5511900000002').then((code) => {
            resolved = true;
            return code;
        });

        // Nothing may go on the wire before the server is ready.
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(resolved, false, 'request must not resolve before pair-device');
        assert.equal(
            sent.some((frame) => companionChild(frame, 'companion_platform_display')),
            false,
            'no link_code_companion_reg before pair-device'
        );

        emitPairDevice(getClient());
        const code = await pending;

        assert.match(code, /^[123456789ABCDEFGHJKLMNPQRSTVWXYZ]{8}$/);
        assert.equal(resolved, true);
    });

    it('sends a canonical companion_platform_display on the wire', async () => {
        const { sock, sent, getClient } = await makeSock();
        const pending = sock.requestPairingCode('5511900000002');
        emitPairDevice(getClient());
        await pending;

        const decoded = await Promise.all(
            sent.map((frame, index) => readFrameNode(frame, index === 0))
        );
        const node = decoded.find((entry) => companionChild(entry, 'companion_platform_display'));

        assert.ok(node, 'link_code_companion_reg must be sent');
        assert.equal(companionChild(node, 'companion_platform_display'), 'Chrome (Windows)');
        // The id is the canonical pairing id (not the UWP companion id, which
        // belongs to the QR/companion flow, not the link-code flow).
        assert.equal(companionChild(node, 'companion_platform_id'), '1');
        assert.equal(node.attrs.type, 'set');
        assert.equal(node.attrs.xmlns, 'md');
    });

    it('rejects a second concurrent request instead of sending two codes', async () => {
        const { sock, getClient } = await makeSock();
        const first = sock.requestPairingCode('5511900000002');
        await assert.rejects(
            () => sock.requestPairingCode('5511900000003'),
            /already in progress/
        );
        emitPairDevice(getClient());
        await first;
    });

    it('rejects the pending request when the connection closes first', async () => {
        const { sock, getClient } = await makeSock();
        const pending = sock.requestPairingCode('5511900000002');
        await new Promise((resolve) => setTimeout(resolve, 20));
        getClient().emit('close');

        await assert.rejects(() => pending, /pairing|Connection/i);
    });
});
