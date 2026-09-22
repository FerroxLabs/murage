// The supervisor decides with a clock, so it is tested with one. No Electron,
// no forking, no waiting: every case below is the exact sequence that produced
// the 53 minutes of dead app on 2026-09-22, or one of the ways a naive fix
// would have been worse than the bug.
import assert from "node:assert/strict";
import test from "node:test";

import {
  CRASH_WINDOW_MS,
  MAX_CRASHES_IN_WINDOW,
  RESTART_DELAYS_MS,
  createServerSupervisor,
} from "./server-supervisor.mjs";

/** A clock the test moves by hand. */
function at(start = 1_000_000) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; return value; } };
}

test("the crash that cost the owner an hour now costs a blink", () => {
  const clock = at();
  const supervisor = createServerSupervisor({ now: clock.now });
  // exit code 1, unhandled WebSocket 'error' from the preview timer
  const decision = supervisor.decide({ code: 1 });
  assert.equal(decision.action, "restart");
  assert.equal(decision.attempt, 1);
  assert.equal(decision.delayMs, RESTART_DELAYS_MS[0]);
});

test("a clean exit is a decision and is never argued with", () => {
  const supervisor = createServerSupervisor({ now: at().now });
  assert.deepEqual(supervisor.decide({ code: 0 }), { action: "stay-down", reason: "clean-exit" });
});

test("an intentional shutdown stays down even when the code is not zero", () => {
  const supervisor = createServerSupervisor({ now: at().now });
  // Quit, relaunch and port handover all kill the child without ceremony; a
  // supervisor that restarts here fights the quit button.
  const decision = supervisor.decide({ code: 143, intentional: true });
  assert.deepEqual(decision, { action: "stay-down", reason: "intentional" });
});

test("the gaps widen, so a recurring fault cannot become a spin", () => {
  const clock = at();
  const supervisor = createServerSupervisor({ now: clock.now });
  const delays = [];
  for (let i = 0; i < MAX_CRASHES_IN_WINDOW; i++) {
    const decision = supervisor.decide({ code: 1 });
    assert.equal(decision.action, "restart");
    delays.push(decision.delayMs);
    clock.advance(1_000);
  }
  assert.deepEqual(delays, RESTART_DELAYS_MS.slice(0, MAX_CRASHES_IN_WINDOW));
  for (let i = 1; i < delays.length; i++) assert.ok(delays[i] > delays[i - 1], "each gap must be wider");
});

test("it gives up rather than restarting for ever", () => {
  const clock = at();
  const supervisor = createServerSupervisor({ now: clock.now });
  for (let i = 0; i < MAX_CRASHES_IN_WINDOW; i++) { supervisor.decide({ code: 1 }); clock.advance(1_000); }
  assert.equal(supervisor.exhausted(), false);
  const decision = supervisor.decide({ code: 1 });
  assert.equal(decision.action, "give-up");
  assert.equal(decision.reason, "crash-loop");
  assert.equal(supervisor.exhausted(), true);
});

test("crashes that are hours apart are not a loop", () => {
  const clock = at();
  const supervisor = createServerSupervisor({ now: clock.now });
  // The owner's real history: one crash, then nothing for the rest of the day.
  // A guard that counted these together would refuse to restart an app that
  // had been healthy since breakfast.
  for (let i = 0; i < MAX_CRASHES_IN_WINDOW + 3; i++) {
    const decision = supervisor.decide({ code: 1 });
    assert.equal(decision.action, "restart", "a lone crash always earns a replacement");
    assert.equal(decision.attempt, 1, "nothing is held against it from an hour ago");
    clock.advance(CRASH_WINDOW_MS + 1);
  }
  assert.equal(supervisor.exhausted(), false);
});

test("a child that proves itself clears its predecessors", () => {
  const clock = at();
  const supervisor = createServerSupervisor({ now: clock.now });
  supervisor.decide({ code: 1 });
  supervisor.decide({ code: 1 });
  assert.equal(supervisor.recentCrashes(), 2);
  clock.advance(CRASH_WINDOW_MS + 1);
  supervisor.settled();
  assert.equal(supervisor.recentCrashes(), 0);
  assert.equal(supervisor.decide({ code: 1 }).attempt, 1);
});

test("null and undefined exit codes are crashes, not clean exits", () => {
  // A child killed by a signal reports a null code. Treating that as "it meant
  // it" is how a supervisor sleeps through the failure it exists for.
  for (const code of [null, undefined]) {
    const supervisor = createServerSupervisor({ now: at().now });
    assert.equal(supervisor.decide({ code }).action, "restart", `code ${String(code)} must restart`);
  }
});
