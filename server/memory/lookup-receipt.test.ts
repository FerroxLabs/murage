// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 T2 round 3, R3-4 (lane M): what memory_search and memory_get hand a
// turn was not on its receipt, so a reply built from a lookup had no lineage
// and stayed shown after the owner forgot what it used. Lookups now go on a
// companion receipt of the dispatch; the frame's own receipt is untouched, so
// a session still continues when nothing changed.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./authority.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { captureSource } from "./capture.ts";
import { MemoryDispatchReceipt, memoryContinuationChanged } from "./dispatch.ts";
import { forgetMemory } from "./forget.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { capturedMessageWithheld } from "./replay-lineage.ts";
import { memoryAgentRoute } from "./routes.ts";
import { setMemoryMode } from "./repository.ts";
import { appendMessage } from "../message-db.ts";
import type { Message } from "../store.ts";
import { workingContextBlock, workingContextSources } from "../working-context.ts";

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }] }], groups: [] };
const empty = { async search() { return { hits: [], vectorRows: 0, coverageComplete: false }; } };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); reconcileMemoryRoster(roster); });

function access() {
  const registry = new InternalCapabilities(); registry.begin("bot", "chat", "g");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}

it("a reply built from memory_get rests on what it looked up, and is withheld when the owner forgets it", async () => {
  const text = "The alarm code is 4812.";
  captureSource(database(), { id: "message:older:m1", threadId: "older", messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text });
  const turn = access();
  const record = saveMemoryCandidate(text, [{ sourceId: "message:older:m1", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k", turn);
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  const bundle = await buildMemoryBundle("", turn, empty);
  const receipt = new MemoryDispatchReceipt(bundle, turn, "engine");
  receipt.accepted();
  const got = await memoryAgentRoute("/api/internal/memory/get", { handles: [{ id: record, version: 1 }] }, turn, empty, receipt) as { records: Array<{ text: string }> };
  expect(got.records[0]!.text).toBe(text);
  receipt.output("reply-1");
  expect(capturedMessageWithheld("chat", "reply-1")).toBe(false);
  // the frame's receipt still decides whether the session continues
  database().prepare("UPDATE memory_disclosures SET native_session='s' WHERE bundle_id LIKE ?").run(`${bundle.bundleId}%`);
  expect(memoryContinuationChanged(bundle, "chat", "engine", "s")).toBe(false);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(capturedMessageWithheld("chat", "reply-1")).toBe(true);
});

it("a lookup by another turn's capability is not noted on this dispatch", async () => {
  const turn = access();
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty), turn, "engine");
  const registry = new InternalCapabilities(); registry.begin("bot", "chat", "other");
  const other = memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "other", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
  receipt.noteLookup([{ id: "r", version: 1, evidence: [] }], other);
  expect(database().prepare("SELECT count(*) n FROM memory_disclosures").get()?.n).toBe(1);
});

it("Astra r1 #6: a reply built from the working context rests on the replies it quotes", async () => {
  appendMessage("older", { id: "r-old", role: "bot", kind: "text", text: "Shipped the Acme order.", at: 1 } as Message);
  const turn = access();
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty), turn, "engine");
  receipt.accepted();
  const working = workingContextBlock(true, { botId: "bot", currentThreadId: "chat", bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older", title: "Orders" }] }], groups: [], routines: [], now: 10 });
  expect(working.text).toContain("Shipped the Acme order.");
  expect(receipt.noteSources(workingContextSources(working.quoted))).toBe(true);
  receipt.output("reply-2");
  expect(capturedMessageWithheld("chat", "reply-2")).toBe(false);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:older:r-old" });
  expect(capturedMessageWithheld("chat", "reply-2")).toBe(true);
});

it("Astra r1 #9: past the receipt bound a lookup is refused, not handed over unrecorded", async () => {
  const turn = access();
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty), turn, "engine");
  const many = Array.from({ length: 257 }, (_, index) => ({ id: `r${index}`, version: 1, evidence: [] }));
  expect(() => receipt.noteLookup(many, turn)).toThrow("MEMORY_LOOKUP_LIMIT");
});
