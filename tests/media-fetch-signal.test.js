/**
 * Testes do timeout no download de midia.
 *
 * Contexto (bug real): `downloadContentFromMessage` faz um fetch sem signal. Se
 * o servidor de midia aceita a conexao e NUNCA responde, a promise fica
 * pendurada para sempre -- o handler do bot nunca termina e o comando parece
 * "morto" (outros comandos seguem funcionando, porque o processo esta vivo).
 *
 * Dois pontos cobertos:
 *   1. `getHttpStream` repassa `options.signal` para o fetch (sem isso, um
 *      AbortController do chamador nao tem efeito nenhum);
 *   2. um AbortController abortado de fato interrompe o download pendurado.
 *
 * Run: node --test tests/media-fetch-signal.test.js
 */

import assert from 'node:assert/strict';
import crypto from 'crypto';
import net from 'node:net';
import { after, describe, it } from 'node:test';

import { downloadContentFromMessage, getHttpStream } from '../lib/index.js';
import { proto } from '../WAProto/index.js';

/** Servidores abertos, fechados no fim para o processo encerrar. */
const abertos = [];
after(() => {
  for (const s of abertos) {
    try {
      s.close();
    } catch {
      /* ja fechado */
    }
  }
});

/** Servidor que aceita a conexao e nunca responde (blackhole). */
async function subirBlackhole() {
  const servidor = net.createServer(() => {
    // aceita e fica em silencio: nenhum byte de resposta HTTP
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  abertos.push(servidor);
  return { servidor, porta: servidor.address().port };
}

/** Espera no maximo `ms` e devolve 'TIMEOUT' se nada acontecer. */
function comTimeout(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r('TIMEOUT'), ms))]);
}

describe('midia: o fetch honra o AbortSignal', () => {
  it('getHttpStream aborta quando o signal e disparado', async () => {
    const { servidor, porta } = await subirBlackhole();
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 500);

      const inicio = Date.now();
      const resultado = await comTimeout(
        getHttpStream(`http://127.0.0.1:${porta}/nunca-responde`, { signal: controller.signal })
          .then(() => 'resolveu')
          .catch((e) => `abortou: ${e.name}`),
        6000
      );
      const ms = Date.now() - inicio;

      assert.notEqual(resultado, 'TIMEOUT', 'nao pode pendurar: o signal precisa ter efeito');
      assert.ok(ms < 5000, `abortou rapido (levou ${ms}ms)`);
    } finally {
      servidor.close();
    }
  });

  it('downloadContentFromMessage aborta o download pendurado', async () => {
    const { servidor, porta } = await subirBlackhole();
    try {
      const media = proto.Message.ImageMessage.create({
        url: `http://127.0.0.1:${porta}/nunca-responde.enc`,
        mediaKey: crypto.randomBytes(32),
        mimetype: 'image/jpeg'
      });

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 500);

      const resultado = await comTimeout(
        downloadContentFromMessage(media, 'image', { options: { signal: controller.signal } })
          .then(() => 'resolveu')
          .catch((e) => `abortou: ${e.name}`),
        6000
      );

      assert.notEqual(resultado, 'TIMEOUT', 'o download nao pode ficar pendurado para sempre');
    } finally {
      servidor.close();
    }
  });

  it('regressao: sem signal, o download segue funcionando normalmente', async () => {
    // Servidor que responde de verdade. Os bytes sao invalidos, entao a
    // decifragem falha -- mas o que importa aqui e que o FETCH conclui (nao
    // pendura) sem signal, preservando o comportamento antigo.
    const http = await import('node:http');
    const servidor = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.alloc(64));
    });
    await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
    abertos.push(servidor);
    const porta = servidor.address().port;

    try {
      const media = proto.Message.ImageMessage.create({
        url: `http://127.0.0.1:${porta}/x.enc`,
        mediaKey: crypto.randomBytes(32),
        mimetype: 'image/jpeg'
      });

      const stream = await getHttpStream(`http://127.0.0.1:${porta}/x.enc`);
      assert.ok(stream, 'o fetch conclui sem signal');

      // Drena o stream para nao deixar atividade assincrona depois do teste.
      let resultado = 'sem-erro';
      try {
        const dl = await downloadContentFromMessage(media, 'image');
        for await (const _ of dl) {
          /* consome */
        }
      } catch {
        resultado = 'erro-controlado';
      }
      assert.equal(resultado, 'erro-controlado', 'a decifragem falha de forma controlada');
    } finally {
      servidor.close();
    }
  });
});