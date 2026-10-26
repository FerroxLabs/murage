// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Read-time mask (PASTE-CAPTURE-FIX 2.1, r2.1, r2.8 N3): a row the scrub has
// not reached yet still holds a 1.0.3 number. The engine's bundle, recall
// hits, the owner's list and the inspect quotes read it masked from the first
// launch of 1.0.4.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { searchMemory, type MemorySearchBridge } from "./search.ts";
import { memoryOwnerRoute } from "./settings.ts";
import type { MemoryRecord } from "../../shared/memory.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] };
const keywordOnly: MemorySearchBridge = { search: async () => ({ hits: [], vectorRows: 0, degradedReason: "keyword-only" }) };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); });

function access() {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(), generation = registry.begin("bot", "thread");
  const token = registry.mint({ botId: "bot", threadId: "thread", generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}

const RAW = "Deposits for Frost Bank go to the account ending 4471, routing 021000021.";
const MASKED = "Deposits for Frost Bank go to the account ending ****, routing *********.";

/** A source and its chunk as 1.0.3 left them: the digits in the payload and in the record. */
function legacyRows() {
  const db = database();
  captureSource(db, { id: "legacy", threadId: "thread", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text: RAW });
  for (let work = claimMemoryJob("fixture"); work; work = claimMemoryJob("fixture")) publishMemoryWork(work, "fixture", captureWork(work));
  db.prepare("UPDATE memory_source_versions SET payload=json_set(payload,'$.text',?) WHERE source_id='legacy'").run(RAW);
  db.prepare("UPDATE memory_records SET text=? WHERE kind='source'").run(RAW);
  const row = db.prepare("SELECT id,version FROM memory_records WHERE kind='source'").get()!;
  return { id: String(row.id), version: Number(row.version) };
}

it("the engine bundle and recall read an unscrubbed record masked", async () => {
  legacyRows();
  const bundle = await buildMemoryBundle("Frost Bank deposits", access(), keywordOnly, { allowance: LineageAllowance.tool() });
  expect(bundle.text).toContain("account ending ****");
  expect(bundle.text).not.toMatch(/4471|021000021/);
  const hits = (await searchMemory("Frost Bank deposits", access(), keywordOnly, { allowance: LineageAllowance.tool(1_000_000_000) })).hits;
  expect(hits.length).toBeGreaterThan(0);
  for (const hit of hits) expect(hit.text).not.toMatch(/4471|021000021/);
});

it("the owner's list shows a source record labelled by kind with masked text, and inspect quotes are masked", async () => {
  const record = legacyRows();
  const ticket = ownerMemoryTicket();
  const listed = await memoryOwnerRoute("/api/memory/action", { action: "list", botId: "bot", view: "recent" }, ticket, roster) as { records: MemoryRecord[] };
  const source = listed.records.find((row) => row.id === record.id)!;
  expect(source).toMatchObject({ kind: "source", text: MASKED });
  const inspected = await memoryOwnerRoute("/api/memory/action", { action: "inspect", id: record.id, version: record.version }, ticket, roster) as { record: MemoryRecord; evidence: Array<{ text: string }> };
  expect(inspected.record.text).toBe(MASKED);
  expect(inspected.evidence.length).toBeGreaterThan(0);
  for (const quote of inspected.evidence) expect(quote.text).not.toMatch(/4471|021000021/);
});
