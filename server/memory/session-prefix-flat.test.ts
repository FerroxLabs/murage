// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Flatness: a session's receipts are judged once; a turn judges only what is new.
// (setup shared with receipt-sequence.test.ts)
// Astra mem-review round 2, R2-P1: the order of a session's receipts is the
// order they were written (rowid), never their created_at. A clock that went
// back, or a lookup companion dated a millisecond before its frame, must not
// decide which receipt is the session's newest. These use the real linking
// functions and the real replay.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./authority.ts";
import { captureSource } from "./capture.ts";
import { forgetMemory } from "./forget.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { capturedMessageWithheld, lineageCacheCounts } from "./replay-lineage.ts";
import { setMemoryMode } from "./repository.ts";
import { LineageAllowance } from "./lineage-allowance.ts";

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }] }], groups: [] };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); reconcileMemoryRoster(roster); });

function access() {
  const registry = new InternalCapabilities(); registry.begin("bot", "chat", "g");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}
function secretRecord() {
  const text = "The alarm code is 4812.";
  captureSource(database(), { id: "message:older:m1", threadId: "older", messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text });
  const record = saveMemoryCandidate(text, [{ sourceId: "message:older:m1", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k", access());
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  return record;
}
const ins = (id: string, records: Array<{ id: string; version: number }>, output: string[]) =>
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,'chat','engine','S',?,'[]',?,(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),0,'delivered',1)")
    .run(id, JSON.stringify(records), JSON.stringify(output));

it("a long session's turn judges only the receipts written since, and a withdrawal deep in it still withholds the latest reply", () => {
  const record = secretRecord();
  const TURNS = 300;
  let misses = 0;
  const turn = (n: number) => {
    ins(`F${n}`, n === 3 ? [{ id: record, version: 1 }] : [], [`r${n}`]);
    const before = lineageCacheCounts().misses;
    expect(capturedMessageWithheld(LineageAllowance.tool(1_000_000_000), "chat", `r${n}`)).toBe(false);
    return lineageCacheCounts().misses - before;
  };
  for (let n = 1; n <= TURNS; n++) { const m = turn(n); if (n === 100) misses = m; if (n === TURNS) expect(m).toBeLessThanOrEqual(Math.max(misses, 8)); }
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(capturedMessageWithheld(LineageAllowance.tool(1_000_000_000), "chat", `r${TURNS}`)).toBe(true);
  expect(capturedMessageWithheld(LineageAllowance.tool(1_000_000_000), "chat", `r${TURNS + 1}`)).toBe(false);
});
