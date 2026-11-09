// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OUTSIDE-COMPACT part B (design R4): the journal is rewritten as its live state, but only behind the directory-sync probe (published "full"),
// or on Windows (P3). Rows C1, C2a-d, C3c, C5, D1, D2, D3/D3b, D6, D7, D10 (no-compaction half). The real fileOutsideStore and the real
// writeFileAtomic on temp paths; the seams only count calls, inject faults and model a power cut.
import { appendFileSync, copyFileSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteCount } from "./atomic.ts";
import * as marks from "./email/external-marks.ts";
import { fileOutsideStore, type OutsideStoreSeams } from "./outside-store.ts";

const dirs: string[] = [];
const newDir = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "ocpb-"))); dirs.push(dir); return dir; };
const newPath = () => join(newDir(), "s.jsonl");
beforeEach(() => marks.restartOutsideForTests());
afterEach(() => { marks.restartOutsideForTests(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const text = (...entries: unknown[]) => entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
const own = (key: string) => ({ k: "own", key });
const eio = () => Object.assign(new Error("EIO"), { code: "EIO" });
const SMALL = { floor: 1000 }; // seam thresholds: a few KB of dead lines is enough
const tmpsIn = (path: string) => readdirSync(join(path, "..")).filter((name) => name.endsWith(".tmp"));
const view = (path: string) => { const copy = join(newDir(), "v.jsonl"); copyFileSync(path, copy); return fileOutsideStore(copy, { dirSync: () => "synced" }).load(); };

/** Dead lines: every one of these `mark` rows is replaced by the next, so only the last one is live. */
const dead = (count: number, thread = "t-dead") => text(...Array.from({ length: count }, (_, i) => ({ k: "mark", row: { threadId: thread, source: "email", at: i + 1 } })));

/** The fixture of C1: since, own, registry, a mark, duplicate turn ids, legacy rows (no startedAt, no binding), a clean-on-disk session beside a
 * marked turn, mixed snapshot + edit lines, a sealed run and an unsealed `open` (a crashed run), then dead lines to cross the threshold. */
const rich = () => text(
  { k: "since", at: 100 },
  own("bot:a"), own("bot:b"), own("bot:a"),
  { k: "reg", add: [{ path: "/w/a", kind: "file", since: 1 }, { path: "/w/b", kind: "tree", since: 2, until: 9 }], drop: [] },
  { k: "reg", add: [{ path: "/w/c", kind: "span", since: 3 }], drop: [{ path: "/w/a", kind: "file", since: 1 }] },
  { k: "mark", row: { threadId: "t1", source: "web page", at: 7, turnId: "u1" } },
  { k: "mark", row: { threadId: "t2", source: "email", at: 8 } },
  { k: "clear", threadId: "t2" },
  { k: "turn", row: { threadId: "t1", instanceId: "i1", turnId: "u1", at: 7 } },
  { k: "turn", row: { threadId: "t1", instanceId: "i1", turnId: "u1", at: 99 } }, // a duplicate id: the first row wins
  { k: "turn", row: { threadId: "t1", instanceId: "i2", turnId: "u2", at: 9, begunAt: 5, sessionKey: "sk", gen: 1, birthRunId: "r0" } },
  { k: "session", row: { threadId: "t1", instanceId: "i9", tainted: false, wrote: false, edits: [], startedAt: 50 } },
  { k: "session", row: { threadId: "t1", instanceId: "i1", sessionKey: "sk2", gen: 2, birthRunId: "r1", tainted: false, wrote: true, edits: ["/a"] } },
  { k: "edit", threadId: "t1", instanceId: "i1", add: ["/b", "/a"] },
  { k: "edit", threadId: "t3", instanceId: "i3", add: ["/only-edit"] },
  { k: "open", runId: "run-sealed", threadId: "t1", instanceId: "i1", at: 11 },
  { k: "seal", runId: "run-sealed" },
  { k: "open", runId: "run-crashed", threadId: "t4", instanceId: "i4", at: 12, sessionKey: "sk4", gen: 1, birthRunId: "r4" },
  // an older unsealed BOUND open, then a newer session snapshot of the same key with other bindings: sessions must be written after opens
  { k: "open", runId: "run-old", threadId: "t5", instanceId: "i5", at: 13, sessionKey: "skA", gen: 1, birthRunId: "rA" },
  { k: "session", row: { threadId: "t5", instanceId: "i5", sessionKey: "skB", gen: 2, birthRunId: "rB", tainted: false, wrote: true, edits: ["/distinct"] } },
  { k: "edit", threadId: "t5", instanceId: "i5", add: ["/distinct-2"] },
) + dead(120);

/** A directory with a power-cut model. Every create or rename after the last SUCCESSFUL directory sync is reverted by `powerCut()`
 * (old bytes restored, or the file removed). On win32 a successful fsync of the renamed journal counts as that call (P3). */
function disk(path: string, over: { dirSync?: () => "synced" | "unsupported"; platform?: NodeJS.Platform; fsyncFail?: (afterRename: boolean) => boolean; rename?: (from: string, to: string, n: number) => void } = {}) {
  const events: string[] = [];
  const model = { durableExists: existsSync(path), renamed: false, oldBytes: undefined as Buffer | undefined };
  let renames = 0;
  const counts = { dirSync: 0, fsync: 0, rename: 0 };
  const sync = () => { model.durableExists = existsSync(path); model.renamed = false; model.oldBytes = undefined; };
  const seams: OutsideStoreSeams = {
    thresholds: SMALL,
    platform: over.platform,
    log: (message) => events.push(`log:${message}`),
    dirSync: () => { counts.dirSync++; events.push("dirSync"); const result = (over.dirSync ?? (() => "synced" as const))(); if (result === "synced") sync(); return result; },
    fsync: () => {
      counts.fsync++;
      if (over.fsyncFail?.(model.renamed)) { events.push("fsync-fail"); throw eio(); }
      events.push("fsync");
      if (over.platform === "win32" && model.renamed) sync();
    },
    rename: (from, to) => {
      counts.rename++; renames++;
      events.push("rename");
      if (over.rename) over.rename(from, to, renames);
      if (!model.renamed) { model.renamed = true; model.oldBytes = existsSync(to) ? readFileSync(to) : undefined; }
      renameSync(from, to);
    },
  };
  const powerCut = () => {
    if (model.renamed) { if (model.durableExists && model.oldBytes) writeFileSync(path, model.oldBytes); else rmSync(path, { force: true }); }
    else if (!model.durableExists) rmSync(path, { force: true });
    model.renamed = false; model.oldBytes = undefined; model.durableExists = existsSync(path);
  };
  return { seams, events, counts, powerCut, model };
}
const snapshotDir = (path: string) => {
  const from = join(path, ".."), to = newDir();
  for (const name of readdirSync(from)) copyFileSync(join(from, name), join(to, name));
  return join(to, "s.jsonl");
};
const THREADS = ["t1", "t2", "t3", "t4", "t5", "t-dead"];
const INSTANCES = ["i1", "i2", "i3", "i4", "i5", "i9"];
const stateOf = () => ({
  ready: marks.outsideReady(), since: marks.outsideSince(),
  marks: THREADS.map((t) => marks.turnOutsideMark(t)),
  turns: THREADS.map((t) => marks.markedTurnsOf(t)),
  tainted: THREADS.flatMap((t) => INSTANCES.map((i) => marks.sessionTainted(t, i))),
  edits: THREADS.flatMap((t) => INSTANCES.map((i) => [...marks.sessionEdits(t, i)].sort())),
  own: ["bot:a", "bot:b", "bot:zzz"].map((k) => marks.ownWritten(k)),
});


describe("C1 compaction keeps the whole live state", () => {
  it("C1 replay(compacted) deep-equals replay(original), and the external-marks state is equal, on boot 1 and boot 2", () => {
    const path = newPath();
    writeFileSync(path, rich());
    const original = view(path);
    // the control: the same file wired with no compaction (default thresholds, nothing near 4 MB)
    const control = newPath();
    writeFileSync(control, rich());
    expect(marks.wireOutsideStore(fileOutsideStore(control))).toBe(true);
    expect(atomicWriteCount(control)).toBe(0);
    const expected = stateOf();
    expect(expected.turns[3].length).toBe(1); // the crashed run's `#open` turn is there
    marks.restartOutsideForTests();
    const bytesBefore = statSync(path).size;
    expect(marks.wireOutsideStore(fileOutsideStore(path, disk(path).seams))).toBe(true);
    expect(atomicWriteCount(path)).toBe(1);
    expect(statSync(path).size).toBeLessThan(bytesBefore / 4);
    expect(stateOf()).toEqual(expected);
    const written = readFileSync(path, "utf8");
    expect(written.endsWith("\n")).toBe(true);
    expect(written).toContain('"k":"since","at":100');
    expect(written.split("\n").filter((line) => line.includes('"k":"reg"')).every((line) => line.includes('"drop":[]'))).toBe(true);
    expect(written).not.toContain("#open"); // no synthetic turn rows: only the rows as replayed
    expect(view(path)).toEqual(original);
    marks.restartOutsideForTests();
    // boot 2: nothing to rewrite, same state
    expect(marks.wireOutsideStore(fileOutsideStore(path, disk(path).seams))).toBe(true);
    expect(atomicWriteCount(path)).toBe(1);
    expect(stateOf()).toEqual(expected);
    expect(view(path)).toEqual(original);
    expect(fileOutsideStore(path).loadRegistry().sort((a, b) => a.path.localeCompare(b.path))).toEqual([{ path: "/w/b", kind: "tree", since: 2, until: 9 }, { path: "/w/c", kind: "span", since: 3 }]);
    expect(stateOf().edits.some((edits) => edits.includes("/distinct-2") && edits.includes("/distinct"))).toBe(true); // the newer snapshot of t5/i5 survived
  });
});

const liveTurns = (count: number) => text(...Array.from({ length: count }, (_, i) => ({ k: "turn", row: { threadId: `t${i % 50}`, instanceId: "i", turnId: `turn-${i}-${"x".repeat(150)}`, at: i + 1, sessionKey: "sk", gen: 1, birthRunId: "r" } })));

describe("C2 thresholds", () => {
  it("C2a a 60 MB dead-line file compacts to the live bound once; boot 2 does not rewrite", () => {
    const path = newPath();
    const chunk = dead(2000);
    const live = text({ k: "since", at: 5 }, own("bot:a"));
    writeFileSync(path, live);
    for (let written = 0; written < 60 * 1024 * 1024; written += chunk.length) appendFileSync(path, chunk);
    expect(statSync(path).size).toBeGreaterThan(60 * 1024 * 1024);
    const store = fileOutsideStore(path); // the REAL thresholds
    expect(store.load().ownWrites).toEqual(["bot:a"]);
    expect(atomicWriteCount(path)).toBe(1);
    expect(statSync(path).size).toBeLessThan(512);
    expect(fileOutsideStore(path).load().marks.length).toBe(1);
    expect(atomicWriteCount(path)).toBe(1);
  }, 120_000);
  it("C2b real thresholds: 5 MB live + 1 MB dead (serialized ~83%) is not rewritten on boot 1 or boot 2", () => {
    const path = newPath();
    writeFileSync(path, liveTurns(20000) + dead(15000));
    expect(statSync(path).size).toBeGreaterThan(4 * 1024 * 1024);
    fileOutsideStore(path).load();
    fileOutsideStore(path).load();
    expect(atomicWriteCount(path)).toBe(0);
  }, 120_000);
  it("C2c seam thresholds {floor 1 MB, big 8 MB}: 6 MB live + 4 MB dead (60% <= 75%) rewrites once; boot 2 does not", () => {
    const path = newPath();
    writeFileSync(path, liveTurns(24000) + dead(62000));
    expect(statSync(path).size).toBeGreaterThan(8 * 1024 * 1024);
    const seams = { thresholds: { floor: 1024 * 1024, big: 8 * 1024 * 1024 } };
    fileOutsideStore(path, seams).load();
    expect(atomicWriteCount(path)).toBe(1);
    fileOutsideStore(path, seams).load();
    expect(atomicWriteCount(path)).toBe(1);
  }, 120_000);
  it("C2d a 0.5 MB file that is 90% dead is under the floor: no rewrite", () => {
    const path = newPath();
    writeFileSync(path, text(own("bot:a")) + dead(8000));
    expect(statSync(path).size).toBeGreaterThan(400 * 1024);
    expect(statSync(path).size).toBeLessThan(4 * 1024 * 1024);
    fileOutsideStore(path).load();
    expect(atomicWriteCount(path)).toBe(0);
  });
});

describe("C3c / C5 the stat guard and the cost after compaction", () => {
  it("C3c a foreign append before stat #2: compaction is skipped and the line survives", () => {
    const path = newPath();
    writeFileSync(path, rich());
    let calls = 0;
    const real = (target: string) => { const s = statSync(target); return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino }; };
    const stat = (target: string) => { calls++; if (calls === 2) appendFileSync(target, text(own("bot:foreign"))); return real(target); };
    expect(marks.wireOutsideStore(fileOutsideStore(path, { ...disk(path).seams, stat }))).toBe(true);
    expect(calls).toBe(2);
    expect(atomicWriteCount(path)).toBe(0);
    expect(readFileSync(path, "utf8")).toContain('"key":"bot:foreign"');
    expect(marks.ownWritten("bot:foreign")).toBe(false); // not part of this boot's state, but on disk for the next one
    marks.restartOutsideForTests();
    expect(marks.wireOutsideStore(fileOutsideStore(path))).toBe(true);
    expect(marks.ownWritten("bot:foreign")).toBe(true);
  });
  it("C5 the load of a 60 MB history is under a second once it has been compacted", () => {
    const path = newPath();
    const chunk = dead(2000);
    writeFileSync(path, text({ k: "since", at: 5 }));
    for (let written = 0; written < 60 * 1024 * 1024; written += chunk.length) appendFileSync(path, chunk);
    fileOutsideStore(path).load(); // boot 1 compacts
    expect(atomicWriteCount(path)).toBe(1);
    const started = performance.now();
    expect(marks.wireOutsideStore(fileOutsideStore(path))).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  }, 120_000);
});

const bootsReady = (path: string) => { marks.restartOutsideForTests(); return marks.wireOutsideStore(fileOutsideStore(path)); };

describe("D1 a crash at each step of the compaction recovers to fold(original)", () => {
  it("D1 after S1 (stat #1), S2 (stat #2), S3 (tmp written, not renamed) and S4 (renamed, nothing durable), and on both power-cut outcomes of S4", () => {
    const path = newPath();
    writeFileSync(path, rich());
    const original = view(path);
    const originalBytes = readFileSync(path);
    const snaps: Record<string, string> = {};
    let statCalls = 0;
    const stat = (target: string) => { statCalls++; if (statCalls <= 2) snaps[`S${statCalls}`] = snapshotDir(path); const s = statSync(target); return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino }; };
    const d = disk(path, {
      rename: () => { snaps.S3 = snapshotDir(path); },
      fsyncFail: (afterRename) => { if (afterRename && !snaps.S4) snaps.S4 = snapshotDir(path); return false; },
    });
    expect(marks.wireOutsideStore(fileOutsideStore(path, { ...d.seams, stat }))).toBe(true);
    expect(atomicWriteCount(path)).toBe(1);
    expect(Object.keys(snaps).sort()).toEqual(["S1", "S2", "S3", "S4"]);
    expect(readdirSync(join(snaps.S3, "..")).some((name) => name.endsWith(".tmp"))).toBe(true); // the dead tmp of a crash before the rename
    for (const [name, snap] of Object.entries(snaps)) {
      expect(bootsReady(snap), name).toBe(true);
      expect(view(snap), name).toEqual(original);
    }
    // S4, power cut brings back the OLD directory entry: the old inode holds fold-equal state
    const rolledBack = snapshotDir(snaps.S4);
    writeFileSync(rolledBack, originalBytes);
    expect(bootsReady(rolledBack)).toBe(true);
    expect(view(rolledBack)).toEqual(original);
  });
});

describe("D2 a failure before the rename keeps the old file and never latches", () => {
  const cases: [string, (over: Parameters<typeof disk>[1], seams: OutsideStoreSeams) => OutsideStoreSeams][] = [
    ["the tmp cannot be opened, written or fsynced (writeAtomic throws)", (_over, seams) => ({ ...seams, writeAtomic: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } })],
    ["the rename throws (the real writeFileAtomic unlinks its tmp)", (_over, seams) => ({ ...seams, rename: () => { throw eio(); } })],
  ];
  for (const [title, shape] of cases) {
    it(`D2 ${title}: original bytes, ready, no tmp, not latched, and a later own write and seal work`, () => {
      const path = newPath();
      writeFileSync(path, rich());
      const original = readFileSync(path);
      const d = disk(path);
      expect(marks.wireOutsideStore(fileOutsideStore(path, shape({}, d.seams)))).toBe(true);
      expect(marks.outsideReady()).toBe(true);
      expect(readFileSync(path).equals(original)).toBe(true);
      expect(tmpsIn(path)).toEqual([]);
      expect(atomicWriteCount(path)).toBe(0);
      expect(d.events.filter((event) => event.startsWith("log:journal rewrite failed")).length).toBe(1);
      expect(marks.ownWrite("bot:later")).toBe(true);
      marks.sealOutsideStore();
      expect(bootsReady(path)).toBe(true);
      expect(marks.ownWritten("bot:later")).toBe(true);
    });
  }
});

describe("D3 restart after the latch", () => {
  const compactedWith = (path: string, failing: { on: boolean; n: number }) => disk(path, { dirSync: () => { if (failing.on && failing.n++ >= 1) throw eio(); return "synced"; } });
  it("D3 boot 1 compacts and the directory sync fails twice: latched, file == compacted text. App-only restart: the barrier runs, an own write is durable across a power cut", () => {
    const path = newPath();
    writeFileSync(path, rich());
    const original = view(path);
    const failing = { on: true, n: 0 };
    const d = compactedWith(path, failing);
    expect(marks.wireOutsideStore(fileOutsideStore(path, d.seams))).toBe(false);
    expect(marks.outsideReady()).toBe(false);
    expect(marks.ownWrite("bot:x")).toBe(false);
    expect(atomicWriteCount(path)).toBe(1);
    const compacted = readFileSync(path, "utf8");
    expect(compacted.split("\n").filter((line) => line.includes("t-dead")).length).toBe(1);
    expect(view(path)).toEqual(original);
    // boot 2: a fresh module state and a new store; the file is below the threshold (no compaction), the sync now works
    failing.on = false;
    marks.restartOutsideForTests();
    const syncsBefore = d.counts.dirSync;
    expect(marks.wireOutsideStore(fileOutsideStore(path, d.seams))).toBe(true);
    expect(d.counts.dirSync - syncsBefore).toBe(1); // the barrier ran although nothing was compacted
    expect(atomicWriteCount(path)).toBe(1);
    expect(marks.ownWrite("bot:x")).toBe(true);
    d.powerCut();
    expect(bootsReady(path)).toBe(true);
    expect(marks.ownWritten("bot:x")).toBe(true);
    expect(readFileSync(path, "utf8").startsWith(compacted)).toBe(true);
  });
  it("D3b the sync still fails on boot 2: not ready, no byte appended; after a power cut boot 3 is ready and equals fold(original)", () => {
    const path = newPath();
    writeFileSync(path, rich());
    const original = view(path);
    const failing = { on: true, n: 0 };
    const d = compactedWith(path, failing);
    expect(marks.wireOutsideStore(fileOutsideStore(path, d.seams))).toBe(false);
    const compacted = readFileSync(path);
    marks.restartOutsideForTests();
    expect(marks.wireOutsideStore(fileOutsideStore(path, d.seams))).toBe(false);
    expect(marks.ownWrite("bot:x")).toBe(false);
    expect(readFileSync(path).equals(compacted)).toBe(true);
    d.powerCut();
    expect(bootsReady(path)).toBe(true);
    expect(view(path)).toEqual(original);
    expect(marks.ownWritten("bot:x")).toBe(false);
  });
});

describe("D6 two wires in one process, both compacting", () => {
  it("D6 two barriers per wire (#1 and #2); an acknowledged own write into the new inode survives a power cut", () => {
    const path = newPath();
    writeFileSync(path, rich());
    const d = disk(path);
    expect(marks.wireOutsideStore(fileOutsideStore(path, d.seams))).toBe(true);
    expect(d.counts.dirSync).toBe(2);
    expect(marks.ownWrite("bot:y")).toBe(true);
    appendFileSync(path, dead(200)); // history grows again between the wires
    marks.restartOutsideForTests();
    expect(marks.wireOutsideStore(fileOutsideStore(path, d.seams))).toBe(true);
    expect(d.counts.dirSync).toBe(4);
    expect(atomicWriteCount(path)).toBe(2);
    expect(marks.ownWrite("bot:z")).toBe(true);
    d.powerCut();
    expect(bootsReady(path)).toBe(true);
    expect(marks.ownWritten("bot:y")).toBe(true);
    expect(marks.ownWritten("bot:z")).toBe(true);
  });
});

describe("D7 Windows (this row tests our model of the P3 reliance, not the OS)", () => {
  const eperm = () => Object.assign(new Error("EPERM"), { code: "EPERM" });
  it("D7 EPERM x2 then ok: compacted, with barrier #2's fsync right after the rename; an own write after it survives a power cut", () => {
    const path = newPath();
    writeFileSync(path, rich());
    const original = view(path);
    const d = disk(path, { platform: "win32", dirSync: () => "unsupported", rename: (_from, _to, n) => { if (n <= 2) throw eperm(); } });
    expect(marks.wireOutsideStore(fileOutsideStore(path, d.seams))).toBe(true);
    expect(d.counts.rename).toBe(3);
    expect(atomicWriteCount(path)).toBe(1);
    expect(d.events.slice(d.events.lastIndexOf("rename") + 1)[0]).toBe("fsync");
    expect(marks.ownWrite("bot:w")).toBe(true);
    d.powerCut();
    expect(bootsReady(path)).toBe(true);
    expect(marks.ownWritten("bot:w")).toBe(true);
    expect(view(path).marks).toEqual(original.marks);
  });
  it("D7b EPERM x6: the old file is kept, no tmp, ready", () => {
    const path = newPath();
    writeFileSync(path, rich());
    const original = readFileSync(path);
    const d = disk(path, { platform: "win32", dirSync: () => "unsupported", rename: () => { throw eperm(); } });
    expect(marks.wireOutsideStore(fileOutsideStore(path, d.seams))).toBe(true);
    expect(d.counts.rename).toBe(6);
    expect(readFileSync(path).equals(original)).toBe(true);
    expect(tmpsIn(path)).toEqual([]);
    expect(atomicWriteCount(path)).toBe(0);
  });
  it("D7c the journal fsync fails twice after the rename: not ready", () => {
    const path = newPath();
    writeFileSync(path, rich());
    const d = disk(path, { platform: "win32", dirSync: () => "unsupported", fsyncFail: (afterRename) => afterRename });
    expect(marks.wireOutsideStore(fileOutsideStore(path, d.seams))).toBe(false);
    expect(marks.outsideReady()).toBe(false);
  });
});

describe("D10 a POSIX filesystem with no directory sync is append-only", () => {
  it("D10 no writeAtomic call, ready, state equal, one log line per boot, and appends work", () => {
    const path = newPath();
    writeFileSync(path, rich());
    const original = readFileSync(path);
    const view0 = view(path);
    let writes = 0;
    const d = disk(path, { platform: "linux", dirSync: () => "unsupported" });
    const store = fileOutsideStore(path, { ...d.seams, writeAtomic: () => { writes++; } });
    expect(marks.wireOutsideStore(store)).toBe(true);
    expect(writes).toBe(0);
    expect(atomicWriteCount(path)).toBe(0);
    expect(readFileSync(path).equals(original)).toBe(true);
    expect(view(path)).toEqual(view0);
    expect(d.events.filter((event) => event.startsWith("log:")).length).toBe(1);
    expect(marks.ownWrite("bot:n")).toBe(true);
    expect(readFileSync(path, "utf8").endsWith(text(own("bot:n")))).toBe(true);
  });
});

describe("M1 a partial append never lets the next append join onto its fragment", () => {
  it("M1 a partial append throws, a later append succeeds, and the reload is clean with the second line present", () => {
    const path = newPath();
    writeFileSync(path, text({ k: "since", at: 5 }, own("bot:a")));
    let fail = true;
    const appendLine = (target: string, data: string) => {
      if (fail) { fail = false; appendFileSync(target, data.slice(0, 12)); throw eio(); } // a fragment, no newline
      appendFileSync(target, data);
    };
    const store = fileOutsideStore(path, { appendLine, dirSync: () => "synced" });
    store.load();
    expect(() => store.addOwnWrite!("bot:lost")).toThrow();
    store.addOwnWrite!("bot:second");
    const reloaded = fileOutsideStore(path, { dirSync: () => "synced" }).load();
    expect(reloaded.ownWrites).toEqual(["bot:a", "bot:second"]);
    expect(readFileSync(path, "utf8")).toBe(`${text({ k: "since", at: 5 }, own("bot:a"), own("bot:second"))}`);
  });
});

describe("L2 a fatal load says so, without quoting the file", () => {
  it("L2 a corrupt journal logs one console.error naming the outside store, and never its contents", () => {
    const path = newPath();
    writeFileSync(path, `${text({ k: "since", at: 5 })}SECRETCONTENT not json\n${text(own("bot:a"))}`);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    try { expect(marks.wireOutsideStore(fileOutsideStore(path))).toBe(false); } finally { console.error = original; }
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("outside-store");
    expect(errors[0]).not.toContain("SECRET"); // a JSON error message quotes the first bytes of the bad line
    expect(marks.outsideReady()).toBe(false);
  });
});

describe("C3d every stat field is compared", () => {
  type Facts = { size: number; mtimeMs: number; ino: number };
  const real = (target: string): Facts => { const s = statSync(target); return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino }; };
  const attempt = (first: (f: Facts) => Facts, second: (f: Facts) => Facts) => {
    const path = newPath();
    writeFileSync(path, rich());
    let calls = 0;
    const stat = (target: string) => { calls++; return calls === 1 ? first(real(target)) : second(real(target)); };
    expect(marks.wireOutsideStore(fileOutsideStore(path, { ...disk(path).seams, stat }))).toBe(true);
    return atomicWriteCount(path);
  };
  it("C3d a changed size, mtime or (non-zero) inode skips the rewrite; the same facts, or a zero inode on one side, still rewrite", () => {
    expect(attempt((f) => f, (f) => f)).toBe(1);
    expect(attempt((f) => f, (f) => ({ ...f, size: f.size + 1 }))).toBe(0);
    expect(attempt((f) => f, (f) => ({ ...f, mtimeMs: f.mtimeMs + 1 }))).toBe(0);
    expect(attempt((f) => f, (f) => ({ ...f, ino: f.ino + 1 }))).toBe(0);
    expect(attempt((f) => ({ ...f, ino: 0 }), (f) => f)).toBe(1); // a filesystem with no inode numbers: the other fields decide
  });
});

describe("D2b real faults inside the atomic writer (open, partial write, fsync) and the tmp fsync before the rename", () => {
  const boom = (code: string) => Object.assign(new Error(code), { code });
  const faults: [string, NonNullable<OutsideStoreSeams["atomicOps"]>][] = [
    ["open", { open: (() => { throw boom("EACCES"); }) as unknown as typeof openSync }],
    ["partial write", { write: ((fd: number) => { writeFileSync(fd, "partial"); throw boom("ENOSPC"); }) as unknown as typeof writeFileSync }],
    ["fsync", { fsync: (() => { throw boom("EIO"); }) as unknown as typeof fsyncSync }],
  ];
  for (const [title, ops] of faults) {
    it(`D2b a tmp ${title} failure: original bytes, tmp unlinked, ready, not latched`, () => {
      const path = newPath();
      writeFileSync(path, rich());
      const original = readFileSync(path);
      const d = disk(path);
      expect(marks.wireOutsideStore(fileOutsideStore(path, { ...d.seams, atomicOps: ops }))).toBe(true);
      expect(readFileSync(path).equals(original)).toBe(true);
      expect(tmpsIn(path)).toEqual([]);
      expect(atomicWriteCount(path)).toBe(0);
      expect(marks.ownWrite("bot:later")).toBe(true);
    });
  }
  it("D2c the tmp file is fsynced before the rename", () => {
    const path = newPath();
    writeFileSync(path, rich());
    const d = disk(path);
    const atomicOps = { fsync: ((fd: number) => { d.events.push("tmp-fsync"); fsyncSync(fd); }) as typeof fsyncSync };
    expect(marks.wireOutsideStore(fileOutsideStore(path, { ...d.seams, atomicOps }))).toBe(true);
    expect(atomicWriteCount(path)).toBe(1);
    expect(d.events.indexOf("tmp-fsync")).toBeGreaterThanOrEqual(0);
    expect(d.events.indexOf("tmp-fsync")).toBeLessThan(d.events.indexOf("rename"));
  });
});

describe("D11 a directory sync that was proven at the probe but is unavailable after the rename fails closed (Astra B-High)", () => {
  it("D11 synced then unsupported: not ready, no write admitted, the old entry comes back after a power cut and loses nothing acknowledged", () => {
    const path = newPath();
    writeFileSync(path, rich());
    const original = view(path);
    let calls = 0;
    const d = disk(path, { dirSync: () => (++calls === 1 ? "synced" : "unsupported") });
    const store = fileOutsideStore(path, d.seams);
    expect(marks.wireOutsideStore(store)).toBe(false);
    expect(marks.outsideReady()).toBe(false);
    expect(marks.ownWrite("bot:w")).toBe(false);
    const compacted = readFileSync(path);
    expect(() => store.addOwnWrite!("bot:direct")).toThrow(); // a per-write retry re-checks and refuses too
    expect(readFileSync(path).equals(compacted)).toBe(true);
    d.powerCut();
    expect(bootsReady(path)).toBe(true);
    expect(view(path)).toEqual(original);
  });
});
