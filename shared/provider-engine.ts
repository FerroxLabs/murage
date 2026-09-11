import type { ProviderPreset, ProviderProtocol } from "./provider-connections.ts";
/** Transport support, not a claim about account entitlement/model tool quality. */
export function providerEngineProtocol(driver: string, preset: ProviderPreset, protocol: ProviderProtocol): ProviderProtocol | null {
  if (driver === "fuigoAgent") return protocol;
  if (driver === "claudeAgent") return preset === "flux" ? "anthropic" : protocol === "anthropic" ? protocol : null;
  if (driver === "codex") return preset === "flux" || preset === "openai" ? "responses" : protocol === "responses" ? protocol : null;
  if (["qwenAgent", "hermesAgent", "grok", "openai-compat"].includes(driver)) return protocol === "openai" ? protocol : null;
  return null;
}
/** Whether an engine runs tools. pi, opencode, droid, kimi and grokAgent run
 *  their own tool loops (and mount Murage's MCP servers) the same way the
 *  others in the first list do; `grok` (API) and `openai-compat` only chat —
 *  no tools, no agents — and are labelled that way (0.1.52 spec E4). */
export const TOOL_ENGINES: readonly string[] = ["fuigoAgent", "claudeAgent", "codex", "qwenAgent", "hermesAgent", "piAgent", "opencodeGo", "droidAgent", "kimiAgent", "grokAgent"];
export const CHAT_ONLY_ENGINES: readonly string[] = ["grok", "openai-compat"];
export function engineToolSupport(driver: string): "tools" | "chat-only" | "unverified" {
  return TOOL_ENGINES.includes(driver) ? "tools" : CHAT_ONLY_ENGINES.includes(driver) ? "chat-only" : "unverified";
}
