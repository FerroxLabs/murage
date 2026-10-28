// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sentinel extraction producer (GAP-SENTINEL-109 4.2, S03 inputs): admitted attempts settle once as complete, unusable
// (by fixed code), cancelled or interrupted; deferrals are counted apart and never as attempts; a valid empty reply is a
// success; HTTP and CLI transports report the same contract; the hourly line has its exact shape; no reply, source,
// model alias, connection id or key reaches a counter, a fact or a log line; nothing is written to disk.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { withCliMemoryLearning } from "../drivers/cli-memory-learning.ts";
import { extractCandidates, reportMemoryUsage, type TextOnlyExtractor } from "../memory/extract.ts";
import { EXTRACTION_CATALOGUE_MODELS, EXTRACTION_SUMMARY_MS, extractionOutcomes } from "../memory/extraction-outcomes.ts";
import { FLUX_EXTRACTORS, resolveMemoryExtractor } from "../memory/extractor-connections.ts";
import { HEALTH_DIR } from "../../shared/health-protocol.mjs";
import { drainServerWindows, factsOf, freshServerCounters, rows, total } from "./test-support.ts";

const SOURCE = "PRIVATE_SOURCE_SENTINEL";
const SECRETS = [SOURCE, "PRIVATE_REPLY_SENTINEL", "PRIVATE_KEY_SENTINEL", "PRIVATE-MODEL-ALIAS", "PRIVATE-CONNECTION", "PRIVATE_ERROR_SENTINEL"];

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  extractionOutcomes.clear();
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected fetch"); }));
  freshServerCounters();
});
afterEach(() => {
  extractionOutcomes.clear(); closeDatabase();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

const signal = () => new AbortController().signal;
const run = (extractor: TextOnlyExtractor | null, abort = signal()) => extractCandidates(SOURCE, extractor, abort);
const envelope = (content: unknown = "[]", extra: Record<string, unknown> = {}) => ({
  usage: { prompt_tokens: 10, completion_tokens: 20 },
  choices: [{ finish_reason: "stop", message: { content }, ...extra }],
});
/** Flux Router over HTTP (the gateway engine, a catalogue model), answering each call from `replies` in turn. */
function http(...replies: Array<{ body: unknown; status?: number }>) {
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    const { body, status = 200 } = replies[Math.min(call++, replies.length - 1)]!;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }));
  return resolveMemoryExtractor("@murage/flux-fast", [], () => "PRIVATE_KEY_SENTINEL")!;
}
/** A signed-in CLI engine (Codex) with a model alias that must never be reported, answering through `answer`. */
function cli(answer: () => string | Promise<string>) {
  const adapter = { provider: "codex", onEvent: () => () => undefined, sendTurn: async () => ({ turnId: "t" }), interruptTurn: async () => undefined };
  const instance = {
    instanceId: "PRIVATE-CONNECTION-cli", driverKind: "codex", displayName: "Codex", enabled: true, models: { default: "PRIVATE-MODEL-ALIAS" },
    adapter, dispose: async () => undefined,
  } as unknown as ProviderInstance;
  withCliMemoryLearning(instance, { run: () => async () => { reportMemoryUsage({ engineRun: true }); return answer(); } });
  return resolveMemoryExtractor(instance.instanceId, [instance])!;
}
const sourceKeys = (windows: ReturnType<typeof drainServerWindows>) => new Set(rows(windows).filter(row => row.detector === "extraction" && row.sourceKey).map(row => row.sourceKey));
function noSecrets(windows: unknown) {
  const seen = JSON.stringify([windows, vi.mocked(console.warn).mock.calls, vi.mocked(console.info).mock.calls]);
  for (const secret of SECRETS) expect(seen).not.toContain(secret);
}

describe("extraction outcomes as health counters", () => {
  it("the reported model catalogue is Murage's own extractor list", () => {
    expect(FLUX_EXTRACTORS.map(item => item.model)).toEqual([...EXTRACTION_CATALOGUE_MODELS]);
  });

  it("a valid empty reply is a complete attempt on HTTP and on a CLI engine alike", async () => {
    expect(await run(http({ body: envelope("[]") }))).toMatchObject({ status: "complete", candidates: [] });
    expect(await run(cli(() => "[]"))).toMatchObject({ status: "complete", candidates: [] });
    const windows = drainServerWindows();
    for (const engineKind of ["gateway", "codex"]) {
      expect(total(windows, "extraction", "admitted", { engineKind })).toBe(1);
      expect(total(windows, "extraction", "complete", { engineKind })).toBe(1);
      expect(total(windows, "extraction", "unusable", { engineKind })).toBe(0);
    }
    const streaks = factsOf(windows, "extraction-streak");
    expect(streaks.map(fact => fact.engineKind).sort()).toEqual(["codex", "gateway"]);
    for (const fact of streaks) expect(fact).toMatchObject({ settledCount: 1, leadingUnusable: 0, trailingUnusable: 0, maxConsecutiveUnusable: 0, orderComplete: true });
    // every counter and fact of one extractor carries the same opaque key
    expect(sourceKeys(windows).size).toBe(2);
    for (const fact of streaks) expect(sourceKeys(windows).has(fact.sourceKey)).toBe(true);
    expect(existsSync(join(DATA_DIR, HEALTH_DIR))).toBe(false); // counters only: nothing persisted per attempt
    noSecrets(windows);
  });

  it.each([
    ["not-json", { body: envelope("PRIVATE_REPLY_SENTINEL") }],
    ["schema", { body: envelope('{"PRIVATE_REPLY_SENTINEL":true}') }],
    ["length", { body: envelope('[{"text":"PRIVATE_REPLY_SENTINEL"', { finish_reason: "length" }) }],
    ["tool-call", { body: envelope("[]", { message: { content: "[]", tool_calls: [{ id: "PRIVATE_REPLY_SENTINEL" }] } }) }],
    ["empty", { body: envelope("   ") }],
    ["response-limit", { body: "x".repeat(65_537) }],
    ["transport", { body: "PRIVATE_REPLY_SENTINEL", status: 500 }],
    ["other", { body: envelope(null, { message: { content: null, refusal: "PRIVATE_REPLY_SENTINEL" } }) }],
  ] as const)("an HTTP reply that is %s is one unusable attempt with that code", async (code, reply) => {
    expect(await run(http(reply))).toMatchObject({ status: "deferred", reason: "extraction-incomplete" });
    const windows = drainServerWindows();
    expect(total(windows, "extraction", "admitted", { engineKind: "gateway" })).toBe(1);
    expect(total(windows, "extraction", "unusable", { engineKind: "gateway" })).toBe(1);
    expect(total(windows, "extraction", code, { engineKind: "gateway" })).toBe(1);
    expect(total(windows, "extraction", "complete")).toBe(0);
    noSecrets(windows);
  });

  it.each([
    ["not-json", (): string => "PRIVATE_REPLY_SENTINEL"],
    ["schema", (): string => '{"PRIVATE_REPLY_SENTINEL":true}'],
    ["empty", (): string => "   "],
    ["response-limit", (): string => "x".repeat(20_000)],
    ["transport", (): string => { throw new Error("PRIVATE_ERROR_SENTINEL"); }],
  ] as const)("a CLI answer that is %s reports the same code as HTTP", async (code, answer) => {
    expect(await run(cli(answer))).toMatchObject({ status: "deferred", reason: "extraction-incomplete" });
    const windows = drainServerWindows();
    expect(total(windows, "extraction", "admitted", { engineKind: "codex" })).toBe(1);
    expect(total(windows, "extraction", "unusable", { engineKind: "codex" })).toBe(1);
    expect(total(windows, "extraction", code, { engineKind: "codex" })).toBe(1);
    noSecrets(windows);
  });

  it("deferrals happen before any call: counted by cause, never admitted", async () => {
    expect(await run(null)).toMatchObject({ reason: "extractor-unavailable" });
    let release: (value: string) => void = () => {};
    const slow = http({ body: envelope("[]") });
    const first = run(Object.assign((...args: Parameters<TextOnlyExtractor>) => new Promise<string>(resolve => { release = resolve; void args; }), { learningConnection: "@murage/flux-fast", learningModel: () => "flux-fast", healthEngine: "gateway" as const }));
    expect(await run(slow)).toMatchObject({ reason: "extractor-busy" });
    release("[]");
    expect(await first).toMatchObject({ status: "complete" });
    // five unusable replies open the reply backoff: the next is deferred by pacing
    const bad = http({ body: envelope("PRIVATE_REPLY_SENTINEL") });
    for (let i = 0; i < 5; i++) await run(bad);
    expect(await run(bad)).toMatchObject({ reason: "extractor-backoff" });
    const windows = drainServerWindows();
    expect(total(windows, "extraction", "deferred-unconfigured", { engineKind: "none" })).toBe(1);
    expect(total(windows, "extraction", "deferred-busy", { engineKind: "gateway" })).toBe(1);
    expect(total(windows, "extraction", "deferred-budget", { engineKind: "gateway" })).toBe(1);
    expect(total(windows, "extraction", "admitted")).toBe(6);
    expect(total(windows, "extraction", "complete") + total(windows, "extraction", "unusable")).toBe(6);
  });

  it("an attempt the caller cancels is cancelled, not unusable; an engine session that ends under it is interrupted", async () => {
    const abort = new AbortController();
    const waiting = Object.assign((_t: string, _m: number, inner: AbortSignal) => new Promise<string>((_resolve, reject) => {
      inner.addEventListener("abort", () => reject(new Error("MEMORY_EXTRACTION_ABORTED")), { once: true });
    }), { learningConnection: "@murage/flux-fast", learningModel: () => "flux-fast", healthEngine: "gateway" as const });
    const pending = run(waiting, abort.signal);
    abort.abort();
    expect(await pending).toMatchObject({ status: "deferred" });
    // a CLI engine whose hidden session exits before answering (drivers/cli-memory-learning.ts hiddenTurnRunner)
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const adapter = {
      provider: "codex", onEvent: (listener: (event: RuntimeEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      sendTurn: async (input: { threadId: string }) => {
        for (const listener of [...listeners]) listener({ eventId: "e", provider: "codex", threadId: input.threadId, createdAt: "now", type: "session.exited" } as RuntimeEvent);
        return { turnId: "t" };
      },
      respondToRequest: async () => "rejected", interruptTurn: async () => undefined, resetSession: async () => undefined,
    };
    const instance = { instanceId: "PRIVATE-CONNECTION-exit", driverKind: "codex", displayName: "Codex", enabled: true, adapter, dispose: async () => undefined } as unknown as ProviderInstance;
    withCliMemoryLearning(instance);
    expect(await run(resolveMemoryExtractor(instance.instanceId, [instance])!)).toMatchObject({ status: "deferred" });
    const windows = drainServerWindows();
    expect(total(windows, "extraction", "cancelled", { engineKind: "gateway" })).toBe(1);
    expect(total(windows, "extraction", "interrupted", { engineKind: "codex" })).toBe(1);
    expect(total(windows, "extraction", "unusable")).toBe(0);
    noSecrets(windows);
  });

  it("the window's streak fact gives the leading, trailing and longest unusable runs in settlement order", async () => {
    const replies = ["bad", "bad", "bad", "[]", "bad", "bad"].map(content => ({ body: envelope(content) }));
    const extractor = http(...replies);
    for (let i = 0; i < replies.length; i++) await run(extractor);
    const windows = drainServerWindows();
    expect(factsOf(windows, "extraction-streak")).toEqual([expect.objectContaining({
      engineKind: "gateway", settledCount: 6, leadingUnusable: 3, trailingUnusable: 2, maxConsecutiveUnusable: 3, orderComplete: true,
    })]);
    expect(total(windows, "extraction", "unusable")).toBe(5);
    expect(total(windows, "extraction", "not-json")).toBe(5);
  });

  it("the hourly line has the exact contract shape: opaque extractor, engine category, catalogue model or custom, coverage", async () => {
    await run(http({ body: envelope("[]") }));
    await run(cli(() => "PRIVATE_REPLY_SENTINEL"));
    vi.advanceTimersByTime(EXTRACTION_SUMMARY_MS);
    const lines = vi.mocked(console.info).mock.calls.map(call => String(call[0]));
    const shape = /^\[memory\] extraction outcomes complete=(\d+) deferred=(\d+) unusable=(\d+) interrupted=(\d+) extractor=([0-9a-f]{32}) engine=([a-z-]+) model=([a-z-]+) coverage=(complete|partial)$/;
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(shape);
    expect(lines).toContainEqual(expect.stringMatching(/complete=1 deferred=0 unusable=0 interrupted=0 extractor=[0-9a-f]{32} engine=gateway model=flux-fast coverage=partial$/));
    expect(lines).toContainEqual(expect.stringMatching(/complete=0 deferred=0 unusable=1 interrupted=0 extractor=[0-9a-f]{32} engine=codex model=custom coverage=partial$/));
    // a whole hour observed next is complete coverage
    await run(http({ body: envelope("[]") }));
    vi.advanceTimersByTime(EXTRACTION_SUMMARY_MS);
    expect(vi.mocked(console.info).mock.calls.at(-1)?.[0]).toMatch(/engine=gateway model=flux-fast coverage=complete$/);
    noSecrets([]);
  });
});
