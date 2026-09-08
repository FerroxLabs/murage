import type { ProviderPreset, ProviderProtocol } from "./provider-connections.ts";
/** Transport support, not a claim about account entitlement/model tool quality. */
export function providerEngineProtocol(driver: string, preset: ProviderPreset, protocol: ProviderProtocol): ProviderProtocol | null {
  if (driver === "fuigoAgent") return protocol;
  if (driver === "claudeAgent") return preset === "flux" ? "anthropic" : protocol === "anthropic" ? protocol : null;
  if (driver === "codex") return preset === "flux" || preset === "openai" ? "responses" : protocol === "responses" ? protocol : null;
  if (["qwenAgent", "hermesAgent", "grok", "openai-compat"].includes(driver)) return protocol === "openai" ? protocol : null;
  return null;
}
export function engineToolSupport(driver: string): "tools" | "chat-only" | "unverified" {
  return ["fuigoAgent", "claudeAgent", "codex", "qwenAgent", "hermesAgent"].includes(driver) ? "tools" : ["grok", "openai-compat"].includes(driver) ? "chat-only" : "unverified";
}
