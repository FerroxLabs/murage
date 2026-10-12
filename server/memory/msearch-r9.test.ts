// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Msearch review round 9 (lanes/msearch-review/r9/REPORT.md). Fails on 64b86c997.
//  P2  checkpoint starvation: the acknowledgement timeout started before the open scans drained, and checkpointing was refused
//      afterwards, so scans arriving every 400 ms (each lasting to its deadline) kept the log from ever being truncated.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { MemoryIndex, walBytes, type IndexedMemory } from "./index.ts";
import { closeMemoryIndexReader, lexicalPageSliced, resetScanAdmission, setWalCheckpointRequester, setWalDrainThreshold } from "./index-reader.ts";

const INDEX_PATH = () => join(DATA_DIR, "memory-index.db");
const entry = (id: string): IndexedMemory => ({ id, version: 1, scopeId: "s", text: "harbour lantern notes for the Friday review", deleted: false });
function world() {
  closeMemoryIndexReader();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
  const index = new MemoryIndex(INDEX_PATH());
  index.prepareModel("model");
  index.upsert(Array.from({ length: 6000 }, (_, n) => entry(`d-${String(n).padStart(4, "0")}`)));
  return index;
}
beforeEach(() => { resetScanAdmission(); closeMemoryIndexReader(); closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.useRealTimers(); resetScanAdmission(); closeMemoryIndexReader(); setWalCheckpointRequester(null); setWalDrainThreshold(64 * 1024 * 1024); });

/** A scan that stays open until its deadline: each yield sleeps (fake time) to the deadline. */
const heldScan = (n: number, deadlineAt: number) => lexicalPageSliced(`harbour held${n}`, ["s"], 50, 0, () => new Promise<void>(resolve => setTimeout(resolve, Math.max(1, deadlineAt - Date.now()))), { deadlineAt });

describe("P2: continuous overlapping scans cannot starve the checkpoint", () => {
  it("scans every 400 ms, each held to a 2.5 s deadline, with the log over the threshold: the request is sent and acknowledged within a bound", async () => {
    const index = world();
    expect(walBytes(INDEX_PATH())).toBeGreaterThan(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const requests: number[] = [];
    setWalCheckpointRequester(async () => { requests.push(Date.now()); return index.checkpointNow(); });
    setWalDrainThreshold(Number.MAX_SAFE_INTEGER);
    const pages: Array<Promise<{ partial?: boolean } | null>> = [];
    let n = 0, overAt = -1;
    for (let t = 0; t < 60_000; t += 400) {
      if (t === 2000) { setWalDrainThreshold(1); overAt = Date.now(); }
      pages.push(heldScan(n++, Date.now() + 2500));
      await vi.advanceTimersByTimeAsync(400);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(pages);
    index.close();
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests[0] - overAt).toBeLessThanOrEqual(3000); // the open scans' deadline (2.5 s) plus slack
  }, 60_000);

  it("a missing acknowledgement reopens admission after GATE_MAX_MS from the send, and the request is retried after the back-off", async () => {
    const index = world();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const requests: number[] = [];
    setWalCheckpointRequester(() => { requests.push(Date.now()); return new Promise<boolean>(() => { /* never answers */ }); });
    setWalDrainThreshold(1);
    const first = lexicalPageSliced("harbour never", ["s"], 50, 0, async () => {}, { deadlineAt: Date.now() + 2500 });
    await vi.advanceTimersByTimeAsync(2100); // past the acknowledgement timeout: admission is open again, the first scan is answered
    expect(requests).toHaveLength(1);
    const page = await first;
    expect(page?.partial).toBeUndefined();
    index.close();
  }, 60_000);

  it("below the threshold, concurrent scans all answer in full and no request is made", async () => {
    const index = world();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const requests: number[] = [];
    setWalCheckpointRequester(async () => { requests.push(Date.now()); return true; });
    setWalDrainThreshold(Number.MAX_SAFE_INTEGER);
    const pages = [0, 1, 2].map(i => lexicalPageSliced(`harbour calm${i}`, ["s"], 50, 0, () => new Promise<void>(resolve => setTimeout(resolve, 100)), { deadlineAt: Date.now() + 5000 }));
    await vi.advanceTimersByTimeAsync(6000);
    const answers = await Promise.all(pages);
    index.close();
    for (const answer of answers) { expect(answer?.partial).toBeUndefined(); expect(answer?.hits).toHaveLength(50); }
    expect(requests).toHaveLength(0);
  }, 60_000);
});
