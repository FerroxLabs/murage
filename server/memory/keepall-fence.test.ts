// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 Keep all P0, Astra's two Highs, on the production functions over a fixture file:
// 1. a turn's own deny_generation bumps are recorded exactly, in the bump's own transaction: a rolled-back own bump leaves nothing behind,
//    so a later real revoke that lands on the same generation value is looked up, never taken for the turn's own write.
// 2. the room's last rebuild names its own replayed lines one by one and the send fence judges them by content, as it judges a prefix's
//    shown lines: an audience-only mark (an install-wide revoke) never refuses the final retry, a real mark still does, and lines of
//    other threads stay judged for the room's audience.
import { afterEach, describe, expect, it } from "vitest";
import { denyGeneration, denyLookup, fenceVerdict } from "./deny-read.ts";
import { addTurnParents, closeTurnLineage, currentLsn, openTurnLineage, writeSessionLineage } from "./lineage-write.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { buildPrompt, lineRefs, noneRef, ownReplayRefs, promptPart } from "./prompt-parts.ts";
import type { LineageRef } from "./lineage-types.ts";
import { CONTENT, MEMBER, OWNER, WritetimeFixture } from "./testing/writetime-fixture.ts";

const fixtures: WritetimeFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
const make = () => { const fixture = new WritetimeFixture(); fixtures.push(fixture); return fixture; };
const SHOWN = { state: "shown" };
const W = (reason: string) => ({ state: "withheld", reason });
const DENIED_PARENT: LineageRef = { kind: "memory", ref: { kind: "lesson", id: "l1" } };

describe("the send fence: a turn's own generation bumps (Astra 1.0.3 rollback High)", () => {
  it("a committed own bump passes; a rolled-back own bump followed by a real revoke on the same value is caught", () => {
    const f = make().reply("T", "q", 5).meta("deny_generation", 3);
    // a parent under a revoke: carrying it onto the turn's session row bumps deny_generation (revoke-commit.ts inheritMarks)
    f.denyMemory("lesson", "l1", 0, 1);

    const kept = openTurnLineage(f.db, { threadId: "T", turnId: "kept" });
    addTurnParents(kept, [DENIED_PARENT]);
    const keptPrompt = buildPrompt(kept, [promptPart("quote", [{ kind: "line", threadId: "T", messageId: "q" }])]);
    writeSessionLineage(f.db, { threadId: "T", driverInstance: "d", nativeSession: "kept" }, kept);
    expect(denyGeneration(f.db), "the turn's own session row bumped the generation").toBe(4);
    expect(fenceVerdict(f.db, keptPrompt, MEMBER), "the turn's own committed bump is not a revoke").toEqual(SHOWN);
    closeTurnLineage(kept);

    const turn = openTurnLineage(f.db, { threadId: "T", turnId: "rolled" });
    expect(turn.denyGeneration).toBe(4);
    addTurnParents(turn, [DENIED_PARENT]);
    const built = buildPrompt(turn, [promptPart("quote", [{ kind: "line", threadId: "T", messageId: "q" }])]);
    f.db.exec("BEGIN");
    writeSessionLineage(f.db, { threadId: "T", driverInstance: "d", nativeSession: "rolled" }, turn);
    expect(denyGeneration(f.db)).toBe(5);
    expect(fenceVerdict(f.db, built, MEMBER), "inside its transaction the bump is the turn's own").toEqual(SHOWN);
    f.db.exec("ROLLBACK");
    expect(denyGeneration(f.db), "the rollback restored the generation").toBe(4);
    expect(fenceVerdict(f.db, built, MEMBER)).toEqual(SHOWN);

    // a real revoke now marks the quoted line and moves the generation to the value the rolled-back bump had held
    f.denyLine("T", 5, 9).meta("deny_generation", 5);
    expect(fenceVerdict(f.db, built, MEMBER), "the stale own bump never stands in for the real revoke").toEqual(W("deny-line"));
    expect(fenceVerdict(f.db, built, CONTENT)).toEqual(W("deny-line"));
    closeTurnLineage(turn);
  });

  it("an own bump plus a real revoke on top is looked up again", () => {
    const f = make().reply("T", "q", 5).meta("deny_generation", 3);
    f.denyMemory("lesson", "l1", 0, 1);
    const turn = openTurnLineage(f.db, { threadId: "T", turnId: "t" });
    addTurnParents(turn, [DENIED_PARENT]);
    const built = buildPrompt(turn, [promptPart("quote", [{ kind: "line", threadId: "T", messageId: "q" }])]);
    writeSessionLineage(f.db, { threadId: "T", driverInstance: "d", nativeSession: "n" }, turn);
    expect(fenceVerdict(f.db, built, MEMBER)).toEqual(SHOWN);
    f.denyLine("T", 5, 9).meta("deny_generation", denyGeneration(f.db) + 1);
    expect(fenceVerdict(f.db, built, MEMBER)).toEqual(W("deny-line"));
    closeTurnLineage(turn);
  });
});

describe("the room's last rebuild: owner-room replay judged by content (Astra 1.0.3 room High)", () => {
  const audienceOnly = (f: WritetimeFixture, revoke: number) => f.db.prepare("INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)").run(revoke);

  it("after a global revoke marks historical replies and the generation moves before submission, the final retry passes without revoked content", () => {
    // the room R: historical replies g1 and g2; an install-wide revoke (audience-only, Keep all) marked g1; a real forget marked g2
    const f = make().owner("R", "o1", 1).reply("R", "g1", 2).reply("R", "g2", 3).owner("R", "o2", 4).reply("U", "x", 6).meta("deny_generation", 3);
    f.denyLine("R", 2, 7);
    audienceOnly(f, 7);
    f.denyLine("R", 3, 8);
    // what the room's build shows in words: content-judged lines only, so the forgotten reply g2 never reaches the prompt
    const judged = denyLookup(f.db, { threadId: "R", lines: [{ messageId: "g1", author: "generated" }, { messageId: "g2", author: "generated" }] }, CONTENT);
    expect(Object.fromEntries(judged)).toEqual({ g1: SHOWN, g2: W("deny-line") });
    const shownIds = ["o1", "o2", ...[...judged].filter(([, verdict]) => verdict.state === "shown").map(([id]) => id)];

    const turn = openTurnLineage(f.db, { threadId: "R", turnId: "member\u0000last" });
    const roomReader = OWNER;
    // index.ts room path, roomLastResort: the own lines one by one plus Murage's own words
    const finalRetry = buildPrompt(turn, [promptPart("room replay", [...ownReplayRefs("R", shownIds), noneRef("murage")])]);
    const before = buildPrompt(turn, [promptPart("room replay", [...lineRefs("R", shownIds), noneRef("murage")])]);
    f.meta("deny_generation", 4); // another revoke committed before submission
    expect(fenceVerdict(f.db, before, roomReader), "1.0.3 RC: audience-checked lines refused the valid replay").toEqual(W("deny-line"));
    expect(fenceVerdict(f.db, finalRetry, roomReader), "the final retry runs").toEqual(SHOWN);
    expect(fenceVerdict(f.db, finalRetry, MEMBER)).toEqual(SHOWN);

    // a real mark on a replayed line still refuses it
    const leaked = buildPrompt(turn, [promptPart("room replay", [...ownReplayRefs("R", ["g2"]), noneRef("murage")])]);
    expect(fenceVerdict(f.db, leaked, roomReader)).toEqual(W("deny-line"));

    // an external reference (a line of another thread) stays judged for the room's audience
    f.denyLine("U", 6, 7);
    const external = buildPrompt(turn, [promptPart("room replay", [...ownReplayRefs("R", shownIds), { kind: "line", threadId: "U", messageId: "x" }, noneRef("murage")])]);
    expect(fenceVerdict(f.db, external, roomReader)).toEqual(W("deny-line"));
    closeTurnLineage(turn);
  });
});

describe("a room turn after a revoke's commit keeps its post-commit history (1.0.3 rw-cap)", () => {
  it("the replay of lines whose turns began after the commit passes the fence while the install-wide window is open; a line of an earlier turn is held", () => {
    // the room R: an owner line and a reply written before anything; another thread U holds the line the owner regenerates
    const f = make().owner("R", "o1", 1).reply("R", "g0", 2).reply("U", "x", 3).meta("deny_generation", 3);
    const early = openTurnLineage(f.db, { threadId: "R", turnId: "member\u0000early" });
    // the owner's action: a content revoke (not audience-only) with an install-wide window, its marker not yet walked
    const R = commitRevoke(f.db, { kind: "line", threadId: "U", messageIds: ["x"], cause: "regenerate" }, { inline: false });
    expect(R).toBeGreaterThan(0);
    expect(f.db.prepare("SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id='*' AND revoke_id=?").get(R)).toEqual({ n: 1 });
    const cap = Number(f.db.prepare("SELECT started_lsn FROM memory_revoke_jobs WHERE revoke_id=?").get(R)!.started_lsn);
    // a reply of the turn begun before the commit, then the room's turns after it, each prompt built at the head of its time
    const lsn = () => currentLsn(f.db);
    f.reply("R", "pre", lsn(), { turnLsn: early.turnLsn });
    closeTurnLineage(early);
    for (const id of ["p1", "p2", "p3"]) { const head = lsn() - 1; expect(head).toBeGreaterThanOrEqual(cap); f.reply("R", id, lsn(), { turnLsn: head }); }
    const judged = Object.fromEntries(denyLookup(f.db, { threadId: "R", lines: ["g0", "pre", "p1", "p2", "p3"].map(messageId => ({ messageId, author: "generated" as const })) }, CONTENT));
    expect(judged).toEqual({ g0: SHOWN, pre: { state: "checking", reason: "pending" }, p1: SHOWN, p2: SHOWN, p3: SHOWN });

    // the next room turn replays its shown history; another revoke moves the generation before submission
    const turn = openTurnLineage(f.db, { threadId: "R", turnId: "member\u0000next" });
    const shownIds = ["o1", ...Object.entries(judged).filter(([, verdict]) => verdict.state === "shown").map(([id]) => id)];
    const replay = buildPrompt(turn, [promptPart("room replay", [...ownReplayRefs("R", shownIds), noneRef("murage")])]);
    f.meta("deny_generation", denyGeneration(f.db) + 1);
    expect(fenceVerdict(f.db, replay, OWNER), "no send fence refused (checking:pending) on post-commit history").toEqual(SHOWN);
    expect(fenceVerdict(f.db, replay, MEMBER)).toEqual(SHOWN);
    // the line of the turn begun before the commit still holds the send
    const withPre = buildPrompt(turn, [promptPart("room replay", [...ownReplayRefs("R", [...shownIds, "pre"]), noneRef("murage")])]);
    expect(fenceVerdict(f.db, withPre, OWNER)).toEqual({ state: "checking", reason: "pending" });
    closeTurnLineage(turn);
  });
});
