// secret-scan: fixture (fake paths, policy test rows)
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
const { outsideScanMarks, plainWipe } = await import("./outside-scan.ts");
const { alwaysAskCommand } = await import("./always-ask.ts");
const { ownerMarks, withoutDoubts } = await import("./shell/marks.ts");
const { expectNoLimitsOwnerOutcome, expectNoLimitsProtectedWrite, isWipeRule } = await import("./testing/no-limits-1019.ts");

type Context = Parameters<typeof autoVerdict>[3];
const NO_LIMITS = { id: "owned", autoApprove: true, fullAccess: true, noLimits: true };
const FULL = { id: "owned", autoApprove: true, fullAccess: true };
const CLEAN_OWNER = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null } as const;
const STUB = { realpath: (path: string) => path, stat: () => ({ isFile: () => true, isDirectory: () => false }) };
const DISK = "/dev/sda";

/** Session files by absolute path: `{ text }` or "unavailable" (over 128 KiB, missing, non-regular, read error). */
type Files = Record<string, string | "unavailable">;
function call(bot: object, cmd: string, cwd = "/w", files: Files = {}, marked = false): ReturnType<typeof autoVerdict> {
  const edits = new Set(Object.keys(files));
  const context = {
    ...CLEAN_OWNER,
    outsideRead: marked ? outsideScanMarks(cmd) : null,
    commandText: cmd,
    commandCwd: cwd,
    workFolder: "/w",
    readOnlyHooks: { cwd, sessionEdits: edits },
    unseen: { fs: STUB, platform: "posix" },
    sessionFile: (path: string) => (path in files ? (files[path] === "unavailable" ? "unavailable" : { text: files[path]! }) : "unavailable"),
  } as unknown as Context;
  return autoVerdict(bot as never, "Bash", cmd, context);
}
const MONO_FULL = { id: "owned", autoApprove: true, fullAccess: true };
/** The row is held at Full access (and every non-owner bot); at the owner's No limits turn it runs unless the wipe list names it. */
const cards = (bot: object, cmd: string, cwd?: string, files?: Files, protectedWrite = false) => {
  const verdict = call(bot, cmd, cwd, files);
  if (bot !== NO_LIMITS) { expect(verdict.approve, cmd).toBeNull(); return; }
  // S1-B3 RULING (MAIN 2026-11-11 09:30Z): only declared protected writes
  // supersede the inherited run assertion; reader failures retain it.
  // S1-B3 RULING (MAIN 2026-11-11 09:30Z): these fixtures explicitly write system/device targets.
  const writesProtected = /^(?:touch (?:\/etc\/|~\/\.(?:bashrc|ssh\/))|echo x > (?:\/etc\/|~\/\.(?:bashrc|ssh\/))|cp blob \/(?:tmp\/\.\.\/proc|proc\/))/.test(cmd)
    || (/\/(?:dev|etc|var\/spool)\b/.test(cmd) && /(?:\bwrite(?:FileSync)?\s*\(|\btofile\s*\(|\bsyscall\s*\()/.test(cmd))
    || Object.values(files ?? {}).some(body => body !== 'unavailable' && /\/(?:dev|etc|var\/spool)\b/.test(body) && /(?:\bwrite(?:FileSync)?\s*\(|\btofile\s*\(|\bsyscall\s*\()/.test(body));
  if (protectedWrite || writesProtected) { expectNoLimitsProtectedWrite(verdict, cmd); return; }
  // NOLIM 1.0.19 (Sean 2026-11-10): the owner's No limits turn runs the row; Full access still cards it (the reader is unchanged). Only the
  // wipe list (or the plainWipe proxy over the text) and the kept Murage self-integrity row still card at No limits.
  expect(call(MONO_FULL, cmd, cwd, files).approve === null || verdict.approve !== null || isWipeRule(readerRule(cmd, cwd, files)) || plainWipe(cmd) ? "ok" : `No limits cards what Full access runs: ${cmd}`).toBe("ok");
  expectNoLimitsOwnerOutcome(verdict, cmd, readerRule(cmd, cwd, files));
};
/** The reader's own rule for the text, in the owner's strict read (never the final verdict's rule). */
const readerRule = (cmd: string, cwd = "/w", files: Files = {}) => {
  const read = () => alwaysAskCommand(cmd, cwd, "command", undefined, undefined, "/home/tester", { fs: STUB, platform: "posix",
    sessionEdits: new Set(Object.keys(files)), sessionFile: (path: string) => (path in files && files[path] !== "unavailable" ? { text: files[path]! } : "unavailable") });
  // the finalizer looks for a wipe in both reader modes with the closed-list doubts off; a named catastrophe the reader could not place
  // (a wipe it named in a text it could not follow whole) is a wipe row too
  const hits = [ownerMarks(read), ownerMarks(() => withoutDoubts(read)), withoutDoubts(read)];
  const wipe = hits.find((hit) => hit !== null && (isWipeRule(hit.rule) || hit.namedCatastrophe === true));
  return wipe ? "disk-erase" : hits[0]?.rule;
};
const runs = (bot: object, cmd: string, cwd?: string, files?: Files) => expect(call(bot, cmd, cwd, files).approve, cmd).toBeTruthy();

describe("FIX3 raw writes and data", () => {
  it("M-FIX3-gate 131072 character word exceeds command budget", () => cards(NO_LIMITS, `printf %s ${"a".repeat(131072)}`));
  it.each([
    "cp blob /tmp/../proc/../w/out", "mv blob /x/../dev/../w/y",
    "tee /w/../etc/../w/x", "touch /tmp/../sys/../w/x",
    "install blob /tmp/../var/spool/cron/../../../w/z", "ln blob /tmp/../proc/../w/out",
    "tar -C /w/../etc/../w/x -xf blob", "dd if=blob of=/w/../etc/../w/x",
    "rsync blob /tmp/../proc/../w/out", "unzip -d /tmp/../sys/../w/x blob",
    "zip /x/../dev/../w/y blob", "printf x > /tmp/../sys/../w/x",
  ])("M-FIX3-raw %s", cmd => cards(NO_LIMITS, cmd, undefined, undefined, true));
  it.each(["/etc/" + "./".repeat(3000) + "passwd", "/w/" + "../".repeat(2000) + "etc/passwd",
    "/w/" + "a".repeat(5000)])("M-FIX3-overlong %s", path => cards(NO_LIMITS, `cp blob ${path}`, undefined, undefined, path.startsWith("/etc/") || path.endsWith("etc/passwd")));
  it.each([4097, 131072 - 10])("M-FIX3-data printf %i", size => runs(NO_LIMITS, `printf %s ${"a".repeat(size)}`));
  it("M-FIX3-data echo 70000", () => runs(NO_LIMITS, `echo ${"a".repeat(70000)}`));
  it("M-FIX3-data protected redirect", () => cards(NO_LIMITS, `printf %s ${"a".repeat(4097)} > /etc/x`, undefined, undefined, true));
});

// S1-B3 RULING (MAIN 2026-11-11 09:30Z): these known writers name protected
// output targets. Execution-only and source-only rows retain their run assertions.
const FIX2_PROTECTED_WRITES = (cmd: string) =>
 /^(?:sed .*\/etc\/|awk .*print .*\/etc\/|python3 .*open\("\/var\/spool\/|touch .*\/etc\/|cp .*\/etc\/|mv .*\/etc\/|tee .*\/etc\/|install .*\/etc\/|ln .*\/etc\/|find .*-(?:fprint|fprintf|fls|delete)|tar -C .*\/etc\/|unzip -d .*\/etc\/|zip .*\/etc\/|rsync -a .*\/etc\/|docker run .*\/etc\/)/.test(cmd);

describe("FIX2 default deny", () => {
  // Exact review commands are inert strings. Some were already closed at HEAD.
  it.each([
    `sed -e'w /etc/cron.d/pwn'`, `sed -e 1p -e 'w /etc/cron.d/pwn' notes.txt`,
    `sed --expression='w /etc/cron.d/pwn'`, `sed -e'e id'`, `sed -ne'w /etc/cron.d/pwn'`,
    "sed -f- <<'EOF'\ne id\nEOF", "sed -e 1p -f/tmp/evil.sed",
    "sed -i -e 1p ../../../../../../etc/passwd",
    `awk 'BEGIN{system("id")}'`, `gawk 'BEGIN{system("id")}'`, `nawk 'BEGIN{system("id")}'`,
    `awk 'BEGIN{print "owned" > "/etc/cron.d/pwn"}'`, "awk -f /tmp/evil.awk",
    'ruby -e \'puts "#{`id`}"\'',
    `perl -e 'print "@{[system('"'"'id'"'"')]}"'`,
    `python3 -c 'open("/var/spool/cron/crontabs/root","w").write("x")'`,
    "touch ../../../../../../etc/cron.d/pwn", "touch ~/../../../../../../etc/cron.d/pwn",
    "cp ./blob ../../../../../../etc/cron.d/pwn", "mv ./blob ../../../../../../etc/cron.d/pwn",
    "tee ../../../../../../etc/cron.d/pwn", "install -m 644 ./blob ../../../../../../etc/cron.d/pwn",
    "ln -sf /tmp/blob ../../../../../../etc/cron.d/pwn",
    "git -c core.PAGER=id --paginate diff", "git -c core.sshcommand=id ls-remote ssh://example.invalid/r.git",
    "gcc -specs=pwn.specs hello.c", "clang -specs=pwn.specs hello.c",
    "tar -I./wipe.sh -cf /tmp/o.tar /tmp/src", "rsync -e'id' /tmp/a user@host:/tmp/b",
    "env GIT_SSH_COMMAND=id git ls-remote ssh://example.invalid/r.git",
    "find /tmp -exec awk 'BEGIN{system(\"id\")}' \\;",
    "find /tmp -fprint ../../../../../../etc/cron.d/pwn", "find ../../../../../../etc/cron.d -delete",
    "xargs -a/tmp/list touch", "xargs -a/tmp/list awk",
    "tar --checkpoint-action=exec=id --checkpoint=1 -cf /tmp/o.tar /tmp/src",
    "tar -xf /tmp/o.tar --to-command=id", "tar -C ../../../../../../etc/cron.d -xf /tmp/o.tar",
    "unzip -d ../../../../../../etc/cron.d /tmp/o.zip", "zip ../../../../../../etc/cron.d/o.zip /tmp/a",
    "rsync -a /tmp/a/ ../../../../../../etc/cron.d/",
    "ssh -o ProxyCommand=id example.invalid", "scp -o ProxyCommand=id example.invalid:/tmp/a /tmp/b",
    "git -c alias.x='!id' x", "docker run --rm -v ../../../../../../etc/cron.d:/t alpine touch /t/pwn",
    'cat > ./s.rb <<\'EOF\'\nputs "#{`id`}"\nEOF\nruby ./s.rb',
  ])("FIX2 attack %s", cmd => cards(NO_LIMITS, cmd, undefined, undefined, FIX2_PROTECTED_WRITES(cmd)));
  it.each([
    "tar -Iid", "rsync --rsh id a b", "ssh -oProxyCommand=id host", "git -cALIAS.x=!id x",
    "find /w -fprintf /etc/out %p", "find /w -fls /etc/out", "find /w -okdir awk 'system(1)' \\;",
    "xargs --arg-file=/w/L touch", "env PAGER=id less notes", "GIT_SSH=id git status",
    `python3 -c 'open("/tmp/out","w").write("x")'`,
  ])("FIX2 attack sibling %s", cmd => cards(NO_LIMITS, cmd, undefined, undefined, FIX2_PROTECTED_WRITES(cmd)));
  it.each(["/opt/custom-tool", "/w/wipe.sh", "/w/echo"])("G1 path command %s", cmd => cards(NO_LIMITS, cmd));
  it.each(["bash /etc/tool.sh", "python3 /proc/tool.py", "bash /dev/tool.sh", "bash /w/../tool.sh", "bash /w/F.sh; echo x"])("M-FIX2-waiver %s", cmd => cards(NO_LIMITS, cmd));
  it.each(["/w/./a.py", "/w//a.py", "/w/sub/../a.py"])("G2 stale session %s", path => {
    cards(NO_LIMITS, `cat > ${path} <<'PY'\nmystery()\nPY\npython3 /w/a.py`, "/w", { "/w/a.py": "print(1)" });
  });
  it.each(["dd if=proj of=/./dev/sdb", "cp proj /tmp/../proc/self/fd/1", "tee /dev/../dev/sdc"])("G4 sibling %s", cmd => cards(NO_LIMITS, cmd, undefined, undefined, true));
  it.each(["ruby -e 'mystery()'", "node -e 'mystery()'", "lua -e 'mystery()'"])("G5 sibling %s", cmd => cards(NO_LIMITS, cmd));
  it("G4 project dd control", () => runs(NO_LIMITS, "dd if=proj of=proj"));
});

/** MurageMain 11-07 (MARKS r11): Full access runs an unseen script file of the allowed shape, so the owner's own No limits
 * turn runs it too. Every other turn keeps the card, and so does a script a deny rule names. */
describe("M-R11-unseen owner No limits turn runs an unseen script Full access runs", () => {
  const turn = (cmd: string, extra: object) => {
    const context = {
      ...CLEAN_OWNER, commandText: cmd, commandCwd: "/w", workFolder: "/w",
      readOnlyHooks: { cwd: "/w", sessionEdits: new Set<string>() }, unseen: { fs: STUB, platform: "posix" },
      sessionFile: () => "unavailable", ...extra,
    } as unknown as Context;
    return autoVerdict(NO_LIMITS as never, "Bash", cmd, context);
  };
  it.each(["bash ./build.sh", "node tvcall.mjs", "python3 manage.py", "sh ./build.sh"])("M-R11-unseen %s runs on the owner's turn", cmd => {
    expect(call(FULL, cmd).approve, cmd).toBeTruthy();
    expect(turn(cmd, {}).approve, cmd).toBeTruthy();
  });
  it.each([
    ["M-R11-unseen-owner channel", { fullAccessOrigin: "owner-channel" }],
    ["M-R11-unseen-owner routine", { fullAccessOrigin: "routine" }],
    ["M-R11-unseen-owner other", { fullAccessOrigin: "other" }],
    ["M-R11-unseen-turn unattended", { unattended: true }],
    ["M-R11-unseen-turn automated", { automated: true }],
    ["M-R11-unseen-turn channel owner", { channelOwner: true }],
  ] as const)("%s keeps the card on bash ./build.sh", (_name, extra) => {
    const verdict = turn("bash ./build.sh", extra);
    expect(verdict.approve).toBeNull();
  });
  // NOLIM 1.0.19 (N1, N2.4): the finalizer reads the stored origin only, so a routine level flag or a marked lane on the owner's own
  // work does not hold it
  it.each([
    ["M-R11-unseen-turn routine level", { routineLevel: true }],
    ["M-R11-unseen-lane marked lane", { outsideRead: ["interpreter"] }],
  ] as const)("%s runs bash ./build.sh for stored owner work", (_name, extra) => {
    expect(turn("bash ./build.sh", extra).approve).toBeTruthy();
  });
  it.each(["bash /etc/tool.sh", "bash /usr/share/tool.sh", "python3 /usr/lib/tool.py"])("M-R11-unseen-deny %s: Full access keeps the card, No limits runs it", cmd => {
    expect(call(FULL, cmd).approve, cmd).toBeNull();
    expectNoLimitsOwnerOutcome(turn(cmd, {}), cmd, readerRule(cmd));
  });
  // the wipe list holds on every No limits turn, as for the could-not-read waiver (auto-approve.ts couldNotReadWaived)
  it.each(["bash ./build.sh /dev/sda", 'echo "rm -rf /" ; bash ./build.sh', "bash ./build.sh rm -rf /"])("M-R11-unseen-wipe %s keeps the card", cmd => {
    expect(call(FULL, cmd).approve, cmd).toBeTruthy();
    expect(turn(cmd, {}).approve, cmd).toBeNull();
  });
});

describe("S1 controls with scanner marks in the verdict context", () => {
  it.each([`python3 -c 'print("{}".format(1))'`, `python3 -c 'open("/w/out.txt","w").write("x")'`])("marked interpreter %s", cmd => {
    expect(outsideScanMarks(cmd)).toContain("interpreter");
    // NOLIM 1.0.19: the scanner's marks are not read at No limits, and (B5) `format` is a disk-format verb only as a command word, so a
    // string's .format(1) is no wipe word: both texts run, marked or not (M-format-method).
    const verdict = call(NO_LIMITS, cmd, "/w", {}, true);
    expect(plainWipe(cmd), cmd).toBe(false);
    expect(verdict.approve, cmd).toBeTruthy();
    runs(FULL, cmd);
  });
});

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
    // MARKS r9 X2: probe printf %s <131,063 a's> -> No limits cards (always-ask unreadable); Full access RUNS, same as b18 (full-access source), so Full is unchanged
    runs(FULL, cmd);
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
  // MARKS r9 X1: outsideScanMarks always runs in the product; with the marks the verdict cards (source outside-turn, rule outside-content) on No limits
  // NOLIM 1.0.19: the owner's No limits turn runs it with marks too (the marks are not read there)
  it("unlisted command", () => expect(call(NO_LIMITS, "unknown_marks_command arg", "/w", {}, true).approve, "unknown_marks_command arg").toBeTruthy());
  // twin: probe unknown_marks_command arg without marks -> runs (the product always passes the marks)
  it("unlisted command (unmarked)", () => runs(NO_LIMITS, "unknown_marks_command arg"));
});

it("M-PR-1a: embedded dotted device is held by the word scanner alone", () => cards(NO_LIMITS, "echo target=/./dev/sda"));
it("reading an unavailable session file does not execute it", () => runs(NO_LIMITS, "cat /w/F", "/w", { "/w/F": "unavailable" }));
it("canonical session execution cannot evade the unavailable-file guard", () => cards(FULL, "bash /w/./F.sh", "/w", { "/w/F.sh": "unavailable" }));

describe("MARKS r7: the closed-list doubts hold owner No limits only (r1.5 :24)", () => {
  it.each(["touch out", "rm -rf build"])("M-R7-level %s with no fixed folder runs on Full access", cmd => runs(FULL, cmd, ""));
  it.each(["touch out", "rm -rf build"])("M-R7-level-control %s with no fixed folder cards on No limits", cmd => cards(NO_LIMITS, cmd, ""));
  it.each(["rm -rf /", "mkfs.ext4 /dev/sda1"])("M-R7-level-deny %s still cards on Full access", cmd => cards(FULL, cmd));
});

describe("MARKS r9 (MurageMain 11-07): a ~ or $HOME word with a known folder runs on No limits; wipe-list and protected targets behind ~ still card", () => {
  // probe 11-07: echo ~/x, touch ~/x, echo $HOME/x, echo ~ -> null at /w (b18 null); rm -rf ~/ -> delete-home; ~/.ssh/authorized_keys -> card
  it.each(["echo ~/x", "touch ~/x", "echo $HOME/x", "echo ~", "echo /etc/x", "ls ~/x", "rm ~/x"])("M-R9-tilde %s runs", cmd => runs(NO_LIMITS, cmd, "/w"));
  it.each(["rm -rf ~/", "rm -rf ~", "rm -rf ~/*", "echo x > ~/.ssh/authorized_keys", "echo x > ~/.bashrc", "touch ~/.bashrc", "touch ~/.ssh/config", "touch /etc/x", "echo x > /etc/passwd"])("M-R9-tilde-twin %s still cards", cmd => cards(NO_LIMITS, cmd, "/w"));
  it.each(["rm -rf ~/", "rm -rf ~/*"])("M-R9-tilde-twin %s cards on Full access", cmd => cards(FULL, cmd, "/w"));
});
