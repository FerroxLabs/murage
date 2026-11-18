import { withHideInherit } from "../shared/win-hide-child-process.mjs";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WIN-BACKUP-RT-1018: is this Windows process running with an elevated token?
//
// The backup helper (native/backup-age/transport.cpp:134) refuses an elevated
// parent and exits 72, the same exit code as every other failed check, so on
// its own a person who started Murage with Run as administrator was told the
// backup folder was the problem. The product asks before it spawns the helper
// (resolveWindowsBackupRuntime) and names the real cause. The helper's own
// refusal stays the security gate; this check only gives the right sentence,
// so an answer it can't read is "unknown" and the helper decides.
//
// whoami.exe is run by its full path under the Windows folder, never found
// through PATH, with an empty PATH of its own. A High (S-1-16-12288) or System
// (S-1-16-16384) mandatory level is elevated; Medium (S-1-16-8192) or lower is not.
import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

const ELEVATED = /\bS-1-16-(12288|16384)\b/;
const STANDARD = /\bS-1-16-(0|4096|8192|8448)\b/;

/** The whoami.exe of this Windows installation, by full path. SystemRoot is used only when it is a plain drive folder. */
export function windowsFolder(environment: NodeJS.ProcessEnv = process.env) {
  const root = environment.SystemRoot;
  return typeof root === "string" && /^[A-Za-z]:\\[^\\/:*?"<>|\r\n]+$/.test(root) ? root : "C:\\Windows";
}
export const windowsWhoamiPath = (environment: NodeJS.ProcessEnv = process.env) => win32.join(windowsFolder(environment), "System32", "whoami.exe");

type Run = (command: string, args: string[], options: { encoding: "utf8"; windowsHide: true; timeout: number; env: Record<string, string>; maxBuffer: number }) => { status: number | null; stdout?: string | null; error?: Error };

/** true: elevated; false: a standard token; null: could not tell (the helper's own check then decides). */
export function readWindowsTokenElevation(run: Run = spawnSync as unknown as Run, environment: NodeJS.ProcessEnv = process.env): boolean | null {
  try {
    const result = run(windowsWhoamiPath(environment), ["/groups"], withHideInherit({ encoding: "utf8", windowsHide: true, timeout: 15_000, env: { PATH: "", SystemRoot: windowsFolder(environment) }, maxBuffer: 1024 * 1024 }));
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
    if (ELEVATED.test(result.stdout)) return true;
    return STANDARD.test(result.stdout) ? false : null;
  } catch { return null; }
}
