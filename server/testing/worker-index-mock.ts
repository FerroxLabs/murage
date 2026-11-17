// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMW WP3: the mock MemoryIndex the helper-process suites share, on the WP2a surface the worker now drives (static create, applyBatch,
// maintenanceStep, tick, sealAndTruncate, prepareExit). A suite extends it and overrides what it observes. Not loaded by the helper.
export class MockWorkerIndex {
  rebuilt = false;
  fileId = "mock-file";
  static async create(path: string, _opts?: unknown): Promise<MockWorkerIndex> { return new this(path); }
  constructor(_path?: string) {}
  prepareModel(): void {}
  vector(): void {}
  upsert(_records: unknown[]): void {}
  purgeRolledCheckpoints(): { removed: number; examined: number; merged: boolean; done: boolean } { return { removed: 0, examined: 0, merged: false, done: true }; }
  maintenanceOwed(): boolean { return false; }
  async applyBatch(records: unknown[]): Promise<{ status: "done" }> { this.upsert(records); return { status: "done" }; }
  /** The old merge-purge pass is the mock index is its one maintenance step: it ran something only while a merge was owed. */
  async maintenanceStep(): Promise<{ ran: "merge" | null; gateClear?: boolean }> {
    if (this.purgeRolledCheckpoints && this.maintenanceOwed?.()) { this.purgeRolledCheckpoints(); return { ran: "merge", gateClear: true }; }
    return { ran: null, gateClear: true };
  }
  writerStopped(): boolean { return false; }
  writerCheckOwed(): boolean { return false; }
  tick(): void {}
  resetDone(): number | null { return null; }
  stopInfo(): null { return null; }
  deletionScrubPending(): boolean { return false; }
  ageFillOwed(): boolean { return false; }
  async sealAndTruncate(): Promise<{ truncated: boolean }> { return { truncated: true }; }
  async prepareExit(): Promise<void> {}
  async purgeRecords(_ids?: unknown): Promise<void> {}
  ioBytes(): number { return 0; }
  close(): void {}
}
