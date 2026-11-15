// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { lstatSync } from "node:fs";
import { win32 } from "node:path";
import { windowsAclRestrict, type ToolRunner } from "../win-acl.ts";

/** Disposable fixture entries only, parents before children. /grant:r replaces
 * the named principals; it does not remove another principal's explicit ACE.
 * Reset to inherited grants first, then remove inheritance and grant the owner
 * and SYSTEM. Production storage must inspect/refuse broad DATA_DIR instead. */
export function protectWindowsFixtureEntry(
  path: string, run: ToolRunner, env: NodeJS.ProcessEnv = process.env,
  kind: typeof lstatSync = lstatSync,
): void {
  run(win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "icacls.exe"), [path, "/reset", "/q"]);
  if (!windowsAclRestrict(path, run, env, kind)) throw new Error("Windows fixture ACL setup failed");
}
