// Back-compat re-export: the Fuigo ACP driver lives in acp/fuigo.ts, riding
// the shared acp/core.ts runtime. Kept here so imports and dist-server
// references resolve the same way they do for grokagent.ts.
export { FuigoAgentDriver } from "./acp/fuigo.ts";
