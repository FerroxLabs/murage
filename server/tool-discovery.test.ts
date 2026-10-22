// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Windows Git Bash for Claude (APP-GRANT-FIXPLAN-r6 (e)+(h), r3 (e)): the handed override when it is a real bash.exe, else from
// `git --exec-path` with the handed env; cached by generation, handed PATH and handed override, every hit re-stated.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { PinRun } from "../shared/arg-vocabulary.ts";
import * as discovery from "./tool-discovery.ts";
import { gitBashPath, resetToolDiscoveryForTests, type ToolIdentity } from "./tool-discovery.ts";

let files: Map<string, ToolIdentity>;
let runs: { file: string; args: string[]; path: string | undefined }[];
let execPath: string;

const deps = () => ({
  identify: (path: string) => files.get(path.toLowerCase()) ?? null,
  run: (async (file, args, opts) => {
    runs.push({ file, args, path: opts.env.PATH });
    return execPath ? { ok: true, stdout: `${execPath}\n`, stderr: "" } : { ok: false, stdout: "", stderr: "" };
  }) as PinRun,
});

function file(path: string, ino: number): void {
  files.set(path.toLowerCase(), { real: path, dev: 1, ino, size: 100, mtimeMs: 1 });
}

beforeEach(() => {
  resetToolDiscoveryForTests();
  files = new Map();
  runs = [];
  execPath = "C:/Program Files/Git/mingw64/libexec/git-core";
  file("C:\\Program Files\\Git\\cmd\\git.exe", 10);
  file("C:\\Program Files\\Git\\bin\\bash.exe", 11);
  file("D:\\Git\\cmd\\git.exe", 20);
  file("D:\\Git\\bin\\bash.exe", 21);
  file("E:\\Tools\\bash.exe", 30);
});

describe("Git Bash discovery", () => {
  it("takes the handed CLAUDE_CODE_GIT_BASH_PATH when it is a real bash.exe, else asks git where it lives", async () => {
    expect(await gitBashPath({ PATH: "C:\\Program Files\\Git\\cmd", CLAUDE_CODE_GIT_BASH_PATH: "E:\\Tools\\bash.exe" }, 1, deps())).toBe("E:\\Tools\\bash.exe");
    expect(runs).toEqual([]);
    expect(await gitBashPath({ PATH: "C:\\Program Files\\Git\\cmd" }, 1, deps())).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    // the absolute git.exe the handed PATH names, never a bare `git`
    expect(runs.at(-1)).toEqual({ file: "C:\\Program Files\\Git\\cmd\\git.exe", args: ["--exec-path"], path: "C:\\Program Files\\Git\\cmd" });
  });

  it("different handed PATH or override give different discoveries", async () => {
    expect(await gitBashPath({ PATH: "C:\\Program Files\\Git\\cmd" }, 1, deps())).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    execPath = "D:/Git/mingw64/libexec/git-core";
    expect(await gitBashPath({ PATH: "D:\\Git\\cmd" }, 1, deps())).toBe("D:\\Git\\bin\\bash.exe");
    expect(await gitBashPath({ PATH: "D:\\Git\\cmd", CLAUDE_CODE_GIT_BASH_PATH: "E:\\Tools\\bash.exe" }, 1, deps())).toBe("E:\\Tools\\bash.exe");
    expect(runs.length).toBe(2);
  });

  it("a hit re-states git and bash: a replaced bash.exe (new inode) rediscovers; a new generation rediscovers", async () => {
    const env = { PATH: "C:\\Program Files\\Git\\cmd" };
    await gitBashPath(env, 1, deps());
    await gitBashPath(env, 1, deps());
    expect(runs.length).toBe(1);
    file("C:\\Program Files\\Git\\bin\\bash.exe", 99);
    expect(await gitBashPath(env, 1, deps())).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(runs.length).toBe(2);
    await gitBashPath(env, 2, deps());
    expect(runs.length).toBe(3);
  });

  it("no bash: null, so the Claude turn runs on the CLI's PowerShell tool (powershell-inherit)", async () => {
    execPath = "";
    files.delete("c:\\program files\\git\\bin\\bash.exe");
    expect(await gitBashPath({ PATH: "C:\\nowhere" }, 1, deps())).toBeNull();
    execPath = "C:/Program Files/Git/mingw64/libexec/git-core";
    expect(await gitBashPath({ PATH: "C:\\Program Files\\Git\\cmd" }, 3, deps())).toBeNull();
  });

  // WIN-NOBASH-DESIGN-r2 section 2 (Astra #5) and A2
  it("git absent from the handed PATH: no probe runs, and never a bare `git`", async () => {
    files.delete("c:\\program files\\git\\bin\\bash.exe");
    expect(await gitBashPath({ PATH: "C:\\Windows\\System32" }, 1, deps())).toBeNull();
    expect(runs).toEqual([]);
    await gitBashPath({ PATH: "C:\\Program Files\\Git\\cmd" }, 1, deps());
    expect(runs.every((run) => run.file !== "git")).toBe(true);
    expect(runs.length).toBe(1);
  });

  it("the CLI's fixed candidate is found with no git anywhere", async () => {
    execPath = "";
    expect(await gitBashPath({ PATH: "C:\\Windows\\System32" }, 1, deps())).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(runs).toEqual([]);
    expect(discovery.CLAUDE_GIT_BASH_CANDIDATES).toEqual(["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]);
    files.delete("c:\\program files\\git\\bin\\bash.exe");
    file("D:\\Apps\\Git\\bin\\bash.exe", 40);
    expect(await gitBashPath({ PATH: "C:\\Windows\\System32", ProgramFiles: "D:\\Apps" }, 2, deps())).toBe("D:\\Apps\\Git\\bin\\bash.exe");
    file("C:\\Users\\o\\AppData\\Local\\Programs\\Git\\bin\\bash.exe", 41);
    expect(await gitBashPath({ PATH: "C:\\Windows\\System32", LOCALAPPDATA: "C:\\Users\\o\\AppData\\Local" }, 2, deps())).toBe("C:\\Users\\o\\AppData\\Local\\Programs\\Git\\bin\\bash.exe");
  });

  it("an sh.exe (or any non-bash) override: null with reason override-not-bash", async () => {
    file("E:\\Tools\\sh.exe", 31);
    expect(await discovery.gitBashDiscovery({ PATH: "C:\\Program Files\\Git\\cmd", CLAUDE_CODE_GIT_BASH_PATH: "E:\\Tools\\sh.exe" }, 1, deps())).toEqual({ bash: null, reason: "override-not-bash" });
    expect(await discovery.gitBashDiscovery({ PATH: "C:\\Program Files\\Git\\cmd", CLAUDE_CODE_GIT_BASH_PATH: "E:\\Tools\\evil.cmd" }, 1, deps())).toEqual({ bash: null, reason: "override-not-bash" });
    files.delete("c:\\program files\\git\\bin\\bash.exe");
    execPath = "";
    expect(await discovery.gitBashDiscovery({ PATH: "C:\\nowhere" }, 1, deps())).toEqual({ bash: null, reason: "no-git-bash" });
  });

  it("a null result keeps every probed candidate: a Git installed later is found with the same key", async () => {
    execPath = "";
    files.delete("c:\\program files\\git\\bin\\bash.exe");
    const env = { PATH: "C:\\Windows\\System32" };
    expect(await gitBashPath(env, 1, deps())).toBeNull();
    expect(await gitBashPath(env, 1, deps())).toBeNull();
    file("C:\\Program Files (x86)\\Git\\bin\\bash.exe", 50);
    expect(await gitBashPath(env, 1, deps())).toBe("C:\\Program Files (x86)\\Git\\bin\\bash.exe");
  });

  it("A2: every directory variable a candidate is built from is in the cache key", async () => {
    execPath = "";
    files.delete("c:\\program files\\git\\bin\\bash.exe");
    file("F:\\PF\\Git\\bin\\bash.exe", 60);
    expect(await gitBashPath({ PATH: "C:\\Windows", ProgramFiles: "C:\\Nope" }, 1, deps())).toBeNull();
    expect(await gitBashPath({ PATH: "C:\\Windows", ProgramFiles: "F:\\PF" }, 1, deps())).toBe("F:\\PF\\Git\\bin\\bash.exe");
    file("G:\\X86\\Git\\bin\\bash.exe", 61);
    expect(await gitBashPath({ PATH: "C:\\Windows", "ProgramFiles(x86)": "G:\\X86" }, 1, deps())).toBe("G:\\X86\\Git\\bin\\bash.exe");
  });

  it("reads no process.env (structural)", () => {
    const source = readFileSync(fileURLToPath(new URL("./tool-discovery.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/process\.env/);
  });
});
