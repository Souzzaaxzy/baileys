/**
 * WhatsApp Flows / Native Flow — builders, validacao e parser.
 *
 * ## O que EXISTE no proto desta versao (verificado, nao suposto)
 *
 * Procurado em `WAProto/index.d.ts`:
 *
 * | nome citado em exemplos | existe aqui? |
 * |---|---|
 * | `InteractiveMessage.nativeFlowMessage` | **SIM** |
 * | `NativeFlowMessage.buttons[].{name,buttonParamsJson}` | **SIM** |
 * | `NativeFlowMessage.{messageParamsJson,messageVersion}` | **SIM** |
 * | `InteractiveResponseMessage.nativeFlowResponseMessage` | **SIM** |
 * | `ButtonsMessage.Button.nativeFlowInfo` | **SIM** |
 * | `flowMessage` | **NAO EXISTE** |
 * | `flowResponseMessage` | **NAO EXISTE** (o certo e' `nativeFlowResponseMessage`) |
 * | `flowId` (em mensagem de usuario) | **NAO EXISTE** — so' em `GalaxyFlowAction` (PeerDataOperation de ads/business) |
 *
 * Ou seja: **o formulario de Flow nao tem campo protobuf proprio.** Ele e' um
 * botao de Native Flow com `name: 'flow'` e um JSON de parametros — a mesma
 * estrutura de qualquer outro botao nativo. Este modulo NAO inventa proto: ele
 * monta o JSON e valida os campos.
 *
 * ## Os dois "flows" sao coisas DIFERENTES
 *
 * 1. **WhatsApp Flows (oficial, Meta)** — botao `name: 'flow'` apontando para um
 *    `flow_id` criado na WABA pela API de Flows da Meta. O formulario e' DESENHADO
 *    pelo cliente a partir do Flow JSON publicado na Meta.
 * 2. **Native Flow** — o envelope (`interactiveMessage.nativeFlowMessage`) com
 *    botoes `quick_reply` / `cta_url` / `cta_copy` / `cta_call` / `single_select`.
 *
 * Este modulo cobre os dois: monta o botao `flow` com os nomes de campo que a
 * Meta usa, e oferece um formulario nativo que o envelope comprovadamente
 * renderiza (`single_select`, que a biblioteca ja' suporta).
 *
 * ## LIMITE HONESTO (medido em terceiros, nao em aparelho aqui)
 *
 * Enviar `name: 'flow'` por uma lib nao-oficial e' **gateado pelo servidor**: o
 * destinatario recebe *"mensagem incompativel com sua versao do WhatsApp"* mesmo
 * com iOS/Android atualizados, enquanto o MESMO codigo com `quick_reply`/`cta_url`
 * funciona (relato reproduzido no `whatsmeow` #1144, testando 9 variacoes de
 * payload). O `flow_id` valido vem da Meta, e a exibicao depende dela.
 *
 * Por isso a API aqui **valida e avisa** em vez de prometer formulario: sem
 * `flow_id`, `buildFlowButton` lanca um erro explicito (`FLOW_ID_MISSING`), e a
 * bot pode cair no formulario nativo.
 */

/** Erro de validacao com um codigo estavel, para o chamador distinguir os casos. */
export class FlowValidationError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'FlowValidationError';
		this.code = code;
	}
}

/** Versao do protocolo de Flow que a Meta usa hoje (`flow_message_version`). */
export const FLOW_MESSAGE_VERSION = '3'

/** Acoes validas de `flow_action`. */
export const FLOW_ACTIONS = Object.freeze(['navigate', 'data_exchange'])

/** Modos validos de `mode`. */
export const FLOW_MODES = Object.freeze(['published', 'draft'])

/** Nome do botao que abre um Flow oficial da Meta. */
export const FLOW_BUTTON_NAME = 'flow'

const texto = (v) => (typeof v === 'string' ? v.trim() : '')

/**
 * Monta o objeto de parametros do botao `flow` (o que vai em `buttonParamsJson`).
 *
 * Os NOMES dos campos sao os da Meta (`flow_id`, `flow_token`, `flow_cta`,
 * `flow_action`, `flow_action_payload`, `flow_message_version`, `mode`),
 * confirmados na doc oficial "Send a Flow message" e em 2 integradores.
 *
 * @param {object} params
 * @param {string} params.flowId        ID do Flow na WABA (obrigatorio)
 * @param {string} [params.cta]         texto do botao (`flow_cta`)
 * @param {string} [params.token]       `flow_token` (identificador de sessao)
 * @param {string} [params.action]      `navigate` (padrao) ou `data_exchange`
 * @param {string} [params.screen]      tela inicial (`flow_action_payload.screen`)
 * @param {object} [params.data]        dados iniciais (`flow_action_payload.data`)
 * @param {string} [params.mode]        `published` (padrao) ou `draft`
 * @param {string} [params.version]     `flow_message_version` (padrao '3')
 * @returns {object} o objeto de parametros (ainda nao serializado)
 */
export const buildFlowParams = (params = {}) => {
	const flowId = texto(params.flowId ?? params.flow_id)
	if (!flowId) {
		throw new FlowValidationError(
			'FLOW_ID_MISSING',
			'Informe o flowId: o Flow precisa existir na WABA (criado pela API de Flows da Meta) para o cliente desenhar o formulario.'
		)
	}

	const action = texto(params.action ?? params.flow_action) || 'navigate'
	if (!FLOW_ACTIONS.includes(action)) {
		throw new FlowValidationError(
			'FLOW_ACTION_INVALID',
			`flow_action deve ser um de: ${FLOW_ACTIONS.join(', ')} (recebido: "${action}")`
		)
	}

	const mode = texto(params.mode) || 'published'
	if (!FLOW_MODES.includes(mode)) {
		throw new FlowValidationError(
			'FLOW_MODE_INVALID',
			`mode deve ser um de: ${FLOW_MODES.join(', ')} (recebido: "${mode}")`
		)
	}

	const cta = texto(params.cta ?? params.flow_cta) || 'Abrir formulário'
	const version = texto(params.version ?? params.flow_message_version) || FLOW_MESSAGE_VERSION

	// `flow_token` e' obrigatorio no payload da Meta; o default documentado e' 'unused'.
	const token = texto(params.token ?? params.flow_token) || 'unused'

	const saida = {
		flow_message_version: version,
		flow_token: token,
		flow_id: flowId,
		flow_cta: cta,
		flow_action: action,
		mode
	}

	// `flow_action_payload` vai quando ha tela OU dados iniciais (a Meta o exige
	// para `navigate`). Sem `screen`, o cliente usa a primeira tela do Flow.
	const screen = texto(params.screen ?? params.flow_action_payload?.screen)
	const data = params.data ?? params.flow_action_payload?.data
	if (screen || data) {
		saida.flow_action_payload = {}
		if (screen) {
			saida.flow_action_payload.screen = screen
		}
		if (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > 0) {
			saida.flow_action_payload.data = data
		}
	}

	return saida
}

/**
 * Monta um BOTAO de Native Flow pronto para `nativeFlow`.
 *
 * @param {object} params os mesmos de {@link buildFlowParams}
 * @returns {{name: string, buttonParamsJson: string}}
 */
export const buildFlowButton = (params = {}) => ({
	name: FLOW_BUTTON_NAME,
	buttonParamsJson: JSON.stringify(buildFlowParams(params))
})

/**
 * Le de volta os parametros de um `buttonParamsJson` (tolerante).
 *
 * @param {string} buttonParamsJson
 * @returns {object|null}
 */
export const parseFlowButtonParams = (buttonParamsJson) => {
	if (typeof buttonParamsJson !== 'string' || !buttonParamsJson.trim()) {
		return null
	}
	try {
		const parsed = JSON.parse(buttonParamsJson)
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
	} catch {
		return null
	}
}

/**
 * Este botao e' um Flow oficial da Meta?
 *
 * @param {{name?: string, buttonParamsJson?: string}} button
 */
export const isFlowButton = (button) => texto(button?.name) === FLOW_BUTTON_NAME

/**
 * Descreve um botao de Flow para log/diagnostico — SEM vazar o `flow_token`.
 *
 * O token identifica a sessao do usuario no Flow; nao e' segredo criptografico,
 * mas nao ha por que despeja-lo em log. So' o TAMANHO e' reportado.
 *
 * @param {{buttonParamsJson?: string}} button
 */
export const describeFlowButton = (button) => {
	const p = parseFlowButtonParams(button?.buttonParamsJson)
	if (!p) {
		return { flowId: null, cta: null, action: null, mode: null, screen: null, tokenLen: 0 }
	}
	return {
		flowId: p.flow_id ?? null,
		cta: p.flow_cta ?? null,
		action: p.flow_action ?? null,
		mode: p.mode ?? null,
		screen: p.flow_action_payload?.screen ?? null,
		tokenLen: typeof p.flow_token === 'string' ? p.flow_token.length : 0
	}
}

/**
 * Monta a RESPOSTA de um Native Flow (`interactiveResponseMessage`).
 *
 * E' o formato que a fork ja' envia via `flowReply`, exposto aqui para o
 * chamador nao repetir o shape e para haver um unico lugar de verdade.
 *
 * @param {{name?: string, paramsJson?: string, text?: string, format?: number, version?: number}} resposta
 * @returns {object} o conteudo pronto para `generateWAMessageContent`
 */
export const buildFlowReply = (resposta = {}) => {
	const name = texto(resposta.name)
	if (!name) {
		throw new FlowValidationError('FLOW_REPLY_NAME_MISSING', 'A resposta do Flow precisa do `name` do botao de origem.')
	}
	return {
		interactiveResponseMessage: {
			body: {
				format: typeof resposta.format === 'number' ? resposta.format : 0,
				text: texto(resposta.text) || 'Resposta enviada'
			},
			nativeFlowResponseMessage: {
				name,
				paramsJson: typeof resposta.paramsJson === 'string' && resposta.paramsJson.trim()
					? resposta.paramsJson
					: '{}',
				version: typeof resposta.version === 'number' ? resposta.version : 1
			}
		}
	}
}

/**
 * Extrai a resposta de um Native Flow de uma mensagem recebida.
 *
 * A resposta chega como `interactiveResponseMessage.nativeFlowResponseMessage`
 * dentro de `message` — o caminho que `getContentType` ja' entrega em
 * `messages.upsert`. Desembrulha os envelopes conhecidos (view-once, efemera,
 * editada) porque o cliente pode aninha-la.
 *
 * @param {object} message o `message` do evento (ou o conteudo ja' normalizado)
 * @returns {{name: string, paramsJson: string, params: object|null, text: string|null, version: number}|null}
 */
export const parseFlowResponse = (message) => {
	let atual = message
	// Mesmos invólucros que a fork desembrulha em `normalizeMessageContent`
	// (subconjunto: os que podem carregar uma resposta interativa).
	for (let i = 0; i < 5 && atual; i++) {
		const inner =
			atual.viewOnceMessage?.message ||
			atual.viewOnceMessageV2?.message ||
			atual.viewOnceMessageV2Extension?.message ||
			atual.ephemeralMessage?.message ||
			atual.documentWithCaptionMessage?.message ||
			atual.editedMessage?.message
		if (!inner) {
			break
		}
		atual = inner
	}

	const resp = atual?.interactiveResponseMessage
	const native = resp?.nativeFlowResponseMessage
	if (!native) {
		return null
	}

	const params = parseFlowButtonParams(native.paramsJson)
	return {
		name: native.name ?? null,
		paramsJson: native.paramsJson ?? '{}',
		params,
		text: resp?.body?.text ?? null,
		version: typeof native.version === 'number' ? native.version : 1
	}
}
