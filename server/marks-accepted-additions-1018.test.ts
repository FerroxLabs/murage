// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MARKS FIX A (MurageMain ruling 11-08): each accepted addition has its own named row, so a mutant of that one addition is red
// on that row family alone. 1 byDesign held=waived, 2 lone-backslash skip, 3 N5 `+` joins, 4 shell/wipe-vocab.ts.
// Fixture strings are inert data, never executed.
import { describe, expect, it } from "vitest";
import { alwaysAskCommand as alwaysAskRaw } from "./always-ask.ts";
import { autoVerdict, type AutoContext } from "./auto-approve.ts";
import { DELETE_FLAGS, DELETE_VERBS, DISK_VERBS, wipeVerb, wipeWordIn } from "./shell/wipe-vocab.ts";
import { doubtFree as doubtFreeRaw } from "./testing/marks-doubt-free.ts";
import { ownerMarks } from "./testing/marks-nlh0.ts";

// MARKS R1 (MurageMain 11-08, G1): these rows state the owner clean No limits strict read, so each reader call runs under ownerMarks;
// every other level and origin reads as NLH0 (its NLH0 rows are in marks-owner-reads-1018.test.ts, which has no wipe-vocab import and so also runs on NLH0).
const alwaysAskCommand: typeof alwaysAskRaw = (...args) => ownerMarks(() => alwaysAskRaw(...args));
const doubtFree: typeof doubtFreeRaw = (...args) => ownerMarks(() => doubtFreeRaw(...args));

const OWNER = { id: "owned", autoApprove: true, fullAccess: true, noLimits: true };
const FULL = { id: "owned", autoApprove: true, fullAccess: true };
const context = (command: string) => ({ commandText: command, commandCwd: "/w", workFolder: "/w",
  fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null,
  unseen: { platform: "posix", fs: { realpath: (path: string) => path, stat: () => ({ isFile: () => true, isDirectory: () => false }) } },
  sessionFile: () => "unavailable" }) as unknown as AutoContext;
const verdict = (bot: object, command: string) => autoVerdict(bot as never, "Bash", command, context(command));

describe("MARKS-ACCEPTED-1 byDesign held=waived", () => {
  // the exemption in nlmi-marks-r16-rows.test.ts `cards()` is only legitimate while the product really answers a could-not-read on the
  // owner's clean No limits turn with a run tagged held=waived, and Full access cards that same command
  it.each(['cp a "$OUT"', 'echo x > "$LOG"'])("MARKS-ACCEPTED-1 %s runs tagged held=waived, Full access cards it", (command) => {
    const owner = verdict(OWNER, command);
    expect(owner.approve).toBeTruthy();
    expect(owner.rule).toBe("held=waived");
    expect(verdict(FULL, command).approve).toBeNull();
  });
});

describe("MARKS-ACCEPTED-2 lone backslash is find's terminator", () => {
  const BS = String.fromCharCode(92); // one backslash
  it.each(["find ./a -name x -exec touch {} $BS;", "find /w -type f -exec chmod 600 {} $BS;", "find ./a -exec cp {} /w/b $BS;"].map((c) => c.replace("$BS", BS)))("MARKS-ACCEPTED-2 %s", (command) => {
    expect(alwaysAskCommand(command, "/w")?.classification).not.toBe("deny"); // the strict reader may doubt find -exec; it is never a deny
    expect(doubtFree(command, "/w")).toBeNull();
    expect(verdict(OWNER, command).approve).toBeTruthy();
  });
});



describe("MARKS-ACCEPTED-2b lone backslash left by a doubled terminator", () => {
  const BS = String.fromCharCode(92);
  // the reader keeps one backslash of a doubled terminator as a lone word; read as a Windows drive root it would be a protected-path deny
  it.each(["find . -exec echo {} BS;", "find ./a -exec touch {} BS;", "find . -type f -exec ls {} BS;"].map((c) => c.replace("BS", BS + BS)))("MARKS-ACCEPTED-2 doubled terminator %s", (command) => {
    for (const hit of [alwaysAskCommand(command, "/w"), doubtFree(command, "/w")]) {
      expect(hit?.classification).not.toBe("deny");
      expect(hit?.rule).not.toBe("protected-path");
    }
  });
});

describe("MARKS-ACCEPTED-3 N5 protected path joined from adjacent literals", () => {
  it.each([`python3 -c 'open("/et"+"c/cron.d/pwn","w").write("x")'`, `python3 -c 'open("/e"+"tc"+"/passwd","w")'`])("MARKS-ACCEPTED-3 %s", (command) => {
    for (const hit of [alwaysAskCommand(command, "/w"), doubtFree(command, "/w")]) {
      expect(hit).toMatchObject({ classification: "deny", rule: "unknown-target" });
    }
    expect(verdict(OWNER, command)).toMatchObject({ approve: null, classification: "deny" });
  });
  it("MARKS-ACCEPTED-3 joined literals that are not protected stay unflagged", () => {
    expect(doubtFree(`python3 -c 'print("/tm"+"p/out")'`, "/w")?.classification).not.toBe("deny");
  });
});

describe("MARKS-ACCEPTED-4 shell/wipe-vocab.ts", () => {
  it("MARKS-ACCEPTED-4 vocabulary exports", () => {
    for (const verb of ["rm", "rmdir", "shred", "unlink"]) expect(DELETE_VERBS.has(verb), verb).toBe(true);
    for (const flag of ["-delete", "--delete", "--remove-source-files"]) expect(DELETE_FLAGS.has(flag), flag).toBe(true);
    for (const verb of ["wipefs", "diskutil", "mke2fs"]) expect(DISK_VERBS.has(verb), verb).toBe(true);
  });
  it("MARKS-ACCEPTED-4 wipeVerb", () => {
    expect(wipeVerb("rm", ["-rf", undefined])).toBe(true);
    expect(wipeVerb("mkfs.ext4", [undefined])).toBe(true);
    expect(wipeVerb("dd", ["if=a", "of=b"])).toBe(true);
    expect(wipeVerb("find", [".", "-delete"])).toBe(true);
    expect(wipeVerb("rsync", ["--delete", "a", "b"])).toBe(true);
    expect(wipeVerb("cp", ["a", "b"])).toBe(false);
    expect(wipeVerb("dd", ["if=a", "of"])).toBe(false);
  });
  it("MARKS-ACCEPTED-4 wipeWordIn", () => {
    expect(wipeWordIn("shutil.rmtree(x)")).toBe("rmtree");
    expect(wipeWordIn("fs.rmSync(p)")).toBe("rmSync");
    expect(wipeWordIn("print(1)")).toBeUndefined();
  });
  it("MARKS-ACCEPTED-4 DISK_VERBS name disk-erase programs and wipeVerb reads them as wipes", () => {
    for (const verb of ["wipefs", "diskutil", "mke2fs", "newfs", "diskpart"]) {
      expect(DISK_VERBS.has(verb), verb).toBe(true);
      expect(wipeVerb(verb, [undefined]), verb).toBe(true);
    }
  });
  it("MARKS-ACCEPTED-4 WIPE_WORD names delete and disk words in inline code", () => {
    for (const word of ["rmtree", "shutil.rmtree(x)", "os.rmdir(p)", "fs.rmSync(p)", "wipefs /dev/x", "rimraf(p)"]) expect(wipeWordIn(word), word).toBeDefined();
    expect(wipeWordIn("print(1)")).toBeUndefined();
  });
  it("MARKS-ACCEPTED-4 N2 a value that is a whole delete target is unknown-target", () => {
    for (const hit of [alwaysAskCommand('rm -rf "$X"', "/w"), doubtFree('rm -rf "$X"', "/w")]) expect(hit).toMatchObject({ classification: "deny", rule: "unknown-target" });
    expect(doubtFree('cp a "$OUT"', "/w")?.classification).not.toBe("deny");
  });
  it("MARKS-ACCEPTED-4 N5 inline code holding a wipe word is unknown-target", () => {
    expect(verdict(OWNER, `perl -e 'unlink($x); mystery()'`)).toMatchObject({ approve: null, classification: "deny", rule: "unknown-target" });
  });
});

describe("MARKS-ACCEPTED-5 owner clean No limits runs an unseen script file", () => {
  // MurageMain 11-08 (open flag, Sean's No-limits rule): `node ./build.js` and `bash ./build.sh` on the owner's own clean No limits turn
  // run with no card; the same command cards without the owner-started proof (a channel or relayed turn) and at Full access's no-proof shape.
  it.each(["node ./build.js", "bash ./build.sh"])("MARKS-ACCEPTED-5 %s runs on the owner's clean No limits turn, no card", (command) => {
    expect(verdict(OWNER, command).approve, command).toBeTruthy();
  });
  it.each(["node ./build.js", "bash ./build.sh"])("MARKS-ACCEPTED-5 %s still cards without the owner-started proof", (command) => {
    for (const proof of [{ ownerStarted: false }, { fullAccessOrigin: "other" }]) {
      expect(autoVerdict(OWNER as never, "Bash", command, { ...context(command), ...proof } as AutoContext).approve, `${command} ${JSON.stringify(proof)}`).toBeNull();
    }
  });
});
