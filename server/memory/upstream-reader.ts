// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { BUDGET_VERDICT, checkReleaseAvailable, chargeUpstream, reserveRelease, RELEASE_CHUNK_MAX, ReleaseBudget, UPSTREAM_COLLECTION_MAX, UPSTREAM_EVENT_MAX } from "./release-budget.ts";
import type { LineageVerdict } from "./lineage-types.ts";

/** Tracks raw SSE delimiters without decoding. CRLF and LF may be split across reads.
 * Reserve bytes and event work before the caller can decode or retain a chunk. */
export class UpstreamAccounting {
  private pending = 0;
  private total = 0;
  private lineBytes = 0;
  private previousCR = false;
  private failed = false;
  // red-at-b530c7532: spawned proxies use strip-only TypeScript loading.
  readonly budgets: readonly ReleaseBudget[];
  readonly mode: "sse" | "collection";
  readonly refuse: (verdict: typeof BUDGET_VERDICT) => never;
  readonly collect: boolean;
  constructor(budgets: readonly ReleaseBudget[], mode: "sse" | "collection",
    refuse: (verdict: typeof BUDGET_VERDICT) => never, collect = false) {
    this.budgets = budgets; this.mode = mode; this.refuse = refuse; this.collect = collect;
    if (!budgets.length) refuse(BUDGET_VERDICT);
  }
  accept(chunk: Uint8Array): void {
    if (this.failed) this.refuse(BUDGET_VERDICT);
    try {
    chargeUpstream(this.budgets, chunk.byteLength, 0);
    this.total += chunk.byteLength;
    if ((this.mode === "collection" || this.collect) && this.total > UPSTREAM_COLLECTION_MAX) this.refuse(BUDGET_VERDICT);
    if (this.mode !== "sse") return;
    reserveRelease(this.budgets, { work: chunk.byteLength });
    for (const byte of chunk) {
      if (++this.pending > UPSTREAM_EVENT_MAX) this.refuse(BUDGET_VERDICT);
      if (byte === 10) {
        if (this.lineBytes === 0 || this.lineBytes === 1 && this.previousCR) {
          reserveRelease(this.budgets, { work: 1 });
          this.pending = 0;
        }
        this.lineBytes = 0;
      } else this.lineBytes++;
      this.previousCR = byte === 13;
    }
    } catch (error) { this.failed = true; throw error; }
  }
  end(): void {
    if (this.failed) this.refuse(BUDGET_VERDICT);
    if (this.mode === "sse" && this.pending) reserveRelease(this.budgets, { work: 1 });
    this.pending = 0;
  }
}

/** Request-owned async context. No caller-selected probe flag can override an
 * admitted consuming context; background/catalog calls outside it remain probes. */
import { AsyncLocalStorage } from "node:async_hooks";
type UpstreamOwner = { budgets: readonly ReleaseBudget[]; refuse: (verdict: LineageVerdict) => never };
const upstreamOwner = new AsyncLocalStorage<UpstreamOwner>();
export function withUpstreamOwner<T>(owner: UpstreamOwner, work: () => T): T {
  return upstreamOwner.run(Object.freeze({ budgets: Object.freeze([...owner.budgets]), refuse: owner.refuse }), work);
}
export function reserveUpstreamRequest(bytes: number): void {
  const owner = upstreamOwner.getStore();
  if (owner) {
    // Preparation is not a release. The concrete synchronous writer charges
    // attempts and bytes once, after validation under the database owner.
    reserveRelease(owner.budgets, { work: 1 });
    checkReleaseAvailable(owner.budgets, { attempts: 1, bytes });
  }
}
export function currentUpstreamAccounting(mode: "sse" | "collection", collect = false): UpstreamAccounting | undefined {
  const owner = upstreamOwner.getStore();
  return owner && new UpstreamAccounting(owner.budgets, mode, owner.refuse, collect);
}
/** Captures ownership when the stream is created, so reconnects and delayed
 * reads cannot select a newer generation. No prefetch before the first pull. */
export function accountedResponse(response: Response, collect = false): Response {
  const accounting = currentUpstreamAccounting(response.headers.get("content-type")?.includes("text/event-stream") ? "sse" : "collection", collect);
  if (!accounting || !response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { accounting.end(); controller.close(); reader.releaseLock(); return; }
        accounting.accept(next.value);
        controller.enqueue(next.value);
      } catch (error) {
        void reader.cancel().catch(() => {});
        controller.error(error);
        if ((error as { code?: string })?.code === "MEMORY_CONTEXT_REVOKED") {
          try { accounting.refuse((error as { fence?: LineageVerdict }).fence ?? { state: "checking", reason: "lookup-error" }); } catch { /* preserve the original refusal */ }
        }
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });
  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  for (const key of ["url", "redirected", "type"] as const) Object.defineProperty(wrapped, key, { value: response[key] });
  return wrapped;
}
export async function accountedFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  return accountedResponse(await fetch(input, init), true);
}

export function accountedChunks(stream: AsyncIterable<Uint8Array | string>, mode: "sse" | "collection") {
  // Capture at creation: a delegated relay may be pulled after its request's
  // async scope has ended, or while another generation owns the consumer.
  const accounting = currentUpstreamAccounting(mode);
  return (async function* () {
    for await (const chunk of stream) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      accounting?.accept(bytes);
      for (let offset = 0; offset < bytes.byteLength; offset += RELEASE_CHUNK_MAX) yield bytes.subarray(offset, offset + RELEASE_CHUNK_MAX);
    }
    accounting?.end();
  })();
}

/** Cancels on *any* failure, including a synchronous final-writer refusal. No partial
 * content fallback and no decoding before accounting. The consumer controls backpressure. */
export async function readConsumingUpstream(response: Response, accounting: UpstreamAccounting,
  accept: (chunk: Uint8Array) => void | Promise<void>): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      // Charge the entire received chunk before visiting or accumulating any of it.
      accounting.accept(next.value);
      for (let offset = 0; offset < next.value.byteLength; offset += RELEASE_CHUNK_MAX) {
        await accept(next.value.subarray(offset, offset + RELEASE_CHUNK_MAX));
      }
    }
    accounting.end();
  } catch (error) {
    // Native transport failures retain their native settlement. Only an
    // actual fence/budget refusal can invoke the ledger-refusal lifecycle.
    if ((error as { code?: string })?.code === "MEMORY_CONTEXT_REVOKED") {
      try { accounting.refuse((error as { fence?: LineageVerdict }).fence ?? { state: "checking", reason: "lookup-error" }); }
      catch { /* preserve the original refusal */ }
    }
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
