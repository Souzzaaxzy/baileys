import makeWASocket from './Socket/index.js';
export * from '../WAProto/index.js';
export * from './Utils/index.js';
export * from './Types/index.js';
export * from './Store/index.js';
export * from './Defaults/index.js';
export * from './WABinary/index.js';
export * from './WAM/index.js';
export * from './WAUSync/index.js';
/**
 * VoIP media stack (WASM calling on this session).
 *
 * Exported as a namespace on purpose: the media layer has its own `CallState`,
 * `generateCallId`, etc., and a flat `export *` would collide with the signaling
 * types above. Use it as `Voip.GroupCallMedia`, `Voip.WasmEngine`, ...
 */
export * as Voip from './Voip/index.js';
export { makeWASocket };
export default makeWASocket;
//# sourceMappingURL=index.js.map