// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S4-INTERP L1h (Astra L1 r7 Medium): the sessionEdits journal is incremental. One `edit` line per tool-call path (all its new
// spellings in that line), no whole-set snapshot per spelling, replay linear in the lines. Rows J1-J6, plus J7 (journals written
// by the tip before L1h, full-snapshot `session` lines, still load). The real fileOutsideStore on a temp path.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_EDITS_OVERFLOW, beginOutsideTurn, forgetOutsideState, noteSessionWrote, markTurnOutside, openOutsideTurn, outsideReady, restartOutsideForTests, sessionEdits, wireOutsideStore } from "./email/external-marks.ts";
import { outsideScanMarks, type OutsideScanHooks } from "./outside-scan.ts";
import { fileOutsideStore } from "./outside-store.ts";
import { noteToolStartOutside } from "./outside-wire.ts";

const clean = (): OutsideScanHooks => ({
  cwd: "/w", home: "/h", lookupProgram: (name) => `/usr/bin/${name}`,
  probe: (p) => ({ kind: "file", real: p, fresh: false, zip: false }),
});
const tmp = (tag: string) => realpathSync(mkdtempSync(join(tmpdir(), `s4j-${tag}-`)));
const newJournal = () => join(tmp("j"), "s.jsonl");
const wire = (path: string) => { forgetOutsideState(); wireOutsideStore(fileOutsideStore(path)); beginOutsideTurn("t1", "i1", "turn-1", false); };
const reload = (path: string) => { forgetOutsideState(); return wireOutsideStore(fileOutsideStore(path)); };
const edit = (file: string) => { noteToolStartOutside("t1", { origin: "engine", title: "Write", callKey: `w-${file}`, input: { file_path: file } }, "/w"); };
const lines = (path: string): any[] => readFileSync(path, "utf8").split("\n").filter(Boolean).map((text) => JSON.parse(text));
const row = (edits: string[], extra: Record<string, unknown> = {}) => ({ threadId: "t1", instanceId: "i1", tainted: false, wrote: false, edits, ...extra });
const put = (path: string, ...entries: unknown[]) => appendFileSync(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
/** a symlink dir `link` -> `real` under a fresh root; `${root}/./link/f<i>` has three spellings (as given, normalized, real; the file is missing) */
const rig = (tag: string) => {
  const root = tmp(tag);
  mkdirSync(join(root, "real"));
  symlinkSync(join(root, "real"), join(root, "link"));
  return root;
};
const spelled = (root: string, i: number) => `${root}/./link/f${i}`;
const sizeOf = (path: string) => statSync(path).size;
const editsOf = (path: string) => (fileOutsideStore(path).load().sessions.find((r) => r.threadId === "t1" && r.instanceId === "i1")?.edits ?? []);

describe("J1-J3 one entry per path, flat cost, and the spellings survive a restart", () => {
  afterEach(() => restartOutsideForTests());
  const N = 1400;
  const fill = () => {
    const path = newJournal();
    const root = rig("fill");
    wire(path);
    const growth: number[] = [];
    const allowed: number[] = [];
    for (let i = 0; i < N; i++) {
      const before = sizeOf(path);
      edit(spelled(root, i));
      growth.push(sizeOf(path) - before);
      // R2: the growth is the new spellings' bytes (quotes and comma included) plus 256 B of line framing
      allowed.push([spelled(root, i), `${root}/link/f${i}`, `${root}/real/f${i}`].reduce((sum, entry) => sum + entry.length + 3, 0) + 256);
    }
    return { path, root, growth, allowed };
  };
  it("J1 1,400 paths with three spellings each are 1,400 edit lines and no non-empty session snapshot", () => {
    const { path, root } = fill();
    const all = lines(path);
    const edits = all.filter((l) => l.k === "edit");
    expect(edits.length).toBe(N);
    expect(edits.every((l) => l.add.length === 3)).toBe(true);
    expect(all.filter((l) => l.k === "session" && l.row.edits.length > 0)).toEqual([]);
    const longest = spelled(root, N - 1).length;
    expect(sizeOf(path)).toBeLessThanOrEqual(N * (3 * (longest + 8) + 96) + 4096);
  });
  it("J2 the file grows by the same small amount for the 1,400th path as for the 1st", () => {
    const { growth, allowed } = fill();
    for (const i of [0, N - 1]) {
      expect(growth[i]!).toBeGreaterThan(0);
      expect(growth[i]!).toBeLessThanOrEqual(allowed[i]!);
    }
    expect(growth[N - 1]!).toBeLessThanOrEqual(growth[0]! + 16);
  });
  it("J3 a fresh store from the file holds all 4,200 entries and the I18a-d, I18b and I19 spellings still mark against the reloaded set", () => {
    const { path, root } = fill();
    // the spelling rows, journaled in the same file
    mkdirSync(join(root, "w2"));
    writeFileSync(join(root, "real", "tool"), "x");
    utimesSync(join(root, "real", "tool"), new Date(1e12), new Date(1e12));
    edit(join(root, "link", "tool")); // I18a
    edit(join(root, "link", "newdir", "deep", "tool")); // I18d
    edit("/w/./x/../tool"); // I18b
    edit("/w/X.js"); // I19
    const before = new Set(sessionEdits("t1", "i1"));
    expect(before.size).toBeGreaterThanOrEqual(N * 3);
    expect(reload(path)).toBe(true);
    const after = sessionEdits("t1", "i1");
    expect(after.size).toBe(before.size);
    for (const entry of before) expect(after.has(entry), entry).toBe(true);
    const marks = (command: string, hooks: OutsideScanHooks = clean()) => outsideScanMarks(command, { ...hooks, sessionEdits: after });
    expect(marks(join(root, "real", "tool"))).toContain("interpreter");
    expect(marks(join(root, "real", "newdir", "deep", "tool"))).toContain("interpreter");
    expect(marks("/w/tool")).toContain("interpreter");
    expect(marks("node /w/x.js", { ...clean(), probe: (p) => ({ kind: "file", real: p.toLowerCase() === "/w/x.js" ? "/w/X.js" : p, fresh: false, zip: false }) })).toContain("interpreter");
    expect(outsideScanMarks(join(root, "real", "tool"), { ...clean(), sessionEdits: new Set(["/w/other"]) })).toEqual([]);
  });
});

describe("J4 order: snapshots, edit lines, a fresh session, a superseding open", () => {
  afterEach(() => restartOutsideForTests());
  const A = { sessionKey: "ka", gen: 1, birthRunId: "ra" };
  const B = { sessionKey: "kb", gen: 1, birthRunId: "rb" };
  it("J4a edit lines, a taint snapshot, more edit lines, then a reload is the union", () => {
    const path = newJournal();
    const store = fileOutsideStore(path);
    store.setSession(row([]));
    store.addSessionEdits("t1", "i1", ["/a"]);
    store.setSession(row(["/a"], { tainted: true }));
    store.addSessionEdits("t1", "i1", ["/b", "/c"]);
    const loaded = fileOutsideStore(path).load().sessions;
    expect(loaded.length).toBe(1);
    expect([...loaded[0]!.edits].sort()).toEqual(["/a", "/b", "/c"]);
    expect(loaded[0]!.tainted).toBe(true);
  });
  it("J4b a later fresh session line empties the set on reload", () => {
    const path = newJournal();
    const store = fileOutsideStore(path);
    store.setSession(row([]));
    store.addSessionEdits("t1", "i1", ["/a", "/b"]);
    store.setSession(row([]));
    expect(editsOf(path)).toEqual([]);
    store.addSessionEdits("t1", "i1", ["/n"]);
    expect(editsOf(path)).toEqual(["/n"]);
  });
  it("J4c an open of another session binding supersedes the row and its edits; later edits start a new set", () => {
    const path = newJournal();
    const store = fileOutsideStore(path);
    store.setSession(row([], A));
    store.addSessionEdits("t1", "i1", ["/a", "/b"]);
    store.openTurn("t1", "i1", 1, "run-b", B);
    store.addSessionEdits("t1", "i1", ["/c"]);
    expect(editsOf(path)).toEqual(["/c"]);
  });
  it("J4f explicit bindings: session(A), edit(A), open(B), session(B), edit(B) leaves exactly the B edits, and an open of the same binding keeps the set", () => {
    const path = newJournal();
    const store = fileOutsideStore(path);
    store.setSession(row([], A));
    store.addSessionEdits("t1", "i1", ["/a1", "/a2"]);
    store.openTurn("t1", "i1", 1, "run-a2", A); // the same binding: no supersede
    expect([...editsOf(path)].sort()).toEqual(["/a1", "/a2"]);
    store.openTurn("t1", "i1", 2, "run-b", B); // another binding: supersedes the row and its edits
    store.setSession(row([], B));
    store.addSessionEdits("t1", "i1", ["/b1"]);
    const sessions = fileOutsideStore(path).load().sessions;
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.sessionKey).toBe("kb");
    expect(sessions[0]!.edits).toEqual(["/b1"]);
  });
  it("J4d an unsealed open after the edits keeps them and adds the overflow key (more marking only)", () => {
    const path = newJournal();
    const root = rig("open");
    wire(path);
    edit(spelled(root, 1));
    const bound = fileOutsideStore(path).load().sessions[0]!;
    fileOutsideStore(path).openTurn("t1", "i1", Date.now(), "run-x", { sessionKey: bound.sessionKey!, gen: bound.gen!, birthRunId: bound.birthRunId! });
    expect(reload(path)).toBe(true);
    const edits = sessionEdits("t1", "i1");
    expect(edits.has(SESSION_EDITS_OVERFLOW)).toBe(true);
    expect(edits.has(`${root}/link/f1`)).toBe(true);
  });
  it("J4e wrote and taint snapshots in the middle of the edits lose none", () => {
    const path = newJournal();
    const root = rig("snap");
    wire(path);
    edit(spelled(root, 1));
    noteSessionWrote("t1", "i1");
    edit(spelled(root, 2));
    markTurnOutside("t1", "web page");
    edit(spelled(root, 3));
    const before = new Set(sessionEdits("t1", "i1"));
    expect(before.size).toBe(9);
    expect(reload(path)).toBe(true);
    expect(new Set(sessionEdits("t1", "i1"))).toEqual(before);
  });
});

describe("J5 a capped session has a bounded journal and a quick replay", () => {
  afterEach(() => restartOutsideForTests());
  it("J5 4,096 paths x 3 spellings then the overflow line: at most 6 MB, ready, replay under 3 s", () => {
    const path = newJournal();
    const root = rig("cap");
    wire(path);
    for (let i = 0; i < 4096; i++) edit(spelled(root, i));
    expect(sessionEdits("t1", "i1").size).toBe(4096 * 3);
    expect(sessionEdits("t1", "i1").has(SESSION_EDITS_OVERFLOW)).toBe(false);
    edit(`${root}/./link/past-the-cap`);
    expect(sessionEdits("t1", "i1").has(SESSION_EDITS_OVERFLOW)).toBe(true);
    const size = sizeOf(path);
    expect(size).toBeLessThanOrEqual(6 * 1024 * 1024);
    const started = Date.now();
    const ready = reload(path);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(ready).toBe(true);
    expect(sessionEdits("t1", "i1").size).toBe(4096 * 3 + 1);
    // the base algorithm (a whole-set snapshot per inserted entry) for the same session, by arithmetic: far over 700 MB
    const entry = spelled(root, 4095).length + 4;
    let baseBytes = 0;
    for (let k = 1; k <= 4096 * 3; k++) baseBytes += k * entry + 120;
    expect(baseBytes).toBeGreaterThan(700 * 1024 * 1024);
  }, 60_000);
});

describe("J6 a torn last edit line is skipped, a corrupt middle one fails closed", () => {
  afterEach(() => restartOutsideForTests());
  it("J6a a torn final edit line is skipped", () => {
    const path = newJournal();
    put(path, { k: "session", row: row([]) }, { k: "edit", threadId: "t1", instanceId: "i1", add: ["/a"] });
    appendFileSync(path, '{"k":"edit","threadId":"t1","instanceId":"i1","add":["/torn');
    expect(editsOf(path)).toEqual(["/a"]);
    expect(reload(path)).toBe(true);
  });
  it("J6b a corrupt edit line in the middle throws, and the store is not ready", () => {
    const path = newJournal();
    put(path, { k: "session", row: row([]) });
    appendFileSync(path, '{"k":"edit","threadId":"t1","instanceId":"i1","add":["/bad\n');
    put(path, { k: "edit", threadId: "t1", instanceId: "i1", add: ["/b"] });
    expect(() => fileOutsideStore(path).load()).toThrow();
    expect(reload(path)).toBe(false);
    expect(outsideReady()).toBe(false);
  });
});

describe("J6 durability: an edit line is on disk when the call returns, and a failed append latches the store", () => {
  afterEach(() => restartOutsideForTests());
  it("J6c after an append a fresh replay sees the edit, with no flush between", () => {
    const path = newJournal();
    const store = fileOutsideStore(path);
    store.setSession(row([]));
    for (const entry of ["/a", "/b", "/c"]) {
      store.addSessionEdits("t1", "i1", [entry]);
      expect(editsOf(path)).toContain(entry);
    }
  });
  it("J6d a failed edit append closes relief: the store is not ready and no turn opens, the edit stays held in memory", () => {
    const path = newJournal();
    const root = rig("fail");
    wire(path);
    edit(spelled(root, 1));
    expect(outsideReady()).toBe(true);
    rmSync(path); mkdirSync(path); // the next append fails (a folder where the file was)
    edit(spelled(root, 2));
    expect(outsideReady()).toBe(false);
    expect(openOutsideTurn("t1", "i1")).toBe(false);
    expect(sessionEdits("t1", "i1").has(`${root}/real/f2`)).toBe(true);
  });
  it("J6e a failed snapshot after edits closes relief the same way", () => {
    const path = newJournal();
    const root = rig("failsnap");
    wire(path);
    edit(spelled(root, 1));
    rmSync(path); mkdirSync(path);
    noteSessionWrote("t1", "i1");
    expect(outsideReady()).toBe(false);
    expect(openOutsideTurn("t1", "i1")).toBe(false);
    expect(sessionEdits("t1", "i1").has(`${root}/real/f1`)).toBe(true);
  });
});

describe("J7 a journal written by the tip before L1h (full-snapshot session lines) still loads", () => {
  afterEach(() => restartOutsideForTests());
  it("J7a growing session snapshots load as the last one", () => {
    const path = newJournal();
    put(path, { k: "session", row: row([]) }, { k: "session", row: row(["/a"]) }, { k: "session", row: row(["/a", "/b"]) }, { k: "session", row: row(["/a", "/b", "/c"], { wrote: true }) });
    expect(editsOf(path)).toEqual(["/a", "/b", "/c"]);
    expect(reload(path)).toBe(true);
    expect([...sessionEdits("t1", "i1")].sort()).toEqual(["/a", "/b", "/c"]);
  });
  it("J7b edit lines after old snapshots are merged into the snapshot's set", () => {
    const path = newJournal();
    put(path, { k: "session", row: row(["/a", "/b"]) }, { k: "edit", threadId: "t1", instanceId: "i1", add: ["/c", "/a"] });
    expect(editsOf(path)).toEqual(["/a", "/b", "/c"]);
  });
  it("J7c an edit line with no session row before it builds a clean row (as a live session starts)", () => {
    const path = newJournal();
    put(path, { k: "edit", threadId: "t9", instanceId: "i9", add: ["/z"] });
    const sessions = fileOutsideStore(path).load().sessions;
    expect(sessions).toEqual([{ threadId: "t9", instanceId: "i9", tainted: false, wrote: false, edits: ["/z"] }]);
  });
});
