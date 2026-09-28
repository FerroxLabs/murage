// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 final check 2, N1: room recall was empty in real rooms on every OS.
// A room's checkpoint rolls on every captured message in the room. The owner's
// new message (and each teammate reply of the round) is still being captured
// by the memory worker when the member's bundle is built, and the worker is
// one child process answering in order: the capture's result reaches the
// server, and rolls the checkpoint, before the answer to the member's recall
// query does. The bundle's post-recall re-check then dropped the version it
// had selected, so every un-pinned room turn got an empty bundle. These tests
// keep that real ordering: the search bridge publishes the in-flight capture
// and refreshes the checkpoint exactly as MemoryWorkerController does before
// it answers. As in server/index.ts runGroupMemberTurn, every message the
// room context serializes is excluded from recall (the notes' own source
// chunks included), so the checkpoint is what carries them.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import type { MemoryWork } from "./worker-protocol.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { buildMemoryBundleAfterReset, MemoryDispatchReceipt } from "./dispatch.ts";
import { forgetMemory } from "./forget.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { readerWithheldMessage } from "./disclosures.ts";

const botThread = "0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b", otherThread = "1c2d3e4f-5061-4728-9bac-1d2e3f4a5b6c";
const roomThread = "2d3e4f50-6172-4839-acbd-2e3f4a5b6c7d";
const roster = { bots: [{ id: "bot", threadId: botThread }, { id: "other", threadId: otherThread }], groups: [{ id: "room", threadId: roomThread, memberIds: ["bot", "other"] }] };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); setMemoryMode("capture"); });

function member(botId = "bot") {
  const registry = new InternalCapabilities(), generation = registry.begin(botId, roomThread);
  const token = registry.mint({ botId, threadId: roomThread, generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
/** A room message captured into the memory queue; the worker holds it. */
function inFlight(text: string, speaker = "owner") {
  const messageId = randomUUID();
  captureSource(database(), { id: `message:${roomThread}:${messageId}`, threadId: roomThread, messageId, kind: "text", speaker, outcome: "recorded", text });
  const work = claimMemoryJob("room-recall-fixture");
  if (!work) throw Error("No actual capture job");
  return { messageId, sourceId: `message:${roomThread}:${messageId}`, work };
}
/** What MemoryWorkerController does when the child's capture result arrives. */
function settle(work: MemoryWork) {
  publishMemoryWork(work, "room-recall-fixture", captureWork(work));
  const result = refreshMemoryCheckpoint(work.id);
  if (result.status !== "updated") throw Error("Expected actual checkpoint publication");
  return { id: result.checkpointId, version: result.version };
}
/** The worker answers the recall query only after the capture it was holding. */
function workerBridge(holding: MemoryWork, before?: () => void) {
  return { search: async () => { await Promise.resolve(); settle(holding); before?.(); return { hits: [], vectorRows: 0 }; } };
}

it("gives a room member the room's saved notes when the round's capture rolls the checkpoint during recall", async () => {
  const saved = inFlight("Remember: the dog is called Biscuit and her collar is teal.");
  const first = settle(saved.work);
  const ask = inFlight("What is the dog called?");
  const access = member();
  const bundle = await buildMemoryBundleAfterReset("What is the dog called?", access, workerBridge(ask.work), async () => {}, { excludeMessageIds: [saved.messageId, ask.messageId], withheldMessage: readerWithheldMessage(access) });
  // The checkpoint rolled while recall awaited the worker.
  expect(database().prepare("SELECT state FROM memory_records WHERE id=? AND version=?").get(first.id, first.version)?.state).toBe("archived");
  expect(bundle.tokenCount).toBeGreaterThan(0);
  expect(bundle.text).toContain("Biscuit");
  // The member gets the room's current notes, not a dropped record.
  expect(bundle.recordVersions).toEqual([{ id: first.id, version: first.version + 1 }]);
  expect(bundle.checkpoint.map(record => record.version)).toEqual([first.version + 1]);
  expect(bundle.degradedReason).toBeUndefined();
  const receipt = new MemoryDispatchReceipt(bundle, access, "fixture");
  expect(() => receipt.assertCurrent()).not.toThrow();
});

it("gives each member of the round the notes, the second one after the first one's reply is captured", async () => {
  const saved = inFlight("Remember: the dog is called Biscuit.");
  const first = settle(saved.work);
  const ask = inFlight("What is the dog called?");
  const a = await buildMemoryBundleAfterReset("dog", member("bot"), workerBridge(ask.work), async () => {}, { excludeMessageIds: [saved.messageId, ask.messageId] });
  expect(a.recordVersions).toEqual([{ id: first.id, version: first.version + 1 }]);
  const reply = inFlight("It is Biscuit.", "bot");
  const b = await buildMemoryBundleAfterReset("dog", member("other"), workerBridge(reply.work), async () => {}, { excludeMessageIds: [saved.messageId, ask.messageId, reply.messageId] });
  expect(b.recordVersions).toEqual([{ id: first.id, version: first.version + 2 }]);
  expect(b.text).toContain("Biscuit");
});

it("still refuses the turn when the owner forgets the room's notes while recall awaits", async () => {
  const saved = inFlight("Remember: the dog is called Biscuit.");
  settle(saved.work);
  const ask = inFlight("What is the dog called?");
  await expect(buildMemoryBundleAfterReset("dog", member(), workerBridge(ask.work, () => {
    forgetMemory(ownerMemoryTicket(), { kind: "source", id: saved.sourceId, revision: 1 });
  }), async () => {})).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
});

it("does not hand a member the newer checkpoint when it rests on a message withheld from that member", async () => {
  const saved = inFlight("Remember: the dog is called Biscuit.");
  const first = settle(saved.work);
  // A teammate's reply this member is not shown (disclosures.ts
  // readerWithheldMessage): its capture rolls the checkpoint during recall.
  const hidden = inFlight("A reply this member may not see.", "bot");
  const withheld = (threadId: string, messageId: string) => threadId === roomThread && messageId === hidden.messageId;
  const bundle = await buildMemoryBundleAfterReset("dog", member(), workerBridge(hidden.work), async () => {}, { excludeMessageIds: [saved.messageId], withheldMessage: withheld });
  expect(bundle.text).not.toContain("may not see");
  expect(bundle.recordVersions).not.toContainEqual({ id: first.id, version: first.version + 1 });
});
