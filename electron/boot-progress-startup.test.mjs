// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 startup-all (fablehunt-1020q #4, sweep-B B-3): every step before listen outside a memory-upgrade note was stopped at the shell's
// 5-minute limit and started over at the next launch. The server now keeps its own start-up note moving from its first module to listen
// (server/boot-progress.ts); the shell waits while that note is its child's and moving. Here a real child process holds its server thread
// in one long statement while the real heartbeat thread writes the real note, and the shell's real watcher and probe look at it on a fake
// clock that each probe sleep moves by 5 s.
// 1.0.20 bootwait (hunt-fable-1119 FINDINGS-2 #2): the heartbeat thread rewrites the note every 2 s whatever the server thread does, so a
// rewrite proves the child is alive, never that it gets anywhere. The wait goes past 5 minutes only while a real step advances (the step
// name or its sequence number changes); a child alive but held in one step for 5 minutes gets the recovery window, as 1.0.19 did. The
// earlier "held 6 minutes in one step reaches ready" case asserted that regression and is replaced by the heartbeat-only case below.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { BOOT_PROGRESS_FILE, BOOT_PROGRESS_FRESH_MS, readBootProgress, watchBootProgress } from "./boot-progress-watch.mjs";
import { BOOT_EXTEND_ABSOLUTE_MS } from "./server-boot-probe.mjs";
import { launchOf, pollServerIdentity } from "./signed-fetch.test.mjs";
import { interruptedBootStep } from "../server/boot-progress.ts";

const MIN = 60_000, LIMIT_MS = 5 * MIN;
const realDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const refused = async () => { throw new Error("connection refused"); };
const answer = (pid) => async () => ({ ok: true, status: 200, json: async () => ({ app: "murage", pid, launch: launchOf("n7"), static: true }) });

/** A child that starts the real note and then holds its only thread in one statement (Atomics.wait), as a CREATE INDEX, a log replay or a
 * table drop holds the server thread before listen. Its heartbeat is quick so this test's fake minutes see it move. */
async function blockedChild(dir) {
  const script = join(dir, "child.mjs");
  writeFileSync(script, `import { startBootProgress } from ${JSON.stringify(new URL("../server/boot-progress.ts", import.meta.url).href)};
startBootProgress(process.argv[2], { intervalMs: 20, step: "database.memory" });
console.log("beating");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`);
  const child = spawn(process.execPath, [script, dir], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("beating")) resolve(); });
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  return { child, closed, stop: async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; } };
}

/** A child that starts the real note and moves to the next real step (setBootStep) each time the test asks, as a long start does between
 * its tables, recoveries and boot steps. `step(name)` returns once the real heartbeat has written that step into the note. */
async function steppingChild(dir) {
  const script = join(dir, "stepper.mjs");
  writeFileSync(script, `import { setBootStep, startBootProgress } from ${JSON.stringify(new URL("../server/boot-progress.ts", import.meta.url).href)};
startBootProgress(process.argv[2], { intervalMs: 20, step: "database.wal" });
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { for (const line of chunk.split("\\n")) if (line) setBootStep(line); });
console.log("beating");
`);
  const child = spawn(process.execPath, [script, dir], { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("beating")) resolve(); });
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const step = async (name) => {
    child.stdin.write(`${name}\n`);
    for (let i = 0; i < 250; i += 1) { if (readBootProgress(dir, { pid: child.pid })?.step === name) return; await realDelay(20); }
    throw new Error(`the note never showed step ${name}`);
  };
  return { child, closed, step, stop: async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; } };
}

/** The shell's wait for one child as main.mjs runs it: the watcher on the note, the probe with the closure main.mjs passes. */
async function shellWait({ dir, pid, readyAt = Infinity, onClock = async () => {} }) {
  let clock = 0;
  const watch = watchBootProgress({ dataDir: dir, pid: () => pid, now: () => clock, setTimer: () => ({}), clearTimer: () => {} });
  watch.tick();
  const result = await pollServerIdentity({
    port: 1, nonce: () => "n7", bootTimeoutMs: LIMIT_MS, now: () => clock,
    sleep: async () => { clock += 5_000; await onClock(clock); await realDelay(30); watch.tick(); },
    fetchImpl: () => (clock >= readyAt ? answer(pid)() : refused()),
    bootProgressFresh: () => watch.fresh(),
  });
  return { outcome: result.outcome, at: clock };
}

test("a child alive but held in one step (only its heartbeat rewrites the note) gets the recovery window at the 5-minute limit, as on 1.0.19", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-progress-"));
  const run = await blockedChild(dir);
  try {
    const end = await shellWait({ dir, pid: run.child.pid, readyAt: 6 * MIN });
    assert.equal(end.outcome, "timeout");
    assert.ok(end.at >= LIMIT_MS && end.at <= LIMIT_MS + 10_000, `ended at ${end.at}`);
    // the heartbeat was beating the whole time: the note was this child's and fresh when the wait ended
    assert.equal(readBootProgress(dir, { pid: run.child.pid })?.step, "database.memory");
  } finally { await run.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("a long start whose steps keep advancing is waited on past 5 minutes and reaches ready (20 minutes, a step every 4)", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-progress-"));
  const run = await steppingChild(dir);
  try {
    let next = 4 * MIN, n = 0;
    const end = await shellWait({ dir, pid: run.child.pid, readyAt: 20 * MIN, onClock: async (clock) => { if (clock >= next) { next += 4 * MIN; n += 1; await run.step(`recover.step${n}`); } } });
    assert.equal(end.outcome, "ready");
    assert.ok(end.at >= 20 * MIN, `ready at ${end.at}`);
  } finally { await run.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("steps that advance and then stop (the child alive, its heartbeat beating) get the recovery window 5 minutes after the last step", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-progress-"));
  const run = await steppingChild(dir);
  try {
    const lastStepAt = 12 * MIN;
    let next = 3 * MIN, n = 0;
    const end = await shellWait({ dir, pid: run.child.pid, onClock: async (clock) => { if (clock >= next && clock <= lastStepAt) { next += 3 * MIN; n += 1; await run.step(`recover.step${n}`); } } });
    assert.equal(end.outcome, "timeout");
    assert.ok(end.at >= lastStepAt + LIMIT_MS && end.at <= lastStepAt + LIMIT_MS + 10_000, `ended at ${end.at}`);
  } finally { await run.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("a note that is not this child's (an earlier launch's, or another process) buys no time: the 5-minute limit holds", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-progress-"));
  const run = await blockedChild(dir);
  try {
    const end = await shellWait({ dir, pid: run.child.pid + 1, readyAt: 6 * MIN });
    assert.equal(end.outcome, "timeout");
    assert.ok(end.at >= LIMIT_MS && end.at < LIMIT_MS + MIN, `ended at ${end.at}`);
  } finally { await run.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("a child that dies mid-start stops its note: the wait ends about a minute later, and the next start knows the step it ended in", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-progress-"));
  const run = await steppingChild(dir);
  try {
    // it advances a step every 3 minutes (so the wait goes on past 5) and is killed at 8, in its third step, 2 minutes after it began
    const diesAt = 8 * MIN;
    let killed = false, next = 3 * MIN, n = 0;
    const end = await shellWait({ dir, pid: run.child.pid, onClock: async (clock) => {
      if (clock >= next && clock < diesAt) { next += 3 * MIN; n += 1; await run.step(n === 2 ? "database.memory" : `recover.step${n}`); }
      if (clock >= diesAt && !killed) { killed = true; await run.stop(); }
    } });
    assert.equal(end.outcome, "timeout");
    assert.ok(end.at >= diesAt + BOOT_PROGRESS_FRESH_MS && end.at <= diesAt + BOOT_PROGRESS_FRESH_MS + 2 * MIN, `ended at ${end.at}`);
    // the note the dead child left: the next start (another pid) reads which step it was in
    assert.equal(interruptedBootStep(dir), "database.memory");
  } finally { await run.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("never endless: a note whose steps advance forever is waited on only to the absolute limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-progress-"));
  try {
    let clock = 0;
    const PID = 4242;
    // every rewrite a new step: the strongest "progress" a note can show still ends at the absolute limit
    const note = () => writeFileSync(join(dir, BOOT_PROGRESS_FILE), JSON.stringify({ v: 1, state: "starting", pid: PID, startedAt: 0, updatedAt: clock, step: "recover.step", seq: 1 + clock / 5_000 }));
    note();
    const watch = watchBootProgress({ dataDir: dir, pid: PID, now: () => clock, setTimer: () => ({}), clearTimer: () => {} });
    watch.tick();
    const result = await pollServerIdentity({
      port: 1, nonce: () => "n7", bootTimeoutMs: LIMIT_MS, now: () => clock,
      sleep: async () => { clock += 5_000; note(); watch.tick(); },
      fetchImpl: refused, bootProgressFresh: () => watch.fresh(),
    });
    assert.equal(result.outcome, "timeout");
    assert.ok(clock >= BOOT_EXTEND_ABSOLUTE_MS && clock <= BOOT_EXTEND_ABSOLUTE_MS + MIN, `ended at ${clock}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
