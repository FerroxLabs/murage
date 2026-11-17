// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { turnFromLog } from "../scale/rig-config.mjs";
import { judge } from "./smooth-config.mjs";
import { loadBudgets } from "./smooth-gate.mjs";
const key = thread => createHash("sha256").update(thread).digest("hex").slice(0, 16);
const tr = (id, phase, extra = "") => `[turn-trace] id=${id} phase=${phase} at=1ms since=1ms ${extra}`;
const retry = thread => `[memory] context revoked at a late submission on thread ${thread}; re-preparing (1 of 3)`;
it("S6.held parser waits through numbered retries and attributes interleaved threads", () => {
  const log = [tr("foreign", "received", `threadKey=${key("other")}`), tr("first", "received", `threadKey=${key("held")}`), retry("held"), tr("first", "turn.done", "outcome=failed")];
  expect(turnFromLog(log.join("\n"), "held")).toMatchObject({ traceId: "first", redispatched: true, done: false });
  log.push(tr("second", "received", `threadKey=${key("held")}`), retry("held").replace("1 of 3", "2 of 3"), tr("second", "turn.done", "outcome=failed"));
  expect(turnFromLog(log.join("\n"), "held").done).toBe(false);
  log.push(tr("third", "received", `threadKey=${key("held")}`), tr("third", "turn.done", "outcome=ok"));
  expect(turnFromLog(log.join("\n"), "held")).toMatchObject({ traceId: "first", redispatchTraceId: "third", done: true, outcome: "ok" });
});
// Run the actual rig turn collector with isolated transport/log/clock fakes. The
// first terminal is submission_refused; cleanup may run only after the retry.
it.each([false, true])("S6.held rig waits for final settlement before cleanup (timeout=%s)", async neverFinishes => {
  const source = readFileSync(new URL("./smooth.mjs", import.meta.url), "utf8");
  const collector = source.slice(source.indexOf("async function turn(botId"), source.indexOf("const PROMPT ="));
  const results = [];
  for (const thread of ["a", "b", "c"]) {
    let tick = 0, waiter, resolveEnd, cleaned = false;
    const log = [tr("first", "received", `threadKey=${key(thread)}`)];
    const deps = {
      TURN_TIMEOUT: 10000, quiesce: async () => {}, logSize: () => 0, logFrom: () => log.join("\n"),
      performance: { now: () => tick * 1000 }, Date, randomBytes, currentScenario: "deletion", seenTurnIds: new Map(),
      waits: { add: w => { waiter = w; resolveEnd = w.resolve; }, delete: () => {} }, activeEvidenceTurns: new Map(),
      call: async () => ({ status: 200, ms: 1 }), ownedTraces: new Set(), turnFromLog,
      sleep: async () => {
        tick++;
        if (tick === 1) { log.push(retry(thread), tr("first", "turn.done", "outcome=failed")); waiter.turnId = "attempt-1"; resolveEnd({ type: "turn.failed", turnId: "attempt-1", at: tick * 1000 }); }
        if (tick === 3) log.push(tr("second", "received", `threadKey=${key(thread)}`));
        if (tick === 9 && !neverFinishes) { log.push(tr("second", "turn.done", "outcome=ok")); waiter.turnId = "attempt-2"; waiter.end = { type: "turn.completed", turnId: "attempt-2", at: tick * 1000 }; }
      },
      settleBot: async () => { cleaned = true; return { settled: true }; },
      getBot: async () => ({ busy: neverFinishes || tick < 9 }),
      keptTurnEnd: () => ({}), redact: s => s, keepFailedTurn: async r => r, R: {}, note: () => {},
    };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const result = await new AsyncFunction(...Object.keys(deps), `let lastTurnMark; ${collector}; return turn('bot', '${thread}', 'held', { wait: false });`)(...Object.values(deps));
    expect(tick).toBeGreaterThanOrEqual(9);
    expect(cleaned).toBe(neverFinishes);
    expect(result).toMatchObject({ failed: neverFinishes, outcome: neverFinishes ? "timeout" : "turn.completed" });
    results.push(result);
  }
  if (neverFinishes) return;
  const rows = judge(loadBudgets(), { scenarios: { deletion: { heldCompleted: results.filter(r => !r.failed).length, rePreparing: 1 } } });
  expect(rows.rows.filter(r => ["S6.held", "S6.rePreparing"].includes(r.id)).every(r => r.pass)).toBe(true);
});
it("S6.held SSE waiter stays on the logical send across provider attempts", async () => {
  const { matchTurnEvent } = await import("../scale/rig-config.mjs");
  const source = readFileSync(new URL("./smooth.mjs", import.meta.url), "utf8");
  const reader = source.slice(source.indexOf("async function sse()"), source.indexOf("// ---- RIG-SMOOTH-R2 v3 telemetry"));
  const ends = [], wait = { logicalSend: true, threadId: "held", before: new Set(["old"]), resolve: e => ends.push(e) };
  const waits = new Set([wait]);
  let aborted;
  const frames = [
    { type: "turn.started", threadId: "other", turnId: "foreign" },
    { type: "turn.started", threadId: "held", turnId: "first" },
    { type: "turn.completed", threadId: "held", turnId: "first", ok: false },
    { type: "turn.started", threadId: "held", turnId: "second" },
    { type: "turn.completed", threadId: "held", turnId: "old", ok: false },
    { type: "turn.completed", threadId: "held", turnId: "second", ok: true },
  ];
  const deps = { waits, matchTurnEvent, URL_: "fixture", H: {}, TextDecoder, performance,
    registerOwnedThreads: () => {}, journalFailureEvent: () => {}, activeJournalTurns: new Map(), ownedThreadScenarios: new Map(),
    currentScenario: "deletion", keptTurnEnd: () => ({}), redact: s => s, seenTurnIds: new Map(), sleep: async () => {},
    AbortController: class { constructor() { aborted = this; this.signal = { aborted: false }; } },
    fetch: async () => ({ body: (async function* () { yield new TextEncoder().encode(frames.map(e => `data: ${JSON.stringify(e)}\n`).join("")); aborted.signal.aborted = true; })() }),
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction(...Object.keys(deps), `let sseAbort, journalTurnSequence = 0; ${reader}; await sse();`)(...Object.values(deps));
  expect(waits.has(wait)).toBe(true);
  expect(ends.map(e => e.type)).toEqual(["turn.failed", "turn.completed"]);
  expect(wait.end).toMatchObject({ turnId: "second", type: "turn.completed" });
});
