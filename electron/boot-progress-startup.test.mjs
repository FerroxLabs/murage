// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 startup-all (fablehunt-1020q #4, sweep-B B-3): every step before listen outside a memory-upgrade note was stopped at the shell's
// 5-minute limit and started over at the next launch. The server now keeps its own start-up note moving from its first module to listen
// (server/boot-progress.ts); the shell waits while that note is its child's and moving. Here a real child process holds its server thread
// in one long statement while the real heartbeat thread writes the real note, and the shell's real watcher and probe look at it on a fake
// clock that each probe sleep moves by 5 s.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { BOOT_PROGRESS_FILE, BOOT_PROGRESS_FRESH_MS, watchBootProgress } from "./boot-progress-watch.mjs";
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

test("a start held 6 minutes in one step before listen, its note moving, reaches ready: no stop at the 5-minute limit", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-progress-"));
  const run = await blockedChild(dir);
  try {
    const end = await shellWait({ dir, pid: run.child.pid, readyAt: 6 * MIN });
    assert.equal(end.outcome, "ready");
    assert.ok(end.at >= 6 * MIN, `ready at ${end.at}`);
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

test("a child that dies mid-step stops its note: the wait ends about a minute later, and the next start knows the step it ended in", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-progress-"));
  const run = await blockedChild(dir);
  try {
    const diesAt = 8 * MIN;
    let killed = false;
    const end = await shellWait({ dir, pid: run.child.pid, onClock: async (clock) => { if (clock >= diesAt && !killed) { killed = true; await run.stop(); } } });
    assert.equal(end.outcome, "timeout");
    assert.ok(end.at >= diesAt + BOOT_PROGRESS_FRESH_MS && end.at <= diesAt + BOOT_PROGRESS_FRESH_MS + 2 * MIN, `ended at ${end.at}`);
    // the note the dead child left: the next start (another pid) reads which step it was in
    assert.equal(interruptedBootStep(dir), "database.memory");
  } finally { await run.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("never endless: a note that moves forever is waited on only to the absolute limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-progress-"));
  try {
    let clock = 0;
    const PID = 4242;
    const note = () => writeFileSync(join(dir, BOOT_PROGRESS_FILE), JSON.stringify({ v: 1, state: "starting", pid: PID, startedAt: 0, updatedAt: clock, step: "database.memory", seq: 1 }));
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
