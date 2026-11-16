// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Flux Memory capture honours a deleted conversation (Grok engine-approvals-r5 High): the thread predicate refuses a denied thread or
// scope as captureSource does, and a deletion aborts the thread's capture in flight and its retries.
import { mkdirSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { FluxMemoryCapture, fluxBotCapturePaused } from "./flux-memory-capture.ts";
import { setFluxExternalMemory } from "./flux-memory-envelope.ts";
import { setFluxMemorySettings } from "./flux-memory-headers.ts";
import { captureThreadDeletion, onThreadMemoryDenied, threadMemoryCaptures } from "./memory/capture.ts";
import { setMemoryCaptureRoster } from "./memory/capture-scope.ts";
import { reconcileMemoryRoster } from "./memory/policy.ts";
import { readMemoryLearning, updateMemoryLearning } from "./memory/learning-policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roster = { bots: [{ id: "moss", threadId: "private" }, { id: "other", threadId: "other-thread" }], groups: [] as never[] };
const owner = { botId: "moss", audience: "owner" as const, decidedOwner: true };

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never);
  setFluxMemorySettings({}); setFluxExternalMemory(undefined);
});
afterEach(() => { setMemoryCaptureRoster(null); setFluxMemorySettings({}); setFluxExternalMemory(undefined); });

describe("Flux Memory capture and a deleted conversation", () => {
  it("the thread predicate: on while memory captures, off once the conversation is deleted or memory is off", () => {
    const db = database();
    expect(threadMemoryCaptures(db, "private")).toBe(true);
    captureThreadDeletion(db, "private");
    expect(threadMemoryCaptures(db, "private")).toBe(false);
    expect(threadMemoryCaptures(db, "other-thread")).toBe(true);
    setMemoryMode("off");
    expect(threadMemoryCaptures(db, "other-thread")).toBe(false);
  });

  it("a deletion during the request aborts it, and a deletion before a retry stops the retry", async () => {
    const db = database();
    const off = onThreadMemoryDenied(threadId => capture.forgetThread(threadId));
    let calls = 0;
    let aborted = false;
    let release: () => void = () => {};
    const capture: FluxMemoryCapture = new FluxMemoryCapture({
      key: () => "sk-flux-deny-test",
      threadCaptures: (threadId) => threadMemoryCaptures(db, threadId),
      userText: () => "keep this between us",
      asksFirst: () => false,
      ledger: { noteUsed: () => ({ space: `bot:${"b".repeat(64)}`, tag: "e".repeat(64) }), keyOff: () => false, setKeyOff: () => {}, accepted: () => {}, threadForgotten: () => {}, spaceGone: () => {}, limit: () => {} },
      sleep: async () => {},
      log: () => {},
      fetch: (async (_url: string, init: RequestInit) => {
        calls++;
        return new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
          release = () => resolve(new Response(null, { status: 503 }));
        });
      }) as typeof fetch,
    });
    try {
      capture.begin({ threadId: "private", warmIdentity: owner });
      capture.observe({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "ok", threadId: "private" });
      capture.observe({ type: "turn.completed", ok: true, threadId: "private" });
      await new Promise(resolve => setImmediate(resolve));
      expect(calls).toBe(1);
      captureThreadDeletion(db, "private");
      await Promise.all([...capture.inflight]);
      expect(aborted).toBe(true);
      expect(calls).toBe(1);

      // the other thread: its first attempt answers 503, the conversation is deleted before the retry, so no second attempt
      capture.begin({ threadId: "other-thread", warmIdentity: { ...owner, botId: "other" } });
      capture.observe({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "ok", threadId: "other-thread" });
      capture.observe({ type: "turn.completed", ok: true, threadId: "other-thread" });
      await new Promise(resolve => setImmediate(resolve));
      expect(calls).toBe(2);
      captureThreadDeletion(db, "other-thread");
      release();
      await Promise.all([...capture.inflight]);
      expect(calls).toBe(2);
    } finally { off(); }
  });

  it("a turn on a deleted conversation gets no entry at all", async () => {
    const db = database();
    captureThreadDeletion(db, "private");
    let calls = 0;
    const capture = new FluxMemoryCapture({
      key: () => "sk-flux-deny-test", threadCaptures: (threadId) => threadMemoryCaptures(db, threadId), userText: () => "hi",
      asksFirst: () => false, ledger: { noteUsed: () => ({ space: `bot:${"c".repeat(64)}`, tag: "e".repeat(64) }), keyOff: () => false, setKeyOff: () => {}, accepted: () => {}, threadForgotten: () => {}, spaceGone: () => {}, limit: () => {} }, log: () => {},
      fetch: (async () => { calls++; return new Response(null, { status: 202 }); }) as unknown as typeof fetch,
    });
    capture.begin({ threadId: "private", warmIdentity: owner });
    capture.observe({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "ok", threadId: "private" });
    capture.observe({ type: "turn.completed", ok: true, threadId: "private" });
    await Promise.all([...capture.inflight]);
    expect(calls).toBe(0);
  });
});

it("bot learning switches and the Memory page pause prevent admission and cancel a pending retry", async () => {
  const db = database(), bot = { id: "moss", learning: { enabled: true, askFirst: false } };
  expect(fluxBotCapturePaused(db, bot)).toBe(false);
  bot.learning.enabled = false; expect(fluxBotCapturePaused(db, bot)).toBe(true);
  bot.learning.enabled = true; bot.learning.askFirst = true; expect(fluxBotCapturePaused(db, bot)).toBe(true);
  bot.learning.askFirst = false;
  const current = readMemoryLearning(db);
  updateMemoryLearning(db, { botsPaused: [bot.id] }, current.revision);
  expect(fluxBotCapturePaused(db, bot)).toBe(true);
  expect(fluxBotCapturePaused(db, undefined)).toBe(true);
  let calls = 0;
  const capture = new FluxMemoryCapture({
    key: () => "sk-flux-fake-paused", threadCaptures: () => true, userText: () => "synthetic context",
    asksFirst: () => false, botCaptures: () => !fluxBotCapturePaused(db, bot),
    ledger: { noteUsed: () => ({ space: `bot:${"a".repeat(64)}`, tag: "e".repeat(64) }), keyOff: () => false, setKeyOff: () => {}, accepted: () => {}, threadForgotten: () => {}, spaceGone: () => {}, limit: () => {} },
    sleep: async () => { const policy = readMemoryLearning(db); updateMemoryLearning(db, { botsPaused: [bot.id] }, policy.revision); },
    fetch: (async () => { calls++; return new Response(null, { status: 503 }); }) as typeof fetch,
  });
  const turn = () => { capture.begin({ threadId: "private", warmIdentity: owner }); capture.observe({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "reply", threadId: "private" }); capture.observe({ type: "turn.completed", ok: true, threadId: "private" }); };
  turn(); await Promise.all([...capture.inflight]); expect(calls).toBe(0);
  updateMemoryLearning(db, { botsPaused: [] }, readMemoryLearning(db).revision);
  turn(); await Promise.all([...capture.inflight]); expect(calls).toBe(1);
});
