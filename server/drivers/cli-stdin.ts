// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerBusyloopPayloadSite } from "../../shared/flux-route.ts";
export type StdinFrame = { wire: string; done?: (error?: Error | null) => void; release?: (write: () => unknown, validate: () => void) => unknown };

/** S2 input ownership. Cold/S1 sessions start passed. Opening this gate must
 * only follow confirmed retirement of the preceding mount generation. */
export class ClaudeStdinGate {
  barrier: "open" | "passed" = "passed";
  failure: string | null = null;
  private releasing = false;
  private forwarded?: StdinFrame;
  private readonly owned = new Map<string, string>();
  private queue: StdinFrame[] = [];
  private failWait!: () => void;
  failed: Promise<void> = new Promise(resolve => { this.failWait = resolve; });

  open(): void {
    if (this.queue.length || this.releasing) throw new Error("S2 input still owned");
    this.barrier = "open";
    this.failure = null;
    this.owned.clear();
    this.failed = new Promise(resolve => { this.failWait = resolve; });
  }
  fail(reason: string): void {
    this.failure ??= reason;
    this.failWait();
  }
  incomingRequest(): boolean {
    if (this.barrier !== "open") return false;
    this.fail("CLI request during S2 barrier");
    return true;
  }
  own(id: string, subtype: "mcp_reconnect" | "mcp_status"): void {
    this.owned.set(id, subtype);
  }
  /** One exact release frame re-enters the sole raw writer. All reentrant
   * writes still route through the hold; no general bypass is exposed. */
  forward(frame: StdinFrame, write: () => void): void {
    if (!this.releasing || this.barrier !== "passed" || this.forwarded) throw new Error("S2 release not active");
    this.forwarded = frame;
    try { write(); } finally { this.forwarded = undefined; }
  }
  route(frame: StdinFrame): "write" | "held" | "blocked" {
    if (this.forwarded?.wire === frame.wire && this.forwarded.done === frame.done && this.forwarded.release === frame.release) {
      this.forwarded = undefined;
      return "write";
    }
    if (this.barrier === "passed" && !this.releasing) return "write";
    let value: any;
    try { value = registerBusyloopPayloadSite("read", JSON.parse(frame.wire)); } catch { /* non-JSON is never allowlisted */ }
    if (value?.type === "user") { this.queue.push(frame); return "held"; }
    const subtype = value?.request?.subtype;
    if (!this.failure && value?.type === "control_request"
      && (subtype === "mcp_reconnect" || subtype === "mcp_status")
      && this.owned.get(value.request_id) === subtype) {
      this.owned.delete(value.request_id); // one write per minted id
      return "write";
    }
    this.fail("Non-allowlisted S2 stdin write");
    return "blocked";
  }
  /** Hold remains in force across turn.started listeners, including the
   * passed/live.turn-before-prompt window (G-M2). write is the raw sink. */
  release(prompt: StdinFrame, start: () => void, write: (frame: StdinFrame) => void): void {
    if (this.failure || this.barrier !== "open") throw new Error("S2 barrier did not pass");
    this.releasing = true;
    this.barrier = "passed";
    this.owned.clear();
    try {
      start();
      if (this.failure) throw new Error(this.failure);
      try { write(prompt); } catch (error) {
        // CL7a (N4): the prompt's refusal is every queued frame's refusal; none is written after it.
        const failed = error instanceof Error ? error : new Error(String(error));
        for (const frame of this.queue.splice(0)) frame.done?.(failed);
        throw error;
      }
      while (this.queue.length) write(this.queue.shift()!);
    } finally { this.releasing = false; }
  }
  /** Move frames, including their acknowledgements, to the cold turn. Never
   * replay a closure bound to the failed warm child's stdin. */
  takeForCold(): StdinFrame[] { return this.queue.splice(0); }
}
