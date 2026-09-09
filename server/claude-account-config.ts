import { mkdirSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DATA_DIR, instanceConfigs, type AppConfig } from "./config.ts";
import { DEFAULT_INSTANCES } from "./default-instances.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { InstanceConfigMap } from "./contracts.ts";

/** Materialize the current fleet, but never persist injected runtime values. */
export function persistableClaudeInstances(cfg: AppConfig): InstanceConfigMap {
  const map = instanceConfigs(cfg);
  for (const [id, entry] of Object.entries(map)) {
    const original = cfg.instances?.[id] ?? DEFAULT_INSTANCES[id];
    delete entry.environment;
    delete entry.config;
    if (original?.environment !== undefined) entry.environment = structuredClone(original.environment);
    if (original?.config !== undefined) entry.config = structuredClone(original.config);
  }
  return map;
}

const object = z.record(z.string(), z.json());
const instancesSchema = z.record(z.string(), z.object({
  driver: z.string().min(1), displayName: z.string().optional(), accentColor: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(), enabled: z.boolean().optional(), config: z.json().optional(),
}));
export interface ClaudeAccountConfigReceipt { path: string; before: string | null; after: string }

/** Caller holds the provider-configuration gate and has checked fleet idle.
 * Only instances are replaced. Removal never removes credential directories.
 * Malformed existing config is an error, never permission to overwrite it. */
export function replaceClaudeAccountInstances(instances: InstanceConfigMap, path = join(DATA_DIR, "config.json")): ClaudeAccountConfigReceipt {
  const checked = instancesSchema.parse(instances);
  let before: string | null = null;
  try { before = readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const disk = before === null ? {} : object.parse(JSON.parse(before));
  const previous = object.safeParse(disk.instances);
  const replacement: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(checked)) {
    const retained = object.safeParse(previous.success ? previous.data[id] : undefined);
    const merged = { ...(retained.success ? retained.data : {}), ...entry };
    // Absent explicit environment must not retain an older runtime injection.
    if (entry.environment === undefined) delete merged.environment;
    replacement[id] = merged;
  }
  const after = JSON.stringify({ ...disk, instances: replacement }, null, 2);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, after, { mode: 0o600 });
  return { path, before, after };
}

/** Compare before rollback so a concurrent writer is never overwritten.
 * The caller must still reload the old fleet and report any reload failure. */
export function restoreClaudeAccountInstances(receipt: ClaudeAccountConfigReceipt): void {
  if (readFileSync(receipt.path, "utf8") !== receipt.after) throw new Error("Configuration changed after account update; rollback was not applied.");
  if (receipt.before === null) {
    unlinkSync(receipt.path);
    if (existsSync(receipt.path)) throw new Error("Account configuration rollback could not be confirmed.");
  } else {
    writeFileAtomic(receipt.path, receipt.before, { mode: 0o600 });
    if (readFileSync(receipt.path, "utf8") !== receipt.before) throw new Error("Account configuration rollback could not be confirmed.");
  }
}
