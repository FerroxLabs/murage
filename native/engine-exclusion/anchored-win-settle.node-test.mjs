// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CONTRACTS-B 1.5 (rev 6) validation of the Windows anchored-open helper's end/settle lifecycle, by exact counters, the CRT debug heap and an
// injected turn gate (R25'): the twenty schedule cases, the gate guard and recovery, T2, T2b, T3, T4, T5, T6' and the soak. Needs the
// test-hooks build (dist-native/engine-exclusion-test, debug CRT, never packaged). Run: node --expose-gc --test <this file>
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const onWindows = process.platform === "win32";
const testFile = path.join(root, "dist-native", "engine-exclusion-test", `win32-${process.arch}`, "engine-exclusion.node");
const PLAIN = "Could not read Claude Code files.";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let hooks = null;
if (onWindows) { try { hooks = require(testFile); } catch { hooks = null; } }
if (hooks) hooks.anchorTestDropPrivileges();
const skip = !onWindows ? "not windows" : hooks ? false : process.env.CI ? false : "no test-hooks build here";
const stats = () => hooks.anchorTestStats();
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const dirs = [];
function temp() {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "anchor-s-")));
  dirs.push(dir);
  return dir;
}
test.after(() => { for (const dir of dirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } });
function layout() {
  const home = temp();
  mkdirSync(path.join(home, ".claude", "skills", "Alpha"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "skills", "Alpha", "SKILL.md"), "alpha body");
  return { home };
}
function code(fn) {
  try { fn(); } catch (error) { assert.equal(error.message, PLAIN); return error.code; }
  return "none";
}
/** Rounds of gc until every lifetime counter is zero; ASSERTS that it got there in time (failing with the last stats). */
async function collect(deadlineMs = 5000) {
  const end = Date.now() + deadlineMs;
  let last;
  for (;;) {
    global.gc(); await new Promise((r) => setImmediate(r)); await wait(10);
    last = stats();
    if (last.sessions === 0 && last.entries === 0 && last.requests === 0) return;
    if (Date.now() > end) assert.fail(`collect: counters did not reach zero: ${JSON.stringify(last)}`);
  }
}
const eventName = (tag) => `Local\\anchor-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
function heapClean(label) {
  const heap = hooks.anchorTestHeapCheck();
  assert.equal(heap.valid, true, `${label}: heap valid`);
  assert.equal(heap.blocks, 0, `${label}: no live block since the mark (${heap.bytes} bytes)`);
}
/** Invariant on every observed true (T6'c): the three counters read in the same synchronous turn. */
function endedTrue(s) {
  const ended = hooks.anchorEnd(s);
  const st = stats();
  assert.equal(ended, true, "anchorEnd reports settled");
  assert.equal(st.fileHandles, 0, "fileHandles");
  assert.equal(st.activeWorkers, 0, "activeWorkers");
  assert.equal(st.slot, 0, "slot");
}

// ---- the twenty schedule cases ------------------------------------------------------------------------------------------------------
const OK = "entry";
// [name, order, success outcome, success [late, abandoned], failure outcome, failure [late, abandoned]]
const CASES = [
  ["S-a", "W1,W2,W3,J1", OK, [0, 0], "F", [0, 0]],
  ["S-b", "W1,J1,W2,W3,J2", OK, [1, 0], "F", [1, 0]],
  ["S-b2", "W1,J1,W2,J2,W3", OK, [1, 0], "F", [1, 0]],
  ["S-b3", "W1,W2,J1,W3,J2", OK, [1, 0], "F", [1, 0]],
  ["S-b4", "W1,W2,J1,J2,W3", OK, [1, 0], "F", [1, 0]],
  ["S-e", "J1,W1,W2,W3,J2", OK, [1, 0], "F", [1, 0]],
  ["S-e2", "J1,W1,W2,J2,W3", OK, [1, 0], "F", [1, 0]],
  ["S-c", "W1,J1,J2,W2", "ETIMEDOUT", [0, 1], "ETIMEDOUT", [0, 0]],
  ["S-d", "J1,J2,W1,W2", "ETIMEDOUT", [0, 0], "ETIMEDOUT", [0, 0]],
  ["S-f", "J1,W1,J2,W2", "ETIMEDOUT", [0, 1], "ETIMEDOUT", [0, 0]],
];
for (const [name, order, successOutcome, successDeltas, failureOutcome, failureDeltas] of CASES) {
  for (const op of ["success", "failure"]) {
    test(`schedule ${name} ${order} (${op})`, { skip }, async () => {
      const { home } = layout();
      const expected = op === "success" ? successOutcome : failureOutcome;
      const deltas = op === "success" ? successDeltas : failureDeltas;
      await collect();
      hooks.anchorTestHeapMark();
      let s = hooks.anchorBegin(home, 5000);
      const child = op === "success" ? ".claude" : "missing-child";
      let F = null;
      if (op === "failure") { F = code(() => hooks.anchorOpen(s, child, "dir")); assert.equal(F, "ENOENT", "the unscheduled control call"); }
      const before = stats();
      hooks.anchorTestSchedule(s, order);
      let entry = null, got = "entry";
      try { entry = hooks.anchorOpen(s, child, "dir"); } catch (error) { assert.equal(error.message, PLAIN); got = error.code; }
      const want = expected === "F" ? F : expected;
      assert.equal(got, want, `the call result of ${name}/${op} is exactly ${want}`);
      // healthy / poisoned follow-up BEFORE any end (ending makes later calls EBADF)
      if (got === "entry") assert.ok(hooks.anchorList(entry.handle), "an Entry outcome is not poisoned");
      else if (got === "ETIMEDOUT") assert.equal(code(() => hooks.anchorStat(s)), "ETIMEDOUT", "an ETIMEDOUT outcome poisoned the session (R22a)");
      else assert.ok(hooks.anchorStat(s), "a late-consumed failure does not poison");
      hooks.anchorEnd(s);
      assert.equal(hooks.anchorTestWaitSettled(s, 5000), true, "settled");
      const after = stats();
      assert.equal(after.schedSteps, order.split(",").length, "every listed step ran");
      assert.equal(after.schedBroken, 0, "the listed order is the order that ran");
      endedTrue(s);
      assert.equal(after.lateConsumed - before.lateConsumed, deltas[0], "lateConsumed delta");
      assert.equal(after.abandonedClosed - before.abandonedClosed, deltas[1], "abandonedClosed delta");
      entry = null; s = null;
      await collect();
      heapClean(name);
      const claude = path.join(home, ".claude");
      renameSync(claude, `${claude}2`);
      renameSync(`${claude}2`, claude);
    });
  }
}

test("gate guard: an impossible order breaks the gate, the call still ends, and a fresh session runs S-a's exact oracle", { skip, timeout: 60000 }, async () => {
  const { home } = layout();
  await collect();
  let s = hooks.anchorBegin(home, 5000);
  hooks.anchorTestSchedule(s, "W1,J2,J1,W2");
  const got = code(() => { const e = hooks.anchorOpen(s, ".claude", "dir"); assert.ok(e.handle); });
  assert.ok(got === "none" || got === "ETIMEDOUT", `Entry or ETIMEDOUT, got ${got}`);
  hooks.anchorEnd(s);
  assert.equal(hooks.anchorTestWaitSettled(s, 5000), true);
  assert.equal(stats().schedBroken, 1, "the gate broke");
  assert.equal(stats().fileHandles, 0);
  s = null;
  await collect();
  const fresh = hooks.anchorBegin(home, 5000);
  hooks.anchorTestSchedule(fresh, "W1,W2,W3,J1");   // re-arming before any request was posted replaces the earlier arm
  hooks.anchorTestSchedule(fresh, "W1,W2,W3,J1");
  const entry = hooks.anchorOpen(fresh, ".claude", "dir");
  assert.ok(entry.handle);
  hooks.anchorEnd(fresh);
  assert.equal(hooks.anchorTestWaitSettled(fresh, 5000), true);
  assert.equal(stats().schedBroken, 0);
  assert.equal(stats().schedSteps, 4);
  endedTrue(fresh);
});

// ---- T2, T2b, T3 ---------------------------------------------------------------------------------------------------------------------
test("T2 retained Session through timeout, worker exit, repeated end, GC", { skip }, async () => {
  const { home } = layout();
  await collect();
  hooks.anchorTestHeapMark();
  let s = hooks.anchorBegin(home, 5000);
  let e = hooks.anchorOpen(s, ".claude", "dir");
  const ev = eventName("t2");
  hooks.anchorTestStall(ev);
  hooks.anchorTestDeadlineAtPost(50);
  try {
    assert.equal(code(() => hooks.anchorOpen(e.handle, "skills", "dir")), "ETIMEDOUT");
    assert.equal(stats().activeWorkers, 1, "the stalled worker has not cleaned up");
    const claude = path.join(home, ".claude");
    let pinned = false;
    try { renameSync(claude, `${claude}2`); renameSync(`${claude}2`, claude); } catch (error) { pinned = ["EBUSY", "EPERM", "EACCES"].includes(error.code); }
    assert.ok(pinned, "the pin is real");
  } finally { hooks.anchorTestRelease(ev); }
  hooks.anchorEnd(s);
  assert.equal(hooks.anchorTestWaitSettled(s, 5000), true);
  endedTrue(s);
  for (let i = 0; i < 5; i++) endedTrue(s);
  for (let i = 0; i < 3; i++) hooks.anchorClose(e.handle);
  assert.equal(code(() => hooks.anchorOpen(e.handle, "skills", "dir")), "EBADF");
  renameSync(path.join(home, ".claude"), path.join(home, ".claude2"));
  renameSync(path.join(home, ".claude2"), path.join(home, ".claude"));
  s = null; e = null;
  await collect();
  heapClean("T2");
});

test("T2b healthy, finalizer-driven cleanup", { skip }, async () => {
  const { home } = layout();
  await collect();
  hooks.anchorTestHeapMark();
  const before = stats().sessionExternalsFinalized;
  let e;
  (() => { const s = hooks.anchorBegin(home, 5000); e = hooks.anchorOpen(s, ".claude", "dir"); })();
  const until = Date.now() + 5000;
  while (stats().sessionExternalsFinalized === before && Date.now() < until) { global.gc(); await new Promise((r) => setImmediate(r)); await wait(10); }
  assert.equal(stats().sessionExternalsFinalized, before + 1, "the Session external was finalized");
  assert.equal(stats().sessions, 1, "the surviving Entry keeps the Session struct alive");
  assert.equal(stats().entries, 1);
  const done = Date.now() + 5000;
  while ((stats().activeWorkers !== 0 || stats().fileHandles !== 0) && Date.now() < done) await wait(10);
  assert.equal(stats().activeWorkers, 0);
  assert.equal(stats().fileHandles, 0);
  renameSync(path.join(home, ".claude"), path.join(home, ".claude2"));
  renameSync(path.join(home, ".claude2"), path.join(home, ".claude"));
  assert.equal(code(() => hooks.anchorOpen(e.handle, "skills", "dir")), "EBADF");
  for (let i = 0; i < 3; i++) hooks.anchorClose(e.handle);
  e = null;
  await collect();
  heapClean("T2b");
});

test("T3 handle count then rename, with no anchorEnd", { skip }, async () => {
  const { home } = layout();
  await collect();
  let s = hooks.anchorBegin(home, 5000);
  let a = hooks.anchorOpen(s, ".claude", "dir");
  let b = hooks.anchorOpen(a.handle, "skills", "dir");
  const ev = eventName("t3");
  hooks.anchorTestStall(ev);
  hooks.anchorTestDeadlineAtPost(60);
  let fired = false;
  setTimeout(() => { fired = true; }, 0);
  const t0 = process.hrtime.bigint();
  try {
    assert.equal(code(() => hooks.anchorOpen(b.handle, "Alpha", "dir")), "ETIMEDOUT");
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 60 + 250, `returned within 60 + 250 ms, took ${ms}`);
    await wait(5);
    assert.equal(fired, true, "a timer scheduled before the call fires right after");
    const skills = path.join(home, ".claude", "skills");
    let pinned = false;
    try { renameSync(skills, `${skills}2`); renameSync(`${skills}2`, skills); } catch (error) { pinned = ["EBUSY", "EPERM", "EACCES"].includes(error.code); }
    assert.ok(pinned, "pinned while stalled");
    assert.equal(code(() => hooks.anchorBegin(home, 300)), "EBUSY", "one stalled worker per process (R21)");
  } finally { hooks.anchorTestRelease(ev); }
  const until = Date.now() + 5000;
  while ((stats().fileHandles !== 0 || stats().activeWorkers !== 0) && Date.now() < until) await wait(25);
  assert.equal(stats().fileHandles, 0);
  assert.equal(stats().activeWorkers, 0);
  s = null; a = null; b = null;
  await collect();
  const skills = path.join(home, ".claude", "skills");
  renameSync(skills, `${skills}2`);
  renameSync(`${skills}2`, skills);
});

// ---- T5 begin releases deterministically ---------------------------------------------------------------------------------------------
for (const kind of ["tag", "create", "beginalloc", "thread", "device"]) {
  test(`T5 begin forced to fail (${kind}) has released the home before it throws`, { skip }, async () => {
    const { home } = layout();
    await collect();
    hooks.anchorTestHeapMark();
    const ev = eventName("t5");
    hooks.anchorTestStallExit(ev);   // the exiting worker parks before its final close-all, so only cleanup done before the throw counts
    hooks.anchorTestFail(kind);
    try {
      assert.equal(code(() => hooks.anchorBegin(home, 5000)), "EIO");
      renameSync(home, `${home}-moved`);   // the behavioural oracle: first, at once
      renameSync(`${home}-moved`, home);
      assert.equal(stats().fileHandles, 0);
    } finally { hooks.anchorTestRelease(ev); }
    const until = Date.now() + 5000;
    while ((stats().activeWorkers !== 0 || stats().slot !== 0) && Date.now() < until) await wait(10);
    assert.equal(stats().activeWorkers, 0);
    assert.equal(stats().slot, 0);
    (() => {
      const next = hooks.anchorBegin(home, 5000);   // first time, no retry
      hooks.anchorEnd(next);
      assert.equal(hooks.anchorTestWaitSettled(next, 5000), true);
      endedTrue(next);
    })();
    await collect();
    heapClean(`T5 ${kind}`);
  });
}
test("T5c Entry tag failure ends cleanly", { skip }, async () => {
  const { home } = layout();
  await collect();
  hooks.anchorTestHeapMark();
  let s = hooks.anchorBegin(home, 5000);
  hooks.anchorTestFail("tag");
  assert.equal(code(() => hooks.anchorOpen(s, ".claude", "dir")), "EIO");
  hooks.anchorEnd(s);
  assert.equal(hooks.anchorTestWaitSettled(s, 5000), true);
  endedTrue(s);
  renameSync(path.join(home, ".claude"), path.join(home, ".claude2"));
  renameSync(path.join(home, ".claude2"), path.join(home, ".claude"));
  s = null;
  await collect();
  heapClean("T5c");
});

// ---- T6' settle ----------------------------------------------------------------------------------------------------------------------
test("T6' (a) healthy: settled, folders released at once, the next begin succeeds first time", { skip }, async () => {
  const { home } = layout();
  mkdirSync(path.join(home, "emptied"));
  await collect();
  (() => {
    const s = hooks.anchorBegin(home, 5000);
    const claude = hooks.anchorOpen(s, ".claude", "dir");
    hooks.anchorOpen(claude.handle, "skills", "dir");
    hooks.anchorOpen(s, "emptied", "dir");
    hooks.anchorEnd(s);
    assert.equal(hooks.anchorTestWaitSettled(s, 5000), true);
    endedTrue(s);
    const skills = path.join(home, ".claude", "skills");
    renameSync(skills, `${skills}2`); renameSync(`${skills}2`, skills);
    renameSync(path.join(home, ".claude"), path.join(home, ".claude2")); renameSync(path.join(home, ".claude2"), path.join(home, ".claude"));
    rmdirSync(path.join(home, "emptied"));
    const next = hooks.anchorBegin(home, 5000);
    hooks.anchorEnd(next);
    assert.equal(hooks.anchorTestWaitSettled(next, 5000), true);
  })();
  await collect();
});
test("T6' (b) not settled is reported, not waited for", { skip }, async () => {
  const { home } = layout();
  await collect();
  const ev = eventName("t6b");
  hooks.anchorTestStallExit(ev);
  let s = hooks.anchorBegin(home, 5000);
  hooks.anchorOpen(s, ".claude", "dir");
  try {
    for (let i = 0; i < 2; i++) {
      const t0 = process.hrtime.bigint();
      assert.equal(hooks.anchorEnd(s), false, `anchorEnd #${i + 1} while held`);
      assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 400, "returns in under 400 ms");
    }
    assert.ok(stats().fileHandles > 0);
    assert.equal(stats().activeWorkers, 1);
  } finally { hooks.anchorTestRelease(ev); }
  assert.equal(hooks.anchorTestWaitSettled(s, 5000), true);
  endedTrue(s);
  renameSync(path.join(home, ".claude"), path.join(home, ".claude2"));
  renameSync(path.join(home, ".claude2"), path.join(home, ".claude"));
  s = null;
  await collect();
});
test("T6' (b2) with a stall held inside W1 the Session lock is never held across the blocked call", { skip }, async () => {
  const { home } = layout();
  await collect();
  let s = hooks.anchorBegin(home, 5000);
  const ev = eventName("t6b2");
  hooks.anchorTestStall(ev);
  hooks.anchorTestDeadlineAtPost(50);
  try {
    assert.equal(code(() => hooks.anchorOpen(s, ".claude", "dir")), "ETIMEDOUT");
    const t0 = process.hrtime.bigint();
    assert.equal(hooks.anchorEnd(s), false);
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 400, "returns in under 400 ms");
  } finally { hooks.anchorTestRelease(ev); }
  assert.equal(hooks.anchorTestWaitSettled(s, 5000), true);
  endedTrue(s);
  s = null;
  await collect();
});

// ---- soak (a regression guard, NOT an ordering oracle) -------------------------------------------------------------------------------
test("soak: 200 begin/open/end cycles at a 20 ms deadline", { skip, timeout: 300000 }, async () => {
  const { home } = layout();
  await collect();
  hooks.anchorTestHeapMark();
  for (let i = 0; i < 200; i++) {
    let s = hooks.anchorBegin(home, 5000);
    hooks.anchorTestDeadlineAtPost(20);
    const outcome = code(() => hooks.anchorOpen(s, ".claude", "dir"));
    assert.ok(outcome === "none" || outcome === "ETIMEDOUT", `iteration ${i}: ${outcome}`);
    hooks.anchorEnd(s);
    assert.equal(hooks.anchorTestWaitSettled(s, 5000), true, `iteration ${i} settled`);
    endedTrue(s);
    s = null;
    if (i % 50 === 49) await collect();
  }
  await collect();
  heapClean("soak");
});

// ---- T4 the CRT debug heap is live and clean (the LAST tests in the file) -------------------------------------------------------------
for (const kind of ["double-free", "write-after-free"]) {
  test(`T4a positive control: ${kind} ends the process with exit 86`, { skip, timeout: 60000 }, () => {
    const result = spawnSync(process.execPath, [path.join(here, "test", "heap-canary.mjs"), kind], { env: { ...process.env, MURAGE_ENGINE_EXCLUSION_PATH: testFile }, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 86, `status ${result.status} signal ${result.signal} stderr ${result.stderr}`);
    assert.match(result.stderr, /ANCHOR-CRT-HEAP/);
  });
}
test("T4b no live block allocated in anchored-win.c, and the heap is valid (keep this LAST)", { skip }, async () => {
  await collect();
  assert.equal(hooks.anchorTestHeapLeaks(), 0);
  assert.equal(hooks.anchorTestHeapCheck().valid, true);
});
void sleepSync;
