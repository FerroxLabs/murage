// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A task saved by 1.0.20 carries no usageAccounting. After the upgrade the bot usage card must keep the cache split such records
// showed before (the old rule: every task with input has a finite cache count), and must still drop it for a record the server
// marks partial. Entered through GET /api/bots on a booted server holding a 1.0.20-shaped bots.json, then through Store.addTaskUsage.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let fixture: VerificationServer | undefined;
let headers: Record<string, string> = {};
afterEach(async () => { await fixture?.close(); fixture = undefined; });

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture!.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const authHeaders = async () => { headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await call("GET", "/api/desktop-secret")).body.secret }; };
const AT = 1_700_000_000_000;
const legacy = (i: number) => ({ threadId: `old-${i}`, title: `Task ${i}`, createdAt: AT + i, resumeCursors: {}, usage: { input: 100, output: 10, cachedInput: 60, costUsd: null, turns: 1 } });

/** One bot whose saved tasks are `extra` plus two 1.0.20-shaped ones, read by a restarted server. */
async function upgraded(extra: object[], engineEnv: { FAKE_CLAUDE_NO_CACHE?: string } = {}) {
  fixture = await launchVerificationServer({}, undefined, { env: engineEnv });
  await authHeaders();
  const model = (await call("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
  const bot = (await call("POST", "/api/bots", { name: "Upgrade bot", modelSelection: { instanceId: "verification", model } })).body.bot as { id: string };
  await fixture.stop();
  const path = join(fixture.info.dataDir, "bots.json");
  const records = JSON.parse(readFileSync(path, "utf8")) as any[];
  const record = records.find((entry) => entry.id === bot.id);
  record.tasks = [...record.tasks.filter((task: any) => task.threadId === record.threadId), legacy(1), legacy(2), ...extra];
  writeFileSync(path, JSON.stringify(records));
  await fixture.restart();
  await authHeaders();
  return (await call("GET", "/api/bots")).body.bots.find((entry: any) => entry.id === bot.id);
}

describe("a bot saved by 1.0.20, read after the upgrade", () => {
  it("keeps the cache split its saved tasks showed", async () => {
    const frame = await upgraded([]);
    // src/lib/usage.ts botUsage keeps a cache count when the totals are unmarked-only (its own test is src/lib/usage.test.ts).
    expect(frame.usageTotal).toMatchObject({ input: 200, cachedInput: 120, cacheUnmarkedOnly: true });
  });
  it("still drops the split once a task is marked partial", async () => {
    const partial = { ...legacy(3), usage: { input: 100, output: 10, cachedInput: 30, costUsd: null, turns: 1, usageAccounting: { version: 1, inputComplete: true, cacheComplete: false } } };
    const frame = await upgraded([partial]);
    // botUsage drops a cache count the totals mark incomplete unless cacheUnmarkedOnly: so both must hold on the frame.
    expect(frame.usageTotal.cacheUnmarkedOnly).toBeUndefined();
    expect(frame.usageTotal.usageAccounting?.cacheComplete).toBe(false);
  });
  it("drops the split in the first frame a live turn with no cache report pushes, before any later write rebuilds the totals", async () => {
    // The settled turn reaches the warm aggregate only through taskAggregates.noteUsage (index.ts "bot" change, task-window.ts
    // unsoundCache counter); a later task write would rebuild it from the tasks and hide a missing update, so read the frame
    // pushed for that very change on the owner event stream.
    const frame = await upgraded([], { FAKE_CLAUDE_NO_CACHE: "1" });
    expect(frame.usageTotal).toMatchObject({ input: 200, cachedInput: 120, cacheUnmarkedOnly: true });
    const frames: any[] = [];
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${fixture!.info.url}/api/events`, { headers, signal: controller.signal });
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            for (const line of chunk.split("\n")) if (line.startsWith("data: ")) { const event = JSON.parse(line.slice(6)); if (event.kind === "bot" && event.bot.id === frame.id) frames.push(event.bot); }
          }
        }
      } catch { /* aborted */ }
    })();
    try {
      const sent = await call("POST", `/api/bots/${frame.id}/messages`, { text: "one more turn", threadId: frame.threadId });
      expect(sent.status, JSON.stringify(sent.body)).toBe(202);
      const end = Date.now() + 30_000;
      while (!frames.some((entry) => entry.usageTotal?.turns > frame.usageTotal.turns)) {
        if (Date.now() > end) throw new Error("no frame carried the settled turn");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const first = frames.find((entry) => entry.usageTotal?.turns > frame.usageTotal.turns);
      expect(first.usageTotal.turns).toBe(frame.usageTotal.turns + 1);
      expect(first.usageTotal.cacheUnmarkedOnly).toBeUndefined();
      expect(first.usageTotal.usageAccounting?.cacheComplete).toBe(false);
    } finally { controller.abort(); }
  }, 90_000);
  it("still drops it for a saved task whose input has no cache count", async () => {
    const frame = await upgraded([{ ...legacy(3), usage: { input: 100, output: 10, costUsd: null, turns: 1 } }]);
    expect(frame.usageTotal.cacheUnmarkedOnly).toBeUndefined();
    expect(frame.usageTotal.usageAccounting?.cacheComplete).toBe(false);
  });
});

describe("one more turn on a task saved by 1.0.20", () => {
  let home = "";
  afterEach(() => { vi.unstubAllEnvs(); if (home) removeTempDirSync(home); });
  async function bank(turn: { input: number; output: number; cachedInput?: number }) {
    home = mkdtempSync(join(tmpdir(), "murage-usage-legacy-"));
    vi.resetModules();
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    const { Store } = await import("./store.ts");
    const store = new Store(() => ({ instanceId: "claude", model: "m" }));
    const bot = store.createBot(undefined, { seedMessages: false });
    store.taskByThread(bot.id, bot.threadId)!.usage = { input: 100, output: 10, cachedInput: 60, costUsd: null, turns: 1 };
    return store.addTaskUsage(bot.id, bot.threadId, { ...turn, costUsd: null }, "turn-after-upgrade")!;
  }
  it("adds to the split and keeps it complete", async () => {
    expect(await bank({ input: 50, output: 5, cachedInput: 20 })).toMatchObject({ input: 150, cachedInput: 80, usageAccounting: { inputComplete: true, cacheComplete: true } });
  });
  it("a turn with no cache report still marks the sum partial", async () => {
    expect(await bank({ input: 50, output: 5 })).toMatchObject({ usageAccounting: { cacheComplete: false } });
  });
});
