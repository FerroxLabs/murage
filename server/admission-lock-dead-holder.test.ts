// SPDX-License-Identifier: AGPL-3.0-or-later
// WAL-ADMISSION-HANG r2 (MC63 design D1-D3). A lock is never taken over by time: it is recovered only after the main thread has
// confirmed the holder's exit, and only if the word still holds that thread's token. One total deadline bounds every lock() call
// (AdmissionLockTimeout, callers fail closed). Recovery poisons the ledger instead of trusting half-updated counters.
// Every contender runs in its own worker so that a hang is caught by the test timeout instead of freezing this process.
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { checkpointLedger } from "./admission-shared.ts";

const prelude = `const { parentPort, workerData, threadId } = require("node:worker_threads");
const make = (0, eval)("(" + workerData.src + ")");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ledger = make(workerData.buf, threadId, workerData.deadline ?? 2000);
`;
const start = (buf: SharedArrayBuffer, body: string, deadline?: number, extra: Record<string, unknown> = {}) =>
  new Worker(prelude + body, { eval: true, workerData: { buf, src: checkpointLedger.toString(), deadline, ...extra } });
const next = <T>(worker: Worker, ms: number, what: string) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms (stuck in lock())`)), ms);
  worker.once("message", (m: T) => { clearTimeout(timer); resolve(m); });
  worker.once("error", error => { clearTimeout(timer); reject(error); });
});
/** Like next(), but a worker that never answers is a value ("stuck"), so the test fails by its own assertion, not by a rejection of a watchdog. */
const answerOrStuck = <T>(worker: Worker, ms: number) => new Promise<T | "stuck">((resolve, reject) => {
  const timer = setTimeout(() => resolve("stuck"), ms);
  worker.once("message", (m: T) => { clearTimeout(timer); resolve(m); });
  worker.once("error", error => { clearTimeout(timer); reject(error); });
});
const newBuffer = () => new SharedArrayBuffer(32 * BigInt64Array.BYTES_PER_ELEMENT);
const word = (buf: SharedArrayBuffer, n: number) => new BigInt64Array(buf)[n]!;
/** Answers what a beginCopy/endCopy cycle does once told to: "admitted", "refused" or the name of the error it threw, with the time it took. */
const PROBER = `parentPort.once("message", () => { const t0 = performance.now(); let r;
  try { const t = ledger.beginCopy(1024, Date.now()); if (t) ledger.endCopy(t, 0); r = t ? "admitted" : "refused"; } catch (e) { r = e.name; }
  parentPort.postMessage({ r, ms: performance.now() - t0 }); });`;
const probe = async (buf: SharedArrayBuffer, deadline: number) => {
  const prober = start(buf, PROBER, deadline);
  try { prober.postMessage("go"); return await next<{ r: string; ms: number }>(prober, 10_000, "prober"); } finally { await prober.terminate(); }
};
// The holder takes the lock and never lets go.
const HOLDER = `ledger.lock(); parentPort.postMessage(threadId); for (;;) {}`;
async function holderKilled(buf: SharedArrayBuffer) {
  const holder = start(buf, HOLDER);
  const id = await next<number>(holder, 10_000, "holder");
  await holder.terminate();
  return id;
}

it("T1 a paused live holder is never taken over: the contender times out, the holder resumes and unlocks cleanly, totals intact", { timeout: 30_000 }, async () => {
  const buf = newBuffer();
  // The holder keeps the lock for 1.2 s (far past the old quarter-second stale bound and the contender's 300 ms deadline), writes while it still owns it, then unlocks.
  const holder = start(buf, `ledger.lock(); parentPort.postMessage(threadId); sleep(1200); Atomics.store(ledger.slots, 5, 41n); ledger.unlock(); parentPort.postMessage("released");`);
  try {
    const id = await next<number>(holder, 10_000, "holder");
    const held = word(buf, 0);
    expect(held >> 32n, "the holder's token is in the word").toBe(BigInt(id));
    const answer = await probe(buf, 300);
    expect(answer.r, "no takeover: the contender times out").toBe("AdmissionLockTimeout");
    expect(answer.ms, "after its own deadline, not before and not unbounded").toBeGreaterThanOrEqual(280);
    expect(answer.ms).toBeLessThan(1000);
    expect(word(buf, 0), "the live holder still owns the lock").toBe(held);
    expect(checkpointLedger(buf).recoveries(), "nothing was recovered").toBe(0);
    expect(await next<string>(holder, 10_000, "holder release")).toBe("released");
  } finally { await holder.terminate(); }
  expect(word(buf, 0), "unlocked cleanly").toBe(0n);
  expect(word(buf, 5), "the holder's write, made while it owned the lock, is intact").toBe(41n);
  expect((await probe(buf, 300)).r, "and the ledger works afterwards").toBe("admitted");
});

it("T1b a lock word that never changes (token reuse) is not taken over after the old stale bound, only timed out", { timeout: 30_000 }, async () => {
  const buf = newBuffer();
  const planted = (77n << 32n) | 1n;
  new BigInt64Array(buf)[0] = planted; // a holder (owner 77) that has not moved for longer than 250 waits would have been taken over
  const answer = await probe(buf, 600);
  expect(answer.r, "same token for the whole wait: still no takeover").toBe("AdmissionLockTimeout");
  expect(answer.ms).toBeGreaterThanOrEqual(580);
  expect(word(buf, 0), "the word is untouched").toBe(planted);
  expect(checkpointLedger(buf).recoveries()).toBe(0);
});

it("T2 starvation: a contender that keeps reacquiring cannot hold another taker past its one total deadline", { timeout: 60_000 }, async () => {
  const buf = newBuffer();
  // Never free the word; stop changing tokens after six deadlines so a reset-deadline mutant answers slowly and fails the duration assertion.
  const starver = start(buf, `ledger.lock(); parentPort.postMessage("up"); let cur = Atomics.load(ledger.slots, 0), n = 0n;
    const until = performance.now() + 6 * 300;
    while (performance.now() < until) { const end = performance.now() + 1; while (performance.now() < end) {} const nx = (cur & ~0xffffffffn) | ((n = (n + 1n) & 0xffffffffn) || 1n); Atomics.compareExchange(ledger.slots, 0, cur, nx); cur = nx; }
    parentPort.on("message", () => {});`);
  const contender = start(buf, `parentPort.once("message", () => { const out = [];
    for (let i = 0; i < 5; i++) { const t0 = performance.now(); let r = "acquired"; try { ledger.lock(); ledger.unlock(); } catch (e) { r = e.name; } out.push({ r, ms: performance.now() - t0 }); }
    parentPort.postMessage(out); });`, 300);
  try {
    await next(starver, 10_000, "starver");
    contender.postMessage("go");
    const answer = await answerOrStuck<{ r: string; ms: number }[]>(contender, 10_000);
    expect(answer, "the contender answered: its wait is bounded by its one total deadline (it is not stuck inside lock())").not.toBe("stuck");
    const out = answer as { r: string; ms: number }[];
    for (const o of out) {
      expect(o.r, "the starved taker ends with the named error").toBe("AdmissionLockTimeout");
      expect(o.ms, "one total deadline, however often the token changes").toBeLessThan(300 + 400);
    }
  } finally { await starver.terminate(); await contender.terminate(); }
});

it("T3 a holder ended at the lock-held point: no hang, no takeover, recovery only after the confirmed exit, poisoned, nothing admitted until rebuild", { timeout: 30_000 }, async () => {
  const buf = newBuffer();
  const ledger = checkpointLedger(buf);
  const id = await holderKilled(buf);
  expect(word(buf, 0), "the dead thread's token is still in the word").not.toBe(0n);
  const before = await probe(buf, 200);
  expect(before.r, "before recovery the taker fails loudly (named), it does not hang and does not take over").toBe("AdmissionLockTimeout");
  expect(ledger.recoverAfterExit(id + 1000), "another thread's id changes nothing").toBe(false);
  expect(ledger.recoverAfterExit(id), "the confirmed exit of the holder recovers its lock").toBe(true);
  expect(word(buf, 0), "lock free").toBe(0n);
  expect(ledger.poisoned(), "and the ledger is poisoned").toBe(true);
  expect(ledger.recoveries()).toBe(1);
  expect((await probe(buf, 200)).r, "no admission while poisoned").toBe("refused");
  ledger.lock(); ledger.unlock(); // does not wait
  expect(ledger.rebuild({ writes: 0, bgReserved: 0, debt: 0 }), "rebuilt from the owner's real state").toBe(true);
  expect(ledger.poisoned()).toBe(false);
  expect((await probe(buf, 200)).r, "admitted again after the rebuild").toBe("admitted");
});

it("T4r a thread ended inside endCopy after the reservation release never leaves understated totals and no second holder overlaps", { timeout: 30_000 }, async () => {
  const buf = newBuffer();
  const ceiling = 3 * 1024 * 1024;
  // reading.os is a getter that every version reads AFTER the slot 6 release (6692ebc0a0, 509deac2 and f49afc3a all read it there):
  // it posts and spins, so the thread dies in the middle of endCopy with the reservation already dropped.
  const worker = new Worker(`const { parentPort, workerData, threadId } = require("node:worker_threads");
    const ledger = (0, eval)("(" + workerData.src + ")")(workerData.buf, threadId, 2000, { gen: 7 });
    const t = ledger.beginCopy(workerData.ceiling, Date.now());
    const reading = { meter: 0, get os() { parentPort.postMessage(threadId); for (;;) {} } };
    ledger.endCopy(t, 4096, 0, reading);`, { eval: true, workerData: { buf, src: checkpointLedger.toString(), ceiling } });
  const id = await next<number>(worker, 10_000, "worker");
  await worker.terminate();
  expect(word(buf, 6), "the reservation was already dropped (the torn state)").toBe(0n);
  expect(word(buf, 0), "the dead thread's token is still in the word").not.toBe(0n);
  const before = (checkpointLedger(buf) as any).recoveries?.() ?? 0;
  const answer = await probe(buf, 300);
  expect(answer.r, "the prober does not hang and takes nothing over without a confirmed exit").toBe("AdmissionLockTimeout");
  expect((checkpointLedger(buf) as any).recoveries?.() ?? 0, "no takeover was recorded").toBe(before);
  const ledger = checkpointLedger(buf) as any;
  expect(ledger.recoverAfterExit?.(id)).toBe(true);
  expect(ledger.poisoned?.()).toBe(true);
  // the exit reconcile (main thread, its one lock): the dead owner's table entry is charged to the current minute
  ledger.lock(); try { ledger.rotate(Date.now()); (ledger as any).reconcileDead?.(() => false, () => false, true); } finally { ledger.unlock(); }
  expect(Number(word(buf, 6)) + Number(word(buf, 8)), "slot 6 + slot 8 cover the ceiling").toBeGreaterThanOrEqual(ceiling);
  expect(Number(word(buf, 8)), "as settled charge").toBeGreaterThanOrEqual(ceiling);
  expect(ledger.beginCopy(1024, Date.now()), "next taker: refused while poisoned").toBeNull();
  expect(ledger.rebuild({ writes: 0, bgReserved: 0, debt: 0 })).toBe(true);
  expect(Number(word(buf, 3)), "totals stay charged after the rebuild until the minute rotates").toBeGreaterThanOrEqual(ceiling);
});

it("T-LOCK-LIVE two live threads keep mutual exclusion and are never taken over", { timeout: 30_000 }, async () => {
  const buf = newBuffer();
  const counter = `for (let i = 0; i < 20000; i++) { ledger.lock(); const v = Atomics.load(ledger.slots, 5); for (let k = 0; k < 50; k++) {} Atomics.store(ledger.slots, 5, v + 1n); ledger.unlock(); } parentPort.postMessage("done");`;
  const a = start(buf, counter), b = start(buf, counter);
  try { await Promise.all([next<string>(a, 25_000, "a"), next<string>(b, 25_000, "b")]); } finally { await a.terminate(); await b.terminate(); }
  expect(Number(word(buf, 5)), "no lost update").toBe(40_000);
  expect(checkpointLedger(buf).recoveries(), "a live holder is never recovered").toBe(0);
});

// L1 (Grok): the same four situations with the MAIN THREAD as the taker. It never waits or spins: one compare-exchange, and a busy word
// is an immediate AdmissionLockTimeout. The event loop is sampled while the lock is held and its worst gap must stay small.
async function mainTakes(ledger: ReturnType<typeof checkpointLedger>, rounds = 20) {
  let worstGap = 0, last = performance.now();
  const outcomes: string[] = [];
  const t0 = performance.now();
  for (let i = 0; i < rounds; i++) {
    try { ledger.beginCopy(1024, Date.now()); outcomes.push("admitted"); } catch (e) { outcomes.push((e as Error).name); }
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    const now = performance.now(); worstGap = Math.max(worstGap, now - last - 5); last = now;
  }
  return { outcomes, worstGap, total: performance.now() - t0 };
}
const allTimeouts = (r: { outcomes: string[] }) => expect(r.outcomes.every(o => o === "AdmissionLockTimeout"), r.outcomes.join(",")).toBe(true);

it("T-MAIN the main thread as taker never blocks: paused live holder, planted never-changing token, token-changing starver, killed holder", { timeout: 60_000 }, async () => {
  // T1 case: a live holder paused for 1.5 s
  let buf = newBuffer();
  let main = checkpointLedger(buf);
  const holder = start(buf, `ledger.lock(); parentPort.postMessage(threadId); sleep(1500); ledger.unlock(); parentPort.postMessage("released");`);
  try {
    await next<number>(holder, 10_000, "holder");
    const r = await mainTakes(main);
    allTimeouts(r);
    expect(r.worstGap, "event loop never held up").toBeLessThan(50);
    expect(r.total, "20 attempts and 20 sleeps, no waiting for the holder").toBeLessThan(500);
    expect(main.recoveries()).toBe(0);
    expect(await next<string>(holder, 10_000, "release")).toBe("released");
  } finally { await holder.terminate(); }
  main.lock(); main.unlock(); // the holder let go: the main thread takes it at once
  // T1b case: token that never changes
  buf = newBuffer(); main = checkpointLedger(buf);
  new BigInt64Array(buf)[0] = (77n << 32n) | 1n;
  const planted = await mainTakes(main); allTimeouts(planted);
  expect(planted.worstGap).toBeLessThan(50);
  expect(word(buf, 0), "untouched").toBe((77n << 32n) | 1n);
  // T2 case: a holder whose token changes all the time
  buf = newBuffer(); main = checkpointLedger(buf);
  const starver = start(buf, `ledger.lock(); parentPort.postMessage("up"); let cur = Atomics.load(ledger.slots, 0), n = 0n;
    for (;;) { const end = performance.now() + 1; while (performance.now() < end) {} const nx = (cur & ~0xffffffffn) | ((n = (n + 1n) & 0xffffffffn) || 1n); Atomics.compareExchange(ledger.slots, 0, cur, nx); cur = nx; }`);
  try {
    await next(starver, 10_000, "starver");
    const r = await mainTakes(main); allTimeouts(r);
    expect(r.worstGap).toBeLessThan(50);
  } finally { await starver.terminate(); }
  // T3/T4 case: a killed holder: immediate error before the confirmed exit is processed, recovery after it, poisoned
  buf = newBuffer(); main = checkpointLedger(buf);
  const id = await holderKilled(buf);
  const dead = await mainTakes(main); allTimeouts(dead);
  expect(dead.worstGap).toBeLessThan(50);
  expect(main.recoverAfterExit(id)).toBe(true);
  expect(main.beginCopy(1024, Date.now()), "poisoned: refused, not admitted").toBeNull();
  expect(main.rebuild({ writes: 0, bgReserved: 0, debt: 0 })).toBe(true);
  expect(main.beginCopy(1024, Date.now())).not.toBeNull();
});

// T5r / T-MAINr: an externally supervised child process (process.execPath). READY is printed after the imports and the ledger are built;
// the supervisor's 8 s SIGKILL clock starts only then, every child is reaped in finally. Assertions are on behavior: exit 0, fast, counted.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
async function runChild(mode: string) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(new URL("./admission-ledger-d6-child.ts", import.meta.url)), mode], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "", killed = false, timer: ReturnType<typeof setTimeout> | undefined;
  child.stdout.on("data", d => { out += d; if (!timer && out.includes("READY")) timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, 8000); });
  child.stderr.on("data", d => { err += d; });
  const t0 = Date.now();
  try {
    const code = await new Promise<number | null>(resolve => { child.on("exit", c => resolve(c)); });
    return { code, killed, out, err, ms: Date.now() - t0 };
  } finally { if (timer) clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); }
}
it("T5r a dead token on the main thread's ledger: copyRoom, admit and owner activity fail closed at once (supervised child)", { timeout: 40_000 }, async () => {
  const r = await runChild("t5");
  expect(r.killed, `the supervisor had to kill it (hang): ${r.err.slice(0, 300)}`).toBe(false);
  expect(r.code, r.err.slice(0, 300)).toBe(0);
  const result = JSON.parse(r.out.split("\n").filter(l => l.startsWith("{"))[0] ?? "{}") as { ms?: number; lockTimeouts?: number };
  expect(result.ms, "under a second").toBeLessThan(1000);
  expect(result.lockTimeouts, "counted").toBeGreaterThanOrEqual(3);
});
it("T-MAINr the main thread as taker never blocks in four situations (supervised child)", { timeout: 60_000 }, async () => {
  const r = await runChild("tmain");
  expect(r.killed, `the supervisor had to kill it (hang): ${r.err.slice(0, 300)}`).toBe(false);
  expect(r.code, r.err.slice(0, 300)).toBe(0);
  const o = JSON.parse(r.out.split("\n").filter(l => l.startsWith("{"))[0] ?? "{}") as Record<string, { outcomes: string[]; worst: number; total: number }> & { recovered?: boolean; refusedWhilePoisoned?: boolean; rebuilt?: boolean };
  for (const key of ["paused", "planted", "starver", "killed"] as const) {
    expect(o[key]!.outcomes.every(x => x === "AdmissionLockTimeout"), key + ": " + o[key]!.outcomes.join(",")).toBe(true);
    expect(o[key]!.worst, key + " event loop gap").toBeLessThan(50);
  }
  expect(o.recovered).toBe(true); expect(o.refusedWhilePoisoned).toBe(true); expect(o.rebuilt).toBe(true);
  expect(r.ms).toBeLessThan(30_000);
});

// T6r: a deterministic forced handoff. A contender worker waits on a flag, takes the lock the moment the test's getter or isIdle callback
// (both run in the owner BEFORE its one CAS) raises it, records slots 2/4/5/6/8 at the start of its hold and checks them unchanged at unlock.
function contenderOn(buf: SharedArrayBuffer) {
  const flag = new Int32Array(new SharedArrayBuffer(8));
  const worker = start(buf, `const flag = new Int32Array(workerData.flag);
    parentPort.postMessage("ready"); Atomics.wait(flag, 0, 0);
    ledger.lock(); const snap = () => [2, 4, 5, 6, 8].map(n => Atomics.load(ledger.slots, n));
    const a = snap(); Atomics.store(flag, 1, 1); Atomics.notify(flag, 1);
    const end = performance.now() + 150; let violations = 0; while (performance.now() < end) { const b = snap(); for (let i = 0; i < 5; i++) if (b[i] !== a[i]) violations++; }
    ledger.unlock(); parentPort.postMessage({ violations });`, 2000, { flag: flag.buffer });
  const trigger = () => { Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); const end = performance.now() + 5000; while (Atomics.load(flag, 1) === 0 && performance.now() < end) { /* spin until the contender holds the word */ } };
  return { worker, trigger, ready: () => next<string>(worker, 10_000, "contender ready"), done: () => next<{ violations: number }>(worker, 20_000, "contender") };
}
it("T6r the owner's one CAS never writes inside a contender's hold (backfilled and admit); the debt is kept and applied later", { timeout: 60_000 }, async () => {
  const MIN = 60_000, M0 = 1_000_000 * MIN;
  const { IoBudget } = await import("./io-budget.ts");
  let armed: (() => void) | null = null;
  const budget = new IoBudget({ read: () => ({ at: M0 + 5000, cpuMicros: 0, fsWriteBlocks: 0, meterBytes: 0 }) as never, log: () => {}, isIdle: () => { armed?.(); return false; } });
  const buf = budget.checkpointAdmissionBuffer(), s = new BigInt64Array(buf);
  const t = budget.admit("BG", 10_000, 4000)!;
  budget.settle(t, 2000, { salt: "aa", frame: 5 }, 4000, 0);
  expect(Number(s[4])).toBe(4000);
  const c1 = contenderOn(buf);
  try {
    await c1.ready();
    const done = c1.done();
    // the BackfillMark getter is read before the one CAS (D6) or between r2's two acquisitions
    budget.backfilled({ get salt() { c1.trigger(); return "aa"; }, frame: 9 });
    expect((await done).violations, "backfilled: no write by the owner inside the contender's hold").toBe(0);
    expect(Number(s[4]), "the debt was kept, not dropped").toBe(4000);
    budget.copyRoom(); // the next section applies it
    expect(Number(s[4]), "and applied later").toBe(0);
  } finally { await c1.worker.terminate(); }
  const c2 = contenderOn(buf);
  try {
    await c2.ready();
    const done = c2.done();
    armed = () => { armed = null; c2.trigger(); };
    const ticket = budget.admit("BG", 10_000, 0);
    expect(ticket, "admit refused while the contender holds").toBeNull();
    expect((await done).violations, "admit: no write inside the hold").toBe(0);
  } finally { await c2.worker.terminate(); }
});
