// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// designs/SEND-FENCE-RECEIPT-RACE.md (lee-phantom f-room-after-window). In a room whose whole audience is the owner (roomOwnerAudience)
// the room's own transcript is read by content at the send fence (index.ts room prefix `content: true`, 1.0.3 M1). The originals of a
// teammate's reply COPIED into that transcript (a delegate or ask result row, copyOf) used to be plain `line` refs judged for the room's
// audience: after an install-wide receipt revoke (a memory settings change, an import, a roster change) every room turn whose
// deny_generation moved between its start and its send was refused on them, rebuilt with the same refs, refused again, and ended as
// "could not start this reply" (R1 at 203fdbdcd fails every time). They are now judged by the reader that judged the copy: content when
// the room's own thread is read by content. Content marks still refuse; every other room and every quoted line keep the audience reader.
import { afterEach, describe, expect, it } from "vitest";
import { fenceVerdict } from "./deny-read.ts";
import { closeTurnLineage, openTurnLineage } from "./lineage-write.ts";
import { buildPrompt, crossThreadLineageRefs, promptPart, type PromptShownLine } from "./prompt-parts.ts";
import type { LineageReader, LineageRef } from "./lineage-types.ts";
import { CONTENT, MEMBER, OWNER, WritetimeFixture } from "./testing/writetime-fixture.ts";

const fixtures: WritetimeFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
const SHOWN = { state: "shown" };
const AUDIENCE_REVOKE = 7, CONTENT_REVOKE = 8;
const COPY: PromptShownLine = { threadId: "R", id: "copy", copyOf: { threadId: "H", messageIds: ["orig"] } };

/** Helper thread H holds the teammate's reply `orig` (made with memory); room R holds its copy `copy` (copyOf H/orig). `origin` and `copy`
 * say which revoke marks each: an audience-only receipt revoke, a content revoke, or none. */
function roomWithCopy(marks: { origin?: "audience" | "content"; copy?: "audience" | "content" }) {
  const f = new WritetimeFixture(); fixtures.push(f);
  f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)").run(AUDIENCE_REVOKE);
  const id = (mark: "audience" | "content") => mark === "audience" ? AUDIENCE_REVOKE : CONTENT_REVOKE;
  f.reply("H", "orig", 10, { memLsn: 5 });
  if (marks.origin) f.denyLine("H", 10, id(marks.origin));
  f.message("R", "copy", "bot", { copyOf: { threadId: "H", messageIds: ["orig"] } }).lineage("R", "copy", 20, { memLsn: 5 });
  if (marks.copy) f.denyLine("R", 20, id(marks.copy));
  f.meta("deny_generation", 3);
  return f;
}
/** The room prompt as index.ts builds it: the room prefix (content only in an owner-only room) naming what it shows, plus the refs of
 * crossThreadLineageRefs for the shown rows. `emitted` is what the renderer wrote in words (renderRoomContext): by default every own row
 * the render did not withhold. */
function roomPrompt(f: WritetimeFixture, shown: readonly PromptShownLine[], ownerOnly: boolean, withheld: ReadonlySet<string> = new Set(),
  emitted: ReadonlySet<string> = new Set(shown.filter(line => line.threadId === "R" && !withheld.has(line.id)).map(line => line.id))) {
  const turn = openTurnLineage(f.db, { threadId: "R", turnId: `room-${Math.random()}` });
  const refs: LineageRef[] = [
    { kind: "prefix", threadId: "R", headLsn: 21, shown: shown.filter(line => line.threadId === "R" && !withheld.has(line.id)).map(line => line.id), ...(ownerOnly ? { content: true as const } : {}) },
    ...crossThreadLineageRefs("R", shown, withheld, ownerOnly, emitted),
  ];
  const built = buildPrompt(turn, [promptPart("room", refs)]);
  return { turn, built, refs };
}
const moved = (f: WritetimeFixture) => f.meta("deny_generation", 4); // a foreign carry onto a revoked parent, or a marker's last slice
const verdict = (f: WritetimeFixture, p: ReturnType<typeof roomPrompt>, reader: LineageReader) => { try { return fenceVerdict(f.db, p.built, reader); } finally { closeTurnLineage(p.turn); } };

describe("send fence, owner-only room, a copied teammate reply after an install-wide receipt revoke", () => {
  it("F1/R1: an audience-only mark on the copy and its original never refuses once the generation moved", () => {
    const f = roomWithCopy({ origin: "audience", copy: "audience" });
    const p = roomPrompt(f, [COPY], true);
    expect(p.refs).toContainEqual({ kind: "line", threadId: "H", messageId: "orig", copyOfShown: true });
    moved(f);
    expect(verdict(f, p, OWNER)).toEqual(SHOWN);
  });

  it("F2: nothing moved: shown, as before", () => {
    const f = roomWithCopy({ origin: "audience", copy: "audience" });
    expect(verdict(f, roomPrompt(f, [COPY], true), OWNER)).toEqual(SHOWN);
  });

  it("F3/F13: a content mark on the original alone (not yet walked onto the copy) still refuses", () => {
    const f = roomWithCopy({ origin: "content" });
    const p = roomPrompt(f, [COPY], true);
    moved(f);
    expect(verdict(f, p, OWNER).state).toBe("withheld");
    const q = roomPrompt(f, [COPY], true);
    f.meta("deny_generation", 5);
    expect(verdict(f, q, CONTENT).state).toBe("withheld");
  });

  it("F14: an original older than the policy watermark reads as the copy and the room prefix read it (content: no watermark)", () => {
    const f = roomWithCopy({});
    f.meta("policy_bump_lsn", 9);
    const p = roomPrompt(f, [COPY], true);
    moved(f);
    expect(verdict(f, p, OWNER)).toEqual(SHOWN);
  });

  it("F5: a room that is not owner-only keeps the audience reader for the original", () => {
    const f = roomWithCopy({ origin: "audience" });
    const p = roomPrompt(f, [COPY], false);
    expect(p.refs).toContainEqual({ kind: "line", threadId: "H", messageId: "orig" });
    moved(f);
    expect(verdict(f, p, MEMBER).state).toBe("withheld");
  });

  it("F7: a quoted line of another thread (not a copy the room shows) keeps the audience reader, owner-only room or not", () => {
    const f = roomWithCopy({ origin: "audience" });
    const p = roomPrompt(f, [{ threadId: "H", id: "orig", quoted: true }], true);
    expect(p.refs).toContainEqual({ kind: "line", threadId: "H", messageId: "orig" });
    moved(f);
    expect(verdict(f, p, OWNER).state).toBe("withheld");
  });

  it("A2: a copy the renderer trimmed (window or budget) showed no words: its original carries no flag and keeps the audience reader", () => {
    const f = roomWithCopy({ origin: "audience", copy: "audience" });
    const p = roomPrompt(f, [COPY], true, new Set(), new Set());
    expect(p.refs).toContainEqual({ kind: "line", threadId: "H", messageId: "orig" });
    expect(p.refs.some(ref => ref.kind === "line" && ref.copyOfShown)).toBe(false);
    moved(f);
    expect(verdict(f, p, OWNER).state).toBe("withheld");
  });

  it("without the renderer's emitted rows no original carries the flag (fail closed)", () => {
    const refs = crossThreadLineageRefs("R", [COPY], new Set(), true);
    expect(refs).toEqual([{ kind: "line", threadId: "H", messageId: "orig" }]);
  });

  it("a copy the render withheld adds no original at all", () => {
    const f = roomWithCopy({ origin: "audience", copy: "audience" });
    const p = roomPrompt(f, [COPY], true, new Set(["copy"]));
    expect(p.refs.filter(ref => ref.kind === "line")).toEqual([]);
    closeTurnLineage(p.turn);
  });
});
