// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The disk-fact callback (Rule 75d), the pure rows of T102: every answer is
// checked against what git itself prints on a fixture git created.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diskFacts, readGitConfigText, repoConfigValues, type EnvStateLike } from "./disk-facts.ts";

let base: string;
let home: string;
let gitEnv: NodeJS.ProcessEnv;

/** What git prints for a folder, in the platform's own spelling: Git for Windows writes C:/x/y, which names the same folder as C:\x\y. */
const gitPath = (printed: string) => (process.platform === "win32" ? printed.replace(/\//g, "\\") : printed);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, env: gitEnv, encoding: "utf8" }).trim();

const plainEnv = (): EnvStateLike => new Map([["HOME", { kind: "inherited" as const }]]);

beforeEach(() => {
  // the native real path: on Windows an 8.3 short name (RUNNER~1) reads as its long name, as the disk facts place it
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "disk-facts-")));
  home = join(base, "home");
  mkdirSync(home);
  gitEnv = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const facts = () => diskFacts(new Map([["HOME", home]]), { systemConfig: join(base, "no-system-config") });
const toplevel = (cwd: string, env: EnvStateLike = plainEnv()) => facts().substitution({ name: "git", args: ["rev-parse", "--show-toplevel"] }, cwd, env);

describe("git rev-parse --show-toplevel in the plain state", () => {
  it("an initialized repository, from the top and from a subdirectory, with the bare = false git init writes", () => {
    const repo = join(base, "repo");
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    git(repo, "init", "-q");
    expect(toplevel(repo)).toBe(gitPath(git(repo, "rev-parse", "--show-toplevel")));
    expect(toplevel(join(repo, "src", "deep"))).toBe(gitPath(git(join(repo, "src", "deep"), "rev-parse", "--show-toplevel")));
  });

  it("a clone and a linked worktree of it", () => {
    const origin = join(base, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q");
    writeFileSync(join(origin, "a"), "a");
    git(origin, "add", "a");
    git(origin, "commit", "-qm", "a");
    git(base, "clone", "-q", origin, "clone");
    const clone = join(base, "clone");
    expect(toplevel(clone)).toBe(gitPath(git(clone, "rev-parse", "--show-toplevel")));
    git(clone, "worktree", "add", "-q", join(base, "wt"));
    const wt = join(base, "wt");
    expect(toplevel(wt)).toBe(gitPath(git(wt, "rev-parse", "--show-toplevel")));
    expect(toplevel(wt)).toBe(wt);
  });

  it("a bare repository, a worktree of one, core.bare true or malformed, core.worktree and an include are undefined", () => {
    git(base, "init", "-q", "--bare", "bare.git");
    expect(toplevel(join(base, "bare.git"))).toBeUndefined();

    const repo = join(base, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    appendFileSync(join(repo, ".git", "config"), "[core]\n\tbare = true\n");
    expect(toplevel(repo)).toBeUndefined();

    for (const extra of ["[core]\n\tbare = maybe\n", "[core]\n\tworktree = /elsewhere\n", "[include]\n\tpath = other\n", "[includeIf \"gitdir:/x\"]\n\tpath = other\n"]) {
      const r = join(base, `r${Math.random().toString(36).slice(2)}`);
      mkdirSync(r);
      git(r, "init", "-q");
      appendFileSync(join(r, ".git", "config"), extra);
      expect(toplevel(r), extra).toBeUndefined();
    }
  });

  it("a later false in the chain wins over an earlier true, in git's precedence", () => {
    const repo = join(base, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    writeFileSync(join(home, ".gitconfig"), "[core]\n\tbare = true\n");
    // the repository config (bare = false, written by git init) comes later
    expect(toplevel(repo)).toBe(repo);
  });

  it("any git discovery or config variable in the command's environment, or no HOME value, is undefined", () => {
    const repo = join(base, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    expect(toplevel(repo, new Map([["HOME", { kind: "inherited" }], ["GIT_DIR", { kind: "literal", value: "/x" }]]))).toBeUndefined();
    expect(toplevel(repo, new Map([["HOME", { kind: "inherited" }], ["GIT_DIR", { kind: "unknown", why: "x" }]]))).toBeUndefined();
    expect(toplevel(repo, new Map([["HOME", { kind: "inherited" }], ["XDG_CONFIG_HOME", { kind: "inherited" }]]))).toBeUndefined();
    expect(toplevel(repo, new Map([["HOME", { kind: "inherited" }], ["GIT_DIR", { kind: "unset" }]]))).toBe(repo);
    expect(toplevel(repo, new Map([["HOME", { kind: "unknown", why: "su" }]]))).toBeUndefined();
    expect(toplevel(repo, new Map())).toBeUndefined();
  });

  it("outside any repository is undefined", () => {
    const plain = join(base, "plain");
    mkdirSync(plain);
    expect(toplevel(plain)).toBeUndefined();
  });
});

describe("the rest of the table", () => {
  it("pwd, realpath, readlink -f, dirname and basename of one literal", () => {
    const f = facts();
    const env = plainEnv();
    mkdirSync(join(base, "d"));
    expect(f.substitution({ name: "pwd", args: [] }, base, env)).toBe(base);
    expect(f.substitution({ name: "pwd", args: ["-P"] }, base, env)).toBeUndefined();
    expect(f.substitution({ name: "realpath", args: ["d"] }, base, env)).toBe(join(base, "d"));
    expect(f.substitution({ name: "readlink", args: ["-f", "d"] }, base, env)).toBe(join(base, "d"));
    expect(f.substitution({ name: "readlink", args: ["d"] }, base, env)).toBeUndefined();
    expect(f.substitution({ name: "dirname", args: ["a/b/c"] }, base, env)).toBe("a/b");
    expect(f.substitution({ name: "basename", args: ["a/b/c"] }, base, env)).toBe("c");
    expect(f.substitution({ name: "basename", args: ["a", "b"] }, base, env)).toBeUndefined();
    expect(f.substitution({ name: "mktemp", args: ["-d"] }, base, env)).toBeUndefined();
    expect(f.substitution({ name: "date", args: [] }, base, env)).toBeUndefined();
  });

  // Astra BLOCK 3 (Rule 75d): realpath climbs from a link's target, never from the lexically collapsed path
  it("realpath and readlink -f of link/../x resolve the link before the climb", () => {
    const f = facts();
    const env = plainEnv();
    mkdirSync(join(base, "x", "y"), { recursive: true });
    mkdirSync(join(base, "x", "d2"));
    mkdirSync(join(base, "d2"));
    symlinkSync(join(base, "x", "y"), join(base, "l"));
    expect(f.substitution({ name: "realpath", args: ["l/../d2"] }, base, env)).toBe(join(base, "x", "d2"));
    expect(f.substitution({ name: "readlink", args: ["-f", "l/../d2"] }, base, env)).toBe(join(base, "x", "d2"));
  });

  it("the config reader reads git's boolean spellings and refuses what it cannot read", () => {
    expect(readGitConfigText("[core]\n\tbare\n")).toEqual({ ok: true, bare: true });
    expect(readGitConfigText("[core]\n\tbare = Off\n")).toEqual({ ok: true, bare: false });
    expect(readGitConfigText("[core]\n\tbare =\n")).toEqual({ ok: true, bare: false });
    expect(readGitConfigText("[core]\n\tbare = 2\n")).toEqual({ ok: true, bare: "bad" });
    expect(readGitConfigText("[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://x/y.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n")).toEqual({ ok: true, bare: false });
    expect(readGitConfigText("[core]\n\tpager = less \\\n -R\n")).toEqual({ ok: false });
    expect(readGitConfigText("garbage line here!\n")).toEqual({ ok: false });
  });

  // APP-GRANT-FIXPLAN-r6 (e)+(h) (b) "Per repository": the reader returns the last value of each key it is asked for
  it("the config reader returns the last value of each asked key, keyed section.name, over the same strict rules", () => {
    const keys = ["core.sshcommand", "commit.gpgsign", "tag.gpgsign", "tag.forcesignannotated"];
    expect(readGitConfigText("[core]\n\tsshCommand = ssh -i k\n\tSSHCOMMAND = \"ssh -p 2\"\n[commit]\n\tgpgSign\n[tag]\n\tgpgsign = false\n", keys)).toEqual({
      ok: true, bare: undefined, values: { "core.sshcommand": "ssh -p 2", "commit.gpgsign": true, "tag.gpgsign": "false" },
    });
    expect(readGitConfigText("[core]\n\tbare = false\n", keys)).toEqual({ ok: true, bare: false, values: {} });
    expect(readGitConfigText("[include]\n\tpath = x\n", keys)).toEqual({ ok: false });
  });

  it("a repository's chain gives what git config --get prints, the repository above the global file", () => {
    const repo = join(base, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    git(repo, "init", "-q");
    const keys = ["core.sshcommand", "commit.gpgsign"];
    const read = (cwd: string) => repoConfigValues(cwd, home, keys, { systemConfig: join(base, "no-system-config") });
    expect(read(repo)).toEqual({ ok: true, values: {} });
    writeFileSync(join(home, ".gitconfig"), "[core]\n\tsshCommand = ssh -i ~/.ssh/global\n");
    expect(read(join(repo, "src"))).toEqual({ ok: true, values: { "core.sshcommand": git(repo, "config", "--get", "core.sshCommand") } });
    git(repo, "config", "core.sshCommand", "ssh -i ~/.ssh/repo");
    git(repo, "config", "commit.gpgSign", "true");
    expect(read(repo)).toEqual({ ok: true, values: { "core.sshcommand": "ssh -i ~/.ssh/repo", "commit.gpgsign": "true" } });
    appendFileSync(join(repo, ".git", "config"), "[include]\n\tpath = other\n");
    expect(read(repo)).toEqual({ ok: false });
  });
});
