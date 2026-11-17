// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests only: open a memory index the way the helper does (MemoryIndex.create on the WAL core) with a controller that grants every
// charge, and close it the way a helper exit leaves it plus the permitted test close (seal + TRUNCATE first, so the next open passes).
import { MemoryIndex } from "../index.ts";
import { memwLines } from "../memw-steps.ts";
import { walTestHooks, type WalCharge } from "../index-wal.ts";

/** A controller that acks every charge (the helper's charge-ack, granted). */
export const grantCharge = (charge: WalCharge): Promise<boolean> => { void charge; return Promise.resolve(true); };
/** The WAL core's exit paths throw in tests instead of ending the vitest worker. */
export function testExitThrows(): void { walTestHooks.exit ??= (code: number) => { throw new Error(`MEMORY_INDEX_EXIT ${code}`); }; }
export async function openTestIndex(path: string, charge: (c: WalCharge) => Promise<boolean> = grantCharge): Promise<MemoryIndex> {
  testExitThrows();
  return MemoryIndex.create(path, { charge });
}
/** prepareExit (seal, -walok, TRUNCATE) then the permitted close. A close without the seal is S13: the next open stops. */
export async function closeSealed(index: MemoryIndex): Promise<void> { await index.prepareExit(); index.close(); }
/** Group-commit rows through the checked writer and require the whole batch committed (the old upsert contract). */
export async function put(index: MemoryIndex, rows: Parameters<MemoryIndex["applyBatch"]>[0]): Promise<void> {
  // The store caller retries the uncommitted tail after the worker has merged (segment-gate), drained or settled a check: the helper does the same, one worker tick between tries.
  let rest = rows;
  for (let tries = 0; ; tries++) {
    const r = await index.applyBatch(rest);
    if (r.status === "done") return;
    if (tries >= 400 || (r.reason !== "segment-gate" && r.reason !== "drain" && r.reason !== "check-owed")) throw new Error(`MEMORY_INDEX_BATCH_${r.reason} committed=${r.committed}`);
    rest = rest.slice(r.committed);
    await workerTick(index);
  }
}
/** One iteration of the helper's maintenance loop, the way worker.ts drives it: the 50 ms index.tick() (the setInterval after init), then
 * maintain() = maintenanceStep() plus the drain seal it asks for (holdAndSeal, up to 100 tries). The tick's seal is fire-and-forget in the worker and
 * runs beside the loop; a test waits for it by queuing one more seal behind it on the writer's own serial queue (only when the log was over the
 * tick line, so the product tick() decides whether a seal runs at all). `fillMayRun` is the worker's own gate for the age fill and sweep: the step
 * ran nothing, the segment gate is clear, and the writer neither stopped nor owes a check. The age fill leaves its check owed (one checked write);
 * the next tick's maintenance step settles it, as the worker's next maintain() does. */
export async function workerTick(index: MemoryIndex): Promise<{ fillMayRun: boolean; step: Awaited<ReturnType<MemoryIndex["maintenanceStep"]>> }> {
  const writer = (index as unknown as { writer: { L(): number; checkOwed(): boolean } }).writer;
  const overTickLine = writer.L() > memwLines().tickTruncate && !writer.checkOwed();
  await index.tick();
  if (overTickLine) await index.sealAndTruncate();
  const step = await index.maintenanceStep();
  if (step.drain) for (let n = 0; n < 100; n++) if ((await index.sealAndTruncate()).truncated) break;
  return { step, fillMayRun: step.ran === null && step.gateClear === true && !index.writerStopped() && !index.writerCheckOwed() };
}
/** Worker ticks until the writer owes no check and is not stopped (what the loop reaches between steps). */
export async function settleIndex(index: MemoryIndex): Promise<void> {
  for (let n = 0; n < 1000 && !index.writerStopped(); n++) { await workerTick(index); if (!index.writerCheckOwed()) return; }
}
