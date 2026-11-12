// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory learning when no good reply comes back: a network failure costs a slice nothing and waits its turn, a skipped slice comes back by itself
// on a schedule behind every gate an owner's source has, and the pinned model falls back so that a pin that is dead in the field is today's path.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { openLearningGate } from "../testing/open-learning-gate.ts";
import { consolidateMemorySource, pendingMemoryConsolidationJobs, promoteDueSkippedSlices, retrySkippedSlice } from "./consolidate.ts";
import { extractCandidates, groundMemoryClaim, isNetworkFailure, type TextOnlyExtractor } from "./extract.ts";
import { clearPinQuarantineForTests, PIN_QUARANTINE_MS, resolveLearningConnection, resolveMemoryExtractor, setLearningClockForTests } from "./extractor-connections.ts";
import { extractionOutcomes, FLUX_PINNED_LEARNING_MODEL } from "./extraction-outcomes.ts";
import { resetFluxKeyModelsForTests, setFluxKeyCatalog } from "../flux-key-models.ts";
import { claimMemoryJob, publishMemoryWork, resetMemoryClaimCursor } from "./jobs.ts";
import { readMemoryLearning, updateMemoryLearning } from "./learning-policy.ts";
import { reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";

const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] } as unknown as MemoryRoster;
// What a key's own Flux catalog lists. A paid key lists the pinned learning model; a never-paid key lists flux-fast and flux-auto only.
const PAID_CATALOG = ["flux-auto", "flux-fast", "flux-standard", "flux-reasoning", "flux-pinned-gpt-5-nano"];
const FREE_CATALOG = ["flux-auto", "flux-fast"];
beforeEach(() => {
  extractionOutcomes.clear(); clearPinQuarantineForTests(); setLearningClockForTests(null);
  resetFluxKeyModelsForTests(); setFluxKeyCatalog(() => PAID_CATALOG);
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("capture"); resetMemoryClaimCursor();
  const db = database(); updateMemoryLearning(db, { callsPerMinute: 60 }, readMemoryLearning(db).revision);
});
afterEach(() => { extractionOutcomes.clear(); setLearningClockForTests(null); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const TEXT = "I prefer green tea in the morning.";
const LENGTH = Buffer.byteLength(TEXT);
function captured(id = "src") {
  storeAnchorMessage(database(), "thread", `m-${id}`, TEXT);
  captureSource(database(), { id, threadId: "thread", messageId: `m-${id}`, origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text: TEXT });
  const work = claimMemoryJob("w")!; publishMemoryWork(work, "w", captureWork(work));
  return work.id;
}
const signal = () => new AbortController().signal;
const fenced = () => ({ fence: openLearningGate() }) as never;
const intent = () => JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id IN ('consolidation','consolidation-pending')").get()!.intent));
const dueRows = () => database().prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_id='consolidation-skip-due'").all().map(row => ({ id: String(row.id), ...JSON.parse(String(row.intent)) })) as Array<{ id: string; cursor: number; dueAt: number; run: number; auto: boolean; bindingId: string }>;
const setDue = (patch: Record<string, unknown>) => database().prepare("UPDATE memory_scope_bindings SET intent=json_patch(intent,?) WHERE subject_id='consolidation-skip-due'").run(JSON.stringify(patch));
const setIntent = (patch: Record<string, unknown>) => database().prepare("UPDATE memory_scope_bindings SET intent=json_patch(intent,?) WHERE subject_id IN ('consolidation','consolidation-pending')").run(JSON.stringify(patch));
const events = () => database().prepare("SELECT 1 FROM memory_learning_events WHERE json_extract(detail,'$.outcome')='slice-skipped'").all().length;
const failing = () => { const fn = vi.fn(async () => { throw new Error("provider down"); }); return fn as unknown as TextOnlyExtractor & typeof fn; };
const refused = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect"), { code }) });
const unreachable = () => { const fn = vi.fn(async () => { throw refused("ENOTFOUND"); }); return fn as unknown as TextOnlyExtractor & typeof fn; };
async function skip(job: string) { const extractor = failing(); for (let n = 0; n < 3; n++) await consolidateMemorySource(job, extractor, signal()); return extractor; }
const HOUR = 3_600_000;

it("reads a connect failure anywhere in the error, and never an HTTP status or a reset after sending", () => {
  expect(isNetworkFailure(refused("ETIMEDOUT"))).toBe(true);
  expect(isNetworkFailure(new TypeError("fetch failed", { cause: new AggregateError([Object.assign(new Error("a"), { code: "ECONNREFUSED" })]) }))).toBe(true);
  expect(isNetworkFailure(Object.assign(new Error("x"), { status: 503, cause: { code: "ENOTFOUND" } }))).toBe(false);
  expect(isNetworkFailure(refused("ECONNRESET"))).toBe(false);
  expect(isNetworkFailure(new Error("provider down"))).toBe(false);
});

it("a run of network failures waits behind a growing backoff that an owner's retry does not pass, and a good reply clears it", async () => {
  const net = unreachable();
  expect(await extractCandidates(TEXT, net, signal(), undefined, undefined, { ownerRetry: true })).toMatchObject({ reason: "extractor-unreachable", noReply: true });
  const held = await extractCandidates(TEXT, net, signal(), undefined, undefined, { ownerRetry: true });
  expect(held).toMatchObject({ reason: "extractor-unreachable" });
  expect(held).not.toHaveProperty("noReply");
  expect(net).toHaveBeenCalledTimes(1);
  const outcomes = extractionOutcomes.forExtractor(net), first = outcomes.networkRetryAt - Date.now();
  expect(first).toBeGreaterThan(50_000); expect(first).toBeLessThanOrEqual(60_000);
  for (let n = 0; n < 8; n++) extractionOutcomes.networkFailed(outcomes);
  expect(outcomes.networkRetryAt - Date.now()).toBeLessThanOrEqual(15 * 60_000);
  extractionOutcomes.completed(outcomes);
  expect(outcomes.networkRetryAt).toBe(0);
});

it("a network failure does not count as an unusable reply in health", async () => {
  const settled = vi.spyOn(extractionOutcomes, "settled"), net = unreachable();
  await extractCandidates(TEXT, net, signal());
  expect(settled).toHaveBeenCalledWith(expect.anything(), "cancelled", undefined);
});

it("a failed support call during an outage does not keep calling, and says why in the log", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const extractor = (async () => "[]") as unknown as TextOnlyExtractor;
  extractor.ground = vi.fn(async () => { throw refused("EAI_AGAIN"); });
  const input = { text: "claim", quote: "q", claimType: "owner-statement", speaker: "owner", outcome: "recorded" };
  expect(await groundMemoryClaim(input, extractor, signal())).toEqual({ supported: false, reason: "grounding-incomplete" });
  expect(await groundMemoryClaim(input, extractor, signal())).toEqual({ supported: false, reason: "grounding-busy-or-cancelled" });
  expect(extractor.ground).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls.flat().join("\n")).toContain("[memory] support check unfinished: reason=network");
});

it("the first skip schedules the slice, logs a line with no ids or text, and raises one event", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await skip(captured());
  const [due] = dueRows();
  expect(due).toMatchObject({ cursor: 0, run: 0, auto: false });
  expect(due!.dueAt - Date.now()).toBeGreaterThan(0.9 * HOUR);
  expect(JSON.stringify(due)).not.toContain("tea");
  const line = warn.mock.calls.flat().find(item => String(item).startsWith("[memory] slice skipped:"));
  expect(line).toMatch(new RegExp(`^\\[memory\\] slice skipped: reason=transport-error attempts=3 bytes=${LENGTH} run=0 next=\\d{4}-.*Z$`));
  expect(events()).toBe(1);
  expect(intent()).toMatchObject({ status: "complete", skipped: [{ cursor: 0 }] });
  expect(database().prepare("SELECT reason FROM (SELECT json_extract(intent,'$.skipped[0].reason') AS reason FROM memory_scope_bindings WHERE subject_id='consolidation')").get()!.reason).toBe("extraction-attempts");
});

it("a due slice comes back through the ordinary claim with one attempt, and a second skip stays quiet and moves on the schedule", async () => {
  const job = captured(); await skip(job);
  expect(promoteDueSkippedSlices()).toBe(0);
  setDue({ dueAt: Date.now() - 1 });
  expect(promoteDueSkippedSlices()).toBe(1);
  expect(intent()).toMatchObject({ status: "deferred", reason: "retry-skipped", extractionAttempts: 2, sliceCalls: 0, retries: [{ cursor: 0, length: LENGTH }] });
  expect(intent().skipped).toEqual([]);
  const [promoted] = dueRows();
  expect(promoted).toMatchObject({ run: 1, auto: true });
  expect(promoted!.dueAt - Date.now()).toBeGreaterThan(5.9 * HOUR);
  expect(pendingMemoryConsolidationJobs()).toContain(job);
  const extractor = failing();
  expect(await consolidateMemorySource(job, extractor, signal())).toMatchObject({ reason: "slice-skipped" });
  expect(extractor).toHaveBeenCalledTimes(1);
  expect(events()).toBe(1);
  expect(dueRows()[0]).toMatchObject({ run: 1, auto: false });
});

it("a due slice that succeeds is done: its row goes, and an owner press answers done", async () => {
  const job = captured(); await skip(job);
  setDue({ dueAt: Date.now() - 1 }); promoteDueSkippedSlices();
  const fine = vi.fn(async () => "[]") as unknown as TextOnlyExtractor;
  expect(await consolidateMemorySource(job, fine, signal())).toMatchObject({ status: "complete" });
  expect(dueRows()).toEqual([]);
  expect(intent()).toMatchObject({ retried: [0], skipped: [] });
});

it("an automatic run honours reply backoff, which an owner's first retry may pass", async () => {
  const job = captured(); await skip(job);
  setDue({ dueAt: Date.now() - 1 }); promoteDueSkippedSlices();
  const extractor = failing();
  extractionOutcomes.forExtractor(extractor).retryAt = Date.now() + 60_000;
  expect(await consolidateMemorySource(job, extractor, signal())).toMatchObject({ reason: "extractor-backoff" });
  expect(extractor).not.toHaveBeenCalled();
});

it("a network failure on an automatic run costs it nothing", async () => {
  const job = captured(); await skip(job);
  setDue({ dueAt: Date.now() - 1 }); promoteDueSkippedSlices();
  expect(await consolidateMemorySource(job, unreachable(), signal())).toMatchObject({ status: "deferred", reason: "extractor-unreachable" });
  expect(intent()).toMatchObject({ extractionAttempts: 2, sliceCalls: 0, retries: [{ cursor: 0 }] });
});

it.each([
  ["waiting for next month's ceiling", { status: "deferred", reason: "spend-ceiling", retryAfter: Date.now() + 86_400_000 }],
  ["withheld with no retry", { status: "deferred", reason: "reply-withheld", retryAfter: null }],
  ["claimed", { status: "running", generation: "g", expiresAt: Date.now() + 60_000 }],
])("a source %s holds the retry back, using no run", async (_name, patch) => {
  await skip(captured());
  setIntent(patch); setDue({ dueAt: Date.now() - 1 });
  expect(promoteDueSkippedSlices()).toBe(0);
  expect(intent().retries ?? []).toEqual([]);
  const [row] = dueRows();
  expect(row).toMatchObject({ run: 0, auto: false });
  expect(row!.dueAt - Date.now()).toBeGreaterThan(0.9 * HOUR);
});

it("a slice still queued keeps its row, and one an owner already finished, or a forgotten source, loses it", async () => {
  const job = captured(); await skip(job);
  retrySkippedSlice(database(), "src", 0);
  setDue({ dueAt: Date.now() - 1 });
  expect(promoteDueSkippedSlices()).toBe(0);
  expect(dueRows()).toHaveLength(1);
  await consolidateMemorySource(job, (async () => "[]") as unknown as TextOnlyExtractor, signal());
  expect(dueRows()).toEqual([]);
  await skip(captured("src2"));
  setDue({ dueAt: Date.now() - 1 });
  database().prepare("UPDATE memory_sources SET state='deleted' WHERE id='src2'").run();
  expect(promoteDueSkippedSlices()).toBe(0);
  expect(dueRows()).toEqual([]);
});

it("slices skipped before this build are found page by page past the bound, and each only once", async () => {
  await skip(captured());
  const db = database(), scope = String(db.prepare("SELECT scope_id FROM memory_sources WHERE id='src'").get()!.scope_id);
  for (const row of dueRows()) db.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run(row.id);
  // more rows than one page, sorting on both sides of the real one
  for (let n = 0; n < 300; n++) db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','observability',0,'granted','{}')").run(`${n % 2 ? "a" : "z"}-filler-${n}`, scope);
  const pages = () => JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id='skip-due-backfill'").get()?.intent ?? "{}"));
  for (let pass = 0; pass < 6 && !pages().done; pass++) { promoteDueSkippedSlices(0, 0); closeDatabase(); }
  expect(pages()).toMatchObject({ done: true });
  expect(dueRows()).toHaveLength(1);
  expect(dueRows()[0]).toMatchObject({ cursor: 0, run: 0 });
  promoteDueSkippedSlices(0, 0);
  expect(dueRows()).toHaveLength(1);
});

// The pin, on the wire
const body = (content: unknown, finish = "stop") => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
const fluxWire = (reply: (model: string) => Response | Promise<Response>) => {
  const models: string[] = [], request = vi.fn(async (_url: unknown, init: { body: string }) => { const sent = JSON.parse(init.body); models.push(sent.model); expect(sent).not.toHaveProperty("stop"); expect(sent).not.toHaveProperty("reasoning"); expect(sent).not.toHaveProperty("reasoning_effort"); return reply(sent.model); });
  vi.stubGlobal("fetch", request);
  return { models, request };
};
const refusal = (status: number) => new Response(JSON.stringify({ error: { message: "model not allowed", code: "key_model_access_denied" } }), { status });
const connection = (key = "paid") => resolveLearningConnection({ selected: "@murage/flux-fast", instances: [], readKey: () => key, defaultOn: true });

it("extraction and support checks ask for the pinned alias, and each call logs its arm", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const wire = fluxWire(() => body("[]")), { extractor } = connection();
  expect(extractor!.learningModel!()).toBe(FLUX_PINNED_LEARNING_MODEL);
  await extractor!("text", 100, signal(), fenced());
  await extractor!.ground!({ text: "a", quote: "b", claimType: "fact", speaker: "owner", outcome: "x" }, 64, signal(), openLearningGate("grounding"));
  expect(wire.models).toEqual(["flux-pinned-gpt-5-nano", "flux-pinned-gpt-5-nano"]);
  const lines = info.mock.calls.flat().join("\n");
  expect(lines).toContain("[memory] learning call: purpose=extraction arm=pinned");
  expect(lines).toContain("[memory] learning call: purpose=grounding arm=pinned");
});

it.each([403, 400, 404])("a %i on the pin, refused before routing: flux-fast answers in the same call, the choice is remembered per key, and learning is not paused", async status => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {}), info = vi.spyOn(console, "info").mockImplementation(() => {});
  const wire = fluxWire(model => model === "flux-fast" ? body("[]") : refusal(status));
  const { extractor } = connection();
  expect(await extractor!("text", 100, signal(), fenced())).toBe("[]");
  expect(await extractor!("text", 100, signal(), fenced())).toBe("[]");
  expect(wire.models).toEqual(["flux-pinned-gpt-5-nano", "flux-fast", "flux-fast"]);
  expect(warn.mock.calls.flat().filter(line => String(line).includes("learning model refused"))).toEqual([`[memory] learning model refused: status=${status} fallback=flux-fast for=6h`]);
  expect(info.mock.calls.flat().join("\n")).toContain("arm=fast");
  expect(extractor!.learningModel!()).toBe("flux-fast");
  expect(connection().extractor).not.toBeNull();
  // another key still tries the pin
  wire.models.length = 0;
  await connection("other").extractor!("text", 100, signal(), fenced());
  expect(wire.models[0]).toBe("flux-pinned-gpt-5-nano");
});

// FLUX-FREE-MODEL 1.0.18. A Masterclass customer's never-paid key asked Flux for flux-pinned-gpt-5-nano on its first learning call and got
// this 403 (recorded from Flux, the Flux router's model access refusal handler). A free key may call flux-fast and flux-auto only.
const RECORDED_403 = () => new Response(JSON.stringify({ error: { message: "key not allowed to access model. This key can only access models=['flux-auto', 'flux-fast']. Tried to access flux-pinned-gpt-5-nano", type: "auth_error", param: "model", code: "403" } }), { status: 403 });
const RECORDED_403_SHAPED = () => new Response(JSON.stringify({ error: { message: "flux-pinned-gpt-5-nano is not on the Flux free plan. Upgrade at https://fluxrouter.ai/home/billing to unlock it. Your key can use: flux-auto, flux-fast.", type: "auth_error", param: "model", code: "403" } }), { status: 403 });

it.each([["a free-plan catalog", FREE_CATALOG], ["no catalog yet", null]] as const)("a key with %s never asks for a flux-pinned-* id: extraction and support checks run on flux-fast", async (_name, catalog) => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  setFluxKeyCatalog(() => catalog);
  const wire = fluxWire(model => model.startsWith("flux-pinned-") ? RECORDED_403() : body("[]")), { extractor } = connection("never-paid");
  expect(extractor!.learningModel!()).toBe("flux-fast");
  await extractor!("text", 100, signal(), fenced());
  await extractor!.ground!({ text: "a", quote: "b", claimType: "fact", speaker: "owner", outcome: "x" }, 64, signal(), openLearningGate("grounding"));
  expect(wire.models).toEqual(["flux-fast", "flux-fast"]);
  expect(wire.models.some(model => model.startsWith("flux-pinned-"))).toBe(false);
});

it("only the key's own catalog counts: a paid key keeps the pin while a free key beside it never sends it", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  setFluxKeyCatalog(key => key === "paid" ? PAID_CATALOG : FREE_CATALOG);
  const wire = fluxWire(() => body("[]"));
  await connection("paid").extractor!("text", 100, signal(), fenced());
  await connection("never-paid").extractor!("text", 100, signal(), fenced());
  expect(wire.models).toEqual(["flux-pinned-gpt-5-nano", "flux-fast"]);
});

it.each([["LiteLLM's refusal", RECORDED_403], ["Flux's free-plan sentence", RECORDED_403_SHAPED]] as const)("after Flux's recorded 403 (%s) the same call is sent again exactly once, on a free-plan model, and the pin is not asked again", async (_name, refused) => {
  vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {});
  const wire = fluxWire(model => model.startsWith("flux-pinned-") ? refused() : body("[]")), { extractor } = connection();
  expect(await extractor!("text", 100, signal(), fenced())).toBe("[]");
  expect(wire.models).toEqual(["flux-pinned-gpt-5-nano", "flux-fast"]);
  expect(["flux-fast", "flux-auto"]).toContain(wire.models[1]);
  await extractor!("text", 100, signal(), fenced());
  expect(wire.models).toEqual(["flux-pinned-gpt-5-nano", "flux-fast", "flux-fast"]);
});

it.each([
  ["extraction", "not json at all", async (extractor: TextOnlyExtractor) => extractCandidates("text", extractor, signal(), undefined, undefined, { fence: openLearningGate() })],
  ["a support check", "not json at all", async (extractor: TextOnlyExtractor) => groundMemoryClaim({ text: "a", quote: "b", claimType: "fact", speaker: "owner", outcome: "x" }, extractor, signal(), undefined, openLearningGate("grounding"))],
])("a pin reply to %s that arrives and will not parse counts as today, and the next call goes to flux-fast", async (_name, reply, call) => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const wire = fluxWire(() => body(reply)), { extractor } = connection();
  await call(extractor!);
  expect(wire.models).toEqual(["flux-pinned-gpt-5-nano"]);
  expect(warn.mock.calls.flat().filter(line => String(line).includes("learning model refused"))).toEqual(["[memory] learning model refused: status=reply fallback=flux-fast for=6h"]);
  expect(extractor!.learningModel!()).toBe("flux-fast");
});

it("a caller's cancel says nothing about the pin", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  fluxWire(() => body("[]"));
  const { extractor } = connection(), stop = new AbortController();
  await extractor!("text", 100, signal(), fenced());
  stop.abort();
  extractor!.pinReplyUnusable!(new Error("cancelled after the reply"), stop.signal);
  expect(extractor!.learningModel!()).toBe(FLUX_PINNED_LEARNING_MODEL);
});

it("the refusal is forgotten after a while, so a key that gains the pin gets it", async () => {
  let now = 1_000_000; setLearningClockForTests(() => now);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const wire = fluxWire(model => model === "flux-fast" ? body("[]") : refusal(403));
  const { extractor } = connection();
  await extractor!("text", 100, signal(), fenced());
  now += PIN_QUARANTINE_MS + 1;
  await extractor!("text", 100, signal(), fenced());
  expect(wire.models).toEqual(["flux-pinned-gpt-5-nano", "flux-fast", "flux-pinned-gpt-5-nano", "flux-fast"]);
});

it("a fallback that is refused too is what today does: the connection pauses", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fluxWire(() => refusal(403));
  const { extractor } = connection("revoked");
  await expect(extractor!("text", 100, signal(), fenced())).rejects.toMatchObject({ status: 403 });
  expect(connection("revoked").extractor).toBeNull();
});

it("a refused pin uses no attempt on the slice", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fluxWire(model => model === "flux-fast" ? body("[]") : refusal(403));
  const job = captured(), extractor = resolveMemoryExtractor("@murage/flux-fast", [], () => "free")!;
  expect(await consolidateMemorySource(job, extractor, signal())).toMatchObject({ status: "complete" });
  expect(intent().skipped ?? []).toEqual([]);
});

it.each([
  ["empty", () => body(""), "extraction-incomplete"],
  ["cut off with nothing visible", () => body(null, "length"), "extraction-incomplete"],
  ["a 502", () => new Response("bad", { status: 502 }), "extraction-incomplete"],
])("a pin that answers %s costs that one attempt, as today, and the next call is flux-fast", async (_name, answer, reason) => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const wire = fluxWire(model => model === "flux-fast" ? body("[]") : answer());
  const job = captured(), extractor = resolveMemoryExtractor("@murage/flux-fast", [], () => "paid")!;
  expect(await consolidateMemorySource(job, extractor, signal())).toMatchObject({ status: "deferred", reason });
  expect(intent()).toMatchObject({ extractionAttempts: 1 });
  expect(await consolidateMemorySource(job, extractor, signal())).toMatchObject({ status: "complete" });
  expect(wire.models).toEqual(["flux-pinned-gpt-5-nano", "flux-fast"]);
});

it("the network, the pace, a refusal and a long answer say nothing about the pin", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const replies: Array<() => Response | never> = [() => { throw refused("ENOTFOUND"); }, () => new Response("slow", { status: 429 }), () => body("[1,", "length")];
  const wire = fluxWire(() => replies.shift()!());
  const { extractor } = connection();
  for (let n = 0; n < 3; n++) await extractor!("text", 100, signal(), fenced()).catch(() => {});
  expect(wire.models).toEqual(Array(3).fill("flux-pinned-gpt-5-nano"));
  expect(extractor!.learningModel!()).toBe(FLUX_PINNED_LEARNING_MODEL);
});

it("the chosen tiers, reflection and own connections stay as they are", async () => {
  const wire = fluxWire(() => body("[]"));
  await resolveMemoryExtractor("@murage/flux-standard", [], () => "k")!("text", 100, signal(), fenced());
  await resolveMemoryExtractor("@murage/flux-auto", [], () => "k")!("text", 100, signal(), fenced());
  await resolveMemoryExtractor("@murage/flux-fast", [], () => "k")!("text", 100, signal(), { policyRevision: "p", messages: [{ role: "user", content: "x" }], purpose: "reflection", fence: openLearningGate("reflection") });
  expect(wire.models).toEqual(["flux-standard", "flux-auto", "flux-fast"]);
});
