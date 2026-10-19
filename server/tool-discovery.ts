// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Windows Git Bash for Claude (APP-GRANT-FIXPLAN-r6 (e)+(h), r3 (e)). Claude Code runs its Bash tool through Git Bash on
// Windows; Murage's command wrapper runs through the same bash.exe, found from the HANDED environment only: the handed
// CLAUDE_CODE_GIT_BASH_PATH when it is a real bash.exe, else from `git --exec-path` run through the shared launcher with the
// handed env (2 s). Nothing here reads Murage's own process environment. Cached by generation, handed PATH and handed
// override; an entry keeps the identity of git and bash, and a hit re-states them, so a replaced file rediscovers.

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

type Entry = { bash: string | null; ids: { path: string; id: ToolIdentity | null }[] };
const ENTRIES_MAX = 32;
const cache = new Map<string, Entry>();

export function resetToolDiscoveryForTests(): void { cache.clear(); }

const sameId = (a: ToolIdentity | null, b: ToolIdentity | null): boolean =>
  a === b || (!!a && !!b && a.real === b.real && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs);

/** The first `git.exe` in the handed PATH. */
function gitOnPath(path: string, deps: DiscoveryDeps): { path: string; id: ToolIdentity } | null {
  for (const entry of path.split(";")) {
    if (!entry || !win32.isAbsolute(entry)) continue;
    // identify places the joined path part by part, the folder included
    const at = win32.join(entry, "git.exe");
    const id = deps.identify(at);
    if (id) return { path: at, id };
  }
  return null;
}

async function discover(handed: Readonly<Record<string, string>>, deps: DiscoveryDeps): Promise<Entry> {
  const override = handed.CLAUDE_CODE_GIT_BASH_PATH;
  if (override && /(^|[\\/])bash\.exe$/i.test(override)) {
    const id = deps.identify(override);
    if (id && /(^|[\\/])bash\.exe$/i.test(id.real)) return { bash: id.real, ids: [{ path: override, id }] };
  }
  const git = gitOnPath(handed.PATH ?? "", deps);
  const ids: Entry["ids"] = git ? [git] : [];
  const out = await deps.run("git", ["--exec-path"], { env: handed, timeoutMs: PIN_PROBE_MS }).catch(() => ({ ok: false, stdout: "", stderr: "" }));
  const execPath = out.ok ? out.stdout.trim().replace(/\//g, "\\") : "";
  if (!execPath || !win32.isAbsolute(execPath)) return { bash: null, ids };
  // <root>\mingw64\libexec\git-core (or clangarm64, mingw32): Git Bash is <root>\bin\bash.exe, else <root>\usr\bin\bash.exe
  const root = win32.dirname(win32.dirname(win32.dirname(execPath)));
  for (const candidate of [win32.join(root, "bin", "bash.exe"), win32.join(root, "usr", "bin", "bash.exe")]) {
    const id = deps.identify(candidate);
    if (id) return { bash: id.real, ids: [...ids, { path: candidate, id }] };
  }
  return { bash: null, ids };
}

/** The bash.exe Claude's wrapper runs, or null when there is none (the Claude turn is then refused, which is Claude Code's own
 *  Windows requirement and holds no other engine). */
export async function gitBashPath(handed: Readonly<Record<string, string>>, generation: number, deps: DiscoveryDeps = DEFAULT_DEPS): Promise<string | null> {
  const key = `${generation}\u0000${handed.PATH ?? ""}\u0000${handed.CLAUDE_CODE_GIT_BASH_PATH ?? ""}`;
  const hit = cache.get(key);
  if (hit && hit.ids.every((entry) => sameId(deps.identify(entry.path), entry.id))) return hit.bash;
  const found = await discover(handed, deps);
  cache.delete(key);
  cache.set(key, found);
  while (cache.size > ENTRIES_MAX) cache.delete(cache.keys().next().value!);
  return found.bash;
}
