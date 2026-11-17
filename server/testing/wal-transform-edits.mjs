// SPDX-License-Identifier: AGPL-3.0-or-later
// D1-D3 edits of the WAL source transform (design DESIGN-WALFLAKE6 rev8). Test-only: nothing in production reads or imports this file.
// The worker clock is test-driven only when the worker is created with WAL_TEST_CLOCK=1 in its environment; otherwise the worker keeps its own
// timer and clock and only the marker and inert helper definitions are present.
export const TRANSFORM_MARKER = "WAL-TRANSFORM-APPLIED:v1";

const WORKER_PRELUDE = [
  "const __walManual = process.env.WAL_TEST_CLOCK === \"1\";",
  "const __walClock = { t: Date.now() };",
  "const __walNow = () => __walManual ? __walClock.t : Date.now();",
  "let __walRec = null, __walAccept = null;",
  "function __walTest(m) {",
  "  if (m.walTest === \"clock\") { __walClock.t = m.set !== undefined ? m.set : __walClock.t + (m.advance || 0); parentPort.postMessage({ type: \"walClockAck\", id: m.id, t: __walClock.t }); return; }",
  "  if (m.walTest === \"tick\") { if (m.advance) __walClock.t += m.advance; __walRec = null; __tick(); parentPort.postMessage({ type: \"walTickAck\", id: m.id, rec: __walRec, t: __walClock.t }); }",
  "}",
  "",
].join("\n");

export const EDITS = {
  "server/wal-maintenance.ts": [
    { name: "worker-marker", anchor: "const WORKER_SOURCE = `\n", insert: (a) => a + `/*${TRANSFORM_MARKER}*/\n` + WORKER_PRELUDE },
    // D1: the scheduler clock (the tick's now, and lastAt) is the test clock; the scheduling rules themselves are untouched.
    { name: "clock-lastat-init", anchor: "base = 0, lastAt = Date.now();", insert: () => "base = 0, lastAt = __walNow();" },
    { name: "clock-lastat-pass", anchor: "lastAt = Date.now();\n      Object.assign(out, result", insert: () => "lastAt = __walNow();\n      Object.assign(out, result" },
    { name: "clock-tick-now", anchor: "const now = Date.now()", insert: () => "const now = __walNow()" },
    // D1: the poll body becomes a named function; a test drives it by message (and the worker's own timer is a no-op in that mode).
    { name: "tick-open", anchor: "const timer = setInterval(() => {", insert: () => "const __tick = () => {" },
    { name: "tick-close", anchor: "}, pollMs);\ntimer.unref();", insert: () => "};\nconst timer = __walManual ? setInterval(() => {}, 1073741823) : setInterval(__tick, pollMs);\ntimer.unref();" },
    // D1/D2: one record per driven tick: the rule inputs, whether a timed pass started, the deferral stamp and the accepted-start stamp.
    { name: "tick-record", anchor: "if (due) runPass(\"timed\", null, 0, sample);", insert: (a) =>
      "const __b6 = Atomics.load(shared, 6), __lastBefore = lastAt; __walAccept = null;\n  " + a +
      "\n  __walRec = { now, lastAt: __lastBefore, due, work, started: Atomics.load(shared, 6) !== __b6, deferredAt, accept: __walAccept };" },
    // D2: both stamps use the worker's Date.now(); the deferral is kept before it is cleared.
    { name: "accept-stamp", anchor: "deferredAt = null;\n  if (kind === \"timed\") timed = false;", insert: (a) => "if (kind === \"timed\") __walAccept = { acceptedStartAt: Date.now(), deferredAt };\n  " + a },
    { name: "test-message", anchor: "parentPort.on(\"message\", (m) => {\n", insert: (a) => a + "  if (m && m.walTest) { __walTest(m); return; }\n" },
  ],
  // D3: the origin of every SUCCESSFUL publication of the idle verdict (slot 7 of the ledger) is counted when it came from the 25 ms timer path.
  "server/io-budget.ts": [
    { name: "timer-publication", anchor: "Atomics.store(a.slots,7,idle);", insert: (a) => a + "if(site===\"timer\"){const g=globalThis as unknown as {__walTimerPublications?:number};g.__walTimerPublications=(g.__walTimerPublications??0)+1;}" },
  ],
};
