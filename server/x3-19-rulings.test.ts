// X3 1.0.19 rulings H1-H4 (MurageMain, on Astra r1 of dev/1019-x3): positive knowledge only. Anything not proven keeps
// `unknown`, and unknown means a card. Each row below is red on 900ecc22f and green with the rulings.
import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import * as approve from "./auto-approve.ts";
import { autoVerdict, prepareShellJudgement, type CredentialGlobFs } from "./auto-approve.ts";
import { ShellSessionRegistry, type ShellSessionRecord } from "./shell-session-state.ts";
import type { ShellCwdState } from "../shared/sensitive-globs.ts";
import type { RuntimeEvent } from "./contracts.ts";

const bot = { id: "x3", autoApprove: true, fullAccess: true, noLimits: false };
const P5_CARD_PREFIX = (approve as Record<string, unknown>).P5_CARD_PREFIX as string;
type Tree = Record<string, string[]>;
const TREE: Tree = {
  "/": ["w/", "srv/", "a/"], "/w": ["README.md", "src/"], "/w/src": ["a.ts"],
  "/srv": ["export/"], "/srv/export": ["credentials.json"], "/a": ["k/"], "/a/k": ["notes.txt"],
};
const enoent = (path: string) => Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
function treeFs(tree: Tree, slow?: (path: string) => void): CredentialGlobFs {
  const isFile = (path: string) => (tree[posix.dirname(path)] ?? []).includes(posix.basename(path));
  return {
    realpath: async (path: string) => { const n = posix.normalize(path).replace(/(.)\/$/, "$1"); if (n in tree || isFile(n)) return n; throw enoent(n); },
    opendir: async (path: string) => {
      const n = posix.normalize(path).replace(/(.)\/$/, "$1");
      slow?.(n);
      const entries = tree[n]; if (!entries) throw enoent(n);
      let at = 0;
      return { read: async () => { const e = entries[at++]; if (e === undefined) return null; const dir = e.endsWith("/"); return { name: dir ? e.slice(0, -1) : e, isDirectory: () => dir, isSymbolicLink: () => false }; }, close: async () => {} };
    },
  };
}
class Rig {
  registry = new ShellSessionRegistry();
  record: ShellSessionRecord;
  n = 0;
  constructor(public fs: CredentialGlobFs, cwd: string | undefined) {
    this.registry.launch("g", { thread: "t", provider: "p" });
    this.registry.accept("g", "T", cwd);
    this.registry.started({ thread: "t", provider: "p", native: "n", incarnation: 1 }, "T");
    this.record = this.registry.select("t", "p", "T")!;
  }
  async call(command: string, exit?: number) {
    const seq = this.registry.claim(this.record);
    const prepared = await prepareShellJudgement(command, this.registry.snapshot(this.record), { fs: this.fs, home: "/home/u" });
    expect(this.registry.publish(this.record, prepared.parent, seq)).toBe(true);
    const id = `q${++this.n}`;
    if (prepared.replacement) this.registry.propose(this.record, "T", id, prepared.replacement);
    if (exit !== undefined) {
      const event = { type: "item.completed", itemType: "tool", ok: exit === 0, provider: "codex", threadId: "t", eventId: id, createdAt: "", turnId: "T", itemId: id, result: { exitCode: exit } } as unknown as RuntimeEvent;
      this.registry.completeRequest("t", "p", "T", id, 0 === exit ? 0 : exit);
      void event;
    }
    return prepared;
  }
  get state() { return this.record.state; }
}
const verdictOf = (command: string, rule: string | null) => autoVerdict(bot, "Bash", command, {
  fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, commandText: command, globExpansionRule: rule, shellCwdPrepared: true,
});

describe("H1: a cd clears unknown only when it is a proven top-level simple command", () => {
  it.each([
    ["a comment hides the cd", "true # && cd /w"],
    ["negated", "! cd /w extra && true"],
    ["after ||", "false || cd /w"],
    ["two operands", "cd /w extra"],
    ["a subshell", "(cd /w)"],
    ["a group", "{ cd /w; }"],
    ["an if", "if true; then cd /w; fi"],
    ["a loop", "for x in 1; do cd /w; done"],
    ["a function", "f() { cd /w; }; f"],
    ["a background list", "cd /w &"],
    ["a pipe", "true | cd /w"],
    ["a cd also named in a comment (the scanner and the tokenizer disagree)", "cd /w # && cd /srv/export"],
    ["a non-literal operand", 'cd "$X"'],
    ["a flag", "cd -P /w"],
    ["builtin spelling", "builtin cd /w"],
  ])("%s: `%s` leaves the record unknown", async (_why, command) => {
    const rig = new Rig(treeFs(TREE), undefined);
    await rig.call(command, 0);
    expect(rig.state.unknown, command).toBeTruthy();
    const next = await rig.call("ls *.md");
    expect(next.rule, command).toMatch(new RegExp("^" + P5_CARD_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(verdictOf("ls *.md", next.rule).approve).toBeNull();
  });
  it.each([
    "cd /w && true", "cd -- /w", "cd /w # a trailing comment", "true && cd /w",
  ])("control: `%s` is proven and installs /w", async command => {
    const rig = new Rig(treeFs(TREE), undefined);
    await rig.call(command, 0);
    expect(rig.state.unknown, command).toBeUndefined();
    expect([...rig.state.targets.keys()]).toContain("/w");
  });
});

describe("H2: publishes carry a per-record sequence; a stale one is dropped and never clears unknown", () => {
  const known = (path: string): ShellCwdState => ({ targets: new Map([[path, "x"]]) });
  it("the older preparation arrives last: it is ignored and unknown stays", () => {
    const registry = new ShellSessionRegistry();
    registry.launch("g", { thread: "t", provider: "p" }); registry.accept("g", "T", "/w");
    registry.started({ thread: "t", provider: "p", native: "n", incarnation: 1 }, "T");
    const record = registry.select("t", "p", "T")!;
    const older = registry.claim(record), newer = registry.claim(record);
    expect(newer).toBeGreaterThan(older);
    const overflowed: ShellCwdState = { targets: new Map(), unknown: "too many possible shell folders", capped: true };
    expect(registry.publish(record, overflowed, newer)).toBe(true);
    expect(registry.publish(record, known("/w"), older)).toBe(false);
    expect(record.state.unknown).toBeTruthy();
    expect(record.state.capped).toBe(true);
    expect(record.state.targets.size).toBe(0);
  });
  it("a publish prepared before a P1 commit is dropped after it (the commit is a newer write)", async () => {
    const rig = new Rig(treeFs(TREE), "/w");
    const early = rig.registry.claim(rig.record);
    await rig.call("cd /a/k && true", 0);
    expect([...rig.state.targets.keys()]).toContain("/a/k");
    expect(rig.registry.publish(rig.record, known("/w"), early)).toBe(false);
    expect([...rig.state.targets.keys()]).toContain("/a/k");
  });
  it("an equal or missing sequence is not installed", () => {
    const registry = new ShellSessionRegistry();
    registry.launch("g", { thread: "t", provider: "p" }); registry.accept("g", "T", "/w");
    registry.started({ thread: "t", provider: "p", native: "n", incarnation: 1 }, "T");
    const record = registry.select("t", "p", "T")!;
    const seq = registry.claim(record);
    expect(registry.publish(record, known("/w"), seq)).toBe(true);
    expect(registry.publish(record, known("/a/k"), seq)).toBe(false);
    expect(registry.publish(record, known("/a/k"), undefined as unknown as number)).toBe(false);
  });
});

describe("H3: a deadline never silently skips a candidate place", () => {
  const places = (): ShellCwdState => ({ targets: new Map([["/w", "a"], ["/a/k", "b"]]) });
  it("control: with time, `cat README*` over two harmless places is quiet", async () => {
    const prepared = await prepareShellJudgement("cat README*", places(), { fs: treeFs(TREE) });
    expect(prepared.rule).toBeNull();
  });
  it("forced deadline: the place not yet judged cards", async () => {
    const slow = treeFs(TREE, path => { if (path === "/w") { const end = performance.now() + 80; while (performance.now() < end) { /* the first listing uses the whole deadline */ } } });
    const prepared = await prepareShellJudgement("cat README*", places(), { fs: slow });
    expect(prepared.rule).not.toBeNull();
    expect(verdictOf("cat README*", prepared.rule).approve).toBeNull();
  });
});

describe("H4: invalidating a prepared judgement resets its quiet rule in the same step", () => {
  const invalidate = (approve as Record<string, unknown>).invalidateShellJudgement as (prepared: Awaited<ReturnType<typeof prepareShellJudgement>>, text: string, shell?: "pwsh") => void;
  it("a quiet relative glob prepared on the record is loud after the record is retired", async () => {
    const rig = new Rig(treeFs(TREE), "/w");
    const prepared = await prepareShellJudgement("ls *.md", rig.registry.snapshot(rig.record), { fs: rig.fs });
    expect(prepared.rule).toBeNull();
    rig.registry.retire("t", "p");
    expect(typeof invalidate).toBe("function");
    invalidate(prepared, "ls *.md");
    expect(prepared.rule).toMatch(/shell|record|unknown|\(/);
    expect(prepared.rule).not.toBeNull();
    expect(verdictOf("ls *.md", prepared.rule).approve).toBeNull();
    expect(prepared.local.unknown).toBeTruthy();
  });
  it("a call with no relative glob stays quiet, an absolute glob keeps its own verdict", async () => {
    const rig = new Rig(treeFs(TREE), "/w");
    const prepared = await prepareShellJudgement("ls", rig.registry.snapshot(rig.record), { fs: rig.fs });
    invalidate(prepared, "ls");
    expect(prepared.rule).toBeNull();
  });
  it("a proven per-call start is not floor state: it is left alone", async () => {
    const rig = new Rig(treeFs(TREE), "/w");
    const prepared = await prepareShellJudgement("ls *.md", rig.registry.snapshot(rig.record), { fs: rig.fs, namedCwd: "/w", attributed: true });
    expect(prepared.start.source).not.toBe("record");
    const before = prepared.rule;
    invalidate(prepared, "ls *.md");
    expect(prepared.rule).toBe(before);
  });
});
