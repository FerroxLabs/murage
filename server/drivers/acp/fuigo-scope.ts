// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FUIGO-SCOPE-1010: a bot's Fuigo runs in a Murage-owned FUIGO_HOME, one per bot (scoped-cli-home.ts), as Grok does
// with GROK_HOME (grok-scope.ts). FUIGO_HOME replaces the home whole (fuigo-dirs lib.rs resolve_fuigo_home_from), so
// the owner's ~/.fuigo config, hooks, MCP servers, plugins, sessions and TUI grants never reach a bot turn, and the
// scope's config.toml carries Murage's ask rules (fuigo-permission.ts), which is how every read, search, edit and
// command reaches Murage's key guard before it runs.
//
// The scope holds:
//   config.toml   generated on every rebuild: the owner's config filtered (filterFuigoConfigToml), Murage's pins, the
//                 bot's local-model tables from Murage's own folder, and the one `[permission]` table (the bot's ask
//                 rules plus the owner's denies)
//   the organisation policy files, copied from the owner's home on every spawn (copyFuigoOrgPolicy)
//   sessions/, logs/ and the rest: the bot's own, written by Fuigo
//
// Login: nothing is linked. A native-login owner's turn sets FUIGO_AUTH_PATH to the owner's own auth.json, so Fuigo
// reads and refreshes it in place (auth/manager.rs:392-396); the lock is always beside that file
// (auth/manager/lock.rs `auth_json_path.with_file_name("auth.json.lock")`), and the refresh writes a temporary file in
// the owner's folder and renames it (storage.rs write_auth_json_atomic; Windows removes the target first). No symlink,
// so Windows needs no Developer Mode. Murage never writes auth.json.
// A Flux-key turn does NOT get FUIGO_AUTH_PATH: Fuigo ranks a session token above FUIGO_API_KEY (agent/config.rs
// resolve_credentials: model key > auth provider > session token > FUIGO_API_KEY), so pointing it at the owner's login
// would move the turn's billing off the Flux key. Its organisation copies then follow Fuigo's own cleanup.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { listDir, pathExists, readText } from "../isolation-cache.ts";
import { currentScopeHome, engineConfigInvalid, registerScopeReconstructor, scopedCliHome, scopedCliHomeRoot, ScopeUnavailableError, type ScopedCliHomeSpec } from "../scoped-cli-home.ts";
import {
  copyFuigoOrgPolicy, filterFuigoConfigToml, FUIGO_SCOPE_PINS, FuigoPolicyChangingError, FuigoPolicyUnreadableError, fuigoHomePermission, fuigoLocalModelDir, renderFuigoLocalModelFile,
} from "./fuigo-permission.ts";

/** Fuigo's credential env names (fuigo.ts FUIGO_KEY_ENV): any of them set makes this a key turn. */
const FUIGO_KEY_ENV = ["FUIGO_API_KEY", "FUIGO_CODE_API_KEY", "FLUX_API_KEY"] as const;

/** Set by provider-routing.ts on a provider-routed turn's per-turn home: that home is already Murage's own, rendered
 *  with the same rules, and is never scoped again (V2). */
export const MURAGE_FUIGO_ROUTED_HOME = "MURAGE_FUIGO_ROUTED_HOME";

/** Folders of a bot's Fuigo home that hold only rebuildable logs and caches (pruned past the scope's byte cap). */
export const FUIGO_SCOPE_CACHE = ["logs", "crash", "marketplace-cache", "memtrace"] as const;

/** The real Fuigo home this env names (an explicit FUIGO_HOME the owner set, else ~/.fuigo). */
export function realFuigoHome(env: Record<string, string | undefined>): string {
  return env.FUIGO_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".fuigo");
}

const hasKey = (env: Record<string, string | undefined>) => {
  const names = new Set<string>(FUIGO_KEY_ENV);
  return Object.entries(env).some(([name, value]) => names.has(name.toUpperCase()) && Boolean(value?.trim()));
};

/** The bot's local-model tables (ensureFuigoLocalModel writes one file per slug), read as rebuild dependencies. Each file
 *  goes through the allowlist renderer (renderFuigoLocalModelFile, G3): never pasted, and a file that is anything but one
 *  local-model table of its own slug is left out and logged, so a table a bot planted there never starts a process. */
export function localModelTables(log: (line: string) => void = (line) => console.warn(line)): string {
  const dir = fuigoLocalModelDir();
  let names: string[] = [];
  try { names = listDir(dir); } catch { pathExists(dir); return ""; }
  let out = "";
  for (const name of names.filter((entry) => entry.endsWith(".toml")).sort()) {
    let text: string;
    try { text = readText(join(dir, name)); } catch { continue; /* removed meanwhile */ }
    const rendered = renderFuigoLocalModelFile(name, text);
    if (rendered === null) { log(`Fuigo: a file in Murage's local-model folder is not a local-model table and was left out of the bot's settings: ${name}`); continue; }
    out += `\n${rendered}`;
  }
  return out;
}

/** The owner's config.toml, or "" when there is none. A file that exists and cannot be read fails the turn. */
function ownerConfig(realHome: string): string {
  const path = join(realHome, "config.toml");
  try { return readText(path); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    pathExists(path);
    if (code === "ENOENT" || code === "ENOTDIR") return "";
    throw engineConfigInvalid("Fuigo", error, "plain");
  }
}

/** Fuigo's folder-trust store (fuigo-workspace/src/trust.rs), read by the engine from its FUIGO_HOME. */
export const FUIGO_TRUST_STORE = "trusted_folders.toml";

/** The owner's own trusted_folders.toml, carried into the scope as a copy refreshed on every rebuild, so a folder the
 *  owner's Fuigo already trusts runs trusted for the bot too and raises no card (folder-trust.ts upstreamTrusted reads
 *  the same file). The owner's file is never written. Absent or unreadable: null, so no copy (the folder stays
 *  untrusted and Murage's own record decides, the fail-closed side). */
function ownerTrustedFolders(realHome: string): string | null {
  const path = join(realHome, FUIGO_TRUST_STORE);
  try { return readText(path); } catch { pathExists(path); return null; }
}

/** The bot scope's config.toml. */
export function scopedFuigoConfigToml(owner: string, localModels = "", log?: (line: string) => void): string {
  const filtered = filterFuigoConfigToml(owner).trimEnd();
  return `${filtered ? `${filtered}\n\n` : ""}${FUIGO_SCOPE_PINS}${localModels}\n${fuigoHomePermission(owner, undefined, log)}`;
}

function fuigoScopeSpec(realHome: string, botId: string | undefined): ScopedCliHomeSpec {
  return {
    kind: "fuigo",
    realHome,
    botId,
    share: [],
    cache: FUIGO_SCOPE_CACHE,
    generated: () => {
      const trusted = ownerTrustedFolders(realHome);
      return { "config.toml": scopedFuigoConfigToml(ownerConfig(realHome), localModelTables()), ...(trusted === null ? {} : { [FUIGO_TRUST_STORE]: trusted }) };
    },
  };
}
registerScopeReconstructor("fuigo", ({ realHome, botId }) => fuigoScopeSpec(realHome, botId));

/** Point FUIGO_HOME at the bot's own scope, copy the owner's organisation policy into it and set FUIGO_AUTH_PATH for a
 *  native-login turn. Throws (the core rejects the turn, never starts it in the owner's home) when it cannot. */
export function scopeFuigoHome(env: Record<string, string | undefined>, botId?: string): void {
  // A Cloud home's launcher renders its own Fuigo home, read-only for the turn (murage-turn-launch.py fuigo_config_text).
  if (process.env.MURAGE_CLOUD_ROLE === "home") return;
  // A provider-routed turn's home is already Murage's own, with the same rules and policy copies (provider-routing.ts).
  if (env[MURAGE_FUIGO_ROUTED_HOME] && env[MURAGE_FUIGO_ROUTED_HOME] === env.FUIGO_HOME) return;
  const realHome = realFuigoHome(env);
  if (realHome.startsWith(scopedCliHomeRoot("fuigo"))) { const current = currentScopeHome("fuigo", realHome); if (current) env.FUIGO_HOME = current; return; }
  const home = scopedCliHome(fuigoScopeSpec(realHome, botId));
  try { copyFuigoOrgPolicy(realHome, home); } catch (error) {
    if (error instanceof FuigoPolicyChangingError) throw new ScopeUnavailableError(error.message, true, { cause: error, engine: "Fuigo" });
    if (error instanceof FuigoPolicyUnreadableError) throw engineConfigInvalid("Fuigo", error, "plain");
    throw error;
  }
  env.FUIGO_HOME = home;
  setFuigoAuthPath(env, realHome);
}

/** FUIGO_AUTH_PATH for a turn whose home Murage owns: the owner's own auth.json when the turn has no key (native
 *  login), never on a key turn (see the header: billing stays on the key). `routed` turns name their model's key by
 *  `env_key`, which outranks a session token, so they may read the owner's login for the policy principal. */
export function setFuigoAuthPath(env: Record<string, string | undefined>, realHome: string, routed = false): void {
  const owner = env.FUIGO_AUTH_PATH || join(realHome, "auth.json");
  if (routed ? existsSync(owner) : !hasKey(env)) env.FUIGO_AUTH_PATH = owner;
  else delete env.FUIGO_AUTH_PATH;
}
