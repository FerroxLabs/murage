// S5-DATADIR-PATHS r4.1 sites 6 and 7 (config load): a Claude account configDir and a managed engine cli under a
// RECORDED previous data root are rebased by reconstruction (section 2) before any accountDirectory, directoryIdentity,
// withInstanceCli, probe or spawn. A refused cli is treated as missing (never spawned or probed); a refused configDir is
// re-homed (RH1-RH4) or, failing that, the account stays unavailable with sign-in disabled. CLAUDE_CONFIG_DIR is never the old path.
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, loadConfig, saveConfig, setInstanceConfigOverlay } from "./config.ts";
import type { InstanceConfig, InstanceConfigMap } from "./contracts.ts";
import { assertSeparateClaudeAccount, markClaudeAccountUnavailable } from "./claude-accounts.ts";
import { dataRoots } from "./data-roots.ts";
import { rebaseStoredPath, type Constructors } from "./stored-paths.ts";

export const REHOME_FAILED_TEXT = "This Claude account's folder could not be set up in the new location. Remove the account and add it again.";

const refusedClis = new Set<string>();
setInstanceConfigOverlay((instances) => {
  if (!refusedClis.size) return instances;
  const next: InstanceConfigMap = { ...instances };
  for (const id of refusedClis) {
    const entry = next[id]; const config = rawConfig(entry);
    if (entry && typeof config.cli === "string") { const { cli: _cli, ...rest } = config; next[id] = { ...entry, config: rest } as InstanceConfig; }
  }
  return next;
});

function rawConfig(entry: InstanceConfig | undefined): Record<string, unknown> {
  return entry?.config && typeof entry.config === "object" && !Array.isArray(entry.config) ? entry.config as Record<string, unknown> : {};
}

const ID = /^[A-Za-z0-9][\w.-]{0,79}$/;
/** Site 7: the managed folder shapes engine-management.ts accepts (codex-<ver>-<...>/..., fuigo/<id>/<ver>-<hex>/fuigo[.exe]),
 * rebuilt at each root from the stored value's own tail below that root's managed-engines folder. */
export function managedCliConstructors(stored: string, instanceId: string, previous: readonly string[], platform: NodeJS.Platform = process.platform): Constructors {
  const fold = (value: string) => platform === "win32" ? value.replace(/\//g, "\\").toLowerCase() : value;
  let tail: string[] | undefined;
  for (const root of [DATA_DIR, ...previous]) {
    const base = join(root, "managed-engines");
    const s = fold(stored), b = fold(base);
    const separator = platform === "win32" ? "\\" : "/";
    if (!s.startsWith(b + separator)) continue;
    tail = stored.slice(base.length + 1).split(/[\\/]/);
    break;
  }
  const shaped = !!tail && (
    (tail.length >= 2 && /^codex-\d+\.\d+\.\d+-/.test(tail[0]!) && tail.every(part => part && part !== "." && part !== ".."))
    || (tail.length === 4 && tail[0] === "fuigo" && tail[1] === instanceId && ID.test(tail[1]!) && /^\d+\.\d+\.\d+-[0-9a-f-]+$/.test(tail[2]!) && /^fuigo(?:\.exe)?$/.test(tail[3]!)));
  return root => shaped ? [join(root, "managed-engines", ...tail!)] : [];
}

/** Site 6: the one constructor of a Murage-made account folder (claude-accounts.ts newClaudeAccount). */
export const configDirConstructors = (instanceId: string): Constructors => root => [join(root, "providers", instanceId)];

export interface ConfigPathSeams { mkdir: (path: string) => void; uuid: () => string }
export const configPathSeams: ConfigPathSeams = { mkdir: path => mkdirSync(path, { mode: 0o700 }), uuid: () => randomUUID() };

/** RH1-RH3; returns the new lexical configDir, or undefined (the caller keeps the account unavailable). */
function rehome(instances: InstanceConfigMap, id: string, entry: InstanceConfig): string | undefined {
  try {
    const leaf = `${id}.${configPathSeams.uuid()}`;
    const lexical = join(DATA_DIR, "providers", leaf);
    // RH2: the providers root (linked or plain) must be ok; ownedPath walks it, then the leaf is made exclusively.
    const parent = dataRoots().ownedPath(join(DATA_DIR, "providers"), { create: true });
    const canonicalLeaf = join(parent.canonical, leaf);
    configPathSeams.mkdir(canonicalLeaf);
    const stat = lstatSync(canonicalLeaf);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    // RH3
    assertSeparateClaudeAccount({ ...instances }, id, { ...entry, config: { ...rawConfig(entry), configDir: lexical } } as InstanceConfig);
    return lexical;
  } catch { return undefined; }
}

/** Once at startup, after bootDataRoots(): rebases, re-homes and persists in one atomic saveConfig (RH4). */
export function rebaseConfigPaths(log: (line: string) => void = line => console.warn(line)): { rebased: number; rehomed: number; refused: number } {
  refusedClis.clear();
  const result = { rebased: 0, rehomed: 0, refused: 0 };
  let instances: InstanceConfigMap | undefined;
  try { instances = loadConfig().instances as InstanceConfigMap | undefined; } catch { return result; }
  if (!instances) return result;
  const previous = dataRoots().previousRoots();
  const next: InstanceConfigMap = { ...instances };
  let changed = false;
  for (const [id, entry] of Object.entries(instances)) {
    let config = rawConfig(entry);
    if (typeof config.cli === "string" && config.cli && previous.length) {
      const outcome = rebaseStoredPath(config.cli, managedCliConstructors(config.cli, id, previous), { previous });
      if ("path" in outcome) { config = { ...config, cli: outcome.path }; changed = true; result.rebased++; }
      else if ("refused" in outcome) { refusedClis.add(id); result.refused++; }
    }
    if (entry.driver === "claudeAgent" && typeof config.configDir === "string" && config.configDir.trim() && previous.length) {
      const stored = config.configDir;
      const outcome = rebaseStoredPath(stored, configDirConstructors(id), { previous });
      if ("path" in outcome) { config = { ...config, configDir: outcome.path }; changed = true; result.rebased++; }
      else if ("refused" in outcome) {
        const fresh = rehome(next, id, entry);
        if (fresh) { config = { ...config, configDir: fresh }; changed = true; result.rehomed++; }
        else { markClaudeAccountUnavailable(stored, REHOME_FAILED_TEXT); result.refused++; }
      }
    }
    if (config !== rawConfig(entry)) next[id] = { ...entry, config } as InstanceConfig;
  }
  if (changed) {
    try { saveConfig({ instances: next } as Parameters<typeof saveConfig>[0]); }
    catch {
      // RH4 failed: nothing was persisted. Every re-homed account stays unavailable; a rebased path is retried next start.
      for (const [id, entry] of Object.entries(instances)) { const dir = rawConfig(entry).configDir; if (typeof dir === "string" && rawConfig(next[id]).configDir !== dir) markClaudeAccountUnavailable(dir, REHOME_FAILED_TEXT); }
      log("data-dir-config-rebase save failed");
      return result;
    }
  }
  if (result.rebased || result.rehomed || result.refused) log(`data-dir-config-rebase rebased=${result.rebased} rehomed=${result.rehomed} refused=${result.refused}`);
  return result;
}

/** Tests only. */
export function refusedCliIdsForTest(): string[] { return [...refusedClis]; }
