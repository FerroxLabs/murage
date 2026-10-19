// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy, 1.0.2 S6 (U2): a forget made BEFORE the upgrade has a time (its tombstone's), and the U2 seed gives its range a proven bound
// from it (`until`, lineage-backfill.ts forgetBound): a generated line whose turn began after the forget was built without the forgotten line
// and is not withheld by position; one whose turn began before it (or that was written before it) is.
import { mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { denyLookup } from "./deny-read.ts";
import { lineageBackfillSlice, resetLineageBackfillForTest } from "./lineage-backfill.ts";
import { drainRevokeMarker } from "./memory-revocation.ts";
import { setScopeFlowEdgesRecorded } from "./revoke-marker.ts";
import { buildLegacyHistory, markUpgraded, messageSource, type LegacyHistory } from "./testing/legacy-history-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

setScopeFlowEdgesRecorded(true);
const THREAD = "wt-1-t0";

/** m0..m11 of one thread: even = owner, odd = reply (turn of the owner line before it), `at` = its index; only the forgotten reply is captured (a captured later reply would carry the forgotten line's contamination on through the marker's walk of its source: that is the design's own contagion, not the bound). */
function build(): LegacyHistory {
  closeDatabase(); resetLineageBackfillForTest();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  return buildLegacyHistory(database(), { seed: 1, threads: 1, lines: 12, receipts: 0, captured: 0, copies: 0, rootSets: 0 });
}
/** The owner forgot reply `id` at time `forgetAt` (a tombstone and a deleted source, as 1.0.1 left it). */
function forget(history: LegacyHistory, id: string, forgetAt: number, reason = "owner-forget"): void {
  const db = database(), source = messageSource(THREAD, id);
  db.prepare("INSERT OR IGNORE INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot','settled',NULL,'active')").run(source, history.scopeOf.get(THREAD)!, THREAD, id);
  db.prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(source);
  db.prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES(?,?,?,1,NULL,0,?,?)").run(`tomb-${source}`, "source", source, reason, forgetAt);
}
function upgrade(): void {
  const db = database();
  markUpgraded(db);
  for (let slices = 0; lineageBackfillSlice(db, { budgetMs: 500 }).more; slices++) if (slices > 100_000) throw new Error("backfill without end");
  expect(drainRevokeMarker(db).pending).toBe(false);
}
const states = (ids: readonly string[]): Record<string, string> => {
  const verdicts = denyLookup(database(), { threadId: THREAD, lines: ids.map(messageId => ({ messageId, author: Number(messageId.slice(1)) % 2 === 0 ? "owner" as const : "generated" as const })) }, { audience: null });
  return Object.fromEntries(ids.map(id => [id, verdicts.get(id)!.state === "withheld" ? `withheld:${(verdicts.get(id) as { reason: string }).reason}` : verdicts.get(id)!.state]));
};
const IDS = ["m1", "m3", "m4", "m5", "m6", "m7", "m9", "m11"];

describe("U2 gives a forget made before the upgrade a proven bound from its time", () => {
  it("replies whose turn began after the forget stay shown; the forgotten line, the replies written before it and the turn it ran inside are withheld", () => {
    forget(build(), "m3", 6); // m4 (the owner's line, at 4) and m5 (at 5) are before it; m6 (at 6) starts the turn of m7, begun at 6, not before
    upgrade();
    expect(states(IDS)).toEqual({
      m1: "shown", m3: "withheld:tombstone", m4: "shown", m5: "withheld:deny-range",
      m6: "shown", m7: "shown", m9: "shown", m11: "shown",
    });
    // the bound itself: the range ends at the first turn begun after the forget (the turn of m5 is the last covered)
    const range = database().prepare("SELECT from_lsn AS f,until_turn_lsn AS u FROM memory_deny_range WHERE thread_id=?").all(THREAD);
    expect(range).toHaveLength(1);
    const turnOf = (id: string) => Number(database().prepare("SELECT l.turn_lsn AS t FROM memory_line_lineage l JOIN memory_thread_no n ON n.no=l.thread_no WHERE n.thread_id=? AND l.message_id=?").get(THREAD, id)!.t);
    expect(Number(range[0]!.u)).toBe(turnOf("m5") + 1);
  });

  it("a turn that began before the forget but wrote its reply after it is withheld (the owner's line it answered is older than the forget)", () => {
    const history = build();
    // m7 is written at 7, after the forget at 6, but the owner line it answers (m6) was written at 5: the turn was put together before the forget
    database().prepare("UPDATE messages SET at=5 WHERE thread_id=? AND id='m6'").run(THREAD);
    forget(history, "m3", 6);
    upgrade();
    expect(states(["m5", "m7", "m9"])).toEqual({ m5: "withheld:deny-range", m7: "withheld:deny-range", m9: "shown" });
  });

  it("a turn whose beginning cannot be read counts as begun before the forget (fail closed)", () => {
    const history = build();
    // the turn of m9 starts at a first row with no readable time (its row is gone from the messages table)
    database().prepare("DELETE FROM messages WHERE thread_id=? AND id='m8'").run(THREAD);
    forget(history, "m3", 6);
    upgrade();
    expect(states(["m7", "m9", "m11"]).m9).not.toBe("shown");
    expect(states(["m11"]).m11).toBe("shown");
  });

  it("a tombstone that is not the owner's own forget has no time to bound by: the range runs to the upgrade, as before", () => {
    const history = build();
    forget(history, "m3", 6, "conversation-deleted");
    upgrade();
    expect(states(["m5", "m7", "m11"])).toEqual({ m5: "withheld:deny-range", m7: "withheld:deny-range", m11: "withheld:deny-range" });
  });
});
