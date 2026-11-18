// X3 r5 section 5 with rev 3.2 sections 2-3 and Astra x3r532 notes (brief 5b):
// the session record, P1 commits, S2' unknown start, S3' overflow, K and P5.
// Every row runs prepareShellJudgement plus the full No-limits owner verdict.
import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import * as approve from "./auto-approve.ts";
import { autoVerdict, prepareShellJudgement, type CredentialGlobFs } from "./auto-approve.ts";
// read through the namespace, so the file also runs (red row by row) on a base without them
const K_CARD_RULE = (approve as Record<string, unknown>).K_CARD_RULE as string | undefined ?? "\0no K class";
const P5_CARD_PREFIX = (approve as Record<string, unknown>).P5_CARD_PREFIX as string | undefined ?? "\0no P5 class";
import * as sessions from "./shell-session-state.ts";
import { ShellSessionRegistry, type ShellSessionRecord } from "./shell-session-state.ts";
import type { RuntimeEvent } from "./contracts.ts";
const exitStatus = (sessions as Record<string, unknown>).shellExitStatus as ((event: RuntimeEvent) => number | undefined) | undefined
  ?? ((event: RuntimeEvent) => (event as { result?: { exitCode?: number } }).result?.exitCode);

const bot = { id: "x3", autoApprove: true, fullAccess: true, noLimits: true };
const HOME = "/home/u";
type Tree = Record<string, string[]>; // folder -> entries; a name ending in "/" is a folder

function baseTree(extra: Tree = {}): Tree {
  const tree: Tree = {
    "/": ["w/", "srv/", "home/", "a/", "b/"],
    "/w": ["README.md", "src/", "docs/", ...Array.from({ length: 40 }, (_, i) => `d${String(i + 1).padStart(2, "0")}/`)],
    "/w/src": ["a.ts"], "/w/docs": ["x.md"],
    "/srv": ["export/", "backup/"], "/srv/export": ["credentials.json", "src/"], "/srv/export/src": ["credentials.json"],
    "/srv/backup": [".ssh/"], "/srv/backup/.ssh": ["archive/"], "/srv/backup/.ssh/archive": ["README-key"],
    "/home": ["u/"], "/home/u": [".ssh/"], "/home/u/.ssh": ["id_rsa"],
    "/a": ["k/"], "/a/k": ["notes.txt"], "/b": ["k/"], "/b/k": ["id_rsa"],
    ...extra,
  };
  for (let i = 1; i <= 40; i++) tree[`/w/d${String(i).padStart(2, "0")}`] = ["README.md"];
  return tree;
}
const enoent = (path: string) => Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
function treeFs(tree: Tree): { fs: CredentialGlobFs; io: { realpath: number; opendir: number } } {
  const io = { realpath: 0, opendir: 0 };
  const isFile = (path: string) => (tree[posix.dirname(path)] ?? []).includes(posix.basename(path));
  return { io, fs: {
    realpath: async (path: string) => {
      io.realpath++;
      const n = posix.normalize(path).replace(/(.)\/$/, "$1");
      if (n in tree || isFile(n)) return n;
      throw enoent(n);
    },
    opendir: async (path: string) => {
      io.opendir++;
      const n = posix.normalize(path).replace(/(.)\/$/, "$1");
      const entries = tree[n];
      if (!entries) throw enoent(n);
      let at = 0;
      return {
        read: async () => {
          const entry = entries[at++];
          if (entry === undefined) return null;
          const dir = entry.endsWith("/");
          return { name: dir ? entry.slice(0, -1) : entry, isDirectory: () => dir, isSymbolicLink: () => false };
        },
        close: async () => {},
      };
    },
  } };
}

type Cls = "K" | "P5" | "W" | null;
class Rig {
  registry = new ShellSessionRegistry();
  record: ShellSessionRecord;
  counts = { K: 0, P5: 0, W: 0 };
  carded: string[] = [];
  n = 0;
  /** `driver`: whose completion event reports the exit status (r5:93). Only Codex does; a persistent driver never commits. */
  constructor(public tree: ReturnType<typeof treeFs>, cwd: string | undefined, public driver: "codex" | "claude" | "fuigo" = "codex") {
    this.registry.launch("g", { thread: "t", provider: "p" });
    this.registry.accept("g", "T", cwd);
    this.registry.started({ thread: "t", provider: "p", native: "n", incarnation: 1 }, "T");
    this.record = this.registry.select("t", "p", "T")!;
  }
  get state() { return this.record.state; }
  /** One call: judge on the record (or at `namedCwd`, the N4 per-call folder), publish, keep its replacement, then complete
   * with `exit` through the driver's completion event (undefined: no completion). */
  async call(command: string, exit?: number, namedCwd?: string): Promise<{ cards: boolean; cls: Cls; rule: string | null; id: string; proposed: boolean; local: string[] }> {
    const seq = this.registry.claim(this.record);
    const prepared = await prepareShellJudgement(command, this.registry.snapshot(this.record), { fs: this.tree.fs, home: HOME, ...(namedCwd ? { namedCwd, attributed: true } : {}) });
    expect(this.registry.publish(this.record, prepared.parent, seq)).toBe(true);
    const id = `q${++this.n}`;
    const proposed = prepared.replacement ? this.registry.propose(this.record, "T", id, prepared.replacement) : false;
    if (exit !== undefined) {
      const event = { type: "item.completed", itemType: "tool", ok: exit === 0, provider: this.driver, threadId: "t", eventId: id, createdAt: "", turnId: "T", itemId: id, result: { exitCode: exit } } as unknown as RuntimeEvent;
      this.registry.completeRequest("t", "p", "T", id, exitStatus(event));
    }
    const verdict = autoVerdict(bot, "Bash", command, {
      fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, commandText: command, globExpansionRule: prepared.rule,
      shellCwdPrepared: true, shellCwdByThread: new Map([["t", prepared.local]]), threadId: "t",
    });
    const cls: Cls = prepared.rule === K_CARD_RULE ? "K" : prepared.rule?.startsWith(P5_CARD_PREFIX) ? "P5" : prepared.rule ? "W" : null;
    if (cls) { this.counts[cls]++; this.carded.push(`${cls} ${command.slice(0, 40)} :: ${prepared.rule}`); }
    expect(verdict.approve, JSON.stringify(verdict)).not.toBeNull();
    return { cards: prepared.rule !== null, cls, rule: prepared.rule, id, proposed, local: [...prepared.local.targets.keys()] };
  }
  /** End every still-open request with a failing exit: its replacement is dropped, nothing commits. */
  closeOpen() {
    for (const key of [...this.record.replacements.keys()]) { const [turn, request] = JSON.parse(key) as [string, string]; this.registry.completeRequest("t", "p", turn, request, 1); }
  }
  expectUnknownEmpty() {
    expect(this.state.unknown).toBeTruthy();
    expect(this.state.capped).toBe(true);
    expect(this.state.targets.size).toBe(0);
    expect(this.state.pending ?? []).toEqual([]);
  }
}
const d = (i: number) => `/w/d${String(i).padStart(2, "0")}`;
/** Launch /w, then additive `cd /w/dNN; true` from `from`; the call that makes the 33rd place is asserted to overflow at once (5b). */
async function fillTo32ThenOverflow(rig: Rig, overflowCommand: string) {
  for (let i = 1; i <= 31; i++) {
    await rig.call(`cd ${d(i)}; true`, 1);
    expect(rig.state.unknown).toBeUndefined();
  }
  expect(rig.state.targets.size).toBe(32);
  await rig.call(overflowCommand, 1);
  rig.expectUnknownEmpty();
}

describe("X3 r5 rev 3.2 record rows", () => {
  it("T-S2 (MA1): a record with no recorded start is unknown; a relative glob cards P5", async () => {
    const rig = new Rig(treeFs(baseTree()), undefined);
    expect(rig.state.unknown).toBeTruthy();
    const io = rig.tree.io.opendir;
    const r = await rig.call("cat README*");
    expect(r.cards).toBe(true);
    expect(r.cls).toBe("P5");
    expect(rig.tree.io.opendir).toBe(io);
  });

  it("T-S2r (MA2): an absolute exit-0 commit clears unknown; the next relative glob is quiet", async () => {
    const rig = new Rig(treeFs(baseTree()), undefined);
    expect((await rig.call("cat README*")).cls).toBe("P5");
    const c = await rig.call("cd /w && true", 0);
    expect(c.proposed).toBe(true);
    expect([...rig.state.targets.keys()]).toEqual(["/w"]);
    expect(rig.state.unknown).toBeUndefined();
    const r = await rig.call("ls *.md");
    expect(r.cls).toBeNull();
    expect(r.cards).toBe(false);
  });

  it("T-S2r persistent twin: no exit status, no commit; the record stays unknown and `ls *.md` CARDS P5", async () => {
    const rig = new Rig(treeFs(baseTree()), undefined, "claude");
    await rig.call("cd /w && true", 0);
    expect(rig.state.unknown).toBeTruthy();
    expect((await rig.call("ls *.md")).cls).toBe("P5");
  });

  it("T-SP1 (floor path): persistent shell, spawn /w, `cd /srv/export; true` then `cat *.json` CARDS W", async () => {
    const rig = new Rig(treeFs(baseTree()), "/w");
    await rig.call("cd /srv/export; true", 0);
    expect([...rig.state.targets.keys()].sort()).toEqual(["/srv/export", "/w"]);
    const r = await rig.call("cat *.json");
    expect(r.cards).toBe(true);
    expect(r.cls).toBe("W");
  });

  it("T-SP2 (floor path): `cd \"$D\"` makes the record unknown; `ls *.md` CARDS P5", async () => {
    const rig = new Rig(treeFs(baseTree()), "/w");
    await rig.call('cd "$D"', 0);
    expect(rig.state.unknown).toBeTruthy();
    const r = await rig.call("ls *.md");
    expect(r.cards).toBe(true);
    expect(r.cls).toBe("P5");
  });

  it("T-S3 (MA3, MA4): the 33rd place overflows to unknown and empty; one K, then P5", async () => {
    const rig = new Rig(treeFs(baseTree()), "/w");
    await fillTo32ThenOverflow(rig, `cd ${d(32)}; true`);
    await rig.call("cd /srv/export; true", 1);
    // still unknown and capped; the absolute candidate is held additively (5b: emptiness is asserted at the overflowing call)
    expect(rig.state.unknown).toBeTruthy();
    expect(rig.state.capped).toBe(true);
    const k = await rig.call("ls *.md");
    expect(k.cards).toBe(true);
    expect(k.cls).toBe("K");
    const p5 = await rig.call("cat *.json");
    expect(p5.cards).toBe(true);
    expect(p5.cls).toBe("P5");
    expect(rig.counts, rig.carded.join("\n")).toEqual({ K: 1, P5: 1, W: 0 });
  });

  it("T-S3p (MP1): 33 ABSENT targets in one command overflow; `ls *.md` CARDS K", async () => {
    const rig = new Rig(treeFs(baseTree()), "/w");
    const cmd = Array.from({ length: 33 }, (_, i) => `cd /missing/p${String(i + 1).padStart(2, "0")}`).join("; ") + "; true";
    await rig.call(cmd, 0);
    rig.expectUnknownEmpty();
    const r = await rig.call("ls *.md");
    expect(r.cards).toBe(true);
    expect(r.cls).toBe("K");
  });

  it("T-S3p: 32 ABSENT targets stay pending (known record) and are dropped at the next call", async () => {
    const rig = new Rig(treeFs(baseTree()), "/w");
    const cmd = Array.from({ length: 32 }, (_, i) => `cd /missing/p${String(i + 1).padStart(2, "0")}`).join("; ") + "; true";
    await rig.call(cmd, 0);
    expect(rig.state.unknown).toBeUndefined();
    expect(rig.state.pending).toHaveLength(32);
    const r = await rig.call("ls *.md");
    expect(r.cards).toBe(false);
    expect(rig.state.pending ?? []).toEqual([]);
    expect([...rig.state.targets.keys()]).toEqual(["/w"]);
  });

  it("T-SCALE/T-S3p: the 17th open request keeps no replacement; its exit-0 completion adds nothing and clears nothing", async () => {
    const rig = new Rig(treeFs(baseTree()), undefined);
    const ids: string[] = [];
    for (let i = 0; i < 16; i++) { const r = await rig.call("cd /w && true"); expect(r.proposed).toBe(true); ids.push(r.id); }
    expect(rig.record.replacements.size).toBe(16);
    const seventeenth = await rig.call("cd /srv/export && true");
    expect(seventeenth.proposed).toBe(false);
    expect(rig.registry.completeRequest("t", "p", "T", seventeenth.id, 0)).toBe(false);
    expect(rig.state.unknown).toBeTruthy();
    // No completion of an overlapping request proves the execution order.
    expect(rig.registry.completeRequest("t", "p", "T", ids[0], 1)).toBe(false);
    expect(rig.state.unknown).toBeTruthy();
    expect(rig.registry.completeRequest("t", "p", "T", ids[1], 0)).toBe(true);
    expect(rig.state.unknown).toBeTruthy();
    rig.registry.complete("t", "p", "T");
    expect(rig.record.replacements.size).toBe(0);
  });

  it("T-S3r (MR1): an absolute commit recovers; a later 33rd place is a new episode with a second K", async () => {
    const rig = new Rig(treeFs(baseTree()), "/w");
    await fillTo32ThenOverflow(rig, `cd ${d(32)}; true`);
    expect((await rig.call("ls *.md")).cls).toBe("K");
    await rig.call("cd /w && true", 0);
    expect([...rig.state.targets.keys()]).toEqual(["/w"]);
    expect(rig.state.unknown).toBeUndefined();
    expect(rig.state.capped).toBeFalsy();
    const quiet = await rig.call("ls *.md");
    expect(quiet.cards).toBe(false);
    for (let i = 9; i <= 39; i++) { await rig.call(`cd ${d(i)}; true`, 1); expect(rig.state.unknown).toBeUndefined(); }
    await rig.call(`cd ${d(40)}; true`, 1);
    rig.expectUnknownEmpty();
    const k2 = await rig.call("ls *.md");
    expect(k2.cls).toBe("K");
    expect(rig.counts.K).toBe(2);
  });

  it("T-S3r persistent twin: a driver with no exit status never commits; the record stays unknown", async () => {
    const rig = new Rig(treeFs(baseTree()), "/w", "claude");
    await fillTo32ThenOverflow(rig, `cd ${d(32)}; true`);
    expect((await rig.call("ls *.md")).cls).toBe("K");
    await rig.call("cd /w && true", 0);
    expect(rig.state.unknown).toBeTruthy();
    expect(rig.state.capped).toBe(true);
    expect((await rig.call("ls *.md")).cls).toBe("P5");
  });

  it("T-S3r-rel (MA8): a relative commit while unknown keeps unknown; `cat *.json` CARDS P5", async () => {
    const rig = new Rig(treeFs(baseTree()), "/w");
    await fillTo32ThenOverflow(rig, "cd /srv/export; true");
    expect((await rig.call("ls *.md")).cls).toBe("K");
    await rig.call("cd /w; true");
    expect([...rig.state.targets.keys()]).toEqual(["/w"]);
    expect(rig.state.unknown).toBeTruthy();
    // the P1 prerequisites hold: `src` resolves to a non-empty candidate set
    const rel = await rig.call("cd src && true", 0);
    expect(rel.local).toContain("/w/src");
    expect(rig.state.unknown).toBeTruthy();
    expect(rig.state.capped).toBe(true);
    const r = await rig.call("cat *.json");
    expect(r.cards).toBe(true);
    expect(r.cls).toBe("P5");
  });

  it("T-S3r-rel S2' twin (MA8): unknown start, `cd /w; true`, `cd src && true` exit 0, `cat *.json` CARDS P5", async () => {
    const rig = new Rig(treeFs(baseTree()), undefined);
    await rig.call("cd /w; true");
    const rel = await rig.call("cd src && true", 0);
    expect(rel.local).toContain("/w/src");
    expect(rig.state.unknown).toBeTruthy();
    const r = await rig.call("cat *.json");
    expect(r.cards).toBe(true);
    expect(r.cls).toBe("P5");
  });

  it("T-S3rel (MR2): a relative commit in a known record keeps every resolved candidate", async () => {
    const rig = new Rig(treeFs(baseTree()), "/a");
    await rig.call("cd /b; true");
    expect([...rig.state.targets.keys()].sort()).toEqual(["/a", "/b"]);
    await rig.call("cd k && true", 0);
    // S-a: the commit is a union, so the old places stay: {/a, /b} ∪ {/a/k, /b/k}
    expect([...rig.state.targets.keys()].sort()).toEqual(["/a", "/a/k", "/b", "/b/k"]);
  });

  it("G-H1 (MS-a): a proven call's exit-0 commit unions; `cat *.json` still CARDS W at /srv/export", async () => {
    // Codex with the spawn binding off (the T-SP3 citation-missing configuration): calls 1 and 3 are judged on the record.
    const rig = new Rig(treeFs(baseTree()), "/w", "codex");
    await rig.call("cd /srv/export; true");
    expect([...rig.state.targets.keys()].sort()).toEqual(["/srv/export", "/w"]);
    const proven = await rig.call("cd /w && true", 0, "/w");
    expect(proven.proposed).toBe(true);
    expect([...rig.state.targets.keys()].sort()).toEqual(["/srv/export", "/w"]);
    const r = await rig.call("cat *.json");
    expect(r.cards).toBe(true);
    expect(r.cls).toBe("W");
  });

  it("G-H1 unit twin (MS-a): any synthetic exit-0 commit through the record API unions, never replaces", () => {
    const registry = new ShellSessionRegistry();
    registry.launch("g", { thread: "t", provider: "p" });
    registry.accept("g", "T", "/w");
    registry.started({ thread: "t", provider: "p", native: "n", incarnation: 1 }, "T");
    const record = registry.select("t", "p", "T")!;
    registry.publish(record, { targets: new Map([["/w", "launch"], ["/srv/export", "cd"]]) }, registry.claim(record));
    expect(registry.propose(record, "T", "r1", { targets: new Map([["/w", "committed"]]), install: true })).toBe(true);
    expect(registry.commit(record, "T", "r1", 0)).toBe(true);
    expect([...record.state.targets.keys()].sort()).toEqual(["/srv/export", "/w"]);
  });

  it("G-H2 (MS-b): an N4 per-call folder adds its place but keeps unknown; `cat *.json` CARDS P5", async () => {
    const rig = new Rig(treeFs(baseTree()), "/w", "fuigo");
    await rig.call('cd "$D"');
    expect(rig.state.unknown).toBeTruthy();
    await rig.call("true", 0, "/srv/export");
    expect(rig.state.unknown).toBeTruthy();
    expect([...rig.state.targets.keys()]).toContain("/srv/export");
    const r = await rig.call("cat *.json");
    expect(r.cards).toBe(true);
    expect(r.cls).toBe("P5");
  });

  it("G-Sb (MS-b2): an absolute exit-0 commit installs: old ∪ {/w}, unknown clear, `ls *.md` QUIET", async () => {
    const rig = new Rig(treeFs(baseTree()), undefined, "codex");
    await rig.call("cd /srv/export; true");
    expect(rig.state.unknown).toBeTruthy();
    await rig.call("cd /w && true", 0);
    expect([...rig.state.targets.keys()].sort()).toEqual(["/srv/export", "/w"]);
    expect(rig.state.unknown).toBeUndefined();
    const r = await rig.call("ls *.md");
    expect(r.cards).toBe(false);
    expect(r.cls).toBeNull();
  });

  // Waits on Builder C's witness judge (r5 section 1, x3-p2c after 0180fee7): the
  // pre-r5 expander does not witness /b/k/id_rsa. Unskip on the combined sha.
  it("T-S3rel (MR2) W: after the commit, `cat *` CARDS W at /b/k", async () => {
    const rig = new Rig(treeFs(baseTree()), "/a");
    await rig.call("cd /b; true");
    await rig.call("cd k && true", 0);
    const r = await rig.call("cat *");
    expect(r.cards).toBe(true);
    expect(r.cls).toBe("W");
  });

  it("T-S3rel: under unknown, `cd k && cat *` resolves every candidate of `k` and still CARDS P5", async () => {
    const rig = new Rig(treeFs(baseTree()), undefined);
    await rig.call("cd /a; true");
    await rig.call("cd /b; true");
    const r = await rig.call("cd k && cat *");
    expect(r.local).toEqual(expect.arrayContaining(["/a/k", "/b/k"]));
    expect(r.cls).toBe("P5");
  });
});

/** Per listed place, for a one-segment relative glob at a fixture place of
 * depth <= 2 (`/w`, `/w/dNN`): opendir lists the glob's one folder once; the
 * physical walk realpaths each path step (root, then at most 2 folders) and
 * each matched entry (one README.md). The bounds are per place, so total work
 * is bounded by places, never by history. */
const OPENDIR_PER_PLACE = 1, REALPATH_PER_PLACE = 3 + 1;

describe("X3 r5 F4 enumerator row (r5:161, kills M1)", () => {
  it("F4 (M1): `ls *` in {~/.aws} listing [config] is QUIET; the joined text ~/.aws/* alone never cards", async () => {
    const rig = new Rig(treeFs(baseTree({ "/home/u": [".ssh/", ".aws/"], "/home/u/.aws": ["config"] })), "/home/u/.aws");
    expect([...rig.state.targets.keys()]).toEqual(["/home/u/.aws"]);
    const listed = await rig.call("ls *");
    expect(listed.rule).toBeNull();
    expect(listed.cards).toBe(false);
    expect(rig.tree.io.opendir).toBeGreaterThan(0);
  });
});

describe("X3 r5 rev 3.2 T-SCALE (RELEASE GATE: work units, never timing)", () => {
  async function history(calls: number) {
    const tree = treeFs(baseTree());
    const rig = new Rig(tree, "/w");
    for (let i = 0; i < calls; i++) {
      const cmd = i % 2 === 0 ? `cd ${d((i / 2) % 40 + 1)}; true` : `cd /missing/p${i}; true`;
      await rig.call(cmd);
      expect(rig.state.targets.size).toBeLessThanOrEqual(32);
      expect((rig.state.pending ?? []).length).toBeLessThanOrEqual(32);
      expect(rig.record.replacements.size).toBeLessThanOrEqual(16);
    }
    return rig;
  }
  /** Recover to a known record through an absolute Codex commit (S-b: old places ∪ {/w}), then count one relative glob's work. */
  async function relativeGlobWork(rig: Rig) {
    rig.closeOpen();
    await rig.call("cd /w && true", 0);
    expect(rig.state.unknown).toBeUndefined();
    const places = rig.state.targets.size;
    expect(places).toBeGreaterThan(0);
    expect(places).toBeLessThanOrEqual(32);
    const before = { ...rig.tree.io };
    await rig.call("ls *.md");
    return { places, realpath: rig.tree.io.realpath - before.realpath, opendir: rig.tree.io.opendir - before.opendir };
  }

  it("MS-CAP-PLACES: 40 and 1,040 calls of history leave <= 32 places; a relative glob's work is the same and bounded per place", async () => {
    const short = await history(80), long = await history(2080);
    for (const rig of [short, long]) {
      // after the history, a relative glob in the record costs at most one listing per retained place
      const before = { ...rig.tree.io };
      await rig.call("ls *.md");
      const work = { realpath: rig.tree.io.realpath - before.realpath, opendir: rig.tree.io.opendir - before.opendir };
      // at most 32 listed places, plus at most 32 pending re-resolutions (one realpath each)
      expect(work.opendir).toBeLessThanOrEqual(32 * OPENDIR_PER_PLACE);
      expect(work.realpath).toBeLessThanOrEqual(32 * REALPATH_PER_PLACE + 32);
    }
    // a known record after either history: work is bounded per retained place (<= 32), never by history length
    for (const rig of [short, long]) {
      const work = await relativeGlobWork(rig);
      expect(work.opendir).toBeGreaterThan(0);
      expect(work.opendir).toBeLessThanOrEqual(work.places * OPENDIR_PER_PLACE);
      expect(work.realpath).toBeLessThanOrEqual(work.places * REALPATH_PER_PLACE);
    }
  });

  it("MS-CAP-PENDING: 33 simultaneous pending entries in one command never retain more than 32", async () => {
    const rig = new Rig(treeFs(baseTree()), "/w");
    await rig.call(Array.from({ length: 33 }, (_, i) => `cd /missing/q${i}`).join("; ") + "; true");
    expect((rig.state.pending ?? []).length).toBeLessThanOrEqual(32);
    const before = rig.tree.io.realpath;
    await rig.call("true");
    // the next call re-resolves at most 32 pending entries
    expect(rig.tree.io.realpath - before).toBeLessThanOrEqual(32);
  });

  it("uncapped twin: 20 places, `ls *.md` costs <= 20 listings", async () => {
    const rig = new Rig(treeFs(baseTree()), "/w");
    for (let i = 1; i < 20; i++) await rig.call(`cd ${d(i)}; true`);
    const before = { ...rig.tree.io };
    await rig.call("ls *.md");
    expect(rig.tree.io.opendir - before.opendir).toBeLessThanOrEqual(20 * OPENDIR_PER_PLACE);
    expect(rig.tree.io.realpath - before.realpath).toBeLessThanOrEqual(20 * REALPATH_PER_PLACE);
  });

  it("MS-IO: an unknown record that still holds a place makes 0 fs calls for a relative glob", async () => {
    const rig = new Rig(treeFs(baseTree()), undefined);
    await rig.call("cd /w; true");
    expect([...rig.state.targets.keys()]).toEqual(["/w"]);
    expect(rig.state.unknown).toBeTruthy();
    const before = { ...rig.tree.io };
    const r = await rig.call("ls *.md");
    expect(r.cls).toBe("P5");
    expect(rig.tree.io).toEqual(before);
  });
});
