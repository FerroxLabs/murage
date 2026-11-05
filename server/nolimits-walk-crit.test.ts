// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-WALK-CRIT (designs/NOLIMITS-WALK-CRIT.md): a shell launcher whose argv is not exactly
// `<shell> -c <script> [args]` (or `-lc`) asks, on an owner No limits turn too. busybox, toybox, csh and tcsh
// always ask. Fixture strings are inert data, never executed.
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { autoVerdict } = await import("./auto-approve.ts");

const NO_LIMITS = { id: "owned", autoApprove: true, fullAccess: true, noLimits: true };
const OWNER = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null } as const;
const verdict = (cmd: string) => autoVerdict(NO_LIMITS, "Bash", cmd, { ...OWNER, commandText: cmd });

const SUB = "$(rm -rf /)";

const BYPASSES = [
  "bash -oc errexit 'P'",
  "bash -Oc extglob 'P'",
  "bash +oc errexit 'P'",
  "bash -o errexit -c 'P'",
  "bash +o errexit -c 'P'",
  "bash --rcfile /dev/null -c 'P'",
  "bash --norc -c 'P'",
  "bash -xc 'P'",
  "bash -cx 'P'",
  "sh -ec 'P'",
  "bash -ic 'P'",
  "bash -cs 'P'",
  "bash -x -c 'P'",
  "bash -c -x 'P'",
  "bash -c -- 'P'",
  "bash -c +x 'P'",
  "bash -c true -c 'P'",
  "bash -- -c 'P'",
  "env bash -oc errexit 'P'",
  "env -- bash -xc 'P'",
  "nohup bash -oc errexit 'P'",
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

describe("NOLIMITS-WALK-CRIT: launcher shapes the reader does not follow keep their card", () => {
  it.each(BYPASSES)("%s with a substitution", (shape) => {
    expect(verdict(shape.replace("P", SUB)).approve).toBeNull();
  });
  it.each(BYPASSES)("%s with a plain wipe", (shape) => {
    expect(verdict(shape.replace("P", "rm -rf /")).approve).toBeNull();
  });
  it.each(["busybox ls", "tcsh -c 'echo hi'", "bash -oc errexit 'echo hi'", "bash -xc 'ls'"])("%s asks even when harmless", (cmd) => {
    expect(verdict(cmd)).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" });
  });
});

describe("NOLIMITS-WALK-CRIT: the plain -c form reads as before", () => {
  it.each(["bash -c 'ls'", "bash -lc 'ls'", "sh -c 'git status'", "zsh -c 'echo hi'", "bash -c 'echo $0 $1' zero one"])(
    "%s runs with no card",
    (cmd) => expect(verdict(cmd).approve).not.toBeNull(),
  );
  it.each(["bash -c 'P'", "bash -lc 'P'", "sh -c 'echo ok; P'"])("%s keeps its card for a wipe in the script", (shape) => {
    expect(verdict(shape.replace("P", "rm -rf /")).approve).toBeNull();
    expect(verdict(shape.replace("P", SUB)).approve).toBeNull();
  });
});
