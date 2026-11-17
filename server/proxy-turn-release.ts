// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import "../shared/win-hide-child-process.mjs";
import {isOwnChildIoAcknowledgement} from "./sentinel/io-child-receipts.ts";
import { LEDGER_REFUSAL_LINE } from "./ledger-refusal.ts";
import type { ProxyFrame, ReleaseEnvelope } from "./consuming-turn-ingress.ts";

export const TURN_RELEASE_VERDICT_PATH = "/api/internal/turn-release/v1/verdict";
export function terminalProxyRefusal(id: string | number | null) {
  const boundedId = typeof id === "string" && id.length > 0 && Buffer.byteLength(id) <= 128 || typeof id === "number" && Number.isSafeInteger(id) ? id : null;
  return { jsonrpc: "2.0", id: boundedId, error: { code: -32099, message: LEDGER_REFUSAL_LINE,
    data: { code: "MEMORY_CONTEXT_REVOKED", terminal: true } } } as const;
}
export interface ProxyReleasePorts {
  verdict(frame: ProxyFrame, signal: AbortSignal): Promise<ReleaseEnvelope>;
  /** Internal supervisor channel, never an engine's stdin. */
  envelope(envelope: ReleaseEnvelope): Promise<void>;
  seal(): void;
  terminal(frame: ReturnType<typeof terminalProxyRefusal>): void;
  close(): void;
}
/** Serialize releases across concurrent tool completions. Any failure permanently seals
 * this instance; there is no local JSON-RPC fallback and no refreshed environment binding. */
export function createProxyTurnRelease(instanceId: string, ports: ProxyReleasePorts) {
  let sealed = false, sequence = 0;
  let queuedBytes = 0, queuedFrames = 0;
  let queue: Promise<void> = Promise.resolve();
  const refuse = (id: string | number | null): never => {
    if (!sealed) {
      sealed = true;
      try { ports.seal(); } catch { /* supervisor EOF still seals the parent lease */ }
      try { ports.terminal(terminalProxyRefusal(id)); } catch { /* no content fallback */ }
      try { ports.close(); } catch { /* sealed remains permanent */ }
    }
    throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" });
  };
  return Object.freeze({
    release(id: string | number | null, frame: Omit<ProxyFrame, "instanceId" | "sequence">): Promise<void> {
      let bytes = 0;
      try {
        if (sealed || !frame || !Array.isArray(frame.refs) || typeof frame.frame !== "string") refuse(id);
        bytes = Buffer.byteLength(frame.frame);
        if (queuedFrames >= 64 || queuedBytes + bytes > 8 * 1024 * 1024) refuse(id);
        frame = Object.freeze({ ...frame, refs: Object.freeze([...frame.refs]) });
        queuedBytes += bytes; queuedFrames++;
      } catch { try { refuse(id); } catch (error) { return Promise.reject(error); } }
      const task = queue.then(async () => {
        if (sealed) refuse(id);
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const rpc = JSON.parse(frame.frame);
          if (!instanceId || !rpc || rpc.jsonrpc !== "2.0" || Array.isArray(rpc) || (rpc.id ?? null) !== id
            || (id !== null && !(typeof id === "string" && id.length > 0 && Buffer.byteLength(id) <= 128 || typeof id === "number" && Number.isSafeInteger(id)))
            || Buffer.byteLength(frame.frame) > 8 * 1024 * 1024 || /[\r\n]/.test(frame.frame)) refuse(id);
          const request = { ...frame, instanceId, sequence: ++sequence };
          await Promise.race([
            (async () => {
              const envelope = await ports.verdict(request, controller.signal);
              if (sealed || controller.signal.aborted || envelope.instanceId !== instanceId || envelope.sequence !== sequence || envelope.frame !== frame.frame
                || typeof envelope.permit !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(envelope.permit)) refuse(id);
              // The receiving ingress rechecks immediately before actual engine delivery.
              await ports.envelope(envelope);
            })(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); try { refuse(id); } catch (error) { reject(error); } }, 5000); timer.unref?.(); }),
          ]);
        } catch { refuse(id); } finally { if (timer) clearTimeout(timer); controller.abort(); }
      });
      const complete = task.finally(() => { queuedBytes -= bytes; queuedFrames--; });
      queue = complete.catch(() => {});
      return complete;
    },
    transportLost: () => refuse(null),
    get sealed() { return sealed; },
  });
}

import { createHash } from "node:crypto";
/** Each spawned entry captures its channel once. Later environment/request changes
 * cannot retarget it. stdout carries envelopes only; IPC carries terminal/ack. */
const processReleases = new Map<string, ReturnType<typeof createProxyTurnRelease>>();
const spawnReleaseEnvironment = Object.freeze({ instanceId: process.env.MURAGE_RELEASE_INSTANCE ?? "",
  token: process.env.MURAGE_RELEASE_TOKEN ?? "", base: process.env.MURAGE_RELEASE_URL ?? "" });
export function processProxyRelease(role: string) {
  const existing = processReleases.get(role);
  if (existing) return existing;
  const { instanceId, token, base } = spawnReleaseEnvironment;
  let closed = false;
  const acknowledgements = new Map<number, { resolve(): void; reject(): void }>();
  const release = createProxyTurnRelease(instanceId, {
    async verdict(frame, signal) {
      if (!instanceId || !token || !process.connected || closed) throw new Error("MEMORY_CONTEXT_REVOKED");
      const rpc = JSON.parse(frame.frame);
      const response = await fetch(new URL(TURN_RELEASE_VERDICT_PATH, base), { method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ instanceId, sequence: frame.sequence, descriptor: `proxy:${role}:frame`, requestId: rpc.id ?? null,
          bytes: Buffer.byteLength(frame.frame), digest: createHash("sha256").update(frame.frame).digest("hex"), frame: frame.frame }) });
      if (!response.ok) throw new Error("MEMORY_CONTEXT_REVOKED");
      // The response is bounded before JSON parsing; no unbounded response.json().
      if (!response.body) throw new Error("MEMORY_CONTEXT_REVOKED");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const next = await reader.read(); if (next.done) break;
          await reserveProxyUpstream(role, next.value.byteLength);
          size += next.value.byteLength; if (size > 16 * 1024 * 1024 + 1024) throw new Error("MEMORY_CONTEXT_REVOKED"); chunks.push(next.value); }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } finally { await reader.cancel().catch(() => {}); }
    },
    async envelope(value) {
      const serialized = JSON.stringify(value) + "\n";
      await reserveProxyUpstream(role, Buffer.byteLength(serialized));
      return new Promise<void>((resolve, reject) => {
        if (closed || !process.connected) { reject(new Error("MEMORY_CONTEXT_REVOKED")); return; }
        acknowledgements.set(value.sequence, { resolve, reject: () => reject(new Error("MEMORY_CONTEXT_REVOKED")) });
        process.stdout.write(serialized, error => { if (error) lost(); });
      });
    },
    seal() { closed = true; for (const pending of acknowledgements.values()) pending.reject(); acknowledgements.clear(); },
    terminal(frame) { process.send?.({ type: "turn-release-terminal", instanceId, frame }); },
    close() {
      // Without an admitted spawn there is no owned process channel to close.
      // Still sealed: no application frame can escape or gain fallback authority.
      if (!instanceId) return;
      process.stdout.end(); process.stdin.pause(); process.exitCode = 1;
      if (process.connected) process.disconnect?.();
    },
  });
  const lost = () => { try { release.transportLost(); } catch { /* terminal already sent; never a local reply */ } };
  process.on("message", (message: unknown) => {
    if(isOwnChildIoAcknowledgement(message))return;
    const ack = message as { type?: string; instanceId?: string; sequence?: number };
    if (ack?.type !== "turn-release-ack" || ack.instanceId !== instanceId || !Number.isSafeInteger(ack.sequence)) { lost(); return; }
    const pending = acknowledgements.get(ack.sequence!);
    if (!pending) { lost(); return; }
    acknowledgements.delete(ack.sequence!); pending.resolve();
  });
  process.once("disconnect", lost); process.stdin.once("end", lost); process.stdout.once("error", lost);
  processReleases.set(role, release);
  return release;
}
export function releaseProxyFrame(role: string, value: unknown): Promise<void> {
  const release = processProxyRelease(role);
  try {
    const frame = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof frame !== "string" || Buffer.byteLength(frame) > 8 * 1024 * 1024 || /[\r\n]/.test(frame)) release.transportLost();
    const rpc = JSON.parse(frame);
    const id = rpc?.id ?? null;
    return release.release(id, { frame, refs: [], descriptor: { id: `proxy:${role}:frame`, mode: "body" } });
  } catch { try { release.transportLost(); } catch { /* sealed */ } return Promise.reject(new Error("MEMORY_CONTEXT_REVOKED")); }
}
/** Fire-and-forget senders still seal synchronously on failure; their callers may
 * not synthesize another ordinary result from this rejected release. */
export function sendProxyFrame(role: string, value: unknown): void {
  void releaseProxyFrame(role, value).catch(() => {});
}
export function proxyTransportLost(role: string): void {
  try { processProxyRelease(role).transportLost(); } catch { /* sealed before return */ }
}
/** Only a rejection caused by the supplied caller cancellation may leave the
 * mount alive. A deadline or an unrelated transport error still seals it. */
function callerCancelled(signal: AbortSignal | null | undefined, error: unknown): boolean {
  return signal?.aborted === true && signal.reason?.name !== "TimeoutError"
    && (error === signal.reason || error instanceof Error && error.name === "AbortError");
}
export async function proxyFetch(role: string, input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  try { return proxyUpstreamResponse(role, await fetch(input, init), signal); }
  catch (error) { if (!callerCancelled(signal, error)) proxyTransportLost(role); throw error; }
}

/** The child's local cap is only staging protection. Authorization to examine
 * each chunk comes from the original server-owned generation counters. */
export async function reserveProxyUpstream(role: string, bytes: number): Promise<void> {
  const { instanceId, token, base } = spawnReleaseEnvironment;
  try {
    if (!instanceId || !token || processProxyRelease(role).sealed) throw new Error("MEMORY_CONTEXT_REVOKED");
    const response = await fetch(new URL(TURN_RELEASE_VERDICT_PATH, base), { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "upstream", instanceId, bytes }) });
    void response.body?.cancel().catch(() => {});
    if (!response.ok || processProxyRelease(role).sealed) throw new Error("MEMORY_CONTEXT_REVOKED");
  } catch (error) { proxyTransportLost(role); throw error; }
}

export function proxyUpstreamResponse(role: string, response: Response, signal?: AbortSignal | null): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const sse = response.headers.get("content-type")?.includes("text/event-stream");
  let total = 0, pending = 0, line = 0, cr = false;
  const wrapped = new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { controller.close(); reader.releaseLock(); return; }
        await reserveProxyUpstream(role, next.value.byteLength);
        total += next.value.byteLength;
        if (!sse && total > 8 * 1024 * 1024) throw new Error("MEMORY_CONTEXT_REVOKED");
        if (sse) for (const byte of next.value) {
          if (++pending > 1024 * 1024) throw new Error("MEMORY_CONTEXT_REVOKED");
          if (byte === 10) { if (!line || line === 1 && cr) pending = 0; line = 0; } else line++;
          cr = byte === 13;
        }
        controller.enqueue(next.value);
      } catch (error) {
        if (!callerCancelled(signal, error)) proxyTransportLost(role);
        void reader.cancel().catch(() => {}); controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 }), { status: response.status, statusText: response.statusText, headers: response.headers });
  for (const key of ["url", "redirected", "type"] as const) Object.defineProperty(wrapped, key, { value: response[key] });
  return wrapped;
}

export async function collectProxyUpstream(role: string, stream: AsyncIterable<Uint8Array>, cap = 8 * 1024 * 1024): Promise<Buffer> {
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for await (const chunk of stream) {
      await reserveProxyUpstream(role, chunk.byteLength);
      size += chunk.byteLength;
      if (size > Math.min(cap, 8 * 1024 * 1024)) throw new Error("MEMORY_CONTEXT_REVOKED");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) { proxyTransportLost(role); throw error; }
}
