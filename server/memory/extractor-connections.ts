import type { ProviderInstance } from "../contracts.ts";
import { fluxKey } from "../flux-config.ts";
import { FLUX_OPENAI_BASE } from "../flux-routing.ts";
import { requestMemoryExtraction, type TextOnlyExtractor } from "./extract.ts";

const FLUX_EXTRACTORS = [
  { instanceId: "@murage/flux-fast", model: "flux-fast", label: "Flux Router · Fast" },
  { instanceId: "@murage/flux-standard", model: "flux-standard", label: "Flux Router · Standard" },
  { instanceId: "@murage/flux-auto", model: "flux-auto", label: "Flux Router · Auto" },
] as const;

/** Discover callable, tool-free connections; native CLI authentication is not enough. */
export function memoryExtractorConnections(instances: ProviderInstance[], key: string | null = fluxKey()) {
  return [
    ...FLUX_EXTRACTORS.map(({ instanceId, label }) => ({
      instanceId, label, eligible: Boolean(key),
      ...(!key ? { reason: "Add your Flux Router key in app settings." } : {}),
    })),
    ...instances.filter(instance => instance.enabled && typeof instance.extractMemory === "function")
      .map(instance => ({ instanceId: instance.instanceId, label: instance.displayName ?? instance.driverKind, eligible: true })),
  ];
}

export function resolveMemoryExtractor(
  selected: string | null,
  instances: ProviderInstance[],
  readKey: () => string | null = fluxKey,
): TextOnlyExtractor | null {
  if (!selected) return null;
  const flux = FLUX_EXTRACTORS.find(item => item.instanceId === selected);
  if (flux) {
    if (!readKey()) return null;
    return (text, maximumOutputTokens, signal) => {
      // Resolve again at dispatch so a revoked/replaced key never survives in a closure.
      const key = readKey();
      if (!key) throw new Error("MEMORY_EXTRACTOR_UNAVAILABLE");
      return requestMemoryExtraction({ url: FLUX_OPENAI_BASE, apiKey: key, model: flux.model }, text, maximumOutputTokens, signal);
    };
  }
  const instance = instances.find(item => item.enabled && item.instanceId === selected);
  return instance?.extractMemory?.bind(instance) ?? null;
}
