/**
 * ProtoAnalyzer — reads the decoded WebMessageInfo / MessageKey surface.
 *
 * WHAT IS ACTUALLY RELIABLE HERE
 * ------------------------------
 * The protocol fields the receive path fills in (`key.remoteJid`,
 * `key.participant`, `key.id`, `messageTimestamp`, `pushName`) are the ones the
 * transport itself guarantees. Everything else is *reported*, never scored:
 *
 *   - `key.participantAlt` / `key.addressingMode` — a LID-addressed message is
 *     ordinary traffic in 2026; it is recorded for the report and carries no
 *     weight (see EVIDENCE_CATALOG: STRUCTURAL_ANOMALY has weight 0).
 *   - `messageStubType` — a stub can mean "undecryptable for THIS device" for
 *     benign reasons (late join, key loss), so it is not evidence.
 *   - Unknown keys in the proto — a newer WhatsApp build will add fields, so an
 *     unknown key is a version difference, not a bot.
 *
 * The one thing this module does that can become evidence is detecting a
 * *contradiction* between what the stanza said and what the decoded message
 * says. A single contradiction is not actionable either; it only becomes
 * PROTOCOL_INCONSISTENCY evidence when the CorrelationEngine sees it repeat.
 */

import { proto } from '../../WAProto/index.js';

/** Fields we consider trustworthy enough to compare. */
const COMPARABLE = ['remoteJid', 'participant', 'addressingMode'];

/**
 * Extracts the protocol-visible facts of a message.
 *
 * @param {object} info WebMessageInfo (decoded)
 * @returns {object} plain descriptor, safe to store/log
 */
export const analyzeProto = (info) => {
    if (!info || typeof info !== 'object') {
        return { usable: false, reason: 'no_info' };
    }
    const key = info.key || {};
    const message = info.message || {};

    return {
        usable: true,
        key: {
            id: key.id || null,
            remoteJid: key.remoteJid || null,
            fromMe: Boolean(key.fromMe),
            participant: key.participant || null,
            participantAlt: key.participantAlt || null,
            addressingMode: key.addressingMode || null
        },
        messageTimestamp: Number(info.messageTimestamp) || null,
        pushName: typeof info.pushName === 'string' ? info.pushName : null,
        stubType: typeof info.messageStubType === 'number' ? info.messageStubType : null,
        hasMessage: Boolean(message && Object.keys(message).length),
        // Narrative-only structural notes. None of these is a bot signal.
        notes: structuralNotes(info)
    };
};

/**
 * Structural notes for the report. Every entry here is explicitly weighed 0 by
 * the catalog: they are things WhatsApp itself emits routinely.
 */
const structuralNotes = (info) => {
    const notes = [];
    const key = info.key || {};
    if (key.participantAlt) {
        notes.push({ code: 'participant_alt', detail: key.participantAlt, reliable: false });
    }
    if (key.addressingMode === 'lid') {
        notes.push({ code: 'lid_addressed', detail: null, reliable: false });
    }
    if (info.messageStubType !== undefined && info.messageStubType !== null) {
        notes.push({ code: 'stub', detail: info.messageStubType, reliable: false });
    }
    const ctxInfo = info.message?.messageContextInfo;
    if (ctxInfo?.deviceListMetadata) {
        // Presence of device list metadata is protocol bookkeeping, not identity.
        notes.push({ code: 'device_list_metadata', detail: null, reliable: false });
    }
    return notes;
};

/**
 * Compares what the STANZA carried (raw attributes from the receive path) with
 * what the DECODED message ended up with.
 *
 * @param {object} stanzaFacts extracted from the stanza at receive time
 * @param {object} protoFacts  result of analyzeProto()
 * @returns {Array<{field:string,stanza:any,message:any}>} empty when consistent
 */
export const findInconsistencies = (stanzaFacts, protoFacts) => {
    if (!stanzaFacts || !protoFacts?.usable) return [];
    const out = [];
    for (const field of COMPARABLE) {
        const a = stanzaFacts[field];
        const b = protoFacts.key?.[field];
        if (a == null || b == null) continue;
        if (String(a) !== String(b)) {
            out.push({ field, stanza: String(a), message: String(b) });
        }
    }
    // The stanza timestamp is seconds; the decoded one is seconds too. A
    // difference beyond a minute of clock skew is worth reporting (still not
    // actionable alone).
    const stanzaTs = Number(stanzaFacts.timestamp);
    const protoTs = Number(protoFacts.messageTimestamp);
    if (Number.isFinite(stanzaTs) && Number.isFinite(protoTs) && stanzaTs > 0 && protoTs > 0) {
        if (Math.abs(stanzaTs - protoTs) > 60) {
            out.push({ field: 'timestamp', stanza: stanzaTs, message: protoTs });
        }
    }
    return out;
};

/**
 * Whether the stub type means "not decryptable here" — used to *suppress*
 * analysis, never to accuse. An undecryptable message has no behaviour to
 * measure, so the analyzers must skip it.
 */
export const isUndecryptableStub = (info) => {
    try {
        return info?.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT;
    } catch {
        return false;
    }
};
