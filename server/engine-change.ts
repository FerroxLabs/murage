import type { AppConfig } from "./config.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";

export type ChangeMode = "scoped" | "fleet" | "none";
export interface EngineChange { scope: Set<string>; wholeFleet: boolean; marked: Set<string> }
export interface EngineChangeHost {
  cfg: AppConfig;
  registry: ProviderRegistry;
  loadConfig: () => AppConfig;
  instanceConfigs: (cfg: AppConfig) => InstanceConfigMap;
  changedInstanceIds: typeof changedInstanceIds;
  unsafe: (scope: ReadonlySet<string>) => boolean;
}
export type EngineChangeOutcome =
  | { outcome: "applied" }
  | { outcome: "failed" | "restored"; cause: unknown }
  | { outcome: "unconfirmed"; cause: unknown; restoreCause?: unknown; recoveryCause?: unknown };

/** The instance ids whose resolved configuration differs between two snapshots. */
export function changedInstanceIds(before: InstanceConfigMap, after: InstanceConfigMap): Set<string> {
  const changed = new Set<string>();
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[id] ?? null) !== JSON.stringify(after[id] ?? null)) changed.add(id);
  }
  return changed;
}
function fleetIds(host: EngineChangeHost, before: InstanceConfigMap, after: InstanceConfigMap): Set<string> {
  return new Set([...Object.keys(before), ...Object.keys(after), ...host.registry.entries().map(e => e.instanceId)]);
}
function refreshCfg(host: EngineChangeHost, fresh: AppConfig): void {
  for (const key of Object.keys(host.cfg)) if (!(key in fresh)) delete (host.cfg as unknown as Record<string, unknown>)[key];
  Object.assign(host.cfg, fresh);
}
export function settleEngineChange(host: EngineChangeHost): void {
  host.registry.settle(host.instanceConfigs(host.loadConfig()));
}
export function commitEngineChange(host: EngineChangeHost, named: Iterable<string>, mode: ChangeMode, save: () => void): EngineChange {
  const before = host.instanceConfigs(host.cfg);
  const namedSet = new Set(named);
  if (mode !== "none") host.registry.retire(mode === "fleet" ? fleetIds(host, before, before) : namedSet);
  try {
    save();
    const fresh = host.loadConfig();
    const after = host.instanceConfigs(fresh);
    const scope = new Set([...host.changedInstanceIds(before, after), ...namedSet]);
    const wholeFleet = mode === "fleet" || (mode === "scoped" && host.unsafe(scope));
    const marked = mode === "none" ? new Set<string>() : wholeFleet ? fleetIds(host, before, after) : scope;
    host.registry.retire(marked);
    refreshCfg(host, fresh);
    return { scope, wholeFleet, marked };
  } catch (cause) { settleEngineChange(host); throw cause; }
}
export async function reloadWithRollback(host: EngineChangeHost, change: EngineChange, reload: (scope: ReadonlySet<string> | undefined) => Promise<void>, restore?: () => void): Promise<EngineChangeOutcome> {
  const scopeArg = change.wholeFleet ? undefined : change.scope;
  try { await reload(scopeArg); settleEngineChange(host); return { outcome: "applied" }; }
  catch (cause) {
    if (!restore) { settleEngineChange(host); return { outcome: "failed", cause }; }
    host.registry.retire(change.marked);
    try {
      restore();
      refreshCfg(host, host.loadConfig());
    } catch (restoreCause) { return { outcome: "unconfirmed", cause, restoreCause }; }
    try { await reload(scopeArg); settleEngineChange(host); return { outcome: "restored", cause }; }
    catch (recoveryCause) { settleEngineChange(host); return { outcome: "unconfirmed", cause, recoveryCause }; }
  }
}
