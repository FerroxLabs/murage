import type { InstanceConfigMap } from "./contracts.ts";
import { claudeAccountInfo } from "./claude-accounts.ts";
import type { DescribeFlight, ProviderRegistry } from "./harness/registry.ts";

type Rows = Awaited<ReturnType<ProviderRegistry["describe"]>>;
/** Account validation is part of the evidence, before any birth can observe it. */
export function mapClaudeAccountInstances(instances: Rows, configured: InstanceConfigMap): Rows {
  return instances.map(instance => {
    const entry = configured[instance.instanceId];
    if (entry?.driver !== "claudeAgent" || !instance.install) return instance;
    try {
      const account = claudeAccountInfo(instance.instanceId, entry, instance.cli || instance.cliDefault || "claude");
      return account.managed ? { ...instance, install: { ...instance.install, signInCommand: account.signInCommand } } : instance;
    } catch {
      return { ...instance, install: undefined, snapshot: { state: "unavailable" as const, reason: "Named Claude account setup is invalid. Review its directory in Engines settings." } };
    }
  });
}
type Live = ReturnType<ProviderRegistry["instances"]>[number];
/** Cache on the original flight, so shared callers map and publish exactly once. `observe` (the Cloud birth fallback's state note) is
 * given the live instances from just before THIS caller started the scan, with the mapped rows; it never runs for a scan another
 * caller began, because the before-map of that scan is not known. */
export function mappedInstanceScan(registry: ProviderRegistry, map: (rows: Rows) => Rows | Promise<Rows>, observe?: (before: ReadonlyMap<string, Live>, rows: Rows) => void) {
  const mapped = new WeakMap<DescribeFlight, Promise<Rows>>();
  return (options: { catalogs?: "fresh" | "due"; startedAfter?: number } = {}): Promise<Rows> => {
    const ticket = observe ? registry.scanTicket() : 0;
    const before = observe ? new Map(registry.instances().map(instance => [instance.instanceId, instance] as const)) : undefined;
    const flight = registry.describeFlight(options);
    const startedHere = observe !== undefined && registry.scanTicket() !== ticket;
    let result = mapped.get(flight);
    if (!result) {
      result = flight.run.then(map).then(rows => { if (observe && before && startedHere) observe(before, rows); registry.publishScan(flight, rows); return rows; });
      mapped.set(flight, result);
    }
    return result;
  };
}
