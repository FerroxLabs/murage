// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rule 74 (APP-GRANT-DESIGN-FINAL.AGREED-r10.md): the owner's interactive
// login capture (74a), the handed map with the pins written last (74a(3),
// 74c), and the consistency check that can only remove (74d).

import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ABSENT_PINS, valuePins, type PinRun } from "../shared/arg-vocabulary.ts";
import * as procs from "./procs.ts";
import { comparePowerShellCheck, setExecEnvBotReader, setExecEnvOriginReader, compareCheck, execEnvHanded, execEnvNow, handedPinsOf, handEnv, noteStartupFileEvent, type HandedEnv } from "./engine-env.ts";
import { envInfoOf, isExecEnv } from "../shared/mount-identity.ts";
import { askTouchesStartup } from "./startup-files.ts";
import { captureOwnerEnv, invalidateEnvCapture, ownerEnvState, parseEnvBlock, readCapture, resetPathCacheForTests, setOwnerEnvStore } from "./env-path.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let dir: string;
/** The pin probes (`ssh -V`, `git config`) answered as on a machine with neither. */
const noRun: PinRun = async () => ({ ok: false, stdout: "", stderr: "" });
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "engine-env-")));
  resetPathCacheForTests();
  invalidateEnvCapture("test start");
});
afterEach(() => removeTempDirSync(dir));

/** A stand-in account shell: prints rc-file noise around the real capture. */
function fakeShell(body: string): string {
  const file = join(dir, "fake-shell");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

// The account-shell capture and the pinned /bin/sh check are POSIX only: on Windows Murage never runs a login shell (the launch
// environment is read live; env-check-again.test.ts has the Windows row), so the #!/bin/sh stand-ins cannot run there.
const posixShell = process.platform !== "win32";

describe("the capture (Rule 74a)", () => {
  it.skipIf(!posixShell)("reads the whole exported map between the markers, past startup noise", async () => {
    const shell = fakeShell(`echo "welcome to zsh"; export PROJECT_DOCS=./docs; export PATH=/opt/nvm/bin:/usr/bin; export HOME=${dir}; shift 3; exec /bin/sh -c "$1"`);
    setOwnerEnvStore(join(dir, "env"));
    const owner = await captureOwnerEnv({ shell });
    expect(owner.capture).toBe("session");
    expect(owner.env.PROJECT_DOCS).toBe("./docs");
    expect(owner.env.PATH).toBe("/opt/nvm/bin:/usr/bin");
    expect(owner.env.MURAGE_ENV_MARK).toBeUndefined();
    // persisted 0600, NUL-separated, readable through the same parser
    const stored = readdirFile(join(dir, "env"));
    expect(statSync(stored).mode & 0o777).toBe(0o600);
    expect(parseEnvBlock(readFileSync(stored, "utf8"))?.PROJECT_DOCS).toBe("./docs");
  });

  it.skipIf(!posixShell)("an incomplete capture is never handed: the last validated map is kept, then the told fallback", async () => {
    const shell = fakeShell(`export PATH=/good/bin:/usr/bin:/bin; export HOME=${dir}; shift 3; exec /bin/sh -c "$1"`);
    setOwnerEnvStore(join(dir, "env"));
    expect((await captureOwnerEnv({ shell })).capture).toBe("session");
    // the server restarts and the same shell's capture now fails: the persisted map is handed
    resetPathCacheForTests();
    writeFileSync(shell, "#!/bin/sh\nexit 3\n");
    const kept = await captureOwnerEnv({ shell });
    expect(kept.capture).toBe("kept");
    expect(kept.env.PATH).toBe("/good/bin:/usr/bin:/bin");
    expect(kept.cause).toBeTruthy();
    // a shell with no validated map at all gets the told fallback, never silently
    resetPathCacheForTests();
    const other = join(dir, "other-shell");
    writeFileSync(other, "#!/bin/sh\necho PATH=/x\n");
    chmodSync(other, 0o755);
    const fallback = await captureOwnerEnv({ shell: other });
    expect(fallback.capture).toBe("fallback");
    expect(fallback.cause).toBeTruthy();
  });

  it("a map missing PATH or HOME, a missing marker, or a block that does not parse whole is incomplete", () => {
    const mark = "__M__";
    expect(readCapture(`${mark}PATH=/b\0HOME=/h\0${mark}`, mark)).toEqual({ PATH: "/b", HOME: "/h" });
    expect(readCapture(`${mark}PATH=/b\0${mark}`, mark)).toBeNull();
    expect(readCapture(`PATH=/b\0HOME=/h\0${mark}`, mark)).toBeNull();
    expect(readCapture(`${mark}PATH=/b\0HOME=/h${mark}`, mark)).toBeNull();
    expect(readCapture(`${mark}=x\0PATH=/b\0HOME=/h\0${mark}`, mark)).toBeNull();
  });
});

function readdirFile(folder: string): string {
  const name = readdirSync(folder).find((entry) => entry.startsWith("owner-env."));
  if (!name) throw new Error("no stored map");
  return join(folder, name);
}

describe("the handed map (Rule 74a(3), 74c)", () => {
  it("writes every value pin last and deletes every absence pin, recording it as trusted absence", async () => {
    const owner = { env: { PATH: "/usr/bin", HOME: "/h", PAGER: "less", PYTHONINSPECT: "1", BASH_ENV: "/h/.bashrc", OPENAI_API_KEY: "x" }, capture: "session" as const };
    const handed = await handEnv(owner, { platform: "linux", run: noRun, strip: (env) => Object.fromEntries(Object.entries(env).filter(([name]) => !/KEY|SECRET|TOKEN/.test(name))) });
    for (const [name, value] of valuePins("linux")) expect(handed.env[name], name).toBe(value);
    for (const name of ABSENT_PINS) expect(name in handed.env, name).toBe(false);
    expect(handed.absent.sort()).toEqual([...ABSENT_PINS].sort());
    expect(handed.env.OPENAI_API_KEY).toBeUndefined();
    expect(handed.env.HOME).toBe("/h");
    expect(Object.keys(handed.env).some((name) => handed.absent.includes(name))).toBe(false);
  });
});

describe("the consistency check (Rule 74d)", () => {
  const handed = { env: { PATH: "/usr/bin:/bin", HOME: "/h", PAGER: "cat" }, absent: ["POSIXLY_CORRECT", "BASH_ENV"], capture: "session" as const, ownerStartup: {}, pins: new Map() };

  it("only removes: a changed, missing or new name becomes Unknown; an absent name the print holds leaves absent", () => {
    const printed = "PATH=/usr/bin:/bin\0HOME=/h\0PAGER=less\0POSIXLY_CORRECT=1\0NEW=1\0SHLVL=1\0\0/p\n";
    const result = compareCheck(handed, "/p", printed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/h" });
    expect(result.absent).toEqual(["BASH_ENV"]);
    expect(result.unknown.sort()).toEqual(["NEW", "PAGER", "POSIXLY_CORRECT"]);
    expect(result.cwdKnown).toBe(true);
    expect(compareCheck(handed, "/q", printed)).toMatchObject({ ok: false, reason: "cwd-disagreement" });
  });

  it.skipIf(!posixShell)("malformed output and a missing cwd stay U20", async () => {
    expect(compareCheck(handed, "/p", "garbage")).toMatchObject({ ok: false });
    const failed = await execEnvNow("s1", ["/bin/sh", "-c"], { ...handed, env: { ...handed.env, PATH: "/nonexistent" } }, "/nonexistent-dir");
    expect(failed).toMatchObject({ env: {}, absent: [], cwd: "/nonexistent-dir", unread: { code: "U20" } });
    expect(failed.unchecked).toBeUndefined();
  });

  it.skipIf(!posixShell)("runs the pinned form for real and keeps an untouched map", async () => {
    const real = { env: { PATH: "/usr/bin:/bin", HOME: dir, PAGER: "cat" }, absent: ["POSIXLY_CORRECT"], capture: "session" as const, ownerStartup: {}, pins: new Map() };
    const result = await execEnvNow("s2", ["/bin/sh", "-c"], real, dir);
    expect(result).toMatchObject({ cwd: dir, absent: ["POSIXLY_CORRECT"] });
    expect(result.env).toEqual(real.env);
  });

  it.skipIf(!posixShell)("never executes a shadow env earlier on the handed PATH", async () => {
    const marker = join(dir, "shadow-ran");
    writeFileSync(join(dir, "env"), `#!/bin/sh\nprintf ran > '${marker}'\nexit 1\n`, { mode: 0o755 });
    const real = { ...handed, env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, PAGER: "cat" } };
    const result = await execEnvNow("shadow-env", ["/bin/sh", "-c"], real, dir);
    expect(result.unread).toBeUndefined(); expect(result.unchecked).toBeUndefined();
    expect(result.env).toEqual(real.env);
    expect(existsSync(marker)).toBe(false);
  });
});

// Gap (c) of steps 1..3 (Rule 74a): an APPROVED write to a startup-file row re-captures before the next spawn
describe("re-capture after an approved startup-file write", () => {
  it.skipIf(!posixShell)("re-captures only when an ask naming a startup file is answered allow", async () => {
    const shell = fakeShell(`export PATH=/usr/bin:/bin; export HOME=${dir}; shift 3; exec /bin/sh -c "$1"`);
    setOwnerEnvStore(join(dir, "env"));
    expect((await captureOwnerEnv({ shell })).capture).toBe("session");
    await handEnv({ env: { PATH: "/usr/bin:/bin", HOME: dir }, capture: "session" }, { run: noRun });
    expect(askTouchesStartup({ toolCall: { name: "edit", input: { file_path: join(dir, ".zshrc") } } })).toBe(true);
    expect(askTouchesStartup({ toolCall: { name: "shell", input: { command: "echo export X=1 >> ~/.bash_profile", cwd: dir } } })).toBe(true);
    expect(askTouchesStartup({ toolCall: { name: "edit", input: { file_path: join(dir, "src", "app.ts") } } })).toBe(false);
    // a denied startup-file ask and an allowed ordinary ask leave the capture alone
    noteStartupFileEvent({ type: "request.opened", requestType: "permission", threadId: "t", requestId: "r1", toolCall: { name: "edit", input: { file_path: "~/.zprofile" } } } as never);
    expect(noteStartupFileEvent({ type: "request.resolved", threadId: "t", requestId: "r1", behavior: "deny" })).toBe(false);
    noteStartupFileEvent({ type: "request.opened", requestType: "permission", threadId: "t", requestId: "r2", toolCall: { name: "edit", input: { file_path: join(dir, "README.md") } } } as never);
    expect(noteStartupFileEvent({ type: "request.resolved", threadId: "t", requestId: "r2", behavior: "allow" })).toBe(false);
    expect(ownerEnvState()?.capture).toBe("session");
    // the allowed one asks for the re-capture: the next spawn captures again
    noteStartupFileEvent({ type: "request.opened", requestType: "permission", threadId: "t", requestId: "r3", filePaths: [join(dir, ".zshrc")] } as never);
    expect(noteStartupFileEvent({ type: "request.resolved", threadId: "t", requestId: "r3", behavior: "allow" })).toBe(true);
    // the capture in use is not marked kept (r3 (f)); the next capture runs the shell again
    writeFileSync(shell, `#!/bin/sh\nexport PATH=/usr/bin:/bin HOME=${dir} RECAPTURED=1; shift 3; exec /bin/sh -c "$1"\n`);
    expect(ownerEnvState()?.capture).not.toBe("kept");
    const again = await captureOwnerEnv({ shell });
    expect(again.capture).toBe("session");
    expect(again.env.RECAPTURED).toBe("1");
  });
});

// WIN-NOBASH-DESIGN-r2 3.5: the inherit path's F12 record is the hand with an informational provenance, never U20
describe("execEnvHanded with provenance (powershell-inherit)", () => {
  it("is a well-formed record with no unread, and its pins equal the Bash case's", () => {
    const env: Record<string, string> = { PATH: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\o" };
    for (const [name, value] of valuePins("win32")) env[name] = value;
    const handed: HandedEnv = { env, absent: [...ABSENT_PINS], capture: "session", ownerStartup: [], pins: [] } as unknown as HandedEnv;
    const provenance = { kind: "inherited" as const, cli: "2.1.305", adds: ["CLAUDECODE", "NO_COLOR"], unenforceable: ["POSIXLY_CORRECT", "GIT_SSH"] };
    const form = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"];
    const inherited = execEnvHanded(handed, "C:\\w", form, { provenance });
    expect(isExecEnv(inherited)).toBe(true);
    expect(inherited.unread).toBeUndefined();
    expect(inherited.provenance).toEqual(provenance);
    expect(inherited.env).toEqual(env);
    const bash = execEnvHanded(handed, "C:\\w", ["C:\\Program Files\\Git\\bin\\bash.exe", "-c"]);
    expect([...handedPinsOf(inherited, "win32")]).toEqual([...handedPinsOf(bash, "win32")]);
    // a malformed provenance is not trusted
    expect(isExecEnv({ ...inherited, provenance: { kind: "inherited", cli: 1, adds: [], unenforceable: [] } })).toBe(false);
    expect(isExecEnv({ ...inherited, managedEnv: ["PAGER"] })).toBe(true);
    expect(isExecEnv({ ...inherited, managedEnv: [1] })).toBe(false);
  });
});

describe("108 Windows framing and retry state", () => {
  const hand: HandedEnv = { env: { Path: "C:\\bin", NOTE: "ภาษาไทย ☕" }, absent: ["BASH_ENV"], capture: "session", ownerStartup: {}, pins: new Map() };
  const nonce = "a".repeat(32), cwd = "C:\\work space\\日本語";
  const envelope = (over: Record<string, unknown> = {}) => JSON.stringify({ version: 1, nonce, env: Object.entries(hand.env), provider: "FileSystem", cwd, processCwd: cwd, ...over });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); setExecEnvOriginReader(() => "other"); });
  it("reads Unicode, folds names, and only removes handed facts", () => {
    expect(comparePowerShellCheck(hand, cwd, envelope(), nonce)).toMatchObject({ ok: true, env: hand.env });
    expect(comparePowerShellCheck(hand, cwd, envelope({ env: [["PATH", "C:\\bin"], ["NOTE", "changed"], ["NEW", "x"], ["bash_env", "x"]] }), nonce)).toMatchObject({ ok: true, env: { Path: "C:\\bin" }, absent: [] });
  });
  it("rejects extra, truncated, wrong-version/nonce, aliases and provider/cwd disagreement", () => {
    for (const output of [envelope() + envelope(), "noise" + envelope(), envelope().slice(0, -1), envelope({ nonce: "wrong" }), envelope({ version: 2 }), envelope({ provider: "Registry" }), envelope({ processCwd: "C:\\elsewhere" }), envelope({ cwd: "HKLM:\\" }), envelope({ env: [["PATH", "one"], ["Path", "two"]] }), envelope({ env: [["X", 3]] })]) expect(comparePowerShellCheck(hand, cwd, output, nonce).ok).toBe(false);
    expect(comparePowerShellCheck({ ...hand, env: { Path: "one", PATH: "two" } }, cwd, envelope(), nonce).ok).toBe(false);
  });
  it("shares in-flight checks, removes failures, cools down 30/120 seconds and caches recovery", async () => {
    vi.useFakeTimers();
    let finish!: Parameters<typeof procs.execCli>[3];
    const run = vi.spyOn(procs, "execCli").mockImplementation((_file, _args, _opts, cb) => { finish = cb; });
    const form = [process.platform === "win32" ? "powershell.exe" : "/fixture/powershell.exe", "-NoProfile", "-Command"];
    const a = execEnvNow("retry", form, hand, cwd), b = execEnvNow("retry", form, hand, cwd);
    expect(run).toHaveBeenCalledTimes(1);
    finish(new Error("fixture"), "");
    expect(await a).toMatchObject({ env: {}, absent: [], unread: { code: "U20" } }); await b;
    await execEnvNow("retry", form, hand, cwd); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    const c = execEnvNow("retry", form, hand, cwd); finish(new Error("fixture"), ""); await c;
    await vi.advanceTimersByTimeAsync(119_999); await execEnvNow("retry", form, hand, cwd); expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const d = execEnvNow("retry", form, hand, cwd);
    const script = run.mock.calls.at(-1)![1].at(-1)!;
    finish(null, envelope({ nonce: script.match(/nonce='([a-f0-9]+)'/)![1] }));
    expect((await d).unread).toBeUndefined(); await execEnvNow("retry", form, hand, cwd); expect(run).toHaveBeenCalledTimes(3);
  });
  it("isolates origins, rejects throwing launches and reruns a changed generation", async () => {
    let origin = "routine"; setExecEnvOriginReader(() => origin);
    const form = [process.platform === "win32" ? "powershell.exe" : "/fixture/powershell.exe", "-NoProfile", "-Command"];
    const run = vi.spyOn(procs, "execCli").mockImplementation(() => { throw new Error("fixture launch"); });
    await execEnvNow("origin", form, hand, cwd); await execEnvNow("origin", form, hand, cwd);
    origin = "owner"; await execEnvNow("origin", form, hand, cwd); expect(run).toHaveBeenCalledTimes(2);
    invalidateEnvCapture("fixture reset");
    run.mockImplementation((_file, args, _opts, cb) => {
      if (run.mock.calls.length === 3) invalidateEnvCapture("fixture race");
      cb(null, envelope({ nonce: args.at(-1)!.match(/nonce='([a-f0-9]+)'/)![1] }));
    });
    expect((await execEnvNow("origin", form, hand, cwd)).unread).toBeUndefined(); expect(run).toHaveBeenCalledTimes(4);
  });
});

describe("108 E1 typed operational failures", () => {
  const hand: HandedEnv = { env: { HOME: "C:\\private-home", PAGER: "cat", PRIVATE_NAME: "private-value" }, absent: ["BASH_ENV"], capture: "session", ownerStartup: {}, pins: new Map() };
  const cwd = "C:\\work", form = [process.platform === "win32" ? "C:\\fixture\\pwsh.exe" : "/fixture/pwsh.exe", "-NoProfile", "-Command"];
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); setExecEnvBotReader(() => undefined); });
  it.each([
    ["launch-failed", "ENOENT"], ["launch-failed", "EACCES"], ["timeout", undefined],
  ] as const)("retains the handed map and cooldown reason for %s (%s), with one value-free log per window", async (reason, code) => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(100_000);
    setExecEnvBotReader(() => "fixture-bot");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const run = vi.spyOn(procs, "execCli").mockImplementation((_file, _args, _opts, cb) => {
      cb(Object.assign(new Error("private-value"), { code, killed: reason === "timeout" }), "");
    });
    const failed = await execEnvNow("e1", form, hand, cwd);
    const cooled = await execEnvNow("e1", form, hand, cwd);
    for (const record of [failed, cooled]) {
      expect(record).toMatchObject({ env: hand.env, absent: hand.absent, unchecked: { reason } });
      expect(record.unread).toBeUndefined(); expect(isExecEnv(record)).toBe(true);
      expect(envInfoOf(record).unchecked).toEqual({ reason });
      expect(JSON.stringify(envInfoOf(record))).not.toContain("private-value");
    }
    expect(run).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([[`approvals: environment unchecked bot=fixture-bot reason=${reason}`]]);
    vi.setSystemTime(130_000); await execEnvNow("e1", form, hand, cwd);
    expect(run).toHaveBeenCalledTimes(2); expect(log).toHaveBeenCalledTimes(2);
    vi.setSystemTime(249_999); await execEnvNow("e1", form, hand, cwd);
    expect(run).toHaveBeenCalledTimes(2); expect(log).toHaveBeenCalledTimes(2);
  });
  it.each(["cwd", "alias", "extra", "nonce", "version", "malformed", "cloud", "no-form", "unpinned"])("keeps %s failures and their cooldowns U20", async kind => {
    const run = vi.spyOn(procs, "execCli").mockImplementation((_file, args, _opts, cb) => {
      const nonce = args.at(-1)!.match(/nonce='([a-f0-9]+)'/)![1];
      const value = { version: 1, nonce, provider: "FileSystem", env: Object.entries(hand.env), cwd, processCwd: cwd,
        ...(kind === "cwd" ? { cwd: "C:\\elsewhere" } : {}),
        ...(kind === "alias" ? { env: [["PATH", "one"], ["Path", "two"]] } : {}),
        ...(kind === "extra" ? { extra: true } : {}), ...(kind === "nonce" ? { nonce: "wrong" } : {}),
        ...(kind === "version" ? { version: 2 } : {}),
      };
      cb(null, kind === "malformed" ? "invalid" : JSON.stringify(value));
    });
    if (kind === "cloud") vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const shell = kind === "no-form" ? [] : kind === "unpinned" ? [process.platform === "win32" ? "powershell.exe" : "/fixture/powershell.exe", "-Command"] : form;
    for (let i = 0; i < 2; i++) {
      const record = await execEnvNow("held", shell, hand, cwd);
      expect(record).toMatchObject({ env: {}, absent: [], unread: { code: "U20" } });
      expect(record.unchecked).toBeUndefined();
    }
    expect(run).toHaveBeenCalledTimes(["cloud", "no-form", "unpinned"].includes(kind) ? 0 : 1);
  });
  it("labels POSIX and Windows cwd disagreements and rejects unproven short names", () => {
    expect(compareCheck(hand, "/work", "HOME=/h\0\0/elsewhere\n")).toMatchObject({ ok: false, reason: "cwd-disagreement" });
    const value = { version: 1, nonce: "n", provider: "FileSystem", env: Object.entries(hand.env), cwd: "C:\\PROGRA~1", processCwd: "C:\\PROGRA~1" };
    expect(comparePowerShellCheck(hand, "C:\\Program Files", JSON.stringify(value), "n")).toMatchObject({ ok: false, reason: "cwd-disagreement" });
    for (const reason of ["did-not-finish", "cwd-disagreement", "overflow", "exit-or-stderr", "changed-while-checked", "unpinned-shell-path"]) {
      expect(isExecEnv({ ...execEnvHanded(hand, cwd, form), unchecked: { reason } })).toBe(false);
    }
  });
});
