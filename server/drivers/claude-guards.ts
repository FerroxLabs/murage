// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What stands between a Claude Code CLI and a Murage spawn: the qualified minimum version (a cheap
// `--version` probe before any launch), and, as the fallback for whatever the probe cannot see,
// the CLI's own refusal of the isolation flags in Murage's words.
import { realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { execCli, resolveCli } from "../procs.ts";
import { engineLaunchFile } from "./isolation-cache.ts";

/** The oldest Claude Code Murage runs a bot on: 2.1.280, the floor Murage 1.0.1 already had (the
 * CLI itself answers "version 2.1.280 or newer is required" to anything older, claude.ts), so no
 * owner who could chat on 1.0.1 is refused here. Every isolation control claudeIsolation relies on
 * was proven on the build host stub-API rig with 2.1.280, 2.1.281 and 2.1.295, each case with and
 * without the flags (2026-10-10): disableAllHooks, flag-level enabledPlugins (marketplace and
 * `@skills-dir` ids), claudeMdExcludes for CLAUDE.md and rules, skillOverrides for skills and nested
 * commands, outputStyle, agent, permissions.deny Agent(<name>), and the flag-level env override of
 * CLAUDE_CODE_PLUGIN_DIRS. Nothing in the isolation raises the floor. */
export const CLAUDE_MIN_VERSION = "2.1.280";

/** `2.1.295 (Claude Code)` -> [2, 1, 295]; null when no version is in the text. */
export function parseClaudeVersion(text: string): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True only for a version that parses and is older than the minimum. */
export function claudeVersionBelow(version: string, minimum = CLAUDE_MIN_VERSION): boolean {
  const have = parseClaudeVersion(version);
  const need = parseClaudeVersion(minimum);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) if (have[i]! !== need[i]!) return have[i]! < need[i]!;
  return false;
}

/** Raised before any launch when the installed Claude Code is older than the qualified minimum. The
 * turn settles through the same update_required path as a CLI that refuses a model or a flag. */
export class ClaudeUpdateRequired extends Error {
  readonly version: string;
  readonly code = "update_required";
  constructor(version: string) {
    super(CLAUDE_UPDATE_MESSAGE);
    this.name = "ClaudeUpdateRequired";
    this.version = version;
  }
}

/** A probe that could not answer is not retried for this long: the turn launches without the floor
 * check (fail-open, logged) instead of paying the probe's timeout on every turn. */
export const VERSION_FAILURE_BACKOFF_MS = 10 * 60_000;
/** A good answer stands while the executable is unchanged; this only bounds how long a wrapper
 * script whose target changed underneath it can be trusted. */
const VERSION_SUCCESS_TTL_MS = 6 * 60 * 60_000;
interface VersionEntry { identity: string; at: number; version: Promise<string | null>; failed?: boolean; logged?: boolean }
const versionCache = new Map<string, VersionEntry>();
const loggedUnknown = new Set<string>();
export function resetClaudeVersionGate(): void { versionCache.clear(); loggedUnknown.clear(); }

/** The verdict on `cli --version`: "below" for a parsed version older than the minimum, "unknown"
 * for output with no version in it (allowed, and logged once per CLI and answer), "ok" otherwise. */
export function claudeVersionVerdict(output: string): "ok" | "below" | "unknown" {
  if (!parseClaudeVersion(output)) return "unknown";
  return claudeVersionBelow(output) ? "below" : "ok";
}

/** Path, mtime and size of each file the configured CLI launches through (the executable found on
 * the spawn PATH, and a Windows shim's script), so an update or reinstall is a new identity and is
 * probed again, and an unchanged CLI never is. Never its contents. */
export function claudeExecutableIdentity(cli: string, env: NodeJS.ProcessEnv): string {
  const resolved = resolveCli(cli, []);
  const found = (name: string): string | undefined => {
    if (isAbsolute(name) || name.includes("/") || name.includes("\\")) return name;
    for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
      if (!dir) continue;
      const path = join(dir, name);
      try { if (statSync(path).isFile()) return path; } catch { /* next */ }
    }
    return undefined;
  };
  const stamp = (path: string | undefined): string => {
    if (!path) return "?";
    try {
      const real = realpathSync(path);
      const s = statSync(real);
      return `${real}@${s.mtimeMs}:${s.size}`;
    } catch { return `${path}@?`; }
  };
  const files = [stamp(found(resolved.command)), ...resolved.args.filter((arg) => isAbsolute(arg)).map(stamp)];
  return [cli, ...files].join("\n");
}

/** The X.Y.Z of the `--version` answer last probed for `cli`, or null when none is known (never probes). */
export async function knownClaudeCliVersion(cli: string): Promise<string | null> {
  const entry = versionCache.get(cli);
  if (!entry) return null;
  const answer = await entry.version;
  return answer?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

/** Throws ClaudeUpdateRequired when `cli --version` reports less than the minimum. The answer is held
 * per executable identity (claudeExecutableIdentity): an unchanged CLI is probed once. A probe that
 * fails (no answer, timeout) or prints no version lets the launch go ahead, logged, and a failure is
 * not probed again for VERSION_FAILURE_BACKOFF_MS: a previously working owner keeps chatting, and the
 * CLI's own refusal of an unknown flag (claudeLaunchRefusal) still stands behind it. `signal` (the
 * turn's Stop) ends the wait at once without throwing; the caller's own stop check takes over. */
export async function requireClaudeCliVersion(cli: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, run: typeof execCli = execCli, probeEnv?: () => Promise<NodeJS.ProcessEnv>): Promise<void> {
  if (signal?.aborted) return;
  const now = Date.now();
  const identity = claudeExecutableIdentity(cli, env);
  let entry = versionCache.get(cli);
  if (!entry || entry.identity !== identity || now - entry.at > (entry.failed ? VERSION_FAILURE_BACKOFF_MS : VERSION_SUCCESS_TTL_MS)) {
    const fresh: VersionEntry = { identity, at: now, version: Promise.resolve(null) };
    // the probe runs on `probeEnv` when given (the handed map a turn gets); a hand that cannot be made is a failed probe
    fresh.version = (probeEnv ? probeEnv().catch(() => null) : Promise.resolve(env)).then((spawnEnv) => new Promise<string | null>((resolveVersion) => {
      const failed = () => { fresh.failed = true; fresh.at = Date.now(); resolveVersion(null); };
      if (!spawnEnv) return failed();
      // The file probed is the file the turn launches: resolved from the Murage env's PATH (engineLaunchFile), never the handed
      // map's shell PATH, which can name another build first. The handed map is only the env the probe runs with. No file
      // on that PATH is a failed probe, as an unspawnable cli always was.
      let probeFile: string;
      try { probeFile = engineLaunchFile(cli, { PATH: env.PATH }); } catch { return failed(); }
      run(probeFile, ["--version"], { timeout: 8000, env: spawnEnv }, (err, stdout) => {
        const answer = err ? null : String(stdout ?? "").trim();
        // the backoff runs from the failure, not from when the probe started
        if (answer === null) return failed();
        resolveVersion(answer);
      });
    }));
    entry = fresh;
    versionCache.set(cli, entry);
  }
  const pending = entry;
  const version = signal
    ? await new Promise<string | null | "aborted">((resolveWait) => {
        const onAbort = () => resolveWait("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
        pending.version.then((value) => { signal.removeEventListener("abort", onAbort); resolveWait(value); });
      })
    : await pending.version;
  if (version === "aborted") return;
  if (version === null) {
    if (!pending.logged) {
      pending.logged = true;
      console.warn(`claude: '${cli} --version' did not answer; launching without the ${CLAUDE_MIN_VERSION} floor check (next probe in ${VERSION_FAILURE_BACKOFF_MS / 60_000} min)`);
    }
    return;
  }
  const verdict = claudeVersionVerdict(version);
  if (verdict === "below") throw new ClaudeUpdateRequired(parseClaudeVersion(version)!.join("."));
  if (verdict === "unknown" && !loggedUnknown.has(`${cli}\n${version}`)) {
    loggedUnknown.add(`${cli}\n${version}`);
    console.warn(`claude: '${cli} --version' printed no version (${JSON.stringify(version.slice(0, 80))}); launching without the ${CLAUDE_MIN_VERSION} floor check`);
  }
}

export const CLAUDE_MANAGED_MCP_CONFLICT = "CLAUDE_MANAGED_MCP_CONFLICT";

export const CLAUDE_UPDATE_MESSAGE = "Claude Code needs an update to run Murage's bots. Run 'claude update', then try again.";
export const CLAUDE_MANAGED_MCP_MESSAGE =
  "This computer's managed Claude Code policy (managed-mcp.json) decides which MCP servers run, so Murage can't add its own tools beside it. Ask your administrator to allow Murage, or pick another engine for this bot.";

export interface ClaudeLaunchRefusal {
  stopReason: "update_required" | "managed_mcp_conflict";
  message: string;
  claudeUpdate?: true;
  errorKind?: typeof CLAUDE_MANAGED_MCP_CONFLICT;
}

/** The flags Murage launches Claude Code with (turns, helpers and the auth probe). Only a refusal
 * of one of these is ours to translate: an unknown option the owner smuggled in some other way is
 * not an update prompt. */
export const CLAUDE_LAUNCH_FLAGS = [
  "--strict-mcp-config", "--mcp-config", "--settings", "--disallowedTools", "--allowedTools", "--tools", "--effort",
  "--append-system-prompt-file", "--include-partial-messages", "--no-session-persistence", "--add-dir",
  "--permission-mode", "--permission-prompt-tool", "--session-id", "--resume", "--model", "--output-format",
  "--input-format", "--verbose",
] as const;
const LAUNCH_FLAG = new Set<string>(CLAUDE_LAUNCH_FLAGS);

/** Reads a CLI's startup output for a refusal of Murage's own command line. Two answers count:
 * `error: unknown option '--x'` for one of CLAUDE_LAUNCH_FLAGS (a release older than the flag;
 * commander's wording on 2.1.281 and 2.1.295, with or without `error:` and in either quote, and
 * `--x=value`), and the refusal of `--strict-mcp-config` when a managed MCP policy is deployed
 * (`You cannot use --strict-mcp-config when an enterprise MCP config is present`, both versions on
 * the rig). Anything else, including an unknown option that is not ours, is not a refusal. Callers
 * pass only what the CLI printed before it started work (no `init` yet, or a one-shot that
 * failed), never a running turn's later output. */
export function claudeLaunchRefusal(output: string): ClaudeLaunchRefusal | null {
  if (/you cannot use --strict-mcp-config when an enterprise MCP config is present/i.test(output)) {
    return { stopReason: "managed_mcp_conflict", message: CLAUDE_MANAGED_MCP_MESSAGE, errorKind: CLAUDE_MANAGED_MCP_CONFLICT };
  }
  for (const match of output.matchAll(/^\s*(?:error:\s*)?unknown option:?\s*['"`]?(--[A-Za-z][\w-]*)/gim)) {
    if (LAUNCH_FLAG.has(match[1]!)) return { stopReason: "update_required", message: CLAUDE_UPDATE_MESSAGE, claudeUpdate: true };
  }
  return null;
}

/** The same refusal as an Error for one-shot helper calls, with `code` set to
 * CLAUDE_MANAGED_MCP_CONFLICT or `update_required`. */
export function claudeLaunchRefusalError(output: string): (Error & { code: string }) | null {
  const refusal = claudeLaunchRefusal(output);
  if (!refusal) return null;
  const error = new Error(refusal.message) as Error & { code: string };
  error.code = refusal.errorKind ?? refusal.stopReason;
  return error;
}
