// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from "vitest";
import { requestMemoryExtraction } from "./extract.ts";

afterEach(() => vi.restoreAllMocks());
const capture = async (url: string) => {
  const seen: Array<Record<string, string>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: URL, init: RequestInit) => { seen.push(init.headers as Record<string, string>); return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "[]" } }] })); }));
  await requestMemoryExtraction({ url, apiKey: "k", model: "m" } as Parameters<typeof requestMemoryExtraction>[0], "some text to learn from", 1000, new AbortController().signal).catch(() => {});
  vi.unstubAllGlobals();
  return seen[0];
};

it("the extraction request to Flux is background work: capture off, inject off, app murage, and never the old names", async () => {
  const headers = await capture("https://api.fluxrouter.ai/v1");
  expect(headers).toBeTruthy();
  expect(headers["x-flux-memory-capture"]).toBe("off");
  expect(headers["x-flux-memory-inject"]).toBe("off");
  expect(headers["x-flux-memory-app"]).toBe("murage");
  expect(Object.keys(headers).some(name => /scope|required/i.test(name))).toBe(false);
});

it("an extraction endpoint that is not Flux gets no memory headers", async () => {
  const headers = await capture("https://api.example.com/v1");
  expect(Object.keys(headers).filter(name => name.startsWith("x-flux-memory"))).toEqual([]);
});
