// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r#7 (1.0.7): on Windows the engines run their commands under `powershell.exe -NoProfile [-NonInteractive] -Command`, and
// Rule 74d's check used to record every such command as U20, so Codex and Fuigo commands asked at Full access and No limits.
// The PowerShell form is now read from what it is, without starting PowerShell (murage-releases #1), and gets the verdicts a
// POSIX command whose check passed gets; every form, platform or name the reader cannot place stays U20 and keeps asking.

import { afterEach, describe, expect, it, vi } from "vitest";

const started: string[] = [];
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (...args: Parameters<typeof real.spawn>) => { started.push(String(args[0])); return real.spawn(...args); },
    execFile: (...args: Parameters<typeof real.execFile>) => { started.push(String(args[0])); return (real.execFile as (...a: unknown[]) => ReturnType<typeof real.execFile>)(...args); },
  };
});

import { ABSENT_PINS, valuePins } from "../shared/arg-vocabulary.ts";
import type { ExecEnv } from "../shared/mount-identity.ts";
import { autoVerdict, type AutoApprover, type AutoContext } from "./auto-approve.ts";
import { execEnvHanded, execEnvNow, handedPinsOf, readPowerShellForm, type HandedEnv } from "./engine-env.ts";

const ASK: AutoApprover = {};
const AUTO: AutoApprover = { autoApprove: true };
const FULL: AutoApprover = { autoApprove: true, fullAccess: true };
const NO_LIMITS: AutoApprover = { autoApprove: true, fullAccess: true, noLimits: true };
const LEVELS: Array<[string, AutoApprover]> = [["Ask", ASK], ["Auto", AUTO], ["Full access", FULL], ["No limits", NO_LIMITS]];
const CWD = "C:\\Users\\owner\\.murage\\workspaces\\bot-ember";
const CODEX_FORM = ["powershell.exe", "-NoProfile", "-Command"];
const FUIGO_FORM = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"];

function hand(extra: Record<string, string> = {}): HandedEnv {
  const env: Record<string, string> = { Path: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\owner", PSModulePath: "C:\\Program Files\\WindowsPowerShell\\Modules",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes", RSYNC_RSH: "ssh -o BatchMode=yes" };
  for (const [name, value] of valuePins("win32")) env[name] = value;
  return { env: { ...env, ...extra }, absent: [...ABSENT_PINS], capture: "session", ownerStartup: {}, pins: new Map() } as unknown as HandedEnv;
}

/** What index.ts builds for an engine command ask (handedPins, envUnread on a command card only). */
function contextFor(command: string, record: ExecEnv, engine: "codex" | "acp"): AutoContext {
  return {
    commandText: command, commandCwd: CWD,
    handedPins: handedPinsOf(record, "win32"),
    ...(record.unread ? { envUnread: record.unread.cause } : {}),
    call: { toolCall: { name: "shell", input: { command } }, engine, commandShell: "pwsh", ...(engine === "acp" ? { toolKind: "execute" } : {}) } as never,
  };
}

function asWindows<T>(run: () => Promise<T>): Promise<T> {
  const was = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  return run().finally(() => Object.defineProperty(process, "platform", was));
}

afterEach(() => { started.length = 0; });

describe("readPowerShellForm", () => {
  it.each([["Codex's form", CODEX_FORM], ["Fuigo's and Claude's form", FUIGO_FORM], ["pwsh, any case", ["C:\\Program Files\\PowerShell\\7\\PWSH.EXE", "-nologo", "-NOPROFILE", "-command"]]])(
    "reads %s: the hand as handed, PSModulePath removed", (_label, form) => {
      const handed = hand();
      const read = readPowerShellForm(form, handed, "win32");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      const { PSModulePath: _gone, ...rest } = handed.env;
      expect(read.env).toEqual(rest);
      expect(read.absent).toEqual(handed.absent);
      expect(read.unknown).toEqual(["PSModulePath"]);
    });

  it("removes PSExecutionPolicyPreference in any case, like PSModulePath", () => {
    const read = readPowerShellForm(CODEX_FORM, hand({ psexecutionpolicypreference: "Bypass" }), "win32");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.env.psexecutionpolicypreference).toBeUndefined();
    expect(read.env.USERPROFILE).toBe("C:\\Users\\owner");
    expect(read.unknown).toEqual(expect.arrayContaining(["PSModulePath", "psexecutionpolicypreference"]));
  });

  it("removes both names of a case twin, and an absence pin the hand holds under another case", () => {
    const read = readPowerShellForm(FUIGO_FORM, hand({ pager: "less", bash_env: "C:\\evil.sh" }), "win32");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.env.PAGER).toBeUndefined();
    expect(read.env.pager).toBeUndefined();
    expect(read.env.bash_env).toBeUndefined();
    expect(read.absent).not.toContain("BASH_ENV");
    expect(read.unknown).toEqual(expect.arrayContaining(["PAGER", "pager", "bash_env", "BASH_ENV"]));
    // the removed pin is no longer a pin of this record, so a command setting it is U19 (handedPinsOf)
    expect(handedPinsOf({ env: read.env, absent: read.absent, cwd: CWD, shell: FUIGO_FORM, capture: "session" }, "win32").has("PAGER")).toBe(false);
  });

  it.each([
    ["off Windows", CODEX_FORM, "linux"],
    ["without -NoProfile (the owner's profile runs)", ["powershell.exe", "-NonInteractive", "-Command"], "win32"],
    ["with -File", ["powershell.exe", "-NoProfile", "-File"], "win32"],
    ["with -EncodedCommand", ["powershell.exe", "-NoProfile", "-EncodedCommand"], "win32"],
    ["with -ExecutionPolicy", ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"], "win32"],
    ["with an abbreviated option", ["powershell.exe", "-nop", "-Command"], "win32"],
    ["with no -Command", ["powershell.exe", "-NoProfile"], "win32"],
    ["with nothing after the program", ["powershell.exe"], "win32"],
    ["with a program that is not PowerShell", ["cmd.exe", "-NoProfile", "-Command"], "win32"],
  ] as const)("cannot read a form %s: U20", (_label, form, platform) => {
    expect(readPowerShellForm(form, hand(), platform)).toMatchObject({ ok: false });
  });

  it.each([["a name holding =", { "A=B": "c" }], ["a value holding NUL", { X: "a\0b" }], ["an empty name", { "": "x" }]])(
    "cannot read a hand with %s: U20", (_label, extra) => {
      expect(readPowerShellForm(FUIGO_FORM, hand(extra), "win32")).toMatchObject({ ok: false });
    });
});

describe("execEnvNow on Windows: the PowerShell form is read, never started", () => {
  it("gives a checked record, starts no process, and keeps the pins", async () => {
    const record = await asWindows(() => execEnvNow("r7-s1", FUIGO_FORM, hand(), CWD));
    expect(started).toEqual([]);
    expect(record.unread).toBeUndefined();
    expect(record.env).toMatchObject({ PAGER: "cat", GIT_TERMINAL_PROMPT: "0" });
    expect(record.env.PSModulePath).toBeUndefined();
  });

  it("a form it cannot read is U20, still starting nothing", async () => {
    const record = await asWindows(() => execEnvNow("r7-s2", ["powershell.exe", "-Command"], hand(), CWD));
    expect(started).toEqual([]);
    expect(record).toMatchObject({ env: {}, absent: [], unread: { code: "U20" } });
  });
});

describe("Codex and Fuigo commands on Windows, four levels", () => {
  const read = (form: readonly string[]): ExecEnv => {
    const handed = hand();
    const check = readPowerShellForm(form, handed, "win32");
    if (!check.ok) throw new Error(check.why);
    return { ...execEnvHanded(handed, CWD, form), env: check.env, absent: check.absent };
  };
  const posix = (): ExecEnv => execEnvHanded(hand(), CWD, ["/bin/sh", "-c"]);

  it.each([["Codex", "codex", CODEX_FORM], ["Fuigo", "acp", FUIGO_FORM]] as const)("%s: a read record gets the verdict of a POSIX command whose check passed", (_label, engine, form) => {
    for (const command of ["Get-ChildItem outputs", "git status", "python report.py"]) {
      for (const [label, bot] of LEVELS) {
        const ps = autoVerdict(bot, "shell", command, contextFor(command, read(form), engine));
        const sh = autoVerdict(bot, "shell", command, contextFor(command, posix(), engine));
        expect(ps.source, `${label}: ${command}`).not.toBe("unread-call");
        expect(ps.approve === null, `${label}: ${command}`).toBe(sh.approve === null);
      }
    }
    for (const bot of [FULL, NO_LIMITS]) expect(autoVerdict(bot, "shell", "git status", contextFor("git status", read(form), engine)).approve).not.toBeNull();
  });

  it("a U20 record still holds at all four levels", () => {
    const unread: ExecEnv = { ...posix(), env: {}, absent: [], unread: { code: "U20", cause: "the PowerShell form runs the owner's profile" } };
    for (const [label, bot] of LEVELS) {
      expect(autoVerdict(bot, "shell", "git status", contextFor("git status", unread, "acp")), label).toMatchObject({ approve: null, source: "unread-call" });
    }
  });

  it("a command setting a pin the read removed is U19 at all four levels", () => {
    const handed = hand({ pager: "less" });
    const check = readPowerShellForm(FUIGO_FORM, handed, "win32");
    if (!check.ok) throw new Error(check.why);
    const record: ExecEnv = { ...execEnvHanded(handed, CWD, FUIGO_FORM), env: check.env, absent: check.absent };
    for (const [label, bot] of LEVELS) {
      expect(autoVerdict(bot, "shell", "$env:PAGER='less'; git log", contextFor("$env:PAGER='less'; git log", record, "acp")).approve, label).toBeNull();
    }
  });
});
