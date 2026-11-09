// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-WALK-CRIT (designs/NOLIMITS-WALK-CRIT.md): a shell `-c` form the reader does not follow asks, on
// an owner No limits turn too. r1b: clusters of l/i/x/e/v/u with one c, and `-o errexit`-style pairs (not
// fish), still read. busybox, toybox, csh and tcsh always ask. Fixture strings are inert data, never executed.
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { autoVerdict } = await import("./auto-approve.ts");

const NO_LIMITS = { id: "owned", autoApprove: true, fullAccess: true, noLimits: true };
// 1.0.20 (NOLIMITS-MEANS-IT slice 2): today's No limits, the 1.0.20 lane off (its rows: nolimits-means-it-1020.test.ts)
const OWNER = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, noPreRunSeamAtNoLimits: true } as const;
const verdict = (cmd: string, commandCwd?: string) => autoVerdict(NO_LIMITS, "Bash", cmd, { ...OWNER, commandText: cmd, ...(commandCwd ? { commandCwd } : {}) });

const SUB = "$(rm -rf /)";

const BYPASSES = [
  "bash -oc errexit 'P'",
  "bash -Oc extglob 'P'",
  "bash +oc errexit 'P'",
  "bash +o errexit -c 'P'",
  "bash --rcfile /dev/null -c 'P'",
  "bash --norc -c 'P'",
  "bash -cs 'P'",
  "bash -c -x 'P'",
  "bash -c -- 'P'",
  "bash -c +x 'P'",
  "bash -c true -c 'P'",
  "bash -- -c 'P'",
  "env bash -oc errexit 'P'",
  "nohup bash -oc errexit 'P'",
  "bash -xo errexit -c 'P'",
  "bash -cO x 'P'",
  "bash -cp 'P'",
  "fish -dc 'P'",
  "fish -o errexit -c 'P'",
  "zsh -cs 'P'",
  "bash -o allexport -c 'P'",
  "bash +x -c 'P'",
  "bash -x +o errexit -c 'P'",
  "bash -c -c 'P'",
  "bash -xc -c 'P'",
  "bash -xcc 'P'",
  "bash -cR x 'P'",
  "ksh -T x -c 'P'",
  "env -- bash -xs -c 'P'",
  "fish -ic 'P'",
  "fish -cl 'P'",
  "fish -c true --command='P'",
  "fish -c true -C 'P'",
  "busybox sh -c 'P'",
  "/bin/busybox ash -c 'P'",
  "toybox sh -c 'P'",
  "tcsh -c true -c 'P'",
  "csh -c 'P'",
  "env tcsh -c 'P'",
  "bash " + "-o errexit ".repeat(200) + "-c 'P'",
  "bash -" + "c".repeat(5000) + " 'P'",
  "bash -c 'P' " + "x ".repeat(300),
];

/** r1b: common spellings of the `-c` form the reader follows (stop-line corpus gc-08..gc-13, gc-argv-bash-cl). */
const READ_SHAPES = [
  "bash -cl 'P'",
  "bash -lic 'P'",
  "bash -ic 'P'",
  "bash -xc 'P'",
  "bash -cx 'P'",
  "bash -ec 'P'",
  "sh -ec 'P'",
  "bash -x -c 'P'",
  "bash -o errexit -c 'P'",
  "bash -o errexit -o pipefail -c 'P'",
  "bash -e -o nounset -xc 'P'",
  "zsh -o xtrace -c 'P'",
  "dash -euc 'P'",
  "env -- bash -xc 'P'",
];

describe("NOLIMITS-WALK-CRIT: launcher shapes the reader does not follow keep their card", () => {
  it.each(BYPASSES)("%s with a substitution", (shape) => {
    expect(verdict(shape.replace("P", SUB)).approve).toBeNull();
  });
  it.each(BYPASSES)("%s with a plain wipe", (shape) => {
    expect(verdict(shape.replace("P", "rm -rf /")).approve).toBeNull();
  });
  it.each(["busybox ls", "tcsh -c 'echo hi'", "bash -oc errexit 'echo hi'", "bash -xo errexit -c 'ls'", "bash -cO x 'ls'", "bash -cp 'ls'", "fish -dc 'ls'", "fish -o errexit -c 'ls'", "fish -cvi true", "fish -ic true", "fish -c true --command=ls", "zsh -cs 'ls'", "bash +x -c 'ls'", "bash -c -c 'ls'"])("%s asks even when harmless", (cmd) => {
    expect(verdict(cmd)).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" });
  });
});

describe("NOLIMITS-WALK-CRIT: the plain -c form reads as before", () => {
  it.each(["bash -c 'ls'", "bash -lc 'ls'", "sh -c 'git status'", "zsh -c 'echo hi'", "bash -c 'echo $0 $1' zero one", ...READ_SHAPES.map((x) => x.replace("P", "ls"))])(
    "%s runs with no card",
    // MARKS r9 C1: probe `bash -o errexit -c 'ls'` (and the other -o rows) at No limits with cwd /w -> RUN no-limits (as b18); with no cwd -> always-ask unreadable (doubt value-path on the -o word). Known project cwd given; the twin below pins the no-cwd card.
    (cmd) => expect(verdict(cmd, "/w").approve).not.toBeNull(),
  );
  it.each(["bash -o errexit -c 'ls'", "bash -o errexit -o pipefail -c 'ls'", "bash -e -o nounset -xc 'ls'", "zsh -o xtrace -c 'ls'"])(
    "%s runs with no card (no cwd)",
    // MARKS r9 C1 twin: probe the same four with no cwd at No limits -> CARD always-ask unreadable (doubt value-path)
    // MARKS r11: back to b18 (M-R10 monotonic relief): the value-path doubt alone no longer cards on the owner's turn
    (cmd) => expect(verdict(cmd).approve).not.toBeNull(),
  );
  it.each(["bash -c 'P'", "bash -lc 'P'", "sh -c 'echo ok; P'", ...READ_SHAPES])("%s keeps its card for a wipe in the script", (shape) => {
    expect(verdict(shape.replace("P", "rm -rf /")).approve).toBeNull();
    expect(verdict(shape.replace("P", SUB)).approve).toBeNull();
  });
});
