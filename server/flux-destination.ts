import { isFluxUrl } from "./flux-memory-headers.ts";

export type FluxDestination = "connector" | "other" | "refuse-alias" | "refuse-unknown";
export type EffectiveDestination = { provider: string; urls: readonly unknown[] } | { unknown: string };

// Server turn errors use the existing runtime.error path, not renderer locales.
export const FLUX_DESTINATION_ALIAS_REFUSAL = "This model's provider points at Flux Router. Switch this bot to the Flux connection in Settings → Models.";
export const FLUX_DESTINATION_UNKNOWN_REFUSAL = "Murage couldn't confirm where this OpenCode model sends requests. Send it again, or check OpenCode's config.";

/** Judge an effective destination, never a picker id. The caller supplies the
 * connector id because provider names belong to each engine's config format.
 * With no concrete URL, use the provider's default; the connector's is Flux.
 * Missing URL fields belong in an empty array, not as undefined entries. */
export function fluxDestination(destination: EffectiveDestination, connector: string): FluxDestination {
  if ("unknown" in destination || !destination.provider) return "refuse-unknown";
  let flux = destination.provider === connector && destination.urls.every(value => value === "");
  for (const value of destination.urls) {
    if (typeof value !== "string" || value.includes("{")) return "refuse-unknown";
    if (value === "") continue;
    try { new URL(value); } catch { return "refuse-unknown"; }
    if (isFluxUrl(value)) flux = true;
  }
  if (!flux) return "other";
  return destination.provider === connector ? "connector" : "refuse-alias";
}

/** Probe failures identify the installed version without echoing CLI output. */
export function fluxDestinationUnknownRefusal(version?: string): string {
  const safe = version?.match(/^(?:opencode\s+)?(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/)?.[1];
  return safe ? `${FLUX_DESTINATION_UNKNOWN_REFUSAL} (OpenCode ${safe.slice(0, 24)})` : FLUX_DESTINATION_UNKNOWN_REFUSAL;
}
