// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import "../shared/win-hide-child-process.mjs";
import {childFinishKey,isOwnChildIoAcknowledgement} from "./sentinel/io-child-receipts.ts";
// The leaf module, never ledger-refusal.ts: this file is loaded by every spawned proxy before it answers `initialize`.
import { BUDGET_REFUSAL_LINE, LEDGER_REFUSAL_LINE, REFUSAL_KIND_HEADER } from "./ledger-refusal-line.ts";
import { TURN_RELEASE_WAIT_MS } from "./turn-release-wait.ts";
import { logSwallowedConsumingError } from "./consuming-error-log.ts";
import type { ProxyFrame, ReleaseEnvelope } from "./consuming-turn-ingress.ts";
import { OWNER_TURN_HEADER } from "./owner-turn-caps.ts";

export const TURN_RELEASE_VERDICT_PATH = "/api/internal/turn-release/v1/verdict";
/** `budgetStop` (cause22 r2): the server's 409 said the turn was ended by its release budget (REFUSAL_KIND_HEADER), so the engine is told
 * the budget line, never that context became unavailable. The code and data are unchanged: only the sentence differs. */
export function terminalProxyRefusal(id: string | number | null, budgetStop = false) {
  const boundedId = typeof id === "string" && id.length > 0 && Buffer.byteLength(id) <= 128 || typeof id === "number" && Number.isSafeInteger(id) ? id : null;
  return { jsonrpc: "2.0", id: boundedId, error: { code: -32099, message: budgetStop ? BUDGET_REFUSAL_LINE : LEDGER_REFUSAL_LINE,
    data: { code: "MEMORY_CONTEXT_REVOKED", terminal: true } } } as const;
}
export interface ProxyReleasePorts {
  verdict(frame: ProxyFrame, signal: AbortSignal): Promise<ReleaseEnvelope>;
  /** Internal supervisor channel, never an engine's stdin. */
  envelope(envelope: ReleaseEnvelope): Promise<void>;
  seal(): void;
  /** `reason` is a bare code word naming the first refusing check (never frame text or a token). */
  terminal(frame: ReturnType<typeof terminalProxyRefusal>, reason: string): void;
  close(): void;
}
/** A bare code word for the terminal message and log: lower-case letters, digits and -_:=. only, bounded. */
export function terminalReasonWord(value: unknown): string {
  const word = typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9_:=.-]+/g, "-").slice(0, 64) : "";
  return word || "unknown";
}
/** Serialize releases across concurrent tool completions. Any failure permanently seals
 * this instance; there is no local JSON-RPC fallback and no refreshed environment binding. */
export function createProxyTurnRelease(instanceId: string, ports: ProxyReleasePorts) {
  let sealed = false, sequence = 0, budgetStop = false;
  let queue: Promise<void> = Promise.resolve();
  const refuse = (id: string | number | null, reason = "release-refused"): never => {
    if (!sealed) {
      // The stack names the check that refused; the error itself carries no frame or token.
      logSwallowedConsumingError("proxy.refuse", new Error("PROXY_RELEASE_REFUSED"));
      sealed = true;
      try { ports.seal(); } catch { /* supervisor EOF still seals the parent lease */ }
      try { ports.terminal(terminalProxyRefusal(id, budgetStop), terminalReasonWord(reason)); } catch { /* no content fallback */ }
      try { ports.close(); } catch { /* sealed remains permanent */ }
    }
    throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" });
  };
  return Object.freeze({
    release(id: string | number | null, frame: Omit<ProxyFrame, "instanceId" | "sequence">): Promise<void> {
      try {
        if (sealed || !frame || !Array.isArray(frame.refs) || typeof frame.frame !== "string") refuse(id, sealed ? "sealed" : "frame-shape");
        frame = Object.freeze({ ...frame, refs: Object.freeze([...frame.refs]) });
      } catch { try { refuse(id); } catch (error) { return Promise.reject(error); } }
      const task = queue.then(async () => {
        if (sealed) refuse(id, "sealed");
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const rpc = JSON.parse(frame.frame);
          if (!instanceId || !rpc || rpc.jsonrpc !== "2.0" || Array.isArray(rpc) || (rpc.id ?? null) !== id
            || (id !== null && !(typeof id === "string" && id.length > 0 && Buffer.byteLength(id) <= 128 || typeof id === "number" && Number.isSafeInteger(id)))
            || /[\r\n]/.test(frame.frame)) refuse(id, "frame-invalid");
          const request = { ...frame, instanceId, sequence: ++sequence };
          // A slow verdict or acknowledgement delays this frame (TURN_RELEASE_WAIT_MS); only a wait that never ends seals.
          await Promise.race([
            (async () => {
              const envelope = await ports.verdict(request, controller.signal);
              if (sealed || controller.signal.aborted || envelope.instanceId !== instanceId || envelope.sequence !== sequence || envelope.frame !== frame.frame
                || typeof envelope.permit !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(envelope.permit)) refuse(id, "verdict-mismatch");
              // The receiving ingress rechecks immediately before actual engine delivery.
              await ports.envelope(envelope);
            })(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); try { refuse(id, "verdict-timeout"); } catch (error) { reject(error); } }, TURN_RELEASE_WAIT_MS); timer.unref?.(); }),
          ]);
        } catch (error) {
          // The child's stderr is the only place the first cause of this refusal can be seen.
          if (!sealed) logSwallowedConsumingError("proxy.release", error);
          refuse(id, "verdict-failed");
        } finally { if (timer) clearTimeout(timer); controller.abort(); }
      });
      queue = task.catch(() => {});
      return task;
    },
    transportLost: (reason = "transport-lost") => refuse(null, reason),
    /** cause22 r2: the release door answered 409 with the budget word. Only chooses the sentence of the terminal refusal that follows. */
    budgetStop(): void { budgetStop = true; },
    get sealed() { return sealed; },
  });
}

import { createHash } from "node:crypto";
/** Each spawned entry captures its channel once. Later environment/request changes
 * cannot retarget it. stdout carries envelopes only; IPC carries terminal/ack. */
const processReleases = new Map<string, ReturnType<typeof createProxyTurnRelease>>();
/** q1023-winfirst: a door call that found its pooled keep-alive socket already closed by the server (Node closes an idle one after
 * 5 s; a cold box starting the browser engine idles a child that long) is rejected by fetch with a TypeError before any answer. The
 * server never read it, so it goes once more on a new connection; a second such failure, a timeout or any answer stands as before.
 * A call the server did read and then lost can only be charged twice (a reserve) or refused as a repeat (a verdict): fail-closed.
 * `patient` (1.0.24 linuxmem, MAIN-RULING memory; ASTRA 197c943acf): the bot's own memory mount keeps asking while the door cannot be
 * reached, until the frame's own wait ends (the caller's signal, TURN_RELEASE_WAIT_MS). The same request goes again, so the door
 * still decides everything: a call it did read is charged twice or refused as a repeat, exactly as above. */
async function doorFetch(url: URL, init: RequestInit, patient = false): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try { return await fetch(url, init); }
    catch (error) {
      if (!(error instanceof TypeError) || init.signal?.aborted || attempt >= 2 && !patient) throw error;
      if (attempt >= 2) await new Promise(resolve => setTimeout(resolve, Math.min(50 * 2 ** (attempt - 2), DOOR_RETRY_MAX_MS)));
    }
  }
}
const DOOR_RETRY_MAX_MS = 1000;
/** Roles whose reply release waits out an unreachable door. Only the bot's own memory mount: a saved memory's answer must reach the
 * bot (a sealed mount stops the owner's turn after the save landed). Every other role keeps one more try, then seals. */
const PATIENT_REPLY_ROLES: ReadonlySet<string> = new Set(["memory"]);
const spawnReleaseEnvironment = Object.freeze({ instanceId: process.env.MURAGE_RELEASE_INSTANCE ?? "",
  token: process.env.MURAGE_RELEASE_TOKEN ?? "", base: process.env.MURAGE_RELEASE_URL ?? "" });
const closeHooks: Array<() => void> = [];
/** cause22 caps: whose turn this process serves, as the release door last said. One process serves one admitted instance. */
let ownerTurn: boolean | undefined;
function noteOwnerTurn(response: { headers: { get(name: string): string | null } }): void { ownerTurn = response.headers.get(OWNER_TURN_HEADER) === "1"; }
/** True once the release door has named this turn the owner's own. */
export function proxyOwnerTurn(): boolean { return ownerTurn === true; }
/** Asks the door when it has not said yet: a zero-byte reserve, answered with the header. A refused reserve has sealed already. */
export async function learnProxyOwnerTurn(role: string): Promise<boolean> {
  if (ownerTurn === undefined) { try { await reserveProxyUpstream(role, 0); } catch { return false; } }
  return ownerTurn === true;
}
/** A spawned entry that holds a resource of its own (a broker socket) lets the release close it:
 * an open handle there would keep the sealed process alive after the release has closed. */
export function onProxyReleaseClose(hook: () => void): void { closeHooks.push(hook); }
export function processProxyRelease(role: string) {
  const existing = processReleases.get(role);
  if (existing) return existing;
  const { instanceId, token, base } = spawnReleaseEnvironment;
  let closed = false, stdinEnded = false;
  const patientReply = PATIENT_REPLY_ROLES.has(role);
  const acknowledgements = new Map<number, { resolve(): void; reject(): void }>();
  const release = createProxyTurnRelease(instanceId, {
    async verdict(frame, signal) {
      if (!instanceId || !token || !process.connected || closed) throw new Error("MEMORY_CONTEXT_REVOKED");
      const rpc = JSON.parse(frame.frame);
      const response = await doorFetch(new URL(TURN_RELEASE_VERDICT_PATH, base), { method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ instanceId, sequence: frame.sequence, descriptor: `proxy:${role}:frame`, requestId: rpc.id ?? null,
          bytes: Buffer.byteLength(frame.frame), digest: createHash("sha256").update(frame.frame).digest("hex"), frame: frame.frame }) }, patientReply);
      if (!response.ok) { noteRefusalKind(role, response); throw new Error("MEMORY_CONTEXT_REVOKED"); }
      noteOwnerTurn(response);
      // Every chunk of the answer is reserved before it is kept; no response.json().
      if (!response.body) throw new Error("MEMORY_CONTEXT_REVOKED");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      try {
        for (;;) { const next = await reader.read(); if (next.done) break;
          await reserveProxyUpstream(role, next.value.byteLength, false, patientReply);
          chunks.push(next.value); }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } finally { await reader.cancel().catch(() => {}); }
    },
    async envelope(value) {
      const serialized = JSON.stringify(value) + "\n";
      await reserveProxyUpstream(role, Buffer.byteLength(serialized), false, patientReply);
      return new Promise<void>((resolve, reject) => {
        if (closed || !process.connected) { reject(new Error("MEMORY_CONTEXT_REVOKED")); return; }
        acknowledgements.set(value.sequence, { resolve, reject: () => reject(new Error("MEMORY_CONTEXT_REVOKED")) });
        process.stdout.write(serialized, error => { if (error) lost("stdout-write"); });
      });
    },
    seal() { closed = true; for (const pending of acknowledgements.values()) pending.reject(); acknowledgements.clear(); },
    // `reason` names the refusing check for the parent's log; the frame itself is the fixed refusal.
    terminal(frame, reason) { process.send?.({ type: "turn-release-terminal", instanceId, frame, reason }); },
    close() {
      for (const hook of closeHooks) { try { hook(); } catch { /* sealed remains permanent */ } }
      // Without an admitted spawn there is no owned process channel to close.
      // Still sealed: no application frame can escape or gain fallback authority.
      if (!instanceId) return;
      process.stdout.end(); process.stdin.pause(); process.exitCode = 1;
      // The entry owns cleanup and finalization; natural exits use the preload finisher after active work drains.
      if (stdinEnded && typeof Reflect.get(globalThis, childFinishKey) === "function") { process.exitCode = 0; process.channel?.unref(); }
      else if (process.connected) process.disconnect?.();
    },
  });
  const lost = (cause: string) => {
    if (!release.sealed) logSwallowedConsumingError(`proxy.lost:${cause}`, new Error("TRANSPORT_LOST"));
    try { release.transportLost(`lost:${cause}`); } catch { /* terminal already sent; never a local reply */ }
  };
  process.on("message", (message: unknown) => {
    if(isOwnChildIoAcknowledgement(message))return;
    const ack = message as { type?: string; instanceId?: string; sequence?: number };
    if (ack?.type !== "turn-release-ack" || ack.instanceId !== instanceId || !Number.isSafeInteger(ack.sequence)) {
      lost(`ipc-unexpected type=${typeof ack?.type === "string" ? ack.type.slice(0, 40) : typeof message}`); return;
    }
    const pending = acknowledgements.get(ack.sequence!);
    if (!pending) { lost("ipc-unknown-ack"); return; }
    acknowledgements.delete(ack.sequence!); pending.resolve();
  });
  process.once("disconnect", () => lost("disconnect")); process.stdin.once("end", () => { stdinEnded = true; lost("stdin-end"); }); process.stdout.once("error", () => lost("stdout-error"));
  processReleases.set(role, release);
  return release;
}
/** cause22 r2: a 409 from the release door names a budget stop with one fixed header word; anything else leaves the default line. */
export function noteRefusalKind(role: string, response: { status: number; headers: { get(name: string): string | null } }): void {
  if (response.status === 409 && response.headers.get(REFUSAL_KIND_HEADER) === "retained-budget") processProxyRelease(role).budgetStop();
}
export function releaseProxyFrame(role: string, value: unknown): Promise<void> {
  const release = processProxyRelease(role);
  try {
    const frame = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof frame !== "string" || /[\r\n]/.test(frame)) release.transportLost();
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
export function proxyTransportLost(role: string, reason?: string): void {
  try { processProxyRelease(role).transportLost(reason); } catch { /* sealed before return */ }
}
/** Only a rejection caused by the supplied caller cancellation may leave the
 * mount alive. A deadline or an unrelated transport error still seals it. */
function callerCancelled(signal: AbortSignal | null | undefined, error: unknown): boolean {
  return signal?.aborted === true && signal.reason?.name !== "TimeoutError"
    && (error === signal.reason || error instanceof Error && error.name === "AbortError");
}
/** `retryable` (1.0.24 memhold): the caller retries this request itself (an own memory write, idempotent by its key), so a lost
 * connection or body only rejects and never seals the mount. A refusal from the release door still seals (reserveProxyUpstream). */
export async function proxyFetch(role: string, input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1], options?: { retryable?: boolean }): Promise<Response> {
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  try { return proxyUpstreamResponse(role, await fetch(input, init), signal, options?.retryable === true); }
  catch (error) {
    if (!callerCancelled(signal, error)) { logSwallowedConsumingError("proxy.fetch", error); if (options?.retryable !== true) proxyTransportLost(role, `fetch:${fetchErrorWord(error)}`); }
    throw error;
  }
}

/** The connection-level cause of a failed fetch (ECONNREFUSED, TimeoutError, ...): a code word, never a message. */
function fetchErrorWord(error: unknown): string {
  // undici wraps the socket error as `cause`, or as `cause.errors` when several addresses were tried.
  const cause = (error as { cause?: { code?: unknown; errors?: Array<{ code?: unknown }>; name?: unknown } } | null)?.cause;
  const word = [cause?.code, cause?.errors?.[0]?.code, (error as { code?: unknown } | null)?.code, cause?.name, (error as { name?: unknown } | null)?.name]
    .find(value => typeof value === "string" && value);
  return terminalReasonWord(word ?? "error");
}
/** The child's local cap is only staging protection. Authorization to examine
 * each chunk comes from the original server-owned generation counters. */
/** `patient`: the reservations of a reply's own release on a patient role (doorFetch). */
export async function reserveProxyUpstream(role: string, bytes: number, retryable = false, patient = false): Promise<void> {
  const { instanceId, token, base } = spawnReleaseEnvironment;
  let refused = false;
  try {
    if (!instanceId || !token || processProxyRelease(role).sealed) throw new Error("MEMORY_CONTEXT_REVOKED");
    // One reservation never exceeds half the door's per-call bound; a larger chunk is reserved in parts.
    for (let left = bytes; ; left -= RESERVE_PART) {
      const response = await doorFetch(new URL(TURN_RELEASE_VERDICT_PATH, base), { method: "POST", redirect: "error", signal: AbortSignal.timeout(TURN_RELEASE_WAIT_MS),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ operation: "upstream", instanceId, bytes: Math.max(0, Math.min(left, RESERVE_PART)) }) }, patient);
      void response.body?.cancel().catch(() => {});
      if (!response.ok) noteRefusalKind(role, response);
      if (!response.ok || processProxyRelease(role).sealed) { refused = true; throw new Error("MEMORY_CONTEXT_REVOKED"); }
      // cause22 caps: every answer of the door says whose turn this is (owner-turn-caps.ts).
      noteOwnerTurn(response);
      if (left <= RESERVE_PART) break;
    }
  } catch (error) {
    // 1.0.24 memhold: a retryable memory write whose door could not be reached (no refusal) only rejects; the caller retries it
    if (retryable && !refused && instanceId && token && !processProxyRelease(role).sealed) throw error;
    if (!processProxyRelease(role).sealed) logSwallowedConsumingError("proxy.reserveUpstream", error);
    proxyTransportLost(role, "upstream-reserve"); throw error;
  }
}

const RESERVE_PART = 4 * 1024 * 1024;

export function proxyUpstreamResponse(role: string, response: Response, signal?: AbortSignal | null, retryable = false): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const wrapped = new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { controller.close(); reader.releaseLock(); return; }
        await reserveProxyUpstream(role, next.value.byteLength, retryable);
        controller.enqueue(next.value);
      } catch (error) {
        if (!retryable && !callerCancelled(signal, error)) proxyTransportLost(role, "upstream-body");
        void reader.cancel().catch(() => {}); controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 }), { status: response.status, statusText: response.statusText, headers: response.headers });
  for (const key of ["url", "redirected", "type"] as const) Object.defineProperty(wrapped, key, { value: response[key] });
  return wrapped;
}

/** MAIN-RULING cause22-no-transport-caps: collects output of any size; every chunk is still reserved before it is kept. */
export async function collectProxyUpstream(role: string, stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of stream) {
      await reserveProxyUpstream(role, chunk.byteLength);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (!processProxyRelease(role).sealed) logSwallowedConsumingError("proxy.reserveUpstream", error);
    proxyTransportLost(role); throw error;
  }
}
