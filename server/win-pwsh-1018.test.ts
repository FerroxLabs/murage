// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WIN-PWSH-1018: Full access parity for the one PowerShell text Codex and the ACP engines send on Windows for a script run.
// Both run every command as ["powershell.exe", "-NoProfile", "-Command", <text>] (drivers/codex.ts shellForm, drivers/acp/core.ts
// acpShellForm), so the gates judge <text> itself, here `bash ./build.sh`, as commandShell "pwsh". The Claude Bash tool's
// `bash ./build.sh` reaches the unseen-script reader (walk.ts unseenScript -> always-ask.ts unseenShapeAdmits: placement under the
// folder, the head bytes, a deny rule on the path, the relayed-scope card) and is covered at Full access (`unseenCovered`). The same
// text under pwsh hit the 1.0.5 launcher rule instead (pwsh.ts unmodelled: "bash runs something the reader does not see"), which
// cards at every level with why=tokenizer. Now the exact NL-WIN-1018 D4 shape is read as the Git Bash text it is at the level and
// origin Full access covers for the owner, through the same reader and the same judges; No limits keeps the D4 gate and every
// other spelling, level and origin keeps the PowerShell card. Nothing passes here that the Claude Bash tool's own text would not.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { autoVerdict } from "./auto-approve.ts";

type Context = Parameters<typeof autoVerdict>[3];
const NO_LIMITS = { id: "owned", autoApprove: true, fullAccess: true, noLimits: true };
const FULL = { id: "full", autoApprove: true, fullAccess: true };
const AUTO = { id: "auto", autoApprove: true };
const ASK = { id: "ask" };
/** A stubbed Windows disk and PATH for the gate's `bash` resolution (WIN-PWSH-1018 H1): dir (lower case) -> name -> entry. */
type Entry = { kind: "file" | "dir" | "link"; real?: string; /** stat ino (0n: the volume gives none) */ ino?: bigint; /** two names differing in case are two files */ caseSensitive?: boolean };
const inos = new Map<string, bigint>();
const inoOf = (key: string): bigint => { if (!inos.has(key)) inos.set(key, BigInt(inos.size + 1)); return inos.get(key)!; };
const fakeDisk = (dirs: Record<string, Record<string, Entry>>, path: string | undefined, pathExt: string | undefined, gitBash: string | undefined) => {
  const at = (p: string) => { const i = p.lastIndexOf("\\"); const d = dirs[p.slice(0, i).toLowerCase()]; const n = d && Object.keys(d).find(x => x.toLowerCase() === p.slice(i + 1).toLowerCase()); return n === undefined ? undefined : d![n]; };
  return {
    path, pathExt, gitBash,
    list: (dir: string) => { const d = dirs[dir.toLowerCase()]; if (!d) throw new Error("EPERM"); return Object.keys(d); },
    lstat: (p: string) => { const e = at(p); if (!e) throw new Error("ENOENT"); return { isFile: () => e.kind === "file", isSymbolicLink: () => e.kind === "link" }; },
    realpath: (p: string) => { const e = at(p); if (!e) throw new Error("ENOENT"); return e.real ?? (e.caseSensitive ? p : p.toLowerCase()); },
    // one file index per distinct real path (case folded unless the entry sits in a case-sensitive folder)
    stat: (p: string) => { const e = at(p); if (!e) throw new Error("ENOENT"); const r = e.real ?? (e.caseSensitive ? p : p.toLowerCase()); return { dev: 1n, ino: e.ino ?? inoOf(e.caseSensitive ? r : r.toLowerCase()) }; },
  };
};
const F: Entry = { kind: "file" };
const GIT_ROOT = "C:\\Program Files\\Git";
const GIT_BASH = `${GIT_ROOT}\\bin\\bash.exe`;
const DISK = {
  "c:\\program files\\git\\bin": { "bash.exe": F, "sh.exe": F, "git.exe": F },
  "c:\\program files\\git\\usr\\bin": { "bash.exe": F, "sh.exe": F },
  "c:\\windows\\system32": { "bash.exe": F, "cmd.exe": F },
};
const GIT_FIRST = fakeDisk(DISK, "C:\\Program Files\\Git\\bin;C:\\Windows\\System32", ".COM;.EXE;.BAT;.CMD", GIT_BASH);

/** The engine forms the gate box logged: tool=shell, cmd=pwsh, origin=owner, owner=0 (no owner-started proof), level=full. */
const CODEX_CALL = (text: string) => ({ engine: "codex", commandShell: "pwsh", toolCall: { name: "shell", input: { command: text } } });
const FUIGO_CALL = (text: string) => ({ engine: "fuigo", commandShell: "pwsh", toolCall: { name: "execute", input: { command: text } } });

describe("WIN-PWSH-1018: pwsh `bash ./build.sh` at Full access runs as the Claude Bash tool's own does", () => {
  let dir = "";
  let outside = "";
  const text0 = "bash ./build.sh";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "winpwsh-"));
    outside = mkdtempSync(join(tmpdir(), "winpwsh-out-"));
    writeFileSync(join(dir, "build.sh"), "#!/bin/bash\necho MARK > out.txt\n");
    writeFileSync(join(dir, "b.sh"), "#!/bin/bash\necho hi\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.sh"), "#!/bin/bash\necho hi\n");
    writeFileSync(join(outside, "x.sh"), "#!/bin/bash\necho x\n");
    symlinkSync(outside, join(dir, "junction"));
    mkdirSync(join(dir, ".ssh"));
    writeFileSync(join(dir, ".ssh", "run.sh"), "#!/bin/bash\n");
    writeFileSync(join(dir, "NUL.sh"), "#!/bin/bash\n");
  });
  /** The exact gate-box context: origin owner, no owner-started proof, a clean attended turn. */
  const base = (text: string) => ({ fullAccessOrigin: "owner", ownerStarted: false, stopLine: null, outsideRead: null, commandText: text, commandCwd: dir, workFolder: dir, handedShellPath: GIT_FIRST });
  const pwsh = (bot: object, text: string, extra: object = {}, tool = "shell", call: (text: string) => object = CODEX_CALL) =>
    autoVerdict(bot as never, tool, text, { ...base(text), call: call(text), ...extra } as unknown as Context);
  /** The Claude Bash tool's own text: no engine call, no commandShell. */
  const direct = (bot: object, text: string, extra: object = {}) => autoVerdict(bot as never, "Bash", text, { ...base(text), ...extra } as unknown as Context);

  it("the codex form runs at Full access, as the Claude Bash tool's text does", () => {
    const found = pwsh(FULL, text0);
    expect(found.approve, JSON.stringify(found)).not.toBeNull();
    expect(found.source).not.toBe("always-ask");
    expect(found.source).toBe(direct(FULL, text0).source);
  });
  it("the fuigo (ACP) form runs at Full access, as the Claude Bash tool's text does", () => {
    const found = pwsh(FULL, text0, {}, "execute", FUIGO_CALL);
    expect(found.approve, JSON.stringify(found)).not.toBeNull();
    expect(found.source).toBe(direct(FULL, text0).source);
  });
  it.each(["bash ./build.sh", "sh ./build.sh", "bash ./sub/b.sh", "bash sub/b.sh"])("parity at Full access for %s: the same answer as the Claude Bash tool", (text) => {
    const viaPwsh = pwsh(FULL, text);
    const viaBash = direct(FULL, text);
    expect(viaPwsh.approve !== null, text).toBe(viaBash.approve !== null);
    expect(viaPwsh.approve, text).not.toBeNull();
  });
  it.each([
    "bash ./build.sh; Remove-Item x", "bash ./build.sh && echo hi", "bash ./build.sh | Out-Null",
    "bash ./b.sh > o", "bash ./b.sh 2>&1",
    "bash -x ./b.sh", "bash --rcfile x ./b.sh",
    "bash $env:X", "bash $(Get-Item x)", "bash ./$name.sh", "bash ./b`$x.sh", "bash @args",
    "bash ../out.sh", "bash sub/../../x.sh",
    "bash C:\\tmp\\b.sh", "bash /c/tmp/b.sh", "bash \\\\srv\\s\\b.sh", "bash ./b.sh:ads",
    "bash .\\build.sh", "bash bash.exe", "bash.exe ./build.sh", "bash ./junction/x.sh",
    "bash build.sh",
    "bash -c './build.sh'", "bash ./b.sh; Remove-Item -Recurse C:\\", "cmd /c build.bat", "powershell -c ./build.sh",
    "bash ./.ssh/run.sh", "/bin/bash ./build.sh", "bash './build.sh'", "bash ./build.sh extra", "bash ./b.sh\nRemove-Item x",
    "bash ./b.sh; rm -rf /", "bash ./build.sh\"", "bash ./build.sh; iex (gc x)",
  ])("still cards at Full access: %s", (text) => {
    const found = pwsh(FULL, text);
    expect(found.approve, text).toBeNull();
    expect(found.source, text).toBe("always-ask");
    expect(found.rule, text).toBe("unreadable");
  });
  it("a dangerous payload keeps its deny card at Full access, pwsh and direct alike", () => {
    // outside owner mode a deny carries its rule; the typed `classification` is the owner's MARKS read only
    expect(pwsh(FULL, "Remove-Item -Recurse -Force C:\\")).toMatchObject({ approve: null, source: "always-ask", rule: "delete-root" });
    expect(pwsh(FULL, "Format-Volume -DriveLetter C")).toMatchObject({ approve: null, source: "always-ask", rule: "disk-erase" });
    expect(direct(FULL, "rm -rf /")).toMatchObject({ approve: null, source: "always-ask", rule: "delete-root" });
  });
  it("a script reached through a link to a system folder holds at Full access with the same card the Claude Bash tool gets (the typed protected-path deny is the No limits read)", () => {
    symlinkSync("/etc", join(dir, "etc-link"));
    symlinkSync("/usr/bin", join(dir, "usrbin-link"));
    // at Full access the link check holds it first (the typed protected-path deny is the owner's MARKS read); the pwsh text gets
    // exactly the card the Claude Bash tool's own text gets, never less
    for (const text of ["bash ./etc-link/x.sh", "bash etc-link/x.sh", "bash ./usrbin-link/x.sh"]) {
      const viaPwsh = pwsh(FULL, text);
      const viaBash = direct(FULL, text);
      expect(viaPwsh, text).toMatchObject({ approve: null, source: "always-ask" });
      expect(viaBash, text).toMatchObject({ approve: null, source: "always-ask" });
      expect(viaPwsh.rule, text).toBe(viaBash.rule);
      expect(pwsh(NO_LIMITS, text, { ownerStarted: true }), text).toMatchObject({ approve: null, rule: "protected-path", classification: "deny" });
    }
  });
  it("pwsh syntax the reader does not model (or that does not parse) still holds at Full access", () => {
    for (const text of ["bash ./b`$x.sh", "bash $(Get-Item x)", "bash @args", "bash ./build.sh\"", "bash ./build.sh @'\nx"]) {
      const found = pwsh(FULL, text);
      expect(found.approve, text).toBeNull();
      expect(found.rule, text).toBe("unreadable");
    }
  });
  it("Auto and Ask still card, as they card the Claude Bash tool's own text", () => {
    for (const bot of [AUTO, ASK]) {
      expect(pwsh(bot, text0).approve, JSON.stringify(bot)).toBeNull();
      expect(direct(bot, text0).approve, JSON.stringify(bot)).toBeNull();
    }
  });
  it("No limits keeps the D4 gate: without the owner-started proof it cards, as the Claude Bash tool's text does", () => {
    const viaPwsh = pwsh(NO_LIMITS, text0);
    expect(viaPwsh.approve).toBeNull();
    expect(direct(NO_LIMITS, text0).approve).toBeNull();
    // with the proof, the D4 admission as shipped
    expect(pwsh(NO_LIMITS, text0, { ownerStarted: true })).toMatchObject({ source: "no-limits" });
  });
  it.each<[string, object]>([
    ["origin other", { fullAccessOrigin: "other" }], ["origin owner-channel", { fullAccessOrigin: "owner-channel" }],
    ["no origin, unattended", { fullAccessOrigin: undefined, unattended: true }], ["no origin, automated", { fullAccessOrigin: undefined, automated: true }],
    ["scope set", { scope: "local-computer" }], ["inputCut", { inputCut: true }], ["inputTruncated", { inputTruncated: true }],
    ["inputMissing", { call: { engine: "codex", commandShell: "pwsh", inputMissing: "command", toolCall: { name: "shell", input: {} } } }],
    ["commandCwdInvalid", { commandCwdInvalid: true }], ["routineLevel", { routineLevel: true }],
  ])("Full access still cards on a %s", (_name, extra) => {
    expect(pwsh(FULL, text0, extra).approve).toBeNull();
  });
  it("a missing script, a junction and no cwd card at Full access", () => {
    expect(pwsh(FULL, "bash ./nothere.sh").approve).toBeNull();
    expect(pwsh(FULL, "bash ./junction/x.sh").approve).toBeNull();
    expect(pwsh(FULL, text0, { commandCwd: undefined, workFolder: undefined }).approve).toBeNull();
  });
  it("on a Windows folder (drive cwd, stubbed disk): the shape runs at Full access; a device name, a junction and an ADS card", () => {
    const winDir = "C:\\Users\\o\\bot";
    const links: Record<string, string> = { "c:/users/o/bot/junction/x.sh": "d:/elsewhere/x.sh" };
    const realpath = (path: string) => { const flat = path.replace(/\\/g, "/"); return links[flat.toLowerCase()] ?? flat.replace("c:/Users", "C:/Users"); };
    const fs = { realpath, stat: () => ({ isFile: () => true, isDirectory: () => false }), head: () => new TextEncoder().encode("#!/bin/sh\n") };
    const win = (text: string) => pwsh(FULL, text, { commandCwd: winDir, workFolder: winDir, unseen: { platform: "win32", fs } });
    const winDirect = (text: string) => direct(FULL, text, { commandCwd: winDir, workFolder: winDir, unseen: { platform: "win32", fs } });
    expect(win("bash ./build.sh").approve, JSON.stringify(win("bash ./build.sh"))).not.toBeNull();
    expect(win("bash ./build.sh").source).toBe(winDirect("bash ./build.sh").source);
    expect(win("bash sub/b.sh").approve).not.toBeNull();
    for (const text of ["bash ./NUL.sh", "bash ./con.txt.sh", "bash ./junction/x.sh", "bash ./b.sh:ads", "bash .\\build.sh", "bash C:\\tmp\\b.sh", "bash ./sub./b.sh"]) {
      expect(win(text).approve, text).toBeNull();
    }
  });
});

// H1 (Astra 11-09, redesigned after the second BLOCK): PowerShell resolves a bare `bash` by its own rules, so each of the three
// pwsh bash admissions (the 1.0.5 `bash -c '<payload>'` relief, D4 No limits, Full access `bash ./x.sh`) first resolves it on the
// handed PATH and PATHEXT and admits only the engine's own Git Bash file (regular file, exactly equal native realpath, and equal dev
// and ino when stat gives them). The HOLDS table and the admit cases run on all three lanes; the spelling test is the payload lane's own,
// the sh tests run on Full access and D4.
describe("WIN-PWSH-1018 H1: the bare `bash` PowerShell runs must be the engine's Git Bash (fail closed)", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "winpwsh-h1-"));
    writeFileSync(join(dir, "build.sh"), "#!/bin/bash\necho hi\n");
  });
  const EXTS = ".COM;.EXE;.BAT;.CMD";
  const GIT = "C:\\Program Files\\Git\\bin";
  const USR = "C:\\Program Files\\Git\\usr\\bin";
  const SYS = "C:\\Windows\\System32";
  const APPS = "C:\\Users\\o\\AppData\\Local\\Microsoft\\WindowsApps";
  const TOOLS = "C:\\tools";
  const USER_GIT = "C:\\Users\\o\\AppData\\Local\\Programs\\Git\\bin";
  const k = (d: string) => d.toLowerCase();
  const BASE: Record<string, Record<string, Entry>> = { ...DISK, "c:\\windows\\x": { "cmd.exe": F }, [k(APPS)]: { "bash.exe": F }, [k(TOOLS)]: { "bash.exe": F, "bash.cmd": F }, [k(USER_GIT)]: { "bash.exe": F, "sh.exe": F } };
  const call = (text: string) => ({ engine: "codex", commandShell: "pwsh", toolCall: { name: "shell", input: { command: text } } });
  const clean = (text: string) => ({ fullAccessOrigin: "owner", stopLine: null, outsideRead: null, commandText: text, commandCwd: dir, workFolder: dir, call: call(text) });
  const TEXT = { payload: "bash -c 'echo hi'", d4: "bash ./build.sh", full: "bash ./build.sh" } as const;
  const LANES = ["payload", "d4", "full"] as const;
  const run = (lane: (typeof LANES)[number], handed: object | undefined, text: string = TEXT[lane]) =>
    autoVerdict((lane === "d4" ? NO_LIMITS : FULL) as never, "shell", text, { ...clean(text), ownerStarted: lane === "d4", handedShellPath: handed } as unknown as Context);
  const disk = (dirs: Record<string, Record<string, Entry>>, path: string | undefined, ext: string | undefined = EXTS, gitBash: string | undefined = GIT_BASH) => fakeDisk(dirs, path, ext, gitBash);

  it.each(LANES)("%s: the real Git Bash is admitted (Git bin, a per-user Git, case on disk, empty PATH entries)", (lane) => {
    const userBash = `${USER_GIT}\\bash.exe`;
    const cases: [string, ReturnType<typeof disk>][] = [
      ["git bin first", disk(BASE, `${GIT};${SYS}`)],
      ["empty entries skipped", disk(BASE, `;${SYS.replace("System32", "x")};;${GIT}`, EXTS, GIT_BASH)],
      ["per-user Git under AppData\\Local\\Programs", disk(BASE, `${USER_GIT};${SYS}`, EXTS, userBash)],
      ["wrapper later on PATH is never reached", disk(BASE, `${GIT};${TOOLS}`)],
      ["case differs on disk", disk({ ...BASE, [k(GIT)]: { "BASH.EXE": F } }, GIT)],
    ];
    for (const [name, handed] of cases) {
      const found = run(lane, handed);
      expect(found.approve, `${lane} ${name} ${JSON.stringify(found)}`).not.toBeNull();
    }
  });
  const HOLDS: [string, () => object | undefined][] = [
    ["bash.ps1 ahead of Git Bash", () => disk({ ...BASE, [k(TOOLS)]: { "bash.ps1": F, "bash.exe": F } }, `${TOOLS};${GIT}`)],
    ["bash.cmd wrapper ahead", () => disk({ ...BASE, [k(TOOLS)]: { "bash.cmd": F } }, `${TOOLS};${GIT}`)],
    ["bash.bat wrapper ahead", () => disk({ ...BASE, [k(TOOLS)]: { "bash.bat": F } }, `${TOOLS};${GIT}`)],
    ["bash.com wrapper ahead", () => disk({ ...BASE, [k(TOOLS)]: { "bash.com": F } }, `${TOOLS};${GIT}`)],
    ["bash.ps1 in the Git folder itself", () => disk({ ...BASE, [k(GIT)]: { "bash.ps1": F, "bash.exe": F } }, GIT)],
    ["bash.com beside Git's bash.exe (PATHEXT order)", () => disk({ ...BASE, [k(GIT)]: { "bash.exe": F, "bash.com": F } }, GIT)],
    ["WindowsApps App Execution Alias first", () => disk(BASE, `${APPS};${GIT}`)],
    ["System32 (WSL) bash.exe first", () => disk(BASE, `${SYS};${GIT}`)],
    ["an unrelated bash.exe first", () => disk(BASE, `${TOOLS.replace("tools", "tools2")};${GIT}`, EXTS)],
    ["an unrelated exe in a folder that is named Git\\bin", () => disk({ ...BASE, "c:\\evil\\git\\bin": { "bash.exe": F } }, "C:\\evil\\Git\\bin")],
    ["a file symlink named bash.exe in Git's bin", () => disk({ ...BASE, [k(GIT)]: { "bash.exe": { kind: "link", real: `${SYS}\\bash.exe` } } }, GIT)],
    ["a Git\\bin folder that is a junction to System32", () => disk({ ...BASE, "c:\\junction\\git\\bin": { "bash.exe": { kind: "file", real: `${SYS}\\bash.exe` } } }, "C:\\junction\\Git\\bin")],
    ["a Git\\bin folder that is a junction to WindowsApps", () => disk({ ...BASE, "c:\\junction\\git\\bin": { "bash.exe": { kind: "file", real: `${APPS}\\bash.exe` } } }, "C:\\junction\\Git\\bin")],
    ["a directory named bash.exe in Git's bin, a wrapper later", () => disk({ ...BASE, [k(GIT)]: { "bash.exe": { kind: "dir" } } }, `${GIT};${TOOLS}`)],
    ["a directory named bash.cmd ahead", () => disk({ ...BASE, [k(TOOLS)]: { "bash.cmd": { kind: "dir" } } }, `${TOOLS};${GIT}`)],
    ["Git's usr\\bin bash.exe first when the engine's Git Bash is bin\\bash.exe", () => disk(BASE, `${USR};${GIT}`)],
    ["a quoted PATH entry", () => disk(BASE, `"${GIT}";${TOOLS}`)],
    ["a PATH entry with edge whitespace", () => disk({ ...BASE, [` ${k(GIT)}`]: { "bash.exe": F } }, ` ${GIT};${TOOLS}`)],
    ["PATHEXT entry with leading whitespace", () => disk({ ...BASE, [k(GIT)]: { "bash.exe": F, "bash.cmd": F } }, GIT, " .EXE;.CMD")],
    ["PATHEXT entry that is empty", () => disk(BASE, GIT, ".EXE;;.CMD")],
    ["PATHEXT with a trailing separator", () => disk(BASE, GIT, ".EXE;")],
    ["PATHEXT empty", () => disk(BASE, GIT, "")],
    ["PATHEXT missing (undefined)", () => ({ ...disk(BASE, GIT), pathExt: undefined })],
    ["an extensionless `bash` file ahead of Git Bash (R1)", () => disk({ ...BASE, [k(TOOLS)]: { bash: F } }, `${TOOLS};${GIT}`)],
    ["an extensionless `bash` that is a directory ahead (R1)", () => disk({ ...BASE, [k(TOOLS)]: { bash: { kind: "dir" } } }, `${TOOLS};${GIT}`)],
    ["the discovered Git Bash is a different file with the same name in another case, in a case-sensitive folder (R2)", () => disk({ ...BASE, "c:\\cs\\git\\bin": { "bash.exe": { kind: "file", caseSensitive: true } } },"C:\\cs\\git\\bin", EXTS, "C:\\cs\\Git\\bin\\bash.exe")],
    ["a hard link to Git's bash.exe at another path: equal dev and ino, different realpath (H4)", () => disk({ ...BASE, "c:\\shadow\\bin": { "bash.exe": { kind: "file", ino: 7n } }, [k(GIT)]: { "bash.exe": { kind: "file", ino: 7n } } }, `C:\\shadow\\bin;${GIT}`)],
    ["same name, different file index (R2)", () => disk({ ...BASE, [k(TOOLS)]: { "bash.exe": { kind: "file", ino: 99n } } }, TOOLS, EXTS, GIT_BASH)],
    ["no file index (ino 0) and the real paths differ", () => disk({ ...BASE, [k(TOOLS)]: { "bash.exe": { kind: "file", ino: 0n } }, [k(GIT)]: { "bash.exe": { kind: "file", ino: 0n } } }, TOOLS, EXTS, GIT_BASH)],
    ["no file index (ino 0) and the paths differ only in case (exact-case compare)", () => disk({ ...BASE, [k(GIT)]: { "bash.exe": { kind: "file", ino: 0n, caseSensitive: true } } }, GIT, EXTS, GIT_BASH.replace("Program Files", "PROGRAM FILES"))],
    ["PATH missing", () => disk(BASE, undefined)],
    ["PATH empty", () => disk(BASE, "")],
    ["no Git Bash discovered", () => disk(BASE, GIT, EXTS, "")],
    ["Git Bash discovered but not on disk", () => disk(BASE, GIT, EXTS, "C:\\nowhere\\bin\\bash.exe")],
    ["a directory that cannot be read, before Git", () => disk(BASE, `C:\\locked;${GIT}`)],
    ["a relative PATH entry", () => disk(BASE, `.\\bin;${GIT}`)],
    ["no bash anywhere on PATH", () => disk(BASE, SYS.replace("System32", "none"))],
  ];
  it.each(LANES)("%s: every other resolution is held", (lane) => {
    BASE["c:\\tools2"] = { "bash.exe": F };
    BASE["c:\\windows\\none"] = { "cmd.exe": F };
    for (const [name, make] of HOLDS) {
      const found = run(lane, make());
      expect(found.approve, `${lane}: ${name}`).toBeNull();
      expect(found.source, `${lane}: ${name}`).toBe("always-ask");
    }
  });
  it.each(LANES)("%s: no file index falls back to the exact-case realpath: equal admits, stat failing falls back the same way (R2)", (lane) => {
    const noIno = { ...BASE, [k(GIT)]: { "bash.exe": { kind: "file" as const, ino: 0n } } };
    expect(run(lane, disk(noIno, GIT)).approve, lane).not.toBeNull();
    const d = disk(BASE, GIT);
    expect(run(lane, { ...d, stat: () => { throw new Error("EPERM"); } }).approve, `${lane} stat throws, same real path`).not.toBeNull();
    const cs = disk({ ...BASE, [k(GIT)]: { "bash.exe": { kind: "file", caseSensitive: true } } }, GIT, EXTS, GIT_BASH.replace("Program Files", "PROGRAM FILES"));
    expect(run(lane, { ...cs, stat: () => { throw new Error("EPERM"); } }).approve, `${lane} stat throws, case differs`).toBeNull();
  });
  it.each(LANES)("%s: equal realpaths still need equal dev and ino when stat gives them; ino 0 on one side or a second stat that throws is decided by the realpath (H4, R2)", (lane) => {
    const d = disk(BASE, GIT);
    const seq = (...answers: ({ dev: bigint; ino: bigint } | "throw")[]) => { let i = 0; return () => { const a = answers[i++]; if (a === "throw" || a === undefined) throw new Error("EPERM"); return a; }; };
    expect(run(lane, { ...d, stat: seq({ dev: 1n, ino: 5n }, { dev: 1n, ino: 5n }) }).approve, `${lane} equal`).not.toBeNull();
    expect(run(lane, { ...d, stat: seq({ dev: 1n, ino: 5n }, { dev: 1n, ino: 6n }) }).approve, `${lane} ino differs`).toBeNull();
    expect(run(lane, { ...d, stat: seq({ dev: 1n, ino: 5n }, { dev: 2n, ino: 5n }) }).approve, `${lane} dev differs`).toBeNull();
    expect(run(lane, { ...d, stat: seq({ dev: 1n, ino: 0n }, { dev: 2n, ino: 6n }) }).approve, `${lane} ino 0 on one side`).not.toBeNull();
    expect(run(lane, { ...d, stat: seq({ dev: 1n, ino: 5n }, "throw") }).approve, `${lane} second stat throws`).not.toBeNull();
  });
  it("sh: the first reference probe failing falls through to the other install folder; an extensionless `sh` holds under D4 too", () => {
    const text = "sh ./build.sh";
    const onlyUsr = { ...BASE, [k(GIT)]: { "bash.exe": F }, [k(USR)]: { "bash.exe": F, "sh.exe": F } };
    expect(run("full", disk(onlyUsr, USR), text).approve).not.toBeNull();
    expect(run("d4", disk({ ...BASE, [k(TOOLS)]: { sh: F } }, `${TOOLS};${GIT}`), text).approve).toBeNull();
    expect(run("d4", disk({ ...BASE, [k(TOOLS)]: { sh: { kind: "dir" } } }, `${TOOLS};${GIT}`), text).approve).toBeNull();
  });
  it("sh: an extensionless `sh` ahead, or a different file index for sh.exe, holds (R1, R2)", () => {
    const text = "sh ./build.sh";
    expect(run("full", disk({ ...BASE, [k(TOOLS)]: { sh: F } }, `${TOOLS};${GIT}`), text).approve).toBeNull();
    expect(run("full", disk({ ...BASE, [k(TOOLS)]: { "sh.exe": { kind: "file", ino: 98n } } }, `${TOOLS};${GIT}`), text).approve).toBeNull();
    expect(run("full", disk(BASE, `${GIT};${SYS}`), text).approve).not.toBeNull();
  });
  it.each(LANES)("%s: no handed environment at all is held", (lane) => {
    expect(run(lane, undefined).approve).toBeNull();
  });
  it("only the exact bare word gets the `bash -c` relief: bash.exe, drive, UNC and rooted paths keep the 1.0.5 launcher hold", () => {
    const handed = disk(BASE, `${GIT};${SYS}`);
    expect(run("payload", handed, "bash -c 'echo hi'").approve).not.toBeNull();
    for (const text of ["bash.exe -c 'echo hi'", "C:\\Windows\\System32\\bash.exe -c 'echo hi'", "C:\\Program Files\\Git\\bin\\bash.exe -c 'echo hi'",
      "& 'C:\\Program Files\\Git\\bin\\bash.exe' -c 'echo hi'", "\\\\srv\\share\\bash.exe -c 'echo hi'", "/usr/bin/bash -c 'echo hi'", "C:bash -c 'echo hi'", "wsl bash -c 'echo hi'"]) {
      const found = run("payload", handed, text);
      expect(found.approve, text).toBeNull();
      expect(found.source, text).toBe("always-ask");
    }
  });
  it("sh resolves the same way: Git's sh.exe (bin or usr\\bin) admits; a wrapper, WSL or another sh.exe holds, on Full access and D4", () => {
    const text = "sh ./build.sh";
    const go = (lane: "d4" | "full", handed: object) => run(lane, handed, text);
    for (const lane of ["full", "d4"] as const) {
      expect(go(lane, disk(BASE, `${GIT};${SYS}`)).approve, lane).not.toBeNull();
      expect(go(lane, disk(BASE, `${USR};${SYS}`)).approve, lane).not.toBeNull();
      expect(go(lane, disk({ ...BASE, [k(TOOLS)]: { "sh.cmd": F } }, `${TOOLS};${GIT}`)).approve, lane).toBeNull();
      expect(go(lane, disk({ ...BASE, [k(TOOLS)]: { "sh.exe": F } }, `${TOOLS};${GIT}`)).approve, lane).toBeNull();
      expect(go(lane, disk({ ...BASE, [k(SYS)]: { "sh.exe": F } }, `${SYS};${GIT}`)).approve, lane).toBeNull();
      expect(go(lane, disk({ ...BASE, [k(GIT)]: { "sh.exe": { kind: "link", real: `${SYS}\\sh.exe` } } }, GIT)).approve, lane).toBeNull();
    }
  });
});
