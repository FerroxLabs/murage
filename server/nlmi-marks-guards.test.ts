// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { candidatesOf, canonPath, deviceInWord, newContext, outputOption, procCanonical, procTraversal, walkScript, writtenKey } from "./shell/walk.ts";
import { compilerResponse, genericResponse, checkSed, interpolated, checkCommandOptions, checkEnvironment } from "./shell/marks.ts";
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markCallOutside } from "./outside-wire.ts";
import { alwaysAskCommand, alwaysAskUnreadableReason, protectedClass, unreadableHit } from "./always-ask.ts";
import { nlh0, ownerMarks } from "./testing/marks-nlh0.ts";
import { autoVerdict, marksHitWaivable, type AutoContext } from "./auto-approve.ts";
import { outsideScanMarks } from "./outside-scan.ts";
import { beginOutsideTurn, forgetOutsideState, turnOutsideExempt, turnOutsideMark, wireOutsideStore } from "./email/external-marks.ts";

const reason = (cmd: string) => alwaysAskCommand(cmd, "/w")?.doubt;
// FIX A (ruling N3/N1): a spelled path through a protected folder is the typed deny, not a closed-list doubt
// MARKS R1 (G1): the typed deny is the owner clean No limits read, so these rows read under ownerMarks; the non-owner read is NLH0 (see the NLH0 rows below)
const denied = (cmd: string, rule = "protected-path") => expect(ownerMarks(() => alwaysAskCommand(cmd, "/w"))).toMatchObject({ classification: "deny", rule });
describe("FIX3 raw writes and data", () => {
  const visitor = { command: () => null, redirect: () => null, forkBomb: () => "fork", catastrophic: () => true };
  it("M-FIX3-target record destination before folding", () => {
    expect(() => walkScript("cp blob /w/../etc/../w/x", newContext("/w"), visitor)).toThrow("value-path");
  });
  it("M-FIX3-record-data data with a path shape", () => {
    expect(() => walkScript(`echo ${"a".repeat(4097)}.txt`, newContext("/w"), visitor)).not.toThrow();
  });
  it("M-FIX3-data 131072 character word is data", () => {
    expect(() => candidatesOf({ parts: [{ kind: "lit", text: "a".repeat(131072), quote: "none" }] }, newContext("/w"))).not.toThrow();
  });
  it.each(["/w/../etc/../w/x", "/tmp/../proc/../w/x", "/x/../dev/../w/y"])("M-FIX3-class %s", path => {
    expect(protectedClass(path)).toBe("system");
  });
  it.each(["tar -C /w/../etc/../w/x -xf blob", "unzip -d /tmp/../sys/../w/x blob",
    "rsync blob /tmp/../proc/../w/out", "zip /x/../dev/../w/y blob"])("M-FIX3-model %s", cmd => {
    // MARKS r9 C2: probe tar -C /w/../etc/../w/x -xf blob (and unzip/rsync/zip) -> {rule:unreadable,doubt:value-path} (was tokenizer)
    denied(cmd); // FIX A migration (N3): was doubt value-path
  });
  it.each([
    "cp blob /tmp/../proc/../w/out", "mv blob /x/../dev/../w/y",
    "tee /w/../etc/../w/x", "touch /tmp/../sys/../w/x",
    "install blob /tmp/../var/spool/cron/../../../w/z",
    "ln blob /tmp/../proc/../w/out",
    "printf x > /tmp/../sys/../w/x",
  ])("M-FIX3-raw %s", cmd => denied(cmd)); // FIX A migration (N3): was doubt value-path
  // MARKS r9 C2: probe dd if=blob of=/w/../etc/../w/x (cwd /w) -> {rule:protected-path}; still cards, named by rule not doubt
  it.each(["dd if=blob of=/w/../etc/../w/x"])("M-FIX3-raw %s", cmd => expect(["protected-path", "unreadable"]).toContain(alwaysAskCommand(cmd, "/w")?.rule)); // M-R10: the strict read keeps its doubt; the doubt-free read names protected-path (full-deny-1018.test.ts)
  it.each(["/etc/" + "./".repeat(3000) + "passwd", "/w/" + "../".repeat(2000) + "etc/passwd",
    "/w/" + "a".repeat(5000)])("M-FIX3-overlong %s", path => {
    // FIX A migration (N3): the two climbs name a protected folder (deny); the overlong plain /w path stays a doubt
    if (path.startsWith("/w/a")) expect(reason(`cp blob ${path}`)).toBe("value-path");
    else denied(`cp blob ${path}`);
  });
  it.each([4097, 131072 - 10])("M-FIX3-data printf %i", size => expect(reason(`printf %s ${"a".repeat(size)}`)).toBeUndefined());
  it("M-FIX3-data echo 70000", () => expect(reason(`echo ${"a".repeat(70000)}`)).toBeUndefined());
  it("M-FIX3-data protected redirect", () => denied(`printf %s ${"a".repeat(4097)} > /etc/x`)); // FIX A migration (N3): was doubt value-path
  it.each(["/w/../etc/../w/x", "/x/../dev/../w/y", "/tmp/../sys/../w/x"])("M-FIX3-climb %s", path => {
    expect(canonPath(path, newContext("/w"), "write").value).toBe(true);
  });
});
describe("MARKS independent guard witnesses", () => {
  // MARKS r9 C2: probe /usr/bin/env echo x, command /usr/bin/env echo x, /bin/command echo x (cwd /w) -> null (readable system programs run by design, FIX-LEDGER :4041)
  it.each(["/usr/bin/env echo x", "command /usr/bin/env echo x", "/bin/command echo x"])("M-FIX2-wrapper-path %s", cmd => expect(alwaysAskCommand(cmd, "/w")).toBeNull());
  it.each(["xargs -a/w/L echo", "xargs -0a/w/L echo", "env xargs -a/w/L echo", "command xargs --arg-file=/w/L echo"])("M-PR-6c attached and wrapped %s", cmd => expect(reason(cmd)).toBe("file-fed-args"));
  it.each(["tar", "rsync", "ssh", "scp", "git", "gcc", "clang", "zip", "unzip", "docker", "find"])("M-FIX2-model %s", name => {
    expect(() => checkCommandOptions(name, [])).toThrow();
  });
  it.each(["--unknown", "-Z", "-aZ", "--help=exec"])("M-FIX2-option %s", option => {
    expect(() => checkCommandOptions("cp", [option])).toThrow();
  });
  it("M-FIX2-option-value missing value", () => expect(() => checkCommandOptions("sort", ["-o"])).toThrow());
  it("M-FIX2-long-value missing value", () => expect(() => checkCommandOptions("sort", ["--output"])).toThrow());
  it("M-FIX2-dd unknown assignment", () => expect(() => checkCommandOptions("dd", ["unknown=proj"])).toThrow());
  it("FIX2 modeled option controls", () => {
    for (const args of [["-oout", "notes"], ["-o", "out", "notes"], ["--output=out", "notes"], ["--output", "out", "notes"]]) {
      expect(() => checkCommandOptions("sort", args)).not.toThrow();
    }
    expect(() => checkCommandOptions("dd", ["if=proj", "of=proj"])).not.toThrow();
  });
  it.each(["GIT_SSH_COMMAND", "GIT_SSH", "PAGER", "EDITOR", "GIT_CONFIG_COUNT", "BASH_ENV"])("M-FIX2-env %s", name => {
    expect(() => checkEnvironment(name)).toThrow();
  });
  it.each(["/etc/cron.d/pwn", "/proc/self/fd/1", "/var/spool/cron/root", "C:/Windows/Temp/x"])("M-FIX2-protected %s", path => {
    expect(protectedClass(path)).not.toBeNull();
  });
  it.each(["/tmp/out", "/data/out"])("M-FIX2-python-root %s", path => {
    expect(reason(`python3 -c 'open("${path}","w").write("x")'`)).toBe("value-path");
  });
  it("M-FIX2-waiver no unreadable waiver", () => {
    expect(marksHitWaivable({ ...unreadableHit(), couldNotRead: true })).toBe(false);
    expect(marksHitWaivable({ ...unreadableHit(), unseenScript: true })).toBe(false);
  });
  it("M-FIX2-current current bytes beat a safe session", () => {
    expect(alwaysAskCommand("cat > /w/a.py <<'PY'\nmystery()\nPY\npython3 /w/a.py", "/w", "command", undefined, undefined, undefined,
      { sessionEdits: new Set(["/w/a.py"]), sessionFile: () => ({ text: "print(1)" }) })?.doubt).toBe("tokenizer");
  });
  it("M-FIX2-key canonical identities", () => {
    const ctx = newContext("/w");
    expect(writtenKey(ctx, "/w/./a.py")).toBe(writtenKey(ctx, "/w/a.py"));
    expect(writtenKey(ctx, "C:/W/A.py")).toBe(writtenKey(ctx, "c:/w/a.py"));
  });
  it("M-FIX2-pending-link same-text parent links need disk proof", () => {
    const ctx = newContext("/w");
    ctx.links.set("/w/alias", "/etc");
    expect(() => canonPath("alias/out", ctx, "write")).toThrow();
    expect(() => canonPath("alias/../out", ctx, "read")).toThrow();
  });
  it("M-FIX2-key symlink parent shares current bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "marks-key-"));
    try {
      mkdirSync(join(root, "real"));
      symlinkSync(join(root, "real"), join(root, "alias"));
      const ctx = newContext(root);
      expect(writtenKey(ctx, join(root, "alias/a.py"))).toBe(writtenKey(ctx, join(root, "real/a.py")));
      expect(alwaysAskCommand(`cat > ${root}/alias/a.py <<'PY'\nmystery()\nPY\npython3 ${root}/real/a.py`, root,
        "command", undefined, undefined, undefined, { sessionEdits: new Set([`${root}/real/a.py`]), sessionFile: () => ({ text: "print(1)" }) })?.doubt).toBe("tokenizer");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("FIX2 attack B symlink write cp ./blob /tmp/escape/pwn", () => {
    const root = mkdtempSync(join(tmpdir(), "marks-escape-"));
    try {
      symlinkSync("/etc/cron.d", join(root, "escape"));
      // FIX A migration (N3, rule 7): a link the reader can resolve is classified on its real target. Where /etc/cron.d exists the
      // link resolves into a protected folder (deny); where it does not, the link is unresolved and stays a doubt
      const hit = ownerMarks(() => alwaysAskCommand(`cp ./blob ${root}/escape/pwn`, root));
      if (existsSync("/etc/cron.d")) expect(hit).toMatchObject({ classification: "deny", rule: "protected-path" });
      else expect(hit?.doubt).toBe("value-path");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("M-FIX2-copy direct copy of unread bytes", () => expect(reason("cp /w/unknown /w/runner; /w/runner")).toBe("command"));
  it.each(["/opt/custom-tool", "/w/wipe.sh", "'/w/custom\\tool'", "/w/echo"])("M-FIX2-command %s", cmd => expect(reason(cmd)).toBe("command"));
  it.each(["/w/./a.py", "/w//a.py", "/w/sub/../a.py"])("M-FIX2-key %s", path => {
    expect(alwaysAskCommand(`cat > ${path} <<'PY'\nmystery()\nPY\npython3 /w/a.py`, "/w", "command", undefined, undefined, undefined,
      { sessionEdits: new Set(["/w/a.py"]), sessionFile: () => ({ text: "print(1)" }) })?.doubt).toBe("tokenizer");
  });
  it("M-FIX2-session noncanonical session key", () => {
    expect(alwaysAskCommand("python3 /w/a.py", "/w", "command", undefined, undefined, undefined,
      { sessionEdits: new Set(["/w/./a.py"]), sessionFile: () => ({ text: "print(1)" }) })?.doubt).toBe("unavailable-exec");
  });
  it.each(["sed -f/w/F notes", "sed -nf/w/F notes", "sed --file=/w/F notes"])("M-FIX2-shadow %s", cmd => {
    expect(alwaysAskCommand(`echo x >> /w/F; ${cmd}`, "/w", "command", undefined, undefined, undefined,
      { sessionEdits: new Set(["/w/F"]), sessionFile: () => ({ text: "1p" }) })?.doubt).toBe("tokenizer");
  });
  it.each([
    "sed -f/w/F notes", "sed -fF notes", "sed --file=F notes", "sed --expression='w /etc/passwd' notes",
    "sed --expression 'w /etc/passwd' notes", "sed -e'w /etc/passwd' notes", "sed -nfF notes",
    "sed -i.bak 1p notes", "sed -ni 1p notes", "sed --unknown 1p notes",
    "awk -fF notes", "gawk --file=F notes", "perl -e'mystery()'", "perl -we'print 1'",
  ])("FIX2 G3 existing parser sibling %s", cmd => {
    // FIX A migration (N3): a sed expression that writes /etc/passwd is a literal protected write (deny); the others stay doubts
    if (/'w \/etc\/passwd'/.test(cmd)) denied(cmd);
    else expect(reason(cmd)).toBe("tokenizer");
  });
  // MARKS r9 C2: probe sed -sne 1p notes (cwd /w) -> null (a readable sed -n print runs by design, FIX-LEDGER :4041)
  it.each(["sed -sne 1p notes"])("FIX2 G3 existing parser sibling %s", cmd => expect(alwaysAskCommand(cmd, "/w")).toBeNull());
  // These rows need the outside-scan.ts patch recorded in ALLOW-LIST.md.
  it.each(["ler\\\nna run build", "n\\\nx build", "tur\\\r\nbo run build"])("M-FIX2-runner needs item 6 patch %s", cmd => {
    expect(outsideScanMarks(cmd)).toContain("interpreter");
  });
  it("M-R1-sed every expression", () => expect(() => checkSed(["-e", "1p", "-e", "w /etc/passwd"], () => undefined)).toThrow());
  it("M-R1-option unknown option", () => expect(() => checkSed(["-i", "1p", "notes"], () => undefined)).toThrow());
  it.each(["cp -t../etc blob", "cp -at../etc blob", "install -t../etc blob", "ln -t../etc blob"])("M-R1-target %s", cmd => expect(reason(cmd)).toBe("value-path"));
  // MARKS r9 C2: probe cp -at ../etc blob and mv --target-directory=../etc blob (cwd /w) -> {rule:protected-path}; still cards, named by rule
  it.each(["cp -at ../etc blob", "mv --target-directory=../etc blob"])("M-R1-target %s", cmd => expect(["protected-path", "unreadable"]).toContain(alwaysAskCommand(cmd, "/w")?.rule));
  it("M-R1-literal plain strings exclude interpolation", () => expect(interpolated('puts "#{1}"')).toBe(true));
  it("M-R1-interpreter-option ruby in-place", () => expect(reason(`ruby -e 'puts 1' -i notes`)).toBe("tokenizer"));
  it("M-R1-unknown-option python option", () => expect(reason(`python3 -Z -c 'print(1)'`)).toBe("tokenizer"));
  // M-R10: inline code is read by the family scan at every level; the closed grammar holds the code this text wrote to a file
  it("M-R1-format field lookup", () => expect(alwaysAskCommand("python3 /w/F", "/w", "command", undefined, undefined, undefined,
    { sessionEdits: new Set(["/w/F"]), sessionFile: () => ({ text: 'print("{0.__class__}".format(1))' }) })?.doubt).toBe("tokenizer"));
  it("M-R1-fold complete drive path", () => expect(canonPath("out", newContext("C:/Windows"), "write").value).toBe(true));
  it("M-R1-resolve symlink parent before climb", () => {
    const root = mkdtempSync(join(tmpdir(), "marks-path-"));
    try {
      mkdirSync(join(root, "cwd"));
      symlinkSync("/etc", join(root, "cwd", "link"));
      expect(canonPath("link/passwd", newContext(join(root, "cwd")), "write").value).toBe(true);
      expect(canonPath("link/../etc/passwd", newContext(join(root, "cwd")), "write").value).toBe(true);
      expect(canonPath("passwd", newContext(join(root, "cwd", "link")), "write").value).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("M-R1-dangling uncertain symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "marks-link-"));
    try {
      symlinkSync(join(root, "missing"), join(root, "link"));
      expect(() => canonPath("link/out", newContext(root), "write")).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["w /etc/passwd", "W /etc/passwd", "s/x/y/w /etc/passwd"])("sed file program %s", text => {
    expect(alwaysAskCommand("sed -n -f /w/F notes", "/w", "command", undefined, undefined, undefined,
      { sessionEdits: new Set(["/w/F"]), sessionFile: () => ({ text }) })?.doubt).toBe("tokenizer");
  });
  it.each([
    "sed -n -e 1p -e 'w /etc/passwd' notes", "sed --expression=1p --expression='W /etc/passwd' notes",
    "sed -ne 's/x/y/w /etc/passwd' notes", "sed -n -e 'e echo x' notes",
    "sed -n -e 'r /etc/passwd' notes", "sed -n -e 'R /etc/passwd' notes",
    "sed -i 1p notes", "sed --in-place=.bak 1p notes", "sed -nf /w/F notes",
    "perl -pi -e 'print 1' notes",
  ])("M-R1-program %s", cmd => {
    // FIX A migration (N3): a sed w/W/s///w that writes /etc/passwd is a literal protected write (deny); the others stay doubts
    if (/[wW] \/etc\/passwd/.test(cmd)) denied(cmd);
    else expect(reason(cmd)).toBe("tokenizer");
  });
  // MARKS r9 C2: probe awk 'BEGIN { print 1 }' (cwd /w) -> null (a readable awk print runs by design, FIX-LEDGER :4041)
  it.each(["awk 'BEGIN { print 1 }'"])("M-R1-program %s", cmd => expect(alwaysAskCommand(cmd, "/w")).toBeNull());
  // MARKS r9 C2: probe cp blob ~/x (cwd /w) -> null (a plain file directly in home runs); the dangerous twins keep value-path
  it.each(["../etc/passwd", "./../etc/passwd", "~/x"])("M-R1-path cp %s", target => {
    // FIX A migration (N3): ../etc/passwd from /w is a protected path (deny); ~/x stays ordinary
    if (target === "~/x") expect(reason(`cp blob ${target}`)).toBeUndefined();
    else denied(`cp blob ${target}`);
  });
  // MARKS r9 C2 (twin): probe cp blob ~/x (no cwd) -> {rule:unreadable,doubt:value-path}; ~/.ssh/x and ~/.bashrc still card with a cwd
  it("M-R1-path cp ~/x (no cwd)", () => expect(alwaysAskCommand("cp blob ~/x")?.doubt).toBe("value-path"));
  it.each(["mv blob", "tee", "install blob", "ln blob", "touch", "echo x >"])("M-R1-path %s", cmd => denied(`${cmd} ../etc/passwd`)); // FIX A migration (N3): was doubt value-path
  it("M-R1-cwd unknown relative write", () => expect(alwaysAskCommand("touch out")?.doubt).toBe("value-path"));
  // MARKS r9 C2: probe touch /w/* (cwd /w) -> null (a glob inside the known project folder runs)
  it("M-R1-uncertain glob write", () => expect(alwaysAskCommand("touch /w/*", "/w")).toBeNull());
  it("M-R1-stdin sed stdin is not a named file", () => expect(alwaysAskCommand("sed -f - notes", "/w", "command", undefined, undefined, undefined,
    { sessionFile: () => ({ text: "1p" }) })?.doubt).toBe("tokenizer"));
  it.each([
    ['ruby', 'puts "#{1}"'], ['perl', 'print "${x}"'], ['perl', 'print "@{x}"'],
    ['python3', 'print(f"{1}")'], ['python3', 'print("{0.__class__}".format(1))'],
    ['node', 'console.log(`${1}`)'], ['bash', 'echo `echo x`'], ['bash', 'echo $(echo x)'], ['bash', 'echo ${HOME}'],
  ])("M-R1-interpolation %s %s", (name, body) => {
    // MARKS r9 C2: probe bash -c 'echo ${HOME}' (cwd /w and no cwd) -> null (readable, run by design; a home variable is no longer a doubt); bash -c 'echo $(echo x)' and the backtick form -> null (readable, run by design)
    const want = (body === "echo $(echo x)" || body === "echo `echo x`" || body === "echo ${HOME}") ? undefined : "tokenizer";
    // M-R10: inline code is read by the family scan (and by the shell reader for bash) at every level, no doubt
    expect(reason(`${name} ${name === "bash" || name === "python3" ? "-c" : "-e"} '${body}'`)).toBe(name === "python3" ? undefined : want);
    expect(alwaysAskCommand(`${name} /w/F`, "/w", "command", undefined, undefined, undefined,
      { sessionEdits: new Set(["/w/F"]), sessionFile: () => ({ text: body }) })?.doubt).toBe(want);
  });
  it("M-PR-1a previous-character dot guard", () => {
    expect(deviceInWord("/./dev/sda")).toBe("/dev/sda");
    expect(alwaysAskCommand("echo target=/./dev/sda", "/w")?.rule).toBe("disk-erase");
  });
  // FIX A migration (N5): the literal climbs into /dev; inline code naming a protected path is the typed deny (was doubt value-path)
  it("M-PR-1b canonical literal target", () => denied(`python3 -c 'open("/tmp/../dev/sda","w").write("x")'`));
  it("M-PR-1c unknown call is incomplete", () => expect(alwaysAskCommand("python3 /w/F", "/w", "command", undefined, undefined, undefined,
    { sessionEdits: new Set(["/w/F"]), sessionFile: () => ({ text: 'mystery()' }) })?.doubt).toBe("tokenizer"));
  it("M-PR-2 sed program file", () => expect(reason("sed -f /w/F notes.txt")).toBe("tokenizer"));
  it("M-PR-3a raw-only proc climb", () => {
    expect(procTraversal("/tmp/../proc/../w/out")).toBe(true);
    expect(procCanonical("/w/out")).toBe(false);
    denied("cp blob /tmp/../proc/../w/out"); // FIX A migration (N3): was doubt value-path
  });
  it("M-PR-3b canonical-only proc", () => {
    expect(procTraversal("/proc/self/fd/1")).toBe(false);
    expect(procCanonical("/proc/self/fd/1")).toBe(true);
    denied("cp blob /proc/self/fd/1"); // FIX A migration (N3): was doubt value-path
  });
  // MARKS r9 C2: probe dd if=blob of=/tmp/../dev/sda -> {rule:disk-erase} at /w and no cwd; still cards, now named as the catastrophe
  it("M-PR-4 output value is canonicalized", () => expect(alwaysAskCommand("dd if=blob of=/tmp/../dev/sda", "/w")?.rule).toBe("disk-erase"));
  it("read-position proc stays ordinary", () => expect(canonPath("/proc/self/status", newContext("/w"), "read").value).toBe(false));
  it("M-PR-5a unavailable session execution", () => expect(alwaysAskCommand("bash /w/F.sh", "/w", "command", undefined, undefined, undefined,
    { sessionEdits: new Set(["/w/F.sh"]), sessionFile: () => "unavailable" })?.doubt).toBe("unavailable-exec"));
  it("M-PR-5b provenance never grants an exemption", () => {
    forgetOutsideState();
    expect(wireOutsideStore({ openTurn() {}, seal() {}, load: () => ({ opens: [], marks: [], sessions: [], markedTurns: [], outsideSince: 1 }), loadRegistry: () => [], writeRegistry() {}, setMark() {}, clearMark() {}, setSession() {}, addMarkedTurn() {}, setOutsideSince() {} })).toBe(true);
    beginOutsideTurn("t", "i", "turn", false);
    markCallOutside("t", "interpreter", { callKey: "k", lateFrame: true });
    expect(turnOutsideExempt("t", "k")).toBe(false);
    expect(turnOutsideMark("t")?.provenance).toEqual({ callKey: "k", late: true });
    forgetOutsideState();
  });
  it("M-PR-6a compiler only", () => {
    expect(compilerResponse("gcc", ["@/w/L"])).toBe(true);
    expect(genericResponse("gcc", ["@/w/L"], false)).toBe(false);
  });
  it("M-PR-6b generic only", () => {
    expect(compilerResponse("git", ["@/w/L"])).toBe(false);
    expect(genericResponse("git", ["@/w/L"], false)).toBe(true);
  });
  it("M-PR-6c xargs list", () => expect(reason("xargs -a /w/L echo")).toBe("file-fed-args"));
  it("M-PR-6d archive list", () => expect(reason("tar -cf out.tar -T /w/L")).toBe("file-fed-args"));
  it("M-PR-7 scan gate", () => expect(reason(`printf %s ${"a".repeat(131_073 - "printf %s ".length)}`)).toBe("scan-gate"));
});

describe("MARKS r7: catastrophe first, and readable commands run (MurageMain ruling on FIX-LEDGER :4041)", () => {
  const rule = (cmd: string) => alwaysAskCommand(cmd, "/w")?.rule;
  it.each([
    ["/bin/rm -rf /", "delete-root"], ["mkfs.ext4 /dev/sda1", "disk-erase"], ["rm -rf / $X", "delete-root"],
  ])("M-FIX4-order %s keeps its catastrophe name", (cmd, name) => expect(rule(cmd)).toBe(name));
  it("M-FIX4-pathname a path-spelled program keeps the catastrophe in its operands", () => expect(rule("/opt/x/tool; rm -rf /")).toBe("delete-root"));
  it("M-FIX4-rethrow a value target still holds", () => expect(reason("rm -rf $X")).toBe("value-path"));
  it("M-FIX4-command an unseen path-spelled program holds", () => expect(reason("/opt/x/tool a")).toBe("command"));
  it.each([
    ["DEV=/dev/sda; cat x > $DEV", "disk-erase"], ["X=$(date); mkfs.ext4 /dev/sdb", "disk-erase"],
    ["rm -rf $X; rm -rf ~", "delete-home"],
  ])("M-FIX4-first %s: a doubt never hides a named catastrophe", (cmd, name) => expect(rule(cmd)).toBe(name));
  it.each([
    "awk '{print $1}' data.txt", "tee out.txt < in.txt", "git commit -m 'fix: x'", "find . -name '*.log'",
    "jq . data.json", "a", "rm -rf build", "sed -n 's/a/b/p' notes.txt", "X=1 ls", "chmod +x ./tool.sh",
    "tar -czf out.tgz src", "gcc -o app main.c", "cp a.txt /w/sub/b.txt", "cat /dev/sda > /w/disk.img",
  ])("M-R7-ordinary %s runs without a card", cmd => expect(alwaysAskCommand(cmd, "/w")).toBeNull());
  it.each(["tar -C /w/../etc/../w/x -xf blob", "unzip -d /tmp/../sys/../w/x blob",
    "zip /x/../dev/../w/y blob"])("M-R7-climb %s still holds", cmd => denied(cmd)); // FIX A migration (N3): was doubt value-path
  // MARKS r9 C2: probe made-up --out=/tmp/../proc/../w/o (cwd /w) -> {rule:protected-path}; still cards, named by rule
  it.each(["made-up --out=/tmp/../proc/../w/o"])("M-R7-climb %s still holds", cmd => expect(["protected-path", "unreadable"]).toContain(alwaysAskCommand(cmd, "/w")?.rule));
  it.each(["G=/usr/bin/git; $G status", "/bin/ls -la", "/Applications/Tailscale.app/Contents/MacOS/Tailscale status"])(
    "M-R7-sysbin %s runs as its name", cmd => expect(alwaysAskCommand(cmd, "/w")).toBeNull());
  it("M-R7-sysbin-deny a system program keeps its catastrophe", () => expect(rule("/bin/rm -rf /")).toBe("delete-root"));
  it.each(["sed -i s/a/b/ notes.txt"])("M-R7-sed-inplace %s still holds", cmd => expect(reason(cmd)).toBe("tokenizer"));
  it.each(["sed 's/a/b/w /w/out' notes.txt", "sed -n '1e date' notes.txt", "sed -n 'r /w/x' notes.txt"])(
    "M-R7-sed %s still holds", cmd => expect(reason(cmd)).toBe("tokenizer"));
  it.each(["awk 'BEGIN{system(\"date\")}'", "awk '{print > \"/w/out\"}' data.txt", "awk '{\"date\" | getline d}'"])(
    "M-R7-awk %s still holds", cmd => expect(reason(cmd)).toBe("tokenizer"));
  it.each(["GIT_SSH_COMMAND=x git fetch", "LD_PRELOAD=/w/x.so ls", "BASH_ENV=/w/x bash -c true"])(
    "M-R7-env %s still holds", cmd => expect(reason(cmd)).toBe("tokenizer"));
});

// MARKS r12: the r11 mutation run (scripts/check-marks-mutations.py) left 16 labels standing: their rows named the
// label but no row failed with the line removed (other layers caught the same text, or the row named a sibling label).
// One row per label that fails with exactly that line removed; each row was found by diffing the reader's answers with
// and without the line (strict, doubt-free, and the verdict at Auto, Full access and No limits for the owner, another
// origin, a routine and a marked lane).
describe("MARKS r12 mutation witnesses", () => {
  const visitor = { command: () => null, redirect: () => null, forkBomb: () => "fork", catastrophic: () => true };
  const walks = (cmd: string) => () => walkScript(cmd, newContext("/w"), visitor as never);
  const STUB = { realpath: (path: string) => path, stat: () => ({ isFile: () => true, isDirectory: () => false }) };
  const NO_LIMITS = { id: "r12", autoApprove: true, fullAccess: true, noLimits: true };
  const turn = (cmd: string, cwd: string | undefined, patch: Partial<AutoContext> = {}) => ({
    fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, commandText: cmd, commandCwd: cwd, workFolder: "/w",
    readOnlyHooks: { cwd, sessionEdits: new Set<string>() }, unseen: { fs: STUB, platform: "posix" }, sessionFile: () => "unavailable", ...patch,
  }) as unknown as AutoContext;
  const verdict = (cmd: string, cwd: string | undefined, patch: Partial<AutoContext> = {}) => autoVerdict(NO_LIMITS as never, "Bash", cmd, turn(cmd, cwd, patch));
  it("M-FIX3-target cp into a system folder doubts in the walk", () => expect(walks("cp blob /etc/x")).toThrow("value-path"));
  it("M-X1-exec tar -I runs a program", () => expect(reason("tar -I zstd -xf a.tar")).toBe("tokenizer"));
  it("M-X1-climb touch ../etc/passwd doubts in the walk", () => expect(walks("touch ../etc/passwd")).toThrow("value-path"));
  it("M-R7-climb tar -C through a system folder doubts in the walk", () => expect(walks("tar -C /w/../etc/../w/x -xf blob")).toThrow("value-path"));
  it("M-R7-level a routine No limits run keeps the strict read (touch out, no fixed folder)", () =>
    expect(verdict("touch out", undefined, { automated: true, routineLevel: true, workFolder: undefined } as Partial<AutoContext>)).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" }));
  it("M-R10-relief the owner's No limits turn takes the doubt-free read (dd of=./disk.img, no fixed folder)", () =>
    expect(verdict("dd if=/dev/zero of=./disk.img bs=1M count=1", undefined)).toMatchObject({ source: "no-limits" }));
  it("M-R10-owner a turn another origin started keeps the strict read", () =>
    expect(verdict("dd if=/dev/zero of=./disk.img bs=1M count=1", undefined, { fullAccessOrigin: "other", workFolder: undefined } as Partial<AutoContext>)).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" }));
  it("M-R10-dd dd reads a system folder through if= and writes in the project", () => {
    expect(alwaysAskCommand("dd if=/etc of=./x", "/w")).toBeNull();
    expect(alwaysAskCommand("dd if=/home/tester of=./x", "/w")).toBeNull();
  });
  it("M-R10-inline inline code the family scan reads is no doubt", () => expect(alwaysAskCommand(`python3 -c 'import os; os.system("ls")'`, "/w")).toBeNull());
  it("M-R11-unseen-lane an unseen script on a marked lane keeps the reader's card", () =>
    expect(verdict("bash ./build.sh", "/w", { outsideRead: ["interpreter"] } as Partial<AutoContext>)).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" }));
  it("M-R1-program awk system() runs a program", () => expect(reason(`awk 'BEGIN{system("ls")}'`)).toBe("tokenizer"));
  it("M-R1-path touch out with no fixed folder doubts", () => expect(alwaysAskCommand("touch out")?.doubt).toBe("value-path"));
  it("M-R1-fold a drive root in capitals is a drive root", () => denied("touch C:/")); // FIX A migration (N3): was doubt value-path
  it("M-R1-target an attached -t names the target folder", () => {
    expect(outputOption(["-t/etc", "blob"], 0, "cp")).toEqual({ file: "/etc", last: 0 });
    expect(outputOption(["--target-directory=/etc", "blob"], 0, "mv")).toEqual({ file: "/etc", last: 0 });
  });
  it("M-R1-uncertain a value in rm's operands is the value-path doubt", () => expect(alwaysAskUnreadableReason('rm -rf "$X"', "/w")).toBe("opaque: Doubt(value-path)"));
  it("M-PR-4 dd of= into a system folder doubts", () => denied("dd if=a of=/etc/x")); // FIX A migration (N3): was doubt value-path
});

// MARKS R1 (MurageMain 11-08): the migrated rows above read under ownerMarks (the owner's clean No limits turn). Every other level and origin
// reads as NLH0 (1320a3e29), so the same texts, read without ownerMarks, must give the answer NLH0 gave (marks-nlh0-verdicts.json).
describe("MARKS R1: the same texts outside the owner's No limits turn read as NLH0", () => {
  it.each([
    "cp blob /tmp/../proc/../w/out", "cp blob /proc/self/fd/1", "install blob /tmp/../var/spool/cron/../../../w/z", "ln blob /tmp/../proc/../w/out",
    "mv blob /x/../dev/../w/y", "printf x > /tmp/../sys/../w/x", "tee /w/../etc/../w/x", "touch /tmp/../sys/../w/x",
    "rsync blob /tmp/../proc/../w/out", "tar -C /w/../etc/../w/x -xf blob", "unzip -d /tmp/../sys/../w/x blob", "zip /x/../dev/../w/y blob",
    "sed -e 'w /etc/passwd' notes", "sed --expression 'w /etc/passwd' notes", "sed -n -e 1p -e 'w /etc/passwd' notes",
    "cp ../etc/passwd x", "cp blob ../etc/passwd", "touch ../etc/passwd", "dd if=a of=/etc/x", "touch C:/",
    `python3 -c 'open("/tmp/../dev/sda","w").write("x")'`, `printf %s ${"a".repeat(4097)} > /etc/x`,
  ])("%s", cmd => nlh0(`nlmi-guards|${cmd.length > 200 ? cmd.slice(0, 200) : cmd}`, alwaysAskCommand(cmd, "/w")));
});
