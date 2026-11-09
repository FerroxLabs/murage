import type { ModelCatalog, ModelSelection } from "./contracts.ts";
import type { ScanReading } from "./harness/registry.ts";
import { isFluxModel } from "./flux-surface.ts";

// Sean's ruling, 2026-11-06: Option A, verified subscription logins lead at birth.
// Design: "Fuigo first, unless the owner already pays a flat rate for an engine that is verified signed in."
export const ENGINE_DEFAULT_PAID_ONLY = true;
const native = (option: ModelCatalog["options"][number]) => !isFluxModel(option.id) && option.custom !== true && option.provider === undefined;

export function nativeModel(models: ModelCatalog): string {
  return models.options.find(option => option.id === models.default && native(option))?.id
    ?? models.options.find(native)?.id ?? "";
}

export function birthCandidate(input: {
  reading: ScanReading | null;
  paidOnly: boolean;
  live: (instanceId: string) => { driverKind: string; enabled?: boolean; models: ModelCatalog } | null;
  source: ModelSelection | null;
}): { instanceId: string; model: string } | null {
  if (!input.reading) return null;
  for (const driver of ["claudeAgent", "codex"]) {
    for (const row of input.reading.rows) {
      if (row.driverKind !== driver || row.authenticated !== true || (input.paidOnly && row.billing !== "subscription")) continue;
      const live = input.live(row.instanceId);
      if (!live || live.enabled === false) continue;
      const fallback = nativeModel(live.models);
      if (!fallback) continue;
      const source = input.source;
      const copy = source?.instanceId === row.instanceId && !source.connectionId && source.model !== ""
        && live.models.options.some(option => option.id === source.model && native(option));
      return { instanceId: row.instanceId, model: copy ? source!.model : fallback };
    }
  }
  return null;
}
