// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Windows refuses a rename onto an existing file while ANOTHER process holds that file open: MoveFileExW with
// MOVEFILE_REPLACE_EXISTING, which Node's fs.renameSync uses, fails with ERROR_ACCESS_DENIED (Node: EPERM) whatever
// share mode the holder asked for. POSIX replaces the name and leaves the holder on the old inode. This module puts
// the Windows rule on a POSIX test process, judged from the REAL open handles of other processes (/proc on Linux,
// lsof on macOS), so a witness that needs a live holder to refuse the replace runs the same on every platform. On
// Windows the operating system enforces the rule itself; only the attempt count and the test hook are added.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";

/** Whether a process other than this one holds `path` open (its current inode). */
export function heldByOtherProcess(path) {
  let real;
  try { real = fs.realpathSync(path); } catch { return false; }
  if (process.platform === "linux") {
    for (const pid of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
      let fds;
      try { fds = fs.readdirSync(join("/proc", pid, "fd")); } catch { continue; }
      for (const fd of fds) {
        try { if (fs.readlinkSync(join("/proc", pid, "fd", fd)) === real) return true; } catch { /* closed meanwhile */ }
      }
    }
    return false;
  }
  if (process.platform === "darwin") {
    let pids = "";
    try { pids = execFileSync("lsof", ["-t", "--", real], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return false; } // exit 1: no holder
    return pids.split("\n").some((pid) => pid.trim() !== "" && Number(pid) !== process.pid);
  }
  throw new Error(`windows-replace-rule: no open-handle probe on ${process.platform}`);
}

const attempts = new Map();
/** How many renames onto `path` this process attempted while the rule was installed (refused ones included). */
export function replaceAttempts(path) { return attempts.get(String(path)) ?? 0; }

/** Install the rule on fs.renameSync (and every ESM binding of it). Returns the uninstall. On Windows the operating system
 *  enforces the rule, so only the attempt count and `beforeReplace` are added. `beforeReplace(to, from)` runs before each rename. */
export function installWindowsReplaceRule({ beforeReplace } = {}) {
  const original = fs.renameSync;
  fs.renameSync = function renameSync(from, to) {
    attempts.set(String(to), replaceAttempts(to) + 1);
    beforeReplace?.(String(to), String(from));
    if (process.platform !== "win32" && fs.existsSync(to) && heldByOtherProcess(to)) {
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { errno: -4048, code: "EPERM", syscall: "rename", path: String(from), dest: String(to) });
    }
    return original(from, to);
  };
  syncBuiltinESMExports();
  return () => { fs.renameSync = original; syncBuiltinESMExports(); };
}

// `node --import <this file>`: a whole server process under the rule.
if (process.env.MURAGE_TEST_WINDOWS_REPLACE_RULE === "1") installWindowsReplaceRule();
