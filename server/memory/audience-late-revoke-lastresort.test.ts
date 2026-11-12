// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The listed replay privacy contract from the 1.0.17 probe (fake data only).
// Recovery now uses selective replay at tier 1 and no stored replay at tier 2.
// Legacy ownReplayRefs consumers keep their original audience/content rules. An audience-only revoke
// lands between prepare and the send fence. The real send fence (assertSendFence) must refuse, so no revoked bytes (built.text) reach the
// engine writer. The owner's own replay is tagged `judge: "content"` (direct owner: reader { audience: null }; owner room: ownReplayRefs
// "content"), so an audience-only mark never refuses it.
// Last-resort state is just the prompt shape, so the prompt is built directly with the same functions index.ts uses (ownReplayRefs, noneRef,
// promptPart, buildPrompt). The revoke is the fixture's own mark rows (memory_deny_line + memory_revoke_audience + deny_generation moved).
import { afterEach, describe, expect, it } from "vitest";
import { denyLookup } from "./deny-read.ts";
import { assertSendFence } from "./send-fence.ts";
import { closeTurnLineage, openTurnLineage } from "./lineage-write.ts";
import { buildPrompt, noneRef, ownReplayRefs, promptPart } from "./prompt-parts.ts";
import type { LineageReader } from "./lineage-types.ts";
import { CONTENT, MEMBER, OWNER, WritetimeFixture } from "./testing/writetime-fixture.ts";

const fixtures: WritetimeFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
const AUDIENCE_REVOKE = 7, CONTENT_REVOKE = 8;
const SECRET = "SECRET-REVOKED-LINE-BYTES";
const KEEP = "kept reply words";

type When = "late" | "early";
type Kind = "audience" | "content";
function run(reader: LineageReader, when: When, kind: Kind, tag?: "content") {
  const f = new WritetimeFixture(); fixtures.push(f);
  f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)").run(AUDIENCE_REVOKE);
  f.footprint(1, ["s-room"]);
  f.owner("D", "o1", 1).reply("D", "g1", 2, { memLsn: 5, footprint: 1 }).reply("D", "g2", 3, { memLsn: 5, footprint: 1 }).meta("deny_generation", 3);
  const text: Record<string, string> = { o1: "owner question", g1: SECRET, g2: KEEP };
  const revokeId = kind === "audience" ? AUDIENCE_REVOKE : CONTENT_REVOKE;
  const land = () => { f.denyLine("D", 2, revokeId).meta("deny_generation", 4); };
  if (when === "early") land();
  // prepare: the generated lines are judged by the preparation reader (the same reader the fence later uses)
  const judged = denyLookup(f.db, { threadId: "D", lines: ["g1", "g2"].map(messageId => ({ messageId, author: "generated" as const })) }, reader);
  const shown = ["o1", ...["g1", "g2"].filter(id => judged.get(id)?.state === "shown")];
  const turn = openTurnLineage(f.db, { threadId: "D", turnId: "direct-last-resort" });
  // A legacy listed replay part: every shown line remains fenced by its reader.
  const built = buildPrompt(turn, [promptPart(shown.map(id => text[id]).join("\n"), [...ownReplayRefs("D", shown, tag), noneRef("murage")])]);
  if (when === "late") land(); // after prepare, before the send fence
  const sent: string[] = []; // bytes handed to a fake engine writer
  let refused: unknown = null;
  try { assertSendFence(built, reader, f.db); sent.push(built.text); } catch (error) { refused = error; }
  closeTurnLineage(turn);
  const prepared = judged.get("g1")?.state;
  return { refused, sent, prepared };
}

describe("direct turn, last-resort replay refs, a revoke between prepare and send", () => {
  it("MAIN: non-owner reader, audience-only revoke after prepare: the fence refuses and nothing is sent", () => {
    const r = run(MEMBER, "late", "audience");
    expect(r.prepared, "prepare showed the line to the audience reader, so the case is not vacuous").toBe("shown");
    expect(r.refused).toBeTruthy();
    expect(r.sent).toEqual([]);
  });
  it("CONTROL 1a: direct owner (content reader, replay refs by content), the same audience-only revoke after prepare: shown by design", () => {
    const r = run(CONTENT, "late", "audience");
    expect(r.prepared).toBe("shown");
    expect(r.refused).toBeNull();
    expect(r.sent.join("")).toContain(SECRET);
  });
  it("CONTROL 1b: owner room (owner reader, replay refs tagged content), the same audience-only revoke after prepare: shown by design", () => {
    const r = run(OWNER, "late", "audience", "content");
    expect(r.prepared).toBe("shown");
    expect(r.refused).toBeNull();
    expect(r.sent.join("")).toContain(SECRET);
  });
  it("CONTROL 1c: the tag is what spares the owner room: the same owner reader with an untagged replay is refused", () => {
    const r = run(OWNER, "late", "audience");
    expect(r.refused).toBeTruthy();
    expect(r.sent).toEqual([]);
  });
  it("CONTROL 2: non-owner reader, a CONTENT revoke after prepare must refuse and send nothing", () => {
    const r = run(MEMBER, "late", "content");
    expect(r.prepared).toBe("shown");
    expect(r.refused).toBeTruthy();
    expect(r.sent).toEqual([]);
  });
  it("CONTROL 3: revoke BEFORE prepare (audience-only, non-owner): the line is withheld at prepare and its bytes never reach the payload", () => {
    const r = run(MEMBER, "early", "audience");
    expect(r.prepared).not.toBe("shown");
    expect(r.sent.join("")).not.toContain(SECRET);
    expect(r.refused).toBeNull();
  });
});
