// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Windows Git Bash for Claude (APP-GRANT-FIXPLAN-r6 (e)+(h), r3 (e)): the handed override when it is a real bash.exe, else from
// `git --exec-path` with the handed env; cached by generation, handed PATH and handed override, every hit re-stated.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { PinRun } from "../shared/arg-vocabulary.ts";
import { gitBashPath, resetToolDiscoveryForTests, type ToolIdentity } from "./tool-discovery.ts";

let files: Map<string, ToolIdentity>;
let runs: { args: string[]; path: string | undefined }[];
let execPath: string;

const deps = () => ({
  identify: (path: string) => files.get(path.toLowerCase()) ?? null,
  run: (async (_file, args, opts) => {
    runs.push({ args, path: opts.env.PATH });
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
    expect(await gitBashPath({ PATH: "C:\\Program Files\\Git\\cmd", CLAUDE_CODE_GIT_BASH_PATH: "E:\\Tools\\evil.cmd" }, 1, deps())).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(runs.at(-1)).toEqual({ args: ["--exec-path"], path: "C:\\Program Files\\Git\\cmd" });
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

  it("no bash: null, so the Claude turn is refused (Claude Code's own Windows requirement)", async () => {
    execPath = "";
    expect(await gitBashPath({ PATH: "C:\\nowhere" }, 1, deps())).toBeNull();
    files.delete("c:\\program files\\git\\bin\\bash.exe");
    execPath = "C:/Program Files/Git/mingw64/libexec/git-core";
    expect(await gitBashPath({ PATH: "C:\\Program Files\\Git\\cmd" }, 3, deps())).toBeNull();
  });

  it("reads no process.env (structural)", () => {
    const source = readFileSync(fileURLToPath(new URL("./tool-discovery.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/process\.env/);
  });
});
