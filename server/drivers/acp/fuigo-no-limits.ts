// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../atomic.ts";
import { pathExists, readText } from "../isolation-cache.ts";
import { registerScopeReconstructor, scopedCliHome, scopeSourceOf, scopedCliHomeRoot, type ScopedCliHomeSpec } from "../scoped-cli-home.ts";
import { filterGrokConfigToml } from "./grok-scope.ts";
import { linkNoLimitsState } from "../no-limits-state.ts";

const KIND = "fuigo-no-limits";
const PERMISSION_ROOTS = new Set(["permission", "permissions", "ui", "sandbox", "folder_trust", "claude_compat"]);
const SHARED_STATE = ["sessions", "skills", "hooks", "agents", "logs"];

function noLimitsConfig(home: string): string {
  let text = "";
  try { text = readText(join(home, "config.toml")); } catch { /* an empty owner config is valid */ }
  return `${filterGrokConfigToml(text, PERMISSION_ROOTS)}\n[claude_compat]\nimported = true\n`;
}

/** Native user denies and mode pins must not outrank the owner's No limits
 * choice. The unchanged launch ask policy still routes every call to Murage's
 * wipe/catastrophe verdict. No rules or credentials are changed in the real home. */
function spec(realHome: string, botId?: string): ScopedCliHomeSpec {
  // Sessions and the owner's extensions are the same state at every level.
  // Only native permission configuration gets a filtered, private copy.
  for (const name of SHARED_STATE) if (!pathExists(join(realHome, name))) mkdirSync(join(realHome, name), { recursive: true, mode: 0o700 });
  const privateFiles = new Set(["config.toml", "trusted_folders.toml", "permissions.toml", "permission.toml", "policy.toml"]);
  const share = [...new Set(["auth.json", "auth.json.lock", ...readdirSync(realHome)])].filter(name => !privateFiles.has(name));
  return { kind: KIND, realHome, botId, share, mergeSharedDirectories: ["sessions"], locks: ["auth.json.lock"],
    generated: () => ({ "config.toml": noLimitsConfig(realHome) }) };
}
registerScopeReconstructor(KIND, ({ realHome, botId }) => spec(realHome, botId));
export function applyFuigoNoLimitsHome(env: Record<string, string | undefined>, botId?: string): void {
  const current = env.FUIGO_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".fuigo");
  const realHome = current.startsWith(scopedCliHomeRoot(KIND)) ? scopeSourceOf(current) ?? current : current;
  env.FUIGO_HOME = scopedCliHome(spec(realHome, botId));
  linkNoLimitsState(env.FUIGO_HOME, realHome, ["sessions", "logs", ...["skills", "hooks", "agents", "AGENTS.md"].filter(name => pathExists(join(realHome, name)))]);
}

/** The private launch home shares native state without sharing a saved folder grant. */
export function populateFuigoNoLimitsTurnHome(sourceHome: string, turnHome: string): void {
  const stateHome = sourceHome.startsWith(scopedCliHomeRoot(KIND)) ? scopeSourceOf(sourceHome) ?? sourceHome : sourceHome;
  writeFileAtomic(join(turnHome, "config.toml"), noLimitsConfig(stateHome), { mode: 0o600 });
  linkNoLimitsState(turnHome, stateHome, SHARED_STATE);
}
