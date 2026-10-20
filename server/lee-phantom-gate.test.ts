// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lee_J / Phantom (lanes/release103/LEE-PHANTOM.md): after a permission, roster or settings change, a fresh delegated reply written in the
// teammate's own direct conversation was read by the result gate with the explicit owner audience, so the audience-only marks that change
// leaves (receipt flips, and the inherit marks they spread through the lead's own transcript) made it "checking" (no-answer) or "Reply
// withheld". Such a reply, released to the owner's own audience, is now read as its own conversation reads it: audience-only marks and
// windows no longer bind it; content marks, content windows and unknowns still do, and a person's or a room's conversation is unchanged.
import { afterEach, describe, expect, it } from "vitest";
import { doorEgress } from "./bot-read.ts";
import { writetimeLinesShown } from "./result-egress.ts";
import { WritetimeFixture } from "./memory/testing/writetime-fixture.ts";

const fixtures: WritetimeFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
const OWN = "helper-own-chat", PERSON = "helper-person-task";
const ownerConversation = (threadId: string) => threadId === OWN;

/** A teammate's fresh reply (lsn 40, its turn began at 35) in each conversation, with what a settings change left behind. */
function world() {
  const f = new WritetimeFixture().cert(true);
  fixtures.push(f);
  for (const thread of [OWN, PERSON]) f.reply(thread, `${thread}-old`, 20, { turnLsn: 15 }).reply(thread, `${thread}-fresh`, 40, { turnLsn: 35 });
  const audienceOnly = (revoke: number) => { f.db.prepare("INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)").run(revoke); };
  const lines = writetimeLinesShown(() => f.db, ownerConversation);
  const door = doorEgress(() => f.db, ownerConversation);
  const before = writetimeLinesShown(() => f.db);
  const verdicts = (thread: string, notOwner = false) => ({ lines: lines(thread, [`${thread}-fresh`], notOwner), door: door("lead-bot", thread, [`${thread}-fresh`], notOwner) });
  return { f, audienceOnly, verdicts, before };
}

describe("a fresh delegated reply after a permission, roster or settings change", () => {
  it("is shown to the owner's audience under the marks a receipt flip leaves (inherited deny line and range), in the owner's own conversation", () => {
    const { f, audienceOnly, verdicts, before } = world();
    audienceOnly(16);
    for (const thread of [OWN, PERSON]) f.denyLine(thread, 40, 16).denyRange(thread, 38, 45, 16);
    // what the gate read before: the exact Discord line
    expect(before(OWN, [`${OWN}-fresh`], false)).toBe("withheld");
    expect(verdicts(OWN)).toEqual({ lines: "shown", door: "shown" });
    // a person's conversation, and any not-owner audience, keep every receipt revocation (result-egress-privacy.test.ts)
    expect(verdicts(PERSON)).toEqual({ lines: "withheld", door: "withheld" });
    expect(verdicts(OWN, true).lines).toBe("withheld");
  });

  it("is not held as checking (the no-answer line) by the change's audience-only window or its queued receipt flips", () => {
    const { f, audienceOnly, verdicts, before } = world();
    audienceOnly(18);
    // the bulk the flip drain activated late (cap 50, above the fresh turn) and its install-wide window
    f.job(18, 50).pending("*", 10, 18);
    expect(before(OWN, [`${OWN}-fresh`], false)).toBe("checking");
    expect(verdicts(OWN)).toEqual({ lines: "shown", door: "shown" });
    expect(verdicts(PERSON).lines).toBe("checking");
  });

  it("is still withheld by a content mark and still checking under a content window, in the owner's own conversation too", () => {
    const { f, verdicts } = world();
    f.denyLine(OWN, 40, 2);
    expect(verdicts(OWN)).toEqual({ lines: "withheld", door: "withheld" });
    const other = world();
    other.f.job(3, 50).pending("*", 10, 3);
    expect(other.verdicts(OWN)).toEqual({ lines: "checking", door: "checking" });
  });

  it("is still checking when its thread's lineage is not ready (an unknown is never shown)", () => {
    const { f, verdicts } = world();
    f.cert(false);
    expect(verdicts(OWN).lines).toBe("checking");
  });
});
