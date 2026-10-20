// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// rc13 round 4 (Astra review of 1f8e8c476): the reads that moved out of one hold of the serving thread must not publish or send what changed
// while they yielded. (1) A family's publication reads its span outside the write transaction, in slices, and the transaction only checks that
// read. (2) A switched-off bot's text is never sent after the attempt's snapshot yielded. (3) The daily trace episode never writes a thread that
// was excluded, or a day read while memory was paused. A thread is judged by its own captures, never by every capture in the store.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureMessage } from "./capture.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { admissionStamp, stampMoved } from "./pip-admission.ts";
import { isLearnableSource } from "./learnable.ts";
import { gcPauseMs, startLoopStallWatch, stopLoopStallWatch } from "../observe.ts";
import { maintainPip, maybeTraceEpisodeSliced, mutateReflect, readReflectState, runPipReflect, type ReflectBot, type ReflectDeps } from "./pip-reflect.ts";
import type { IsolationReport, TextOnlyTurnInput, TextOnlyTurnResult } from "./pip-transport.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const T0 = 1_760_000_000_000;
const LATER = T0 + 30 * 24 * 3600_000;
const roster = { bots: [{ id: "moss", threadId: "private", tasks: [] as Array<{ threadId: string }> }, { id: "other", threadId: "other-thread" }], groups: [] as never[] };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never);
  database().exec("PRAGMA synchronous=OFF");
});
afterEach(() => { setMemoryCaptureRoster(null); });

function seed(pairs: number, thread = "private"): void {
  const db = database();
  db.exec("BEGIN");
  for (let i = 1; i <= pairs; i++) {
    captureMessage(db, thread, { id: `o${i}`, at: T0 + i * 1000, role: "user", kind: "text", text: `Please be brief ${i}.`, origin: "desktop" } as never);
    captureMessage(db, thread, { id: `b${i}`, at: T0 + i * 1000 + 500, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: thread === "private" ? "moss" : "other" } } as never);
  }
  db.exec("COMMIT");
  db.exec("UPDATE memory_jobs SET status='complete',cursor=100");
}
const iso: IsolationReport = { mcpServers: [], tools: [], homeNewFiles: [], cwdNewFiles: [], exited: true, initLine: true, stopReason: "end_turn" };
const empty = { proposals: [], stance: [], episode: null };
function rig(): { deps: ReflectDeps; bot: ReflectBot; calls: TextOnlyTurnInput[]; mode: { value: string } } {
  const bot: ReflectBot = { id: "moss", name: "Moss", threadIds: ["private"], continuity: true, options: { reflect: true } } as ReflectBot;
  const calls: TextOnlyTurnInput[] = [], mode = { value: "active" };
  const deps = {
    now: () => LATER, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [bot], memoryMode: () => mode.value,
    resolveRoute: async () => ({ fingerprint: "fp-1", engine: "Stub engine", kind: "cli", model: "stub-model", textOnlyTurn: async (input: TextOnlyTurnInput): Promise<TextOnlyTurnResult> => {
      calls.push(input);
      return { text: JSON.stringify(empty), usage: { inputTokens: 100, outputTokens: 50 }, isolation: iso, verdict: { state: "validated", structured: empty } };
    } }),
  } as unknown as ReflectDeps;
  return { deps, bot, calls, mode };
}
/** This thread's own CPU time in ms (user + system). */
const threadCpuMs = () => { const usage = process.threadCpuUsage(); return (usage.user + usage.system) / 1000; };
/** Runs `body` while a ticker counts loop turns and calls `onTurn` on each; returns the longest stretch the loop went without a turn, less the
 *  garbage collector's pauses in it (observe.ts gcPauseMs, the same subtraction the stall line makes), and never more than the CPU this
 *  thread itself spent in it: a shared CI host that takes the CPU away from the process is not the work holding the loop (the same
 *  measure as memory/msearch-r5.test.ts). The budget is the work's own hold. */
async function ticking<T>(body: () => Promise<T>, onTurn: () => void = () => {}): Promise<{ value: T; longest: number }> {
  startLoopStallWatch(60_000);
  let last = performance.now(), lastCpu = threadCpuMs(), longest = 0, on = true;
  const held = (t: number, cpu: number) => Math.min(t - last - gcPauseMs(last, t), cpu - lastCpu);
  const tick = () => { if (!on) return; const t = performance.now(), cpu = threadCpuMs(); longest = Math.max(longest, held(t, cpu)); last = t; lastCpu = cpu; onTurn(); setImmediate(tick); };
  setImmediate(tick);
  try { const value = await body(); return { value, longest: Math.max(longest, held(performance.now(), threadCpuMs())) }; } finally { on = false; stopLoopStallWatch(); }
}

it("a thread is judged by its own captures: a capture in another thread does not move its stamp, one in it does", () => {
  seed(3); seed(3, "other-thread");
  const db = database(), { deps } = rig();
  // real learnability inputs (capture jobs complete), never a stubbed answer
  const first = db.prepare("SELECT id,revision FROM memory_sources WHERE thread_id='private' AND speaker='owner' LIMIT 1").get()!;
  expect(isLearnableSource(db, String(first.id), Number(first.revision)).learnable).toBe(true);
  const stamp = admissionStamp(db, deps, "moss", ["private"], { reflect: true });
  expect(stampMoved(db, deps, "moss", stamp)).toBe("none");
  captureMessage(db, "other-thread", { id: "x1", at: LATER, role: "user", kind: "text", text: "Elsewhere.", origin: "desktop" } as never);
  expect(stampMoved(db, deps, "moss", stamp)).toBe("none");
  captureMessage(db, "private", { id: "x2", at: LATER, role: "user", kind: "text", text: "Here.", origin: "desktop" } as never);
  expect(stampMoved(db, deps, "moss", stamp)).toBe("moved");
});

// A 50 ms budget over a 100,000-source run (130 s on a hosted runner) is measured on the dedicated perf host (vite.config.ts perf-budget).
it("on a thread of 100,000 sources the whole run, publication included, never holds the loop 50 ms", { tags: ["perf-budget"], timeout: 600_000 }, async () => {
  seed(50_000);
  const { deps, calls } = rig();
  const { value, longest } = await ticking(() => runPipReflect(deps, "moss", new AbortController().signal));
  expect(calls.length).toBe(1);
  expect(value.status).toBe("applied");
  expect(longest).toBeLessThan(50);
});

it("a capture in the thread while the publication read yields is read again, and the family is published from the new read", async () => {
  seed(8000);
  const { deps, calls } = rig();
  let captured = false;
  let { value } = await ticking(() => runPipReflect(deps, "moss", new AbortController().signal), () => {
    const family = Object.values(readReflectState(database(), "moss").run?.families ?? {})[0];
    if (captured || family?.state !== "validated") return;
    captured = true;
    captureMessage(database(), "private", { id: "late", at: LATER, role: "bot", kind: "text", text: "Later.", turnTerminal: true, from: { botId: "moss" } } as never);
  });
  // a publication read that moved is retried on the next idle pass (deferred, PIP-REDESIGN 2.4), from the family still validated
  for (let pass = 0; pass < 3 && value.reason === "read-moved"; pass++) value = await runPipReflect(deps, "moss", new AbortController().signal);
  expect(captured).toBe(true);
  expect(calls.length).toBe(1);
  expect(value.status).toBe("applied");
}, 300_000);

it("Continuity switched off while the attempt's snapshot yields: nothing is sent and the family is refused as off", async () => {
  seed(8000);
  const { deps, bot, calls } = rig();
  let switched = false;
  const { value } = await ticking(() => runPipReflect(deps, "moss", new AbortController().signal), () => {
    if (switched || !readReflectState(database(), "moss").run) return;
    switched = true;
    bot.continuity = false;
  });
  expect(switched).toBe(true);
  expect(calls.length).toBe(0);
  expect(value).toMatchObject({ status: "refused", reason: "off" });
}, 300_000);

it("the daily trace episode writes nothing, and keeps its day, when the thread is excluded or memory paused while it reads", async () => {
  seed(200);
  const { deps, bot, mode } = rig();
  // excluded during the read
  let excluded = false;
  expect(await maybeTraceEpisodeSliced(deps, bot, async () => { if (!excluded) { excluded = true; mutateReflect("moss", s => { s.excludedThreads = ["private"]; }); } })).toBe(false);
  expect(excluded).toBe(true);
  expect(readReflectState(database(), "moss").lastTraceDay).toBeUndefined();
  mutateReflect("moss", s => { s.excludedThreads = []; });
  // paused during the read
  let paused = false;
  expect(await maybeTraceEpisodeSliced(deps, bot, async () => { if (!paused) { paused = true; mode.value = "paused"; } })).toBe(false);
  expect(paused).toBe(true);
  expect(readReflectState(database(), "moss").lastTraceDay).toBeUndefined();
  mode.value = "active";
  // a stopped maintenance pass records no day either
  const stop = new AbortController(); stop.abort();
  await maintainPip(deps, { signal: stop.signal });
  expect(readReflectState(database(), "moss").lastTraceDay).toBeUndefined();
  // nothing moves: the day is written and recorded
  expect(await maybeTraceEpisodeSliced(deps, bot, async () => {})).toBe(true);
  expect(readReflectState(database(), "moss").lastTraceDay).toBeTruthy();
});
