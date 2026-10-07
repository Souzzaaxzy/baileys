/**
 * Credenciais ICE do relay (SDP da call).
 *
 * O `buildRemoteRelayAnswer` monta o SDP "answer" a partir do offer do wrtc.
 * As credenciais ICE (ufrag/pwd) têm de caber no limite do ICE: ufrag 4..256.
 * O `<token>` do relay tem ~260 chars e NÃO serve como ufrag — usá-lo fazia o
 * wrtc recusar o SDP inteiro:
 *
 *   InvalidAccessError: Failed to set remote answer sdp:
 *   Failed to apply the description for m= section:
 *   Invalid ICE parameters: ICE ufrag must be between 4 and 256 characters long
 *
 * Era o "conectando..." eterno: os três endpoints falhavam, nenhum transporte
 * abria e a mídia nunca fluía.
 *
 * Run: node --test tests/relay-ice-credentials.test.js
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
let wrtc = null;
try {
  wrtc = require('@roamhq/wrtc');
} catch {
  wrtc = null;
}

// Valores REAIS medidos no log do dono:
//   [RELAY] endpoint_selecionado - ... token=260 authToken=0 key=24
const TOKEN = 'T'.repeat(260);
const AUTH_OK = 'A'.repeat(96);
const KEY_OK = 'K'.repeat(24);

/** Aplica credenciais no SDP do offer, igual ao buildRemoteRelayAnswer. */
function aplicar(sdp, ufrag, pwd) {
  return sdp
    .replace(/a=ice-ufrag:[^\r\n]+/g, `a=ice-ufrag:${ufrag}`)
    .replace(/a=ice-pwd:[^\r\n]+/g, `a=ice-pwd:${pwd}`)
    .replace(/a=setup:actpass/g, 'a=setup:passive');
}

describe('relay — credenciais ICE do SDP', () => {
  it('o token de 260 NÃO serve como ufrag (reproduz o erro medido)', { skip: !wrtc }, async () => {
    const pc = new wrtc.RTCPeerConnection();
    pc.createDataChannel('pre-negotiated', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await assert.rejects(
      () => pc.setRemoteDescription({ type: 'answer', sdp: aplicar(offer.sdp ?? '', TOKEN, KEY_OK) }),
      /ICE ufrag|Failed to apply the description/i,
      'o ufrag de 260 é recusado pelo ICE'
    );
    pc.close();
  });

  it('o auth_token (96) é aceito como ufrag', { skip: !wrtc }, async () => {
    const pc = new wrtc.RTCPeerConnection();
    pc.createDataChannel('pre-negotiated', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await pc.setRemoteDescription({ type: 'answer', sdp: aplicar(offer.sdp ?? '', AUTH_OK, KEY_OK) });
    pc.close();
  });
});
