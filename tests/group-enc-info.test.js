/**
 * `groupEncInfo` — os sinais de TRANSPORTE derivados dos nós `<enc>` da stanza.
 *
 * É a base da assinatura do "raja" consumida pelo anti do bot: uma stanza de
 * GRUPO que traz `enc` SOMENTE pareado (`msg`/`pkmsg`), SEM `skmsg` (a Sender
 * Key normal) e SEM `count` (o retry do receptor carrega `count`).
 *
 * Run: node tests/group-enc-info.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decryptMessageNode } from '../lib/Utils/decode-wa-message.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOGLEVEL ?? 'silent' });
const GROUP = '120363000000000001@g.us';
const DM = '5511900000009@s.whatsapp.net';
const ME = '5511900000001@s.whatsapp.net';
const ME_LID = '100000000000001@lid';
const AUTHOR = '100000000000050@lid';

const makeStanza = ({ from, encs, id = 'STANZA-1' }) => ({
  tag: 'message',
  attrs: { id, from, participant: from === GROUP ? AUTHOR : undefined, t: String(Math.floor(Date.now() / 1000)), type: 'text' },
  content: encs.map((e) => ({ tag: 'enc', attrs: e.attrs, content: e.content ?? new Uint8Array([1, 2, 3]) }))
});

const repoQueFalha = {
  decryptGroupMessage: async () => { throw new Error('no session'); },
  decryptMessage: async () => { throw new Error('no session'); },
  processSenderKeyDistributionMessage: async () => {},
  lidMapping: { getPNForLID: async () => null, getLIDForPN: async () => null, storeLIDPNMappings: async () => {} },
  migrateSession: async () => {},
  jidToSignalProtocolAddress: (jid) => jid
};

const run = async (stanza) => {
  const node = decryptMessageNode(stanza, ME, ME_LID, repoQueFalha, logger);
  await node.decrypt();
  return node.fullMessage;
};

describe('groupEncInfo', () => {
  it('pairwiseOnly: grupo com enc SOMENTE msg/pkmsg, sem skmsg e sem count', async () => {
    const fm = await run(makeStanza({ from: GROUP, encs: [{ attrs: { v: '2', type: 'msg' } }, { attrs: { v: '2', type: 'pkmsg' } }] }));
    assert.ok(fm.groupEncInfo, 'groupEncInfo presente');
    assert.equal(fm.groupEncInfo.hasPairwise, true);
    assert.equal(fm.groupEncInfo.hasSkmsg, false);
    assert.equal(fm.groupEncInfo.hasCount, false);
    assert.equal(fm.groupEncInfo.pairwiseOnly, true);
    assert.equal(fm.groupEncInfo.encs.length, 2);
  });

  it('NÃO é pairwiseOnly quando tem skmsg (grupo normal)', async () => {
    const fm = await run(makeStanza({ from: GROUP, encs: [{ attrs: { v: '2', type: 'skmsg' } }] }));
    assert.equal(fm.groupEncInfo.hasSkmsg, true);
    assert.equal(fm.groupEncInfo.pairwiseOnly, false);
  });

  it('NÃO é pairwiseOnly quando tem count (retry do receptor)', async () => {
    const fm = await run(makeStanza({ from: GROUP, encs: [{ attrs: { v: '2', type: 'msg', count: '1' } }] }));
    assert.equal(fm.groupEncInfo.hasCount, true);
    assert.equal(fm.groupEncInfo.pairwiseOnly, false);
  });

  it('NÃO preenche groupEncInfo fora de grupo (1:1)', async () => {
    const fm = await run(makeStanza({ from: DM, encs: [{ attrs: { v: '2', type: 'msg' } }] }));
    assert.equal(fm.groupEncInfo, undefined);
  });

  it('NÃO preenche sem nó enc', async () => {
    const fm = await run(makeStanza({ from: GROUP, encs: [] }));
    assert.equal(fm.groupEncInfo, undefined);
  });
});
