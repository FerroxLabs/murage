// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The spec of a bot's scoped CODEX_HOME, in one place so a process that did not build the scope (the model catalog, a nested launch)
// can rebuild it from the scope's marker and refresh the generated config like the builder does (registerScopeReconstructor).
import { join } from "node:path";

import { pathExists, readText } from "./isolation-cache.ts";
import { registerScopeReconstructor, type ScopedCliHomeSpec } from "./scoped-cli-home.ts";

/** The one entry of the owner's CODEX_HOME linked into a bot's scoped home: the login. Sessions, history,
 *  skills and AGENTS.md are the bot's own (a state root per bot, scoped-cli-home.ts); config.toml is a copy. */
export const CODEX_SHARED_ENTRIES = ["auth.json"] as const;
/** Folders of a bot's Codex home that only hold logs, scratch and rebuildable snapshots: all that is pruned past the scope's byte cap (never sessions, config or the login). */
export const CODEX_CACHE_FOLDERS = ["log", "logs", "tmp", "cache", "shell_snapshots"] as const;

export function codexScopeSpec(realHome: string, botId?: string): ScopedCliHomeSpec {
  // The login is a symlink to the owner's auth.json; where a symlink is not allowed (Windows without the privilege) it is a hardlink
  // on the same volume (Codex writes auth.json in place, so a hardlink stays one file), checked every turn; never a copy (shared-login-link.ts).
  return {
    kind: "codex",
    realHome,
    botId,
    share: CODEX_SHARED_ENTRIES,
    loginWrites: "in-place",
    cache: CODEX_CACHE_FOLDERS,
    // The owner's config (model, provider, trust) as a copy: Codex's own writes to it stay in the bot's scope.
    generated: (): Record<string, string> => {
      const path = join(realHome, "config.toml");
      try { return { "config.toml": readText(path) }; } catch { pathExists(path); return {}; }
    },
  };
}

registerScopeReconstructor("codex", ({ realHome, botId }) => codexScopeSpec(realHome, botId));
