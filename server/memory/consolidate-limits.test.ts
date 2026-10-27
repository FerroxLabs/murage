// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-source limits (SETTINGS-REDESIGN r3.2): attempts and calls are charged on the consolidation intent inside the reserve
// transaction, three attempts skip a slice (across restarts), only retry-skipped runs it again, and a slice stops grounding at
// SLICE_CALL_GUARD calls. A refusal charges nothing; spend-ceiling waits for the 1st of next month or a raise.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { consolidateMemorySource, releaseCeilingDeferrals, retryAfter, SLICE_SKIPPED_MESSAGE } from "./consolidate.ts";
import { claimMemoryJob, publishMemoryWork, resetMemoryClaimCursor } from "./jobs.ts";
import { readMemoryLearning, updateMemoryLearning } from "./learning-policy.ts";
import { reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { extractCandidates, type TextOnlyExtractor } from "./extract.ts";
import { extractionOutcomes } from "./extraction-outcomes.ts";
import { SLICE_CALL_GUARD, SLICE_CALL_LIMIT_REASON } from "../../shared/memory-learning-contract.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";
const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] } as unknown as MemoryRoster;
beforeEach(() => {
  extractionOutcomes.clear();
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("capture"); resetMemoryClaimCursor();
});
afterEach(() => { extractionOutcomes.clear(); vi.useRealTimers(); });

const TEXT = "I prefer green tea in the morning.";
function captured(text = TEXT) {
  storeAnchorMessage(database(), "thread", "m-src", text); captureSource(database(), { id: "src", threadId: "thread", messageId: "m-src", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text });
  const work = claimMemoryJob("w")!; publishMemoryWork(work, "w", captureWork(work));
  return work.id;
}
const intent = () => JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id IN ('consolidation','consolidation-pending')").get()!.intent));
const setIntent = (patch: Record<string, unknown>) => database().prepare("UPDATE memory_scope_bindings SET intent=json_patch(intent,?) WHERE subject_id IN ('consolidation','consolidation-pending')").run(JSON.stringify(patch));
const configure = (patch: Record<string, unknown>) => { const db = database(); updateMemoryLearning(db, patch, readMemoryLearning(db).revision); };
const signal = () => new AbortController().signal;
const failing = () => { const fn = vi.fn(async () => { throw new Error("provider down"); }); return fn as unknown as TextOnlyExtractor & typeof fn; };

it("three-then-skip: three admitted attempts, counted across a restart, skip the slice with a retry event; no automatic path tries it again", async () => {
  const job = captured(), extractor = failing();
  expect(await consolidateMemorySource(job, extractor, signal())).toMatchObject({ status: "deferred", reason: "extraction-incomplete" });
  expect(await consolidateMemorySource(job, extractor, signal())).toMatchObject({ status: "deferred" });
  expect(intent()).toMatchObject({ extractionAttempts: 2, sliceCalls: 2, cursor: 0 });
  closeDatabase(); // restart: the counters are rows
  const third = await consolidateMemorySource(job, extractor, signal());
  expect(third).toMatchObject({ status: "complete", reason: "slice-skipped", cursor: Buffer.byteLength(TEXT) });
  expect(extractor).toHaveBeenCalledTimes(3);
  const after = intent();
  expect(after).toMatchObject({ status: "complete", extractionAttempts: 0, sliceCalls: 0, skipped: [{ cursor: 0, length: Buffer.byteLength(TEXT), reason: "extraction-attempts" }] });
  const event = database().prepare("SELECT kind,source_id,detail FROM memory_learning_events WHERE json_extract(detail,'$.outcome')='slice-skipped'").get()!;
  expect(JSON.parse(String(event.detail))).toMatchObject({ message: SLICE_SKIPPED_MESSAGE, sourceId: "src", cursor: 0, length: Buffer.byteLength(TEXT), retry: { action: "retry-skipped", sourceId: "src", cursor: 0 } });
  expect(await consolidateMemorySource(job, extractor, signal())).toMatchObject({ status: "unchanged" });
  expect(extractor).toHaveBeenCalledTimes(3);
});

it("three-then-skip after a crash with the third attempt charged: the next claim skips without dispatching", async () => {
  const job = captured(), extractor = failing();
  await consolidateMemorySource(job, extractor, signal());
  setIntent({ extractionAttempts: 3, status: "deferred" });
  closeDatabase();
  expect(await consolidateMemorySource(job, extractor, signal())).toMatchObject({ status: "complete", reason: "slice-skipped" });
  expect(extractor).toHaveBeenCalledTimes(1);
});

it("refusal-charges-nothing: a ceiling refusal leaves attempts and calls as they were and waits for the 1st of next month", async () => {
  const job = captured(), extractor = failing();
  configure({ ceiling: { input: 0, output: 0 } });
  const first = await consolidateMemorySource(job, extractor, signal());
  expect(first).toMatchObject({ status: "deferred", reason: "spend-ceiling" });
  const now = new Date();
  expect(first!.retryAfter).toBe(new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime());
  expect(intent()).toMatchObject({ extractionAttempts: 0, sliceCalls: 0, reason: "spend-ceiling" });
  for (let n = 0; n < 4; n++) await consolidateMemorySource(job, extractor, signal());
  expect(intent()).toMatchObject({ extractionAttempts: 0, status: "deferred" });
  expect(extractor).not.toHaveBeenCalled();
  // a raise makes the waiting source due now
  expect(releaseCeilingDeferrals(database(), 123)).toBe(1);
  expect(intent().retryAfter).toBe(123);
});

it("retryAfter: spend-ceiling is the server-local 1st of next month, pacing the next minute", () => {
  const at = new Date(2026, 11, 31, 22, 0, 0).getTime();
  expect(retryAfter("spend-ceiling", at)).toBe(new Date(2027, 0, 1).getTime());
  expect(retryAfter("budget-exhausted", at)).toBe((Math.floor(at / 60000) + 1) * 60000);
  expect(retryAfter("extractor-busy", at)).toBe(at + 1000);
});

it("a raise through configure moves the paused source to now", async () => {
  const job = captured();
  configure({ ceiling: { input: 0, output: 0 } });
  await consolidateMemorySource(job, failing(), signal());
  expect(intent().retryAfter).toBeGreaterThan(Date.now());
  const owner = ownerMemoryTicket(), revision = readMemoryLearning(database()).revision;
  const status = await memoryOwnerRoute("/api/memory/action", { action: "configure", ceiling: { input: 200_000_000, output: 30_000_000 }, learningRevision: revision }, owner, roster) as unknown as { learning: { ceiling: Record<string, unknown> } };
  expect(status.learning.ceiling).toMatchObject({ input: 200_000_000, output: 30_000_000, paused: false });
  expect(intent().retryAfter).toBeLessThanOrEqual(Date.now());
});

const retry = (cursor: number) => memoryOwnerRoute("/api/memory/action", { action: "retry-skipped", sourceId: "src", cursor }, ownerMemoryTicket(), roster) as unknown as Promise<{ retry: { status: string; sourceId: string; cursor: number } }>;
it("retry-skipped: one press queues the slice with fresh counters, the cursor stays, and the slice runs once more", async () => {
  const job = captured(), extractor = failing();
  for (let n = 0; n < 3; n++) await consolidateMemorySource(job, extractor, signal());
  expect(intent().skipped).toHaveLength(1);
  expect((await retry(0)).retry).toEqual({ status: "queued", sourceId: "src", cursor: 0 });
  const retried = intent();
  expect(retried).toMatchObject({ status: "deferred", cursor: Buffer.byteLength(TEXT), extractionAttempts: 0, sliceCalls: 0, skipped: [], retries: [{ cursor: 0, length: Buffer.byteLength(TEXT) }] });
  expect(retried.retryAfter).toBeLessThanOrEqual(Date.now());
  expect(database().prepare("SELECT subject_id FROM memory_scope_bindings WHERE subject_id LIKE 'consolidation%'").get()!.subject_id).toBe("consolidation-pending");
  const working = vi.fn(async () => "[]") as unknown as TextOnlyExtractor;
  expect(await consolidateMemorySource(job, working, signal())).toMatchObject({ status: "complete", cursor: Buffer.byteLength(TEXT) });
  expect(working).toHaveBeenCalledTimes(1);
  expect(intent()).toMatchObject({ status: "complete", retries: [], retried: [0] });
  // a press on a slice already retried is a no-op with a clear status, never a 404
  expect((await retry(0)).retry).toEqual({ status: "done", sourceId: "src", cursor: 0 });
  expect(await consolidateMemorySource(job, working, signal())).toMatchObject({ status: "unchanged" });
  expect(working).toHaveBeenCalledTimes(1);
  await expect(retry(5)).rejects.toThrow("MEMORY_SKIPPED_SLICE_UNKNOWN");
});

it.each([true, false])("retry-skipped bypasses active reply backoff for one admitted call (success=%s)", async succeeds => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const job = captured();
  configure({ callsPerMinute: 60 });
  let reply = "bad";
  const extractor = vi.fn(async () => reply) as unknown as TextOnlyExtractor;
  for (let n = 0; n < 3; n++) await consolidateMemorySource(job, extractor, signal());
  // Two more unusable replies from the same pair elsewhere open backoff after the slice was skipped.
  for (let n = 0; n < 2; n++) await extractCandidates(TEXT, extractor, signal());
  expect(await extractCandidates(TEXT, extractor, signal())).toMatchObject({ reason: "extractor-backoff" });
  expect((await retry(0)).retry.status).toBe("queued");
  configure({ ceiling: { input: 0, output: 0 } });
  expect(await consolidateMemorySource(job, extractor, signal())).toMatchObject({ reason: "spend-ceiling" });
  expect(intent().extractionAttempts).toBe(0);
  expect(extractor).toHaveBeenCalledTimes(5);
  configure({ ceiling: { input: 200_000_000, output: 30_000_000 } });
  reply = succeeds ? "[]" : "bad";
  expect(await consolidateMemorySource(job, extractor, signal())).toMatchObject(succeeds
    ? { status: "complete", cursor: Buffer.byteLength(TEXT) }
    : { status: "deferred", reason: "extraction-incomplete" });
  expect(extractor).toHaveBeenCalledTimes(6);
  closeDatabase(); // The admitted attempt persists; reopening must not grant another bypass.
  expect(await consolidateMemorySource(job, extractor, signal())).toMatchObject(succeeds
    ? { status: "unchanged" }
    : { status: "deferred", reason: "extractor-backoff" });
  expect(extractor).toHaveBeenCalledTimes(6);
});

// Astra L3 High 1: two retries pressed before the worker runs are both kept; each slice runs exactly once, and nothing after them reruns.
it("retry-queue: retry A then B before the worker runs; A and B each run once, no cursor overwrite, no rerun of the rest", async () => {
  const A = "a".repeat(16 * 1024), B = "b".repeat(16 * 1024), C = "c".repeat(600);
  const job = captured(A + B + C);
  configure({ callsPerMinute: 60 });
  const seen: string[] = [];
  const failsOnAB = vi.fn(async (text: string) => { seen.push(text[0]!); if (text[0] !== "c") throw new Error("provider down"); return "[]"; }) as unknown as TextOnlyExtractor;
  for (let n = 0; n < 7; n++) await consolidateMemorySource(job, failsOnAB, signal());
  expect(intent()).toMatchObject({ status: "complete", cursor: A.length + B.length + C.length, skipped: [{ cursor: 0 }, { cursor: A.length }] });
  expect(seen.join("")).toBe("aaabbbc");
  expect((await retry(0)).retry.status).toBe("queued");
  expect((await retry(A.length)).retry.status).toBe("queued");
  expect((await retry(0)).retry.status).toBe("already-queued");
  expect(intent()).toMatchObject({ skipped: [], retries: [{ cursor: 0, length: A.length }, { cursor: A.length, length: B.length }] });
  seen.length = 0;
  const working = vi.fn(async (text: string) => { seen.push(text[0]!); expect(text.length).toBe(16 * 1024); return "[]"; }) as unknown as TextOnlyExtractor;
  for (let n = 0; n < 5; n++) await consolidateMemorySource(job, working, signal());
  expect(seen.join("")).toBe("ab");
  expect(intent()).toMatchObject({ status: "complete", cursor: A.length + B.length + C.length, skipped: [], retries: [], retried: [0, A.length] });
  expect((await retry(A.length)).retry.status).toBe("done");
});

it("retry-queue: a retried slice that fails three more times is skipped again, the cursor untouched, and can be retried again", async () => {
  const A = "a".repeat(16 * 1024), C = "c".repeat(600);
  const job = captured(A + C);
  configure({ callsPerMinute: 60 });
  const failsOnA = (async (text: string) => { if (text[0] === "a") throw new Error("provider down"); return "[]"; }) as TextOnlyExtractor;
  for (let n = 0; n < 4; n++) await consolidateMemorySource(job, failsOnA, signal());
  expect(intent()).toMatchObject({ status: "complete", skipped: [{ cursor: 0 }] });
  expect((await retry(0)).retry.status).toBe("queued");
  for (let n = 0; n < 3; n++) await consolidateMemorySource(job, failsOnA, signal());
  expect(intent()).toMatchObject({ status: "complete", cursor: A.length + C.length, skipped: [{ cursor: 0, length: A.length }], retries: [] });
  expect(intent().retried ?? []).toEqual([]);
  expect((await retry(0)).retry.status).toBe("queued");
});

// Astra L3 r2 High 1: slice A grounds two candidates for 35 s each; B is queued after A's 65 s claim expired. A's late commit used to
// write back the queue it read at its claim, dropping B, putting it back in `skipped` and marking the source complete.
it("stale-claim: a retry queued after a claim expired survives that claim's late commit; the claim is revoked and both slices still run", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const B = "b".repeat(16 * 1024), A = TEXT, at = A.indexOf("green tea");
  const job = captured(B + A);
  configure({ callsPerMinute: 60 });
  const candidates = JSON.stringify([1, 2].map(n => ({ text: `The owner drinks green tea (${n})`, quote: "green tea", startByte: at, endByte: at + 9, claimType: "owner-statement" })));
  let grounds = 0, pressed: unknown;
  const extractor = (async (text: string) => { if (text[0] === "b") throw new Error("provider down"); return candidates; }) as TextOnlyExtractor;
  extractor.ground = async () => { vi.setSystemTime(Date.now() + 35_000); if (++grounds === 2) pressed = (await retry(0)).retry; return '{"supported":true}'; };
  for (let n = 0; n < 3; n++) await consolidateMemorySource(job, extractor, signal());
  expect(intent()).toMatchObject({ cursor: B.length, skipped: [{ cursor: 0, length: B.length }] });
  await expect(consolidateMemorySource(job, extractor, signal())).rejects.toThrow("MEMORY_CONSOLIDATION_REVOKED");
  expect(grounds).toBe(2);
  expect(pressed).toEqual({ status: "queued", sourceId: "src", cursor: 0 });
  expect(intent()).toMatchObject({ status: "deferred", cursor: B.length, skipped: [], retries: [{ cursor: 0, length: B.length }] });
  expect(intent().generation).toBeUndefined();
  const seen: string[] = [];
  const working = vi.fn(async (text: string) => { seen.push(text[0]!); return "[]"; }) as unknown as TextOnlyExtractor;
  for (let n = 0; n < 4; n++) await consolidateMemorySource(job, working, signal());
  expect(seen.join("")).toBe("bI");
  expect(intent()).toMatchObject({ status: "complete", cursor: B.length + A.length, skipped: [], retries: [], retried: [0] });
});

it("queue-cas: any queue change made under a running claim is never overwritten by that claim's commit", async () => {
  const B = "b".repeat(16 * 1024);
  const job = captured(B + TEXT);
  configure({ callsPerMinute: 60 });
  const failsOnB = (async (text: string) => { if (text[0] === "b") throw new Error("provider down"); return "[]"; }) as TextOnlyExtractor;
  for (let n = 0; n < 3; n++) await consolidateMemorySource(job, failsOnB, signal());
  const revision = Number(intent().queueRevision) || 0, queued = { cursor: 0, length: B.length };
  // another writer changes the queue while the claim on the main slice is in flight (its generation untouched)
  const underneath = (async () => { setIntent({ skipped: [], retries: [queued], queueRevision: revision + 1 }); return "[]"; }) as TextOnlyExtractor;
  await expect(consolidateMemorySource(job, underneath, signal())).rejects.toThrow("MEMORY_CONSOLIDATION_REVOKED");
  expect(intent()).toMatchObject({ cursor: B.length, skipped: [], retries: [queued], queueRevision: revision + 1 });
});

it("slice-call-limit: grounding stops at the guard, the rest are recorded unsupported with the limit reason, and the slice commits", async () => {
  const job = captured();
  configure({ callsPerMinute: 60 });
  // a slice that already spent calls (two failed attempts and grounding before a crash)
  await consolidateMemorySource(job, failing(), signal());
  setIntent({ sliceCalls: SLICE_CALL_GUARD - 6, extractionAttempts: 1 });
  const start = Buffer.from(TEXT).indexOf("green tea"), quote = "green tea";
  const candidates = Array.from({ length: 20 }, (_, n) => ({ text: `The owner drinks green tea, note ${n}`, quote, startByte: start, endByte: start + Buffer.byteLength(quote), claimType: "owner-statement" }));
  const extractor = (async () => JSON.stringify(candidates)) as TextOnlyExtractor;
  const ground = vi.fn(async () => '{"supported":false}');
  extractor.ground = ground;
  const result = await consolidateMemorySource(job, extractor, signal());
  expect(result).toMatchObject({ status: "complete" });
  // 18 before, 1 extraction = 19, then 5 grounding calls reach 24
  expect(ground).toHaveBeenCalledTimes(5);
  expect(Number(database().prepare("SELECT count(*) AS n FROM memory_record_details WHERE confidence_basis=?").get(SLICE_CALL_LIMIT_REASON)!.n)).toBe(15);
  expect(intent()).toMatchObject({ sliceCalls: 0, extractionAttempts: 0 });
});

it("merged grounding: a correction candidate costs one call, answering the correction and the support check", async () => {
  const job = captured();
  configure({ callsPerMinute: 60 });
  const start = Buffer.from(TEXT).indexOf("green tea"), quote = "green tea";
  database().exec("PRAGMA foreign_keys=OFF");
  const scope = String(database().prepare("SELECT scope_id FROM memory_sources WHERE id='src'").get()!.scope_id);
  database().prepare("INSERT INTO memory_records VALUES('prior',1,?,'fact','The owner drinks black tea','owner-statement','active',0,1,NULL,NULL,1)").run(scope);
  database().prepare("INSERT OR REPLACE INTO memory_record_details(record_id,record_version,partition,attention,claim_status,observed_at,entities) VALUES('prior',1,'semantic','useful','current',NULL,?)").run(JSON.stringify(["owner", "tea"]));
  const extractor = (async () => JSON.stringify([{ text: "The owner drinks green tea", quote, startByte: start, endByte: start + Buffer.byteLength(quote), claimType: "owner-statement", subject: "owner", predicate: "tea", update: true }])) as TextOnlyExtractor;
  const ground = vi.fn(async (input: { previousClaim?: string }) => { expect(input.previousClaim).toBe("The owner drinks black tea"); return '{"supported":true,"updates":false}'; });
  extractor.ground = ground as unknown as NonNullable<TextOnlyExtractor["ground"]>;
  expect(await consolidateMemorySource(job, extractor, signal())).toMatchObject({ status: "complete" });
  expect(ground).toHaveBeenCalledTimes(1);
  // entailed but not an update: no supersede link
  expect(database().prepare("SELECT supersedes_id FROM memory_records WHERE id LIKE 'candidate:%'").get()!.supersedes_id).toBeNull();
});
