// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.62: a long conversation (more than THREAD_RECEIPT_LIMIT memory receipts)
// failed every memory-on turn with MEMORY_REPLAY_LIMIT. The turn now runs
// without recalled memory for that turn, and what it replays holds nothing
// that was made under a memory receipt, so no memory crosses an audience the
// check could not verify.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import * as disclosures from "./memory/disclosures.ts";
import { THREAD_RECEIPT_LIMIT } from "./memory/replay-lineage.ts";

const roster: MemoryRoster = { bots: [{ id: "dax", threadId: "dax-direct", section: "Operations" }], groups: [] };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
function access() {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin("dax", "dax-direct", "g");
  const token = registry.mint({ botId: "dax", threadId: "dax-direct", generation: "g", depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
function longThread(receipts: number) {
  const a = access();
  database().prepare(`WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<?)
    INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    SELECT 'old-'||value,'dax-direct','driver','[]','[]',json_array('reply-'||value),?,?,0,'delivered',value FROM n`).run(receipts, a.policyRevision, a.deletionEpoch);
  const messages = [{ id: "u1", role: "user" }, { id: "reply-1", role: "bot" }, { id: "plain", role: "bot" }, { id: "copy", role: "bot", copyOf: { threadId: "other", messageIds: ["x"] } }, { id: "u2", role: "user" }];
  return { a, messages };
}

it(`a thread past ${THREAD_RECEIPT_LIMIT} receipts still trips the replay check (the failure the turn must survive)`, () => {
  const { a, messages } = longThread(THREAD_RECEIPT_LIMIT + 1);
  let thrown: unknown;
  try { disclosures.filterMemoryReplay("dax-direct", messages, a); } catch (error) { thrown = error; }
  expect((thrown as Error).message).toContain("MEMORY_REPLAY_LIMIT");
  expect(disclosures.memoryReplayLimited(thrown)).toBe(true);
  expect(disclosures.memoryReplayLimited(new Error("MEMORY_SCOPE_DENIED"))).toBe(false);
});

it("the degraded replay keeps people's words and unlinked replies, and drops every reply made with memory and every copy", () => {
  const { messages } = longThread(THREAD_RECEIPT_LIMIT + 1);
  expect(disclosures.replayWithoutMemory("dax-direct", messages).map(m => m.id)).toEqual(["u1", "plain", "u2"]);
});

it("a 5000-message thread with 3000 receipts replays its recent lines in full and withholds only what fails its check", () => {
  const a = access();
  database().prepare(`WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<?)
    INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    SELECT 'r-'||value,'dax-direct','driver',CASE WHEN value=3000 THEN '[{"id":"forgotten","version":1}]' ELSE '[]' END,'[]',json_array('m'||(value*2-1)),?,?,0,'delivered',value FROM n`).run(3000, a.policyRevision, a.deletionEpoch);
  // 5000 messages: odd ids are bot replies (the first 3000 receipts cover m1..m5999), even ids the owner
  const messages = Array.from({ length: 5000 }, (_, i) => ({ id: `m${i + 1}`, role: (i + 1) % 2 ? "bot" : "user", kind: "text", text: `line ${i + 1}` }));
  expect(() => disclosures.filterMemoryReplay("dax-direct", messages, a)).toThrow("MEMORY_REPLAY_LIMIT");
  const window = disclosures.recentReplayWindow(messages);
  expect(window).toHaveLength(disclosures.REPLAY_WINDOW_TEXT_LINES);
  expect(window.at(-1)!.id).toBe("m5000");
  const kept = disclosures.filterMemoryReplayRecent("dax-direct", messages, a, { persist: false });
  // m5999 is outside the 5000; receipt 3000 covers m5999, so no recent line is withheld here
  expect(kept).toHaveLength(disclosures.REPLAY_WINDOW_TEXT_LINES);
  // a recent reply whose receipt cites something that is gone is withheld, nothing else
  database().prepare("UPDATE memory_disclosures SET output_message_ids='[\"m4999\"]' WHERE bundle_id='r-3000'").run();
  const after = disclosures.filterMemoryReplayRecent("dax-direct", messages, a, { persist: false }).map(m => m.id);
  expect(after).not.toContain("m4999");
  expect(after).toHaveLength(disclosures.REPLAY_WINDOW_TEXT_LINES - 1);
});

it("the limit is logged once per conversation", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  disclosures.noteReplayLimitDegraded("long-1"); disclosures.noteReplayLimitDegraded("long-1");
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith("[memory] replay check over limit, turn ran without recalled memory");
  warn.mockRestore();
});
