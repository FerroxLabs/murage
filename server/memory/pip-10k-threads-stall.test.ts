// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 N3 stall guard: the pip pass the server runs (index.ts: pipReflectPendingSliced, then the run's sliced choice of threads) over one
// bot with 10,000 threads never holds the serving thread for a second at a time; the loop keeps turning while it reads.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureMessage } from "./capture.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { pipReflectPendingSliced, readReflectState, reflectableThreadsSliced, sliceBetween, type ReflectDeps } from "./pip-reflect.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const THREADS = 10_000;
const HOLD_MAX_MS = 1_000;
const T0 = 1_760_000_000_000, LATER = T0 + 30 * 24 * 3600_000;
const threadIds = Array.from({ length: THREADS }, (_, i) => `t${String(i).padStart(5, "0")}`);
const roster = { bots: [{ id: "moss", threadId: threadIds[0]!, tasks: threadIds.slice(1).map(threadId => ({ threadId })) }], groups: [] as never[] };
const deps = {
  now: () => LATER, bootEpoch: "boot" as never, tmpBase: "/tmp",
  bots: () => [{ id: "moss", threadIds, continuity: true, options: { reflect: true } as never }],
  resolveRoute: async () => { throw new Error("not used"); }, memoryMode: () => "active",
} as unknown as ReflectDeps;

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster as never); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never);
  const db = database();
  db.exec("PRAGMA synchronous=OFF");
  db.exec("BEGIN");
  threadIds.forEach((threadId, i) => {
    captureMessage(db, threadId, { id: `o${i}`, at: T0 + i * 1000, role: "user", kind: "text", text: `Please be brief ${i}.`, origin: "desktop" } as never);
    captureMessage(db, threadId, { id: `b${i}`, at: T0 + i * 1000 + 500, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } } as never);
  });
  db.exec("COMMIT");
  db.exec("UPDATE memory_jobs SET status='complete',cursor=100");
});
afterEach(() => { setMemoryCaptureRoster(null); });

/** The longest contiguous hold of the loop while `body` runs, collector pauses included (the stall line counts them in blocked=). */
async function longestHold<T>(body: () => Promise<T>): Promise<{ value: T; longest: number; turns: number }> {
  let last = performance.now(), longest = 0, turns = 0, on = true;
  const held = (t: number) => t - last;
  const tick = () => { if (!on) return; const t = performance.now(); longest = Math.max(longest, held(t)); last = t; turns++; setImmediate(tick); };
  setImmediate(tick);
  try { const value = await body(); return { value, longest: Math.max(longest, held(performance.now())), turns }; } finally { on = false; }
}

it(`the pending check and the run's choice of threads over ${THREADS} threads never hold the loop ${HOLD_MAX_MS} ms`, { timeout: 600_000 }, async () => {
  const cold = await longestHold(() => pipReflectPendingSliced(deps));
  expect(cold.value).toBe("moss");
  expect(cold.longest).toBeLessThan(HOLD_MAX_MS);
  const warm = await longestHold(() => pipReflectPendingSliced(deps));
  expect(warm.longest).toBeLessThan(HOLD_MAX_MS);
  const db = database(), bot = deps.bots()[0]!;
  const choice = await longestHold(() => reflectableThreadsSliced(db, deps, bot, readReflectState(db, "moss"), LATER, sliceBetween()));
  expect(choice.value.length).toBe(THREADS);
  expect(choice.longest).toBeLessThan(HOLD_MAX_MS);
  expect(choice.turns).toBeGreaterThan(10);
});
