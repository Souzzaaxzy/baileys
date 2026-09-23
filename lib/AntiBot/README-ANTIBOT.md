# AntiBot — núcleo de detecção (fork Baileys)

Sistema de detecção de **comportamento automatizado não autorizado** por
correlação de evidências independentes e persistentes. O objetivo declarado é
preferir **falso negativo a falso positivo**.

> Este documento existe para que quem for mexer saiba **o que é confiável**, o
> que é hipótese, e por que. A regra do projeto é: nenhum sinal entra no score
> sem classificação explícita.

---

## 1. Arquitetura

```
                 ┌──────────────────────┐
   CB:message ──▶│  StanzaObserver      │──▶ EventCorrelationEngine
   CB:receipt    │  (passivo, aditivo)  │        │
   CB:presence   └──────────────────────┘        │
                                                 ▼
   WebMessageInfo ─▶ MessageAnalyzer ─▶ ParticipantState (bounded)
                          │                      │
                          ▼                      ▼
                    ProtoAnalyzer ──▶  BehaviorAnalyzer
                          │                      │
                          └──────┬───────────────┘
                                 ▼
                        FingerprintEngine
                                 ▼
                         EvidenceEngine  (dedup + cap por categoria)
                                 ▼
                        ConfidenceEngine (ÚNICO que diz CONFIRMED)
                                 ▼
                           RiskDecay  (half-life + persistência)
                                 ▼
                          AntiBotResult
```

| Arquivo | Responsabilidade |
|---|---|
| `AntiBotTypes.js` | status, categorias, **catálogo de pesos**, thresholds |
| `ParticipantState.js` | estado por participante, com teto de memória |
| `MessageAnalyzer.js` | `WebMessageInfo` → amostra **sem conteúdo** |
| `ProtoAnalyzer.js` | fatos do proto + contradições stanza↔mensagem |
| `BehaviorAnalyzer.js` | métricas temporais/estruturais (com guardas) |
| `FingerprintEngine.js` | fingerprint de comportamento por janela |
| `EvidenceEngine.js` | candidato → evidência ponderada |
| `EventCorrelationEngine.js` | junção stanza ↔ mensagem |
| `ConfidenceEngine.js` | bandas e a regra de confirmação |
| `RiskDecay.js` | decaimento e peso de persistência |
| `StanzaObserver.js` | listeners `CB:` passivos |
| `AntiBotEngine.js` | orquestração |

---

## 2. Classificação de confiabilidade dos sinais

Isto é o resultado da pesquisa; é o que impede o sistema de virar um detector de
"muita atividade".

### CONFIRMADO (usável)

| Sinal | Onde | Por quê |
|---|---|---|
| Regularidade dos intervalos (CV baixo) | `BehaviorAnalyzer` | mede pacing; humano é *bursty* (CV alto) mesmo escrevendo rápido |
| Similaridade de payload (digest) | `BehaviorAnalyzer` | humano varia o texto; automação repete a forma |
| Uniformidade de tamanho | `BehaviorAnalyzer` | idem, mais fraco |
| Sequência de tipos repetida | `BehaviorAnalyzer` | exige ≥2 tipos distintos (ver §4) |
| Contradição stanza ↔ mensagem | `ProtoAnalyzer` + correlação | só vira evidência **se repetir** |

### ÚTIL (secundário)

- Presença de payload em `viewOnce`/`ephemeral`: informativo, peso 0.
- `messageStubType = CIPHERTEXT`: **suprime análise** (não há comportamento a medir).

### FRACO / NÃO CONFIÁVEL (nunca pontua)

| Sinal | Decisão |
|---|---|
| `addressingMode: 'lid'`, `participantAlt` | peso **0** — tráfego normal em 2026 |
| PN vs LID | peso **0** |
| `messageStubType` qualquer | peso **0** |
| `category` da stanza | peso **0** |
| mensagem editada, mídia, sticker, áudio | peso **0** |
| ausência de presença | peso **0** |
| ausência de receipt | peso **0** |
| tipo de cliente / plataforma | **não observado** |
| reconexão / troca de dispositivo | **não observado** |

### DESCONHECIDO

Campos novos do proto (versões futuras do WhatsApp) aparecem como
`structural_anomaly` com peso **0**, apenas para o relatório. Um campo
desconhecido é diferença de versão, não bot.

---

## 3. Pesos (fonte única: `EVIDENCE_CATALOG`)

| Evidência | Categoria | Nível | Peso |
|---|---|---|---|
| `regular_intervals` | behavior | STRONG | 6 |
| `payload_similarity` | behavior | MEDIUM | 4 |
| `repeating_sequence` | behavior | MEDIUM | 4 |
| `uniform_length` | behavior | WEAK | 2 |
| `persistent_behavior` | persistence | MEDIUM | 5 (tier) |
| `persistent_risk` | persistence | STRONG | 9–12 (tier) |
| `protocol_inconsistency` | protocol | MEDIUM | 4 |
| `structural_anomaly` | stanza | WEAK | **0** |

Regras aplicadas pelo `EvidenceEngine`:

1. **Dedup por tipo** — repetir um candidato não multiplica o peso.
2. **Cap por categoria (`12`)** — empilhar sinais fracos nunca alcança a banda
   de confirmação.
3. **Peso vem do catálogo** — o chamador não escolhe o próprio peso.

Bandas padrão: `observing 10 · suspicious 20 · highRisk 38 · confirmed 65`.

---

## 4. Os três guardas contra falso positivo

Esta seção é o coração do projeto. Cada guarda existe porque um teste a exigiu.

### 4.1 Cap por categoria ⇒ comportamento sozinho não confirma

O comportamento tem teto de **12**. A menor banda é `observing` (10) e
`suspicious` é 20 — ou seja, **uma janela puramente comportamental nunca passa
de OBSERVING**. O `ConfidenceEngine` ainda exige ≥3 categorias distintas e ao
menos uma **não-comportamental**. Comportamento sozinho, por mais sustentado que
seja, **não confirma**. (Teste: *behaviour ALONE can never confirm*.)

### 4.2 Janelas são TEMPO, não mensagens

Gravar uma janela por mensagem fazia um burst de 40 mensagens parecer 40 janelas
de persistência — inflando exatamente a evidência que deveria provar
sustentação. Hoje: uma janela por `windowMs`, fechada **no fim**, com o score
que ela terminou. (Testes: *persistence appears after a full window*.)

### 4.3 Tempo de CHEGADA, não `messageTimestamp`

`messageTimestamp` tem resolução de **1 segundo**. Um bot mandando 10 msg/s
produz timestamps idênticos e o pacing fica invisível. A medição honesta é
quando **este dispositivo recebeu** — `now()`. O `msgTs` declarado continua no
relatório.

Complementos: `repeating_sequence` exige **≥2 tipos distintos** (senão todo
humano que só manda texto "repete com período 1"); o digest **não** colapsa
dígitos (senão "msg 1", "msg 2" viram o mesmo payload).

---

## 5. Regra de confirmação (`ConfidenceEngine`)

`CONFIRMED` exige **todas**:

1. score ≥ `confirmed`;
2. ≥ `minCategoriesForConfirm` (3) categorias **distintas**;
3. ≥1 categoria **não-comportamental** (protocol/stanza/persistence);
4. ≥ `minWindowsForConfirm` (2) janelas anteriores já em risco.

Falhando qualquer uma, **rebaixa** para HIGH_RISK e registra o motivo
(`confirm_denied_*`). Ambiguidade ⇒ banda menor.

## 6. Decay e persistência

Evidência é **recomputada** por janela (não acumulada), então um sinal que
parou de ocorrer desaparece. O score carregado sofre decaimento exponencial
(`decayHalfLifeMs`, padrão 10 min) e o peso de persistência cresce em tiers
(5 / 9 / 12) conforme janelas anteriores em risco. Quem volta ao normal volta a
NORMAL.

## 7. Memória

- `maxSamples` (60) por participante;
- `maxParticipants` (512) por chat, com despejo LRU;
- `prune(ttl)` remove quem ficou quieto;
- correlação tem `pendingTtl` e teto próprio.

## 8. Uso

```js
import { createAntiBotEngine, ANTI_BOT_MODE } from '@souzzaaxzy/baileys';

const antibot = createAntiBotEngine({ mode: ANTI_BOT_MODE.OBSERVE }, { logger });
antibot.attach(sock);            // observador passivo de stanzas

sock.ev.on('messages.upsert', ({ messages }) => {
  for (const m of messages) {
    const result = antibot.ingest(m);
    if (result?.actionAllowed) { /* o BOT decide o que fazer */ }
  }
});
```

Modos: `log` (só registra) · `observe` · `quarantine` · `active` (único que
permite ação, e só com `actionAllowed === true`).

O núcleo **não** remove ninguém, não envia nada e não altera a conexão.

## 9. Limitações honestas

- É **heurística**: precisa de janelas para julgar; participante novo não é
  julgado (`minSamplesForAnalysis`).
- Um atacante que varie texto e intervalos aleatoriamente **não** é detectado —
  e isso é aceitável pelo requisito de precisão.
- A correlação stanza↔mensagem é **um nível de profundidade** (chave chat+autor,
  não id de mensagem): cobre o caso real sem crescer memória.
- O limiar é calibrável por grupo; os padrões foram ajustados no corpus de teste,
  não em campo.

## 10. Testes

`node --test tests/antibot.test.js` — 17 testes: humanos (normal, muito ativo,
repetitivo, mídia, LID) nunca confirmam; bot escala; comportamento sozinho não
confirma; persistência exige janela; sinais explicitamente não-usáveis valem 0;
memória limitada; entrada inválida não lança.
