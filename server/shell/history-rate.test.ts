// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The unreadable rate on real command history. Gated by
// MURAGE_TEST_SHELL_HISTORY (a test-run key, so the test setup keeps it): a
// JSON-lines file of command texts taken from a copy of an engine's
// transcripts (never a live data dir), kept outside the checkout and mounted
// read-only. There is no in-repo fixture path: real history never goes in
// the tree. It prints counts only: one per rule
// and one per unreadable reason, never a command's text (real history holds
// real secrets). It never fails on the rate: the number is reported, and the
// lane decides.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { alwaysAskCommand, alwaysAskRoutineCommand, alwaysAskUnreadableReason } from "../always-ask.ts";

const file = process.env.MURAGE_TEST_SHELL_HISTORY || undefined;
// the folder every command runs in, as a live turn reports one; unset or
// empty means no folder (MURAGE_TEST_SHELL_CWD="")
const cwd = process.env.MURAGE_TEST_SHELL_CWD || undefined;
/** Program names printed in the protected-path buckets; any other name is
 * `other`, so no word from history is ever printed. */
const NAMED_PROGRAMS = new Set([
  "rm", "rmdir", "cp", "mv", "ln", "chmod", "chown", "tar", "rsync", "find", "grep", "rg", "git", "gh", "docker", "podman", "ssh", "scp",
  "sed", "awk", "cut", "tr", "sort", "xargs", "mkdir", "touch", "tee", "open", "code", "node", "python", "python3", "npm", "npx", "pnpm",
  "curl", "wget", "diskutil", "kill", "ps", "lsof", "tree", "which", "test", "[", "jq", "tmux", "make", "cargo", "diff", "shred", "srm",
  "file", "realpath", "readlink", "basename", "dirname", "mdfind", "fd", "less", "chflags", "xattr", "tmutil", "hdiutil", "mount", "umount",
]);

describe.skipIf(!file)("always-ask over real history", () => {
  it("reports the rate per rule", () => {
    const commands = readFileSync(file!, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string);
    const counts = new Map<string, number>();
    const started = Date.now();
    let slowest = 0;
    for (const command of commands) {
      const t0 = Date.now();
      const hit = alwaysAskCommand(command, cwd, "command");
      slowest = Math.max(slowest, Date.now() - t0);
      const rule = hit?.rule ?? "ordinary";
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
      // the same command on a scheduled or manual routine run (the routine
      // carve-out): fixed bucket names only
      const routine = alwaysAskRoutineCommand(command, cwd);
      const routineKey = routine.hit ? "routine/held" : routine.valueTarget !== undefined ? "routine/carved" : "routine/ordinary";
      counts.set(routineKey, (counts.get(routineKey) ?? 0) + 1);
      const extra = hit as { protectedClass?: string; program?: string } | null;
      if (rule === "protected-path" && extra?.protectedClass) {
        const named = extra.program && NAMED_PROGRAMS.has(extra.program) ? extra.program : "other";
        for (const key of [`protected-path/${extra.protectedClass}`, `protected-path/program/${named}`]) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const reason = rule === "unreadable" ? alwaysAskUnreadableReason(command) ?? "" : "";
      if (reason) {
        const key = `unreadable/${reason.split(":")[0]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        // the detail too, for the reasons whose details are the reader's own
        // fixed phrases (never a word from the command)
        if (/^(expansion|folder|indirect|dynamic-eval|depth): [^$`{}]*$/.test(reason) && !/function /.test(reason)) counts.set(`unreadable/${reason}`, (counts.get(`unreadable/${reason}`) ?? 0) + 1);
      }
    }
    const lines = [
      `HISTORY commands=${commands.length} cwd=${cwd ? "fixed" : "none"} ms=${Date.now() - started} slowest_ms=${slowest}`,
      ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([rule, n]) => `HISTORY ${rule}=${n} (${((n / commands.length) * 100).toFixed(3)}%)`),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    expect(commands.length).toBeGreaterThan(0);
  });
});
