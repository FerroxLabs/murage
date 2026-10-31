import type { ProviderPreset, ProviderProtocol } from "./provider-connections.ts";
/** Transport support, not a claim about account entitlement/model tool quality. */
export function providerEngineProtocol(driver: string, preset: ProviderPreset, protocol: ProviderProtocol): ProviderProtocol | null {
  // Plan sign-ins reach engines through Murage's local model gateway
  // (server/model-gateway.ts), which injects the plan token and, for the
  // ChatGPT plan, turns chat completions into the Responses calls the ChatGPT
  // backend takes. So every engine that takes model connections can use them,
  // except Claude Code, which runs Claude models only.
  if (preset === "chatgpt" || preset === "supergrok") {
    if (driver === "fuigoAgent") return protocol;
    if (driver === "codex") return "responses";
    if (["qwenAgent", "hermesAgent", "grok", "grokAgent", "openai-compat"].includes(driver)) return "openai";
    return null;
  }
  if (driver === "fuigoAgent") return protocol;
  if (driver === "claudeAgent") return preset === "flux" ? "anthropic" : protocol === "anthropic" ? protocol : null;
  if (driver === "codex") return preset === "flux" || preset === "openai" ? "responses" : protocol === "responses" ? protocol : null;
  if (["qwenAgent", "hermesAgent", "grok", "grokAgent", "openai-compat"].includes(driver)) return protocol === "openai" ? protocol : null;
  return null;
}
/** Whether an engine runs tools. pi, opencode, droid, kimi and grokAgent run
 *  their own tool loops (and mount Murage's MCP servers) the same way the
 *  others in the first list do; `grok` (API) and `openai-compat` only chat —
 *  no tools, no agents — and are labelled that way (0.1.52 spec E4). */
export const TOOL_ENGINES: readonly string[] = ["fuigoAgent", "claudeAgent", "codex", "qwenAgent", "hermesAgent", "piAgent", "opencodeGo", "droidAgent", "kimiAgent", "grokAgent"];
/** Why a plan sign-in is missing from this engine's model list, or null when
 * it is there. The picker shows this line instead of a silent gap. */
export function signInEngineGap(driver: string): "claude" | "no-connections" | null {
  if (providerEngineProtocol(driver, "chatgpt", "responses")) return null;
  return driver === "claudeAgent" ? "claude" : "no-connections";
}
export const CHAT_ONLY_ENGINES: readonly string[] = ["grok", "openai-compat"];
export function engineToolSupport(driver: string): "tools" | "chat-only" | "unverified" {
  return TOOL_ENGINES.includes(driver) ? "tools" : CHAT_ONLY_ENGINES.includes(driver) ? "chat-only" : "unverified";
}
