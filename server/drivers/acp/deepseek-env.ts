// Owners: c3-drivers owns the bounded file probe and its cancellation;
// op-misc owns DeepSeek's layered environment configuration.
import { Worker } from "node:worker_threads";

// A native filesystem syscall may outlive a worker termination request. Keep
// those workers owned until exit, and refuse new probes at a fixed capacity.
const liveWorkers = new Set<Worker>();
const MAX_WORKERS = 4;

async function stopWorker(worker: Worker): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      worker.terminate().then(() => true, () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 250); }),
    ]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}

// Filesystem operations can stall even for regular files on remote mounts.
// Keep them off the server thread, with a deadline owned independently of the
// CLI probe (which has already exited when environment decoding begins).
const SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const limit = 65536;
try {
  const layers = workerData.map(path => {
    let fd, inspected = false;
    try {
      const before = fs.lstatSync(path);
      inspected = true;
      if (!before.isFile() || before.size > limit) throw Error('config');
      fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.size > limit || before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size) throw Error('config');
      // Read the descriptor, never reopen its path. One extra byte catches
      // growth after fstat; allocation and work stay bounded even as it grows.
      const bytes = Buffer.alloc(limit + 1);
      let size = 0, count;
      do {
        count = fs.readSync(fd, bytes, size, bytes.length - size, size);
        size += count;
      } while (count && size < bytes.length);
      if (size > limit) throw Error('config');
      return bytes.subarray(0, size).toString('utf8');
    } catch (error) {
      if (!inspected && fd === undefined && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return '';
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  });
  parentPort.postMessage(layers);
} catch { parentPort.postMessage(null); }
`;

export async function readDeepseekEnv(paths: string[], signal?: AbortSignal): Promise<string[]> {
  if (signal?.aborted) throw new Error("stopped");
  if (liveWorkers.size >= MAX_WORKERS) throw new Error("config probe busy");
  const worker = new Worker(SOURCE, { eval: true, workerData: paths });
  liveWorkers.add(worker);
  worker.once("exit", () => liveWorkers.delete(worker));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await new Promise<string[]>((resolve, reject) => {
      cancel = () => reject(new Error("stopped"));
      signal?.addEventListener("abort", cancel, { once: true });
      // Covers startup, open, stat and read, including a stalled filesystem.
      timer = setTimeout(() => reject(new Error("config timeout")), 2000);
      worker.once("message", (layers: unknown) => {
        if (!Array.isArray(layers) || layers.length !== paths.length || layers.some(text => typeof text !== "string")) reject(new Error("config"));
        else resolve(layers);
      });
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("config worker exited")));
      if (signal?.aborted) cancel();
    });
  } finally {
    clearTimeout(timer);
    if (cancel) signal?.removeEventListener("abort", cancel);
    if (!await stopWorker(worker)) {
      // Read-only work cannot authorize a destination after this refusal.
      // Retain its slot until actual exit; do not hold Stop or app shutdown.
      worker.unref();
      throw new Error("config worker stop unconfirmed");
    }
  }
}
