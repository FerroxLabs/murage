// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { candidatesOf, canonPath, deviceInWord, newContext, procCanonical, procTraversal, walkScript, writtenKey } from "./shell/walk.ts";
import { compilerResponse, genericResponse, checkSed, interpolated, checkCommandOptions, checkEnvironment } from "./shell/marks.ts";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markCallOutside } from "./outside-wire.ts";
import { alwaysAskCommand, protectedClass, unreadableHit } from "./always-ask.ts";
import { marksHitWaivable } from "./auto-approve.ts";
import { outsideScanMarks } from "./outside-scan.ts";
import { beginOutsideTurn, forgetOutsideState, turnOutsideExempt, turnOutsideMark, wireOutsideStore } from "./email/external-marks.ts";

const reason = (cmd: string) => alwaysAskCommand(cmd, "/w")?.doubt;
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
    expect(reason(cmd)).toBe("tokenizer");
  });
  it.each([
    "cp blob /tmp/../proc/../w/out", "mv blob /x/../dev/../w/y",
    "tee /w/../etc/../w/x", "touch /tmp/../sys/../w/x",
    "install blob /tmp/../var/spool/cron/../../../w/z",
    "ln blob /tmp/../proc/../w/out", "dd if=blob of=/w/../etc/../w/x",
    "printf x > /tmp/../sys/../w/x",
  ])("M-FIX3-raw %s", cmd => expect(reason(cmd)).toBe("value-path"));
  it.each(["/etc/" + "./".repeat(3000) + "passwd", "/w/" + "../".repeat(2000) + "etc/passwd",
    "/w/" + "a".repeat(5000)])("M-FIX3-overlong %s", path => expect(reason(`cp blob ${path}`)).toBe("value-path"));
  it.each([4097, 131072 - 10])("M-FIX3-data printf %i", size => expect(reason(`printf %s ${"a".repeat(size)}`)).toBeUndefined());
  it("M-FIX3-data echo 70000", () => expect(reason(`echo ${"a".repeat(70000)}`)).toBeUndefined());
  it("M-FIX3-data protected redirect", () => expect(reason(`printf %s ${"a".repeat(4097)} > /etc/x`)).toBe("value-path"));
  it.each(["/w/../etc/../w/x", "/x/../dev/../w/y", "/tmp/../sys/../w/x"])("M-FIX3-climb %s", path => {
    expect(canonPath(path, newContext("/w"), "write").value).toBe(true);
  });
});
describe("MARKS independent guard witnesses", () => {
  it.each(["/usr/bin/env echo x", "command /usr/bin/env echo x", "/bin/command echo x"])("M-FIX2-wrapper-path %s", cmd => expect(reason(cmd)).toBe("command"));
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
      expect(alwaysAskCommand(`cp ./blob ${root}/escape/pwn`, root)?.doubt).toBe("value-path");
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
    "sed -sne 1p notes", "sed -i.bak 1p notes", "sed -ni 1p notes", "sed --unknown 1p notes",
    "awk -fF notes", "gawk --file=F notes", "perl -e'mystery()'", "perl -we'print 1'",
  ])("FIX2 G3 existing parser sibling %s", cmd => expect(reason(cmd)).toBe("tokenizer"));
  // These rows need the outside-scan.ts patch recorded in ALLOW-LIST.md.
  it.each(["ler\\\nna run build", "n\\\nx build", "tur\\\r\nbo run build"])("M-FIX2-runner needs item 6 patch %s", cmd => {
    expect(outsideScanMarks(cmd)).toContain("interpreter");
  });
  it("M-R1-sed every expression", () => expect(() => checkSed(["-e", "1p", "-e", "w /etc/passwd"], () => undefined)).toThrow());
  it("M-R1-option unknown option", () => expect(() => checkSed(["-i", "1p", "notes"], () => undefined)).toThrow());
  it.each(["cp -t../etc blob", "cp -at../etc blob", "cp -at ../etc blob", "mv --target-directory=../etc blob", "install -t../etc blob", "ln -t../etc blob"])("M-R1-target %s", cmd => expect(reason(cmd)).toBe("value-path"));
  it("M-R1-literal plain strings exclude interpolation", () => expect(interpolated('puts "#{1}"')).toBe(true));
  it("M-R1-interpreter-option ruby in-place", () => expect(reason(`ruby -e 'puts 1' -i notes`)).toBe("tokenizer"));
  it("M-R1-unknown-option python option", () => expect(reason(`python3 -Z -c 'print(1)'`)).toBe("tokenizer"));
  it("M-R1-format field lookup", () => expect(reason(`python3 -c 'print("{0.__class__}".format(1))'`)).toBe("tokenizer"));
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
    "awk 'BEGIN { print 1 }'", "perl -pi -e 'print 1' notes",
  ])("M-R1-program %s", cmd => expect(reason(cmd)).toBe("tokenizer"));
  it.each(["../etc/passwd", "./../etc/passwd", "~/x"])("M-R1-path cp %s", target => expect(reason(`cp blob ${target}`)).toBe("value-path"));
  it.each(["mv blob", "tee", "install blob", "ln blob", "touch", "echo x >"])("M-R1-path %s", cmd => expect(reason(`${cmd} ../etc/passwd`)).toBe("value-path"));
  it("M-R1-cwd unknown relative write", () => expect(alwaysAskCommand("touch out")?.doubt).toBe("value-path"));
  it("M-R1-uncertain glob write", () => expect(reason("touch /w/*")).toBe("value-path"));
  it("M-R1-stdin sed stdin is not a named file", () => expect(alwaysAskCommand("sed -f - notes", "/w", "command", undefined, undefined, undefined,
    { sessionFile: () => ({ text: "1p" }) })?.doubt).toBe("tokenizer"));
  it.each([
    ['ruby', 'puts "#{1}"'], ['perl', 'print "${x}"'], ['perl', 'print "@{x}"'],
    ['python3', 'print(f"{1}")'], ['python3', 'print("{0.__class__}".format(1))'],
    ['node', 'console.log(`${1}`)'], ['bash', 'echo `echo x`'], ['bash', 'echo $(echo x)'], ['bash', 'echo ${HOME}'],
  ])("M-R1-interpolation %s %s", (name, body) => {
    expect(reason(`${name} ${name === "bash" || name === "python3" ? "-c" : "-e"} '${body}'`)).toBe("tokenizer");
    expect(alwaysAskCommand(`${name} /w/F`, "/w", "command", undefined, undefined, undefined,
      { sessionEdits: new Set(["/w/F"]), sessionFile: () => ({ text: body }) })?.doubt).toBe("tokenizer");
  });
  it("M-PR-1a previous-character dot guard", () => {
    expect(deviceInWord("/./dev/sda")).toBe("/dev/sda");
    expect(alwaysAskCommand("echo target=/./dev/sda", "/w")?.rule).toBe("disk-erase");
  });
  it("M-PR-1b canonical literal target", () => expect(reason(`python3 -c 'open("/tmp/../dev/sda","w").write("x")'`)).toBe("value-path"));
  it("M-PR-1c unknown call is incomplete", () => expect(reason(`python3 -c 'mystery()'`)).toBe("tokenizer"));
  it("M-PR-2 sed program file", () => expect(reason("sed -f /w/F notes.txt")).toBe("tokenizer"));
  it("M-PR-3a raw-only proc climb", () => {
    expect(procTraversal("/tmp/../proc/../w/out")).toBe(true);
    expect(procCanonical("/w/out")).toBe(false);
    expect(reason("cp blob /tmp/../proc/../w/out")).toBe("value-path");
  });
  it("M-PR-3b canonical-only proc", () => {
    expect(procTraversal("/proc/self/fd/1")).toBe(false);
    expect(procCanonical("/proc/self/fd/1")).toBe(true);
    expect(reason("cp blob /proc/self/fd/1")).toBe("value-path");
  });
  it("M-PR-4 output value is canonicalized", () => expect(reason("dd if=blob of=/tmp/../dev/sda")).toBe("value-path"));
  it("read-position proc stays ordinary", () => expect(canonPath("/proc/self/status", newContext("/w"), "read").value).toBe(false));
  it("M-PR-5a unavailable session execution", () => expect(alwaysAskCommand("bash /w/F.sh", "/w", "command", undefined, undefined, undefined,
    { sessionEdits: new Set(["/w/F.sh"]), sessionFile: () => "unavailable" })?.doubt).toBe("unavailable-exec"));
  it("M-PR-5b provenance never grants an exemption", () => {
    forgetOutsideState();
    expect(wireOutsideStore({ load: () => ({ marks: [], sessions: [], markedTurns: [], outsideSince: 1 }), loadRegistry: () => [], writeRegistry() {}, setMark() {}, clearMark() {}, setSession() {}, addMarkedTurn() {}, setOutsideSince() {} })).toBe(true);
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
