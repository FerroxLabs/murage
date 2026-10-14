// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy, S4 read side (DESIGN-WRITETIME 1 "The one read predicate", 3, and Opus section 6 cases a to q): denyLookup,
// memoryLookup, sessionLookup, refsLookup and fenceVerdict on exactly the marks the S1 writers and the S3 marker leave, written here
// directly. Also the read halves of revbound r3 A1-A6, F1 and F2. Every unknown reads "checking"; nothing unknown is ever shown.
import { afterEach, describe, expect, it } from "vitest";
import { denyGeneration, denyLookup, fenceVerdict, lineageLive, memoryLookup, refsLookup, sessionLookup } from "./deny-read.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import { FOOTPRINT_STAR, memoryRefKey, type LineageReader, type LineageVerdict, type PageLine, type TurnLineage } from "./lineage-types.ts";
import { CONTENT, MEMBER, OWNER, WritetimeFixture } from "./testing/writetime-fixture.ts";

const fixtures: WritetimeFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
const make = () => { const fixture = new WritetimeFixture(); fixtures.push(fixture); return fixture; };
const SHOWN = { state: "shown" };
const W = (reason: string) => ({ state: "withheld", reason });
const C = (reason: string) => ({ state: "checking", reason });
const gen = (...ids: string[]): PageLine[] => ids.map(messageId => ({ messageId, author: "generated" as const }));
const page = (f: WritetimeFixture, thread: string, lines: PageLine[], reader: LineageReader = CONTENT) => Object.fromEntries(denyLookup(f.db, { threadId: thread, lines }, reader));
const verdicts = (map: Map<string, LineageVerdict>) => Object.fromEntries(map);

describe("lines (denyLookup)", () => {
  it("(a) a forgotten message source withholds the line, owner lines included", () => {
    const f = make().owner("T", "o1", 1).reply("T", "g1", 2).owner("T", "o2", 3);
    f.tombstone("source", "message:T:o1").tombstone("source", "message:T:g1", 1);
    expect(page(f, "T", [{ messageId: "o1", author: "owner" }, ...gen("g1"), { messageId: "o2", author: "owner" }])).toEqual({ o1: W("tombstone"), g1: W("tombstone"), o2: SHOWN });
    // a deleted or denied captured source reads the same
    f.source("message:T:o2", "s-room", { thread: "T", message: "o2", state: "deleted" });
    expect(page(f, "T", [{ messageId: "o2", author: "owner" }]).o2).toEqual(W("tombstone"));
  });

  it("(b) the owner's hide flag withholds the line, from the stored row or from the caller", () => {
    const f = make().owner("T", "o1", 1, { withheldFromBots: true }).reply("T", "g1", 2).owner("T", "o2", 3);
    expect(page(f, "T", [{ messageId: "o1", author: "owner" }, { messageId: "g1", author: "generated", withheldFromBots: true }, { messageId: "o2", author: "person" }]))
      .toEqual({ o1: W("own-flag"), g1: W("own-flag"), o2: SHOWN });
  });

  it("owner and person lines never wait: no lineage row, thread not ready, pending, uncertified file", () => {
    const f = make().message("T", "o", "user").message("T", "p", "user").cert(false).ready("T", false).pending("T", 0).pending("*", 0);
    expect(page(f, "T", [{ messageId: "o", author: "owner" }, { messageId: "p", author: "person" }], MEMBER)).toEqual({ o: SHOWN, p: SHOWN });
  });

  it("a line any source says is generated is judged as generated (the caller's author, the stored role, the lineage row)", () => {
    const f = make().message("T", "u", "user").lineage("T", "u", 5, { generated: true }).message("T", "b", "bot");
    // a stored user row whose lineage row says generated, and a bot row the caller calls the owner's: both need their lineage
    f.pending("T", 1);
    expect(page(f, "T", [{ messageId: "u", author: "owner" }, { messageId: "b", author: "owner" }])).toEqual({ u: C("pending"), b: C("no-lineage") });
  });

  it("a line that is not stored is withheld (gone), never shown", () => {
    const f = make();
    expect(page(f, "T", [{ messageId: "x", author: "owner" }, ...gen("y")])).toEqual({ x: W("tombstone"), y: W("tombstone") });
  });

  it("(o) a generated line with no lineage row, or in a thread not ready, reads checking; a ready row of 0 wins over a ready certificate", () => {
    const f = make().message("T", "g0", "bot").reply("T", "g1", 2).reply("U", "u1", 3);
    expect(page(f, "T", gen("g0", "g1"))).toEqual({ g0: C("no-lineage"), g1: SHOWN });
    f.ready("T", false);
    expect(page(f, "T", gen("g1")).g1).toEqual(C("thread-not-ready"));
    expect(page(f, "U", gen("u1")).u1).toEqual(SHOWN);
  });

  it("(p) an upgraded file: certificate not ready -> checking until the certificate is ready (a thread's own ready row never makes it sooner)", () => {
    const f = make().reply("T", "g1", 2).reply("U", "u1", 3).cert(false);
    expect(page(f, "T", gen("g1")).g1).toEqual(C("thread-not-ready"));
    // S5 (lineage-backfill.ts): U1 and U2 are whole-file passes, so only the certificate proves a thread
    f.ready("U", true);
    expect(page(f, "U", gen("u1")).u1).toEqual(C("thread-not-ready"));
    f.cert(true);
    expect(page(f, "U", gen("u1")).u1).toEqual(SHOWN);
    expect(page(f, "T", gen("g1")).g1).toEqual(SHOWN);
  });

  it("deny_line withholds exactly the named line", () => {
    const f = make().reply("T", "g1", 2).reply("T", "g2", 3).denyLine("T", 2);
    expect(page(f, "T", gen("g1", "g2"))).toEqual({ g1: W("deny-line"), g2: SHOWN });
  });

  it("(m) deny_range: a generated line after the forgotten line, by a turn built before the forget's commit; a forget mid-turn covers the reply", () => {
    // forgotten owner line at lsn 10; commit at lsn 20 writes deny_range(T, 10, 20)
    const f = make().owner("T", "a", 10).reply("T", "before", 9, { turnLsn: 8 }).reply("T", "after", 12, { turnLsn: 11 })
      .reply("T", "midturn", 25, { turnLsn: 15 }).reply("T", "later", 30, { turnLsn: 21 }).denyRange("T", 10, 20).tombstone("source", "message:T:a");
    expect(page(f, "T", [{ messageId: "a", author: "owner" }, ...gen("before", "after", "midturn", "later")]))
      .toEqual({ a: W("tombstone"), before: SHOWN, after: W("deny-range"), midturn: W("deny-range"), later: SHOWN });
    // a generated line with no turn lsn counts from 0 (fail closed)
    f.reply("T", "noturn", 40, { turnLsn: null });
    expect(page(f, "T", gen("noturn")).noturn).toEqual(W("deny-range"));
  });

  it("past the read limit of ranges every generated line after the first range is withheld", () => {
    const f = make().reply("T", "old", 1).reply("T", "new", 1000, { turnLsn: 999 });
    for (let at = 0; at < 300; at++) f.denyRange("T", 2 + at, 3 + at, at + 1);
    expect(page(f, "T", gen("old", "new"))).toEqual({ old: SHOWN, new: W("deny-range") });
  });

  it("the pending window: a generated line at or after since(T), or since('*'), reads checking; older lines are shown", () => {
    const f = make().reply("T", "g1", 5).reply("T", "g2", 10).reply("U", "u1", 7).pending("T", 10);
    expect(page(f, "T", gen("g1", "g2"))).toEqual({ g1: SHOWN, g2: C("pending") });
    expect(page(f, "U", gen("u1")).u1).toEqual(SHOWN);
    f.pending("*", 6);
    expect(page(f, "U", gen("u1")).u1).toEqual(C("pending"));
    expect(page(f, "T", gen("g1")).g1).toEqual(SHOWN);
  });

  it("a withheld mark outranks checking", () => {
    const f = make().reply("T", "g1", 5).denyLine("T", 5).pending("T", 1).ready("T", false);
    expect(page(f, "T", gen("g1")).g1).toEqual(W("deny-line"));
  });

  it("(e) the watermark: an audience reader loses a line whose oldest receipt predates the last policy or epoch bump; content readers do not", () => {
    const f = make().reply("T", "stale", 20, { memLsn: 5 }).reply("T", "fresh", 21, { memLsn: 15 }).reply("T", "none", 22).meta("policy_bump_lsn", 10);
    expect(page(f, "T", gen("stale", "fresh", "none"), MEMBER)).toEqual({ stale: W("watermark"), fresh: SHOWN, none: SHOWN });
    expect(page(f, "T", gen("stale"), OWNER).stale).toEqual(W("watermark"));
    expect(page(f, "T", gen("stale"), CONTENT).stale).toEqual(SHOWN);
    f.meta("epoch_bump_lsn", 16);
    expect(page(f, "T", gen("fresh"), MEMBER).fresh).toEqual(W("watermark"));
  });

  it("(f, g) the footprint: a non-owner audience must hold every scope; `*` and an unreadable set read checking; the owner audience skips it", () => {
    const f = make().footprint(7, ["s-room"]).footprint(8, ["s-room", "s-secret"])
      .reply("T", "in", 1, { footprint: 7 }).reply("T", "out", 2, { footprint: 8 }).reply("T", "star", 3, { footprint: FOOTPRINT_STAR }).reply("T", "lost", 4, { footprint: 99 });
    expect(page(f, "T", gen("in", "out", "star", "lost"), MEMBER)).toEqual({ in: SHOWN, out: W("footprint"), star: C("footprint-wide"), lost: C("lookup-error") });
    expect(page(f, "T", gen("in", "out", "star", "lost"), OWNER)).toEqual({ in: SHOWN, out: SHOWN, star: SHOWN, lost: SHOWN });
    expect(page(f, "T", gen("out"), CONTENT).out).toEqual(SHOWN);
    // (g) marks still apply to the owner audience
    f.denyLine("T", 2);
    expect(page(f, "T", gen("out"), OWNER).out).toEqual(W("deny-line"));
  });

  it("(h, A1) a deleted conversation withholds every line, owner lines too, with no captured source (revbound r3 A1 / Fable P1-2)", () => {
    const f = make().owner("T", "o1", 1).reply("T", "g1", 2).deny("thread", "T");
    expect(page(f, "T", [{ messageId: "o1", author: "owner" }, ...gen("g1")])).toEqual({ o1: W("thread-deny"), g1: W("thread-deny") });
  });

  it("(d) a mark decides per thread: a receipt kept in its own thread (superseded checkpoint) leaves that thread's lines shown", () => {
    const f = make().reply("T", "own", 5, { memLsn: 4 }).reply("U", "other", 6, { memLsn: 4 }).denyLine("U", 6);
    expect(page(f, "T", gen("own"), MEMBER).own).toEqual(SHOWN);
    expect(page(f, "U", gen("other"), MEMBER).other).toEqual(W("deny-line"));
  });

  it("any error in the lookup reads checking", () => {
    const f = make().reply("T", "g1", 1);
    f.db.exec("DROP TABLE memory_deny_range");
    expect(page(f, "T", gen("g1"))).toEqual({ g1: C("lookup-error") });
  });
});

describe("memory objects (memoryLookup)", () => {
  const lookup = (f: WritetimeFixture, refs: Parameters<typeof memoryLookup>[1]) => verdicts(memoryLookup(f.db, refs, MEMBER));

  it("(c, l) deny_memory, record and source tombstones, deleted and denied sources, a deleted scope", () => {
    const f = make().source("s1", "s-room").source("s2", "s-room", { state: "deleted" }).source("s3", "s-other", { thread: "X" }).source("s4", "s-room")
      .record("r1", 1, "s-room", ["s1"]).record("r1", 2, "s-room", ["s1"]).record("r2", 1, "s-room", ["s1"]).record("r3", 1, "s-other", ["s1"])
      .denyMemory("record", "r1", 2).tombstone("record", "r2", null).tombstone("source", "s4", 1).deny("thread", "X").deny("scope", "s-other");
    expect(lookup(f, [{ kind: "record", id: "r1", version: 1 }, { kind: "record", id: "r1", version: 2 }, { kind: "record", id: "r2", version: 1 }, { kind: "record", id: "r3", version: 1 },
      { kind: "source", id: "s1", version: 1 }, { kind: "source", id: "s2" }, { kind: "source", id: "s3" }, { kind: "source", id: "s4", version: 1 }, { kind: "record", id: "gone", version: 1 }]))
      .toEqual({ "record:r1:1": SHOWN, "record:r1:2": W("deny-memory"), "record:r2:1": W("tombstone"), "record:r3:1": W("scope-deny"),
        "source:s1:1": SHOWN, "source:s2:0": W("tombstone"), "source:s3:0": W("scope-deny"), "source:s4:1": W("tombstone"), "record:gone:1": W("tombstone") });
    // version 0 marks every version
    f.denyMemory("lesson", "l1", 0).denyMemory("claim", "c1", 0);
    expect(lookup(f, [{ kind: "lesson", id: "l1", version: 3 }, { kind: "claim", id: "c1", version: 1 }])).toEqual({ "lesson:l1:3": W("deny-memory"), "claim:c1:1": W("deny-memory") });
  });

  it("(l, F1) the pending scope window: an object of a pending scope reads checking (created lsn unknown), as does every object under `*`", () => {
    // Fable P1-1: a promoted copy C (owner statement, no evidence, one derivation edge) of R; forget S under R: C is checking from the commit
    const f = make().source("S", "s-room").record("R", 1, "s-room", ["S"]).record("Cp", 1, "s-project", [], { assertion: "owner-statement" }).derive("R", 1, "Cp", 1)
      .record("Q", 1, "s-other", ["S"]);
    expect(lookup(f, [{ kind: "record", id: "Cp", version: 1 }])).toEqual({ "record:Cp:1": SHOWN });
    f.pendingScope("s-project", 4);
    expect(lookup(f, [{ kind: "record", id: "Cp", version: 1 }, { kind: "record", id: "Q", version: 1 }])).toEqual({ "record:Cp:1": C("pending"), "record:Q:1": SHOWN });
    f.pending("*", 4);
    expect(lookup(f, [{ kind: "record", id: "Q", version: 1 }])).toEqual({ "record:Q:1": C("pending") });
    // once the marker reaches C it is withheld, and the pending rows go
    f.db.exec("DELETE FROM memory_deny_pending; DELETE FROM memory_deny_pending_scope");
    f.denyMemory("record", "Cp", 0);
    expect(lookup(f, [{ kind: "record", id: "Cp", version: 1 }, { kind: "record", id: "Q", version: 1 }])).toEqual({ "record:Cp:1": W("deny-memory"), "record:Q:1": SHOWN });
  });

  it("a created_lsn column, when S3 adds it, decides the pending window: older objects are shown, newer and unknown ones checking", () => {
    const f = make();
    f.db.exec("ALTER TABLE memory_records ADD COLUMN created_lsn INTEGER");
    f.record("old", 1, "s-room").record("new", 1, "s-room").record("unknown", 1, "s-room").pendingScope("s-room", 50);
    f.db.exec("UPDATE memory_records SET created_lsn=10 WHERE id='old'; UPDATE memory_records SET created_lsn=60 WHERE id='new'");
    expect(lookup(f, [{ kind: "record", id: "old", version: 1 }, { kind: "record", id: "new", version: 1 }, { kind: "record", id: "unknown", version: 1 }]))
      .toEqual({ "record:old:1": SHOWN, "record:new:1": C("pending"), "record:unknown:1": C("pending") });
  });

  it("an object whose scope is unknown (a lesson, a claim) reads checking while any scope is pending", () => {
    const f = make();
    f.db.prepare("INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,created_at) VALUES('l1',1,'b','bot','note','x','typed','active',0)").run();
    expect(lookup(f, [{ kind: "lesson", id: "l1", version: 1 }])).toEqual({ "lesson:l1:1": SHOWN });
    f.pendingScope("s-anything", 3);
    expect(lookup(f, [{ kind: "lesson", id: "l1", version: 1 }, { kind: "claim", id: "c", version: 1 }])).toEqual({ "lesson:l1:1": C("pending"), "claim:c:1": C("pending") });
  });

  it("(A2) while a revoke is in flight, a source supporting a forgotten record is withheld; past the fan-in it reads checking", () => {
    // R has many versions on different sources; chunk record Cc cites the source behind R@500, which the commit did not tombstone yet
    const f = make().source("s500", "s-room").record("R", 500, "s-room", ["s500"]).record("Cc", 1, "s-room", ["s500"]).tombstone("record", "R", null);
    // no job in flight: the marks are complete (S3's drained state), the source itself is not marked
    expect(lookup(f, [{ kind: "source", id: "s500", version: 1 }])).toEqual({ "source:s500:1": SHOWN });
    f.revboundJobWaiting();
    expect(lookup(f, [{ kind: "source", id: "s500", version: 1 }])).toEqual({ "source:s500:1": W("tombstone") });
    // a v10 revoke in flight counts too; only a forget takes supporting sources (an archive or derived deny_memory mark does not)
    const g = make().source("s9", "s-room").record("R9", 1, "s-room", ["s9"]).tombstone("record", "R9", 1).source("s8", "s-room").record("R8", 1, "s-room", ["s8"])
      .denyMemory("record", "R8", 0).source("s7", "s-room").record("R7", 1, "s-room", ["s7"]).tombstone("record", "R7", null, "bot-deleted").pending("T", 1000);
    expect(lookup(g, [{ kind: "source", id: "s9", version: 1 }, { kind: "source", id: "s8", version: 1 }, { kind: "source", id: "s7", version: 1 }]))
      .toEqual({ "source:s9:1": W("tombstone"), "source:s8:1": SHOWN, "source:s7:1": SHOWN });
    // a popular source past the fan-in cannot be cleared while the job runs
    const h = make().source("pop", "s-room").pending("T", 1000);
    for (let at = 0; at < 70; at++) h.record(`x${at}`, 1, "s-room", ["pop"]);
    expect(lookup(h, [{ kind: "source", id: "pop", version: 1 }])).toEqual({ "source:pop:1": C("pending") });
  });

  it("(A6) an import admitted during the hash-tombstone window is withheld once the hash tombstone lands", () => {
    const f = make().source("import:a", "s-room", { kind: "legacy-import", hash: "H" }).source("import:b", "s-room", { kind: "legacy-import", hash: "K" });
    f.tombstone("import", "s-room", 3, "owner-forget", "H");
    expect(lookup(f, [{ kind: "source", id: "import:a" }, { kind: "source", id: "import:b" }])).toEqual({ "source:import:a:0": W("tombstone"), "source:import:b:0": SHOWN });
  });

  it("any error reads checking, per ref", () => {
    const f = make().record("r", 1, "s-room");
    f.db.exec("DROP TABLE memory_deny_memory");
    expect(lookup(f, [{ kind: "record", id: "r", version: 1 }])).toEqual({ "record:r:1": C("lookup-error") });
  });
});

describe("sessions (sessionLookup)", () => {
  const key = { threadId: "T", driverInstance: "d", nativeSession: "n" };
  it("(i) deny_session, rs-forgotten, a stale or revoked receipt and a deleted thread withhold; no lineage, not ready and pending read checking", () => {
    const f = make().sessionLineage("T", "d", "n", 1, 10);
    expect(sessionLookup(f.db, key, MEMBER)).toEqual(SHOWN);
    f.pending("T", 11);
    expect(sessionLookup(f.db, key, MEMBER)).toEqual(SHOWN);
    f.pending("*", 10);
    expect(sessionLookup(f.db, key, MEMBER)).toEqual(C("pending"));
    f.db.exec("DELETE FROM memory_deny_pending");
    f.ready("T", false);
    expect(sessionLookup(f.db, key, MEMBER)).toEqual(C("thread-not-ready"));
    f.ready("T", true);
    expect(sessionLookup(f.db, { ...key, nativeSession: "unknown" }, MEMBER)).toEqual(C("no-lineage"));
    f.receipt("b1", "T", "d", "n").receipt("b2", "T", "d", "n");
    expect(sessionLookup(f.db, key, MEMBER)).toEqual(SHOWN);
    f.db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
    expect(sessionLookup(f.db, key, MEMBER)).toEqual(W("watermark"));
    f.db.exec("UPDATE memory_disclosures SET policy_revision=(SELECT policy_revision FROM memory_meta)");
    f.db.exec("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='b2'");
    expect(sessionLookup(f.db, key, MEMBER)).toEqual(W("deny-session"));
    f.db.exec("UPDATE memory_disclosures SET state='delivered'");
    f.db.prepare("INSERT INTO memory_session_roots(thread_id,driver_instance,native_session,set_id) VALUES('T','d','n','rs-forgotten')").run();
    expect(sessionLookup(f.db, key, MEMBER)).toEqual(W("session-forgotten"));
    f.db.exec("DELETE FROM memory_session_roots");
    f.denySession("T", "d", "n");
    expect(sessionLookup(f.db, key, MEMBER)).toEqual(W("deny-session"));
    f.deny("thread", "T");
    expect(sessionLookup(f.db, key, MEMBER)).toEqual(W("thread-deny"));
  });
});

describe("refs and the send fence", () => {
  it("(h, k, n, A3) line refs: a copy's original, a hand-off result, a carried line; gone originals and positional originals are withheld", () => {
    // A3: B repeats A's secret in T; B is mirrored into U; forget A: B is withheld by its range, and so is a ref to B from the mirror
    const f = make().owner("T", "A", 10).reply("T", "B", 12, { turnLsn: 11 }).reply("U", "copyB", 13, { turnLsn: 12 }).denyRange("T", 10, 20).tombstone("source", "message:T:A");
    expect(refsLookup(f.db, [{ kind: "line", threadId: "T", messageId: "B" }], MEMBER)).toEqual(W("deny-range"));
    expect(refsLookup(f.db, [{ kind: "line", threadId: "T", messageId: "A" }], MEMBER)).toEqual(W("tombstone"));
    expect(refsLookup(f.db, [{ kind: "line", threadId: "T", messageId: "gone" }], MEMBER)).toEqual(W("tombstone"));
    // in the window before the marker reaches the mirror, the mirror itself reads checking ('*' pending from the root's lsn)
    f.pending("*", 10);
    expect(page(f, "U", gen("copyB"), MEMBER).copyB).toEqual(C("pending"));
    // an owner line referenced by a ref is judged as an owner line (no lineage needed)
    const g = make().message("V", "own", "user");
    expect(refsLookup(g.db, [{ kind: "line", threadId: "V", messageId: "own" }], MEMBER)).toEqual(SHOWN);
  });

  it("(n) prefix refs: deleted thread withheld; not ready, or pending at or before the head, checking", () => {
    const f = make();
    expect(refsLookup(f.db, [{ kind: "prefix", threadId: "P", headLsn: 50 }], MEMBER)).toEqual(SHOWN);
    f.pending("P", 60);
    expect(refsLookup(f.db, [{ kind: "prefix", threadId: "P", headLsn: 50 }], MEMBER)).toEqual(SHOWN);
    expect(refsLookup(f.db, [{ kind: "prefix", threadId: "P" }], MEMBER)).toEqual(C("pending"));
    f.ready("P", false);
    expect(refsLookup(f.db, [{ kind: "prefix", threadId: "P", headLsn: 50 }], MEMBER)).toEqual(C("thread-not-ready"));
    f.deny("thread", "P");
    expect(refsLookup(f.db, [{ kind: "prefix", threadId: "P", headLsn: 50 }], MEMBER)).toEqual(W("thread-deny"));
  });

  it("(q, e, f) receipt refs: revoked, stale and out-of-scope receipts; the worst verdict over mixed refs; none and empty are shown", () => {
    const f = make().receipt("b1", "T", "d", "n").receipt("b2", "T", "d", "n", { state: "revoked" }).source("s1", "s-room").record("r1", 1, "s-room", ["s1"]).reply("T", "g", 5);
    const ok = { kind: "receipt" as const, bundleId: "b1", lsn: 5, scopeIds: ["s-room"] };
    expect(refsLookup(f.db, [], MEMBER)).toEqual(SHOWN);
    expect(refsLookup(f.db, [{ kind: "none", reason: "static" }], MEMBER)).toEqual(SHOWN);
    expect(refsLookup(f.db, [ok, { kind: "memory", ref: { kind: "record", id: "r1", version: 1 } }, { kind: "line", threadId: "T", messageId: "g" }], MEMBER)).toEqual(SHOWN);
    expect(refsLookup(f.db, [{ ...ok, bundleId: "b2" }], CONTENT)).toEqual(W("deny-memory"));
    expect(refsLookup(f.db, [{ ...ok, bundleId: "missing" }], MEMBER)).toEqual(C("lookup-error"));
    expect(refsLookup(f.db, [{ ...ok, scopeIds: ["s-secret"] }], MEMBER)).toEqual(W("footprint"));
    expect(refsLookup(f.db, [{ ...ok, scopeIds: ["s-secret"] }], OWNER)).toEqual(SHOWN);
    f.meta("epoch_bump_lsn", 6);
    expect(refsLookup(f.db, [ok], MEMBER)).toEqual(W("watermark"));
    expect(refsLookup(f.db, [ok], CONTENT)).toEqual(SHOWN);
    // worst over mixed: checking from one, shown from the others
    f.pending("T", 1);
    expect(refsLookup(f.db, [{ kind: "memory", ref: { kind: "record", id: "r1", version: 1 } }, { kind: "line", threadId: "T", messageId: "g" }], CONTENT)).toEqual(C("pending"));
  });

  it("(j) the send fence: an unmoved generation passes; a moved one re-runs the lookups and fails only on a denied or pending part", () => {
    const f = make().reply("T", "q", 5).meta("deny_generation", 3);
    const turn: TurnLineage = { threadId: "T", turnId: "t", turnLsn: 6, parents: [], denyGeneration: 3 };
    const built = buildPrompt(turn, [promptPart("quote", [{ kind: "line", threadId: "T", messageId: "q" }]), promptPart("hi", [{ kind: "none", reason: "owner-turn" }])]);
    expect(denyGeneration(f.db)).toBe(3);
    expect(fenceVerdict(f.db, built, MEMBER)).toEqual(SHOWN);
    f.denyLine("T", 5);
    expect(fenceVerdict(f.db, built, MEMBER)).toEqual(SHOWN); // generation unmoved: the marker bumps it with its marks
    f.meta("deny_generation", 4);
    expect(fenceVerdict(f.db, built, MEMBER)).toEqual(W("deny-line"));
    f.db.exec("DELETE FROM memory_deny_line");
    expect(fenceVerdict(f.db, built, MEMBER)).toEqual(SHOWN);
    // a prompt built outside a turn (generation -1) is always re-checked; an unreadable generation is checking
    const loose = buildPrompt(undefined, [promptPart("quote", [{ kind: "line", threadId: "T", messageId: "q" }])]);
    f.pending("T", 5);
    expect(fenceVerdict(f.db, loose, MEMBER)).toEqual(C("pending"));
    f.db.exec("DELETE FROM memory_lineage_lsn_meta WHERE key='deny_generation'");
    expect(fenceVerdict(f.db, built, MEMBER)).toEqual(C("lookup-error"));
  });

  it("lineageLive turns on with the first line row written, not with an lsn a setting change took", () => {
    const f = make();
    expect(lineageLive(f.db)).toBe(false);
    // the v10 watermark trigger takes an lsn on a policy bump: no line is written, the read-time judge still decides alone
    f.db.prepare("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1").run();
    expect(Number(f.db.prepare("SELECT next FROM memory_lsn WHERE id=1").get()!.next)).toBeGreaterThan(1);
    expect(lineageLive(f.db)).toBe(false);
    f.reply("T", "g", 1);
    expect(lineageLive(f.db)).toBe(true);
  });

  it("memoryRefKey is the key of every memoryLookup entry", () => {
    const f = make().record("r", 1, "s-room");
    const refs = [{ kind: "record" as const, id: "r", version: 1 }, { kind: "source" as const, id: "nope" }];
    expect([...memoryLookup(f.db, refs, OWNER).keys()]).toEqual(refs.map(memoryRefKey));
  });
});
