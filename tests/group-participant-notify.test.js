/**
 * O NOME do participante (`notify`) no metadata de grupo/comunidade.
 *
 * ## O defeito que isto trava
 *
 * A lib mapeava `id`, `phoneNumber`, `lid`, `username` e `admin` — e
 * **descartava o `notify`**, que é o **nome que o WhatsApp mostra**. O campo vem
 * no fio em todo `<participant notify="...">` e era jogado fora, então quem
 * consumia o metadata só tinha JID/LID e número.
 *
 * Era por isso que uma lista de admins montada do metadata não tinha nome: o
 * bot tinha que usar `getUserName()` (que só tira o `@`) e cair no número.
 *
 * Run: node --test tests/group-participant-notify.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { mapParticipantAttrs } from '../lib/Utils/group-participant.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));

describe('mapParticipantAttrs', () => {
    it('traz o `notify` (o nome que o WhatsApp mostra)', () => {
        const p = mapParticipantAttrs({ jid: '5511999999999@s.whatsapp.net', notify: 'Fulano da Silva', type: 'admin' });
        assert.equal(p.notify, 'Fulano da Silva');
        assert.equal(p.admin, 'admin');
        assert.equal(p.id, '5511999999999@s.whatsapp.net');
    });

    it('traz o `name` (contato salvo na agenda) quando vem', () => {
        const p = mapParticipantAttrs({ jid: '5511999999999@s.whatsapp.net', notify: 'Push', name: 'Da Agenda' });
        assert.equal(p.name, 'Da Agenda');
        assert.equal(p.notify, 'Push');
    });

    it('sem `notify`/`name` os campos ficam undefined (nunca string vazia)', () => {
        const p = mapParticipantAttrs({ jid: '5511999999999@s.whatsapp.net' });
        assert.equal(p.notify, undefined);
        assert.equal(p.name, undefined);
        assert.equal(p.admin, null, 'sem `type` nao e admin');
    });

    it('`notify` vazio nao vira string vazia', () => {
        assert.equal(mapParticipantAttrs({ jid: 'x@s.whatsapp.net', notify: '' }).notify, undefined);
    });

    it('mantem as regras de PN/LID (nao regride o que ja existia)', () => {
        const lid = mapParticipantAttrs({ jid: '111@lid', phone_number: '5511999999999@s.whatsapp.net' });
        assert.equal(lid.phoneNumber, '5511999999999@s.whatsapp.net', 'LID + phone_number -> phoneNumber');

        const pn = mapParticipantAttrs({ jid: '5511999999999@s.whatsapp.net', lid: '111@lid' });
        assert.equal(pn.lid, '111@lid', 'PN + lid -> lid');

        const semCruzamento = mapParticipantAttrs({ jid: '5511999999999@s.whatsapp.net', phone_number: '5511888888888@s.whatsapp.net' });
        assert.equal(semCruzamento.phoneNumber, undefined, 'PN com phone_number nao vira phoneNumber');
    });

    it('o criador (`superadmin`) e os admins sao distinguidos pelo `type`', () => {
        assert.equal(mapParticipantAttrs({ jid: 'a@s.whatsapp.net', type: 'superadmin' }).admin, 'superadmin');
        assert.equal(mapParticipantAttrs({ jid: 'b@s.whatsapp.net', type: 'admin' }).admin, 'admin');
        assert.equal(mapParticipantAttrs({ jid: 'c@s.whatsapp.net' }).admin, null);
    });

    it('nao lanca com attrs ausente/null', () => {
        assert.doesNotThrow(() => mapParticipantAttrs());
        assert.doesNotThrow(() => mapParticipantAttrs(null));
        assert.equal(mapParticipantAttrs().id, undefined);
        assert.equal(mapParticipantAttrs().admin, null);
    });

    it('o `username` do participante continua vindo', () => {
        assert.equal(mapParticipantAttrs({ jid: 'x@s.whatsapp.net', participant_username: '@beltrano' }).username, '@beltrano');
    });
});

describe('os TRES pontos de parse usam o mapeamento', () => {
    // Guard estrutural: se alguem voltar a montar o objeto na mao num deles, o
    // campo esquecido volta a divergir — foi assim que o `notify` se perdeu.
    const arquivos = [
        '../lib/Socket/groups.js',
        '../lib/Socket/communities.js',
        '../lib/Socket/messages-recv.js'
    ];

    for (const arquivo of arquivos) {
        it(`${path.basename(arquivo)} delega ao mapParticipantAttrs`, () => {
            const src = fs.readFileSync(path.join(AQUI, arquivo), 'utf8');
            assert.match(src, /mapParticipantAttrs\(attrs\)/, 'usa o mapeador');
            assert.doesNotMatch(src, /admin: \(attrs\.type \|\| null\)/, 'nao tem copia local');
        });
    }

    it('o mapeador e exportado publicamente (quem consome o metadata pode usar)', async () => {
        const raiz = await import('../lib/Utils/index.js');
        assert.equal(typeof raiz.mapParticipantAttrs, 'function');
    });
});
