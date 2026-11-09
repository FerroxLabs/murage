// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OUTSIDE-COMPACT part A (design R4): the append-only journal. Torn-tail repair on every load (D9a-d), the durability barrier and its per-write gate
// (D4, D5, D8, D10, M2, P2), one read per boot with the registry cache (C4), the own-write dedupe after the guards (C7), the turn-id Set and the
// bulk boot and reconciliation index (C6, C8-C11). The real fileOutsideStore on temp paths; the seams only count calls and inject faults.
import { appendFileSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteCount } from "./atomic.ts";
import * as marks from "./email/external-marks.ts";
import { fileOutsideStore } from "./outside-store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const dirs: string[] = [];
const newPath = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ocpa-")));
  dirs.push(dir);
  return join(dir, "s.jsonl");
};
beforeEach(() => marks.restartOutsideForTests());
afterEach(() => { marks.restartOutsideForTests(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

const text = (...entries: unknown[]) => entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
const turn = (id: string, at: number, extra: Record<string, unknown> = {}) => ({ k: "turn", row: { threadId: "t", instanceId: "i", turnId: id, at, ...extra } });
const own = (key: string) => ({ k: "own", key });
const synced = () => "synced" as const;
const eio = () => Object.assign(new Error("EIO"), { code: "EIO" });
const ownsOf = (path: string) => fileOutsideStore(path).load().ownWrites ?? [];
const bytesOf = (path: string) => readFileSync(path);
const MULTI = "café-日本"; // non-ASCII fixtures: 2-byte and 3-byte characters

describe("D9 torn tail: cut back to the last newline, fsynced, on every load", () => {
  const prefix = () => text({ k: "since", at: 5 }, own("bot:a"));
  /** the powerCut model: the bytes the file held at the last successful fsync of the journal */
  const durableCapture = (path: string) => {
    const state = { bytes: Buffer.alloc(0) };
    const fsync = (fd: number) => { fsyncSync(fd); state.bytes = readFileSync(path); };
    return { state, fsync };
  };
  it("D9 a journal ending in a fragment: load, ownWrite, restart: ready and the new key is held (also after a power cut following the fsync)", () => {
    const path = newPath();
    writeFileSync(path, `${prefix()}{"k":"own","ke`);
    const { state, fsync } = durableCapture(path);
    expect(marks.wireOutsideStore(fileOutsideStore(path, { fsync }))).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(prefix());
    // power cut right after load: the last fsynced bytes already have the tail cut
    expect(state.bytes.toString("utf8")).toBe(prefix());
    expect(marks.ownWrite("bot:x")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(`${prefix()}${text(own("bot:x"))}`);
    expect(state.bytes.toString("utf8")).toBe(`${prefix()}${text(own("bot:x"))}`);
    writeFileSync(path, state.bytes);
    marks.restartOutsideForTests();
    expect(marks.wireOutsideStore(fileOutsideStore(path))).toBe(true);
    expect(marks.ownWritten("bot:x")).toBe(true);
    expect(marks.ownWritten("bot:a")).toBe(true);
  });
  it("D9b the same plus a seal after the own line: the restart is ready (no fatal middle line)", () => {
    const path = newPath();
    writeFileSync(path, `${prefix()}{"k":"turn","row":{"thr`);
    expect(marks.wireOutsideStore(fileOutsideStore(path))).toBe(true);
    expect(marks.ownWrite("bot:x")).toBe(true);
    marks.sealOutsideStore();
    marks.restartOutsideForTests();
    expect(marks.wireOutsideStore(fileOutsideStore(path))).toBe(true);
    expect(marks.ownWritten("bot:x")).toBe(true);
  });
  it("D9c a parseable last line with no newline is not applied and is truncated", () => {
    const path = newPath();
    writeFileSync(path, `${prefix()}${JSON.stringify(own("bot:unacked"))}`);
    const { state, fsync } = durableCapture(path);
    const loaded = fileOutsideStore(path, { fsync }).load();
    expect(loaded.ownWrites).toEqual(["bot:a"]);
    expect(readFileSync(path, "utf8")).toBe(prefix());
    expect(state.bytes.toString("utf8")).toBe(prefix());
    expect(ownsOf(path)).toEqual(["bot:a"]);
  });
  it("D9d a tail cut after the first byte of a multi-byte character is truncated exactly to the last newline", () => {
    const path = newPath();
    const whole = Buffer.from(JSON.stringify(own(`bot:${MULTI}`)), "utf8");
    const cut = whole.indexOf(Buffer.from("日", "utf8")) + 1; // inside the 3-byte character
    const head = Buffer.from(text({ k: "since", at: 5 }, own(`bot:${MULTI}`)), "utf8");
    writeFileSync(path, Buffer.concat([head, whole.subarray(0, cut)]));
    const loaded = fileOutsideStore(path).load();
    expect(loaded.ownWrites).toEqual([`bot:${MULTI}`]);
    expect(bytesOf(path).equals(head)).toBe(true);
    // the next append is a clean line after the last acknowledged one
    const store = fileOutsideStore(path, { dirSync: synced });
    store.load();
    store.addOwnWrite!("bot:next");
    expect(readFileSync(path, "utf8")).toBe(`${head.toString("utf8")}${text(own("bot:next"))}`);
  });
  it("D9e repair metadata: one fsync failure right after the truncation is retried (no self-rejection) and the tail stays cut", () => {
    const path = newPath();
    writeFileSync(path, `${prefix()}{"k":"own","ke`);
    let calls = 0;
    const fsync = () => { calls++; if (calls === 1) throw eio(); };
    const store = fileOutsideStore(path, { fsync, dirSync: synced });
    expect(() => store.load()).not.toThrow();
    expect(calls).toBe(2);
    expect(readFileSync(path, "utf8")).toBe(prefix());
    store.addOwnWrite!("bot:x");
    expect(ownsOf(path)).toEqual(["bot:a", "bot:x"]);
  });
  it("D9f a per-write barrier after a failed load barrier reuses the last replay's tail (the torn bytes are still cut)", () => {
    const path = newPath();
    writeFileSync(path, `${prefix()}{"k":"own","ke`);
    let broken = true;
    // the failure comes BEFORE the cut, on both attempts, so only the last replay still knows the tail
    const store = fileOutsideStore(path, { beforeMend: () => { if (broken) throw eio(); }, dirSync: synced });
    expect(marks.wireOutsideStore(store)).toBe(false);
    expect(marks.outsideReady()).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(`${prefix()}{"k":"own","ke`);
    // the disk comes back: a late write goes through the gate, which mends first
    broken = false;
    store.setMark({ threadId: "t", source: "email", at: 9 });
    expect(readFileSync(path, "utf8")).toBe(`${prefix()}${text({ k: "mark", row: { threadId: "t", source: "email", at: 9 } })}`);
    expect(fileOutsideStore(path).load().marks).toHaveLength(1);
  });
  it("D9g a file that grew between the read and the barrier fails closed (size check) and nothing is cut", () => {
    const path = newPath();
    writeFileSync(path, `${prefix()}{"k":"own","ke`);
    const store = fileOutsideStore(path, { dirSync: synced, beforeMend: () => appendFileSync(path, "zz") });
    expect(() => store.load()).toThrow();
    expect(readFileSync(path, "utf8")).toBe(`${prefix()}{"k":"own","kezzzz`);
  });
});

describe("D4 / D5 / D8 / D10 the barrier", () => {
  it("D4 no file: load creates an empty journal and syncs the directory before any line", () => {
    const path = newPath();
    let dirCalls = 0;
    let durableAtSync = false; // the powerCut model: a file that existed at the last successful directory sync survives
    const store = fileOutsideStore(path, { dirSync: () => { dirCalls++; durableAtSync = existsSync(path); return "synced"; } });
    store.load();
    expect(durableAtSync).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBe(0);
    expect(dirCalls).toBe(1);
    store.setOutsideSince(7);
    expect(readFileSync(path, "utf8")).toBe(text({ k: "since", at: 7 }));
  });
  it("D4b a missing parent folder still fails the load (create throws twice)", () => {
    const path = join(newPath(), "..", "nope", "s.jsonl");
    expect(() => fileOutsideStore(path, { dirSync: synced }).load()).toThrow();
  });
  it("D5 a store used without load runs the full barrier, mend included, before its first registry line", () => {
    const path = newPath();
    writeFileSync(path, `${prefix5()}{"k":"reg","ad`);
    let dirCalls = 0;
    const store = fileOutsideStore(path, { dirSync: () => { dirCalls++; return "synced"; } });
    store.writeRegistry([{ path: "/p", kind: "span", since: 1 } as never], []);
    expect(dirCalls).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(`${prefix5()}${text({ k: "reg", add: [{ path: "/p", kind: "span", since: 1 }], drop: [] })}`);
    expect(fileOutsideStore(path).loadRegistry()).toHaveLength(1);
    store.writeRegistry([{ path: "/q", kind: "span", since: 2 } as never], []);
    expect(dirCalls).toBe(1);
  });
  it("D8 a directory sync that fails once then passes: ready; failing twice: not ready and turns refused", () => {
    const once = newPath();
    let calls = 0;
    expect(marks.wireOutsideStore(fileOutsideStore(once, { dirSync: () => { if (calls++ < 1) throw eio(); return "synced"; } }))).toBe(true);
    expect(calls).toBe(2);
    marks.restartOutsideForTests();
    const twice = newPath();
    const dirSync = (): "synced" => { throw eio(); };
    expect(marks.wireOutsideStore(fileOutsideStore(twice, { dirSync }))).toBe(false);
    expect(marks.outsideReady()).toBe(false);
    expect(marks.openOutsideTurn("t", "i")).toBe(false);
  });
  it("D10 a filesystem with no directory sync: ready, no rewrite, appends work", () => {
    const path = newPath();
    writeFileSync(path, text({ k: "since", at: 3 }, own("bot:a")));
    const before = atomicWriteCount(path);
    expect(marks.wireOutsideStore(fileOutsideStore(path, { dirSync: () => "unsupported" }))).toBe(true);
    expect(atomicWriteCount(path)).toBe(before);
    expect(marks.ownWrite("bot:b")).toBe(true);
    expect(ownsOf(path)).toEqual(["bot:a", "bot:b"]);
  });
});
const prefix5 = () => text({ k: "since", at: 5 });

describe("C4 one read per boot, the registry cache, and the fallback", () => {
  const entry = (path: string, since: number) => ({ path, kind: "span", since }) as never;
  it("C4a load reads once, the registry comes from that read, and a write folds into it (no second read)", () => {
    const path = newPath();
    let reads = 0;
    const store = fileOutsideStore(path, { dirSync: synced, onReplay: () => { reads++; } });
    writeFileSync(path, text({ k: "reg", add: [entry("/a", 1)], drop: [] }));
    store.load();
    expect(reads).toBe(1);
    expect(store.loadRegistry()).toEqual([entry("/a", 1)]);
    store.writeRegistry([entry("/b", 2)], [entry("/a", 1)]);
    expect(store.loadRegistry()).toEqual([entry("/b", 2)]);
    expect(reads).toBe(1);
    expect(fileOutsideStore(path).loadRegistry()).toEqual(store.loadRegistry());
  });
  it("C4b a standalone loadRegistry replays once and fills the cache; write-then-load returns the fold", () => {
    const path = newPath();
    writeFileSync(path, text({ k: "reg", add: [entry("/a", 1)], drop: [] }));
    let reads = 0;
    const store = fileOutsideStore(path, { dirSync: synced, onReplay: () => { reads++; } });
    expect(store.loadRegistry()).toEqual([entry("/a", 1)]);
    expect(store.loadRegistry()).toEqual([entry("/a", 1)]);
    expect(reads).toBe(1);
    store.writeRegistry([entry("/c", 3)], []);
    expect(store.loadRegistry()).toEqual(fileOutsideStore(path).loadRegistry());
    expect(reads).toBe(1);
  });
  it("C4c a failed append drops the cache: the next read replays the disk and never returns the stale fold", () => {
    const path = newPath();
    let reads = 0;
    const store = fileOutsideStore(path, { dirSync: synced, onReplay: () => { reads++; } });
    store.load();
    store.writeRegistry([entry("/a", 1)], []);
    rmSync(path);
    mkdirSync(path); // the next append fails (EISDIR)
    expect(() => store.writeRegistry([entry("/z", 9)], [])).toThrow();
    // the disk now holds a line the cache never saw (as after a write that landed and then threw on close)
    removeTempDirSync(path);
    writeFileSync(path, text({ k: "reg", add: [entry("/a", 1), entry("/z", 9)], drop: [] }));
    const before = reads;
    expect(store.loadRegistry()).toEqual([entry("/a", 1), entry("/z", 9)]);
    expect(reads).toBe(before + 1);
  });
  it("C4f a failed non-registry append also drops the cache (a partial line may sit in the journal)", () => {
    const path = newPath();
    let reads = 0;
    const store = fileOutsideStore(path, { dirSync: synced, onReplay: () => { reads++; } });
    store.load();
    store.writeRegistry([entry("/a", 1)], []);
    rmSync(path);
    mkdirSync(path);
    expect(() => store.setMark({ threadId: "t", source: "email", at: 1 })).toThrow();
    removeTempDirSync(path);
    writeFileSync(path, `${text({ k: "reg", add: [entry("/a", 1)], drop: [] })}{"k":"mark","ro\n`);
    expect(() => store.loadRegistry()).toThrow();
  });
  it("C4e a load that throws while reading leaves no cache behind", () => {
    const path = newPath();
    const store = fileOutsideStore(path, { dirSync: synced });
    writeFileSync(path, text({ k: "reg", add: [entry("/a", 1)], drop: [] }));
    store.load();
    writeFileSync(path, `${text({ k: "reg", add: [entry("/b", 2)], drop: [] })}not json\n${text({ k: "since", at: 1 })}`);
    expect(() => store.load()).toThrow();
    expect(() => store.loadRegistry()).toThrow();
  });
  it("D9h a malformed newline-terminated line right before a torn tail is corruption and fails closed", () => {
    const path = newPath();
    writeFileSync(path, `${prefix5()}not json\n{"k":"own","ke`);
    expect(() => fileOutsideStore(path, { dirSync: synced }).load()).toThrow();
  });
  it("C4d a registry read for a store whose load failed is never trusted: the failed rewire holds a store-less registry", () => {
    const path = newPath();
    writeFileSync(path, "not json\n{\"k\":\"since\",\"at\":1}\n");
    expect(marks.wireOutsideStore(fileOutsideStore(path))).toBe(false);
    expect(marks.downloadRegistry()).toBeDefined();
    const good = newPath();
    expect(marks.wireOutsideStore(fileOutsideStore(good, { dirSync: synced }))).toBe(true);
    const registry = marks.downloadRegistry();
    expect(marks.wireOutsideStore(fileOutsideStore(path))).toBe(false);
    expect(marks.downloadRegistry()).not.toBe(registry);
  });
});

describe("C7 own-write dedupe sits after the guards", () => {
  it("C7 a held key is one line and no I/O; a sealed store refuses; a latched store refuses even a held key", () => {
    const path = newPath();
    expect(marks.wireOutsideStore(fileOutsideStore(path, { dirSync: synced }))).toBe(true);
    expect(marks.ownWrite("bot:k")).toBe(true);
    const held = readFileSync(path, "utf8");
    for (let i = 0; i < 1000; i++) expect(marks.ownWrite("bot:k")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(held);
    marks.noteStoreFailure();
    expect(marks.ownWrite("bot:k")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(held);
  });
  it("C7b a sealed store refuses a new key and a held key", () => {
    const path = newPath();
    expect(marks.wireOutsideStore(fileOutsideStore(path, { dirSync: synced }))).toBe(true);
    expect(marks.ownWrite("bot:k")).toBe(true);
    marks.sealOutsideStore();
    const sealedBytes = readFileSync(path, "utf8");
    expect(marks.ownWrite("bot:k")).toBe(false);
    expect(marks.ownWrite("bot:new")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(sealedBytes);
  });
});

describe("C6 rewire and the turn-id Set", () => {
  const crashed = (path: string, count: number) => {
    const lines: unknown[] = [{ k: "since", at: 1 }];
    for (let i = 0; i < count; i++) lines.push({ k: "open", runId: `crash-${i}`, threadId: `th${i % 50}`, instanceId: "i", at: 1_000 + i });
    writeFileSync(path, text(...lines));
  };
  it("C6 each rewire re-derives the recovered `#open` turns exactly once, in one process and on a copy", () => {
    const path = newPath();
    crashed(path, 40);
    for (let wire = 0; wire < 3; wire++) {
      expect(marks.wireOutsideStore(fileOutsideStore(path, { dirSync: synced }))).toBe(true);
      expect(marks.turnWasMarked("th0", "th0#open1000")).toBe(true);
      expect(marks.markedTurnsOf("th0")).toHaveLength(1);
      expect(marks.sessionTainted("th0", "i")).toBe(true);
    }
    const copy = newPath();
    writeFileSync(copy, readFileSync(path));
    marks.restartOutsideForTests();
    expect(marks.wireOutsideStore(fileOutsideStore(copy, { dirSync: synced }))).toBe(true);
    expect(marks.turnWasMarked("th1", "th1#open1001")).toBe(true);
  });
  it("C6b first turn row wins on a duplicate id and a live add of a held id is a no-op", () => {
    const path = newPath();
    writeFileSync(path, text(turn("a", 5, { begunAt: 5 }), turn("a", 6, { begunAt: 6 }), turn("b", 3)));
    expect(marks.wireOutsideStore(fileOutsideStore(path, { dirSync: synced }))).toBe(true);
    expect(marks.markedTurnsOf("t").map((row) => [row.turnId, row.at])).toEqual([["b", 3], ["a", 5]]);
    expect(marks.turnWasMarked("t", "a")).toBe(true);
    expect(marks.turnWasMarked("t", "zz")).toBe(false);
    // a live add of a held id is a no-op
    marks.beginOutsideTurn("t", "i", "a", false);
    marks.markTurnOutside("t", "email");
    expect(marks.markedTurnsOf("t").map((row) => row.turnId)).toEqual(["b", "a"]);
  });
});

describe("C8-C11 linear boot", () => {
  it("C8 50k marked turns with backward timestamps and 1k recovered opens load in under a second, sorted", () => {
    const path = newPath();
    const lines: unknown[] = [{ k: "since", at: 1 }];
    for (let i = 0; i < 50_000; i++) lines.push(turn(`m${i}`, 1_000_000 - i, { begunAt: 1_000_000 - i }));
    for (let i = 0; i < 1000; i++) lines.push({ k: "open", runId: `crash-${i}`, threadId: `o${i}`, instanceId: "i", at: 2_000_000 + i });
    writeFileSync(path, text(...lines));
    const started = performance.now();
    expect(marks.wireOutsideStore(fileOutsideStore(path, { dirSync: synced }))).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
    const list = marks.markedTurnsOf("t");
    expect(list).toHaveLength(50_000);
    expect(list[0]!.at).toBe(1_000_000 - 49_999);
    expect(list.every((row, index) => index === 0 || list[index - 1]!.at <= row.at)).toBe(true);
    expect(marks.turnWasMarked("o5", "o5#open2000005")).toBe(true);
  });
  it("C9 30k retained crashed-run opens and 30k sealed runs replay in under a second; exactly the unsealed opens remain, in order", () => {
    const path = newPath();
    const lines: unknown[] = [];
    for (let i = 0; i < 30_000; i++) lines.push({ k: "open", runId: `crash-${i}`, threadId: "t", instanceId: "i", at: i });
    for (let i = 0; i < 30_000; i++) { lines.push({ k: "open", runId: `r${i}`, threadId: "t", instanceId: "i", at: 40_000 + i }); lines.push({ k: "seal", runId: `r${i}` }); }
    writeFileSync(path, text(...lines));
    const started = performance.now();
    const loaded = fileOutsideStore(path, { dirSync: synced }).load();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(loaded.opens).toHaveLength(30_000);
    expect(loaded.opens[0]!.runId).toBe("crash-0");
    expect(loaded.opens[29_999]!.runId).toBe("crash-29999");
  });
  it("C10 reconciliation over 5k sessions x 20k turns is linear and taints exactly the sessions the old predicate tainted", () => {
    const path = newPath();
    const lines: unknown[] = [];
    // thread 0 holds 20k marked turns, bound to session keys k0..k19999 except the session of instance i7
    for (let i = 0; i < 20_000; i++) lines.push(turn(`m${i}`, 10 + i, { instanceId: `i${i % 5000}`, sessionKey: `k${i}`, gen: 1, birthRunId: "b" }));
    for (let i = 0; i < 5000; i++) lines.push({ k: "session", row: { threadId: "t", instanceId: `i${i}`, sessionKey: `k${i}`, gen: 1, birthRunId: "b", tainted: false, wrote: false, edits: [], startedAt: 1 } });
    // a clean session with another binding in the same instance, and one with no binding and a late start
    lines.push({ k: "session", row: { threadId: "t", instanceId: "i7", sessionKey: "other", gen: 2, birthRunId: "b", tainted: false, wrote: false, edits: [], startedAt: 1 } });
    lines.push({ k: "session", row: { threadId: "u", instanceId: "i", tainted: false, wrote: false, edits: [] } });
    lines.push(turn("ux", 50, { threadId: "u", instanceId: undefined }));
    // unbound turns against a defined startedAt: equal taints, later start does not, no start taints
    lines.push(turn("vx", 5, { threadId: "v", instanceId: undefined, begunAt: 100 }));
    for (const [instance, startedAt] of [["ia", 100], ["ib", 101], ["ic", undefined]] as const) lines.push({ k: "session", row: { threadId: "v", instanceId: instance, tainted: false, wrote: false, edits: [], ...(startedAt !== undefined ? { startedAt } : {}) } });
    // a bound turn: gen and birthRunId each decide the match
    lines.push(turn("w", 5, { threadId: "w", instanceId: "i", sessionKey: "k", gen: 1, birthRunId: "b" }));
    for (const [thread, gen, run] of [["w1", 2, "b"], ["w2", 1, "other"], ["w3", 1, "b"]] as const) {
      lines.push(turn(`wt-${thread}`, 5, { threadId: thread, instanceId: "i", sessionKey: "k", gen: 1, birthRunId: "b" }));
      lines.push({ k: "session", row: { threadId: thread, instanceId: "i", sessionKey: "k", gen, birthRunId: run, tainted: false, wrote: false, edits: [] } });
    }
    writeFileSync(path, text(...lines));
    const started = performance.now();
    expect(marks.wireOutsideStore(fileOutsideStore(path, { dirSync: synced }))).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
    // the old predicate, written out: a turn of the same instance (or none) that carries this session's binding, else an unbound one begun at or after its start
    const carried = new Set(Array.from({ length: 20_000 }, (_, n) => `${n % 5000}|k${n}`));
    for (let i = 0; i < 5000; i++) expect(marks.sessionTainted("t", `i${i}`)).toBe(carried.has(`${i}|${i === 7 ? "other" : `k${i}`}`));
    expect(marks.sessionTainted("t", "i7")).toBe(false);
    // an unbound turn begun at or after the session start (or a session with no start) taints
    expect(marks.sessionTainted("u", "i")).toBe(true);
    expect(marks.sessionTainted("v", "ia")).toBe(true);
    expect(marks.sessionTainted("v", "ib")).toBe(false);
    expect(marks.sessionTainted("v", "ic")).toBe(true);
    expect(marks.sessionTainted("w1", "i")).toBe(false);
    expect(marks.sessionTainted("w2", "i")).toBe(false);
    expect(marks.sessionTainted("w3", "i")).toBe(true);
  });
  it("C11 ten rewires with 15k recovered opens take under a second in total", () => {
    const path = newPath();
    const lines: unknown[] = [{ k: "since", at: 1 }];
    for (let i = 0; i < 15_000; i++) lines.push({ k: "open", runId: `c${i}`, threadId: "th", instanceId: `i${i}`, at: 100 + i });
    writeFileSync(path, text(...lines));
    const store = fileOutsideStore(path, { dirSync: synced });
    const started = performance.now();
    for (let n = 0; n < 10; n++) expect(marks.wireOutsideStore(store)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(marks.markedTurnsOf("th")).toHaveLength(15_000);
  });
});
