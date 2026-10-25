// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Windows Git Bash for Claude (APP-GRANT-FIXPLAN-r6 (e)+(h), r3 (e); WIN-NOBASH-DESIGN-r2 section 2). Murage's wrapper needs Git
// Bash; without it Claude runs on its PowerShell tool (powershell-inherit). The bash.exe the wrapper runs is found from the
// HANDED environment only, agreeing with Claude Code 2.1.305's own detection (bundle function `x()`): the handed
// CLAUDE_CODE_GIT_BASH_PATH when it is a real bash.exe; else from the ABSOLUTE git.exe on the handed PATH (`git --exec-path`
// run through the shared launcher with the handed env, 2 s, and the CLI's own `<git dir>\..\..\bin\bash.exe`); else the CLI's
// fixed candidates `C:\Program Files\Git\bin\bash.exe` and `C:\Program Files (x86)\Git\bin\bash.exe` (2.1.305 strings, exactly
// these two), plus the same places under the handed ProgramFiles, ProgramFiles(x86) and LOCALAPPDATA\Programs. An override the
// wrapper cannot run (sh.exe, or anything that is not bash.exe) is `override-not-bash`. Nothing here reads Murage's own process
// environment. Cached by generation, handed PATH, override and every directory variable a candidate is built from; an entry
// keeps the identity of every file it probed (null for one that was not there), and a hit re-states them, so a replaced file,
// or a Git installed later, rediscovers.

import { statSync } from "node:fs";
import { win32 } from "node:path";
import { PIN_PROBE_MS, type PinRun } from "../shared/arg-vocabulary.ts";
import { realPathInOrder } from "../shared/in-project.ts";
import { execCli } from "./procs.ts";

export interface ToolIdentity { real: string; dev: number; ino: number; size: number; mtimeMs: number }

export interface DiscoveryDeps {
  /** The file placed in order with every part present, and its identity; null when it is not a real file. */
  identify(path: string): ToolIdentity | null;
  run: PinRun;
}

function identifyFile(path: string): ToolIdentity | null {
  const placed = realPathInOrder(path, "", { platform: "win32", mustExist: true });
  if ("cannot" in placed) return null;
  try {
    const st = statSync(placed.real);
    return st.isFile() ? { real: placed.real, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

const launcherRun: PinRun = (file, args, opts) =>
  new Promise((resolve) => {
    execCli(file, args, { env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: stdout ?? "", stderr: stderr ?? "" }));
  });

const DEFAULT_DEPS: DiscoveryDeps = { identify: identifyFile, run: launcherRun };

/** Why no bash.exe was found: none anywhere, or an override the wrapper cannot run. */
/** Why the wrapper is not used: no bash.exe anywhere, an override the wrapper cannot run, or a found Git Bash whose
 * wrapper launch failed its pre-flight on this machine (claudeExecLaunchCheck in drivers/claude.ts). */
export type GitBashMiss = "no-git-bash" | "override-not-bash" | "wrapper-failed";
export interface GitBashFound { bash: string | null; reason?: GitBashMiss; detail?: string }

type Entry = { bash: string | null; reason?: GitBashMiss; ids: { path: string; id: ToolIdentity | null }[] };
const ENTRIES_MAX = 32;
const cache = new Map<string, Entry>();

export function resetToolDiscoveryForTests(): void { cache.clear(); }

const sameId = (a: ToolIdentity | null, b: ToolIdentity | null): boolean =>
  a === b || (!!a && !!b && a.real === b.real && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs);

/** Claude Code 2.1.305's fixed candidates, verbatim from its bundle. */
export const CLAUDE_GIT_BASH_CANDIDATES: readonly string[] = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"];
/** The handed directory variables candidates are also built from (and so part of the cache key). */
const CANDIDATE_DIRS = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] as const;

/** The fixed candidates: the CLI's own, then the same places under the handed directory variables. */
function fixedCandidates(handed: Readonly<Record<string, string>>): string[] {
  const out = [...CLAUDE_GIT_BASH_CANDIDATES];
  for (const name of CANDIDATE_DIRS) {
    const dir = handed[name];
    if (!dir || !win32.isAbsolute(dir)) continue;
    out.push(name === "LOCALAPPDATA" ? win32.join(dir, "Programs", "Git", "bin", "bash.exe") : win32.join(dir, "Git", "bin", "bash.exe"));
  }
  return [...new Set(out.map((path) => path.toLowerCase()))].map((lower) => out.find((path) => path.toLowerCase() === lower)!);
}

/** The first `git.exe` in the handed PATH; every place probed is recorded in `ids`. */
function gitOnPath(path: string, deps: DiscoveryDeps, ids: Entry["ids"]): { path: string; id: ToolIdentity } | null {
  for (const entry of path.split(";")) {
    if (!entry || !win32.isAbsolute(entry)) continue;
    // identify places the joined path part by part, the folder included
    const at = win32.join(entry, "git.exe");
    const id = deps.identify(at);
    ids.push({ path: at, id });
    if (id) return { path: at, id };
  }
  return null;
}

async function discover(handed: Readonly<Record<string, string>>, deps: DiscoveryDeps): Promise<Entry> {
  const ids: Entry["ids"] = [];
  const override = handed.CLAUDE_CODE_GIT_BASH_PATH;
  if (override) {
    // the CLI takes a bash or sh override; the wrapper is bash, so anything else is one Murage cannot wrap
    if (!/(^|[\\/])bash\.exe$/i.test(override)) return { bash: null, reason: "override-not-bash", ids };
    const id = deps.identify(override);
    ids.push({ path: override, id });
    if (id) return /(^|[\\/])bash\.exe$/i.test(id.real) ? { bash: id.real, ids } : { bash: null, reason: "override-not-bash", ids };
  }
  const probe = (candidate: string): string | null => {
    const id = deps.identify(candidate);
    ids.push({ path: candidate, id });
    return id ? id.real : null;
  };
  const git = gitOnPath(handed.PATH ?? "", deps, ids);
  if (git) {
    // the absolute git.exe the handed PATH names, never a bare `git` the launcher would look up on a wider PATH
    const out = await deps.run(git.path, ["--exec-path"], { env: handed, timeoutMs: PIN_PROBE_MS }).catch(() => ({ ok: false, stdout: "", stderr: "" }));
    const execPath = out.ok ? out.stdout.trim().replace(/\//g, "\\") : "";
    if (execPath && win32.isAbsolute(execPath)) {
      // <root>\mingw64\libexec\git-core (or clangarm64, mingw32): Git Bash is <root>\bin\bash.exe, else <root>\usr\bin\bash.exe
      const root = win32.dirname(win32.dirname(win32.dirname(execPath)));
      for (const candidate of [win32.join(root, "bin", "bash.exe"), win32.join(root, "usr", "bin", "bash.exe")]) {
        const bash = probe(candidate);
        if (bash) return { bash, ids };
      }
    }
    // the CLI's own rule: path.join(<git.exe>, "..", "..", "bin", "bash.exe"), so <root>\cmd\git.exe gives <root>\bin\bash.exe
    const bash = probe(win32.join(git.path, "..", "..", "bin", "bash.exe"));
    if (bash) return { bash, ids };
  }
  for (const candidate of fixedCandidates(handed)) {
    const bash = probe(candidate);
    if (bash) return { bash, ids };
  }
  return { bash: null, reason: "no-git-bash", ids };
}

/** The bash.exe Claude's wrapper runs, or null with the reason (the Claude turn then runs on the CLI's PowerShell tool,
 *  powershell-inherit). */
export async function gitBashDiscovery(handed: Readonly<Record<string, string>>, generation: number, deps: DiscoveryDeps = DEFAULT_DEPS): Promise<GitBashFound> {
  const key = [generation, handed.PATH ?? "", handed.CLAUDE_CODE_GIT_BASH_PATH ?? "", ...CANDIDATE_DIRS.map((name) => handed[name] ?? "")].join("\u0000");
  const hit = cache.get(key);
  if (hit && hit.ids.every((entry) => sameId(deps.identify(entry.path), entry.id))) return hit.reason ? { bash: hit.bash, reason: hit.reason } : { bash: hit.bash };
  const found = await discover(handed, deps);
  cache.delete(key);
  cache.set(key, found);
  while (cache.size > ENTRIES_MAX) cache.delete(cache.keys().next().value!);
  return found.reason ? { bash: found.bash, reason: found.reason } : { bash: found.bash };
}

/** The bash.exe alone (gitBashDiscovery without the reason). */
export async function gitBashPath(handed: Readonly<Record<string, string>>, generation: number, deps: DiscoveryDeps = DEFAULT_DEPS): Promise<string | null> {
  return (await gitBashDiscovery(handed, generation, deps)).bash;
}
