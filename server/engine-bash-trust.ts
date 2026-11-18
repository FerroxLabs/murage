// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// W1A admission accounting. Physical handles/jobs belong to the native supervisor.
// This module alone never grants a scanner exemption or qualifies an executable.
export interface ProtectedBashResource {
  revoke(): void;
  /** Resolves only after the supervisor confirms every dependent process drained. */
  drained: Promise<void>;
  release(): void;
}
export type EngineBashLease = Readonly<object>;
type RecordState = {
  token: EngineBashLease; state: "queued" | "acquiring" | "protected" | "draining" | "closed";
  controller: AbortController; resource?: ProtectedBashResource; timer?: ReturnType<typeof setTimeout>;
  finish(value: EngineBashLease | null): void; removeAbort(): void;
  close: Promise<void>; onDrained(): void; drainStarted?: Promise<void>;
};
const bound = (value: number | undefined, maximum: number): number => {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw Error("Invalid Bash lease bound");
  return value;
};
export class EngineBashLeases {
  private readonly records = new WeakMap<object, RecordState>();
  private readonly held = new Set<RecordState>();
  private readonly queue: RecordState[] = [];
  private active = 0;
  private readonly slots: number;
  private readonly workers: number;
  private readonly queued: number;
  private readonly acquireNative: (signal: AbortSignal) => Promise<ProtectedBashResource>;
  constructor(options: { acquire(signal: AbortSignal): Promise<ProtectedBashResource>; slots?: number; workers?: number; queued?: number }) {
    this.acquireNative = options.acquire;
    this.slots = bound(options.slots, 128);
    this.workers = bound(options.workers, 4);
    this.queued = bound(options.queued, 32);
  }
  get size(): number { return this.held.size; }
  live(lease: object): boolean { return this.records.get(lease)?.state === "protected"; }
  acquire(signal?: AbortSignal): Promise<EngineBashLease | null> {
    if (signal?.aborted || this.held.size >= this.slots || (this.active >= this.workers && this.queue.length >= this.queued)) return Promise.resolve(null);
    return new Promise(resolve => {
      const token = Object.freeze({});
      let settled = false;
      let onDrained!: () => void;
      const close = new Promise<void>(done => { onDrained = done; });
      const record: RecordState = { close, onDrained,
        token, state: "queued", controller: new AbortController(),
        finish(value) { if (!settled) { settled = true; resolve(value); } },
        removeAbort: () => signal?.removeEventListener("abort", cancel),
      };
      const cancel = () => { void this.revoke(token); };
      this.records.set(token, record); this.held.add(record); this.queue.push(record);
      signal?.addEventListener("abort", cancel, { once: true });
      record.timer = setTimeout(cancel, 2000);
      // Close the check/listener race for AbortSignals supplied by a caller.
      if (signal?.aborted) cancel();
      this.pump();
    });
  }
  revoke(lease: object): Promise<void> {
    const record = this.records.get(lease);
    if (!record || record.state === "closed") return Promise.resolve();
    if (record.state === "draining") return record.close;
    const queued = record.state === "queued";
    record.state = "draining";
    record.controller.abort(); clearTimeout(record.timer); record.removeAbort(); record.finish(null);
    if (queued) {
      const index = this.queue.indexOf(record); if (index >= 0) this.queue.splice(index, 1);
      this.closeRecord(record); this.pump(); return Promise.resolve();
    }
    if (record.resource) void this.drain(record);
    // A canceled acquiring worker still owns its reservation. Its eventual
    // result takes drain(), including after timeout/late success.
    return record.close;
  }

  private pump(): void {
    while (this.active < this.workers && this.queue.length) {
      const record = this.queue.shift()!;
      if (record.state !== "queued") continue;
      record.state = "acquiring"; this.active++;
      // Catch synchronous native errors as well as rejected acquisition promises.
      void Promise.resolve().then(() => this.acquireNative(record.controller.signal)).then(resource => {
        let protection: ProtectedBashResource | undefined;
        try {
          const { revoke, release, drained } = resource;
          if (typeof revoke === "function" && typeof release === "function" && drained instanceof Promise) {
            protection = { revoke: () => revoke.call(resource), release: () => release.call(resource), drained };
          }
        } catch { /* an incompatible native shape is no lifetime proof */ }
        if (!protection) {
          // An incompatible addon cannot confirm drain. Revoke what it can,
          // publish no authority and retain the bounded reservation rather
          // than releasing handles that might still protect descendants.
          record.state = "draining"; record.controller.abort(); clearTimeout(record.timer); record.removeAbort(); record.finish(null);
          try { resource?.revoke?.(); } catch { /* unknown lifetime stays reserved */ }
          return;
        }
        record.resource = protection;
        if (record.state === "draining" || record.controller.signal.aborted) { void this.drain(record); return; }
        record.state = "protected"; clearTimeout(record.timer);
        void protection.drained.then(() => {
          if (record.state === "protected") { record.state = "draining"; void this.drain(record); }
        }, () => { if (record.state === "protected") { record.state = "draining"; void this.drain(record); } });
        // Subscribe before publishing: an already-settled native drain must
        // invalidate the token before the awaiting caller can use it.
        record.finish(record.token);
      }, () => { record.finish(null); this.closeRecord(record); }).finally(() => { this.active--; this.pump(); });
    }
  }
  private drain(record: RecordState): Promise<void> {
    if (record.drainStarted) return record.drainStarted;
    // Native revoke errors do not grant permission to release protection. Only
    // confirmed drain does. A rejected/unresolved drain retains the slot.
    try { record.resource!.revoke(); } catch { /* retain until confirmed drain */ }
    record.drainStarted = record.resource!.drained.then(() => {
      record.resource!.release(); this.closeRecord(record);
    });
    void record.drainStarted.catch(() => {});
    return record.drainStarted;
  }
  private closeRecord(record: RecordState): void {
    if (record.state === "closed") return;
    record.state = "closed"; clearTimeout(record.timer); record.removeAbort(); this.held.delete(record); record.onDrained?.();
  }
}
