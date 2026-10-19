// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The learning budget: v1 -> v2 settings (memory schema 4) and the 1.0.3 monthly ceiling (SETTINGS-REDESIGN r4.1, r3.1 to r3.4):
// one admission check against `learning-spend:<month>` for every purpose, truthful settlement, the overshoot bound and pacing.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import {
  DEFAULT_MEMORY_LEARNING_V1, downgradeMemoryLearning, learningInputReserve, memoryLearningPatchSchema, memoryLearningV1Schema,
  readMemoryLearning, upgradeMemoryLearning, updateMemoryLearning,
} from "./learning-policy.ts";
import { UNSEEN_EXCESS_CALLS, continuityDay, extractCandidates, groundMemoryClaim, requestMemoryExtraction, requestMemoryGrounding, requestMemoryInference, reserveExtraction, withContinuityInferenceLease, withMemoryInferenceLease, type TextOnlyExtractor } from "./extract.ts";
import { DEFAULT_LEARNING_CEILING, learningSpendLedgerId, learningSpendMonth } from "../../shared/memory-learning-contract.ts";
import { learningCeilingStatus, memoryOwnerRoute } from "./settings.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { learningDefaultOnFor } from "./extractor-connections.ts";
import { memoryHealth } from "./health.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

it("migrates edited bytes to tokens and retires the old ceiling without disabling learning", () => {
  const value = upgradeMemoryLearning({ ...DEFAULT_MEMORY_LEARNING_V1, inputLimit: 350, outputLimit: 70, dailyCostUsd: 5 }, 1);
  expect(value).toMatchObject({ version: 2, automaticFacts: true, dailyInputTokens: 100, dailyOutputTokens: 70, perCallOutputTokens: { grounding: 64 } });
  expect(value).not.toHaveProperty("dailyCostUsd");
  expect(downgradeMemoryLearning(value)).toMatchObject({ inputLimit: 400, outputLimit: 70, dailyCostUsd: null });
  expect(memoryLearningPatchSchema.safeParse({ dailyCostUsd: 5 }).success).toBe(false);
  // the current patch is v3: the daily caps are gone
  expect(memoryLearningPatchSchema.safeParse({ dailyOutputTokens: 5 }).success).toBe(false);
});
it("uses v2 daily defaults for an unedited installation", () => expect(upgradeMemoryLearning(DEFAULT_MEMORY_LEARNING_V1, 0)).toMatchObject({ dailyInputTokens: 400000, dailyOutputTokens: 60000 }));
it("keeps standalone v1 settings strict; database downgrades preserve switches in a binding", () => {
  const v2 = upgradeMemoryLearning(DEFAULT_MEMORY_LEARNING_V1, 0); v2.botsPaused = ["bot"]; v2.learnFrom = { chats: false, channels: false };
  const old = downgradeMemoryLearning(v2), again = upgradeMemoryLearning(old, 1);
  expect(memoryLearningV1Schema.safeParse({ ...old, botsPaused: ["bot"] }).success).toBe(false);
  expect(again.botsPaused).toEqual([]); expect(again.learnFrom).toEqual({ chats: true, channels: true }); expect(again.dailyInputTokens).toBe(Math.ceil(v2.dailyInputTokens * 4 / 3.5));
});

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const MESSAGES = Object.freeze([Object.freeze({ role: "user", content: "tea" })]);
const RESERVE = learningInputReserve(MESSAGES);
const month = () => learningSpendLedgerId(learningSpendMonth());
const row = (id: string) => { const found = database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id); return found ? JSON.parse(String(found.intent)) : undefined; };
const spend = () => row(month());
const setSpend = (input: number, output: number) => {
  const db = database();
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,(SELECT id FROM memory_scopes LIMIT 1),'system','learning-spend',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent")
    .run(month(), JSON.stringify({ input, output }));
};
const configure = (patch: Record<string, unknown>) => { const db = database(); return updateMemoryLearning(db, patch, readMemoryLearning(db).revision); };
const lived = (botId = "bot") => ({ botId, family: "lived" as const, enabled: true });
/** Every purpose's next reservation. */
/** A call that ends with no reply: the reservation stays charged and the call is no longer in flight. */
const ended = (call: ReturnType<typeof reserveExtraction>) => { call.finish(); return call.reserved; };
const everyPurpose = () => [
  ended(reserveExtraction(MESSAGES, 2000)), ended(reserveExtraction(MESSAGES, 64, undefined, "grounding")),
  ended(reserveExtraction(MESSAGES, 2000, undefined, "evaluation")), ended(reserveExtraction(MESSAGES, 8000, undefined, "reflection")),
  ended(reserveExtraction(MESSAGES, 3000, undefined, "continuity", lived())),
];
function scopeReady() { reserveExtraction(MESSAGES, 1); database().exec("DELETE FROM memory_scope_bindings WHERE subject_id IN ('extract-budget','learning-spend')"); }

it("v3 settings are current: a fresh install reads the default ceiling and no ledger", () => {
  expect(readMemoryLearning(database())).toMatchObject({ version: 3, ceiling: DEFAULT_LEARNING_CEILING });
  expect(spend()).toBeUndefined();
  expect(learningCeilingStatus(database(), DEFAULT_LEARNING_CEILING)).toEqual({ month: learningSpendMonth(), ...DEFAULT_LEARNING_CEILING, inputUsed: 0, outputUsed: 0, paused: false });
});

it("charges the month row and the day row together, the input at one token per byte plus the allowance", async () => {
  configure({ callsPerMinute: 60 });
  const extractor: TextOnlyExtractor = async (_text, max) => { expect(max).toBe(2000); return "[]"; };
  extractor.ground = async (_input, max) => { expect(max).toBe(64); return '{"supported":true}'; };
  expect((await extractCandidates("tea", extractor, new AbortController().signal)).status).toBe("complete");
  expect((await groundMemoryClaim({ text: "tea", quote: "tea", claimType: "owner-statement", speaker: "owner", outcome: "recorded" }, extractor, new AbortController().signal)).supported).toBe(true);
  const day = row(`extract-budget:${new Date().toISOString().slice(0, 10)}`);
  expect(spend()).toEqual({ input: day.input, output: 2064 });
  expect(day).toMatchObject({ output: 2064, calls: 2 });
});

it("ceiling-two-slots: at the ceiling minus one reserve, a learning call and a Continuity call race and exactly one is admitted", () => {
  scopeReady();
  configure({ ceiling: { input: 1_000_000, output: 1_000_000 } });
  setSpend(1_000_000 - RESERVE, 0);
  const learning = reserveExtraction(MESSAGES, 2000), continuity = reserveExtraction(MESSAGES, 3000, undefined, "continuity", lived());
  expect([learning.reserved, continuity.reserved]).toEqual([true, "spend-ceiling"]);
  expect(Number(database().prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_id='continuity-budget'").get()!.n)).toBe(0);
  expect(spend()).toMatchObject({ input: 1_000_000, output: 2000 });
});

it("ceiling-overshoot-bound: both slots admitted at the edge settle 10,000 above their reserves; the row stays within the two excesses and every purpose is refused", () => {
  scopeReady();
  configure({ ceiling: { input: 1_000_000, output: 1_000_000 } });
  setSpend(1_000_000 - 2 * RESERVE, 1_000_000 - 5000);
  const learning = reserveExtraction(MESSAGES, 2000), continuity = reserveExtraction(MESSAGES, 3000, undefined, "continuity", lived());
  expect([learning.reserved, continuity.reserved]).toEqual([true, true]);
  learning.settle({ prompt_tokens: RESERVE + 10_000, completion_tokens: 2000 + 10_000 });
  continuity.settle({ prompt_tokens: RESERVE + 10_000, completion_tokens: 3000 + 10_000 });
  const after = spend();
  expect(after.input).toBeLessThanOrEqual(1_000_000 + 20_000);
  expect(after.output).toBeLessThanOrEqual(1_000_000 + 20_000);
  expect(after).toEqual({ input: 1_000_000 + 20_000, output: 1_000_000 + 20_000 });
  expect(everyPurpose()).toEqual(["spend-ceiling", "spend-ceiling", "spend-ceiling", "spend-ceiling", "spend-ceiling"]);
  expect(learningCeilingStatus(database(), readMemoryLearning(database()).ceiling).paused).toBe(true);
});

it("settle-raises: a report above the reservation is recorded on both rows, never clamped; a lower one lowers them", () => {
  const raised = reserveExtraction(MESSAGES, 2000);
  raised.settle({ prompt_tokens: RESERVE + 500, completion_tokens: 2500 });
  expect(spend()).toEqual({ input: RESERVE + 500, output: 2500 });
  expect(row(raised.handle.ledgerId)).toMatchObject({ input: RESERVE + 500, output: 2500 });
  const lowered = reserveExtraction(MESSAGES, 2000);
  lowered.settle({ prompt_tokens: 1, completion_tokens: 1 });
  expect(spend()).toEqual({ input: RESERVE + 501, output: 2501 });
});

it("missing-usage: a reply with no usage block keeps the whole reservation; an unreported side keeps its own; both count as unmetered", () => {
  const silent = reserveExtraction(MESSAGES, 2000);
  silent.settle({});
  expect(spend()).toEqual({ input: RESERVE, output: 2000, unmetered: 1 });
  const half = reserveExtraction(MESSAGES, 2000);
  half.settle({ prompt_tokens: 7 });
  expect(spend()).toEqual({ input: RESERVE + 7, output: 4000, unmetered: 2 });
});

it.each([true, false])("settles a real transport only when it reports usage (%s)", async reported => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "[]" } }], ...(reported ? { usage: { prompt_tokens: 10, completion_tokens: 3 } } : {}) }))));
  const config = { url: "https://fixture.invalid/v1", apiKey: "fake", model: "fake" };
  const extractor: TextOnlyExtractor = (text, max, signal, dispatch) => requestMemoryExtraction(config, text, max, signal, dispatch?.messages);
  await extractCandidates("tea", extractor, new AbortController().signal);
  // no usage block: the whole reservation stays (never a body-size surcharge, Astra r3 Medium) and the reply counts as unmetered
  expect(spend().output).toBe(reported ? 3 : 2000);
  expect(spend().unmetered).toBe(reported ? undefined : 1);
  if (reported) expect(spend().input).toBe(10); else expect(spend().input).toBeGreaterThan(10);
  expect(readMemoryLearning(database()).version).toBe(3);
});

// Astra L3 High 2: a paid reply the transport rejects (cut off at max_tokens, a tool call, a malformed choice) still settles what the
// provider reported, into the month and the day rows, before the slot is released; on every purpose that goes through the transport.
const rejectedReplies: Array<[string, Record<string, unknown>]> = [
  ["length", { choices: [{ finish_reason: "length", message: { content: "[" } }] }],
  ["tool-call", { choices: [{ finish_reason: "stop", message: { content: "", tool_calls: [{ id: "x" }] } }] }],
  ["malformed", { choices: [] }],
];
it.each(rejectedReplies)("rejected-reply-settles: a %s reply settles its reported usage on every purpose", async (_kind, body) => {
  configure({ callsPerMinute: 60 });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...body, usage: { prompt_tokens: 9000, completion_tokens: 2600 } }))));
  const config = { url: "https://fixture.invalid/v1", apiKey: "fake", model: "fake" };
  const extractor: TextOnlyExtractor = (text, max, signal, dispatch) => dispatch?.purpose ? requestMemoryInference(config, text, max, signal, dispatch) : requestMemoryExtraction(config, text, max, signal, dispatch?.messages);
  extractor.ground = (input, max, signal) => requestMemoryGrounding(config, input, max, signal);
  const day = () => row(`extract-budget:${new Date().toISOString().slice(0, 10)}`);
  expect(await extractCandidates("tea", extractor, new AbortController().signal)).toMatchObject({ status: "deferred", reason: "extraction-incomplete" });
  expect(spend()).toEqual({ input: 9000, output: 2600 });
  expect(day()).toMatchObject({ input: 9000, output: 2600 });
  expect(await groundMemoryClaim({ text: "tea", quote: "tea", claimType: "owner-statement", speaker: "owner", outcome: "recorded" }, extractor, new AbortController().signal)).toMatchObject({ supported: false });
  expect(spend()).toEqual({ input: 18000, output: 5200 });
  for (const purpose of ["evaluation", "reflection"] as const) {
    await withMemoryInferenceLease(lease => lease.request(extractor, "tea", 2000, new AbortController().signal, MESSAGES, purpose).catch(() => null));
  }
  expect(spend()).toEqual({ input: 36000, output: 10400 });
  expect(day()).toMatchObject({ input: 36000, output: 10400 });
  await withContinuityInferenceLease(lease => lease.request(extractor, "tea", 2000, new AbortController().signal, MESSAGES, "continuity", lived()).catch(() => null));
  expect(spend()).toEqual({ input: 45000, output: 13000 });
  expect(row(`continuity-budget:bot:${continuityDay()}`)).toMatchObject({ input: 9000, output: 2600 });
});

// Astra L3 r2 High 2: with a ceiling of three reservations and every reply costing more than reserved, unreadable replies (over 64 KiB,
// or not JSON) kept exactly their reservations, so a third call was admitted and spend passed the two-call excess bound. They now keep the
// reservation plus the body size, so the ledger reaches the ceiling sooner and the third call is refused, on every purpose.
const unreadableReplies: Array<[string, () => Response]> = [
  ["over-64KiB-declared", () => new Response("x".repeat(70_000), { headers: { "content-length": "70000" } })],
  ["over-64KiB-streamed", () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(70_000))); c.close(); } }))],
  ["invalid-json", () => new Response('{"choices":[{"message":{"content":"[]"}}],"usage":{"prompt_tokens":9000,"completion_tokens":26')],
];
const purposes = ["extraction", "grounding", "evaluation", "reflection", "continuity"] as const;
it.each(unreadableReplies.flatMap(([kind, reply]) => purposes.map(purpose => [kind, purpose, reply] as const)))("unreadable-reply-ceiling (%s, %s): the third call at a 3R ceiling is refused", async (_kind, purpose, reply) => {
  const per = readMemoryLearning(database()).perCallOutputTokens;
  const reserved = purpose === "grounding" ? Math.min(64, per.grounding) : purpose === "continuity" ? 2000 : Math.min(2000, purpose === "reflection" ? per.reflection : per.extraction);
  configure({ callsPerMinute: 60, ceiling: { input: 1_000_000_000, output: 3 * reserved } });
  const fetchMock = vi.fn(async () => reply());
  vi.stubGlobal("fetch", fetchMock);
  const config = { url: "https://fixture.invalid/v1", apiKey: "fake", model: "fake" };
  const extractor: TextOnlyExtractor = (text, max, signal, dispatch) => dispatch?.purpose ? requestMemoryInference(config, text, max, signal, dispatch) : requestMemoryExtraction(config, text, max, signal, dispatch?.messages);
  extractor.ground = (input, max, signal) => requestMemoryGrounding(config, input, max, signal);
  const signal = new AbortController().signal;
  const call = async () => {
    if (purpose === "extraction") return extractCandidates("tea", extractor, signal);
    if (purpose === "grounding") return groundMemoryClaim({ text: "tea", quote: "tea", claimType: "owner-statement", speaker: "owner", outcome: "recorded" }, extractor, signal);
    if (purpose === "continuity") return withContinuityInferenceLease(lease => lease.request(extractor, "tea", 2000, signal, MESSAGES, "continuity", lived()).catch(() => null));
    return withMemoryInferenceLease(lease => lease.request(extractor, "tea", 2000, signal, MESSAGES, purpose).catch(() => null));
  };
  for (let n = 0; n < 3; n++) await call();
  const paid = fetchMock.mock.calls.length;
  expect(paid).toBeGreaterThan(0);
  expect(paid).toBeLessThan(3);
  // every paid reply keeps its reservation and counts as unmetered; two of them hold learning paused
  expect(paid).toBeLessThanOrEqual(UNSEEN_EXCESS_CALLS);
  expect(spend()).toMatchObject({ output: paid * reserved, unmetered: paid });
  expect(learningCeilingStatus(database(), readMemoryLearning(database()).ceiling).paused).toBe(paid >= UNSEEN_EXCESS_CALLS);
});

// Astra L3 r3 High (spend bound): ceiling 10,000, reservation 2,000, a provider billing 4,000 a call and answering with a malformed
// 96-byte reply. Body bytes cannot bound unseen billing, so the ledger may not admit more calls with unknown cost than the bound allows:
// real spend stays within the ceiling plus two calls' excess, on every purpose and on the Continuity HTTP transport too.
it.each(purposes)("unseen-billing-bound (%s): malformed paid replies never spend past the ceiling plus two calls' excess", async purpose => {
  const per = readMemoryLearning(database()).perCallOutputTokens;
  const reserved = purpose === "grounding" ? Math.min(64, per.grounding) : 2000;
  const ceiling = 5 * reserved, billed = 2 * reserved;
  configure({ callsPerMinute: 60, ceiling: { input: 1_000_000_000, output: ceiling } });
  let real = 0;
  const malformed = JSON.stringify({ choices: [{ message: { content: 7 } }], x: "y".repeat(40) });
  const fetchMock = vi.fn(async () => { real += billed; return new Response(malformed); });
  vi.stubGlobal("fetch", fetchMock);
  const config = { url: "https://fixture.invalid/v1", apiKey: "fake", model: "fake" };
  const extractor: TextOnlyExtractor = (text, max, signal, dispatch) => dispatch?.purpose ? requestMemoryInference(config, text, max, signal, dispatch) : requestMemoryExtraction(config, text, max, signal, dispatch?.messages);
  extractor.ground = (input, max, signal) => requestMemoryGrounding(config, input, max, signal);
  const signal = new AbortController().signal;
  for (let n = 0; n < 8; n++) {
    if (purpose === "extraction") await extractCandidates("tea", extractor, signal);
    else if (purpose === "grounding") await groundMemoryClaim({ text: "tea", quote: "tea", claimType: "owner-statement", speaker: "owner", outcome: "recorded" }, extractor, signal);
    else if (purpose === "continuity") await withContinuityInferenceLease(lease => lease.request(extractor, "tea", 2000, signal, MESSAGES, "continuity", lived()).catch(() => null));
    else await withMemoryInferenceLease(lease => lease.request(extractor, "tea", 2000, signal, MESSAGES, purpose).catch(() => null));
  }
  expect(real).toBeLessThanOrEqual(ceiling + 2 * (billed - reserved));
  expect(learningCeilingStatus(database(), readMemoryLearning(database()).ceiling).paused).toBe(true);
});

it("unmetered recovery: a raise clears unmetered replies and learning resumes; metered replies and calls with no reply never count", async () => {
  scopeReady();
  configure({ callsPerMinute: 60, ceiling: { input: 1_000_000_000, output: 1_000_000 } });
  // a metered reply and a call that never got a reply (network error) leave nothing unmetered
  reserveExtraction(MESSAGES, 2000).settle({ prompt_tokens: 3, completion_tokens: 3 });
  ended(reserveExtraction(MESSAGES, 2000));
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  const config = { url: "https://fixture.invalid/v1", apiKey: "fake", model: "fake" };
  for (let n = 0; n < 4; n++) await extractCandidates("tea", (text, max, signal, dispatch) => requestMemoryExtraction(config, text, max, signal, dispatch?.messages), new AbortController().signal);
  expect(spend().unmetered).toBeUndefined();
  expect(spend().open).toBeUndefined();
  expect(learningCeilingStatus(database(), readMemoryLearning(database()).ceiling).paused).toBe(false);
  // two unmetered replies pause every purpose
  reserveExtraction(MESSAGES, 2000).settle({});
  reserveExtraction(MESSAGES, 2000).settle({ completion_tokens: 1 });
  expect(everyPurpose()).toEqual(["spend-ceiling", "spend-ceiling", "spend-ceiling", "spend-ceiling", "spend-ceiling"]);
  expect(learningCeilingStatus(database(), readMemoryLearning(database()).ceiling).paused).toBe(true);
  // the owner's raise (Needs you "Double the limit and resume") clears them
  const settings = readMemoryLearning(database());
  const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] } as unknown as MemoryRoster;
  reconcileMemoryRoster(roster);
  await memoryOwnerRoute("/api/memory/action", { action: "configure", ceiling: { input: settings.ceiling.input * 2, output: settings.ceiling.output * 2 }, learningRevision: settings.revision }, ownerMemoryTicket(), roster);
  expect(spend().unmetered).toBeUndefined();
  expect(learningCeilingStatus(database(), readMemoryLearning(database()).ceiling).paused).toBe(false);
  expect(ended(reserveExtraction(MESSAGES, 2000))).toBe(true);
});

it("unmetered raise: raising one side alone keeps unmetered replies counted (Astra r4: 16,000 > 14,000 after an input-only raise)", async () => {
  scopeReady();
  configure({ callsPerMinute: 60, ceiling: { input: 1_000_000_000, output: 10_000 } });
  reserveExtraction(MESSAGES, 2000).settle({});
  reserveExtraction(MESSAGES, 2000).settle({});
  const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] } as unknown as MemoryRoster;
  reconcileMemoryRoster(roster);
  const settings = readMemoryLearning(database());
  await memoryOwnerRoute("/api/memory/action", { action: "configure", ceiling: { input: settings.ceiling.input * 2, output: settings.ceiling.output }, learningRevision: settings.revision }, ownerMemoryTicket(), roster);
  expect(spend().unmetered).toBe(2);
  expect(reserveExtraction(MESSAGES, 2000).reserved).toBe("spend-ceiling");
  expect(learningCeilingStatus(database(), readMemoryLearning(database()).ceiling).paused).toBe(true);
});

it("one unmetered reply and the other slot in flight is a busy wait, retried in a second, never a pause", () => {
  scopeReady();
  configure({ callsPerMinute: 60 });
  reserveExtraction(MESSAGES, 2000).settle({});
  const continuity = reserveExtraction(MESSAGES, 3000, undefined, "continuity", lived());
  expect(continuity.reserved).toBe(true);
  expect(reserveExtraction(MESSAGES, 2000).reserved).toBe("extractor-busy");
  expect(learningCeilingStatus(database(), readMemoryLearning(database()).ceiling).paused).toBe(false);
  continuity.settle({ prompt_tokens: 1, completion_tokens: 1 });
  expect(ended(reserveExtraction(MESSAGES, 2000))).toBe(true);
});

it("a reservation an earlier process left open counts as unmetered: one in flight from another boot and one unmetered reply pause learning", () => {
  scopeReady();
  setSpend(0, 0);
  database().prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify({ input: RESERVE, output: 2000, open: { "an-earlier-boot": 1 } }), month());
  expect(learningCeilingStatus(database(), readMemoryLearning(database()).ceiling).paused).toBe(false);
  reserveExtraction(MESSAGES, 2000).settle({});
  expect(learningCeilingStatus(database(), readMemoryLearning(database()).ceiling).paused).toBe(true);
  expect(reserveExtraction(MESSAGES, 2000).reserved).toBe("spend-ceiling");
});

it("month-boundary-settle: a reply that lands after the month rolled over settles into the month it was reserved in", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 31, 23, 59, 50));
  const handle = reserveExtraction(MESSAGES, 2000);
  expect(handle.handle.monthLedgerId).toBe("learning-spend:2026-10");
  vi.setSystemTime(new Date(2026, 10, 1, 0, 0, 10));
  handle.settle({ prompt_tokens: 5, completion_tokens: 5 });
  expect(row("learning-spend:2026-10")).toEqual({ input: 5, output: 5 });
  expect(row("learning-spend:2026-11")).toBeUndefined();
  expect(learningCeilingStatus(database(), DEFAULT_LEARNING_CEILING)).toMatchObject({ month: "2026-11", inputUsed: 0, outputUsed: 0, paused: false });
});

it("restart: the ledger is a row; after a restart the pause is derived again from it, and an unsettled reservation stays charged", () => {
  scopeReady();
  configure({ ceiling: { input: RESERVE + 10, output: 1_000_000 } });
  expect(reserveExtraction(MESSAGES, 2000).reserved).toBe(true); // never settled: the process "dies"
  closeDatabase();
  expect(spend()).toMatchObject({ input: RESERVE, output: 2000 });
  expect(learningCeilingStatus(database(), readMemoryLearning(database()).ceiling).paused).toBe(false);
  expect(reserveExtraction(MESSAGES, 2000).reserved).toBe("spend-ceiling");
  configure({ ceiling: { input: RESERVE, output: 1_000_000 } });
  closeDatabase();
  expect(learningCeilingStatus(database(), readMemoryLearning(database()).ceiling).paused).toBe(true);
});

it("multi-bot budget: twenty bots' Continuity and ordinary learning draw on one month row", () => {
  scopeReady();
  configure({ ceiling: { input: 1_000_000_000, output: 20 * 3000 + 2000 } });
  for (let bot = 0; bot < 20; bot++) expect(ended(reserveExtraction(MESSAGES, 3000, undefined, "continuity", lived(`bot-${bot}`)))).toBe(true);
  expect(ended(reserveExtraction(MESSAGES, 2000, undefined, "evaluation"))).toBe(true);
  expect(spend()).toEqual({ input: 21 * RESERVE, output: 20 * 3000 + 2000 });
  expect(reserveExtraction(MESSAGES, 1, undefined, "continuity", lived("bot-new")).reserved).toBe("spend-ceiling");
  expect(reserveExtraction(MESSAGES, 1).reserved).toBe("spend-ceiling");
});

it("refusal-charges-nothing: a refused call writes no row and never runs its record callback", () => {
  scopeReady();
  configure({ ceiling: { input: 0, output: 0 } });
  const record = vi.fn();
  expect(reserveExtraction(MESSAGES, 2000, record).reserved).toBe("spend-ceiling");
  expect(reserveExtraction(MESSAGES, 3000, record, "continuity", lived()).reserved).toBe("spend-ceiling");
  configure({ ceiling: DEFAULT_LEARNING_CEILING, callsPerMinute: 0 });
  expect(reserveExtraction(MESSAGES, 2000, record).reserved).toBe("budget-exhausted");
  expect(record).not.toHaveBeenCalled();
  expect(Number(database().prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_id IN ('extract-budget','continuity-budget','learning-spend')").get()!.n)).toBe(0);
});

it("pacing stays per day row and no daily token cap remains: calls per minute refuse with budget-exhausted, tokens far past 400k pass", () => {
  configure({ callsPerMinute: 2 });
  const big = [{ role: "user", content: "x".repeat(60_000) }];
  for (let call = 0; call < 2; call++) expect(ended(reserveExtraction(big, 2000))).toBe(true);
  expect(reserveExtraction(big, 2000).reserved).toBe("budget-exhausted");
  database().prepare("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.minute',0,'$.input',5000000) WHERE subject_id='extract-budget'").run();
  expect(reserveExtraction(big, 2000).reserved).toBe(true);
});

it("a zero ceiling reads as budget-limited in health", () => {
  configure({ ceiling: { input: 0, output: 0 } });
  expect(memoryHealth("connection").synthesis.state).toBe("budget-limited");
  configure({ ceiling: DEFAULT_LEARNING_CEILING });
  expect(memoryHealth("connection").synthesis.state).toBe("configured");
});

it("explicit-false-with-flux-key: an explicit learningDefaultOn wins over the Flux key; unset follows the key", () => {
  expect(learningDefaultOnFor({ learningDefaultOn: false }, true)).toBe(false);
  expect(learningDefaultOnFor({ learningDefaultOn: true }, false)).toBe(true);
  expect(learningDefaultOnFor({}, true)).toBe(true);
  expect(learningDefaultOnFor(undefined, false)).toBe(false);
});
