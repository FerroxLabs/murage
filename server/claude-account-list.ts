// The Claude accounts section lists named Claude instances with their sign-in
// state. It used registry.describe(), which refreshes every model catalog and
// snapshots every engine on each list refresh, so under load the section held
// every button disabled for seconds after a change (CLAC2). The list now
// probes Claude account instances only; every other field is read from config.
import { claudeAccountInfo } from "./claude-accounts.ts";
import type { InstanceConfigMap, ProviderSnapshot } from "./contracts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";

const missingEngine = { state: "unavailable", reason: "Account engine is unavailable." } satisfies ProviderSnapshot;

/** `instances` is the persistable instance map. `only` narrows the list (and
 * its probe) to one account, for a create or save receipt. */
export async function listClaudeAccounts(registry: Pick<ProviderRegistry, "snapshots">, instances: InstanceConfigMap, only?: string) {
  const entries = Object.entries(instances).filter(([instanceId, entry]) => entry.driver === "claudeAgent" && (only === undefined || instanceId === only));
  const snapshots = await registry.snapshots(entries.map(([instanceId]) => instanceId));
  return entries.map(([instanceId, entry]) => {
    const config = entry.config && typeof entry.config === "object" && !Array.isArray(entry.config) ? entry.config : {};
    const cli = "cli" in config && typeof config.cli === "string" ? config.cli : "claude";
    return { instanceId, displayName: entry.displayName || instanceId, ...claudeAccountInfo(instanceId, entry, cli),
      snapshot: snapshots.get(instanceId) ?? missingEngine };
  });
}
