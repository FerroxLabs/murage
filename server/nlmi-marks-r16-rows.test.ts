// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NLMI-MARKS r1.6 (designs NLMI-MARKS-1018-r16.md, sha256 1ed7c809...): the concrete bypass rows of Grok job 67
// (_reviews/MARKS-R15-FR-grok-r15.md) and Astra r15 (_reviews/D-NLMI-MARKS-astra-r15.md), each through the whole
// auto-approve verdict on a clean, complete, unscoped owner No limits call (Full access where the review names it).
// Every bypass row ran without a card at af54fa411 / 51bec1dfe (red before). A "session file" is a path an engine file
// tool wrote earlier in this engine session; its bytes reach the verdict through the `sessionFile` hook (r1.4 R-EXEC-3).
// Fixture strings are inert data, never executed.
import { describe, expect, it } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
const { autoVerdict } = await import("./auto-approve.ts");

type Context = Parameters<typeof autoVerdict>[3];
const NO_LIMITS = { id: "owned", autoApprove: true, fullAccess: true, noLimits: true };
const FULL = { id: "owned", autoApprove: true, fullAccess: true };
const CLEAN_OWNER = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null } as const;
const STUB = { realpath: (path: string) => path, stat: () => ({ isFile: () => true, isDirectory: () => false }) };
const DISK = "/dev/sda";

/** Session files by absolute path: `{ text }` or "unavailable" (over 128 KiB, missing, non-regular, read error). */
type Files = Record<string, string | "unavailable">;
function call(bot: object, cmd: string, cwd = "/w", files: Files = {}): ReturnType<typeof autoVerdict> {
  const edits = new Set(Object.keys(files));
  const context = {
    ...CLEAN_OWNER,
    commandText: cmd,
    commandCwd: cwd,
    workFolder: "/w",
    readOnlyHooks: { cwd, sessionEdits: edits },
    unseen: { fs: STUB, platform: "posix" },
    sessionFile: (path: string) => (path in files ? (files[path] === "unavailable" ? "unavailable" : { text: files[path]! }) : "unavailable"),
  } as unknown as Context;
  return autoVerdict(bot as never, "Bash", cmd, context);
}
const cards = (bot: object, cmd: string, cwd?: string, files?: Files) => expect(call(bot, cmd, cwd, files).approve, cmd).toBeNull();
const runs = (bot: object, cmd: string, cwd?: string, files?: Files) => expect(call(bot, cmd, cwd, files).approve, cmd).toBeTruthy();

describe("Grok 67 High 1 / PR-1: a dotted or climbing device literal in an interpreter body", () => {
  const bodies = [`open("/./dev/sda","wb").write(b"x")`, `open("/tmp/../dev/sda","wb").write(b"x")`];
  it.each(bodies)("-c form: python3 -c '%s'", (body) => cards(NO_LIMITS, `python3 -c '${body}'`));
  it.each(bodies)("file form: python3 /w/a.py holding %s", (body) => cards(NO_LIMITS, "python3 /w/a.py", "/w", { "/w/a.py": body }));
  it.each(bodies)("node -e form of %s", (body) => cards(NO_LIMITS, `node -e 'require("fs").writeFileSync(${JSON.stringify(body.slice(6, body.indexOf('"', 6)))}, "x")'`));
});

describe("Astra r15 High 1 / PR-1: a standard-library body with no run, delete or write family word", () => {
  const body = "import array, io\narray.array('B', [120]).tofile(io.FileIO('/dev/sda', 'w'))\n";
  it("file form: python3 /w/F.py", () => cards(NO_LIMITS, "python3 /w/F.py", "/w", { "/w/F.py": body }));
  it("-c form", () => cards(NO_LIMITS, `python3 -c "import array, io; array.array('B', [120]).tofile(io.FileIO('/dev/sda', 'w'))"`));
});

describe("Grok 67 High 2 / PR-2: sed -f with a write command in the script file", () => {
  const files = { "/w/F": `w ${DISK}\n` };
  it.each([
    "sed -f /w/F notes.txt",
    "sed notes.txt -f /w/F",
    "sed --file=/w/F notes.txt",
    "sed --file /w/F notes.txt",
    "sed -f - notes.txt < /w/F",
    "cat /w/F | sed -f - notes.txt",
  ])("%s", (cmd) => cards(NO_LIMITS, cmd, "/w", files));
  it("the same script inline", () => cards(NO_LIMITS, `sed -e 'w ${DISK}' notes.txt`));
});

describe("Grok 67 High 3 / PR-3: /proc entered through a climb, then out through cwd to a device", () => {
  const targets = [
    "/tmp/../proc/self/cwd/../dev/sda",
    "/var/tmp/../../proc/self/cwd/../dev/sda",
    "/tmp/../proc/thread-self/cwd/../dev/sda",
    "/tmp/../proc/1/cwd/../dev/sda",
    "/tmp/../proc/self/root/dev/sda",
  ];
  it.each(targets)("copy target %s", (t) => cards(NO_LIMITS, `cp blob ${t}`, "/tmp"));
  it.each(targets)("redirect target %s", (t) => cards(NO_LIMITS, `echo x > ${t}`, "/tmp"));
  it.each(targets)("output-option tail of=%s", (t) => cards(NO_LIMITS, `dd if=blob of=${t}`, "/tmp"));
});

describe("Grok 67 High 4 / PR-4: an output-option tail that folds to a device", () => {
  it.each([
    "dd of=/./dev/sda",
    "dd of=/tmp/../dev/sda",
    "dd if=blob of=/./dev/sda bs=1M",
    "sort -o /./dev/sda notes.txt",
    "sort --output=/tmp/../dev/sda notes.txt",
    "sort -o/./dev/sda notes.txt",
  ])("%s", (cmd) => cards(NO_LIMITS, cmd));
});

describe("Astra r15 High 2 / PR-5: unavailable session execution cards on Full access too", () => {
  const files: Files = { "/w/F.sh": "unavailable" };
  it.each(["bash /w/F.sh", "sh /w/F.sh", "/w/F.sh", "source /w/F.sh"])("Full access: %s", (cmd) => cards(FULL, cmd, "/w", files));
  it.each(["bash /w/F.sh", "/w/F.sh"])("No limits: %s", (cmd) => cards(NO_LIMITS, cmd, "/w", files));
  it("Full access: an unavailable session-written Python file", () => cards(FULL, "python3 /w/F.py", "/w", { "/w/F.py": "unavailable" }));
});

describe("Astra r15 High 3 / PR-6: file-fed argument lists", () => {
  const files = { "/w/L": `-S /w/a.c -o ${DISK}\n`, "/w/a.c": "int main(void){return 0;}\n", "/w/D": `${DISK}\n` };
  it.each([
    "gcc @/w/L",
    "cc @/w/L",
    "clang @/w/L",
    "xargs -a /w/D cp blob",
    "xargs --arg-file=/w/D cp blob",
    "xargs --arg-file /w/D cp blob",
    "tar -cf out.tar -T /w/D",
    "tar --files-from=/w/D -cf out.tar",
    "rsync -a --files-from=/w/D / /w/out",
  ])("%s", (cmd) => cards(NO_LIMITS, cmd, "/w", files));
});

describe("Astra r15 Medium 4 / PR-7: one command over the 128 KiB scan gate", () => {
  it("131,073 characters cards on No limits and Full access", () => {
    const cmd = `printf %s ${"a".repeat(131_073 - "printf %s ".length)}`;
    expect(cmd.length).toBe(131_073);
    cards(NO_LIMITS, cmd);
    cards(FULL, cmd);
  });
});

describe("GrokBuild 68 High 1: a less `+` operand is a command less runs", () => {
  const files = { "/w/wipe.sh": `dd if=/dev/zero of=${DISK}\n` };
  it("session script form", () => cards(NO_LIMITS, "less +'!sh ./wipe.sh' README", "/w", files));
  it("pre-existing script form", () => cards(NO_LIMITS, "less +'!sh ./wipe.sh' README"));
  it("climbing device form", () => cards(NO_LIMITS, "less +'!dd if=/dev/zero of=/tmp/../dev/sda bs=4k' README"));
});

describe("GrokBuild 68 High 2: an option whose operand is a program the tool runs", () => {
  const files = { "/w/wipe.sh": `dd if=/dev/zero of=${DISK}\n` };
  it.each([
    "sort --compress-program=./wipe.sh -S 1 data.txt",
    "sort --compress-program ./wipe.sh -S 1 data.txt",
  ])("%s (session script)", (cmd) => cards(NO_LIMITS, cmd, "/w", files));
  it("pre-existing script", () => cards(NO_LIMITS, "sort --compress-program=./wipe.sh -S 1 data.txt"));
  // Astra r16 (a): option values a program executes, the same family
  it.each([
    "tar --use-compress-program=./wipe.sh -cf out.tar src",
    "tar -I ./wipe.sh -cf out.tar src",
    "rsync -e ./wipe.sh -a src/ host:dst/",
    "git -c core.pager=./wipe.sh log",
  ])("%s", (cmd) => cards(NO_LIMITS, cmd, "/w", files));
});

describe("Astra r16 (b): a non-literal write target in interpreter code", () => {
  it.each([
    `python3 -c 'import sys; open(sys.argv[1],"wb").write(b"x")' /tmp/../dev/sda`,
    `python3 -c 'import os; open(os.environ["T"],"wb").write(b"x")'`,
    `node -e 'require("fs").writeFileSync(process.argv[1], "x")' /tmp/../dev/sda`,
  ])("%s", (cmd) => cards(NO_LIMITS, cmd));
});

describe("GrokBuild 68 High 3: a device path assembled in interpreter code", () => {
  const python = [
    `open("/dev/"+"sda","wb").write(b"\\0")`,
    `import os; open(os.path.join("/dev","sda"),"wb").write(b"\\0")`,
    `open("/dev/{}".format("sda"),"wb").write(b"\\0")`,
    `d="sda"; open(f"/dev/{d}","wb").write(b"\\0")`,
    `open("/dev/%s" % "sda","wb").write(b"\\0")`,
  ];
  it.each(python)("python3 -c '%s'", (body) => cards(NO_LIMITS, `python3 -c '${body}'`));
  it.each(python)("file form: python3 /w/g.py holding %s", (body) => cards(NO_LIMITS, "python3 /w/g.py", "/w", { "/w/g.py": body }));
  const node = [
    `require("fs").writeFileSync("/dev/"+"sda", Buffer.alloc(1))`,
    `require("fs").writeFileSync(require("path").join("/dev","sda"), Buffer.alloc(1))`,
    "require(\"fs\").writeFileSync(`/dev/${\"sda\"}`, Buffer.alloc(1))",
  ];
  it.each(node)("node -e '%s'", (body) => cards(NO_LIMITS, `node -e '${body}'`));
  it.each(node)("file form: node /w/g.js holding %s", (body) => cards(NO_LIMITS, "node /w/g.js", "/w", { "/w/g.js": body }));
});

describe("Astra r16 recheck OPEN 1: an unclassified call in a lexically clean interpreter body", () => {
  const body = 'import ctypes\nctypes.CDLL(None).syscall(87, b"/etc/passwd")\n';
  it("-c form", () => cards(NO_LIMITS, `python3 -c 'import ctypes; ctypes.CDLL(None).syscall(87, b"/etc/passwd")'`));
  it("file form", () => cards(NO_LIMITS, "python3 /w/c.py", "/w", { "/w/c.py": body }));
});

describe("Astra r16 recheck OPEN 2: a response file forwarded inside a compiler option", () => {
  const files = { "/w/L": `-Map ${DISK}\n`, "/w/a.c": "int main(void){return 0;}\n" };
  it.each(["gcc /w/a.c -Wl,@/w/L", "gcc /w/a.c -Xlinker @/w/L", "cc -Wl,@/w/L /w/a.c"])("%s", (cmd) => cards(NO_LIMITS, cmd, "/w", files));
});

describe("controls that run today and must keep running", () => {
  it.each([
    "cat /proc/self/status",
    "dd if=blob of=out.bin",
    "sort -o out.txt notes.txt",
    "sed -n 1,5p notes.txt",
    `python3 -c 'print("{}".format(1))'`,
    `python3 -c 'open("/w/out.txt","w").write("x")'`,
  ])("%s", (cmd) => runs(NO_LIMITS, cmd));
  it("131,072 characters still runs", () => {
    const cmd = `printf %s ${"a".repeat(131_072 - "printf %s ".length)}`;
    runs(NO_LIMITS, cmd);
  });
});

// Added r16 review witnesses; the original acceptance rows above are unchanged.
describe("strict same-text files and closed-grammar costs", () => {
  it.each(["/./dev/sda", "/tmp/../dev/sda"])("heredoc-written Python target %s", (target) =>
    cards(NO_LIMITS, `cat > /w/a.py << 'PY'\nopen("${target}","wb").write(b"x")\nPY\npython3 /w/a.py`));
  it.each([`osascript -e 'return 1'`, `rscript -e 'print(1)'`, `tclsh <<< 'puts hello'`])("closed grammar cost: %s", cmd => cards(NO_LIMITS, cmd));
  it("dd project-to-project remains admitted", () => runs(NO_LIMITS, "dd if=proj of=proj"));
  it("safe same-text Python output", () => runs(NO_LIMITS, `cat > /w/a.py << 'PY'\nopen("/w/out.txt","w").write("x")\nPY\npython3 /w/a.py`));
  it("safe session Python output", () => runs(NO_LIMITS, "python3 /w/a.py", "/w", { "/w/a.py": 'open("/w/out.txt","w").write("x")' }));
  it("M-PR-3a: raw proc climb leaves proc before the second belt", () => cards(NO_LIMITS, "cp blob /tmp/../proc/../w/out"));
  it("M-PR-3b: canonical proc path without a raw climb", () => cards(NO_LIMITS, "cp blob /proc/self/fd/1"));
  it("M-PR-6a: only the compiler response-file branch", () => cards(NO_LIMITS, "gcc @/w/L"));
  it("M-PR-6b: only the generic response-file branch", () => cards(NO_LIMITS, "git @/w/L"));
  it("unlisted command", () => cards(NO_LIMITS, "unknown_marks_command arg"));
});

it("M-PR-1a: embedded dotted device is held by the word scanner alone", () => cards(NO_LIMITS, "echo target=/./dev/sda"));
it("reading an unavailable session file does not execute it", () => runs(NO_LIMITS, "cat /w/F", "/w", { "/w/F": "unavailable" }));
it("canonical session execution cannot evade the unavailable-file guard", () => cards(FULL, "bash /w/./F.sh", "/w", { "/w/F.sh": "unavailable" }));
