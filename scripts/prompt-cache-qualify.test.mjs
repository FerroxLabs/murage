// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from "vitest";
import { qualifyPromptCache } from "./prompt-cache-qualify.ts";
import { requestUsage } from "../shared/prompt-cache-usage.ts";

it("qualification separates provider read counts, reporting coverage and prefix stability without exporting private text", async () => {
  let calls = 0;
  const report = await qualifyPromptCache(async ({ system, scenario }) => {
    if (scenario === "audience-change") expect(system).not.toContain("PRIVATE_FIXTURE_SENTINEL");
    else expect(system).toContain("PRIVATE_FIXTURE_SENTINEL");
    calls++;
    return calls === 3 ? requestUsage(undefined, undefined, undefined) : requestUsage(100, 0, calls === 1 ? 80 : 10);
  }, [{ id: "house-rules", text: "PRIVATE_FIXTURE_SENTINEL" }]);
  expect(calls).toBe(8);
  expect(report).toMatchObject({ samples: 8, knownSamples: 7, missingInputSamples: 1, missingUsageSamples: 1, malformedUsageSamples: 0, failedWithoutUsageSamples: 0, knownInput: 700, cachedRead: 140, requestHits: 7, prefixStable: true });
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE_FIXTURE_SENTINEL|house-rules|system|credential|hash|thread/i);
  expect(report.tokenShare).toBe(0.2);
});
it("qualification stops at the bounded eight-request corpus even when every result is unreported", async () => {
  let calls = 0;
  const report = await qualifyPromptCache(async () => { calls++; return requestUsage(undefined, undefined, undefined); }, []);
  expect(calls).toBe(8); expect(report.knownSamples).toBe(0); expect(report.tokenShare).toBeNull();
  expect(report).toMatchObject({ missingUsageSamples: 8, malformedUsageSamples: 0, failedWithoutUsageSamples: 0 });
});

it("the explicit command emits a synthetic numeric report and never silently succeeds without qualifying", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./prompt-cache-qualify.ts", import.meta.url))], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ synthetic: true, samples: 8, knownSamples: 8, knownInput: 800, cachedRead: 400, tokenShare: 0.5, prefixStable: true, configurationChanged: true, audienceChanged: true });
});

it("qualification never turns overflowing totals into a precise provider rate", async () => {
  const report = await qualifyPromptCache(async () => requestUsage(Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER), []);
  expect(report).toMatchObject({ samples: 8, knownSamples: 8, reportedInput: null, knownInput: null, cachedRead: null, tokenShare: null });
});
it("fixture qualification uses only its explicit transport and emits no background network or prompt log", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("unexpected network sink"); });
  const log = vi.spyOn(console, "log").mockImplementation(() => { throw new Error("unexpected prompt log"); });
  try {
    await qualifyPromptCache(async () => requestUsage(100, 0, 80), [{ id: "memory", text: "PRIVATE_FIXTURE_SENTINEL" }]);
    expect(fetch).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); log.mockRestore(); }
});

it("qualification separates missing, malformed and failed-without-usage observations", async () => {
  const states = ["missing", "malformed", "failed-without-usage"];
  const report = await qualifyPromptCache(async ({ position }) => position < states.length
    ? { ...requestUsage(undefined, undefined, undefined), reporting: states[position] }
    : requestUsage(100, 0, 80), []);
  expect(report).toMatchObject({ samples: 8, knownSamples: 5, missingInputSamples: 3, missingUsageSamples: 1, malformedUsageSamples: 1, failedWithoutUsageSamples: 1, knownInput: 500, cachedRead: 400, tokenShare: 0.8 });
});
it.each(["missing", "malformed", "failed-without-usage"])("qualification status %s cannot turn placeholder numbers into measured coverage", async reporting => {
  const report = await qualifyPromptCache(async () => ({ ...requestUsage(100, 0, 80), reporting }), []);
  expect(report).toMatchObject({ samples: 8, knownSamples: 0, missingInputSamples: 8, reportedInput: 0, knownInput: 0, cachedRead: 0, tokenShare: null });
});
it("qualification rejects an unknown outcome without exporting its text or placeholder counts", async () => {
  const report = await qualifyPromptCache(async () => ({ ...requestUsage(100, 0, 80), reporting: "PRIVATE_OUTCOME_SENTINEL" }), []);
  expect(report).toMatchObject({ samples: 8, knownSamples: 0, malformedUsageSamples: 8, reportedInput: 0, tokenShare: null });
  expect(JSON.stringify(report)).not.toContain("PRIVATE_OUTCOME_SENTINEL");
});
it("qualification keeps a reported request with missing cache separate from absent usage", async () => {
  const report = await qualifyPromptCache(async () => requestUsage(100, 0, undefined), []);
  expect(report).toMatchObject({ samples: 8, knownSamples: 0, missingInputSamples: 0, missingCacheSamples: 8, missingUsageSamples: 0, malformedUsageSamples: 0, failedWithoutUsageSamples: 0, reportedInput: 800, tokenShare: null });
});

it("qualification counts explicit zero input as reported without inventing a request-hit denominator", async () => {
  const report = await qualifyPromptCache(async () => requestUsage(0, 0, undefined), []);
  expect(report).toMatchObject({ samples: 8, knownSamples: 8, requestSamples: 0, requestHits: 0, missingInputSamples: 0, missingCacheSamples: 0, missingUsageSamples: 0, knownInput: 0, cachedRead: 0, tokenShare: null });
});
it("qualification reporting coverage includes zero input while request hits use only positive-input samples", async () => {
  const report = await qualifyPromptCache(async ({ position }) => position === 0 ? requestUsage(0, 0, undefined) : requestUsage(100, 0, 80), []);
  expect(report).toMatchObject({ samples: 8, knownSamples: 8, requestSamples: 7, requestHits: 7, knownInput: 700, cachedRead: 560, tokenShare: 0.8 });
});
