// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `<cli> --version` for the engine health snapshots. Settings > Engines and the engine list used to
// spawn every installed CLI on every call (a real CLI can take 300 ms or more to print its version).
// A successful answer is held per executable identity (resolved path, mtime and size), so a reinstall
// or update is probed again and an unchanged binary is not. Concurrent callers share one probe.
// Failures are never held: a missing or broken CLI is rechecked on every call. An explicit Test or
// Refresh calls invalidateCliVersions() and rechecks everything.
import { createHash } from "node:crypto";
import { claudeExecutableIdentity } from "./drivers/claude-guards.ts";
import { execCli } from "./procs.ts";

export interface CliVersionProbe { error: Error | null; stdout: string; stderr: string }
type Exec = typeof execCli;
/** at === 0 while the probe is in flight. */
interface Entry { identity: string; at: number; probe: Promise<CliVersionProbe> }

/** Upper bound on how long an unchanged binary's answer is trusted. */
export const CLI_VERSION_TTL_MS = 10 * 60_000;
const entries = new Map<string, Entry>();

/** Forget every held version (the Test and Refresh actions), or one CLI's. */
export function invalidateCliVersions(cli?: string): void {
  if (cli === undefined) { entries.clear(); return; }
  for (const key of [...entries.keys()]) if (key.startsWith(`${cli}\n`)) entries.delete(key);
}

/** The environment is part of the question: an engine instance with another HOME, config dir or
 * credential is a different probe. */
function envFingerprint(env: NodeJS.ProcessEnv): string {
  const hash = createHash("sha1");
  for (const key of Object.keys(env).sort()) hash.update(`${key}=${env[key] ?? ""}\0`);
  return hash.digest("hex");
}

export function cachedCliVersion(cli: string, env: NodeJS.ProcessEnv, run: Exec = execCli, timeout = 8000): Promise<CliVersionProbe> {
  const identity = claudeExecutableIdentity(cli, env);
  const key = `${cli}\n${envFingerprint(env)}`;
  const held = entries.get(key);
  if (held && held.identity === identity && (held.at === 0 || Date.now() - held.at <= CLI_VERSION_TTL_MS)) return held.probe;
  const entry: Entry = { identity, at: 0, probe: Promise.resolve({ error: null, stdout: "", stderr: "" }) };
  entries.set(key, entry);
  entry.probe = new Promise<CliVersionProbe>((resolve) => {
    run(cli, ["--version"], { timeout, env }, (error, stdout, stderr) => {
      const result: CliVersionProbe = { error: error ?? null, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
      if (entries.get(key) === entry) {
        if (!result.error && result.stdout.trim()) entry.at = Date.now(); else entries.delete(key);
      }
      resolve(result);
    });
  });
  return entry.probe;
}
