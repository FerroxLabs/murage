// SPDX-License-Identifier: AGPL-3.0-or-later
// `shell: bash` steps resolve bash from PATH. A self-hosted Windows runner
// service whose PATH holds only Git\cmd failed the Git Bash wipe proof with
// "bash: command not found" before the step started. windows-ci-tools must
// expose the bash.exe next to that git.exe, and fail when there is none.
// Runs the real step body from action.yml in PowerShell against a fake Git tree.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const action = parse(readFileSync(join(root, ".github/actions/windows-ci-tools/action.yml"), "utf8"));
const step = action.runs.steps.find(s => s.name === "Expose Git Bash to bash steps");
const shell = process.env.MURAGE_TEST_PWSH || (process.platform === "win32" ? "powershell" : "pwsh");
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function run(gitDir, bashDir) {
  const base = mkdtempSync(join(tmpdir(), "win-ci-tools-"));
  dirs.push(base);
  const git = join(base, ...gitDir);
  mkdirSync(git, { recursive: true });
  writeFileSync(join(git, "git.exe"), "#!/bin/sh\n");
  chmodSync(join(git, "git.exe"), 0o755);
  if (bashDir) {
    mkdirSync(join(base, ...bashDir), { recursive: true });
    writeFileSync(join(base, ...bashDir, "bash.exe"), "");
  }
  const script = join(base, "step.ps1");
  writeFileSync(script, step.run);
  const githubPath = join(base, "github-path");
  writeFileSync(githubPath, "");
  const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `. '${script}'`], {
    env: { ...process.env, PATH: git + delimiter + process.env.PATH, GITHUB_PATH: githubPath },
    encoding: "utf8",
  });
  const lines = readFileSync(githubPath, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  return { status: result.status, lines, base, output: `${result.stdout}${result.stderr}` };
}

describe("windows-ci-tools exposes Git Bash", () => {
  it("has a step that does it", () => {
    expect(step?.run, "Expose Git Bash to bash steps").toBeTypeOf("string");
  });

  it("adds Git\\bin when the service PATH holds only Git\\cmd", () => {
    const r = run(["Git", "cmd"], ["Git", "bin"]);
    expect(r.status, r.output).toBe(0);
    expect(r.lines).toEqual([join(r.base, "Git", "bin")]);
  });

  it("finds Git\\bin from a git.exe under mingw64\\bin", () => {
    const r = run(["Git", "mingw64", "bin"], ["Git", "bin"]);
    expect(r.status, r.output).toBe(0);
    expect(r.lines).toEqual([join(r.base, "Git", "bin")]);
  });

  it("fails and writes nothing when no bash.exe ships with git", () => {
    const r = run(["Git", "cmd"], null);
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/Git Bash/);
    expect(r.lines).toEqual([]);
  });
});
