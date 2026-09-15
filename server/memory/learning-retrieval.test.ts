// B29 capture → distillation → grounding → current retrieval with a deterministic
// extractor. This is protocol proof only; semantic/model qualification is B34.
// Ordinary grounded learning is recallable without approval. Failed, cancelled,
// interrupted, refused, review-only and repeated claims do not become current
// facts. Corrections supersede without erasing history. Restart completes once.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { captureSource } from "./capture.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { consolidateMemorySource, refreshMemoryCheckpoint } from "./consolidate.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { searchMemory, type MemorySearchBridge } from "./search.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { recordMemorySettlement, reconcileInterruptedMemoryTurns } from "./settlement.ts";
import type { TextOnlyExtractor } from "./extract.ts";
import { readMemoryLearning, updateMemoryLearning } from "./learning-policy.ts";

const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] };
const keywordOnly: MemorySearchBridge = { search: async () => ({ hits: [], vectorRows: 0, degradedReason: "keyword-only" }) };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); });

function access() {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(), generation = registry.begin("bot", "thread");
  const token = registry.mint({ botId: "bot", threadId: "thread", generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
/** Publish every pending capture the way the worker does, refreshing the thread checkpoint. */
function drain() {
  const jobs = new Map<string, string>();
  for (let work = claimMemoryJob("fixture"); work; work = claimMemoryJob("fixture")) {
    publishMemoryWork(work, "fixture", captureWork(work)); refreshMemoryCheckpoint(work.id);
    jobs.set(String(database().prepare("SELECT source_id FROM memory_jobs WHERE id=?").get(work.id)!.source_id), work.id);
  }
  return jobs;
}
function capture(id: string, text: string, speaker = "owner", outcome = "recorded", turnId?: string) {
  captureSource(database(), { id, threadId: "thread", kind: "text", speaker, outcome, text, ...(turnId ? { turnId } : {}),
    ...(speaker === "tool" ? { action: { label: "fixture", reportedOutcome: outcome as "completed" | "failed", verification: "tool-reported" as const } } : {}) });
  const job = drain().get(id); expect(job).toBeTruthy(); return job!;
}
const signal = () => new AbortController().signal;
const extract = (quote: string, claimType: string, text = quote): TextOnlyExtractor => async () => JSON.stringify([{ text, quote, claimType, startByte: 0, endByte: Buffer.byteLength(quote) }]);
const settings = (patch: unknown) => updateMemoryLearning(database(), patch, readMemoryLearning(database()).revision);
const count = (sql: string, ...values: string[]) => Number(database().prepare(sql).get(...values)!.n);
const kindOf = (hit: { id: string; version: number }) => String(database().prepare("SELECT kind FROM memory_records WHERE id=? AND version=?").get(hit.id, hit.version)?.kind);
async function recall(query: string, bridge: MemorySearchBridge = keywordOnly, historical = false) { return (await searchMemory(query, access(), bridge, { historical })).hits; }
const facts = <T extends { id: string; version: number }>(hits: T[]) => hits.filter(hit => kindOf(hit) === "fact");
const bundleText = async (query: string) => (await buildMemoryBundle(query, access(), keywordOnly)).text;

it("makes an ordinary grounded owner fact current recall without an approval step", async () => {
  const text = "My report colour is charcoal.", job = capture("colour", text);
  await consolidateMemorySource(job, extract(text, "owner-statement"), signal());
  expect(facts(await recall("report colour charcoal"))).toEqual([expect.objectContaining({ text, state: "active", assertion: "owner-statement" })]);
  expect(count("SELECT count(*) AS n FROM memory_records WHERE state='candidate'")).toBe(0);
  expect(await bundleText("report colour")).toContain("charcoal");
});

it("recalls the correction as current while the superseded fact stays historical with both sources in order", async () => {
  const first = "I prefer long answers.", second = "Correction: I now prefer short answers.";
  const extractor = (quote: string, update = false): TextOnlyExtractor => {
    const fn: TextOnlyExtractor = async () => JSON.stringify([{ text: quote, quote, claimType: "owner-statement", subject: "owner", predicate: "answer-length", update, startByte: 0, endByte: Buffer.byteLength(quote) }]);
    fn.ground = async () => '{"supported":true}'; return fn;
  };
  await consolidateMemorySource(capture("long", first), extractor(first), signal());
  const old = database().prepare("SELECT id,version FROM memory_records WHERE kind='fact' AND text=?").get(first) as { id: string; version: number };
  await consolidateMemorySource(capture("short", second), extractor(second, true), signal());
  expect(facts(await recall("prefer answers")).map(hit => hit.text)).toEqual([second]);
  // A stale index still naming the old version cannot make it current again.
  const stale: MemorySearchBridge = { search: async () => ({ hits: [{ id: old.id, version: old.version, score: 1 }] as never, vectorRows: 0 }) };
  expect((await recall("prefer long answers", stale)).some(hit => hit.id === old.id)).toBe(false);
  const past = (await recall("prefer long answers", stale, true)).find(hit => hit.id === old.id);
  expect(past).toMatchObject({ state: "superseded", text: first }); expect(past!.validTo).not.toBeNull();
  expect(count("SELECT count(*) AS n FROM memory_source_versions WHERE source_id IN ('long','short')")).toBe(2);
  const checkpoint = (await recall("prefer answers")).find(hit => kindOf(hit) === "checkpoint")!.text;
  expect(checkpoint.indexOf(second)).toBeGreaterThanOrEqual(0);
  expect(checkpoint.indexOf(second)).toBeLessThan(checkpoint.indexOf(first));
});

it("never recalls a failed tool action as done and qualifies a completed one", async () => {
  const failed = "deployment to staging failed", job = capture("failed-deploy", failed, "tool", "failed");
  await consolidateMemorySource(job, extract(failed, "observation"), signal());
  const hits = await recall("deployment staging");
  expect(facts(hits)).toEqual([]);
  const chunks = hits.filter(hit => kindOf(hit) === "source");
  expect(chunks.length).toBeGreaterThan(0);
  for (const hit of chunks) expect(hit.sourceOutcome).toBe("failed");
  for (const hit of hits.filter(hit => kindOf(hit) === "checkpoint")) expect(hit.text).toContain("Observed tool outcome (failed)");
  const bundle = await bundleText("deployment staging");
  expect(bundle).toContain("a tool reported a failed action"); expect(bundle).not.toContain("a tool showed");
  const saved = "saved weekly report to the reports folder", done = capture("saved-report", saved, "tool", "completed");
  await consolidateMemorySource(done, extract(saved, "observation"), signal());
  expect(facts(await recall("weekly report reports folder"))).toEqual([expect.objectContaining({ text: saved, assertion: "tool-observation" })]);
});

it("keeps a cancelled turn's assistant claim out of current recall but preserves its completed tool result", async () => {
  const claim = "The release notes are published to customers.", tool = "copied release notes draft into the review folder";
  const said = capture("assistant-claim", claim, "assistant", "recorded", "turn-1");
  const did = capture("tool-result", tool, "tool", "completed", "turn-1");
  recordMemorySettlement("thread", "turn-1", "cancelled"); drain();
  await consolidateMemorySource(said, extract(claim, "observation"), signal());
  await consolidateMemorySource(did, extract(tool, "observation"), signal());
  for (const hit of await recall("release notes published customers")) expect(hit.text).not.toContain(claim);
  expect(await bundleText("release notes published customers")).not.toContain(claim);
  expect(facts(await recall("release notes review folder"))).toEqual([expect.objectContaining({ text: tool, assertion: "tool-observation" })]);
});

it("marks a turn interrupted by restart as unsettled so its assistant claim leaves current recall", async () => {
  const claim = "I have already emailed the supplier.";
  capture("assistant-interrupted", claim, "assistant", "recorded", "turn-2");
  expect((await recall("emailed supplier")).some(hit => hit.text.includes(claim))).toBe(true);
  recordMemorySettlement("thread", "turn-2", "working"); drain();
  closeDatabase();
  reconcileInterruptedMemoryTurns(); drain();
  expect(database().prepare("SELECT outcome FROM memory_sources WHERE id='turn:thread:turn-2'").get()?.outcome).toBe("interrupted");
  for (const hit of await recall("emailed supplier")) expect(hit.text).not.toContain(claim);
  expect(await bundleText("emailed supplier")).not.toContain(claim);
});

it("completes deferred distillation after restart exactly once", async () => {
  const text = "Please call me Sam in reports.", job = capture("name", text), aborted = new AbortController(); aborted.abort();
  expect(await consolidateMemorySource(job, extract(text, "owner-statement"), aborted.signal)).toMatchObject({ status: "deferred", reason: "extraction-incomplete" });
  expect(count("SELECT count(*) AS n FROM memory_records WHERE kind='fact'")).toBe(0);
  closeDatabase();
  await consolidateMemorySource(job, extract(text, "owner-statement"), signal());
  expect((await consolidateMemorySource(job, async () => { throw Error("must not call"); }, signal())).status).toBe("unchanged");
  expect(count("SELECT count(*) AS n FROM memory_records WHERE kind='fact' AND state='active'")).toBe(1);
  expect(facts(await recall("call Sam reports"))).toHaveLength(1);
});

it("refuses an exhausted quota without a fact, then learns once when budget returns", async () => {
  const limit = readMemoryLearning(database()).callsPerMinute;
  settings({ callsPerMinute: 0 });
  const text = "My timezone is Bangkok.", job = capture("timezone", text);
  expect(await consolidateMemorySource(job, extract(text, "owner-statement"), signal())).toMatchObject({ status: "deferred", reason: "budget-exhausted" });
  expect(facts(await recall("timezone Bangkok"))).toEqual([]);
  settings({ callsPerMinute: limit });
  await consolidateMemorySource(job, extract(text, "owner-statement"), signal());
  expect(facts(await recall("timezone Bangkok"))).toEqual([expect.objectContaining({ text, state: "active" })]);
});

it("keeps explicit review-only and off choices across restart", async () => {
  settings({ reviewMode: true }); closeDatabase();
  expect(readMemoryLearning(database()).reviewMode).toBe(true);
  const review = "I prefer invoices as PDF files.";
  await consolidateMemorySource(capture("review-choice", review), extract(review, "owner-statement"), signal());
  expect(database().prepare("SELECT state FROM memory_records WHERE kind='fact' AND text=?").get(review)?.state).toBe("candidate");
  expect(facts(await recall("invoices PDF files"))).toEqual([]);
  settings({ reviewMode: false, automaticFacts: false }); closeDatabase();
  expect(readMemoryLearning(database())).toMatchObject({ reviewMode: false, automaticFacts: false });
  const off = "I prefer receipts as CSV files.";
  await consolidateMemorySource(capture("off-choice", off), extract(off, "owner-statement"), signal());
  expect(database().prepare("SELECT state FROM memory_records WHERE kind='fact' AND text=?").get(off)?.state).toBe("candidate");
  expect(facts(await recall("receipts CSV files"))).toEqual([]);
});

it("does not treat repeated assistant claims or a duplicate capture as independent proof", async () => {
  const claim = "The launch date is Friday.";
  for (const id of ["echo-1", "echo-2", "echo-3"]) await consolidateMemorySource(capture(id, claim, "assistant"), extract(claim, "owner-statement"), signal());
  expect(count("SELECT count(*) AS n FROM memory_records WHERE kind='fact' AND state='active'")).toBe(0);
  expect(facts(await recall("launch date Friday"))).toEqual([]);
  const owner = "My launch date is Monday.", job = capture("owner-launch", owner);
  await consolidateMemorySource(job, extract(owner, "owner-statement"), signal());
  captureSource(database(), { id: "owner-launch", threadId: "thread", kind: "text", speaker: "owner", outcome: "recorded", text: owner });
  expect(drain().size).toBe(0);
  expect((await consolidateMemorySource(job, async () => { throw Error("must not call"); }, signal())).status).toBe("unchanged");
  const active = facts(await recall("launch date Monday"));
  expect(active).toHaveLength(1);
  expect(count("SELECT count(*) AS n FROM memory_evidence WHERE record_id=?", active[0].id)).toBe(1);
});
