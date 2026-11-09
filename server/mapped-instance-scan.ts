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
/** Cache on the original flight, so shared callers map and publish exactly once. */
export function mappedInstanceScan(registry: ProviderRegistry, map: (rows: Rows) => Rows | Promise<Rows>) {
  const mapped = new WeakMap<DescribeFlight, Promise<Rows>>();
  return (options: { catalogs?: "fresh" | "due"; startedAfter?: number } = {}): Promise<Rows> => {
    const flight = registry.describeFlight(options);
    let result = mapped.get(flight);
    if (!result) {
      result = flight.run.then(map).then(rows => { registry.publishScan(flight, rows); return rows; });
      mapped.set(flight, result);
    }
    return result;
  };
}
