/**
 * Testes do cache de contatos + resolução de nome (`contact-store`).
 *
 * Motivo: a Baileys emite `contacts.upsert` / `contacts.update`, mas não guarda
 * nada — então não havia como perguntar o nome de um contato, e comandos que
 * nomeiam pessoas caíam no número/LID. Este módulo é a fonte do nome.
 *
 * Run: node --test tests/contact-store.test.js
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { makeContactStore } from '../lib/Store/contact-store.js';

const PN = '55110060999999@s.whatsapp.net';
const LID = '5551000060000@lid';

function storeComEventos(opts = {}) {
    const ev = new EventEmitter();
    return { ev, store: makeContactStore({ ev, ...opts }) };
}

describe('contact store', () => {
    it('guarda `name` e resolve pelo JID', () => {
        const { store } = storeComEventos();
        store.upsert({ id: PN, name: 'Fulano de Tal' });
        assert.equal(store.getName(PN), 'Fulano de Tal');
        assert.equal(store.getName('55110060999999'), 'Fulano de Tal', 'aceita o número cru');
    });

    it('prefere `name` a `notify`/`verifiedName`/`username`', () => {
        const { store } = storeComEventos();
        store.upsert({ id: PN, name: 'Da Agenda', notify: 'PushName', verifiedName: 'Empresa', username: '@handle' });
        assert.equal(store.getName(PN), 'Da Agenda');
    });

    it('cai no `notify` quando não há `name`', () => {
        const { store } = storeComEventos();
        store.upsert({ id: PN, notify: 'PushName' });
        assert.equal(store.getName(PN), 'PushName');
    });

    it('cai no `verifiedName` e depois no `username`', () => {
        const { store } = storeComEventos();
        store.upsert({ id: PN, verifiedName: 'Loja Verificada' });
        assert.equal(store.getName(PN), 'Loja Verificada');
        store.upsert({ id: LID, username: '@beltrano' });
        assert.equal(store.getName(LID), '@beltrano');
    });

    it('JID com device (:14) resolve no mesmo contato', () => {
        const { store } = storeComEventos();
        store.upsert({ id: PN, name: 'Fulano' });
        assert.equal(store.getName('55110060999999:14@s.whatsapp.net'), 'Fulano');
    });

    it('LID e PN apontam para o MESMO nome (par lid+phoneNumber)', () => {
        const { store } = storeComEventos();
        store.upsert({ id: PN, name: 'Fulano', lid: LID, phoneNumber: PN });
        assert.equal(store.getName(LID), 'Fulano', 'acha pelo LID');
        assert.equal(store.getName(PN), 'Fulano', 'acha pelo PN');
    });

    it('um `update` parcial (ex.: foto) NÃO apaga o nome já conhecido', () => {
        const { store } = storeComEventos();
        store.upsert({ id: PN, name: 'Fulano' });
        store.upsert({ id: PN, imgUrl: 'changed' }); // update de foto
        assert.equal(store.getName(PN), 'Fulano', 'nome sobreviveu');
    });

    it('renomear (novo `name`) sobrescreve', () => {
        const { store } = storeComEventos();
        store.upsert({ id: PN, name: 'Nome Antigo' });
        store.upsert({ id: PN, name: 'Nome Novo' });
        assert.equal(store.getName(PN), 'Nome Novo');
    });

    it('nome genérico/número/JID cru NÃO conta como nome', () => {
        const { store } = storeComEventos();
        store.upsert({ id: PN, name: 'Usuário' });
        assert.equal(store.getName(PN), undefined, 'genérico é descartado');
        store.upsert({ id: PN, name: '55110060999999' });
        assert.equal(store.getName(PN), undefined, 'número é descartado');
        store.upsert({ id: PN, name: PN });
        assert.equal(store.getName(PN), undefined, 'JID é descartado');
    });

    it('contato desconhecido -> undefined (o chamador decide o fallback)', () => {
        const { store } = storeComEventos();
        assert.equal(store.getName('5599@lid'), undefined);
        assert.equal(store.getName(''), undefined);
        assert.equal(store.getName(undefined), undefined);
    });

    it('assina contacts.upsert e contacts.update do emitter', () => {
        const { ev, store } = storeComEventos();
        ev.emit('contacts.upsert', [{ id: PN, name: 'Via Upsert' }]);
        assert.equal(store.getName(PN), 'Via Upsert');
        ev.emit('contacts.update', [{ id: LID, notify: 'Via Update' }]);
        assert.equal(store.getName(LID), 'Via Update');
    });

    it('getContact devolve o registro completo; getAll lista tudo', () => {
        const { store } = storeComEventos();
        store.upsert({ id: PN, name: 'Fulano', lid: LID, phoneNumber: PN });
        const c = store.getContact(PN);
        assert.equal(c.name, 'Fulano');
        assert.equal(c.lid, LID);
        assert.equal(store.getAll().length, 1, 'um contato (apesar dos apelidos)');
    });

    it('remove apaga contato e apelidos', () => {
        const { store } = storeComEventos();
        store.upsert({ id: PN, name: 'Fulano', lid: LID });
        store.remove(PN);
        assert.equal(store.getName(PN), undefined);
        assert.equal(store.getName(LID), undefined, 'apelido LID também sumiu');
    });

    it('TTL expira o registro (relógio injetável)', () => {
        let agora = 1000;
        const ev = new EventEmitter();
        const store = makeContactStore({ ev, ttlMs: 100, now: () => agora });
        store.upsert({ id: PN, name: 'Efêmero' });
        assert.equal(store.getName(PN), 'Efêmero');
        agora = 1200; // passou do TTL
        assert.equal(store.getName(PN), undefined, 'expirou');
    });

    it('teto de registros: derruba os mais antigos', () => {
        const { store } = storeComEventos({ max: 2 });
        const ids = ['1@lid', '2@lid', '3@lid'];
        for (const id of ids) {
            store.upsert({ id, name: `N${id[0]}` });
        }
        assert.ok(store._size() <= 2, 'não passou do teto');
        assert.equal(store.getName('3@lid'), 'N3', 'o mais novo ficou');
        assert.equal(store.getName('1@lid'), undefined, 'o mais antigo saiu');
    });
});
