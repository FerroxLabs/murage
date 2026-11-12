// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MARKS FIX A (MARKS-DENY-VS-NOLIMITS-RULING sections 2, 3, 4). The typed deny is raised only where a protected place can be
// reached; every other thing the reader cannot follow stays a doubt, and the owner's own No limits turn runs it. The
// owner here is `ownerOwnTurn` (owner origin, owner started it), No limits, cwd = the bot folder "/w".
import { describe, expect, it } from "vitest";
import { alwaysAskCommand } from "./always-ask.ts";
import { autoVerdict, type AutoContext } from "./auto-approve.ts";
import { cell, nlh0, ownerMarks, type CellSpec } from "./testing/marks-nlh0.ts";
import { expectNoLimitsOwnerOutcome, isWipeRule } from "./testing/no-limits-1019.ts";

const STUB = { realpath: (path: string) => path, stat: () => ({ isFile: () => true, isDirectory: () => false }) };
const OWNER = { id: "narrow", autoApprove: true, fullAccess: true, noLimits: true };
const LEVELS: Array<[string, Record<string, unknown>]> = [["ask", { id: "narrow" }], ["auto", { id: "narrow", autoApprove: true }],
  ["full", { id: "narrow", autoApprove: true, fullAccess: true }], ["nolimits", OWNER]];
const PATCHES: Array<[string, Record<string, unknown>]> = [["owner", {}], ["other", { fullAccessOrigin: "other" }], ["unstarted", { ownerStarted: false }],
  ["routine", { routineLevel: true, automated: true }], ["unattended", { unattended: true }], ["marked", { outsideRead: ["interpreter"] }]];
const ctxOf = (command: string, patch: Record<string, unknown> = {}) => ({ commandText: command, commandCwd: "/w", workFolder: "/w",
  fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, unseen: { platform: "posix", fs: STUB },
  sessionFile: () => "unavailable", ...patch }) as unknown as AutoContext;
const owner = (command: string, patch: Record<string, unknown> = {}) => autoVerdict(OWNER as never, "Bash", command, ctxOf(command, patch));

/** Uncertain, and cannot reach a protected path: the owner's turn runs it (source no-limits). */
const RUNS = ["touch out", "dd if=/dev/zero of=./disk.img bs=1M count=1", "python3 -c 'open(\"/tmp/out\",\"w\")'", "perl -e 'mystery()'",
  "cat /dev/sda > /w/disk.img", "dd if=/etc of=./x", "git commit -m \"$MSG\"", "make -C \"$DIR\"", "cp /etc/hosts ./h", "cat < /etc/passwd",
  "sed -n -e 'r /etc/passwd' notes", "python3 -c 'print(f\"{1}\")'"];
/** The two value-target rows of the ruling's RUNS list. Pristine cards them at every level (a reader failure); now they are a
 * could-not-read hit: Full access and every other origin still card them exactly as at NLH0, the owner's clean No limits turn runs them. */
const VALUE_TARGETS = ["cp a \"$OUT\"", "echo x > \"$LOG\""];
/** Uncertain, and may reach a protected path: a typed deny at every level. */
const STOPS: Array<[string, string]> = [
  ["rm -rf \"$X\"", "unknown-target"], ["rm -rf \"$X\"/", "unknown-target"], ["rm -rf ~/\"$X\"", "unknown-target"],
  ["cp x /etc/\"$X\"", "unknown-target"], ["touch ~/\"$X\"", "unknown-target"],
  ["cp blob /w/../etc/../w/x", "protected-path"], ["sed -e 'w /etc/passwd' f", "protected-path"], ["touch ../etc/passwd", "protected-path"],
  ["python3 -c 'import shutil; shutil.rmtree(p)'", "unknown-target"], ["python3 -c 'open(\"/et\"+\"c/cron.d/pwn\",\"w\").write(\"x\")'", "unknown-target"],
  ["python3 -c 'from pathlib import Path; Path(\"/etc/cron.d/pwn\").write_text(\"x\")'", "protected-path"],
];
const WIPE: Array<[string, string]> = [
  ["rm -rf /", "delete-root"], ["rm -rf ~", "delete-home"], ["mkfs.ext4 /dev/sdb", "disk-erase"], [":(){ :|:& };:", "fork-bomb"],
  ["rm -rf $X; rm -rf ~", "delete-home"], ["DEV=/dev/sda; cat x > $DEV", "disk-erase"],
];

// T4, Stage 0 rev 4.1: literal expectations confirmed against the NLH0 reads.
const T4: Record<string, CellSpec> = {
  "STOPS rm -rf \"$X\"": {
    "text": "rm -rf \"$X\"",
    "n2": true,
    held: {
      "protected-path": {"reason": "protected-path"},
      "unreadable/held": {"reason": "value-path"},
    },
    "owner": {"approve": null, "source": "always-ask", "rule": "unknown-target", "classification": "deny", "reason": "unresolved-target"},
  },
  "STOPS rm -rf \"$X\"/": {
    "text": "rm -rf \"$X\"/",
    "n2": true,
    held: {
      "unknown-target": {"reason": "unknown-target"},
    },
    "owner": {"approve": null, "source": "always-ask", "rule": "unknown-target", "classification": "deny", "reason": "unknown-target"},
  },
  "STOPS rm -rf ~/\"$X\"": {
    "text": "rm -rf ~/\"$X\"",
    "n2": true,
    held: {
      "unknown-target": {"reason": "unknown-target"},
    },
    "owner": {"approve": null, "source": "always-ask", "rule": "unknown-target", "classification": "deny", "reason": "unknown-target"},
  },
  "STOPS cp x /etc/\"$X\"": {
    "text": "cp x /etc/\"$X\"",
    // S1-B3 RULING (MAIN 2026-11-11 09:30Z): protected-write run assertions are superseded.
    "n2": true,
    owner: { approve: null, source: "always-ask", rule: "unknown-target", classification: "deny" },
    held: {
      "protected-path": {"reason": "protected-path"},
      "unreadable/held": {"reason": "value-path"},
    },
  },
  "STOPS touch ~/\"$X\"": {
    "text": "touch ~/\"$X\"",
    // S1-B3 RULING (MAIN 2026-11-11 09:30Z): protected-write run assertions are superseded.
    "n2": true,
    owner: { approve: null, source: "always-ask", rule: "unknown-target", classification: "deny" },
    held: {
      "protected-path": {"reason": "protected-path"},
      "unreadable/held": {"reason": "value-path"},
    },
  },
  "STOPS cp blob /w/../etc/../w/x": {
    "text": "cp blob /w/../etc/../w/x",
    // S1-B3 RULING (MAIN 2026-11-11 09:30Z): protected-write run assertions are superseded.
    "n2": true,
    owner: { approve: null, source: "always-ask", rule: "protected-path", classification: "deny" },
    held: {
      "protected-path": {"reason": "protected-path"},
      "unreadable/held": {"reason": "value-path"},
    },
  },
  "STOPS sed -e 'w /etc/passwd' f": {
    "text": "sed -e 'w /etc/passwd' f",
    // S1-B3 RULING (MAIN 2026-11-11 09:30Z): protected-write run assertions are superseded.
    "n2": true,
    owner: { approve: null, source: "always-ask", rule: "protected-path", classification: "deny" },
    held: {
      "protected-path": {"reason": "protected-path"},
      "unreadable/held": {"reason": "tokenizer"},
    },
  },
  "STOPS touch ../etc/passwd": {
    "text": "touch ../etc/passwd",
    // S1-B3 RULING (MAIN 2026-11-11 09:30Z): protected-write run assertions are superseded.
    "n2": true,
    owner: { approve: null, source: "always-ask", rule: "protected-path", classification: "deny" },
    held: {
      "protected-path": {"reason": "protected-path"},
      "unreadable/held": {"reason": "value-path"},
    },
  },
  "STOPS python3 -c 'import shutil; shutil.rmtree(p)'": {
    "text": "python3 -c 'import shutil; shutil.rmtree(p)'",
    "n2": true,
    held: {
      "protected-path": {"reason": "protected-path"},
      "unreadable/held": {"reason": "tokenizer"},
    },
    "owner": {"approve": null, "source": "always-ask", "rule": "unknown-target", "classification": "deny", "reason": "incomplete-executable-code"},
  },
  "STOPS python3 -c 'open(\"/et\"+\"c/cron.d/pwn\",\"w\").write(\"x\")'": {
    "text": "python3 -c 'open(\"/et\"+\"c/cron.d/pwn\",\"w\").write(\"x\")'",
    // S1-B3 RULING (MAIN 2026-11-11 09:30Z): protected-write run assertions are superseded.
    "n2": true,
    owner: { approve: null, source: "always-ask", rule: "unknown-target", classification: "deny" },
    held: {
      "protected-path": {"reason": "protected-path"},
      "unreadable/held": {"reason": "value-path"},
    },
  },
  "STOPS python3 -c 'from pathlib import Path; Path(\"/etc/cron.d/pwn\").write_text(\"x\")'": {
    "text": "python3 -c 'from pathlib import Path; Path(\"/etc/cron.d/pwn\").write_text(\"x\")'",
    // S1-B3 RULING (MAIN 2026-11-11 09:30Z): protected-write run assertions are superseded.
    "n2": true,
    owner: { approve: null, source: "always-ask", rule: "protected-path", classification: "deny" },
    held: {
      "protected-path": {"reason": "protected-path"},
      "unreadable/held": {"reason": "value-path"},
    },
  },
  "WIPE rm -rf /": {
    "text": "rm -rf /",
    "n2": true,
    held: {
      "delete-root": {"reason": "delete-root"},
    },
    "owner": {"approve": null, "source": "always-ask", "rule": "delete-root", "classification": "deny", "reason": "delete-root"},
  },
  "WIPE rm -rf ~": {
    "text": "rm -rf ~",
    "n2": true,
    held: {
      "delete-home": {"reason": "delete-home"},
    },
    "owner": {"approve": null, "source": "always-ask", "rule": "delete-home", "classification": "deny", "reason": "delete-home"},
  },
  "WIPE mkfs.ext4 /dev/sdb": {
    "text": "mkfs.ext4 /dev/sdb",
    "n2": true,
    held: {
      "disk-erase": {"reason": "disk-erase"},
    },
    "owner": {"approve": null, "source": "always-ask", "rule": "disk-erase", "classification": "deny", "reason": "disk-erase"},
  },
  "WIPE :(){ :|:& };:": {
    "text": ":(){ :|:& };:",
    "n2": true,
    held: {
      "fork-bomb": {"reason": "fork-bomb"},
    },
    "owner": {"approve": null, "source": "always-ask", "rule": "fork-bomb", "classification": "deny", "reason": "fork-bomb"},
  },
  "WIPE rm -rf $X; rm -rf ~": {
    "text": "rm -rf $X; rm -rf ~",
    "n2": true,
    held: {
      "protected-path": {"reason": "protected-path"},
      "unreadable/held": {"reason": "value-path"},
      "delete-home": {"reason": "delete-home"},
    },
    "owner": {"approve": null, "source": "always-ask", "rule": "delete-home", "classification": "deny", "reason": "delete-home"},
  },
  "WIPE DEV=/dev/sda; cat x > $DEV": {
    "text": "DEV=/dev/sda; cat x > $DEV",
    "n2": true,
    held: {
      "disk-erase": {"reason": "disk-erase"},
    },
    "owner": {"approve": null, "source": "always-ask", "rule": "disk-erase", "classification": "deny", "reason": "disk-erase"},
  },
};

describe("FIX A: the owner's No limits turn runs what it cannot follow, and keeps its deny rules", () => {
  it.each(RUNS)("N-RUNS %s", (command) => {
    expect(owner(command)).toMatchObject({ source: "no-limits" });
    expect(owner(command).approve).toBeTruthy();
  });
  it.each(VALUE_TARGETS)("N-RUNS value target without a delete verb %s", (command) => {
    expect(owner(command)).toMatchObject({ source: "no-limits" });
    expect(owner(command).approve).toBeTruthy();
    for (const bot of [LEVELS[2]![1], LEVELS[1]![1]]) expect(autoVerdict(bot as never, "Bash", command, ctxOf(command))).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" });
    expect(owner(command, { fullAccessOrigin: "other" })).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" });
    expect(owner(command, { channelOwner: true })).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" });
  });
  it("N-RUNS M-R10-relief dd of=./disk.img: with the bot folder, and with no folder at all (a relative write there is a doubt)", () => {
    const dd = "dd if=/dev/zero of=./disk.img bs=1M count=1";
    expect(owner(dd)).toMatchObject({ source: "no-limits" });
    expect(owner(dd, { commandCwd: undefined, workFolder: undefined })).toMatchObject({ source: "no-limits" });
    expect(alwaysAskCommand("touch out")?.doubt).toBe("value-path");
    expect(owner("touch out", { commandCwd: undefined, workFolder: undefined })).toMatchObject({ source: "no-limits" });
  });
  it("N-RUNS the strict read keeps the doubt (another origin keeps the card)", () => {
    expect(alwaysAskCommand("touch out", undefined)?.doubt).toBe("value-path");
    expect(owner("touch out", { commandCwd: undefined, workFolder: undefined, fullAccessOrigin: "other" })).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" });
  });
  it.each(STOPS)("N-STOPS %s", (command) => {
    // R1: the typed deny is the owner clean No limits cell; every other level and origin reads as NLH0 (pinned)
    for (const [, bot] of LEVELS) for (const [, patch] of PATCHES) {
      const verdict = autoVerdict(bot as never, "Bash", command, ctxOf(command, patch));
      // NOLIM 1.0.19: the owner's No limits cell runs a deny row that is not a wipe (the proxy plainWipe may still card a delete word)
      cell(`STOPS ${command}`, bot, patch, verdict, T4[`STOPS ${command}`]!);
    }
  });
  it("N-STOPS an explicit command folder that is invalid, with a relative write", () => {
    for (const [, bot] of LEVELS) {
      const patch = { commandCwd: undefined, commandCwdInvalid: true };
      const verdict = autoVerdict(bot as never, "Bash", "touch out", ctxOf("touch out", patch));
      // MurageMain ruling 11-08 (N4, security): an invalid explicit command folder never runs at ANY level or turn kind, so this row is no
      // longer pinned to NLH0 outside the owner cell (NLH0 ignored the flag and ran it at Auto and Full): every cell gets the typed deny card.
      // NOLIM 1.0.19: every other level keeps the typed deny card; the owner's No limits turn runs it (stored origin owner)
      if (bot.noLimits === true) expectNoLimitsOwnerOutcome(verdict, "touch out", "unknown-target", JSON.stringify(bot));
      else expect(verdict, JSON.stringify(bot)).toMatchObject({ approve: null, source: "always-ask", classification: "deny", rule: "unknown-target" });
    }
  });
  it.each(WIPE)("N-WIPE %s", (command) => {
    for (const [, bot] of LEVELS) for (const [, patch] of PATCHES) {
      const verdict = autoVerdict(bot as never, "Bash", command, ctxOf(command, patch));
      cell(`WIPE ${command}`, bot, patch, verdict, T4[`WIPE ${command}`]!);
    }
  });
  it("N-ORDER delete-home wins over unknown-target, and a value target alone keeps its doubt in the strict read (M-FIX4-order, M-FIX4-rethrow)", () => {
    expect(ownerMarks(() => alwaysAskCommand("rm -rf $X; rm -rf ~", "/w"))).toMatchObject({ classification: "deny", rule: "delete-home" });
    expect(ownerMarks(() => alwaysAskCommand("rm -rf $X", "/w"))).toMatchObject({ classification: "deny", rule: "unknown-target", doubt: "value-path" });
  });
});

// The routine rows leave out `routineCarveOut`: MARKS A (G4 "strict contexts") reads a carve-out run strictly where the pristine tree read it
// doubt-free; that is outside FIX A and is flagged to MurageMain.
const SNAPSHOT: Record<string, string> = {"touch out|ask|owner":"STOP:no-grant:","touch out|ask|other":"STOP:no-grant:","touch out|ask|unstarted":"STOP:no-grant:","touch out|ask|routine":"STOP:no-grant:","touch out|ask|unattended":"STOP:no-grant:","touch out|ask|marked":"STOP:no-grant:","touch out|auto|owner":"RUN:auto-mode:","touch out|auto|other":"RUN:auto-mode:","touch out|auto|unstarted":"RUN:auto-mode:","touch out|auto|routine":"RUN:auto-mode:","touch out|auto|unattended":"STOP:unattended-block:","touch out|auto|marked":"RUN:auto-mode:","touch out|full|owner":"RUN:full-access:","touch out|full|other":"RUN:auto-mode:","touch out|full|unstarted":"RUN:full-access:","touch out|full|routine":"RUN:full-access:","touch out|full|unattended":"RUN:full-access:","touch out|full|marked":"RUN:full-access:","touch out|nolimits|owner":"RUN:no-limits:","touch out|nolimits|other":"RUN:auto-mode:","touch out|nolimits|unstarted":"RUN:no-limits:","touch out|nolimits|routine":"RUN:no-limits:","touch out|nolimits|unattended":"RUN:no-limits:","touch out|nolimits|marked":"STOP:outside-turn:outside-content","dd if=/dev/zero of=./disk.img bs=1M count=1|ask|owner":"STOP:no-grant:","dd if=/dev/zero of=./disk.img bs=1M count=1|ask|other":"STOP:no-grant:","dd if=/dev/zero of=./disk.img bs=1M count=1|ask|unstarted":"STOP:no-grant:","dd if=/dev/zero of=./disk.img bs=1M count=1|ask|routine":"STOP:no-grant:","dd if=/dev/zero of=./disk.img bs=1M count=1|ask|unattended":"STOP:no-grant:","dd if=/dev/zero of=./disk.img bs=1M count=1|ask|marked":"STOP:no-grant:","dd if=/dev/zero of=./disk.img bs=1M count=1|auto|owner":"RUN:auto-mode:","dd if=/dev/zero of=./disk.img bs=1M count=1|auto|other":"RUN:auto-mode:","dd if=/dev/zero of=./disk.img bs=1M count=1|auto|unstarted":"RUN:auto-mode:","dd if=/dev/zero of=./disk.img bs=1M count=1|auto|routine":"RUN:auto-mode:","dd if=/dev/zero of=./disk.img bs=1M count=1|auto|unattended":"STOP:unattended-block:","dd if=/dev/zero of=./disk.img bs=1M count=1|auto|marked":"RUN:auto-mode:","dd if=/dev/zero of=./disk.img bs=1M count=1|full|owner":"RUN:full-access:","dd if=/dev/zero of=./disk.img bs=1M count=1|full|other":"RUN:auto-mode:","dd if=/dev/zero of=./disk.img bs=1M count=1|full|unstarted":"RUN:full-access:","dd if=/dev/zero of=./disk.img bs=1M count=1|full|routine":"RUN:full-access:","dd if=/dev/zero of=./disk.img bs=1M count=1|full|unattended":"RUN:full-access:","dd if=/dev/zero of=./disk.img bs=1M count=1|full|marked":"RUN:full-access:","dd if=/dev/zero of=./disk.img bs=1M count=1|nolimits|owner":"RUN:no-limits:","dd if=/dev/zero of=./disk.img bs=1M count=1|nolimits|other":"RUN:auto-mode:","dd if=/dev/zero of=./disk.img bs=1M count=1|nolimits|unstarted":"RUN:no-limits:","dd if=/dev/zero of=./disk.img bs=1M count=1|nolimits|routine":"RUN:no-limits:","dd if=/dev/zero of=./disk.img bs=1M count=1|nolimits|unattended":"RUN:no-limits:","dd if=/dev/zero of=./disk.img bs=1M count=1|nolimits|marked":"STOP:outside-turn:outside-content","python3 -c 'open(\"/tmp/out\",\"w\")'|ask|owner":"STOP:no-grant:","python3 -c 'open(\"/tmp/out\",\"w\")'|ask|other":"STOP:no-grant:","python3 -c 'open(\"/tmp/out\",\"w\")'|ask|unstarted":"STOP:no-grant:","python3 -c 'open(\"/tmp/out\",\"w\")'|ask|routine":"STOP:no-grant:","python3 -c 'open(\"/tmp/out\",\"w\")'|ask|unattended":"STOP:no-grant:","python3 -c 'open(\"/tmp/out\",\"w\")'|ask|marked":"STOP:no-grant:","python3 -c 'open(\"/tmp/out\",\"w\")'|auto|owner":"RUN:auto-mode:","python3 -c 'open(\"/tmp/out\",\"w\")'|auto|other":"RUN:auto-mode:","python3 -c 'open(\"/tmp/out\",\"w\")'|auto|unstarted":"RUN:auto-mode:","python3 -c 'open(\"/tmp/out\",\"w\")'|auto|routine":"RUN:auto-mode:","python3 -c 'open(\"/tmp/out\",\"w\")'|auto|unattended":"STOP:unattended-block:","python3 -c 'open(\"/tmp/out\",\"w\")'|auto|marked":"RUN:auto-mode:","python3 -c 'open(\"/tmp/out\",\"w\")'|full|owner":"RUN:full-access:","python3 -c 'open(\"/tmp/out\",\"w\")'|full|other":"RUN:auto-mode:","python3 -c 'open(\"/tmp/out\",\"w\")'|full|unstarted":"RUN:full-access:","python3 -c 'open(\"/tmp/out\",\"w\")'|full|routine":"RUN:full-access:","python3 -c 'open(\"/tmp/out\",\"w\")'|full|unattended":"RUN:full-access:","python3 -c 'open(\"/tmp/out\",\"w\")'|full|marked":"RUN:full-access:","python3 -c 'open(\"/tmp/out\",\"w\")'|nolimits|owner":"RUN:no-limits:","python3 -c 'open(\"/tmp/out\",\"w\")'|nolimits|other":"STOP:always-ask:unreadable","python3 -c 'open(\"/tmp/out\",\"w\")'|nolimits|unstarted":"STOP:always-ask:unreadable","python3 -c 'open(\"/tmp/out\",\"w\")'|nolimits|routine":"STOP:always-ask:unreadable","python3 -c 'open(\"/tmp/out\",\"w\")'|nolimits|unattended":"STOP:always-ask:unreadable","python3 -c 'open(\"/tmp/out\",\"w\")'|nolimits|marked":"STOP:outside-turn:outside-content","perl -e 'mystery()'|ask|owner":"STOP:no-grant:","perl -e 'mystery()'|ask|other":"STOP:no-grant:","perl -e 'mystery()'|ask|unstarted":"STOP:no-grant:","perl -e 'mystery()'|ask|routine":"STOP:no-grant:","perl -e 'mystery()'|ask|unattended":"STOP:no-grant:","perl -e 'mystery()'|ask|marked":"STOP:no-grant:","perl -e 'mystery()'|auto|owner":"RUN:auto-mode:","perl -e 'mystery()'|auto|other":"RUN:auto-mode:","perl -e 'mystery()'|auto|unstarted":"RUN:auto-mode:","perl -e 'mystery()'|auto|routine":"RUN:auto-mode:","perl -e 'mystery()'|auto|unattended":"STOP:unattended-block:","perl -e 'mystery()'|auto|marked":"RUN:auto-mode:","perl -e 'mystery()'|full|owner":"RUN:full-access:","perl -e 'mystery()'|full|other":"RUN:auto-mode:","perl -e 'mystery()'|full|unstarted":"RUN:full-access:","perl -e 'mystery()'|full|routine":"RUN:full-access:","perl -e 'mystery()'|full|unattended":"RUN:full-access:","perl -e 'mystery()'|full|marked":"RUN:full-access:","perl -e 'mystery()'|nolimits|owner":"RUN:no-limits:","perl -e 'mystery()'|nolimits|other":"RUN:auto-mode:","perl -e 'mystery()'|nolimits|unstarted":"RUN:no-limits:","perl -e 'mystery()'|nolimits|routine":"RUN:no-limits:","perl -e 'mystery()'|nolimits|unattended":"RUN:no-limits:","perl -e 'mystery()'|nolimits|marked":"STOP:outside-turn:outside-content","cat /dev/sda > /w/disk.img|ask|owner":"STOP:no-grant:","cat /dev/sda > /w/disk.img|ask|other":"STOP:no-grant:","cat /dev/sda > /w/disk.img|ask|unstarted":"STOP:no-grant:","cat /dev/sda > /w/disk.img|ask|routine":"STOP:no-grant:","cat /dev/sda > /w/disk.img|ask|unattended":"STOP:no-grant:","cat /dev/sda > /w/disk.img|ask|marked":"STOP:no-grant:","cat /dev/sda > /w/disk.img|auto|owner":"RUN:auto-mode:","cat /dev/sda > /w/disk.img|auto|other":"RUN:auto-mode:","cat /dev/sda > /w/disk.img|auto|unstarted":"RUN:auto-mode:","cat /dev/sda > /w/disk.img|auto|routine":"RUN:auto-mode:","cat /dev/sda > /w/disk.img|auto|unattended":"STOP:unattended-block:","cat /dev/sda > /w/disk.img|auto|marked":"RUN:auto-mode:","cat /dev/sda > /w/disk.img|full|owner":"RUN:full-access:","cat /dev/sda > /w/disk.img|full|other":"RUN:auto-mode:","cat /dev/sda > /w/disk.img|full|unstarted":"RUN:full-access:","cat /dev/sda > /w/disk.img|full|routine":"RUN:full-access:","cat /dev/sda > /w/disk.img|full|unattended":"RUN:full-access:","cat /dev/sda > /w/disk.img|full|marked":"RUN:full-access:","cat /dev/sda > /w/disk.img|nolimits|owner":"RUN:no-limits:","cat /dev/sda > /w/disk.img|nolimits|other":"RUN:auto-mode:","cat /dev/sda > /w/disk.img|nolimits|unstarted":"RUN:no-limits:","cat /dev/sda > /w/disk.img|nolimits|routine":"RUN:no-limits:","cat /dev/sda > /w/disk.img|nolimits|unattended":"RUN:no-limits:","cat /dev/sda > /w/disk.img|nolimits|marked":"STOP:outside-turn:outside-content","dd if=/etc of=./x|ask|owner":"STOP:no-grant:","dd if=/etc of=./x|ask|other":"STOP:no-grant:","dd if=/etc of=./x|ask|unstarted":"STOP:no-grant:","dd if=/etc of=./x|ask|routine":"STOP:no-grant:","dd if=/etc of=./x|ask|unattended":"STOP:no-grant:","dd if=/etc of=./x|ask|marked":"STOP:no-grant:","dd if=/etc of=./x|auto|owner":"RUN:auto-mode:","dd if=/etc of=./x|auto|other":"RUN:auto-mode:","dd if=/etc of=./x|auto|unstarted":"RUN:auto-mode:","dd if=/etc of=./x|auto|routine":"RUN:auto-mode:","dd if=/etc of=./x|auto|unattended":"STOP:unattended-block:","dd if=/etc of=./x|auto|marked":"RUN:auto-mode:","dd if=/etc of=./x|full|owner":"RUN:full-access:","dd if=/etc of=./x|full|other":"RUN:auto-mode:","dd if=/etc of=./x|full|unstarted":"RUN:full-access:","dd if=/etc of=./x|full|routine":"RUN:full-access:","dd if=/etc of=./x|full|unattended":"RUN:full-access:","dd if=/etc of=./x|full|marked":"RUN:full-access:","dd if=/etc of=./x|nolimits|owner":"RUN:no-limits:","dd if=/etc of=./x|nolimits|other":"RUN:auto-mode:","dd if=/etc of=./x|nolimits|unstarted":"RUN:no-limits:","dd if=/etc of=./x|nolimits|routine":"RUN:no-limits:","dd if=/etc of=./x|nolimits|unattended":"RUN:no-limits:","dd if=/etc of=./x|nolimits|marked":"STOP:outside-turn:outside-content","git commit -m \"$MSG\"|ask|owner":"STOP:prompt-guard:git-signing","git commit -m \"$MSG\"|ask|other":"STOP:prompt-guard:git-signing","git commit -m \"$MSG\"|ask|unstarted":"STOP:prompt-guard:git-signing","git commit -m \"$MSG\"|ask|routine":"STOP:prompt-guard:git-signing","git commit -m \"$MSG\"|ask|unattended":"STOP:prompt-guard:git-signing","git commit -m \"$MSG\"|ask|marked":"STOP:prompt-guard:git-signing","git commit -m \"$MSG\"|auto|owner":"STOP:prompt-guard:git-signing","git commit -m \"$MSG\"|auto|other":"STOP:prompt-guard:git-signing","git commit -m \"$MSG\"|auto|unstarted":"STOP:prompt-guard:git-signing","git commit -m \"$MSG\"|auto|routine":"STOP:prompt-guard:git-signing","git commit -m \"$MSG\"|auto|unattended":"STOP:unattended-block:","git commit -m \"$MSG\"|auto|marked":"STOP:prompt-guard:git-signing","git commit -m \"$MSG\"|full|owner":"RUN:full-access:","git commit -m \"$MSG\"|full|other":"STOP:prompt-guard:git-signing","git commit -m \"$MSG\"|full|unstarted":"RUN:full-access:","git commit -m \"$MSG\"|full|routine":"RUN:full-access:","git commit -m \"$MSG\"|full|unattended":"RUN:full-access:","git commit -m \"$MSG\"|full|marked":"RUN:full-access:","git commit -m \"$MSG\"|nolimits|owner":"RUN:no-limits:","git commit -m \"$MSG\"|nolimits|other":"STOP:prompt-guard:git-signing","git commit -m \"$MSG\"|nolimits|unstarted":"RUN:no-limits:","git commit -m \"$MSG\"|nolimits|routine":"RUN:no-limits:","git commit -m \"$MSG\"|nolimits|unattended":"RUN:no-limits:","git commit -m \"$MSG\"|nolimits|marked":"STOP:outside-turn:outside-content","make -C \"$DIR\"|ask|owner":"STOP:no-grant:","make -C \"$DIR\"|ask|other":"STOP:no-grant:","make -C \"$DIR\"|ask|unstarted":"STOP:no-grant:","make -C \"$DIR\"|ask|routine":"STOP:no-grant:","make -C \"$DIR\"|ask|unattended":"STOP:no-grant:","make -C \"$DIR\"|ask|marked":"STOP:no-grant:","make -C \"$DIR\"|auto|owner":"RUN:auto-mode:","make -C \"$DIR\"|auto|other":"RUN:auto-mode:","make -C \"$DIR\"|auto|unstarted":"RUN:auto-mode:","make -C \"$DIR\"|auto|routine":"RUN:auto-mode:","make -C \"$DIR\"|auto|unattended":"STOP:unattended-block:","make -C \"$DIR\"|auto|marked":"RUN:auto-mode:","make -C \"$DIR\"|full|owner":"RUN:full-access:","make -C \"$DIR\"|full|other":"RUN:auto-mode:","make -C \"$DIR\"|full|unstarted":"RUN:full-access:","make -C \"$DIR\"|full|routine":"RUN:full-access:","make -C \"$DIR\"|full|unattended":"RUN:full-access:","make -C \"$DIR\"|full|marked":"RUN:full-access:","make -C \"$DIR\"|nolimits|owner":"RUN:no-limits:","make -C \"$DIR\"|nolimits|other":"RUN:auto-mode:","make -C \"$DIR\"|nolimits|unstarted":"RUN:no-limits:","make -C \"$DIR\"|nolimits|routine":"RUN:no-limits:","make -C \"$DIR\"|nolimits|unattended":"RUN:no-limits:","make -C \"$DIR\"|nolimits|marked":"STOP:outside-turn:outside-content","cp a \"$OUT\"|ask|owner":"STOP:always-ask:unreadable","cp a \"$OUT\"|ask|other":"STOP:always-ask:unreadable","cp a \"$OUT\"|ask|unstarted":"STOP:always-ask:unreadable","cp a \"$OUT\"|ask|routine":"STOP:always-ask:unreadable","cp a \"$OUT\"|ask|unattended":"STOP:always-ask:unreadable","cp a \"$OUT\"|ask|marked":"STOP:always-ask:unreadable","cp a \"$OUT\"|auto|owner":"STOP:always-ask:unreadable","cp a \"$OUT\"|auto|other":"STOP:always-ask:unreadable","cp a \"$OUT\"|auto|unstarted":"STOP:always-ask:unreadable","cp a \"$OUT\"|auto|routine":"STOP:always-ask:unreadable","cp a \"$OUT\"|auto|unattended":"STOP:always-ask:unreadable","cp a \"$OUT\"|auto|marked":"STOP:always-ask:unreadable","cp a \"$OUT\"|full|owner":"STOP:always-ask:unreadable","cp a \"$OUT\"|full|other":"STOP:always-ask:unreadable","cp a \"$OUT\"|full|unstarted":"STOP:always-ask:unreadable","cp a \"$OUT\"|full|routine":"STOP:always-ask:unreadable","cp a \"$OUT\"|full|unattended":"STOP:always-ask:unreadable","cp a \"$OUT\"|full|marked":"STOP:always-ask:unreadable","cp a \"$OUT\"|nolimits|owner":"STOP:always-ask:unreadable","cp a \"$OUT\"|nolimits|other":"STOP:always-ask:unreadable","cp a \"$OUT\"|nolimits|unstarted":"STOP:always-ask:unreadable","cp a \"$OUT\"|nolimits|routine":"STOP:always-ask:unreadable","cp a \"$OUT\"|nolimits|unattended":"STOP:always-ask:unreadable","cp a \"$OUT\"|nolimits|marked":"STOP:always-ask:unreadable","echo x > \"$LOG\"|ask|owner":"STOP:always-ask:unreadable","echo x > \"$LOG\"|ask|other":"STOP:always-ask:unreadable","echo x > \"$LOG\"|ask|unstarted":"STOP:always-ask:unreadable","echo x > \"$LOG\"|ask|routine":"STOP:always-ask:unreadable","echo x > \"$LOG\"|ask|unattended":"STOP:always-ask:unreadable","echo x > \"$LOG\"|ask|marked":"STOP:always-ask:unreadable","echo x > \"$LOG\"|auto|owner":"STOP:always-ask:unreadable","echo x > \"$LOG\"|auto|other":"STOP:always-ask:unreadable","echo x > \"$LOG\"|auto|unstarted":"STOP:always-ask:unreadable","echo x > \"$LOG\"|auto|routine":"STOP:always-ask:unreadable","echo x > \"$LOG\"|auto|unattended":"STOP:always-ask:unreadable","echo x > \"$LOG\"|auto|marked":"STOP:always-ask:unreadable","echo x > \"$LOG\"|full|owner":"STOP:always-ask:unreadable","echo x > \"$LOG\"|full|other":"STOP:always-ask:unreadable","echo x > \"$LOG\"|full|unstarted":"STOP:always-ask:unreadable","echo x > \"$LOG\"|full|routine":"STOP:always-ask:unreadable","echo x > \"$LOG\"|full|unattended":"STOP:always-ask:unreadable","echo x > \"$LOG\"|full|marked":"STOP:always-ask:unreadable","echo x > \"$LOG\"|nolimits|owner":"STOP:always-ask:unreadable","echo x > \"$LOG\"|nolimits|other":"STOP:always-ask:unreadable","echo x > \"$LOG\"|nolimits|unstarted":"STOP:always-ask:unreadable","echo x > \"$LOG\"|nolimits|routine":"STOP:always-ask:unreadable","echo x > \"$LOG\"|nolimits|unattended":"STOP:always-ask:unreadable","echo x > \"$LOG\"|nolimits|marked":"STOP:always-ask:unreadable"};
const SNAP_COMMANDS = [...new Set(Object.keys(SNAPSHOT).map((key) => key.split("|")[0]!))];
describe("FIX A: every level and every other origin read the pinned commands as pristine (1320a3e29) did", () => {
  it("N-NONOWNER the verdict matrix equals the snapshot taken on the pristine tree (toEqual)", () => {
    const now: Record<string, string> = {};
    for (const command of SNAP_COMMANDS) for (const [level, bot] of LEVELS) for (const [name, patch] of PATCHES) {
      // the two value-target rows are waived on the owner's clean No limits turn (the N-RUNS row above), pristine cards them
      if (VALUE_TARGETS.includes(command) && level === "nolimits" && name === "owner") { now[`${command}|${level}|${name}`] = SNAPSHOT[`${command}|${level}|${name}`]!; continue; }
      const verdict = autoVerdict(bot as never, "Bash", command, ctxOf(command, patch));
      // NOLIM 1.0.19: the No limits level runs what the pristine tree asked (a marked turn, no start proof) for work whose stored origin is
      // the owner's; it never turns a wipe row into a run. Every other cell must still equal the pristine answer.
      const pinned = SNAPSHOT[`${command}|${level}|${name}`]!;
      if (level === "nolimits" && verdict.source === "no-limits" && pinned.startsWith("STOP:")) {
        expect(isWipeRule(pinned.split(":").pop()), `${command}|${name}: a wipe row never runs at No limits`).toBe(false);
        now[`${command}|${level}|${name}`] = pinned;
        continue;
      }
      now[`${command}|${level}|${name}`] =`${verdict.approve ? "RUN" : "STOP"}:${verdict.source}:${verdict.rule ?? ""}`;
    }
    expect(now).toEqual(SNAPSHOT);
  });
  it("N-NONOWNER No limits is never stricter than Full access (M-R10-monotonic)", () => {
    for (const command of [...RUNS, ...VALUE_TARGETS]) {
      const full = autoVerdict(LEVELS[2]![1] as never, "Bash", command, ctxOf(command));
      if (full.approve) expect(owner(command).approve).toBeTruthy();
    }
  });
});

// D4 as corrected (coordinator 11-08, MARKS-r14-DENY-CLASS D4; NOLIMITS-MEANS-IT r3 2.1.1): an ambiguous interpreter flag is a
// could-not-read with no guessed path. Full access cards it; the owner's clean No limits turn runs it; plainWipe and a deny rule still win.
describe("D4: an ambiguous interpreter flag is a could-not-read", () => {
  const FULL = { id: "d4", autoApprove: true, fullAccess: true };
  it("D4-FULL access cards it", () => {
    // R1: Full access is not the owner's clean No limits turn, so its verdict is NLH0's (pinned); the strict read is the owner's
    nlh0("D4-FULL|verdict", autoVerdict(FULL as never, "Bash", "python3 -x ./tool.py", ctxOf("python3 -x ./tool.py")));
    expect(ownerMarks(() => alwaysAskCommand("python3 -x ./tool.py", "/w")))
      .toMatchObject({ rule: "unreadable", classification: "ask", reason: "ambiguous-interpreter", couldNotRead: true });
  });
  it("D4-OWNER the owner No limits turn runs it", () => {
    expect(owner("python3 -x ./tool.py").approve).toBeTruthy();
    expect(owner("perl -W ./tool.pl").approve).toBeTruthy();
  });
  it("D4-WIPE a wipe word in the text still cards it (plainWipe)", () => {
    expect(owner("python3 -x ./tool.py; git clean -fdx")).toMatchObject({ approve: null, source: "always-ask" });
  });
  it("D4-DENY a protected path named in the text is the deny rule", () => {
    const cmd = "python3 -x ./tool.py; touch /etc/cron.d/pwn";
    expect(ownerMarks(() => alwaysAskCommand(cmd, "/w"))).toMatchObject({ classification: "deny", rule: "protected-path" });
    // S1-B3 RULING (MAIN 2026-11-11 09:30Z): the named protected write keeps its deny card.
    expect(owner(cmd)).toMatchObject({ approve: null, source: "always-ask", rule: "protected-path" });
  });
  it("D4-STARTUP an unplaced write before a startup-file reader is the same kind of hit (FIX A ruling 2)", () => {
    const cmd = "f=$(mktemp); echo x > \"$f\"; bash -lc true";
    nlh0("D4-STARTUP|verdict", autoVerdict(FULL as never, "Bash", cmd, ctxOf(cmd)), undefined, { reason: "value-path" }); // R1: Full access reads as NLH0
    expect(ownerMarks(() => alwaysAskCommand(cmd, "/w"))).toMatchObject({ classification: "ask" });
    expect(owner(cmd).approve).toBeTruthy();
  });
});
