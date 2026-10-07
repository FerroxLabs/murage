import type { IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { CLEANUP_PATH, MAX_CLEANUP_CHARS, createCleanupBudget, handleCleanupRoute, withBudget, type CleanupRunner } from "./dictation-cleanup-route.ts";
import { ROUTE_POLICY } from "../route-policy.ts";

function fakeRes() {
  const state = { status: 0, body: "", headers: {} as Record<string, string> };
  return {
    state,
    res: {
      setHeader: (k: string, v: string) => { state.headers[k] = v; },
      writeHead: (status: number, headers?: Record<string, string>) => { state.status = status; Object.assign(state.headers, headers); },
      end: (data?: string) => { state.body = data ?? ""; },
    } as never,
  };
}

const ask = async (method: string, body: unknown, run: CleanupRunner, path = CLEANUP_PATH) => {
  const { res, state } = fakeRes();
  const handled = await handleCleanupRoute(method, new URL(`http://x${path}`), {} as IncomingMessage, res, { run, readBody: async () => body });
  return { handled, status: state.status, json: state.body ? JSON.parse(state.body) : null, headers: state.headers };
};

describe("POST /api/voice/cleanup", () => {
  it("is not its business when the path is another", async () => {
    expect((await ask("POST", {}, vi.fn(), "/api/voice/transcribe")).handled).toBe(false);
  });

  it("answers GET with 405 and an allow header", async () => {
    const r = await ask("GET", {}, vi.fn());
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe("POST");
  });

  it("needs text", async () => {
    expect((await ask("POST", { text: "  " }, vi.fn())).status).toBe(400);
    expect((await ask("POST", null, vi.fn())).status).toBe(400);
  });

  it("returns the cleaned text and passes the bot and room ids", async () => {
    const run = vi.fn(async () => ({ text: "Clean.", cleaned: true }));
    const r = await ask("POST", { text: "um clean", botId: "bot_1", groupId: "../x" }, run);
    expect(r.json).toEqual({ text: "Clean.", cleaned: true });
    expect(run).toHaveBeenCalledWith("um clean", { botId: "bot_1", groupId: undefined });
  });

  it("answers 200 with the raw text when the runner throws", async () => {
    const r = await ask("POST", { text: "raw words here" }, async () => { throw new Error("boom"); });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ text: "raw words here", cleaned: false });
  });

  it("hands back an over-long transcript untouched without calling the model", async () => {
    const run = vi.fn();
    const long = "word ".repeat(MAX_CLEANUP_CHARS);
    const r = await ask("POST", { text: long }, run);
    expect(r.json.cleaned).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the route is gated exactly like /api/voice/transcribe", () => {
  const entry = (path: string) => ROUTE_POLICY.filter((row) => row.path === path);

  it("has the same route-policy class and methods", () => {
    const transcribe = entry("/api/voice/transcribe");
    const cleanup = entry("/api/voice/cleanup");
    expect(transcribe).toHaveLength(1);
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0].class).toBe(transcribe[0].class);
    expect(cleanup[0].methods).toEqual(transcribe[0].methods);
  });

  it("is registered in the companion's native and browser allowlists next to transcribe", () => {
    const source = readFileSync(fileURLToPath(new URL("../../companion/src/routes.ts", import.meta.url)), "utf8");
    const count = (needle: string) => source.split(needle).length - 1;
    const transcribe = count(String.raw`path: /^\/api\/voice\/transcribe$/`);
    expect(transcribe).toBe(2);
    expect(count(String.raw`path: /^\/api\/voice\/cleanup$/`)).toBe(transcribe);
  });

  it("is dispatched in the same block as transcribe, behind the same guards", () => {
    const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    const at = source.indexOf('path === "/api/voice/transcribe"');
    const cleanup = source.indexOf("handleCleanupRoute(");
    expect(at).toBeGreaterThan(0);
    expect(cleanup).toBeGreaterThan(at);
    expect(cleanup - at).toBeLessThan(2500);
  });
});

describe("the clean-up budget", () => {
  it("allows 60 a minute, then reports no room until the window rolls", () => {
    const budget = createCleanupBudget();
    for (let i = 0; i < 60; i += 1) expect(budget.allow(1_000)).toBe(true);
    expect(budget.allow(1_000)).toBe(false);
    expect(budget.allow(61_001)).toBe(true);
  });

  it("returns the raw text over budget, never an error, and does not call the model", async () => {
    const run = vi.fn(async () => ({ text: "Clean.", cleaned: true }));
    const budget = createCleanupBudget(2, 60_000);
    const guarded = withBudget(run, budget);
    expect((await guarded("a b c d", {})).cleaned).toBe(true);
    expect((await guarded("a b c d", {})).cleaned).toBe(true);
    expect(await guarded("raw words here now", {})).toEqual({ text: "raw words here now", cleaned: false });
    expect(run).toHaveBeenCalledTimes(2);
    const r = await ask("POST", { text: "raw words here now" }, guarded);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ text: "raw words here now", cleaned: false });
  });
});
