// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The support check on the real wire: every reply a reasoning arm can give to a 64-token grounding call, through the real request code against a
// local stub, and what becomes of the claim. A claim that was not judged is never active, never read by a bot, and the owner sees it.
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { consolidateMemorySource, pendingMemoryConsolidationJobs, promoteDueSkippedSlices } from "./consolidate.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { extractionOutcomes } from "./extraction-outcomes.ts";
import { requestMemoryExtraction, requestMemoryGrounding, type TextOnlyExtractor } from "./extract.ts";
import { claimMemoryJob, publishMemoryWork, resetMemoryClaimCursor } from "./jobs.ts";
import { readMemoryLearning, updateMemoryLearning } from "./learning-policy.ts";
import { reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { candidateReviewReason } from "./automatic-learning.ts";
import { reviewEdit, reviewKeep, reviewUndo, waitingCounts } from "./review.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";

const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] } as unknown as MemoryRoster;
const TEXT = "I prefer green tea in the morning.", QUOTE = "green tea";
const start = Buffer.from(TEXT).indexOf(QUOTE);
const claim = { text: "The owner prefers green tea in the morning.", quote: QUOTE, startByte: start, endByte: start + Buffer.byteLength(QUOTE), claimType: "owner-statement" };

type Reply = { content: string | null; finish: string; completion: number; reasoning?: number; reasoningContent?: string };
const ARMS: Record<string, Reply> = {
  "plain-yes": { content: '{"supported":true}', finish: "stop", completion: 6 },
  "plain-no": { content: '{"supported":false}', finish: "stop", completion: 6 },
  "reasoning-cut-empty": { content: "", finish: "length", completion: 64, reasoning: 64, reasoningContent: "The claim says..." },
  "reasoning-cut-null": { content: null, finish: "length", completion: 64, reasoning: 64, reasoningContent: "The claim says..." },
  "reasoning-61-stop-empty": { content: "", finish: "stop", completion: 61, reasoning: 61, reasoningContent: "The claim says..." },
  "reasoning-then-partial": { content: '{"suppor', finish: "length", completion: 64, reasoning: 60 },
  "fenced-yes": { content: '```json\n{"supported":true}\n```', finish: "stop", completion: 12 },
};

let extraction: Record<string, unknown> = claim;
let server: Server, url = "", arm: Reply = ARMS["plain-yes"]!, groundCalls = 0, groundCaps: number[] = [];
beforeAll(async () => {
  server = createServer((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", part => { body += part; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { max_tokens: number };
      const grounding = parsed.max_tokens <= 64;
      const reply = grounding ? arm : { content: JSON.stringify([extraction]), finish: "stop", completion: 40 };
      if (grounding) { groundCalls++; groundCaps.push(parsed.max_tokens); }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ finish_reason: reply.finish, message: { role: "assistant", content: reply.content, ...(reply.reasoningContent ? { reasoning_content: reply.reasoningContent } : {}) } }], usage: { prompt_tokens: 100, completion_tokens: reply.completion, ...(reply.reasoning ? { completion_tokens_details: { reasoning_tokens: reply.reasoning } } : {}) } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  extractionOutcomes.clear(); groundCalls = 0; groundCaps = []; extraction = claim;
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("capture"); resetMemoryClaimCursor();
  configure({ callsPerMinute: 60 });
});
afterEach(() => { extractionOutcomes.clear(); vi.useRealTimers(); });

const configure = (patch: Record<string, unknown>) => { const db = database(); updateMemoryLearning(db, patch, readMemoryLearning(db).revision); };
function captured() {
  storeAnchorMessage(database(), "thread", "m-src", TEXT);
  captureSource(database(), { id: "src", threadId: "thread", messageId: "m-src", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text: TEXT, occurredAt: 1000 } as never);
  const work = claimMemoryJob("w")!; publishMemoryWork(work, "w", captureWork(work));
  return work.id;
}
function realExtractor(): TextOnlyExtractor {
  const config = { url, apiKey: "rig", model: "rig-arm" };
  const extractor = ((text, max, signal, dispatch) => requestMemoryExtraction(config, text, max, signal, dispatch?.messages, dispatch?.fence)) as TextOnlyExtractor;
  extractor.ground = (input, max, signal, fence) => requestMemoryGrounding(config, input, Math.min(64, max), signal, fence);
  return extractor;
}
const results: Array<Record<string, unknown>> = [];
async function run(name: string, mode = "auto", prepare?: () => void) {
  arm = ARMS[name]!;
  const job = captured();
  prepare?.();
  const extractor = realExtractor(), first = await consolidateMemorySource(job, extractor, new AbortController().signal);
  const callsFirst = groundCalls, again = await consolidateMemorySource(job, extractor, new AbortController().signal);
  const db = database();
  const row = db.prepare("SELECT r.id,r.state,r.kind,d.confidence_basis AS basis,d.claim_status AS status FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version WHERE r.id LIKE 'candidate:%'").get();
  const waiting = [...waitingCounts(db, roster).values()].reduce((sum, item) => sum + item.waiting, 0);
  const seen = { arm: name, mode, slice: first.status, rerun: again.status, groundCalls: callsFirst, groundCallsAfterRerun: groundCalls, cap: groundCaps[0], state: row?.state, basis: row?.basis, claimStatus: row?.status, needsYou: waiting, ownerSees: row ? candidateReviewReason(db, String(row.id), 1) : undefined };
  results.push(seen);
  return seen;
}
afterAll(() => { console.log(`RIGTABLE ${JSON.stringify(results)}`); });

it.each(Object.keys(ARMS))("auto learning, %s", async name => {
  const seen = await run(name);
  expect(seen.cap).toBe(64);
  expect(seen.state).toBe(name === "plain-yes" || name === "fenced-yes" ? "active" : "candidate");
});

it.each(Object.keys(ARMS))("asking first, %s: held for the owner", async name => {
  const seen = await run(name, "review", () => configure({ reviewMode: true }));
  expect(seen.state).toBe("candidate");
});

it("no answer and an honest no read differently, and each says what Keep does", async () => {
  const unfinished = await run("reasoning-cut-empty"), row = () => String(database().prepare("SELECT id FROM memory_records WHERE id LIKE 'candidate:%'").get()!.id);
  expect(unfinished.ownerSees).toBe("The check did not finish. Keep uses your decision.");
  database().prepare("UPDATE memory_record_details SET confidence_basis='unsupported-claim' WHERE record_id=?").run(row());
  expect(candidateReviewReason(database(), row(), 1)).toBe("The source did not support this. Keep it if you know it is true.");
  expect(`${unfinished.ownerSees}`).not.toMatch(/[\u2013\u2014]/);
});

it("the Keep path on a check that did not finish: Keep is the owner's decision, Undo returns it, and nothing decides for the owner afterwards", async () => {
  const seen = await run("reasoning-cut-empty");
  expect(seen).toMatchObject({ state: "candidate", needsYou: 1 });
  const db = database(), id = String(db.prepare("SELECT id FROM memory_records WHERE id LIKE 'candidate:%'").get()!.id), ticket = ownerMemoryTicket();
  const state = () => db.prepare("SELECT r.state,d.confidence_basis AS basis FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version WHERE r.id=?").get(id);
  const kept = reviewKeep(ticket, roster, { actionId: "keep-1", id, version: 1 });
  expect(kept.result).toMatchObject({ status: "kept" });
  expect(state()).toMatchObject({ state: "active", basis: "owner_confirmed" });
  const undone = reviewUndo(ticket, roster, { actionId: "undo-1", keepActionId: "keep-1", id, version: 1 });
  expect(undone.result).toMatchObject({ status: "waiting" });
  // Undo puts back why it was waiting, so Needs you says what it said before Keep
  expect(state()).toMatchObject({ state: "candidate", basis: "grounding-incomplete" });
  expect(candidateReviewReason(db, id, 1)).toBe("The check did not finish. Keep uses your decision.");
  const calls = groundCalls;
  expect(promoteDueSkippedSlices(4)).toBe(0);
  expect(pendingMemoryConsolidationJobs()).toEqual([]);
  expect(groundCalls).toBe(calls);
  expect(state()).toMatchObject({ state: "candidate" });
  results.push({ arm: "keep-then-undo", needsYou: [...waitingCounts(db, roster).values()].reduce((sum, item) => sum + item.waiting, 0), ownerSees: candidateReviewReason(db, id, 1) });
});

it("Keep then Undo on a memory the source did not support shows the same words as before", async () => {
  const seen = await run("plain-no");
  expect(seen).toMatchObject({ state: "candidate", basis: "unsupported-claim" });
  const db = database(), id = String(db.prepare("SELECT id FROM memory_records WHERE id LIKE 'candidate:%'").get()!.id), ticket = ownerMemoryTicket();
  reviewKeep(ticket, roster, { actionId: "keep-2", id, version: 1 });
  expect(reviewUndo(ticket, roster, { actionId: "undo-2", keepActionId: "keep-2", id, version: 1 }).result).toMatchObject({ status: "waiting" });
  expect(candidateReviewReason(db, id, 1)).toBe("The source did not support this. Keep it if you know it is true.");
  // an edit and Keep waits again for the same reason, on the edited version
  reviewEdit(ticket, roster, { actionId: "edit-3", id, version: 1, text: "Sean's edited words", keep: true });
  expect(reviewUndo(ticket, roster, { actionId: "undo-3", keepActionId: "edit-3", id, version: 2 }).result).toMatchObject({ status: "waiting", version: 2 });
  expect(candidateReviewReason(db, id, 2)).toBe("The source did not support this. Keep it if you know it is true.");
  // a Keep made before Keep stored the reason leaves only owner_confirmed behind
  db.prepare("UPDATE memory_record_details SET confidence_basis='owner_confirmed' WHERE record_id=?").run(id);
  expect(candidateReviewReason(db, id, 1)).toBe("The source did not support this. Keep it if you know it is true.");
});

it("a correction whose check got no answer leaves the old memory in place", async () => {
  const seen = await run("reasoning-cut-empty", "correction", () => {
    extraction = { ...claim, subject: "owner", predicate: "tea", update: true };
    database().exec("PRAGMA foreign_keys=OFF");
    const scope = String(database().prepare("SELECT scope_id FROM memory_sources WHERE id='src'").get()!.scope_id);
    database().prepare("INSERT INTO memory_records VALUES('prior',1,?,'fact','The owner drinks black tea','owner-statement','active',0,1,NULL,NULL,1)").run(scope);
    database().prepare("INSERT OR REPLACE INTO memory_record_details(record_id,record_version,partition,attention,claim_status,observed_at,entities) VALUES('prior',1,'semantic','useful','current',NULL,?)").run(JSON.stringify(["owner", "tea"]));
  });
  results.push({ arm: "prior-after-correction", state: database().prepare("SELECT state FROM memory_records WHERE id='prior'").get()?.state });
  expect(seen.state).toBe("candidate");
});
