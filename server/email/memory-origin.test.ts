// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot email (BOT-EMAIL-MURAGE-109 5.4): a memory the bot saves itself during a marked turn, or that quotes a marked row, carries the
// external-mail origin, is held for the owner (reason external-mail) and is fenced kind email-derived in a later turn's remembered context.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster } from "../memory/policy.ts";
import { captureSource } from "../memory/capture.ts";
import { claimMemoryJob, publishMemoryWork } from "../memory/jobs.ts";
import { captureWork } from "../memory/chunks.ts";
import { ownerMemoryTicket, pinMemory, saveGroundedMemory } from "../memory/authority.ts";
import { learningReviewReason } from "../memory/automatic-learning.ts";
import { buildMemoryBundle } from "../memory/bundle.ts";
import { fenceEmailDerivedRecords, recordEmailDerived } from "../memory/email-derived.ts";
import { LineageAllowance } from "../memory/lineage-allowance.ts";
import { beginTurnMarks, forgetAllTurnMarks, markTurnEmailDerived, turnEmailDerived } from "./external-marks.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); forgetAllTurnMarks(); });
afterEach(() => forgetAllTurnMarks());

function access() {
  const registry = new InternalCapabilities(), generation = registry.begin("bot", "thread");
  const token = registry.mint({ botId: "bot", threadId: "thread", generation, depth: 10, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
function capture(id: string, text: string, speaker = "owner", externalContent?: "email") {
  captureSource(database(), { id, threadId: "thread", origin: { kind: "attended" }, kind: "text", speaker, outcome: "recorded", text, ...(externalContent ? { externalContent } : {}) });
  const work = claimMemoryJob("fixture")!; expect(work).toBeTruthy();
  publishMemoryWork(work, "fixture", captureWork(work));
  const row = database().prepare("SELECT revision FROM memory_sources WHERE id=?").get(id)!;
  return { sourceId: id, revision: Number(row.revision), startByte: 0, endByte: Buffer.byteLength(text) };
}
const row = (id: string) => database().prepare("SELECT r.state,d.confidence_basis FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version WHERE r.id=?").get(id)!;
const bundle = (a: ReturnType<typeof access>) => buildMemoryBundle("", a, { search: async () => ({ hits: [], vectorRows: 0 }) }, { allowance: LineageAllowance.tool() });

it("an owner statement saved during a marked turn is held for the owner (external-mail); the same save in an unmarked turn activates", async () => {
  const a = access(), text = "I prefer concise answers.", evidence = capture("s-owner", text);
  markTurnEmailDerived("thread");
  const held = await saveGroundedMemory(text, [evidence], "k-marked", a, "owner-statement", null);
  expect(row(held)).toEqual({ state: "candidate", confidence_basis: learningReviewReason("external-mail") });
  expect(recordEmailDerived(database(), held, 1)).toBe(true);
  beginTurnMarks("thread");
  const plain = await saveGroundedMemory(text, [evidence], "k-plain", a, "owner-statement", null);
  expect(row(plain).state).toBe("active");
  expect(recordEmailDerived(database(), plain, 1)).toBe(false);
});

it("a save quoting a marked row carries the origin and is held, even in an unmarked turn", async () => {
  const a = access(), text = "Alex wants a refund by Friday.", evidence = capture("s-mail", text, "bot", "email");
  const id = await saveGroundedMemory(text, [evidence], "k-quote", a, "observation", null);
  expect(row(id)).toEqual({ state: "candidate", confidence_basis: learningReviewReason("external-mail") });
  expect(recordEmailDerived(database(), id, 1)).toBe(true);
});

it("once the owner approves it, the memory is still fenced email-derived in a later turn's remembered context and marks that turn", async () => {
  const a = access(), text = "Ship the order to the new address.", evidence = capture("s-owner2", text);
  markTurnEmailDerived("thread");
  const id = await saveGroundedMemory(text, [evidence], "k-approved", a, "owner-statement", null);
  beginTurnMarks("thread");
  const other = await saveGroundedMemory(text, [evidence], "k-other", a, "owner-statement", null);
  // the owner approves the held one in Needs you, and pins both so the frame carries them
  database().prepare("UPDATE memory_records SET state='active' WHERE id=? AND version=1").run(id);
  const ticket = ownerMemoryTicket(); pinMemory(ticket, id, 1, true); pinMemory(ticket, other, 1, true);
  beginTurnMarks("thread");
  const built = await bundle(access());
  const lines = built.text.split("\n");
  const fenced = lines.findIndex(line => line.startsWith("<<page-content ") && line.includes("kind=email-derived") && line.includes(`origin=${`memory-${id}`.replace(/[^\w.-]/g, "").slice(0, 64)} `));
  expect(fenced).toBeGreaterThanOrEqual(0);
  expect(lines[fenced + 1]).toContain(JSON.stringify(text));
  expect(lines[fenced + 2]).toMatch(/^<<end page-content id=[0-9a-f]{16}>>$/);
  expect(built.text.match(/kind=email-derived/g)).toHaveLength(1);
  expect(turnEmailDerived("thread")).toBe(true);
  // stable across builds (the fence id is derived, not random)
  beginTurnMarks("thread");
  expect((await bundle(access())).text).toBe(built.text);
  // memory_get/search records: fenced by the origin too
  const [read] = fenceEmailDerivedRecords(database(), [{ id, version: 1, text, evidence: [{ sourceId: "s-owner2", revision: evidence.revision }] }], undefined);
  expect(read!.text).toContain("kind=email-derived");
});

it("a frame with no email-derived memory is unchanged and leaves the turn unmarked", async () => {
  const a = access(), text = "I like tea.", evidence = capture("s-tea", text);
  const id = await saveGroundedMemory(text, [evidence], "k-tea", a, "owner-statement", null);
  pinMemory(ownerMemoryTicket(), id, 1, true);
  const built = await bundle(access());
  expect(built.text).toContain(JSON.stringify(text));
  expect(built.text).not.toContain("page-content");
  expect(turnEmailDerived("thread")).toBe(false);
});
