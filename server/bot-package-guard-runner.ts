// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Checks an imported package in a worker thread so the server keeps serving
// chats and routines while a large one is read, and reports how far the check
// has got. If the worker crashes, runs out of memory or takes longer than a
// minute, the import is blocked with a plain "try again": a check that did not
// finish never lets a package through. One check runs at a time per import,
// and a check ends as soon as the owner closes the dialog.
import { Worker } from "node:worker_threads";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import type { BotPackageScanFile, BotPackageScanResult } from "./bot-package-scan.ts";

export const IMPORT_SCAN_TIMEOUT_MS = 60_000;
const WORKER_MEMORY_MB = 4096;
const PROGRESS_KEEP_MS = 10_000;

export interface ImportScanProgress { state: "running" | "done"; filesDone: number; filesTotal: number; bytesDone: number; bytesTotal: number }
export class ImportScanCancelled extends Error { constructor() { super("PACKAGE_SCAN_CANCELLED"); this.name = "ImportScanCancelled"; } }

interface Active { progress: ImportScanProgress; cancel: () => void }
const active = new Map<string, Active>();

/** How far the check with this id has got, or null if there is none. */
export function importScanProgress(scanId: string): ImportScanProgress | null {
  return active.get(scanId)?.progress ?? null;
}

const unavailable = (): BotPackageScanResult => ({ blocked: true, reviewRequired: false, findings: [], truncated: true, state: "unavailable" });

/** At most this many bytes are copied in one turn of the event loop. */
const COPY_SLICE_BYTES = 4 * 1024 * 1024;
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

/** Fresh copies of the files' bytes to hand over, so the caller keeps its own,
 * copied a slice at a time with a turn of the event loop between slices.
 * Stops early once `stopped` says the check already ended. */
async function copyForWorker(files: readonly BotPackageScanFile[], stopped: () => boolean): Promise<{ copied: BotPackageScanFile[]; transfer: ArrayBuffer[] }> {
  const transfer: ArrayBuffer[] = [];
  const copied: BotPackageScanFile[] = [];
  let sinceTurn = 0;
  for (const file of files) {
    if (typeof file.content === "string") { copied.push(file); continue; }
    const source = file.content;
    const bytes = new Uint8Array(source.byteLength);
    for (let offset = 0; offset < source.byteLength; offset += COPY_SLICE_BYTES) {
      if (sinceTurn >= COPY_SLICE_BYTES) { await nextTurn(); sinceTurn = 0; if (stopped()) return { copied, transfer }; }
      const slice = source.subarray(offset, offset + COPY_SLICE_BYTES);
      bytes.set(slice, offset);
      sinceTurn += slice.byteLength;
    }
    transfer.push(bytes.buffer);
    copied.push({ path: file.path, content: bytes });
  }
  return { copied, transfer };
}

export function scanBotPackageForImportAsync(
  files: readonly BotPackageScanFile[],
  options: { signal?: AbortSignal; scanId?: string; timeoutMs?: number; workerPath?: string } = {},
): Promise<BotPackageScanResult> {
  const sizeOf = (file: BotPackageScanFile) => (typeof file.content === "string" ? Buffer.byteLength(file.content, "utf8") : file.content.byteLength);
  const progress: ImportScanProgress = { state: "running", filesDone: 0, filesTotal: files.length, bytesDone: 0, bytesTotal: files.reduce((sum, file) => sum + sizeOf(file), 0) };
  return new Promise<BotPackageScanResult>((resolve, reject) => {
    if (options.signal?.aborted) { reject(new ImportScanCancelled()); return; }
    // A second check for the same import replaces the first.
    if (options.scanId) active.get(options.scanId)?.cancel();
    let settled = false;
    let worker: Worker | undefined;
    let timer: NodeJS.Timeout | undefined;
    const entry: Active = { progress, cancel: () => finish(() => reject(new ImportScanCancelled())) };
    const onAbort = () => entry.cancel();
    function finish(settle: () => void) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      void worker?.terminate();
      progress.state = "done";
      if (options.scanId) {
        const id = options.scanId;
        const keep = setTimeout(() => { if (active.get(id) === entry) active.delete(id); }, PROGRESS_KEEP_MS);
        keep.unref();
      }
      settle();
    }
    if (options.scanId) active.set(options.scanId, entry);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // The copies are made a slice at a time between turns of the event loop:
    // copying a 50 MB package in one go held the server for 30 to 60 ms.
    void copyForWorker(files, () => settled).then(({ copied, transfer }) => {
      if (settled) return;
      worker = new Worker(options.workerPath ?? SPAWNED_PROXIES.importGuardWorker, { resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB } });
      worker.on("message", (message: { type: string; fraction?: number; result?: BotPackageScanResult }) => {
        if (message.type === "progress" && typeof message.fraction === "number") {
          const fraction = Math.min(1, Math.max(0, message.fraction));
          progress.filesDone = Math.min(progress.filesTotal, Math.floor(fraction * progress.filesTotal));
          progress.bytesDone = Math.min(progress.bytesTotal, Math.floor(fraction * progress.bytesTotal));
        } else if (message.type === "result" && message.result) {
          const result = message.result;
          progress.filesDone = progress.filesTotal; progress.bytesDone = progress.bytesTotal;
          finish(() => resolve(result));
        }
      });
      worker.on("error", () => finish(() => resolve(unavailable())));
      worker.on("exit", () => finish(() => resolve(unavailable())));
      worker.postMessage({ files: copied }, transfer);
      timer = setTimeout(() => finish(() => resolve(unavailable())), options.timeoutMs ?? IMPORT_SCAN_TIMEOUT_MS);
    }).catch(() => finish(() => resolve(unavailable())));
  });
}
