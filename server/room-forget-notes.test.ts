// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 final check 2, N2 (Sean, 2026-09-29): forgetting a room's notes (its
// checkpoint) forgot every room message the notes quoted as well. Every
// earlier reply read "you chose to forget it" and the bots lost the room's
// history. Forgetting the notes now forgets the notes: a reply made with them
// is still withheld (it used something the owner deleted), and every other
// reply stays in the room for the bots.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import { captureSource } from "./memory/capture.ts";
import { claimMemoryJob, publishMemoryWork } from "./memory/jobs.ts";
import { captureWork } from "./memory/chunks.ts";
import { refreshMemoryCheckpoint } from "./memory/consolidate.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { forgetMemory, onMemoryMessagesForgotten } from "./memory/forget.ts";
import { applyMemoryTombstones } from "./memory/restore.ts";
import { roomReplayWithheld } from "./memory/disclosures.ts";
import { messageSourceForgotten } from "./memory/replay-lineage.ts";

const roster: MemoryRoster = {
  bots: [
    { id: "finch", threadId: "finch-direct", section: "Dev Shop" },
    { id: "dax", threadId: "dax-direct", section: "Operations" },
  ],
  groups: [{ id: "closing", threadId: "closing-chat", memberIds: ["finch", "dax"] }],
};
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

function access(botId: string, thread: string) {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin(botId, thread, "g");
  const token = registry.mint({ botId, threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
function disclose(bundleId: string, records: Array<{ id: string; version: number }>, outputs: string[]) {
  const a = access("dax", "closing-chat");
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,NULL,?,'[]',?,?,?,?,?,?)")
    .run(bundleId, "closing-chat", "fake", JSON.stringify(records), JSON.stringify(outputs), a.policyRevision, a.deletionEpoch, 10, "delivered", Date.now());
}
/** A room line captured through a real capture job; the notes roll on it. */
function captured(messageId: string, speaker: string, text: string) {
  reconcileMemoryRoster(roster);
  const id = `message:closing-chat:${messageId}`;
  captureSource(database(), { id, threadId: "closing-chat", messageId, kind: "text", speaker, outcome: "recorded", text });
  let jobId = "";
  for (let work = claimMemoryJob("n2-worker"); work; work = claimMemoryJob("n2-worker")) {
    publishMemoryWork(work, "n2-worker", captureWork(work));
    if (work.sourceId === id) jobId = work.id;
  }
  if (!jobId) throw new Error(`fixture did not capture ${id}`);
  return refreshMemoryCheckpoint(jobId);
}
const sourceState = (messageId: string) => (database().prepare("SELECT state FROM memory_sources WHERE id=?").get(`message:closing-chat:${messageId}`) as { state: string }).state;
const room = [{ id: "m-ask", role: "user" }, { id: "m-plain" }, { id: "m-noted" }];

it("forgetting the room's notes withholds only the reply made with them; the quoted messages stay", () => {
  // The owner asks; Finch answers with nothing remembered; the notes quote both.
  captured("m-ask", "owner", "Which rows went out on the 26th?");
  disclose("b-plain", [], ["m-plain"]);
  const notes = captured("m-plain", "finch", "Rows 83 to 86 went out on the 26th.");
  expect(notes.status).toBe("updated");
  // Dax answers with the notes in his remembered context.
  disclose("b-noted", [{ id: notes.checkpointId!, version: notes.version! }], ["m-noted"]);
  expect([...roomReplayWithheld("closing-chat", room)]).toEqual([]);

  forgetMemory(ownerMemoryTicket(), { kind: "record", id: notes.checkpointId!, revision: notes.version! });

  // Only Dax's reply is withheld, and for what it used, not as forgotten itself.
  expect([...roomReplayWithheld("closing-chat", room)]).toEqual(["m-noted"]);
  expect(messageSourceForgotten("closing-chat", "m-noted")).toBe(false);
  // The messages the notes quoted are not forgotten.
  for (const id of ["m-ask", "m-plain"]) {
    expect(messageSourceForgotten("closing-chat", id)).toBe(false);
    expect(sourceState(id)).toBe("active");
  }
  // The notes themselves are gone.
  expect(database().prepare("SELECT state FROM memory_records WHERE id=? AND version=?").get(notes.checkpointId!, notes.version!)).toMatchObject({ state: "deleted" });
  // The quoted words stay out of automatic reimport (content tombstones), and
  // applying tombstones again never turns those into deleted room messages.
  expect(Number((database().prepare("SELECT count(*) AS n FROM memory_tombstones WHERE target_type='import' AND reason='forgotten-original'").get() as { n: number }).n)).toBeGreaterThan(0);
  applyMemoryTombstones(database());
  expect(sourceState("m-ask")).toBe("active");
  expect(sourceState("m-plain")).toBe("active");
  expect([...roomReplayWithheld("closing-chat", room)]).toEqual(["m-noted"]);
});

it("the room's next notes start after the forgotten ones, without their quotes", () => {
  captured("m-ask", "owner", "Which rows went out on the 26th?");
  disclose("b-plain", [], ["m-plain"]);
  const notes = captured("m-plain", "finch", "Rows 83 to 86 went out on the 26th.");
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: notes.checkpointId!, revision: notes.version! });
  const next = captured("m-next", "owner", "Thanks, on to the invoices.");
  expect(next.status).toBe("updated");
  const text = (database().prepare("SELECT text FROM memory_records WHERE id=? AND version=?").get(next.checkpointId!, next.version!) as { text: string }).text;
  expect(text).toContain("invoices");
  expect(text).not.toContain("83 to 86");
  expect(text).not.toContain("26th?");
});

it("forgetting an ordinary memory still forgets the messages it rests on", () => {
  captured("m-ask", "owner", "Which rows went out on the 26th?");
  const notes = captured("m-plain", "finch", "Rows 83 to 86 went out on the 26th.");
  // Pretend the same evidence backs a saved fact rather than the notes.
  database().prepare("UPDATE memory_records SET kind='fact' WHERE id=?").run(notes.checkpointId!);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: notes.checkpointId!, revision: notes.version! });
  expect(sourceState("m-plain")).toBe("deleted");
  expect(messageSourceForgotten("closing-chat", "m-plain")).toBe(true);
});

it("derived project text is not marked stale by forgetting the notes, only by forgetting what they quoted", () => {
  const told: string[][] = [];
  onMemoryMessagesForgotten((_db, ids) => { told.push([...ids].sort()); });
  try {
    captured("m-ask", "owner", "Which rows went out on the 26th?");
    const notes = captured("m-plain", "finch", "Rows 83 to 86 went out on the 26th.");
    forgetMemory(ownerMemoryTicket(), { kind: "record", id: notes.checkpointId!, revision: notes.version! });
    expect(told).toEqual([]);
    forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:closing-chat:m-plain" });
    expect(told).toEqual([["m-plain"]]);
  } finally { onMemoryMessagesForgotten(null); }
});
