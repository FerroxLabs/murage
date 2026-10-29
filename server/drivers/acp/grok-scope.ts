// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Grok's NATIVE personal setup (~/.grok: config.toml [mcp_servers] and hooks,
// hooks/, skills/, rules/, AGENTS.md, plugins/) has no flag, env or GROK_CONFIG
// overlay that turns it off: the overlay accepts only models, features,
// toolset and shell_environment_policy (rig, grok 1.0.50: disabled_mcp_servers,
// mcp_servers.x.enabled, skills.disabled, hooks and allow_managed_hooks_only
// were all dropped from the overlay). The supported lever is GROK_HOME.
//
// So a bot turn on grok 1.0.50+ points GROK_HOME at a Murage-owned folder, one
// per bot (scoped-cli-home.ts), holding:
//   auth.json, auth.json.lock   links to the owner's real login (linked even
//                 before a first sign-in)
//   config.toml   a copy without the mcp_servers, hooks, skills and permission
//                 tables and keys (decided on the parsed key, so quoted keys do
//                 not slip through), plus `[skills] disabled` naming every
//                 ~/.agents skill (grok reads that shared folder from HOME; rig:
//                 its marker reached the prompt until disabled here) and the
//                 bot's own `[permission] ask` rules (GROK_ASK_RULES)
// Sessions, history, caches, rules, skills, hooks, plugins and AGENTS.md are the
// bot's own: the owner's are absent, and one bot never sees another's.
//
// LOGIN REFRESH (rig, grok 1.0.50, fake OIDC issuer via GROK_OIDC_ISSUER,
// grant=refresh_token, strace): grok resolves the auth.json symlink first
// (readlink), writes `.<pid>.tmp` in the TARGET's folder and renames it onto
// the target. The owner's real auth.json is updated and the scoped path stays
// a symlink: the refreshed token is never forked. auth.json.lock is opened
// through the link, so the lock is shared with the owner's own grok.
// grok also rewrites config.toml (a [marketplace] key): it lands in the scoped
// copy, never in the owner's file.
//
// The folder is stable per (real grok home, bot) (sessions resume across turns)
// and refreshed in place when the owner's ~/.grok changes: missing links are
// added, the config copy is rewritten, and nothing grok wrote in the scope is
// removed. Fails closed: below 1.0.50 (the only version proven) or with a version
// that cannot be read (the probe is retried once) the bot's turn is rejected and
// the owner is told to update grok. Windows is scoped the same way: GROK_HOME is
// the same lever there. Grok replaces auth.json by temporary file and rename
// (xai-grok-login/src/storage.rs write_auth_json_atomic), which would separate a
// hardlink, so where a symlink is not allowed the turn is rejected with guidance to
// enable symlinks (Developer Mode); the login is never copied or reconciled
// (shared-login-link.ts).
import { homedir } from "node:os";
import { join } from "node:path";

import { listDir, pathExists, readText } from "../isolation-cache.ts";
import { filterTomlPaths } from "./toml-scan.ts";
import { ownerDenyRules } from "./fuigo-permission.ts";
import { currentScopeHome, engineConfigInvalid, engineUpdateRequired, registerScopeReconstructor, scopedCliHome, scopedCliHomeRoot, type ScopedCliHomeSpec } from "../scoped-cli-home.ts";

/** Linked into a bot's scope, even when absent: the login and its lock. Everything else of ~/.grok (sessions, history, personal setup) is not shared; config.toml is a filtered copy. */
export const GROK_LOGIN_ENTRIES = ["auth.json", "auth.json.lock"] as const;
/** First grok with COMPLETE isolation. GROK_HOME itself is honoured by the published source from 1.0.45 (xai-org/grok-build
 *  crates/codegen/xai-grok-pager/Cargo.toml version 1.0.45; tests/grok_home_paths.rs; docs/user-guide/05-configuration.md), but a scope is only
 *  whole when the personal plugins that live OUTSIDE GROK_HOME are shadowed too, and `--plugin-dir` shadows only from 1.0.50 (rig,
 *  GROK_PLUGIN_SHADOW_MIN in grok.ts: 1.0.45-1.0.49 accept the flag but still load the owner's plugin). So the floor stays at 1.0.50;
 *  an earlier grok would run with the owner's plugin servers inside a bot. */
export const GROK_SCOPED_HOME_MIN = [1, 0, 50] as const;

function atLeast(version: string | undefined, min: readonly number[]): boolean {
  const m = /(?:^|[^\d.])(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  return v[0]! !== min[0]! ? v[0]! > min[0]! : v[1]! !== min[1]! ? v[1]! > min[1]! : v[2]! >= min[2]!;
}

/** Top-level keys whose tables start or run the owner's own servers and commands, plus `permission`: Murage writes
 *  the bot's own permission rules (GROK_ASK_RULES), and a second `[permission]` table would make the file unreadable. */
const PERSONAL_ROOTS = new Set(["mcp_servers", "hooks", "skills", "permission"]);

/** The bot's permission rules (grok's compact `[permission] ask` form). In `--permission-mode default` grok runs
 *  its own "read-only" shell commands without asking anyone: echo, printf, ls, cat, mkdir, touch and more (grok
 *  1.0.62 xai-grok-permission-rules; docs "Operations That Never Prompt by Default"), and a rule the owner allows
 *  in ~/.grok or ~/.claude settings approves a call the same way. An `ask` rule outranks both (grok evaluates deny >
 *  ask > allow, before its built-in approvals), so every shell command, edit and write sends
 *  session/request_permission and Murage decides it by the bot's level: a card at Ask.
 *  FUIGO-SCOPE-1010 (Grok fold, V1/V7): file reads and searches reach Murage too. `Read(**)` is path-scoped on
 *  purpose: a pattern never matches a read with no path (to-do updates, plan mode, a list of the cwd), so those
 *  never card. `Grep` is bare, so a search with no path argument (the cwd) asks as well; only grep, grep_files and
 *  glob are of that class. At Full access and No limits Murage answers these itself, allow_once only, no card. */
export const GROK_ASK_RULES = ["Bash", "Edit", "Write", "Read(**)", "Grep"] as const;

/** grok's config.toml without the `mcp_servers`, `hooks`, `skills` and `permission` tables and keys, whatever way they are written: `[mcp_servers.x]`, `[[hooks.y]]`, a quoted `"mcp_servers" = { ... }` (also across lines), or a dotted `hooks.a.b = ...`. Decided on the parsed key, not the line text. Everything else (models, keys, features, comments) is kept byte for byte. A file this scanner cannot read is not copied at all: grok would not read it either, and none of its text may reach a bot turn. */
export function filterGrokConfigToml(text: string): string {
  return filterTomlPaths(text, (path) => PERSONAL_ROOTS.has(path[0]!));
}

/** Skill names under ~/.agents/skills (the shared open location grok reads from HOME,
 *  outside GROK_HOME): frontmatter `name`, and the folder name. */
export function agentsSkillNames(home: string): string[] {
  const root = join(home, ".agents", "skills");
  const names = new Set<string>();
  let entries: string[] = [];
  try { entries = listDir(root); } catch { pathExists(root); return []; }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    let text = "";
    try { text = readText(join(root, entry, "SKILL.md")); } catch { continue; }
    names.add(entry);
    const name = /^---[\s\S]*?^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(text)?.[1];
    if (name) names.add(name.trim());
  }
  return [...names].sort().slice(0, 512);
}

/** The scoped config.toml: the owner's, filtered, plus `[skills] disabled` for ~/.agents skills and the bot's
 *  `[permission] ask` rules (GROK_ASK_RULES). The owner's own deny rules come back in the same table (FUIGO-SCOPE-1010
 *  H3: owner denies outrank everything, and grok evaluates deny > ask > allow); one that cannot be carried exactly is
 *  dropped and logged, and stays enforced in the owner's own grok. */
export function scopedGrokConfigToml(ownerConfig: string, agentsSkills: readonly string[], log: (line: string) => void = (line) => console.warn(line), denyConfig: string = ownerConfig): string {
  let out = filterGrokConfigToml(ownerConfig);
  const sep = () => (!out || out.endsWith("\n\n") ? "" : out.endsWith("\n") ? "\n" : "\n\n");
  if (agentsSkills.length) out += `${sep()}[skills]\ndisabled = [${agentsSkills.map((name) => JSON.stringify(name)).join(", ")}]\n`;
  const owner = ownerDenyRules(denyConfig);
  for (const dropped of owner.dropped) log(`Grok: an owner deny rule could not be carried into the bot's settings and is enforced only in the owner's own grok: ${dropped}`);
  const deny = owner.rules.length ? `deny = [${owner.rules.map((rule) => JSON.stringify(rule)).join(", ")}]\n` : "";
  return `${out}${sep()}[permission]\nask = [${GROK_ASK_RULES.map((rule) => JSON.stringify(rule)).join(", ")}]\n${deny}`;
}

/** Set by provider-routing.ts on a provider-routed Grok turn: the owner's own grok home, read before GROK_HOME was
 *  pointed at the per-thread provider home. The scope built over that provider home carries the owner's denies from
 *  here, never from the provider home (FUIGO-SCOPE-1010 H3, P10 routed). */
export const MURAGE_GROK_OWNER_HOME = "MURAGE_GROK_OWNER_HOME";

/** The real grok home this env names (an explicit GROK_HOME the owner set, else ~/.grok). */
export function realGrokHome(env: Record<string, string | undefined>): string {
  return env.GROK_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".grok");
}

function grokScopeSpec(realHome: string, botId: string | undefined, skillsHome: string, denyHome = realHome): ScopedCliHomeSpec {
  return {
    kind: "grok",
    realHome,
    botId,
    share: GROK_LOGIN_ENTRIES,
    locks: ["auth.json.lock"], // shared with the owner's own grok where the owner's exists; never reconciled as a login
    cache: ["logs"], // rig (grok 1.0.x, fake home): logs/unified.jsonl; sessions/ is the conversation and stays
    rebuildInputs: denyHome === realHome ? { skillsHome } : { skillsHome, denyHome },
    generated: () => {
      // A5: only a config that is not there is "no settings". One that exists and cannot be read (EACCES, EIO, a folder in its
      // place) would otherwise drop every owner deny, so the turn is refused (the core never starts it), as Fuigo's is.
      const read = (home: string) => {
        const path = join(home, "config.toml");
        try { return readText(path); } catch (error) {
          pathExists(path);
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") return "";
          throw engineConfigInvalid("Grok", error, "plain");
        }
      };
      const config = read(realHome);
      return { "config.toml": scopedGrokConfigToml(config, agentsSkillNames(skillsHome), undefined, denyHome === realHome ? config : read(denyHome)) };
    },
  };
}
registerScopeReconstructor("grok", ({ realHome, botId, inputs }) => grokScopeSpec(realHome, botId, inputs.skillsHome ?? homedir(), inputs.denyHome ?? realHome));

/** Point GROK_HOME at the scoped home on a proven grok (see the header). Throws when the scope cannot be built. */
export function scopeGrokHome(env: Record<string, string | undefined>, cliVersion: string | undefined, botId?: string): void {
  // Fails closed: no catch here. The turn path retries contention and rejects the turn (withScopeRetry) rather than start in the owner's own home.
  // A version that is unknown (the probe was retried) or older than the first proven one is rejected, not run unscoped.
  if (!atLeast(cliVersion, GROK_SCOPED_HOME_MIN)) throw engineUpdateRequired("Grok", cliVersion?.trim() || undefined, GROK_SCOPED_HOME_MIN);
  const realHome = realGrokHome(env);
  if (realHome.startsWith(scopedCliHomeRoot("grok"))) { const current = currentScopeHome("grok", realHome); if (current) env.GROK_HOME = current; return; } // already scoped: its current login generation
  env.GROK_HOME = scopedCliHome(grokScopeSpec(realHome, botId, env.HOME || env.USERPROFILE || homedir(), env[MURAGE_GROK_OWNER_HOME] || realHome));
}
