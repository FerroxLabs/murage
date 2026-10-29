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
//   models_cache.json  a copy of the owner's model list cache (grokModelsCacheCopy)
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
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { listDir, pathExists, readText, trackPath } from "../isolation-cache.ts";
import { currentScopeHome, engineUpdateRequired, registerScopeReconstructor, scopedCliHome, scopedCliHomeRoot, type ScopedCliHomeSpec } from "../scoped-cli-home.ts";

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
 *  session/request_permission and Murage decides it by the bot's level: a card at Ask. */
export const GROK_ASK_RULES = ["Bash", "Edit", "Write"] as const;

interface TomlStatement {
  start: number;
  end: number;
  /** "header" is `[a.b]` or `[[a.b]]`; "pair" is `key = value`. */
  kind: "header" | "pair";
  /** The decoded key path: `"mcp_servers" . 'x'` is ["mcp_servers", "x"]. */
  path: string[];
}

class TomlScanError extends Error {}

/** A tolerant TOML statement scanner: it finds each table header and each key/value pair (with the full extent of a value, even across lines), decoding quoted keys. It does not validate values. */
function scanToml(text: string): TomlStatement[] {
  const out: TomlStatement[] = [];
  let i = 0;
  const n = text.length;
  const skipBlank = () => { while (i < n && (text[i] === " " || text[i] === "\t")) i++; };
  const endOfLine = () => { while (i < n && text[i] !== "\n") i++; if (i < n) i++; };
  const keyPart = (): string => {
    skipBlank();
    const c = text[i];
    if (c === '"') {
      let value = "";
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\n") throw new TomlScanError("newline in key");
        if (text[i] === "\\") {
          const e = text[i + 1];
          const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
          if (e && e in simple) { value += simple[e]; i += 2; continue; }
          const width = e === "u" ? 4 : e === "U" ? 8 : 0;
          const hex = width ? text.slice(i + 2, i + 2 + width) : "";
          if (!width || !new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) throw new TomlScanError("bad escape in key");
          value += String.fromCodePoint(parseInt(hex, 16));
          i += 2 + width;
          continue;
        }
        value += text[i++];
      }
      if (text[i] !== '"') throw new TomlScanError("unterminated key");
      i++;
      return value;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const nl = text.indexOf("\n", i + 1);
      if (close < 0 || (nl >= 0 && nl < close)) throw new TomlScanError("unterminated key");
      const value = text.slice(i + 1, close);
      i = close + 1;
      return value;
    }
    const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i, i + 256));
    if (!m) throw new TomlScanError("bad key");
    i += m[0].length;
    return m[0];
  };
  const keyPath = (): string[] => {
    const path = [keyPart()];
    for (;;) {
      skipBlank();
      if (text[i] !== ".") return path;
      i++;
      path.push(keyPart());
    }
  };
  /** Past one value, inside any nesting and across lines. */
  const skipValue = () => {
    let depth = 0;
    while (i < n) {
      const c = text[i]!;
      if (c === '"' || c === "'") {
        const triple = c.repeat(3);
        if (text.startsWith(triple, i)) {
          const close = (() => {
            let at = i + 3;
            for (;;) {
              at = text.indexOf(triple, at);
              if (at < 0) return -1;
              if (c === '"' && text[at - 1] === "\\" && text[at - 2] !== "\\") { at++; continue; }
              let end = at + 3;
              while (text[end] === c) end++; // up to two extra quotes belong to the string
              return Math.min(end, at + 5);
            }
          })();
          if (close < 0) throw new TomlScanError("unterminated string");
          i = close;
          continue;
        }
        i++;
        while (i < n && text[i] !== c) {
          if (text[i] === "\n") throw new TomlScanError("newline in string");
          if (c === '"' && text[i] === "\\") i++;
          i++;
        }
        if (i >= n) throw new TomlScanError("unterminated string");
        i++;
        continue;
      }
      if (c === "[" || c === "{") { depth++; i++; continue; }
      if (c === "]" || c === "}") { depth--; i++; if (depth < 0) throw new TomlScanError("unbalanced"); continue; }
      if (c === "#") { while (i < n && text[i] !== "\n") i++; continue; }
      if (c === "\n") { if (depth === 0) return; i++; continue; }
      i++;
    }
    if (depth !== 0) throw new TomlScanError("unterminated value");
  };
  while (i < n) {
    const start = i;
    skipBlank();
    const c = text[i];
    if (i >= n) break;
    if (c === "\n" || c === "\r") { endOfLine(); continue; }
    if (c === "#") { endOfLine(); continue; }
    if (c === "[") {
      i++;
      const array = text[i] === "[";
      if (array) i++;
      const path = keyPath();
      skipBlank();
      if (text[i] !== "]") throw new TomlScanError("unterminated header");
      i++;
      if (array) { if (text[i] !== "]") throw new TomlScanError("unterminated header"); i++; }
      endOfLine();
      out.push({ start, end: i, kind: "header", path });
      continue;
    }
    const path = keyPath();
    skipBlank();
    if (text[i] !== "=") throw new TomlScanError("expected =");
    i++;
    skipValue();
    endOfLine();
    out.push({ start, end: i, kind: "pair", path });
  }
  return out;
}

/** grok's config.toml without the `mcp_servers`, `hooks`, `skills` and `permission` tables and keys, whatever way they are written: `[mcp_servers.x]`, `[[hooks.y]]`, a quoted `"mcp_servers" = { ... }` (also across lines), or a dotted `hooks.a.b = ...`. Decided on the parsed key, not the line text. Everything else (models, keys, features, comments) is kept byte for byte. A file this scanner cannot read is not copied at all: grok would not read it either, and none of its text may reach a bot turn. */
export function filterGrokConfigToml(text: string): string {
  let statements: TomlStatement[];
  try { statements = scanToml(text); } catch { return ""; }
  let out = "";
  let at = 0;
  let table: string[] = [];
  for (const [index, statement] of statements.entries()) {
    let personal: boolean;
    let inTable = true;
    if (statement.kind === "header") {
      table = statement.path;
      personal = PERSONAL_ROOTS.has(table[0]!);
    } else {
      inTable = table.length > 0;
      personal = PERSONAL_ROOTS.has([...table, ...statement.path][0]!);
    }
    if (!personal) continue;
    out += text.slice(at, statement.start);
    // A dropped table takes its comments and blank lines with it, up to the next statement.
    at = inTable ? (statements[index + 1]?.start ?? text.length) : statement.end;
  }
  return out + text.slice(at);
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
 *  `[permission] ask` rules (GROK_ASK_RULES). */
export function scopedGrokConfigToml(ownerConfig: string, agentsSkills: readonly string[]): string {
  let out = filterGrokConfigToml(ownerConfig);
  const sep = () => (!out || out.endsWith("\n\n") ? "" : out.endsWith("\n") ? "\n" : "\n\n");
  if (agentsSkills.length) out += `${sep()}[skills]\ndisabled = [${agentsSkills.map((name) => JSON.stringify(name)).join(", ")}]\n`;
  return `${out}${sep()}[permission]\nask = [${GROK_ASK_RULES.map((rule) => JSON.stringify(rule)).join(", ")}]\n`;
}

/** The real grok home this env names (an explicit GROK_HOME the owner set, else ~/.grok). */
export function realGrokHome(env: Record<string, string | undefined>): string {
  return env.GROK_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".grok");
}

/** The owner's grok model list cache, copied (never linked) into the scope so a bot's grok offers the same models as
 *  the owner's. Derived data grok refetches itself: no login, no personal setup. Only a regular file is copied (a
 *  link is never followed), up to GROK_MODELS_CACHE_MAX bytes and only when it parses as JSON; anything else is left
 *  out and the scope's grok uses its built-in list. It is a generated copy (scoped-cli-home.ts): rewritten by
 *  temporary file and rename on every build, removed when the owner's is gone, and never one of the shared logins. */
export const GROK_MODELS_CACHE = "models_cache.json";
const GROK_MODELS_CACHE_MAX = 4 * 1024 * 1024;
export function grokModelsCacheCopy(realHome: string): Record<string, string> {
  const path = join(realHome, GROK_MODELS_CACHE);
  trackPath(path);
  let fd: number | undefined;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > GROK_MODELS_CACHE_MAX) return {};
    // Opened without following a link (where the platform has O_NOFOLLOW) and checked to be the same file lstat saw.
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size > GROK_MODELS_CACHE_MAX) return {};
    const text = readFileSync(fd, "utf8");
    JSON.parse(text);
    return { [GROK_MODELS_CACHE]: text };
  } catch {
    return {};
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function grokScopeSpec(realHome: string, botId: string | undefined, skillsHome: string): ScopedCliHomeSpec {
  return {
    kind: "grok",
    realHome,
    botId,
    share: GROK_LOGIN_ENTRIES,
    locks: ["auth.json.lock"], // shared with the owner's own grok where the owner's exists; never reconciled as a login
    cache: ["logs"], // rig (grok 1.0.x, fake home): logs/unified.jsonl; sessions/ is the conversation and stays
    rebuildInputs: { skillsHome },
    generated: () => {
      let config = "";
      try { config = readText(join(realHome, "config.toml")); } catch { pathExists(join(realHome, "config.toml")); }
      return { "config.toml": scopedGrokConfigToml(config, agentsSkillNames(skillsHome)), ...grokModelsCacheCopy(realHome) };
    },
  };
}
registerScopeReconstructor("grok", ({ realHome, botId, inputs }) => grokScopeSpec(realHome, botId, inputs.skillsHome ?? homedir()));

/** Point GROK_HOME at the scoped home on a proven grok (see the header). Throws when the scope cannot be built. */
export function scopeGrokHome(env: Record<string, string | undefined>, cliVersion: string | undefined, botId?: string): void {
  // Fails closed: no catch here. The turn path retries contention and rejects the turn (withScopeRetry) rather than start in the owner's own home.
  // A version that is unknown (the probe was retried) or older than the first proven one is rejected, not run unscoped.
  if (!atLeast(cliVersion, GROK_SCOPED_HOME_MIN)) throw engineUpdateRequired("Grok", cliVersion?.trim() || undefined, GROK_SCOPED_HOME_MIN);
  const realHome = realGrokHome(env);
  if (realHome.startsWith(scopedCliHomeRoot("grok"))) { const current = currentScopeHome("grok", realHome); if (current) env.GROK_HOME = current; return; } // already scoped: its current login generation
  env.GROK_HOME = scopedCliHome(grokScopeSpec(realHome, botId, env.HOME || env.USERPROFILE || homedir()));
}
