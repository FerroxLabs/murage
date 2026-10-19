// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ROOM-ORDER-DESIGN r6-r8 fixtures for the one ordering key (transcript-seq.ts). Each walks a modelled server that pages by `seq`
// exactly as the server half does (r6 Q2, S3: the `limit` rows with the largest `seq` below the anchor's, oldest first).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Message } from "./store";
import {
  applyTranscriptInput, gapsOf, holdRows, hydrateTranscript, inputShape, nextPage, transcriptState, vouches, type PageAsk, type SeqTranscript,
} from "./transcript-seq";

const row = (n: number, extra: Partial<Message> = {}): Message => ({ id: `m${n}`, role: "bot", kind: "text", text: `m${n}`, at: 0, seq: n, ...extra });
const range = (from: number, to: number, extra?: (n: number) => Partial<Message>) => Array.from({ length: to - from + 1 }, (_, i) => row(from + i, extra?.(from + i)));
const ids = (t: SeqTranscript) => t.messages.map((m) => m.id);
const seqs = (t: SeqTranscript) => t.messages.map((m) => m.seq);

/** A numbered thread on the server: `rows[i]` has `seq` i + 1. */
class Thread {
  rows: Message[];
  constructor(n: number) { this.rows = range(1, n); }
  get newest(): number { return this.rows.length; }
  write(extra: Partial<Message> = {}): Message { const r = row(this.rows.length + 1, extra); this.rows.push(r); return r; }
  newestPage(limit: number) {
    const rows = this.rows.slice(Math.max(0, this.rows.length - limit));
    return { kind: "newest" as const, rows, newestSeq: this.newest, vouched: true, hasMore: rows.length < this.rows.length };
  }
  before(id: string, limit: number) {
    const end = this.rows.findIndex((r) => r.id === id);
    if (end < 0) throw new Error(`no row ${id}`);
    const start = Math.max(0, end - limit);
    return { kind: "older" as const, rows: this.rows.slice(start, end), newestSeq: this.newest, vouched: true, hasMore: start > 0 };
  }
  page(ask: PageAsk, limit: number) { return "newest" in ask ? this.newestPage(limit) : this.before(ask.before, limit); }
}

const unloaded = (): SeqTranscript => ({ messages: [], messagesUnloaded: true });
const live = (r: Message, newestSeq: number) => ({ kind: "live" as const, rows: [r], newestSeq, vouched: true });

/** Walk `nextPage` to the end, recording each ask and checking the state is `partial` before the last page. */
function walk(t: SeqTranscript, server: Thread, limit: number, max = 50): { t: SeqTranscript; asks: string[] } {
  const asks: string[] = [];
  for (let pages = 0; pages < max; pages++) {
    const ask = nextPage(t);
    if (!ask) return { t, asks };
    expect(transcriptState(t)).toBe("partial");
    asks.push("newest" in ask ? "newest" : ask.before);
    const before = t;
    t = applyTranscriptInput(t, server.page(ask, limit));
    // C4 strict progress: every page holds a number not held or vouches an unvouched row
    const heldBefore = new Set(before.messages.filter((m) => !m.unvouched).map((m) => m.seq));
    const progressed = t.messages.some((m) => !m.unvouched && !heldBefore.has(m.seq)) || t.tail !== before.tail;
    expect(progressed, `page ${asks.length} (${asks.at(-1)}) made no progress`).toBe(true);
  }
  throw new Error("walk did not end");
}

describe("r6 Q10 fixtures (one ordering key)", () => {
  it("1. split gap (Astra build r4 High 1): a live row inside a gap splits it, and the walk fills both halves; never complete at 150", () => {
    const server = new Thread(1);
    let t = applyTranscriptInput(unloaded(), server.newestPage(100));
    expect(transcriptState(t)).toBe("complete");
    while (server.newest < 201) server.write();
    t = applyTranscriptInput(t, server.newestPage(100));
    expect(seqs(t).slice(0, 2)).toEqual([1, 102]);
    // the delayed frame of m50
    t = applyTranscriptInput(t, live(server.rows[49]!, 201));
    expect(gapsOf(t).interior).toEqual([{ from: 51, to: 101 }, { from: 2, to: 49 }]);
    expect(nextPage(t)).toEqual({ before: "m102" });
    t = applyTranscriptInput(t, server.before("m102", 50));
    expect(seqs(t).slice(0, 4)).toEqual([1, 50, 52, 53]);
    expect(t.messages).toHaveLength(152);
    expect(transcriptState(t)).toBe("partial");
    expect(nextPage(t)).toEqual({ before: "m52" });
    // r7: the server does not know what is held: limit 50 before m52 is m2..m51, which closes (50,52) and (1,50) at once
    t = applyTranscriptInput(t, server.before("m52", 50));
    expect(ids(t)).toEqual(server.rows.map((r) => r.id));
    expect(transcriptState(t)).toBe("complete");
  });

  it("2. stall (Astra build r4 High 2): a frame past the newest held row never becomes the anchor; two pages complete 202", () => {
    const server = new Thread(201);
    let t = applyTranscriptInput(unloaded(), server.newestPage(100));
    expect(seqs(t)[0]).toBe(102);
    const x = server.write();
    t = applyTranscriptInput(t, live(x, 202));
    expect(t.messages.at(-1)!.id).toBe("m202");
    expect(nextPage(t)).toEqual({ before: "m102" });
    const walked = walk(t, server, 100);
    expect(walked.asks).toEqual(["m102", "m2"]);
    expect(transcriptState(walked.t)).toBe("complete");
    expect(walked.t.messages).toHaveLength(202);
  });

  it("3. ties, splices and a clock step back are irrelevant to order: each row holds at its number", () => {
    const server = new Thread(102);
    server.rows[0] = row(1, { at: 5 });
    server.rows[2] = row(3, { at: 5 });
    server.rows[60] = row(61, { at: 1 }); // earlier than its predecessor (a clock step back)
    let t = applyTranscriptInput(unloaded(), server.newestPage(100));
    expect(seqs(t)[0]).toBe(3);
    // the delayed frame of m1, whose `at` ties m3's: shown first
    t = applyTranscriptInput(t, live(server.rows[0]!, 102));
    expect(ids(t)[0]).toBe("m1");
    // a splice in front of m60 with a later `at` than every row: held at its number (room-transcript.ts places it on screen by its parent)
    const splice = server.write({ insertedBefore: "m60", at: 10_000 });
    t = applyTranscriptInput(t, live(splice, 103));
    expect(t.messages.at(-1)!.id).toBe("m103");
    expect(seqs(t)).toEqual([1, ...range(3, 103).map((m) => m.seq)]);
    // a frame whose `at` is earlier than its predecessor's holds at its number
    const early = server.write({ at: -1 });
    t = applyTranscriptInput(t, live(early, 104));
    expect(seqs(t).slice(-2)).toEqual([103, 104]);
    expect(nextPage(t)).toEqual({ before: "m3" });
    t = walk(t, server, 50).t;
    expect(transcriptState(t)).toBe("complete");
  });

  it("3b. hydrate: the tail is forgotten, held rows unvouched; the newest page over held 1..100 leaves (100,150) paged and every copy replaced", () => {
    const server = new Thread(100);
    let t = applyTranscriptInput(unloaded(), server.newestPage(100));
    expect(transcriptState(t)).toBe("complete");
    t = hydrateTranscript(t, true);
    expect(t.tail).toBeUndefined();
    expect(t.messages.every((m) => m.unvouched)).toBe(true);
    expect(nextPage(t)).toEqual({ newest: true });
    while (server.newest < 201) server.write();
    t = applyTranscriptInput(t, server.newestPage(52));
    expect(seqs(t).slice(99, 101)).toEqual([100, 150]);
    expect(nextPage(t)).toEqual({ before: "m150" });
    const walked = walk(t, server, 100);
    expect(transcriptState(walked.t)).toBe("complete");
    expect(walked.t.messages.some((m) => m.unvouched)).toBe(false);
    expect(ids(walked.t)).toEqual(server.rows.map((r) => r.id));
  });

  it("3c. an empty thread is complete with none; a new run drops every held row", () => {
    const t = applyTranscriptInput(unloaded(), { kind: "newest", rows: [], newestSeq: 0, vouched: true, hasMore: false });
    expect(transcriptState(t)).toBe("complete");
    expect(nextPage(t)).toBeUndefined();
    const held = applyTranscriptInput(unloaded(), new Thread(3).newestPage(100));
    const next = hydrateTranscript(held, false);
    expect(next).toMatchObject({ messages: [], messagesUnloaded: true });
    expect(next.numbered).toBeUndefined();
  });

  it("3d. a row without `seq` in a numbered run is a defect: dropped, and the newest page asked once", () => {
    const server = new Thread(5);
    let t = applyTranscriptInput(unloaded(), server.newestPage(100));
    expect(transcriptState(t)).toBe("complete");
    const { seq: _seq, ...bare } = row(6);
    expect(inputShape([bare], 6)).toBe("mixed");
    t = applyTranscriptInput(t, { kind: "live", rows: [bare], newestSeq: 6, vouched: true });
    expect(ids(t)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(nextPage(t)).toEqual({ newest: true });
    // `seq` without `newestSeq` is the same defect; so is a page whose numbers are not contiguous
    expect(inputShape([row(6)], undefined)).toBe("mixed");
    server.write();
    t = applyTranscriptInput(t, server.newestPage(100));
    expect(transcriptState(t)).toBe("complete");
    const holed = applyTranscriptInput(t, { kind: "newest", rows: [row(1), row(3)], newestSeq: 6, vouched: true });
    expect(nextPage(holed)).toEqual({ newest: true });
  });

  it("3e. a legacy server never makes a transcript complete", () => {
    const legacyRow = (n: number): Message => ({ id: `l${n}`, role: "bot", kind: "text", text: "", at: 0 });
    let t = applyTranscriptInput(unloaded(), { kind: "newest", rows: [legacyRow(1), legacyRow(2)], vouched: true, hasMore: false });
    expect(t.numbered).toBeUndefined();
    expect(ids(t)).toEqual(["l1", "l2"]);
    expect(transcriptState(t)).toBe("partial");
    expect(nextPage(t)).toBeUndefined();
    t = applyTranscriptInput(t, { kind: "live", rows: [legacyRow(3)], vouched: true });
    expect(ids(t)).toEqual(["l1", "l2", "l3"]);
    expect(transcriptState(t)).toBe("partial");
  });
});

describe("r7 fixtures", () => {
  it("(5) an old server's empty page: legacy, hasMore false, never complete", () => {
    const t = applyTranscriptInput(unloaded(), { kind: "newest", rows: [], vouched: true, hasMore: false });
    expect(t.messagesUnloaded).toBeUndefined();
    expect(t.numbered).toBeUndefined();
    expect(t.hasMore).toBe(false);
    expect(transcriptState(t)).toBe("partial");
    expect(nextPage(t)).toBeUndefined();
  });

  it("(6) missed patch: row 40 edited during the outage is re-fetched by the walk and its held copy replaced", () => {
    const server = new Thread(50);
    let t = applyTranscriptInput(unloaded(), server.newestPage(100));
    t = hydrateTranscript(t, true);
    server.rows[39] = row(40, { text: "edited while the stream was down" });
    for (let i = 0; i < 10; i++) server.write();
    const walked = walk(t, server, 50);
    expect(walked.asks).toEqual(["newest", "m11"]);
    expect(transcriptState(walked.t)).toBe("complete");
    expect(walked.t.messages[39]!.text).toBe("edited while the stream was down");
  });

  it("(7) the false-tail schedule (R4): a fresh answer carrying row 50 sets the tail to the server's 201; 101..201 are missing and paged", () => {
    const server = new Thread(100);
    let t = applyTranscriptInput(unloaded(), server.newestPage(100));
    while (server.newest < 201) server.write();
    t = hydrateTranscript(t, true);
    t = applyTranscriptInput(t, { kind: "patch", rows: [server.rows[49]!], newestSeq: 201, vouched: true });
    expect(t.tail).toBe(201);
    expect(gapsOf(t).tail).toEqual({ from: 101, to: 201 });
    expect(transcriptState(t)).toBe("partial");
    // a pre-floor answer sets nothing
    expect(applyTranscriptInput(hydrateTranscript(t, true), { kind: "patch", rows: [server.rows[49]!], newestSeq: 999, vouched: false }).tail).toBeUndefined();
    expect(vouches({ source: "http", sentAt: 5 }, 10)).toBe(false);
    expect(vouches({ source: "http", sentAt: 10 }, 10)).toBe(true);
    expect(vouches({ source: "stream" }, 10)).toBe(true);
    const walked = walk(t, server, 50);
    expect(transcriptState(walked.t)).toBe("complete");
  });
});

describe("r8 fixtures (suffix recovery, promotion)", () => {
  it("(9) case 1: hold 1..100, hydrate, vouched row 50 with newestSeq 201; the walk pages newest, two interior gaps, two unvouched runs", () => {
    const server = new Thread(100);
    let t = applyTranscriptInput(unloaded(), server.newestPage(100));
    while (server.newest < 201) server.write();
    t = hydrateTranscript(t, true);
    t = applyTranscriptInput(t, live(server.rows[49]!, 201));
    const steps: Array<[string, number[]]> = [];
    for (let pages = 0; pages < 10; pages++) {
      const ask = nextPage(t);
      if (!ask) break;
      const page = server.page(ask, 50);
      steps.push(["newest" in ask ? "newest" : ask.before, [page.rows[0]!.seq!, page.rows.at(-1)!.seq!]]);
      t = applyTranscriptInput(t, page);
    }
    expect(steps).toEqual([["newest", [152, 201]], ["m152", [102, 151]], ["m102", [52, 101]], ["m52", [2, 51]], ["m2", [1, 1]]]);
    expect(transcriptState(t)).toBe("complete");
    expect(t.messages).toHaveLength(201);
  });

  it("(10) case 2: hold 1..201 complete, hydrate, no later input: the newest page re-vouches the top run, then the walk refreshes down to 1", () => {
    const server = new Thread(201);
    let t = applyTranscriptInput(unloaded(), server.newestPage(201));
    expect(transcriptState(t)).toBe("complete");
    t = hydrateTranscript(t, true);
    expect(nextPage(t)).toEqual({ newest: true });
    const walked = walk(t, server, 50);
    expect(walked.asks).toEqual(["newest", "m152", "m102", "m52", "m2"]);
    expect(transcriptState(walked.t)).toBe("complete");
  });

  it("(11) client half: a patch from a pending thread stays legacy; the patch after the walk numbers the thread promotes the transcript", () => {
    const legacyRow = (n: number, text = `m${n}`): Message => ({ id: `m${n}`, role: "bot", kind: "text", text, at: 0 });
    let t = applyTranscriptInput(unloaded(), { kind: "newest", rows: [1, 2, 3, 4].map((n) => legacyRow(n)), vouched: true, hasMore: false });
    // patch row 2 while row 4 is still NULL: no seq, no newestSeq
    t = applyTranscriptInput(t, { kind: "patch", rows: [legacyRow(2, "edit 1")], vouched: true });
    expect(t.numbered).toBeUndefined();
    expect(t.messages[1]!.text).toBe("edit 1");
    // the next chunk numbers row 4; patch row 2 again: seq 2, newestSeq 4
    t = applyTranscriptInput(t, { kind: "patch", rows: [row(2, { text: "edit 2" })], newestSeq: 4, vouched: true });
    expect(t.numbered).toBe(true);
    expect(ids(t)).toEqual(["m2"]);
    expect(t.tail).toBe(4);
    expect(nextPage(t)).toEqual({ newest: true });
    const server = new Thread(4);
    server.rows[1] = row(2, { text: "edit 2" });
    t = applyTranscriptInput(t, server.newestPage(50));
    expect(ids(t)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(transcriptState(t)).toBe("complete");
    // a replayed pre-flip frame reaching the promoted transcript is dropped and the newest page asked once
    const replayed = applyTranscriptInput(t, { kind: "live", rows: [legacyRow(5)], vouched: true });
    expect(ids(replayed)).toEqual(ids(t));
    expect(nextPage(replayed)).toEqual({ newest: true });
  });
});

describe("holdRows (r6 Q3)", () => {
  it("is order-independent: a number is held once, an unvouched copy is replaced by a vouched one, a patch replaces by id", () => {
    const a = holdRows([], [row(3), row(1)], { vouched: true });
    const b = holdRows(holdRows([], [row(1)], { vouched: true }), [row(3)], { vouched: true });
    expect(a.map((m) => m.seq)).toEqual([1, 3]);
    expect(b.map((m) => m.seq)).toEqual([1, 3]);
    const old = holdRows([], [row(2, { text: "old" })], { vouched: false });
    expect(old[0]!.unvouched).toBe(true);
    expect(holdRows(old, [row(2, { text: "kept?" })], { vouched: false })[0]!.text).toBe("old");
    const fresh = holdRows(old, [row(2, { text: "new" })], { vouched: true });
    expect(fresh[0]).toMatchObject({ text: "new" });
    expect(fresh[0]!.unvouched).toBeUndefined();
    expect(holdRows(fresh, [row(2, { text: "held copy wins" })], { vouched: true })[0]!.text).toBe("new");
    expect(holdRows(fresh, [row(2, { text: "patched" })], { vouched: true, replace: true })[0]!.text).toBe("patched");
  });

  it("C5 (static): transcript-seq.ts reads no `at`, no clock and no `insertedBefore`", () => {
    const source = readFileSync(join(process.cwd(), "src/state/transcript-seq.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\.at\b/);
    expect(code).not.toMatch(/\bat\s*[:?]|\["at"\]/);
    expect(code).not.toMatch(/Date|performance|answerClock|setTimeout/);
    expect(code).not.toMatch(/insertedBefore/);
  });
});

describe("Astra build r5 (the two client Highs)", () => {
  const x101 = row(101, { id: "x101", text: "the pre-restore server's row 101" });
  const y101 = row(101, { id: "y101", text: "the current server's row 101" });

  it("H1: restore 1..100, an old answer X/101, then the current Y/101: Y is held, X goes, the transcript completes", () => {
    const restored = hydrateTranscript({ messages: range(1, 120), numbered: true, tail: 120 }, false);
    const server = new Thread(100);
    let t = applyTranscriptInput(restored, server.newestPage(100));
    expect(transcriptState(t)).toBe("complete");
    t = applyTranscriptInput(t, { kind: "live", rows: [x101], newestSeq: 101, vouched: false });
    server.rows.push(y101);
    t = applyTranscriptInput(t, live(y101, 101));
    expect(ids(t).slice(-2)).toEqual(["m100", "y101"]);
    expect(ids(t)).not.toContain("x101");
    expect(transcriptState(t)).toBe("complete");
  });

  it("H1: an unvouched number yields to the server's newest page for that number, and to a vouched frame after a same-run hydrate", () => {
    let t = hydrateTranscript({ messages: range(1, 100), numbered: true, tail: 100 }, true);
    t = applyTranscriptInput(t, { kind: "live", rows: [x101], newestSeq: 101, vouched: false });
    expect(ids(t)).toContain("x101");
    const server = new Thread(100);
    server.rows.push(y101);
    t = applyTranscriptInput(t, server.newestPage(50));
    expect(ids(t).slice(-1)).toEqual(["y101"]);
    expect(ids(t)).not.toContain("x101");
    expect(walk(t, server, 50).t.messages.map((m) => m.id)).toEqual(server.rows.map((m) => m.id));
    // a frame, too
    let u = hydrateTranscript({ messages: range(1, 100), numbered: true, tail: 100 }, true);
    u = applyTranscriptInput(u, { kind: "live", rows: [x101], newestSeq: 101, vouched: false });
    u = applyTranscriptInput(u, live(y101, 101));
    expect(u.messages.find((m) => m.seq === 101)?.id).toBe("y101");
  });

  it("H1: an unvouched copy of an id held at another number never blocks the vouched copy at its number", () => {
    const stale = holdRows([], [row(105, { id: "y" })], { vouched: false });
    const fresh = holdRows(stale, [row(101, { id: "y" })], { vouched: true });
    expect(fresh.map((m) => [m.id, m.seq, m.unvouched])).toEqual([["y", 101, undefined]]);
    // a vouched holder keeps its number against an unvouched copy elsewhere
    const kept = holdRows(fresh, [row(103, { id: "y" })], { vouched: false });
    expect(kept).toBe(fresh);
  });

  it("H1: once the tail is known an unvouched answer admits no row above it, so recovery never loops on the newest page", () => {
    const server = new Thread(100);
    let t = applyTranscriptInput(unloaded(), server.newestPage(100));
    const before = t;
    t = applyTranscriptInput(t, { kind: "live", rows: [x101], newestSeq: 101, vouched: false });
    expect(t).toBe(before);
    expect(nextPage(t)).toBeUndefined();
    // a new run starts legacy: an old answer does not promote it (no tail would bound its numbers); the first vouched numbered input does
    let u = hydrateTranscript({ messages: range(1, 100), numbered: true, tail: 100 }, false);
    u = applyTranscriptInput(u, { kind: "newest", rows: [{ ...row(1), seq: undefined }], vouched: true, hasMore: true });
    expect(applyTranscriptInput(u, { kind: "live", rows: [x101], newestSeq: 101, vouched: false })).toBe(u);
    u = walk(applyTranscriptInput(u, server.newestPage(50)), server, 50).t;
    expect(ids(u)).toEqual(server.rows.map((m) => m.id));
    expect(transcriptState(u)).toBe("complete");
  });

  const lrow = (n: number): Message => ({ id: `m${n}`, role: "bot", kind: "text", text: `m${n}`, at: 0 });
  /** A legacy thread on the server: rows m1..mn, pages by storage order, no numbers. */
  const legacyServer = (n: number) => {
    const rows = Array.from({ length: n }, (_, i) => lrow(i + 1));
    return {
      rows,
      before(id: string, limit: number) {
        const end = rows.findIndex((r) => r.id === id);
        const start = Math.max(0, end - limit);
        return { kind: "older" as const, rows: rows.slice(start, end), vouched: true, hasMore: start > 0, before: id };
      },
    };
  };
  const walkLegacy = (t: SeqTranscript, server: ReturnType<typeof legacyServer>, limit: number) => {
    for (let pages = 0; pages < 20; pages++) {
      const ask = nextPage(t);
      if (!ask) return t;
      if ("newest" in ask) throw new Error("legacy walk asked the newest page");
      t = applyTranscriptInput(t, server.before(ask.before, limit));
    }
    throw new Error("legacy walk did not end");
  };

  it("H2: hold m1, then a disjoint newer page m102..201 with hasMore: the gap m2..101 is recorded and paged until it closes", () => {
    const server = legacyServer(201);
    let t = applyTranscriptInput(unloaded(), { kind: "newest", rows: [lrow(1)], vouched: true, hasMore: false });
    t = applyTranscriptInput(t, { kind: "statement", rows: server.rows.slice(101), vouched: true, hasMore: true });
    expect(nextPage(t)).toEqual({ before: "m102" });
    t = walkLegacy(t, server, 50);
    expect(ids(t)).toEqual(server.rows.map((m) => m.id));
    expect(nextPage(t)).toBeUndefined();
    expect(transcriptState(t)).toBe("partial");
  });

  it("H2: a gap page that reaches the rows held below it closes the gap in one page; a live row meanwhile stays at the end", () => {
    const server = legacyServer(201);
    let t = applyTranscriptInput(unloaded(), { kind: "newest", rows: server.rows.slice(0, 10), vouched: true, hasMore: false });
    t = applyTranscriptInput(t, { kind: "newest", rows: server.rows.slice(101), vouched: true, hasMore: true });
    t = applyTranscriptInput(t, { kind: "live", rows: [lrow(202)], vouched: true });
    expect(nextPage(t)).toEqual({ before: "m102" });
    t = applyTranscriptInput(t, server.before("m102", 100));
    expect(ids(t)).toEqual([...server.rows, lrow(202)].map((m) => m.id));
    expect(nextPage(t)).toBeUndefined();
  });
});
