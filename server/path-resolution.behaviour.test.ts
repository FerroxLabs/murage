// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Path resolution on approval paths, by behaviour on a real POSIX tree
// (lanes/release103/APP-GRANT-FIXPLAN-r6.md section (b); Rules 63.2, 63.3,
// 67 and 75d of APP-GRANT-DESIGN-FINAL.AGREED-r10.md). Every case has a link
// inside the project pointing at a folder outside it, so `link/..` is the
// link target's parent and never the project: a lexical collapse reads the
// project, a resolution in order reads where the link points.
//
// The win32 rows are in shared/path-resolution.win32.test.ts.

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { diskFacts, type EnvStateLike } from "../shared/disk-facts.ts";
import { HookDecisionTable, routeDelivery } from "./drivers/codex-hook.ts";
import { classifyStopLine, type StopLinePlace } from "./stop-line.ts";
import * as stopLineState from "./stop-line-state.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let base: string;
let proj: string;
let outside: string;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "path-resolution-")));
  proj = join(base, "proj");
  outside = join(base, "outside");
  mkdirSync(proj);
  mkdirSync(outside);
  symlinkSync(outside, join(proj, "link"));
});

afterEach(() => removeTempDirSync(base));

describe("Rule 67: a file change is matched by where it really lands", () => {
  it("an allow for proj/x does not cover a started change naming link/../x, which lands beside the link's target", () => {
    const table = new HookDecisionTable();
    table.record({ toolUseId: "p1", turnId: "t1", decision: "allow", final: true, name: "apply_patch", destinations: [join(proj, "x")], cwd: proj });
    expect(table.match({ id: "p1", type: "fileChange", changes: [{ path: "link/../x" }] }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
    const fallback = new HookDecisionTable();
    fallback.record({ toolUseId: "p1", turnId: "t1", decision: "allow", final: true, name: "apply_patch", destinations: [join(proj, "x")], cwd: proj });
    expect(fallback.match({ id: "other", type: "fileChange", changes: [{ path: "link/../x" }] }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
    // the same change named plainly still matches
    const plain = new HookDecisionTable();
    plain.record({ toolUseId: "p1", turnId: "t1", decision: "allow", final: true, name: "apply_patch", destinations: [join(proj, "x")], cwd: proj });
    expect(plain.match({ id: "p1", type: "fileChange", changes: [{ path: "x" }] }, "t1")).toMatchObject({ ok: true });
  });

  it("the destinations an allow carries are stored real", () => {
    const patch = ["*** Begin Patch", "*** Add File: sub/../a.md", "+hi", "*** End Patch"].join("\n");
    mkdirSync(join(proj, "sub"));
    const route = routeDelivery({ tool_name: "apply_patch", tool_input: { command: patch }, tool_use_id: "u1", turn_id: "t1", cwd: proj }, { project: proj, home: base, mounts: [] });
    expect(route).toMatchObject({ route: "allow", destinations: [join(proj, "a.md")] });
  });
});

const git = (top: string, gitdirLine: string) => writeFileSync(join(top, ".git"), `gitdir: ${gitdirLine}\n`);

describe("a `.git` file's gitdir: is followed by the link, not collapsed", () => {
  beforeEach(() => {
    // proj/link -> outside, so link/../g is base/g; proj/g is the lexical decoy
    mkdirSync(join(base, "g"));
    mkdirSync(join(proj, "g"));
    writeFileSync(join(base, "g", "config"), "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://github.com/ada/real.git\n");
    writeFileSync(join(proj, "g", "config"), "[include]\n\tpath = other\n[remote \"origin\"]\n\turl = https://github.com/ada/lexical.git\n");
    git(proj, "link/../g");
  });

  it("disk facts: git rev-parse --show-toplevel reads the config the link leads to", () => {
    const home = join(base, "home");
    mkdirSync(home);
    const facts = diskFacts(new Map([["HOME", home]]), { systemConfig: join(base, "no-system-config") });
    const env: EnvStateLike = new Map([["HOME", { kind: "inherited" }]]);
    expect(facts.substitution({ name: "git", args: ["rev-parse", "--show-toplevel"] }, proj, env)).toBe(proj);
  });

  it("stop-line state: the repository a post goes to is the one the link leads to", () => {
    expect(stopLineState.githubRepoOf(proj)).toBe("ada/real");
  });
});

describe("Rule 75d: HOME is placed in order before the chain is read", () => {
  it("HOME=/h/link/.. reads the chain under the link target's parent", () => {
    const repo = join(base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "config"), "[core]\n\tbare = false\n");
    const target = join(base, "t", "sub");
    mkdirSync(target, { recursive: true });
    mkdirSync(join(base, "h"));
    symlinkSync(target, join(base, "h", "link"));
    // the real home is base/t: its .gitconfig has an include, so the chain is unresolved
    writeFileSync(join(base, "t", ".gitconfig"), "[include]\n\tpath = x\n");
    // written out, not joined: path.join would collapse the `..` before the link is read
    const facts = diskFacts(new Map([["HOME", `${base}/h/link/..`]]), { systemConfig: join(base, "no-system-config") });
    const env: EnvStateLike = new Map([["HOME", { kind: "inherited" }]]);
    expect(facts.substitution({ name: "git", args: ["rev-parse", "--show-toplevel"] }, repo, env)).toBeUndefined();
    // a HOME that does not resolve makes the fact undefined
    const gone = diskFacts(new Map([["HOME", join(base, "no-home")]]), { systemConfig: join(base, "no-system-config") });
    expect(gone.substitution({ name: "git", args: ["rev-parse", "--show-toplevel"] }, repo, env)).toBeUndefined();
  });

  it("an absent system config and an absent chain entry are still missing files, so the answer stands", () => {
    const repo = join(base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "config"), "[core]\n\tbare = false\n");
    const home = join(base, "home");
    mkdirSync(home);
    const facts = diskFacts(new Map([["HOME", home]]), { systemConfig: join(base, "absent", "gitconfig") });
    const env: EnvStateLike = new Map([["HOME", { kind: "inherited" }]]);
    expect(facts.substitution({ name: "git", args: ["rev-parse", "--show-toplevel"] }, repo, env)).toBe(repo);
  });

  it("realpath and readlink -f need every part to exist, and climb from a link's target", () => {
    const facts = diskFacts(new Map(), {});
    const env: EnvStateLike = new Map();
    writeFileSync(join(base, "x"), "x");
    expect(facts.substitution({ name: "realpath", args: ["nope"] }, proj, env)).toBeUndefined();
    expect(facts.substitution({ name: "realpath", args: ["gone/a/b"] }, proj, env)).toBeUndefined();
    expect(facts.substitution({ name: "readlink", args: ["-f", "gone/a/b"] }, proj, env)).toBeUndefined();
    expect(facts.substitution({ name: "realpath", args: ["link/../x"] }, proj, env)).toBe(join(base, "x"));
  });
});

describe("the stop line places every delete through its resolver", () => {
  const place = (extra: Partial<StopLinePlace> = {}): StopLinePlace => ({
    cwd: proj,
    roots: [proj],
    home: join(base, "home"),
    knownRecipients: new Set(),
    realpath: stopLineState.stopLineRealpath,
    ...extra,
  });
  const rm = (target: string, extra: Partial<StopLinePlace> = {}) => classifyStopLine("Bash", { command: `rm -rf ${target}` }, "", place(extra));

  it("link/../.ssh/id_ed25519 lands outside the folder and stops", () => {
    mkdirSync(join(proj, ".ssh"));
    writeFileSync(join(proj, ".ssh", "id_ed25519"), "k");
    expect(rm("link/../.ssh/id_ed25519")).toMatchObject({ kind: "delete" });
    // the same file named plainly is inside
    expect(rm(".ssh/id_ed25519")).toBeNull();
  });

  it("~/.ssh/../x stops", () => {
    mkdirSync(join(base, "home", ".ssh"), { recursive: true });
    expect(rm("~/.ssh/../x")).toMatchObject({ kind: "delete" });
  });

  it("a resolver that throws, answers null, or is missing makes the target a stop", () => {
    writeFileSync(join(proj, "a"), "a");
    expect(rm("a")).toBeNull();
    expect(rm("a", { realpath: () => { throw new Error("EACCES"); } })).toMatchObject({ kind: "delete" });
    expect(rm("a", { realpath: () => null } as Partial<StopLinePlace>)).toMatchObject({ kind: "delete" });
    const { realpath: _drop, ...noResolver } = place();
    expect(classifyStopLine("Bash", { command: "rm -rf a" }, "", noResolver as StopLinePlace)).toMatchObject({ kind: "delete" });
  });

  it("an unreadable root is dropped, so nothing under it counts as inside", () => {
    const gone = join(base, "gone");
    const roots = stopLineState.stopLineRoots([proj, gone]);
    expect(roots).toEqual([proj]);
    expect(rm(join(gone, "x"), { roots })).toMatchObject({ kind: "delete" });
  });

  it("the resolver resolves in order and keeps a missing tail; a climb past a missing part is null", () => {
    expect(stopLineState.stopLineRealpath(`${proj}/link/../y`)).toBe(join(base, "y"));
    expect(stopLineState.stopLineRealpath(join(proj, "new", "file"))).toBe(join(proj, "new", "file"));
    expect(stopLineState.stopLineRealpath(`${proj}/new/../file`)).toBeNull();
  });
});
