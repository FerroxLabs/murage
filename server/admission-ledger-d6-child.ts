// SPDX-License-Identifier: AGPL-3.0-or-later
// Child process for admission-lock-dead-holder.test.ts (T5r, T-MAINr): run under an external supervisor that prints nothing itself.
// READY is printed after the imports and the ledger are built; the supervisor's clock starts only then.
import { Worker } from "node:worker_threads";
import { checkpointLedger } from "./admission-shared.ts";
import { IoBudget } from "./io-budget.ts";

const mode = process.argv[2];
const newBuffer = () => new SharedArrayBuffer(32 * BigInt64Array.BYTES_PER_ELEMENT);
if (mode === "t5") {
  const lines: string[] = [];
  const budget = new IoBudget({ read: () => ({ at: Date.now(), cpuMicros: 0, fsWriteBlocks: 0, meterBytes: 0 }) as never, log: line => lines.push(line), isIdle: () => false });
  const buf = budget.checkpointAdmissionBuffer();
  new BigInt64Array(buf)[0] = (77n << 32n) | 1n; // a dead holder's token
  console.log("READY");
  const t0 = performance.now();
  budget.copyRoom(); budget.admit("BG", 4096); budget.admit("FGCOPY", 4096); budget.noteForegroundActivity();
  const health = ((budget as unknown as { admissionHealth?: () => { lockTimeouts?: number } }).admissionHealth?.() ?? {}) as { lockTimeouts?: number };
  console.log(JSON.stringify({ ms: performance.now() - t0, lockTimeouts: health.lockTimeouts ?? -1 }));
  process.exit(0);
} else if (mode === "tmain") {
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const prelude = `const { parentPort, workerData, threadId } = require("node:worker_threads");
    const ledger = (0, eval)("(" + workerData.src + ")")(workerData.buf, threadId);
    const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);\n`;
  const start = (buf: SharedArrayBuffer, body: string) => new Worker(prelude + body, { eval: true, workerData: { buf, src: checkpointLedger.toString() } });
  const first = <T>(w: Worker) => new Promise<T>((resolve, reject) => { w.once("message", resolve as never); w.once("error", reject); });
  async function mainTakes(ledger: ReturnType<typeof checkpointLedger>, rounds = 20) {
    let worst = 0, last = performance.now();
    const outcomes: string[] = [];
    const t0 = performance.now();
    for (let i = 0; i < rounds; i++) {
      try { ledger.beginCopy(1024, Date.now()); outcomes.push("admitted"); } catch (error) { outcomes.push((error as Error).name); }
      await sleep(5);
      const now = performance.now(); worst = Math.max(worst, now - last - 5); last = now;
    }
    return { outcomes, worst, total: performance.now() - t0 };
  }
  console.log("READY");
  const out: Record<string, unknown> = {};
  let buf = newBuffer(), main = checkpointLedger(buf);
  const holder = start(buf, `ledger.lock(); parentPort.postMessage(threadId); nap(1500); ledger.unlock(); parentPort.postMessage("released");`);
  await first<number>(holder);
  out.paused = await mainTakes(main);
  await first<string>(holder); await holder.terminate();
  buf = newBuffer(); main = checkpointLedger(buf); new BigInt64Array(buf)[0] = (77n << 32n) | 1n;
  out.planted = await mainTakes(main);
  buf = newBuffer(); main = checkpointLedger(buf);
  const starver = start(buf, `ledger.lock(); parentPort.postMessage("up"); let cur = Atomics.load(ledger.slots, 0), n = 0n;
    for (;;) { const end = performance.now() + 1; while (performance.now() < end) {} const nx = (cur & ~0xffffffffn) | ((n = (n + 1n) & 0xffffffffn) || 1n); Atomics.compareExchange(ledger.slots, 0, cur, nx); cur = nx; }`);
  await first<string>(starver);
  out.starver = await mainTakes(main);
  await starver.terminate();
  buf = newBuffer(); main = checkpointLedger(buf);
  const dead = start(buf, `ledger.lock(); parentPort.postMessage(threadId); for (;;) {}`);
  const id = await first<number>(dead); await dead.terminate();
  out.killed = await mainTakes(main);
  out.recovered = main.recoverAfterExit(id);
  out.refusedWhilePoisoned = main.beginCopy(1024, Date.now()) === null;
  out.rebuilt = main.rebuild({ writes: 0, bgReserved: 0, debt: 0 });
  console.log(JSON.stringify(out));
  process.exit(0);
}
