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
| `burst_density` | behavior | STRONG | 18 |
| `regular_intervals` | behavior | STRONG | 18 |
| `payload_similarity` | behavior | MEDIUM | 10 |
| `repeating_sequence` | behavior | MEDIUM | 8 |
| `uniform_length` | behavior | WEAK | 4 |
| `persistent_behavior` | persistence | MEDIUM | 14 (tier) |
| `persistent_risk` | persistence | STRONG | 22–40 (tier) |
| `protocol_inconsistency` | protocol | MEDIUM | 25 |
| `structural_anomaly` | stanza | WEAK | **0** |

Regras aplicadas pelo `EvidenceEngine`:

1. **Dedup por tipo** — repetir um candidato não multiplica o peso.
2. **Cap por categoria (`34`)** — o teto fica **acima** de `suspicious` (30) e
   **abaixo** de `highRisk` (50): comportamento sozinho pode ser genuinamente
   suspeito, mas **nunca** actionable.
3. **Peso vem do catálogo** — o chamador não escolhe o próprio peso.

Bandas padrão: `observing 15 · suspicious 30 · highRisk 50 · confirmed 65`.

### A curva medida (o que esperar)

Medições reais, gap constante de 1s, payload idêntico, janela de 60s:

| janelas | msgs | score | banda | age? |
|---|---|---|---|---|
| 1 | 40 | 32 | SUSPICIOUS | não |
| 2 | 80 | 46 | SUSPICIOUS | não |
| 3 | 120 | 54 | HIGH_RISK | não |
| 5 | 150 | 72 | **CONFIRMED** | **sim** |

Ou seja: **~4 windows de ritmo de máquina sustentado** (≈4 minutos no padrão)
para confirmar. Uma janela isolada nunca age — por mais intensa que seja (120
msgs a 250ms numa janela dão 32, SUSPICIOUS).

Contraprova, o que **não** sobe: uso esparso (comandos a cada 30s) = **NORMAL 0**;
humano *bursty* com gaps irregulares de 300ms a 15s = **NORMAL 0**.

---

## 4. Os três guardas contra falso positivo

Esta seção é o coração do projeto. Cada guarda existe porque um teste a exigiu.

### 4.1 Cap por categoria ⇒ comportamento sozinho não é actionable

O comportamento tem teto de **34**: acima de `suspicious` (30), abaixo de
`highRisk` (50). Ou seja, **uma janela puramente comportamental nunca é
actionable**, por mais intensa que seja. O `ConfidenceEngine` ainda exige ≥2
categorias distintas e ao menos uma **não-comportamental** (persistência ou
protocolo). Uma janela só de comportamento, portanto, para em SUSPICIOUS.

### 4.2 Janela é TEMPO, não mensagem

Gravar uma janela por mensagem fazia um burst de 40 mensagens parecer 40 janelas
de persistência — inflando exatamente a evidência que deveria provar
sustentação. Hoje: uma janela por `windowMs`, fechada **no fim**, com o score que
ela terminou. (Testes: *persistence appears after a full window*.)

### 4.3 Tempo de CHEGADA, não `messageTimestamp`

`messageTimestamp` tem resolução de **1 segundo**. Um bot mandando 10 msg/s
produz timestamps idênticos e o pacing fica invisível. A medição honesta é
quando **este dispositivo recebeu** — `now()`. O `msgTs` declarado continua no
relatório.

### 4.4 Rajada x pacing — dois casos, duas evidências

Um furo encontrado na prática: uma rajada **instantânea** (30 mensagens no mesmo
milissegundo) fazia o analisador de intervalos ver **média 0 e variância 0** — e
o resultado ficava mais baixo (NORMAL 14) do que um ritmo de 1s, que é *menos*
artificial. O guard de variância baixa não podia distinguir "pacing de máquina"
de "ausência de pacing".

Hoje os dois casos têm evidência própria:

| caso | evidência | por quê |
|---|---|---|
| gaps constantes (1s, 400ms…) | `regular_intervals` | há pacing |
| tudo no mesmo instante | `burst_density` | **não** há pacing; é densidade |

`regular_intervals` exige média ≥ 20ms (`BURST_TOLERANCE_MS`) — abaixo disso não
é pacing, é rajada. `burst_density` conta a maior quantidade de mensagens dentro
de uma janela deslizante de 2s; acima de 8 é fisicamente impossível digitar
(4 msg/s sustentados, com payloads distintos).

Complementos: `repeating_sequence` exige **≥2 tipos distintos** (senão todo
humano que só manda texto "repete com período 1"); o digest **não** colapsa
dígitos (senão "msg 1", "msg 2" viram o mesmo payload).

---

## 4b. Calibração — como os números foram escolhidos

Os pesos e as bandas **não foram arbitrados**: foram calculados para que a curva
de detecção tivesse as propriedades que o requisito pede. O raciocínio:

1. Comportamento tem 3 evidências fortes (18 + 10 + 4 = 32) → teto **34**.
2. `suspicious` precisa ficar **abaixo** de 34, senão nem a janela mais
   escancaradamente artificial seria reportada. → **30**.
3. `highRisk` precisa ficar **acima** de 34, senão comportamento sozinho seria
   actionable. → **50**.
4. Persistência (tier n≥4 = 40) + comportamento (32) = 72 → acima de
   `confirmed` (65). Assim **ritmo sustentado confirma**, e nada menos confirma.
5. `protocol_inconsistency` = 25: duas categorias reais exigidas antes de virar
   evidência fazem dela um sinal forte mas não suficiente sozinho.

O primeiro conjunto de números (cap 12, bandas 20/40/60/80) falhava por
**construção**: o teto comportamental era metade da banda de confirmação, então
o sistema nunca confirmava nada — exatamente o "não detectou nada" relatado.

---

## 5. Regra de confirmação (`ConfidenceEngine`)

`CONFIRMED` exige **todas**:

1. score ≥ `confirmed` (65);
2. ≥ `minCategoriesForConfirm` (**2**) categorias **distintas**;
3. ≥1 categoria **não-comportamental** (persistence/protocol/stanza);
4. ≥ `minWindowsForConfirm` (2) janelas anteriores já em risco.

Eram 3 categorias na primeira versão — e isso tornava a confirmação
**inalcançável**: com o cap por categoria não há como reunir três classes
independentes a partir de observação passiva, então o sistema nunca confirmava
nada. Duas classes independentes já cumprem o requisito de "múltiplos sinais
independentes".

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

- `node --test tests/antibot.test.js` — **18 testes**: humanos (normal, muito
  ativo, repetitivo, mídia, LID) nunca confirmam; bot escala; **uma** janela de
  comportamento nunca confirma; ritmo sustentado por janelas confirma;
  persistência exige janela; sinais não-usáveis valem 0; memória limitada;
  entrada inválida não lança.
- `node --test tests/antibot-monitoring.test.js` — **9 testes**: o contrato do
  **painel**. `analyzed` conta quem falou; e — a correção que nasceu do relato —
  em `log`/`observe` o painel mostra a **banda RAW da análise**, não a efetiva.
  Antes ele contava a efetiva, e como `observe` rebaixa todos a NORMAL, o painel
  aparecia **zerado** justamente no modo em que se quer ver evidência.

Suíte completa da fork: **231 testes, 0 falhas**.
