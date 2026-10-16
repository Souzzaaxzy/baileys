/**
 * WhatsApp Flows / Native Flow — builders, validacao e resposta.
 *
 * ## O que este teste trava
 *
 * 1. **O que EXISTE no proto** (verificado, nao suposto): `nativeFlowMessage`,
 *    `NativeFlowButton`, `nativeFlowResponseMessage`. E o que **NAO existe**:
 *    `flowMessage`, `flowResponseMessage`, `flowId` em mensagem de usuario —
 *    o teste falha se alguem "inventar" esses campos.
 * 2. **O botao de Flow** monta o JSON com os nomes de campo da Meta
 *    (`flow_id`, `flow_token`, `flow_cta`, `flow_action`, `flow_action_payload`,
 *    `flow_message_version`, `mode`) e o `name: 'flow'`.
 * 3. **Validacao**: sem `flowId` -> `FLOW_ID_MISSING`; `flow_action`/`mode`
 *    invalidos -> erro com codigo estavel (nao um botao quebrado).
 * 4. **Caminho REAL da fork**: o `nativeFlow: [{ flowId }]` atravessa o
 *    `generateWAMessageContent`, vira `interactiveMessage.nativeFlowMessage` e
 *    sobrevive ao `encode`/`decode` do proto.
 * 5. **Resposta**: `buildFlowReply` monta o `interactiveResponseMessage` e o
 *    `parseFlowResponse` le de volta (inclusive com invólucro).
 * 6. **Nao vaza o `flow_token`** no diagnostico (so' o tamanho).
 * 7. **Regressao**: `quick_reply`/`cta_url`/`single_select` continuam iguais.
 *
 * Run: node tests/flow-message.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { proto } from '../WAProto/index.js';
import {
	FLOW_ACTIONS,
	FLOW_BUTTON_NAME,
	FLOW_MESSAGE_VERSION,
	FLOW_MODES,
	FlowValidationError,
	buildFlowButton,
	buildFlowParams,
	buildFlowReply,
	describeFlowButton,
	isFlowButton,
	parseFlowButtonParams,
	parseFlowResponse
} from '../lib/Utils/flow-message.js';
import { generateWAMessageContent, getContentType } from '../lib/Utils/messages.js';

const fakeUpload = async () => ({ url: 'https://mmg.whatsapp.net/fake', directPath: '/v/fake' })
const jid = '5511999999999@s.whatsapp.net'

describe('proto: o que existe (e o que NAO existe)', () => {
	it('existe NativeFlowMessage com buttons/messageParamsJson/messageVersion', () => {
		const NFM = proto.Message.InteractiveMessage.NativeFlowMessage
		assert.ok(NFM, 'NativeFlowMessage existe')
		const m = NFM.fromObject({
			buttons: [{ name: 'flow', buttonParamsJson: '{"flow_id":"1"}' }],
			messageParamsJson: '{}',
			messageVersion: 3
		})
		assert.equal(m.buttons.length, 1)
		assert.equal(m.buttons[0].name, 'flow')
		assert.equal(m.messageVersion, 3)
	})

	it('existe nativeFlowResponseMessage em InteractiveResponseMessage', () => {
		const R = proto.Message.InteractiveResponseMessage
		assert.ok(R, 'InteractiveResponseMessage existe')
		const m = R.fromObject({
			body: { format: 0, text: 'ok' },
			nativeFlowResponseMessage: { name: 'menu_options', paramsJson: '{"id":"#a"}', version: 1 }
		})
		assert.equal(m.nativeFlowResponseMessage.name, 'menu_options')
		assert.equal(m.body.text, 'ok')
	})

	it('NAO existe flowMessage nem flowResponseMessage no Message', () => {
		// O teste falha de proposito se alguem adicionar um campo inventado.
		const campos = Object.keys(proto.Message.fields || {}).concat(
			Object.keys(new proto.Message()).filter((k) => !k.startsWith('_'))
		)
		assert.ok(!campos.includes('flowMessage'), 'nao existe flowMessage')
		assert.ok(!campos.includes('flowResponseMessage'), 'nao existe flowResponseMessage')
	})

	it('flowId NAO e campo de mensagem de usuario (so GalaxyFlowAction)', () => {
		const M = new proto.Message()
		assert.equal(M.flowId, undefined, 'Message nao tem flowId')
		const g = proto.Message.PeerDataOperationRequestMessage.GalaxyFlowAction
		assert.ok(g, 'GalaxyFlowAction existe (contexto de ads/business)')
		assert.ok(g.fromObject({ flowId: 'x' }).flowId === 'x')
	})
})

describe('botao de Flow — parametros da Meta', () => {
	it('monta o JSON com os nomes de campo da Meta', () => {
		const p = buildFlowParams({ flowId: '1234567890', cta: 'Agendar' })
		assert.equal(p.flow_id, '1234567890')
		assert.equal(p.flow_cta, 'Agendar')
		assert.equal(p.flow_action, 'navigate')
		assert.equal(p.mode, 'published')
		assert.equal(p.flow_message_version, FLOW_MESSAGE_VERSION)
		assert.equal(p.flow_token, 'unused', 'default documentado pela Meta')
	})

	it('aceita token, tela e dados iniciais', () => {
		const p = buildFlowParams({
			flowId: '1',
			token: 'sessao-abc',
			screen: 'DADOS',
			data: { plano: 'pro' }
		})
		assert.equal(p.flow_token, 'sessao-abc')
		assert.equal(p.flow_action_payload.screen, 'DADOS')
		assert.deepEqual(p.flow_action_payload.data, { plano: 'pro' })
	})

	it('data_exchange e draft sao aceitos', () => {
		const p = buildFlowParams({ flowId: '1', action: 'data_exchange', mode: 'draft' })
		assert.equal(p.flow_action, 'data_exchange')
		assert.equal(p.mode, 'draft')
	})

	it('sem flowId -> FLOW_ID_MISSING (mensagem acionavel)', () => {
		assert.throws(
			() => buildFlowParams({}),
			(e) => e instanceof FlowValidationError && e.code === 'FLOW_ID_MISSING'
		)
	})

	it('flow_action invalido -> FLOW_ACTION_INVALID', () => {
		assert.throws(
			() => buildFlowParams({ flowId: '1', action: 'teleport' }),
			(e) => e.code === 'FLOW_ACTION_INVALID'
		)
	})

	it('mode invalido -> FLOW_MODE_INVALID', () => {
		assert.throws(
			() => buildFlowParams({ flowId: '1', mode: 'beta' }),
			(e) => e.code === 'FLOW_MODE_INVALID'
		)
	})

	it('o botao tem name "flow" e o JSON serializado', () => {
		const b = buildFlowButton({ flowId: '42', cta: 'Abrir' })
		assert.equal(b.name, FLOW_BUTTON_NAME)
		assert.equal(b.name, 'flow')
		const p = parseFlowButtonParams(b.buttonParamsJson)
		assert.equal(p.flow_id, '42')
		assert.ok(isFlowButton(b))
		assert.ok(!isFlowButton({ name: 'quick_reply' }))
	})

	it('parseFlowButtonParams e tolerante a lixo', () => {
		assert.equal(parseFlowButtonParams(undefined), null)
		assert.equal(parseFlowButtonParams(''), null)
		assert.equal(parseFlowButtonParams('{nao e json'), null)
		assert.equal(parseFlowButtonParams('[1,2]'), null)
	})

	it('o diagnostico NAO vaza o flow_token (so o tamanho)', () => {
		const b = buildFlowButton({ flowId: '42', token: 'SEGREDO-DE-SESSAO-XYZ' })
		const d = describeFlowButton(b)
		assert.equal(d.flowId, '42')
		assert.equal(d.tokenLen, 'SEGREDO-DE-SESSAO-XYZ'.length)
		assert.ok(!JSON.stringify(d).includes('SEGREDO'), 'o valor do token nao aparece')
	})
})

describe('caminho REAL da fork (generateWAMessageContent)', () => {
	it('nativeFlow com flowId vira interactiveMessage.nativeFlowMessage', async () => {
		const m = await generateWAMessageContent(
			{
				text: 'Preencha o formulário',
				footer: 'Teste',
				nativeFlow: [{ flowId: '987654321', cta: 'Abrir formulário' }]
			},
			{ upload: fakeUpload, logger: undefined }
		)
		const im = m.interactiveMessage
		assert.ok(im, 'veio interactiveMessage')
		assert.ok(im.nativeFlowMessage, 'tem nativeFlowMessage')
		assert.equal(im.body.text, 'Preencha o formulário')
		const btn = im.nativeFlowMessage.buttons[0]
		assert.equal(btn.name, 'flow')
		const p = JSON.parse(btn.buttonParamsJson)
		assert.equal(p.flow_id, '987654321')
		assert.equal(p.flow_cta, 'Abrir formulário')
	})

	it('o payload sobrevive ao encode/decode do proto', async () => {
		const m = await generateWAMessageContent(
			{ text: 'x', nativeFlow: [{ flowId: '555', screen: 'WELCOME' }] },
			{ upload: fakeUpload }
		)
		const bytes = proto.Message.encode(proto.Message.fromObject(m)).finish()
		const volta = proto.Message.decode(bytes)
		const btn = volta.interactiveMessage.nativeFlowMessage.buttons[0]
		assert.equal(btn.name, 'flow')
		const p = JSON.parse(btn.buttonParamsJson)
		assert.equal(p.flow_id, '555')
		assert.equal(p.flow_action_payload.screen, 'WELCOME')
	})

	it('declarar um Flow sem flowId FALHA com o codigo, em vez de mandar botao quebrado', async () => {
		// `flow: {...}` declara a intencao de abrir um Flow; sem `flowId` nao ha
		// formulario para o cliente desenhar, entao falha claro em vez de sair um
		// botao que o destinatario nao entende.
		await assert.rejects(
			() => generateWAMessageContent({ text: 'x', nativeFlow: [{ flow: { cta: 'sem id' } }] }, { upload: fakeUpload }),
			(e) => e.code === 'FLOW_ID_MISSING'
		)
		await assert.rejects(
			() => generateWAMessageContent({ text: 'x', nativeFlow: [{ flowId: '' }] }, { upload: fakeUpload }),
			(e) => e.code === 'FLOW_ID_MISSING'
		)
	})

	it('getContentType reconhece a resposta interativa', () => {
		const content = buildFlowReply({ name: 'menu_options', paramsJson: '{"id":"#a"}' })
		assert.equal(getContentType(content), 'interactiveResponseMessage')
	})
})

describe('resposta do Flow', () => {
	it('buildFlowReply monta o interactiveResponseMessage', () => {
		const c = buildFlowReply({ name: 'menu_options', paramsJson: '{"id":"#plano"}' })
		assert.ok(c.interactiveResponseMessage)
		assert.equal(c.interactiveResponseMessage.nativeFlowResponseMessage.name, 'menu_options')
		assert.equal(c.interactiveResponseMessage.nativeFlowResponseMessage.version, 1)
		assert.equal(c.interactiveResponseMessage.body.format, 0)
	})

	it('sem name -> FLOW_REPLY_NAME_MISSING', () => {
		assert.throws(() => buildFlowReply({}), (e) => e.code === 'FLOW_REPLY_NAME_MISSING')
	})

	it('parseFlowResponse le o que o buildFlowReply montou', () => {
		const c = buildFlowReply({ name: 'form_teste', paramsJson: '{"plano":"pro"}' })
		const r = parseFlowResponse(c)
		assert.equal(r.name, 'form_teste')
		assert.deepEqual(r.params, { plano: 'pro' })
		assert.equal(r.version, 1)
	})

	it('parseFlowResponse desembrulha view-once/efemera', () => {
		const c = buildFlowReply({ name: 'form_teste', paramsJson: '{"a":1}' })
		assert.ok(parseFlowResponse({ viewOnceMessageV2: { message: c } }), 'viewOnceMessageV2')
		assert.ok(parseFlowResponse({ ephemeralMessage: { message: c } }), 'ephemeralMessage')
		assert.ok(parseFlowResponse({ viewOnceMessage: { message: c } }), 'viewOnceMessage')
	})

	it('parseFlowResponse devolve null para mensagem comum', () => {
		assert.equal(parseFlowResponse({ conversation: 'oi' }), null)
		assert.equal(parseFlowResponse(undefined), null)
		assert.equal(parseFlowResponse({ interactiveMessage: { body: {} } }), null)
	})
})

describe('regressao: os botoes que ja existiam', () => {
	it('quick_reply, cta_url e single_select continuam iguais', async () => {
		const m = await generateWAMessageContent(
			{
				text: 'menu',
				nativeFlow: [
					{ text: 'Oi', id: '#oi' },
					{ text: 'Site', url: 'https://exemplo.com' },
					{ text: 'Escolher', sections: [{ title: 'S1', rows: [{ title: 'A', id: '#a' }] }] }
				]
			},
			{ upload: fakeUpload }
		)
		const btns = m.interactiveMessage.nativeFlowMessage.buttons
		assert.equal(btns[0].name, 'quick_reply')
		assert.equal(JSON.parse(btns[0].buttonParamsJson).id, '#oi')
		assert.equal(btns[1].name, 'cta_url')
		assert.equal(JSON.parse(btns[1].buttonParamsJson).url, 'https://exemplo.com')
		assert.equal(btns[2].name, 'single_select')
	})

	it('um botao de Flow convive com os outros no mesmo envelope', async () => {
		const m = await generateWAMessageContent(
			{
				text: 'menu',
				nativeFlow: [
					{ text: 'Formulário', flowId: '77' },
					{ text: 'Oi', id: '#oi' }
				]
			},
			{ upload: fakeUpload }
		)
		const btns = m.interactiveMessage.nativeFlowMessage.buttons
		assert.equal(btns[0].name, 'flow')
		assert.equal(btns[1].name, 'quick_reply')
	})

	it('as constantes exportadas batem com a doc da Meta', () => {
		assert.deepEqual(FLOW_ACTIONS, ['navigate', 'data_exchange'])
		assert.deepEqual(FLOW_MODES, ['published', 'draft'])
		assert.equal(FLOW_MESSAGE_VERSION, '3')
	})
})
