// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 PIP-PERF: memoryLookup reads versioned source refs in one statement per 500 (deny-read.ts batchSources) instead of one seek per
// fact per ref, so the learning send gate's re-check of a window's held sources stays flat. The batch must answer exactly what the per-ref
// seeks answer, reason included, for every fact a source verdict reads: each case here is judged both ways and compared.
import { afterEach, expect, it } from "vitest";
import { denyReadMeter, memoryLookup, memoryLookupEachSource, resetDenyReadMeter } from "./deny-read.ts";
import type { LineageVerdict, MemoryRef } from "./lineage-types.ts";
import { MEMBER, WritetimeFixture } from "./testing/writetime-fixture.ts";

const fixtures: WritetimeFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
const make = () => { const fixture = new WritetimeFixture(); fixtures.push(fixture); return fixture; };
const SHOWN = { state: "shown" };
const W = (reason: string) => ({ state: "withheld", reason });
const C = (reason: string) => ({ state: "checking", reason });
const src = (id: string, version = 1): MemoryRef => ({ kind: "source", id, version });
/** Both paths on the same file, the batch first (so the per-process positive anchor memo is warmed by the batch, never for it); returns
 *  the batched answer after checking the per-ref one is identical. The cold per-ref anchor answer has its own test on separate files. */
function both(f: WritetimeFixture, refs: MemoryRef[]): Record<string, LineageVerdict> {
  const batched = Object.fromEntries(memoryLookup(f.db, refs, MEMBER));
  const single = Object.fromEntries(memoryLookupEachSource(f.db, refs, MEMBER));
  expect(single).toEqual(batched);
  return batched;
}

it("a Murage-voice, a malformed and a missing anchor are classified cold the same way by the batch and by the seeks (separate files)", () => {
  const seed = () => {
    const f = make().message("T", "m-voice", "bot", { murageLine: true }).message("T", "m-ok", "user")
      .source("voice", "s-room", { thread: "T", message: "m-voice" }).source("bad", "s-room", { thread: "T", message: "m-bad" })
      .source("gone", "s-room", { thread: "T", message: "m-gone" }).source("ok", "s-room", { thread: "T", message: "m-ok" });
    f.db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('T','m-bad',0,'user','text','','{not json')").run();
    return f;
  };
  const refs = [src("voice"), src("bad"), src("gone"), src("ok")];
  const want = { "source:voice:1": W("murage-anchor"), "source:bad:1": W("murage-anchor"), "source:gone:1": W("murage-anchor"), "source:ok:1": SHOWN };
  expect(Object.fromEntries(memoryLookup(seed().db, refs, MEMBER))).toEqual(want);
  expect(Object.fromEntries(memoryLookupEachSource(seed().db, refs, MEMBER))).toEqual(want);
});

it("every source fact reads the same batched as sought one by one, reason included", () => {
  const f = make()
    .message("T", "m-ok", "user").message("T", "m-voice", "bot", { murageLine: true })
    .source("ok", "s-room", { thread: "T", message: "m-ok" })
    .source("voice", "s-room", { thread: "T", message: "m-voice" })
    .source("no-anchor-row", "s-room", { thread: "T", message: "m-missing" })
    .source("no-thread", "s-room", { message: "m-ok" })
    .source("no-message", "s-room")
    .source("deleted", "s-room", { state: "deleted" })
    .source("thread-denied", "s-room", { thread: "X" }).deny("thread", "X")
    .source("scope-denied", "s-other").deny("scope", "s-other")
    .source("marked-all", "s-room").denyMemory("source", "marked-all", 0)
    .source("marked-rev", "s-room", { revision: 2 }).denyMemory("source", "marked-rev", 2)
    .source("marked-other-rev", "s-room", { revision: 2 }).denyMemory("source", "marked-other-rev", 1)
    .denyMemory("source", "missing-marked", 0)
    .source("tomb-rev", "s-room", { revision: 2 }).tombstone("source", "tomb-rev", 2)
    .source("tomb-other-rev", "s-room", { revision: 2 }).tombstone("source", "tomb-other-rev", 1)
    .source("tomb-all", "s-room").tombstone("source", "tomb-all", null)
    .source("import:a", "s-room", { kind: "legacy-import", hash: "H" }).source("import:b", "s-room", { kind: "legacy-import", hash: "K" })
    .tombstone("import", "s-room", 3, "owner-forget", "H")
    .source("two", "s-room", { revision: 2 }).tombstone("source", "two", 1);
  const refs: MemoryRef[] = [src("two", 1), src("two", 2), src("ok"), src("voice"), src("no-anchor-row"), src("no-thread"), src("no-message"), src("deleted"), src("thread-denied"), src("scope-denied"),
    src("marked-all"), src("marked-rev", 2), src("marked-other-rev", 2), src("missing"), src("missing-marked"), src("tomb-rev", 2), src("tomb-other-rev", 2),
    src("tomb-all"), src("import:a"), src("import:b"), src("ok"), { kind: "source", id: "ok" }, { kind: "record", id: "gone", version: 1 }];
  expect(both(f, refs)).toEqual({
    "source:two:1": W("tombstone"), "source:two:2": SHOWN, "source:ok:1": SHOWN, "source:voice:1": W("murage-anchor"), "source:no-anchor-row:1": W("murage-anchor"), "source:no-thread:1": W("murage-anchor"),
    "source:no-message:1": SHOWN, "source:deleted:1": W("tombstone"), "source:thread-denied:1": W("scope-deny"), "source:scope-denied:1": W("scope-deny"),
    "source:marked-all:1": W("deny-memory"), "source:marked-rev:2": W("deny-memory"), "source:marked-other-rev:2": SHOWN, "source:missing:1": W("tombstone"),
    "source:missing-marked:1": W("deny-memory"), "source:tomb-rev:2": W("tombstone"), "source:tomb-other-rev:2": SHOWN, "source:tomb-all:1": W("tombstone"),
    "source:import:a:1": W("tombstone"), "source:import:b:1": SHOWN, "source:ok:0": SHOWN, "record:gone:1": W("tombstone") });
});

it("the pending window reads the revision's stamp the same way: older shown, newer checking, unstamped bounded by the first stamp", () => {
  const f = make().source("old", "s-room").source("new", "s-room").source("unstamped", "s-room").pendingScope("s-room", 50);
  f.db.exec("UPDATE memory_source_lsn SET created_lsn=10 WHERE source_id='old'; UPDATE memory_source_lsn SET created_lsn=60 WHERE source_id='new'; DELETE FROM memory_source_lsn WHERE source_id='unstamped'");
  expect(both(f, [src("old"), src("new"), src("unstamped")])).toEqual({ "source:old:1": SHOWN, "source:new:1": C("pending"), "source:unstamped:1": SHOWN });
  f.pending("*", 5);
  expect(both(f, [src("old"), src("new"), src("unstamped")])).toEqual({ "source:old:1": C("pending"), "source:new:1": C("pending"), "source:unstamped:1": C("pending") });
});

it("while a revoke is in flight a source supporting a forgotten record is withheld the same way, and past the fan-in reads checking", () => {
  const f = make().source("s9", "s-room").record("R9", 1, "s-room", ["s9"]).tombstone("record", "R9", 1).source("s8", "s-room").record("R8", 1, "s-room", ["s8"])
    .denyMemory("record", "R8", 0).source("pop", "s-room").pending("T", 1000);
  for (let at = 0; at < 70; at++) f.record(`x${at}`, 1, "s-room", ["pop"]);
  expect(both(f, [src("s9"), src("s8"), src("pop")])).toEqual({ "source:s9:1": W("tombstone"), "source:s8:1": SHOWN, "source:pop:1": C("pending") });
});

it("a file the batch cannot read (no messages table) falls back to the seeks, whose error reads checking per ref", () => {
  const f = make().source("plain", "s-room").source("anchored", "s-room", { thread: "T", message: "m" });
  f.db.exec("DROP TABLE messages");
  expect(both(f, [src("plain"), src("anchored")])).toEqual({ "source:plain:1": SHOWN, "source:anchored:1": C("lookup-error") });
});

it("a window of held sources is read in one statement per 500 refs, never one per source, and answers the same", () => {
  const f = make();
  const refs: MemoryRef[] = [];
  for (let at = 0; at < 1200; at++) { f.message("T", `m${at}`, "user").source(`w${at}`, "s-room", { thread: "T", message: `m${at}` }); refs.push(src(`w${at}`)); }
  f.tombstone("source", "w777", 1);
  const answer = both(f, refs);
  expect(Object.values(answer).filter(v => v.state !== "shown")).toEqual([W("tombstone")]);
  resetDenyReadMeter();
  memoryLookup(f.db, refs, MEMBER);
  const batched = denyReadMeter().statements;
  resetDenyReadMeter();
  memoryLookupEachSource(f.db, refs, MEMBER);
  const single = denyReadMeter().statements;
  // 3 batches plus the scope's few shared seeks, against several seeks per source
  expect(batched).toBeLessThan(20);
  expect(single).toBeGreaterThan(2 * refs.length);
});
