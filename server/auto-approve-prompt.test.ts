// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rule 68f, row kind "prompt-capable" (APP-GRANT-FIXPLAN-r6 (e)+(h) (c)): a command that can ask for input on a terminal,
// an askpass or a pinentry holds its card with its reason ahead of every standing answer, or runs when its non-interactive
// form is on the line. Each case is a line of the plan's test list.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvalKey, autoVerdict, exactAllowKeyFor, type AutoContext } from "./auto-approve.ts";
import { exactCommandKey } from "../shared/exact-command.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let base: string;
let home: string;
let repo: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], {
    cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8",
  }).trim();

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "prompt-guard-")));
  home = join(base, "home");
  repo = join(base, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  git(repo, "init", "-q");
});

afterEach(() => removeTempDirSync(base));

const facts = (extra: Partial<NonNullable<AutoContext["promptFacts"]>> = {}): AutoContext => ({
  promptFacts: { cwd: repo, home, systemConfig: join(base, "no-system-config"), ...extra },
});
const verdict = (grants: string[], command: string, context: AutoContext = facts()) =>
  autoVerdict({ alwaysAllow: grants }, "Bash", command, context);
const auto = (command: string, context: AutoContext = facts()) => autoVerdict({ autoApprove: true }, "Bash", command, context);

describe("prompt-capable rows hold ahead of every standing answer", () => {
  it("gpg's effective options are read left to right, and a wrapper is judged before what it wraps", () => {
    expect(verdict(["Bash:gpg"], "gpg --batch --pinentry-mode error --no-batch --pinentry-mode ask --sign f").source).toBe("prompt-guard");
    expect(auto("sudo unbuffer x").source).toBe("prompt-guard");
    expect(auto("sudo unbuffer x").rule).toBe("sudo");
  });

  it("a Bash:apt grant answers sudo -n apt, but not sudo apt", () => {
    expect(verdict(["Bash:apt"], "sudo apt install x")).toMatchObject({ approve: null, source: "prompt-guard", rule: "sudo" });
    expect(verdict(["Bash:apt"], "sudo apt install x").note).toMatch(/-n/);
    expect(approvalKey("Bash", "sudo apt install x")).toBeUndefined();
    expect(verdict(["Bash:apt"], "sudo -n apt install x").source).toBe("always-allow");
  });

  it("Bash:ssh-add answers ssh-add -l, and not ssh-add k", () => {
    expect(verdict(["Bash:ssh-add"], "ssh-add k")).toMatchObject({ approve: null, source: "prompt-guard", rule: "ssh-add" });
    expect(verdict(["Bash:ssh-add"], "ssh-add -l").source).toBe("always-allow");
  });

  it("Bash:gpg answers gpg with batch and pinentry-mode error, and not a plain gpg --sign", () => {
    expect(verdict(["Bash:gpg"], "gpg --sign f")).toMatchObject({ approve: null, source: "prompt-guard", rule: "gpg" });
    expect(verdict(["Bash:gpg"], "gpg --batch --pinentry-mode error --sign f").source).toBe("always-allow");
  });

  it("Bash:git does not answer git commit -S", () => {
    expect(verdict(["Bash:git"], "git commit -S -m x")).toMatchObject({ approve: null, source: "prompt-guard", rule: "git-signing" });
  });

  it("git commit reads the repository's configured signing, --no-gpg-sign pins it off, and an include holds", () => {
    expect(verdict(["Bash:git"], "git commit -m x").source).toBe("always-allow");
    git(repo, "config", "commit.gpgSign", "true");
    expect(verdict(["Bash:git"], "git commit -m x")).toMatchObject({ approve: null, source: "prompt-guard", rule: "git-signing" });
    expect(verdict(["Bash:git"], "git commit --no-gpg-sign -m x").source).toBe("always-allow");
    git(repo, "config", "commit.gpgSign", "false");
    expect(verdict(["Bash:git"], "git commit -m x").source).toBe("always-allow");
    appendFileSync(join(repo, ".git", "config"), "[include]\n\tpath = other\n");
    expect(verdict(["Bash:git"], "git commit -m x").source).toBe("prompt-guard");
  });

  it("git fetch in a repository with another core.sshCommand asks with its note, an equal one runs", () => {
    const ssh = { source: { setting: "core.sshCommand" as const, value: "ssh -i ~/.ssh/k" }, kept: true };
    git(repo, "config", "core.sshCommand", "ssh -i ~/.ssh/other");
    const held = verdict(["Bash:git"], "git fetch", facts({ ssh }));
    expect(held).toMatchObject({ approve: null, source: "prompt-guard", rule: "repo-ssh-command" });
    expect(held.note).toBe("this repository sets its own core.sshCommand, which engines do not use; they use ssh -i ~/.ssh/k");
    git(repo, "config", "core.sshCommand", "ssh -i ~/.ssh/k");
    expect(verdict(["Bash:git"], "git fetch", facts({ ssh })).source).toBe("always-allow");
  });

  it.each(["script -q /dev/null ssh h", "ssh -t h ls", "bash -c 'sudo x'"])("Auto mode asks for %j", (command) => {
    expect(auto(command)).toMatchObject({ approve: null, source: "prompt-guard" });
  });

  // a program named only by a variable cannot be read, so the always-ask
  // reader holds it first, ahead of the prompt guard
  it("Auto mode asks for $P x", () => {
    expect(auto("$P x")).toMatchObject({ approve: null, source: "always-ask" });
  });

  it("Auto mode asks for sudo x, and Full access is unchanged", () => {
    expect(auto("sudo x")).toMatchObject({ approve: null, source: "prompt-guard", rule: "sudo" });
    expect(autoVerdict({ autoApprove: true, fullAccess: true }, "Bash", "sudo x", facts()).source).toBe("full-access");
    expect(autoVerdict({ autoApprove: true, fullAccess: true, noLimits: true }, "Bash", "sudo x", facts()).source).toBe("no-limits");
  });

  it("an exact-command grant for sudo x does not answer it, and no exact grant is offered", () => {
    const exact = { engine: "claude", cwd: repo, command: "sudo x" };
    const key = exactCommandKey(exact)!;
    expect(autoVerdict({ alwaysAllow: [key] }, "Bash", "sudo x", { ...facts(), exactCommand: exact }).source).toBe("prompt-guard");
    expect(exactAllowKeyFor("Bash", "sudo x", exact)).toBeUndefined();
    expect(exactAllowKeyFor("Bash", "git status", { ...exact, command: "git status" })).toBeDefined();
  });

  it("the own-workspace and project-work-roots answers do not run a prompt-capable command", () => {
    expect(autoVerdict({}, "Bash", "sudo x", { ...facts(), ownWorkspace: true }).source).toBe("prompt-guard");
    expect(autoVerdict({}, "Bash", "sudo x", { ...facts(), projectWorkRoots: true }).source).toBe("prompt-guard");
  });

  it("an unattended turn keeps its own name, a routine grant does not answer", () => {
    expect(verdict(["Bash:ssh-add"], "ssh-add k", { ...facts(), unattended: true }).source).toBe("unattended-block");
    const exact = { engine: "claude", cwd: repo, command: "ssh-add k" };
    const key = exactCommandKey(exact)!;
    const routine = autoVerdict({ autoApprove: true }, "Bash", "ssh-add k", { ...facts(), exactCommand: exact, automated: true, routineLevel: true, routineAllow: [key] });
    expect(routine.source).toBe("prompt-guard");
  });
});
