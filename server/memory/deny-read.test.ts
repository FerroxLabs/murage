// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy, S4 read side (DESIGN-WRITETIME 1 "The one read predicate", 3, and Opus section 6 cases a to q): denyLookup,
// memoryLookup, sessionLookup, refsLookup and fenceVerdict on exactly the marks the S1 writers and the S3 marker leave, written here
// directly. Also the read halves of revbound r3 A1-A6, F1 and F2. Every unknown reads "checking"; nothing unknown is ever shown.
import { afterEach, describe, expect, it } from "vitest";
import { denyGeneration, denyLookup, fenceVerdict, lineageLive, memoryLookup, refsLookup, sessionLookup } from "./deny-read.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import { FOOTPRINT_STAR, memoryRefKey, type LineageReader, type MemoryRef, type LineageVerdict, type PageLine, type TurnLineage } from "./lineage-types.ts";
import { CONTENT, MEMBER, OWNER, WritetimeFixture } from "./testing/writetime-fixture.ts";
import { activateRevokesAtUpgrade } from "./schema.ts";

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

  describe("the pending window is capped at the revoke's commit (1.0.3 rw-cap): a line of a turn begun after it is outside the window", () => {
    it("a '*' row holds a line whose turn began before the commit, never one begun at or after it", () => {
      // revoke 4 committed at slot 20, its window from 10: g1's turn began before (19), g2's at the commit (20), g3's after (25)
      const f = make().job(4, 20).pending("*", 10, 4).reply("T", "g1", 21, { turnLsn: 19 }).reply("T", "g2", 22, { turnLsn: 20 }).reply("T", "g3", 26, { turnLsn: 25 });
      expect(page(f, "T", gen("g1", "g2", "g3"))).toEqual({ g1: C("pending"), g2: SHOWN, g3: SHOWN });
      expect(page(f, "T", gen("g1", "g2", "g3"), MEMBER)).toEqual({ g1: C("pending"), g2: SHOWN, g3: SHOWN });
    });
    it("a line older than the window is shown whatever its turn", () => {
      const f = make().job(4, 20).pending("*", 10, 4).reply("T", "old", 9, { turnLsn: 3 });
      expect(page(f, "T", gen("old")).old).toEqual(SHOWN);
    });
    it("a line with no turn lsn (a pre-v10 line) counts its turn from 0 and stays held", () => {
      const f = make().job(4, 20).pending("*", 10, 4).reply("T", "legacy", 30, { turnLsn: null });
      expect(page(f, "T", gen("legacy")).legacy).toEqual(C("pending"));
    });
    it("a bulk still seeding has no cap: every line in its window is held", () => {
      const f = make().job(4, 20, "seeding").pending("*", 10, 4).reply("T", "late", 40, { turnLsn: 39 });
      expect(page(f, "T", gen("late")).late).toEqual(C("pending"));
    });
    it("a pending row with no job row has no cap (fail closed)", () => {
      const f = make().pending("*", 10, 4).reply("T", "late", 40, { turnLsn: 39 });
      expect(page(f, "T", gen("late")).late).toEqual(C("pending"));
    });
    it("a thread-specific flow or inherit row of a revoke takes the same cap", () => {
      const f = make().job(4, 20).pending("T", 10, 4).reply("T", "before", 21, { turnLsn: 15 }).reply("T", "after", 31, { turnLsn: 30 });
      expect(page(f, "T", gen("before", "after"))).toEqual({ before: C("pending"), after: SHOWN });
    });
    it("a hold written after the commit (an inherit hold for a derived post-commit line, since past the cap) has no cap", () => {
      // revoke 4 committed at 20; the line at 31 (turn 30) carried a parent it holds: inheritMarks held T from 31 under revoke 4
      const f = make().job(4, 20).pending("*", 10, 4).pending("T", 31, 4).reply("T", "derived", 31, { turnLsn: 30 }).reply("T", "clean", 28, { turnLsn: 27 });
      expect(page(f, "T", gen("derived", "clean"))).toEqual({ derived: C("pending"), clean: SHOWN });
    });
    it("a line written over a merged turn carries the lowest turn lsn (lineage-write.ts): held when the earliest merged turn began before the commit", () => {
      // turns began at 15 and 25 around revoke 4's commit at 20: the merged line stores 15 and is held; a line of the later turn alone is shown
      const f = make().job(4, 20).pending("*", 10, 4).reply("T", "merged", 27, { turnLsn: Math.min(15, 25) }).reply("T", "later", 28, { turnLsn: 25 });
      expect(page(f, "T", gen("merged", "later"))).toEqual({ merged: C("pending"), later: SHOWN });
    });
    it("a revoke active when a 1.0.2 file is upgraded moves to the upgrade's slot: a reply 1.0.2 wrote after its old cap reads checking (Revision 3b)", () => {
      // bulk 4 was activated by 1.0.2 at slot 20; 1.0.2 then wrote a reply in T whose turn began at 25, which the walk can still mark
      const f = make().pending("*", 10, 4).denyRange("U", 5, 30, 4).reply("T", "mid", 27, { turnLsn: 25 });
      f.db.prepare(`INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(4,'bulk','{"kind":"bulk","cause":"u2"}',5,20,'flow','','active'),(6,'bulk','{"kind":"bulk","cause":"u2"}',20,20,'flow','','seeding')`).run();
      const generation = denyGeneration(f.db), slot = Number(f.db.prepare("SELECT next FROM memory_lsn WHERE id=1").get()!.next);
      // the v10 to v12 step of migrateMemorySchema (revoke-upgrade-activation.test.ts runs it through the real upgrade)
      activateRevokesAtUpgrade(f.db);
      expect(f.db.prepare("SELECT revoke_id,started_lsn FROM memory_revoke_jobs ORDER BY revoke_id").all().map(row => [Number(row.revoke_id), Number(row.started_lsn)])).toEqual([[4, slot], [6, 20]]);
      expect(denyGeneration(f.db)).toBe(generation + 1);
      f.reply("T", "late", slot + 2, { turnLsn: slot + 1 });
      expect(page(f, "T", gen("mid", "late"))).toEqual({ mid: C("pending"), late: SHOWN });
    });
    it("each window keeps its own cap: an older revoke's later commit does not lift a newer one's hold", () => {
      // revoke 4 (since 10, cap 20) and revoke 5 (since 12, cap 35): a line of turn 25 is outside 4's window but inside 5's
      const f = make().job(4, 20).job(5, 35).pending("*", 10, 4).pending("*", 12, 5).reply("T", "mid", 26, { turnLsn: 25 }).reply("T", "late", 37, { turnLsn: 36 });
      expect(page(f, "T", gen("mid", "late"))).toEqual({ mid: C("pending"), late: SHOWN });
    });
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

  it.each(["policy_bump_lsn", "epoch_bump_lsn"] as const)("owner result delivery skips only %s and cannot exempt a non-owner", key => {
    const f = make().reply("T", "reply", 20, { memLsn: 5 }).meta(key, 10);
    const input = { threadId: "T", lines: gen("reply") };
    expect(denyLookup(f.db, input, OWNER).get("reply")).toEqual(W("watermark"));
    expect(denyLookup(f.db, input, OWNER, { ownerOwnChat: true }).get("reply")).toEqual(SHOWN);
    expect(denyLookup(f.db, input, MEMBER, { ownerOwnChat: true }).get("reply")).toEqual(W("watermark"));
  });

  it.each(["line", "range", "pending"] as const)("owner result delivery still applies audience-only %s marks", kind => {
    const f = make().reply("T", "reply", 20, { memLsn: 5 }).meta("policy_bump_lsn", 10);
    f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(1)").run();
    if (kind === "line") f.denyLine("T", 20);
    if (kind === "range") f.denyRange("T", 1, 30);
    if (kind === "pending") f.pending("T", 1);
    const input = { threadId: "T", lines: gen("reply") };
    expect(denyLookup(f.db, input, CONTENT).get("reply")).toEqual(SHOWN);
    expect(denyLookup(f.db, input, OWNER, { ownerOwnChat: true }).get("reply"))
      .toEqual(kind === "pending" ? C("pending") : W(`deny-${kind}`));
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

  it("a stored \"checking\" (left on disk by 1.0.2 or an earlier process: a restart before the drain) is no note: a plain row and a copy are judged live (R2)", () => {
    // rehearsal 4 on 1.0.3: a reply noted "checking" in the `*` pending window of the upgrade's revoke read its own note back as "checking"
    // for good once the revoke had drained, through every reader and every later turn. "checking" is now never stored; one found on disk
    // is read as no note, and the line's own marks and windows decide, as they do for a row with no note at all.
    const DOOR = { audience: { owner: false, scopeIds: ["s-room", "s-bot"] }, ownFlag: false } as const;
    const f = make().message("T", "n1", "bot", { withheldFromBots: "checking" }).lineage("T", "n1", 10, { generated: true, turnLsn: 9 })
      .message("T", "c1", "bot", { withheldFromBots: "checking", copyOf: { threadId: "U", messageIds: ["u1"] } }).lineage("T", "c1", 11, { generated: true, turnLsn: 9 })
      .reply("T", "g1", 12, { turnLsn: 9 })
      .pending("*", 5).job(1, 100);
    // in the window every one of them reads checking, live, from the window (the same as the unnoted row g1)
    for (const reader of [CONTENT, MEMBER, OWNER, DOOR]) expect(page(f, "T", gen("n1", "c1", "g1"), reader)).toEqual({ n1: C("pending"), c1: C("pending"), g1: C("pending") });
    // drained (and this process never saw the note written: nothing in memory): all three are shown on their clean lineage
    f.db.exec("DELETE FROM memory_deny_pending; UPDATE memory_revoke_jobs SET state='done'");
    for (const reader of [CONTENT, MEMBER, OWNER, DOOR]) expect(page(f, "T", gen("n1", "c1", "g1"), reader)).toEqual({ n1: SHOWN, c1: SHOWN, g1: SHOWN });
    // a mark still withholds a noted row (fail closed): a line that used revoked content never shows on a stale note
    f.denyLine("T", 10).denyLine("T", 11);
    expect(page(f, "T", gen("n1", "c1"), MEMBER)).toEqual({ n1: W("deny-line"), c1: W("deny-line") });
    // the owner's own flag, and the caller's, keep their meaning on a noted row
    expect(page(f, "T", [{ messageId: "g1", author: "generated", withheldFromBots: true }], MEMBER)).toEqual({ g1: W("own-flag") });
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

  it("(l, F1) the pending scope window: an object of a pending scope made at or after its since reads checking, as does every object under `*`", () => {
    // Fable P1-1: a promoted copy C (owner statement, no evidence, one derivation edge) of R; forget S under R: C is checking from the commit.
    // Nothing derived is older than its root (revoke-commit.ts scopeSince), so the root and all of it are stamped at or after the since (1.0.7 D1).
    const f = make();
    f.db.exec("UPDATE memory_lsn SET next=4 WHERE id=1");
    f.source("S", "s-room").record("R", 1, "s-room", ["S"]).record("Cp", 1, "s-project", [], { assertion: "owner-statement" }).derive("R", 1, "Cp", 1)
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

  it("the version's created lsn (memory_record_lsn) decides the pending window: older objects are shown, newer ones checking; an unstamped one is bounded by lineage_upgrade_lsn, unknown with no key", () => {
    const f = make();
    f.record("old", 1, "s-room").record("new", 1, "s-room").record("unknown", 1, "s-room").pendingScope("s-room", 50);
    f.db.exec("UPDATE memory_record_lsn SET created_lsn=10 WHERE id='old'; UPDATE memory_record_lsn SET created_lsn=60 WHERE id='new'; DELETE FROM memory_record_lsn WHERE id='unknown'");
    f.meta("lineage_upgrade_lsn", 50);
    const refs: MemoryRef[] = [{ kind: "record", id: "old", version: 1 }, { kind: "record", id: "new", version: 1 }, { kind: "record", id: "unknown", version: 1 }];
    expect(lookup(f, refs)).toEqual({ "record:old:1": SHOWN, "record:new:1": C("pending"), "record:unknown:1": C("pending") });
    f.meta("lineage_upgrade_lsn", 49);
    expect(lookup(f, refs)).toEqual({ "record:old:1": SHOWN, "record:new:1": C("pending"), "record:unknown:1": SHOWN });
    f.db.exec("DELETE FROM memory_lineage_lsn_meta WHERE key='lineage_upgrade_lsn'");
    expect(lookup(f, refs)).toEqual({ "record:old:1": SHOWN, "record:new:1": C("pending"), "record:unknown:1": C("pending") });
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

// 1.0.2 Keep all P0 (F1): a roster or settings change flips every receipt (an audience-only revoke, memory_revoke_audience). The owner's own
// direct chat is a content reader: those marks change what other audiences may be shown, never what the owner's chat holds, so its session
// is not reset by them. 1.0.2 counted them for every reader and reset the owner's session on every turn after Keep all.
describe("sessions: the owner's content reader and audience-only revokes", () => {
  const key = { threadId: "T", driverInstance: "d", nativeSession: "n" };
  const audienceOnly = (f: WritetimeFixture, revoke: number) => f.db.prepare("INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)").run(revoke);
  it("audience-only deny_session, pending and receipt flips: shown for the content reader, withheld or checking for an audience reader", () => {
    const f = make().owner("T", "o1", 1).reply("T", "g1", 2, { turnLsn: 1 }).sessionLineage("T", "d", "n", 1, 10);
    audienceOnly(f, 7);
    f.denySession("T", "d", "n", 7);
    expect(sessionLookup(f.db, key, CONTENT)).toEqual(SHOWN);
    expect(sessionLookup(f.db, key, MEMBER)).toEqual(W("deny-session"));
    expect(sessionLookup(f.db, key, OWNER)).toEqual(W("deny-session"));
    f.db.exec("DELETE FROM memory_deny_session");
    f.pending("T", 5, 7).pending("*", 3, 7);
    expect(sessionLookup(f.db, key, CONTENT)).toEqual(SHOWN);
    expect(sessionLookup(f.db, key, MEMBER)).toEqual(C("pending"));
    f.db.exec("DELETE FROM memory_deny_pending");
    // a receipt flipped and not yet committed by the marker (memory_receipt_flips): audience-only too
    const no = Number(f.db.prepare("SELECT no FROM memory_thread_no WHERE thread_id='T'").get()!.no);
    f.db.prepare("INSERT INTO memory_receipt_flips(thread_no,first_lsn,bundle_id) VALUES(?,?,?)").run(no, 2, "flipped");
    expect(sessionLookup(f.db, key, CONTENT)).toEqual(SHOWN);
    expect(sessionLookup(f.db, key, MEMBER)).toEqual(C("pending"));
    f.db.exec("DELETE FROM memory_receipt_flips");
    // the session's own revoked receipt: the content reader leaves it to the continuation check (state, policy, epoch), an audience reader withholds
    f.receipt("b1", "T", "d", "n", { state: "revoked" });
    expect(sessionLookup(f.db, key, CONTENT)).toEqual(SHOWN);
    expect(sessionLookup(f.db, key, MEMBER)).toEqual(W("deny-session"));
  });
  it("a revoke that is not audience-only still resets the owner's session", () => {
    const f = make().owner("T", "o1", 1).sessionLineage("T", "d", "n", 1, 10);
    f.denySession("T", "d", "n", 9);
    expect(sessionLookup(f.db, key, CONTENT)).toEqual(W("deny-session"));
    f.db.exec("DELETE FROM memory_deny_session");
    f.pending("T", 5, 9);
    expect(sessionLookup(f.db, key, CONTENT)).toEqual(C("pending"));
    f.db.exec("DELETE FROM memory_deny_pending");
    f.deny("thread", "T");
    expect(sessionLookup(f.db, key, CONTENT)).toEqual(W("thread-deny"));
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

  it("(01-B2) a non-owner room prefix's shown lines are rechecked by the audience reader at the fence: a policy bump after the build refuses once the pending rows are tidied", () => {
    const f = make().reply("T", "old", 20, { memLsn: 5 }).meta("deny_generation", 3);
    const turn: TurnLineage = { threadId: "T", turnId: "t", turnLsn: 30, parents: [], denyGeneration: 3 };
    const prefix = (extra: object = {}) => buildPrompt(turn, [promptPart("room transcript", [{ kind: "prefix", threadId: "T", headLsn: 30, shown: ["old"], ...extra }])]);
    expect(fenceVerdict(f.db, prefix(), MEMBER)).toEqual(SHOWN);
    f.meta("policy_bump_lsn", 10).meta("deny_generation", 4); // the owner changed memory settings; no pending row is left (tidy ran)
    expect(fenceVerdict(f.db, prefix(), MEMBER)).toEqual(W("watermark"));
    // the owner-audience room (content: true) and a content reader keep the content recheck: the watermark never holds them
    expect(fenceVerdict(f.db, prefix({ content: true }), MEMBER)).toEqual(SHOWN);
    expect(fenceVerdict(f.db, prefix(), CONTENT)).toEqual(SHOWN);
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
