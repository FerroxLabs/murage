// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-1017-FINAL: 1.0.17 reads owner No limits shell commands the way 1.0.16 did. Every shape from the
// NOLIMITS-BASH-ARGV case list (27 cases, T1-T10 plus the review rounds), carrying a wipe, keeps its card on an
// owner-started No limits turn. NOLIMITS-WALK-CRIT dropped 6 inert cases (a `cat` T10 line, a pwsh backtick escape,
// three quoted heredocs: each correctly runs). Fixture strings are inert data, never executed.
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { autoVerdict } = await import("./auto-approve.ts");

const NO_LIMITS = { id: "owned", autoApprove: true, fullAccess: true, noLimits: true };
// 1.0.20 (NOLIMITS-MEANS-IT slice 2): today's No limits, the 1.0.20 lane off (its rows: nolimits-means-it-1020.test.ts)
const OWNER = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, noPreRunSeamAtNoLimits: true } as const;
const verdict = (cmd: string) => autoVerdict(NO_LIMITS, "Bash", cmd, { ...OWNER, commandText: cmd });

const SUB = "$(rm -rf /)";
const WIPE = "rm -rf /";

// [case name, command] - the shell -c shapes whose script the 1.0.17 candidate never read
const SHAPES: Array<[string, string]> = [
  ["T1 option word after -c", "bash -c -x 'P'"],
  ["T2 -c -s", "bash -c -s 'P'"],
  ["T2 -c -o errexit", "bash -c -o errexit 'P'"],
  ["T2 -c +x", "bash -c +x 'P'"],
  ["T2 -o errexit -c", "bash -o errexit -c 'P'"],
  ["T2 --rcfile x -c", "bash --rcfile x -c 'P'"],
  ["T2 -oc errexit", "bash -oc errexit 'P'"],
  ["T2 -cs", "bash -cs 'P'"],
  ["T2 tcsh second -c", "tcsh -c true -c 'P'"],
  ["T2 fish --features", "fish --features x -c 'P'"],
  ["T2 busybox sh -c", "busybox sh -c 'P'"],
  ["T3 -xc", "bash -xc 'P'"],
  ["T3 -lc", "bash -lc 'P'"],
  ["T3 sh -ec", "sh -ec 'P'"],
  ["T3 zsh -c", "zsh -c 'P'"],
  ["R2 long -ccc word", "bash -" + "c".repeat(5000) + " 'P'"],
];

describe("the -c shapes keep their card on an owner No limits turn", () => {
  for (const [name, shape] of SHAPES) {
    it(`${name} with a substitution`, () => expect(verdict(shape.replace("P", SUB)).approve).toBeNull());
    it(`${name} with a plain wipe`, () => expect(verdict(shape.replace("P", WIPE)).approve).toBeNull());
  }
});

describe("PowerShell and cmd payloads keep their card (T5, T6, R1)", () => {
  it.each([
    "pwsh -NoProfile -c -NoLogo 'rm -rf /'",
    "pwsh -c -NoLogo 'rm -rf /'",
    "echo 'rm -rf /' | pwsh -Command -",
    "pwsh -c 'echo $(rm -rf /)'",
    "pwsh -Command 'Write-Output $(& rm -rf /)'",
    "cmd /c \"echo $(rm -rf /)\"",
  ])("%s", (cmd) => expect(verdict(cmd).approve).toBeNull());
});

describe("heredoc bodies the reader took as ended keep their card (T9, R3)", () => {
  it.each([
    "cat <<EOF\nEOF\r\n# $(rm -rf /)\nEOF\n",
    "cat <<'EOF'\n EOF\n$(rm -rf /)\nEOF\necho \"",
  ])("%j", (cmd) => expect(verdict(cmd).approve).toBeNull());
});
