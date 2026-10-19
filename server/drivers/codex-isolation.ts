// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The owner's personal Codex setup stays out of a bot's turns (same principles
// as the Claude engine's design B, claude.ts claudeIsolation): Murage's own
// mounts stay, the owner's MCP servers and personal skills are off for this
// app-server only, sign-in and ~/.codex are untouched.
//
// MECHANISM. `-c` MERGES into same-named tables of the owner's config.toml
// (codex-mcp-names.ts), so it cannot reset `mcp_servers`; it can set
// `enabled = false` on each one, which Codex honours by never starting the
// server (the mirror case codex-mcp-names.ts documents). Personal skills
// (~/.codex/skills, ~/.agents/skills; the bundled `.system` ones stay) are
// switched off by path with `skills.config = [{ path, enabled = false }]`,
// matched against the skill's SKILL.md path.
//
// Rig (build host, codex-cli 0.146.0 and 0.160.0, `codex exec` against a fake
// Responses API, owner config.toml with 2 servers of 40+25 tools, a personal
// skill and an ~/.agents skill): before 13.2k tokens with the owner's server
// tools and skills in the request; MCP off 9.8k; skills off too, neither
// present. Both keys accepted by both versions, so no floor.
//
// An unreadable config.toml leaves the owner's servers alone (fail open; the
// turn still runs). Murage's own mounts are never disabled.
//
// GLOBAL INSTRUCTIONS. No `-c` key, flag or app-server field excludes
// $CODEX_HOME/AGENTS.md or AGENTS.override.md (rig, 0.146.0 and 0.162.1:
// project_doc_max_bytes=0, project_doc_fallback_filenames=[],
// user_instructions="" all leave them; --ignore-user-config/--ignore-rules
// exist on `exec` only). So from 0.146.0 the app-server runs with a scoped
// CODEX_HOME (scoped-cli-home.ts) that links the owner's ~/.codex through
// except AGENTS.md, AGENTS.override.md and skills/ (Codex writes its bundled
// skills/.system into the scope, not into the owner's skills). Rig:
// thread/start instructionSources [".../AGENTS.override.md"] before, [] after;
// the login refresh (stale ChatGPT auth.json, CODEX_REFRESH_TOKEN_URL_OVERRIDE)
// opens auth.json O_WRONLY|O_TRUNC through the link, in place: the owner's
// real file holds the new token and the link stays. Fails closed: a Codex whose
// version is unknown (the probe is retried once) or older than 0.2.0 (the first
// that reads CODEX_HOME and writes auth.json in place) is not started for a bot
// at all (the owner is told to update it). Where a symlink is not allowed
// (Windows without the privilege) auth.json is shared as a hardlink on the same
// volume, which stays one file because Codex writes it in place; it is checked
// at every turn and the turn is rejected if it is not (shared-login-link.ts),
// never a copy: the real CODEX_HOME is never used.
//
// NOT covered: Codex plugins/hooks, which were not present on the rig to
// prove a switch against.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { codexHome } from "./codex-catalog.ts";
import { codexScopeSpec } from "./codex-scope-spec.ts";
import { listDir, memoDeps, pathExists } from "./isolation-cache.ts";
import { currentScopeHome, engineUpdateRequired, scopedCliHome, scopedCliHomeRoot } from "./scoped-cli-home.ts";
import type { DeclaredMcpServers } from "./codex-mcp-names.ts";
import { codexGatePlan, currentCodexFloors, versionAtLeast, type CodexFloors } from "./codex-hook.ts";

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const MAX_SKILLS = 512;

/** `mcp_servers.<name>` as a TOML dotted key, quoted when the name needs it. */
function serverKey(name: string): string {
  return `mcp_servers.${BARE_KEY.test(name) ? name : JSON.stringify(name)}`;
}

/** SKILL.md files under one personal skills root (dot folders skipped: `.system` is Codex's own). */
function skillFiles(root: string, depth = 0, out: string[] = []): string[] {
  if (depth > 3 || out.length >= MAX_SKILLS) return out;
  let entries: string[] = [];
  try { entries = listDir(root); } catch { return out; }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const dir = join(root, entry);
    const file = join(dir, "SKILL.md");
    if (pathExists(file)) {
      try { out.push(realpathSync(file)); } catch { out.push(file); }
    } else skillFiles(dir, depth + 1, out);
  }
  return out;
}

export function codexPersonalSkillFiles(env: Record<string, string | undefined>): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  return memoDeps("codex-skills", JSON.stringify([codexHome(env), home]), () =>
    [...new Set([...skillFiles(join(codexHome(env), "skills")), ...skillFiles(join(home, ".agents", "skills"))])].sort());
}

/** `-c` overrides that switch off the owner's MCP servers (all but Murage's
 *  `mounted` names) and personal skills for one app-server. */
export function codexIsolationArgs(env: Record<string, string | undefined>, declared: DeclaredMcpServers, mounted: ReadonlySet<string>): string[] {
  const args: string[] = [];
  if (declared.kind === "names") {
    for (const name of [...declared.names].sort()) if (!mounted.has(name)) args.push("-c", `${serverKey(name)}.enabled=false`);
  }
  const skills = codexPersonalSkillFiles(env);
  if (skills.length) args.push("-c", `skills.config=[${skills.map((path) => `{path=${JSON.stringify(path)},enabled=false}`).join(",")}]`);
  return args;
}

export { CODEX_SHARED_ENTRIES, CODEX_CACHE_FOLDERS } from "./codex-scope-spec.ts";
/** Oldest Codex whose CODEX_HOME works and whose login is written in place. Source: openai/codex tag rust-v0.2.0, codex-rs/core/src/config.rs
 *  find_codex_home (lines 481-484 read CODEX_HOME), codex-rs/login/src/lib.rs line 78 (`options.truncate(true).write(true).create(true)`,
 *  an in-place write of auth.json); the same in-place write holds at rust-v0.20/0.30/0.50 (write_auth_json) and, as FileAuthStorage::save
 *  (core/src/auth/storage.rs, `options.truncate(true).write(true).create(true)`), at rust-v0.80, v0.100 and main. Earlier tags are
 *  alphas with no stable CODEX_HOME proof, so 0.2.0 is the earliest provable. */
export const CODEX_SCOPED_HOME_MIN = [0, 2, 0] as const;


/** First Codex whose app-server takes the kebab-case approval and sandbox names (`on-request`, `workspace-write`) on
 *  thread/start, thread/resume and turn/start. Probed offline against the npm builds, no login, no network (lane 103-codex-pin,
 *  2026-10-18): 0.56.0 (the first with thread/start) through 0.66.0 accept only `onRequest` / `workspaceWrite` /
 *  `dangerFullAccess` / `readOnly`; 0.69.0, 0.75.0, 0.80.0, 0.100.0, 0.129.0 and 0.163.0 accept only the kebab names. There is
 *  no stable 0.67 or 0.68. Below 0.56 the app-server has no thread/start (0.2.0 has no app-server at all), so no spelling applies. */
export const CODEX_KEBAB_POLICY_MIN = [0, 69, 0] as const;

/** The approval policy of a gated turn: Codex 0.149.0 and later refuse to start with the retired ask-for-everything value in their
 *  config ("is no longer supported; remove this setting"), so from there Murage sends `on-request` and its own answer path (the
 *  PreToolUse gate of codex-hook.ts, Rule 68) decides. Below CODEX_UNTRUSTED_RETIRED_MIN the driver keeps what it sent before. */
export const CODEX_APPROVAL_POLICY = "on-request";

/** Spawn pin, gated turns only: the scoped home carries a copy of the owner's config.toml, and a retired `approval_policy` there stops
 *  a current Codex before it answers `initialize`. A `-c` override wins over the file (probed: 0.163.0 with the retired value in
 *  config.toml starts under this pin), and the TOML spelling is kebab on every version. */
export const CODEX_APPROVAL_PIN_ARGS: readonly string[] = ["-c", `approval_policy="${CODEX_APPROVAL_POLICY}"`];

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** The approval policy and sandbox a Codex thread and every turn on it run under, spelled for the installed version.
 *  Below CODEX_UNTRUSTED_RETIRED_MIN (legacy): exactly what the driver sent before the pin, `untrusted` when the stop line or the
 *  routed asks must reach Murage's card, `never` under the owner's No limits, otherwise `on-request`. From there (gated) the policy is
 *  `on-request` and the PreToolUse gate stands in front of every call. The sandbox is read-only for a proposal, full access only under
 *  the owner's No limits (`fullAuto`), otherwise workspace-write. An unknown version gets the gated policy and the current spelling. */
export function codexTurnPolicy(
  cliVersion: string | undefined,
  turn: { proposalOnly: boolean; fullAuto: boolean; enforceApproval?: boolean },
  floors: CodexFloors = currentCodexFloors(),
): { approvalPolicy: string; sandbox: string } {
  const sandbox: CodexSandboxMode = turn.proposalOnly ? "read-only" : turn.fullAuto ? "danger-full-access" : "workspace-write";
  const known = /(\d+)\.(\d+)\.(\d+)/.test(cliVersion ?? "");
  const legacy = codexGatePlan(cliVersion, floors).mode === "legacy";
  const policy: string = legacy ? (turn.enforceApproval ? "untrusted" : turn.fullAuto ? "never" : "on-request") : CODEX_APPROVAL_POLICY;
  if (!known || versionAtLeast(cliVersion, CODEX_KEBAB_POLICY_MIN)) return { approvalPolicy: policy, sandbox };
  const camel = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return { approvalPolicy: camel(policy), sandbox: camel(sandbox) };
}

/** The scoped CODEX_HOME for this env on a proven Codex. Fails closed: a Codex whose version is unknown (the probe failed twice) or older than
 *  CODEX_SCOPED_HOME_MIN throws an update-required ScopeUnavailableError, and so does a home that cannot be built (a login that can be
 *  linked by symlink or, on Windows without symlink rights, by hardlink); the turn path rejects before any spawn, so Codex never starts in the owner's own CODEX_HOME.
 *  Null only when this env names a path under the scopes folder that is no scope. */
export function scopedCodexHome(env: Record<string, string | undefined>, cliVersion: string | undefined, botId?: string): string | null {
  if (!versionAtLeast(cliVersion, CODEX_SCOPED_HOME_MIN)) throw engineUpdateRequired("Codex", cliVersion?.trim() || undefined, CODEX_SCOPED_HOME_MIN);
  const realHome = codexHome(env);
  // An environment that already names one of Murage's scopes: the same scope's CURRENT login generation, resolved at this launch
  // (a path inherited from an earlier launch may be an older generation). Null for a path that is no scope.
  if (realHome.startsWith(scopedCliHomeRoot("codex"))) return currentScopeHome("codex", realHome);
  // The login is a symlink to the owner's auth.json; where a symlink is not allowed (Windows without the privilege) it is a hardlink
  // on the same volume (Codex writes auth.json in place, so a hardlink stays one file), checked every turn; never a copy (shared-login-link.ts).
  return scopedCliHome(codexScopeSpec(realHome, botId));
}
