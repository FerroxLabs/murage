// The reducer behind every upgrade screen (shared/upgrade-machine.mjs): each r1 UX-01..12 and r2 #1..#8 finding of lanes/upgui-review, as a test.
import assert from "node:assert/strict";
import test from "node:test";
import { sampleState, parseUpgradeState, unknownUpgradeState } from "../shared/upgrade-contract.mjs";
import {
  DONE_SHOWN_MS, NEUTRAL_AFTER_MS, initialContext, reduce, selectDetail, selectPoll, selectReclaim, selectSettingsDescription, selectStrip, selectWindow,
} from "../shared/upgrade-machine.mjs";

const L1 = "a".repeat(64), L2 = "b".repeat(64);
const state = (over = {}) => sampleState({ launch: L1, step: { awakeElapsedMs: 0, unit: "none" }, ...over });
const blocking = (over = {}) => state({ stage: "starting", phase: "migrating", step: { awakeElapsedMs: 8000, unit: "none" }, complete: false, held: "unknown", capture: "unknown", recall: "unknown", ...over });
const run = (events, family = "app") => events.reduce((ctx, e) => reduce(ctx, e), initialContext(family));
let seq = 0;
const read = (at, s, extra = {}) => ({ type: "READING", at, state: { ...s, seq: ++seq }, ...extra });
const at = (n) => 1_000_000 + n * 1000;

test("UX-02: counts that are not exact carry no figure to show", () => {
  const ctx = run([read(at(0), blocking({ counts: { exact: false } }))], "window");
  assert.equal(selectWindow(ctx).counts, null);
  assert.equal(parseUpgradeState({ ...state(), counts: { messages: 5 } }).ok, false);
  const exact = run([read(at(0), blocking({ counts: { exact: true, messages: 1200, conversations: 40, memoryRecords: 9, firstMessageAt: null } }))], "window");
  assert.equal(selectWindow(exact).counts.messages, 1200);
});

test("UX-03: nothing is a percent until a known launch has said how far; then it never goes below what was shown", () => {
  let ctx = run([read(at(0), blocking({ launch: "unknown", overall: 0.3 }))], "window");
  assert.equal(selectWindow(ctx).percent, null, "an unknown-launch reading accrues no percent");
  ctx = reduce(ctx, read(at(1), blocking({ overall: 0.2 })));
  ctx = reduce(ctx, read(at(2), blocking({ overall: 0.1 })));
  assert.equal(selectWindow(ctx).percent, 20);
});

test("UX-04 / r2-2: the same launch keeps its percent through an empty reading; a new launch starts again; the old launch is retired", () => {
  const working = (o) => state({ stage: "background", phase: "references", overall: o });
  let ctx = run([read(at(0), working(0.81))]);
  ctx = reduce(ctx, read(at(2), state({ stage: "idle", phase: "none", complete: false, overall: "unknown" })));
  assert.equal(selectStrip(ctx).percent, 81, "an idle reading with complete:false neither hides the strip nor resets it");
  assert.equal(ctx.missed, 1);
  ctx = reduce(ctx, read(at(4), working(0.02)));
  assert.equal(selectStrip(ctx).percent, 81, "81 -> {} -> 2 shows 81");
  ctx = reduce(ctx, read(at(6), { ...working(0.02), launch: L2 }));
  assert.equal(selectStrip(ctx).percent, 2, "L1 -> L2 resets");
  ctx = reduce(ctx, read(at(8), working(0.9)));
  assert.equal(selectStrip(ctx).percent, 2, "a late answer from the retired launch is ignored");
  assert.equal(ctx.ignored, 1);
});

test("r2-2: a first known launch after unknown readings is adopted without a reset", () => {
  let ctx = run([read(at(0), blocking({ launch: "unknown", overall: "unknown" }))], "window");
  ctx = reduce(ctx, read(at(1), blocking({ overall: 0.1 })));
  assert.equal(ctx.launch, L1);
  assert.equal(selectWindow(ctx).percent, 10);
  ctx = reduce(ctx, read(at(2), blocking({ launch: "unknown", overall: 0.9 })));
  assert.equal(selectWindow(ctx).percent, 10, "figures from an unknown launch never accrue");
});

test("an answer that arrives out of order is dropped", () => {
  let ctx = run([{ type: "READING", at: at(0), state: { ...state({ stage: "background", phase: "shapes", overall: 0.5 }), seq: 10 } }]);
  ctx = reduce(ctx, { type: "READING", at: at(1), state: { ...state({ stage: "background", phase: "shapes", overall: 0.3 }), seq: 9 } });
  assert.equal(ctx.ignored, 1);
  assert.equal(selectStrip(ctx).percent, 50);
});

const withEta = (ms, awake, over = {}) => state({ stage: "background", phase: "references", eta: { stable: true, ms }, step: { awakeElapsedMs: awake, unit: "none" }, overall: 0.4, ...over });
test("UX-05: the time left needs two steady readings, a phase that has run long enough, and is withdrawn when it goes", () => {
  let ctx = run([read(at(0), withEta(360_000, 9000))]);
  assert.equal(selectStrip(ctx).left, null, "one reading is not enough");
  ctx = reduce(ctx, read(at(2), withEta(360_000, 11_000)));
  assert.equal(selectStrip(ctx).left, 6);
  ctx = reduce(ctx, read(at(4), withEta(360_000, 13_000, { eta: { stable: false } })));
  assert.equal(selectStrip(ctx).left, null, "an unstable reading withdraws what was shown");
  const young = run([read(at(0), withEta(360_000, 2000)), read(at(2), withEta(360_000, 3000))]);
  assert.equal(selectStrip(young).left, null, "a phase under five awake seconds has no believable estimate");
  const counted = run([read(at(0), withEta(360_000, 9000, { phase: "lineage", step: { awakeElapsedMs: 9000, unit: "conversations", done: 1, total: 100 } })), read(at(2), withEta(360_000, 11_000, { phase: "lineage", step: { awakeElapsedMs: 11_000, unit: "conversations", done: 2, total: 100 } }))]);
  assert.equal(selectStrip(counted).left, null, "a counted phase under a tenth done has none either");
});

test("UX-05 (r9): an estimate that rises while the work moves shows the new estimate and nothing else; only a stall is called slow", () => {
  let ctx = run([read(at(0), withEta(360_000, 9000)), read(at(2), withEta(360_000, 11_000))]);
  ctx = reduce(ctx, read(at(4), withEta(660_000, 13_000)));
  ctx = reduce(ctx, read(at(6), withEta(660_000, 15_000)));
  assert.equal(selectStrip(ctx).left, 10);
  assert.equal(selectStrip(ctx).slow, false, "a grown estimate is not a stall");
});

test("r2-4: a gap longer than sleep followed by a failed read withdraws the time left; repeated failures keep it withdrawn", () => {
  let ctx = run([read(at(0), withEta(360_000, 9000)), read(at(2), withEta(360_000, 11_000))]);
  assert.equal(selectStrip(ctx).left, 6);
  ctx = reduce(ctx, { type: "READ_FAILED", at: at(2) + 120_000 });
  assert.equal(selectStrip(ctx).left, null);
  ctx = reduce(ctx, { type: "READ_FAILED", at: at(2) + 130_000 });
  assert.equal(selectStrip(ctx).left, null);
});

test("r2-4: past a minute without a good reading the copy degrades to a neutral still-working line (no percent, no time)", () => {
  let ctx = run([read(at(0), withEta(360_000, 9000)), read(at(2), withEta(360_000, 11_000))]);
  ctx = reduce(ctx, { type: "MALFORMED", at: at(2) + NEUTRAL_AFTER_MS + 1000, reason: "malformed" });
  const strip = selectStrip(ctx);
  assert.equal(strip.neutral, true);
  assert.equal(strip.percent, null);
  assert.equal(strip.left, null);
});

test("a sleep and wake resets the estimate and the moving sense, keeps the percent, and the slept time is not time worked", () => {
  let ctx = run([read(at(0), withEta(360_000, 9000)), read(at(2), withEta(360_000, 11_000))]);
  const before = ctx.runAwakeMs;
  ctx = reduce(ctx, { type: "SUSPEND", at: at(3) });
  ctx = reduce(ctx, { type: "RESUME", at: at(3) + 600_000 });
  ctx = reduce(ctx, read(at(3) + 601_000, withEta(360_000, 13_000)));
  assert.equal(selectStrip(ctx).left, null);
  assert.equal(selectStrip(ctx).percent, 40);
  assert.ok(ctx.runAwakeMs - before < 5000, "ten minutes asleep is not ten minutes waited");
});

test("UX-07 / r2-5: keepOpen unknown while blocking is true; false only on a parsed false or when finishing", () => {
  assert.equal(run([read(at(0), blocking({ keepOpen: "unknown" }))], "window").keepOpen, true);
  assert.equal(selectWindow(run([read(at(0), blocking({ keepOpen: "unknown" }))], "window")).keepOpen, true);
  assert.equal(run([read(at(0), blocking({ keepOpen: false }))], "window").keepOpen, false);
  let ctx = run([read(at(0), blocking({ keepOpen: true }))], "window");
  assert.equal(selectWindow(ctx).keepOpen, true);
  ctx = reduce(ctx, { type: "LISTEN", at: at(1), ready: false });
  assert.equal(selectWindow(ctx).keepOpen, false);
  const legacy = reduce(initialContext("window"), { type: "MALFORMED", at: at(0), reason: "legacy" });
  assert.equal(selectWindow(legacy).keepOpen, true);
  assert.equal(selectWindow(legacy).percent, null, "an old server shows activity only");
});

test("UX-01 / r2-1: a known hold overrides every cached mode, and capture is claimed only when a source says it is on", () => {
  const ctx = initialContext("app");
  const held = run([read(at(0), state({ stage: "background", phase: "references", held: true, holdKey: "memoryStrip.hold", capture: "off", recall: "off", overall: 0.3 }))]);
  for (const mode of ["active", "capture", "paused", "off"]) assert.equal(selectSettingsDescription(held, { mode }), "held", `${mode} with a known hold`);
  assert.equal(selectSettingsDescription(ctx, { mode: "active", held: true, capture: "off", recall: "off" }), "held", "the status endpoint's own hold counts");
  assert.equal(selectSettingsDescription(ctx, { mode: "paused" }), "paused", "unknown health never claims capture");
  assert.equal(selectSettingsDescription(ctx, { mode: "active" }), "on", "no source: no capture or recall claim");
  assert.equal(selectSettingsDescription(ctx, { mode: "paused", held: false, capture: "on", recall: "off" }), "pausedNoted");
  assert.equal(selectSettingsDescription(ctx, { mode: "active", held: false, capture: "on", recall: "on" }), "active");
  assert.equal(selectSettingsDescription(ctx, { mode: "capture", held: false, capture: "on", recall: "off" }), "capture");
  assert.equal(selectSettingsDescription(ctx, { mode: "off", held: false, capture: "off", recall: "off" }), "off");
});

test("a hold wins from any state, survives an unknown, and ends only on an explicit false or a new launch", () => {
  const bg = (over) => state({ stage: "background", phase: "references", overall: 0.3, ...over });
  let ctx = run([read(at(0), bg({}))]);
  ctx = reduce(ctx, read(at(2), bg({ held: true, holdKey: "memoryStrip.hold", capture: "off", recall: "off" })));
  assert.equal(ctx.mode, "held");
  assert.equal(selectStrip(ctx).kind, "hold");
  assert.equal(selectStrip(ctx).role, "alert");
  ctx = reduce(ctx, read(at(4), bg({ held: "unknown" })));
  assert.equal(ctx.mode, "held", "unknown does not release it");
  assert.equal(ctx.capture, "off");
  ctx = reduce(ctx, read(at(6), bg({ held: false, capture: "on", recall: "on" })));
  assert.equal(ctx.mode, "working");
  let again = run([read(at(0), bg({ held: true, holdKey: "memoryStrip.hold", capture: "off", recall: "off" }))]);
  again = reduce(again, read(at(2), { ...bg({ held: false }), launch: L2 }));
  assert.equal(again.mode, "working", "a new launch is not held until it says so");
});

test("only complete:true ends a run: finishing shows for a while, then idle; complete unknown never ends it", () => {
  const bg = (over) => state({ stage: "background", phase: "references", overall: 0.9, ...over });
  let ctx = run([read(at(0), bg({}))]);
  ctx = reduce(ctx, read(at(2), state({ stage: "idle", phase: "none", complete: "unknown", overall: "unknown" })));
  assert.equal(selectStrip(ctx).kind, "working", "complete unknown keeps the last view");
  ctx = reduce(ctx, read(at(4), state({ stage: "idle", phase: "none", complete: true, overall: 1 })));
  assert.equal(selectStrip(ctx).kind, "done");
  ctx = reduce(ctx, { type: "TICK", at: at(4) + DONE_SHOWN_MS + 100 });
  assert.equal(selectStrip(ctx), null);
  assert.equal(selectPoll(ctx).active, false, "polling stops in idle on a known launch");
  const never = run([read(at(0), state({ stage: "idle", phase: "none", complete: true, overall: 1 }))]);
  assert.equal(never.mode, "idle", "a first look that finds nothing to do shows nothing");
  assert.equal(selectStrip(never), null);
});

test("work after a finished notice in the same launch keeps the launch high-water: it shows no lower percent (r3-5), only that work is going on", () => {
  const bg = (o, over = {}) => state({ stage: "background", phase: "references", overall: o, ...over });
  let ctx = run([read(at(0), bg(0.9)), read(at(2), state({ stage: "idle", phase: "none", complete: true, overall: 1 })), { type: "TICK", at: at(20) }]);
  ctx = reduce(ctx, read(at(22), bg(0.2)));
  assert.equal(selectStrip(ctx).kind, "working");
  assert.equal(selectStrip(ctx).percent, null, "indeterminate, never 20 after 100");
});

test("UX-12 / r2-3: polling stops only in idle with a known launch, and a lifecycle event, a reconnect or a return to view wakes it", () => {
  let ctx = run([read(at(0), state({ stage: "idle", phase: "none", complete: true, overall: 1 }))]);
  assert.equal(selectPoll(ctx).active, false);
  for (const type of ["LIFECYCLE", "RECONNECT", "VISIBLE"]) {
    const woken = reduce(ctx, { type, at: at(5) });
    assert.equal(selectPoll(woken).now, true, type);
    assert.equal(selectPoll(reduce(woken, { type: "POLL_STARTED" })).now, false);
  }
  const unknownLaunch = run([read(at(0), state({ launch: "unknown", stage: "idle", phase: "none", complete: true, overall: 1 }))]);
  assert.equal(selectPoll(unknownLaunch).active, true, "an unknown launch cannot be called settled");
  const neverSeen = initialContext("app");
  assert.equal(selectPoll(neverSeen).active, true);
});

test("UX-10 / r2-6: the health reading alone carries the storage state, and polling continues while it converts", () => {
  const idle = (storage) => state({ stage: "idle", phase: "none", complete: true, overall: 1, storage });
  let ctx = run([read(at(0), idle("converting"))]);
  assert.equal(selectReclaim(ctx).converting, true);
  assert.equal(selectPoll(ctx).active, true);
  ctx = reduce(ctx, read(at(2), idle("reclaim-available")));
  assert.equal(selectReclaim(ctx).offer, true);
  assert.equal(selectPoll(ctx).active, false);
  ctx = reduce(ctx, read(at(4), idle("unknown")));
  assert.equal(selectReclaim(ctx).offer, true, "unknown leaves what was known");
});

test("UX-11 / r2-7: a counter appears only for a counted unit with exact figures; the copy's bytes come from the shell", () => {
  const msg = run([read(at(0), state({ stage: "background", phase: "message-index", step: { awakeElapsedMs: 3000, unit: "messages", done: 300, total: 1200 }, overall: 0.4 }))]);
  assert.deepEqual(selectStrip(msg).counter, { unit: "messages", done: 300, total: 1200 });
  const plain = run([read(at(0), state({ stage: "background", phase: "references", overall: 0.4 }))]);
  assert.equal(selectStrip(plain).counter, null);
  const copy = run([read(at(0), blocking({ phase: "copying" }), { copy: { done: 500, total: 2000 } })], "window");
  assert.deepEqual(selectWindow(copy).counter, { unit: "bytes", done: 500, total: 2000 });
  assert.equal(selectWindow(copy).elapsedMs, null, "a counted step shows its count, not a ticking clock");
  const uncounted = selectWindow(run([read(at(0), blocking({ phase: "migrating", step: { awakeElapsedMs: 14_000, unit: "none" } }))], "window"));
  assert.equal(uncounted.elapsedMs, 14_000, "an uncounted step shows the awake time the producer measured");
});

test("an unreadable reading before anything is known shows nothing yet, and a missing first reading changes no figure", () => {
  assert.equal(selectWindow(initialContext("window")), null);
  const ctx = reduce(initialContext("window"), { type: "READ_FAILED", at: at(0) });
  assert.equal(selectWindow(ctx), null);
  assert.equal(selectDetail(initialContext("app")), null);
});

test("an unknown state from a producer that knows nothing is a view of activity, never of progress", () => {
  const ctx = run([read(at(0), unknownUpgradeState({ launch: L1, stage: "starting", complete: false, keepOpen: true }))], "window");
  const view = selectWindow(ctx);
  assert.equal(view.percent, null);
  assert.equal(view.mode, "counting");
  assert.equal(view.keepOpen, true);
});

// ---------------------------------------------------------------- lanes/upgui-review r3

test("r3-1: an unknown reading withdraws capture and recall claims and keeps a known hold", () => {
  const known = state({ stage: "background", phase: "references", overall: 0.3, held: false, capture: "on", recall: "on", storedMode: "active" });
  let ctx = run([read(at(0), known)]);
  assert.equal(selectSettingsDescription(ctx, { mode: "active" }), "active");
  ctx = reduce(ctx, read(at(1), { ...unknownUpgradeState({ launch: L1, source: "health" }), stage: "background", phase: "references" }));
  assert.equal(ctx.held, "unknown");
  assert.equal(ctx.capture, "unknown");
  assert.equal(ctx.recall, "unknown");
  assert.equal(selectSettingsDescription(ctx, { mode: "active" }), "on", "no source says capture is on any more");
  assert.equal(selectSettingsDescription(ctx, { mode: "paused" }), "paused", "a cached pause no longer says new things are noted");
  assert.equal(selectSettingsDescription(ctx, { mode: "capture" }), "on");
  // a known hold is kept through an unknown reading
  let held = run([read(at(0), state({ stage: "background", phase: "references", overall: 0.3, held: true, holdKey: "memoryStrip.hold", capture: "off", recall: "off" }))]);
  held = reduce(held, read(at(1), { ...unknownUpgradeState({ launch: L1, source: "health" }), stage: "background", phase: "references" }));
  assert.equal(held.held, true);
  assert.equal(selectStrip(held).kind, "hold");
  assert.equal(selectSettingsDescription(held, { mode: "active" }), "held");
});

test("r3-2: a different phase starts its estimate again; time awake never goes back within a phase", () => {
  const eta = (phase, ms, awake) => state({ stage: "background", phase, overall: 0.4, eta: { stable: true, ms }, step: { awakeElapsedMs: awake, unit: "none" } });
  let ctx = run([read(at(0), eta("references", 360_000, 9000)), read(at(2), eta("references", 360_000, 11_000))]);
  assert.equal(selectStrip(ctx).left, 6);
  ctx = reduce(ctx, read(at(4), eta("learning", 180_000, 9000)));
  assert.equal(selectStrip(ctx).left, null, "the first reading of another phase shows nothing left over from the last phase");
  ctx = run([read(at(0), eta("references", 360_000, 14_000))]);
  ctx = reduce(ctx, read(at(1), eta("references", 360_000, 10_000)));
  assert.equal(ctx.step.awakeElapsedMs, 14_000);
});

test("r3-5: renewed work in the same launch keeps the launch high-water; it never shows 100 and then a lower percent", () => {
  const working = (o) => state({ stage: "background", phase: "references", overall: o, complete: false });
  let ctx = run([read(at(0), working(0.81))]);
  assert.equal(selectStrip(ctx).percent, 81);
  ctx = reduce(ctx, read(at(1), state({ stage: "idle", phase: "none", complete: true, overall: 1 })));
  ctx = reduce(ctx, { type: "TICK", at: at(1) + DONE_SHOWN_MS + 1 });
  ctx = reduce(ctx, read(at(10), working(0.02)));
  const strip = selectStrip(ctx);
  assert.equal(strip.kind, "working");
  assert.ok(strip.percent === null || strip.percent >= 81, `shows ${strip.percent}`);
  // and with no completion between, the percent stays the high-water mark through a restart of the work
  let mid = run([read(at(0), working(0.81)), read(at(1), working(0.02))]);
  assert.equal(selectStrip(mid).percent, 81);
  ctx = reduce(ctx, read(at(12), working(0.95)));
  assert.equal(selectStrip(ctx).percent, null, "after a completed run the launch's mark is full: renewed work is shown as working, never as a lower percent");
});

test("r3-4: an old server that says only that work is pending shows an indeterminate strip, and stops when it says nothing is", () => {
  let ctx = reduce(initialContext("app"), { type: "MALFORMED", at: at(0), reason: "legacy", pending: true });
  const strip = selectStrip(ctx);
  assert.equal(strip.kind, "working");
  assert.equal(strip.percent, null);
  assert.equal(strip.left, null);
  assert.equal(selectPoll(ctx).active, true);
  ctx = reduce(ctx, { type: "MALFORMED", at: at(2), reason: "legacy", pending: false });
  assert.equal(selectStrip(ctx), null);
});

test("r8/r9 (Fable r7 #6, r8 #7): a long honest estimate is not late, nor is one that grew while the work moves; a stall says 'still working'", () => {
  // a large file: a steady 25-minute estimate, the work moving at every reading, for six minutes
  let ctx = initialContext("window");
  let i = 0;
  const moving = (etaMs) => { ctx = reduce(ctx, read(at(i * 10), withEta(etaMs, 9000 + i * 10_000, { overall: 0.01 + i * 0.001 }))); i++; };
  while (i <= 36) moving(25 * 60_000);
  let view = selectWindow(ctx);
  assert.equal(ctx.runAwakeMs > 4 * 60_000, true);
  assert.equal(view.etaMinutes, 25);
  assert.equal(view.slow, false, "a long estimate that holds is what was said, not longer");
  assert.equal(view.late, false);
  // the shown estimate grows while the work still moves: the new estimate is shown, and nothing is called late (r9: no wording on an estimate's rise)
  moving(40 * 60_000); moving(40 * 60_000);
  view = selectWindow(ctx);
  assert.equal(view.etaMinutes, 40);
  assert.equal(view.slow, false);
  assert.equal(view.late, false);
  // nothing moves for more than a minute: the plain still-working line, never "longer than expected ... still moving"
  const still = 9000 + i * 10_000;
  for (let k = 0; k < 8; k++) ctx = reduce(ctx, read(at(i * 10 + 10 * (k + 1)), withEta(40 * 60_000, still + k * 10_000, { overall: 0.01 + (i - 1) * 0.001 })));
  view = selectWindow(ctx);
  assert.equal(view.slow, false);
  assert.equal(view.late, true);
  assert.equal(view.etaMinutes, null, "no estimate made from movement that has stopped");
});

test("r9 (Fable r8 #7): one minute with no advance is a stall, early in a run as late in one: the estimate goes and 'still working' shows", () => {
  let ctx = initialContext("window");
  // two minutes in, a steady 25-minute estimate, the work moving at every reading
  for (let k = 0; k <= 12; k++) ctx = reduce(ctx, read(at(k * 10), withEta(25 * 60_000, 9000 + k * 10_000, { overall: 0.01 + k * 0.001 })));
  assert.equal(selectWindow(ctx).etaMinutes, 25);
  assert.equal(selectWindow(ctx).late, false);
  // then the same figures for 80 seconds: well short of four minutes of running, and already a stall
  for (let k = 1; k <= 8; k++) ctx = reduce(ctx, read(at(120 + k * 10), withEta(25 * 60_000, 9000 + 120_000 + k * 10_000, { overall: 0.01 + 12 * 0.001 })));
  assert.equal(ctx.runAwakeMs < 4 * 60_000, true);
  const view = selectWindow(ctx);
  assert.equal(view.late, true);
  assert.equal(view.etaMinutes, null);
  assert.equal(selectStrip(ctx).slow, true, "the strip's slow line is for the stall");
  // it moves again: the stall is over at once
  ctx = reduce(ctx, read(at(200), withEta(25 * 60_000, 9000 + 200_000, { overall: 0.02 })));
  assert.equal(selectWindow(ctx).late, false);
});

test("honest time left: a fixed total with a measured rate gets minutes; an open-ended step (a sliding total) gets no percent and no minutes", () => {
  const fixed = (awake) => withEta(360_000, awake, { phase: "lineage", overall: 0.94, step: { awakeElapsedMs: awake, unit: "conversations", done: 50, total: 100 } });
  let ctx = run([read(at(0), fixed(9000)), read(at(2), fixed(11_000))]);
  assert.equal(selectStrip(ctx).left, 6, "a fixed total and a steady measured rate show minutes");
  assert.equal(selectStrip(ctx).percent, 94);
  const open = (awake, done) => withEta(360_000, awake, { phase: "marker", overall: 0.94, step: { awakeElapsedMs: awake, unit: "open", done } });
  ctx = run([read(at(0), open(9000, 4000)), read(at(2), open(11_000, 6000)), read(at(4), open(13_000, 8000))], "window");
  const strip = selectStrip(ctx), view = selectWindow(ctx);
  assert.equal(strip.left, null, "no minutes, however steady the server's estimate looks");
  assert.equal(strip.percent, null, "no percent for a step whose end moves");
  assert.deepEqual(strip.counter, { unit: "open", done: 8000 });
  assert.equal(view.etaMinutes, null);
  assert.equal(view.percent, null);
  assert.equal(view.indeterminate, true);
});

test("an open-ended step carries a count and nothing else: a total or a missing count is refused", () => {
  const base = state({ stage: "background", phase: "marker", step: { awakeElapsedMs: 1000, unit: "open", done: 5 } });
  assert.equal(parseUpgradeState(base).ok, true);
  assert.equal(parseUpgradeState({ ...base, step: { awakeElapsedMs: 1000, unit: "open", done: 5, total: 9 } }).ok, false);
  assert.equal(parseUpgradeState({ ...base, step: { awakeElapsedMs: 1000, unit: "open" } }).ok, false);
  assert.equal(parseUpgradeState({ ...base, phase: "lineage" }).ok, false, "only the phase that is open-ended may say so");
});
