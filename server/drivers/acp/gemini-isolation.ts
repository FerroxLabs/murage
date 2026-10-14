// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Keep the owner's personal Gemini CLI setup out of bot turns.
//
// Gemini reads its user layer from `$GEMINI_CLI_HOME/.gemini` (documented:
// "keeping CLI state isolated"; defaults to the system home), and has no flag
// for hooks, skills, agents, policies or its instruction files. The system
// settings layer would be the other lever, but Gemini refuses a system file
// whose folder is not owned by root. So a bot turn points GEMINI_CLI_HOME at a
// Murage-owned folder whose `.gemini` holds:
//   oauth_creds.json google_accounts.json gemini-credentials.json   links to the owner's real login
//   settings.json   a copy without mcpServers, hooks and the keys that start
//                   or filter servers (filterGeminiSettings; everything else
//                   kept: auth type, models, trust, ui)
//   trustedFolders.json   a copy
// History, sessions, extensions, skills, agents, commands, policies and the
// instruction files are the bot's own: the owner's are absent.
// Murage's own MCP servers arrive over ACP `session/new`; with the owner's
// allow/deny lists gone, nothing in the user layer can drop them.
// LOGIN REFRESH: Gemini 0.47.0 writes oauth_creds.json, google_accounts.json and
// gemini-credentials.json with an in-place fs.writeFile (cacheCredentials), which
// follows the link: the owner's real file is refreshed, never forked.
//
// The folder is stable per (real home, bot): one state root for each bot, so
// its sessions and history are its own and a settings edit or a new login file
// never makes a second scope (the old content-addressed folder rotated on every
// change and stranded what Gemini had written in the previous one). The login
// files are linked even before they exist, so a first sign-in made inside a
// scope lands in the owner's ~/.gemini. Unused scopes are retired with limits
// (scoped-cli-home.ts retireScopes). Nothing under the owner's ~/.gemini is
// written except those logins. The scope is built even when the owner has no
// ~/.gemini yet (empty settings), and when the owner's environment names a Gemini
// home (GEMINI_CLI_HOME) that folder is the one scoped; the override itself never
// reaches a bot turn. A scope that cannot be built rejects the turn (strict) and
// is logged for the model-list probe, which goes on.
// Where a symlink is not allowed (Windows without the privilege) a login is
// shared as a hardlink (the in-place write above keeps it one file), checked
// every turn; never a copy (shared-login-link.ts).
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { memoDeps, pathExists, readText } from "../isolation-cache.ts";
import { registerScopeReconstructor, scopeEngineHome, scopeSourceOf, scopedCliHomeRoot, scopedCliRoot, type ScopedCliHomeSpec } from "../scoped-cli-home.ts";

/** Linked into a bot's scope even before they exist: Gemini's login files. */
export const GEMINI_LOGIN_ENTRIES = ["oauth_creds.json", "google_accounts.json", "gemini-credentials.json"] as const;
/** Copied (never linked), so Gemini's own writes to them stay in the bot's scope. */
const GEMINI_COPIED_ENTRIES = ["trustedFolders.json"] as const;
/** settings.json keys that load or run the owner's own servers and commands. */
export const GEMINI_PERSONAL_SETTINGS_KEYS = ["mcpServers", "hooks", "hooksConfig", "policyPaths", "admin"] as const;
/**
 * Nested user-layer keys that start the owner's processes, or filter which MCP
 * servers and tools a session gets, read from the Gemini 0.47.0 loader
 * (loadCliConfig; getConsolidated* for mcp.allowed / mcp.excluded). Servers
 * Murage mounts over ACP `session/new` are merged into the same mcpServers and
 * go through the same filters (rig: an owner `mcp.allowed:["personal-db"]`
 * started only personal-db, none of Murage's), so none of these may survive:
 *   mcp.serverCommand          spawns a command that emits server config
 *   mcp.allowed / mcp.excluded  allow-list / deny-list across every server
 *   tools.discoveryCommand / tools.callCommand   run the owner's commands
 *   tools.core                 a hard whitelist that drops every MCP tool
 *   context.fileName / includeDirectories / loadMemoryFromIncludeDirectories
 *                              pull personal instruction files back in
 * `tools.exclude` keeps the owner's built-in exclusions; only MCP tool names
 * (`mcp_<server>_<tool>`) are taken out of it.
 */
export const GEMINI_PERSONAL_NESTED_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["mcp", "serverCommand"], ["mcp", "allowed"], ["mcp", "excluded"],
  ["tools", "discoveryCommand"], ["tools", "callCommand"], ["tools", "core"],
  ["context", "fileName"], ["context", "includeDirectories"], ["context", "loadMemoryFromIncludeDirectories"],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The owner's settings without anything that starts their servers or commands, or filters Murage's. */
export function filterGeminiSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = { ...settings };
  for (const key of GEMINI_PERSONAL_SETTINGS_KEYS) delete filtered[key];
  for (const [section, key] of GEMINI_PERSONAL_NESTED_KEYS) {
    const value = filtered[section];
    if (!isRecord(value) || !(key in value)) continue;
    const rest = { ...value };
    delete rest[key];
    filtered[section] = rest;
  }
  const tools = filtered.tools;
  if (isRecord(tools) && Array.isArray(tools.exclude)) {
    filtered.tools = { ...tools, exclude: tools.exclude.filter((name) => typeof name !== "string" || !name.startsWith("mcp_")) };
  }
  for (const section of ["mcp", "tools", "context"]) {
    if (isRecord(filtered[section]) && !Object.keys(filtered[section] as object).length) delete filtered[section];
  }
  return filtered;
}

function readSettings(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readText(path));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The scoped home for this owner setup (the folder that holds their `.gemini`) and bot, built or refreshed. Always built: with no
 *  `.gemini` yet the scope starts with empty settings and no login links, so a first bot turn writes only into the scope. */
function geminiScopeSpec(realGemini: string, botId?: string): ScopedCliHomeSpec {
  const settingsPath = join(realGemini, "settings.json");
  // An unreadable or absent settings.json is not copied: the scope gets empty settings, never the owner's own file.
  return {
    kind: "gemini",
    realHome: realGemini,
    subdir: ".gemini",
    botId,
    share: GEMINI_LOGIN_ENTRIES,
    loginWrites: "in-place",
    linkOnlyWithFolder: true,
    generated: () => {
      const out: Record<string, string> = { "settings.json": `${JSON.stringify(filterGeminiSettings(readSettings(settingsPath) ?? {}), null, 2)}\n` };
      for (const name of GEMINI_COPIED_ENTRIES) {
        const path = join(realGemini, name);
        try { out[name] = readText(path); } catch { pathExists(path); }
      }
      return out;
    },
  };
}
registerScopeReconstructor("gemini", ({ realHome, botId }) => geminiScopeSpec(realHome, botId));

function scopedGeminiRoot(sourceHome: string, botId?: string): string {
  const realGemini = join(sourceHome, ".gemini");
  pathExists(realGemini); // rebuilt when the owner's folder appears: the login links are added then
  return scopedCliRoot(geminiScopeSpec(realGemini, botId));
}

/** The folder that holds the owner's `.gemini`: the home their environment names for Gemini (GEMINI_CLI_HOME, Gemini's own documented
 *  setting), else their HOME. A home already scoped by Murage (a probe's shared scope) answers with the owner folder it was built from. */
function ownerGeminiHome(env: Record<string, string | undefined>): string {
  const current = env.GEMINI_CLI_HOME;
  if (current && current.startsWith(scopedCliHomeRoot("gemini"))) {
    const built = scopeSourceOf(current);
    if (built) return dirname(built);
  } else if (current) {
    return current;
  }
  return env.HOME || env.USERPROFILE || homedir();
}

/**
 * Sets GEMINI_CLI_HOME to the scoped folder, building it if needed. The owner's own override is never passed through to a bot:
 * when their environment names a Gemini home, THAT folder is the source that is scoped (like ~/.gemini by default).
 * Worked out once per owner setup: later turns only stat what the first one read.
 * With a bot, the bot's own scope replaces the shared one a probe may have set.
 * `strict` (every turn): fails closed. A scope that cannot be established throws, and the shared probe scope is never left in
 * place for a bot (the turn path retries contention and rejects the turn before any spawn). Without it (the model-list probe
 * that shares the env transform) a failure is logged and the probe goes on.
 */
export function isolateGeminiFromPersonalSetup(env: Record<string, string | undefined>, botId?: string, strict = false): void {
  try {
    const current = env.GEMINI_CLI_HOME;
    const ours = Boolean(current) && current!.startsWith(scopedCliHomeRoot("gemini"));
    if (ours && !(botId || strict)) return; // already scoped for a probe
    const source = ownerGeminiHome(env);
    const root = memoDeps("gemini-isolate", JSON.stringify([source, botId ?? null]), () => scopedGeminiRoot(source, botId));
    // The scope is worked out once per owner setup; the path an engine is launched with (its current login generation) is resolved at EVERY launch.
    env.GEMINI_CLI_HOME = scopeEngineHome("gemini", root);
  } catch (error) {
    if (strict) throw error;
    console.warn(`gemini isolation skipped: ${(error as Error).message}`);
  }
}
