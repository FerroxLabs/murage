// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, symlinkSync } from "node:fs";
import { waitForExit } from "./cleanup.ts";

/** OS plumbing for a fixture child, without inheriting credentials or engine discovery. */
export function fixturePlatformEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keys = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "MURAGE_ENGINE_EXCLUSION_PATH"]);
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => keys.has(key.toUpperCase()) && value !== undefined));
}


/** Directory junctions exercise Windows reparse-point escapes without elevation.
 * File links require Developer Mode (the Windows gate checks that prerequisite).
 */
export function fixtureLink(target: string, path: string, kind: "dir" | "file", platform: NodeJS.Platform = process.platform): void {
  symlinkSync(target, path, platform === "win32" && kind === "dir" ? "junction" : kind);
}

/** Deny this fixture's reader, returning the exact undo operation before cleanup.
 * A Windows deny ACE wins over inherited allow entries, just as mode 000 does for a POSIX user.
 */
export function denyFixtureRead(path: string, platform: NodeJS.Platform = process.platform): () => void {
  if (platform !== "win32") {
    chmodSync(path, 0o000);
    return () => chmodSync(path, 0o600);
  }
  const sid = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true, encoding: "utf8" }).match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error("The fixture could not resolve its Windows user SID");
  execFileSync("icacls.exe", [path, "/deny", `*${sid}:(R)`], { windowsHide: true, stdio: "pipe" });
  return () => { execFileSync("icacls.exe", [path, "/remove:d", `*${sid}`], { windowsHide: true, stdio: "pipe" }); };
}


/** Match the desktop's shutdown request: Windows kill() bypasses the server's
 * cleanup and flush handlers, so fixture servers need a private IPC channel.
 */
export async function stopFixtureServer(child: ChildProcess | undefined, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === "win32") {
    if (!child.connected) throw new Error("Windows fixture server needs an IPC channel for graceful shutdown");
    child.send({ type: "murage:close" });
    await waitForExit(child, { graceMs: 8_000 });
  } else {
    await waitForExit(child, { signal: "SIGTERM", graceMs: 8_000 });
  }
}
