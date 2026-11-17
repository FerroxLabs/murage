// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bounded, interruptible enumeration for the MCP stop path (nlrace design R8, S4, V4; Astra arev-nlrace3 finding 4). The server process
// never reads /proc synchronously and never calls the native process listing on a stop: every enumeration, pre-stop capture and live proof
// runs in a short-lived helper child (drivers/mcp-stop-probe.ts). A stalled read or a stalled native call therefore costs one helper,
// which is ended with SIGKILL at the cap, never the server's event loop. A cap, an abort, a crash or an unreadable answer is `null`
// (unknown), never a smaller answer. This module imports nothing local so the probe bundle stays free of proxy-paths (see proxy-paths.ts).
import { spawn, type ChildProcess } from "node:child_process";

export type HelperRequest =
  | { op: "capture"; platform: "linux" | "darwin"; rootPid: number }
  /** The pre-stop capture of every root of one relay stop, in one helper child and one enumeration (R8 as amended 2026-11-17). */
  | { op: "captureMany"; platform: "linux" | "darwin"; rootPids: number[] }
  | { op: "desktopProof"; record: unknown }
  /** The post-kill proofs of several servers of one relay stop, in one helper child (R8 amendment B2): one answer per record, in order. */
  | { op: "proveMany"; records: unknown[] }
  | { op: "identity"; platform: "linux" | "darwin"; pid: number }
  | { op: "prove"; record: unknown };
/** Runs one request in its own helper child. Resolves with the helper's JSON answer, or null when it could not answer in time. */
export type HelperRunner = (request: HelperRequest, signal?: AbortSignal) => Promise<unknown | null>;
export interface HelperSpawn { (script: string, env: Record<string, string>): ChildProcess }

export const HELPER_CAP_MS = 4_000;
const defaultSpawn: HelperSpawn = (script, env) => spawn(process.execPath, ["--experimental-strip-types", script], { stdio: ["pipe", "pipe", "ignore"], env, windowsHide: true });

export function makeHelperRunner(options: { script: string; capMs?: number; spawn?: HelperSpawn; onLeak?: (child: ChildProcess) => void }): HelperRunner {
  const cap = options.capMs ?? HELPER_CAP_MS;
  const start = options.spawn ?? defaultSpawn;
  return (request, signal) => new Promise((resolve) => {
    if (signal?.aborted) { resolve(null); return; }
    let child: ChildProcess;
    try { child = start(options.script, { ELECTRON_RUN_AS_NODE: "1", PATH: process.env.PATH ?? "" }); } catch { resolve(null); return; }
    let out = "";
    let settled = false;
    const finish = (value: unknown | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    // The cap and the caller's abort end THIS helper alone, by the handle captured here (never by pid lookup, never another request's helper).
    const endHelper = (): void => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
    const onAbort = (): void => { endHelper(); finish(null); };
    const timer = setTimeout(() => { endHelper(); finish(null); }, cap);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => { if (out.length < 4_000_000) out += chunk.toString("utf8"); });
    child.once("error", () => finish(null));
    child.once("close", () => { try { finish(JSON.parse(out.trim()) as unknown); } catch { finish(null); } });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(request));
  });
}

/** The env flag that runs the probe helper as a warm, long-lived helper (mcp-stop-probe.ts): one JSON request per stdin line, one
 *  `{ id, answer }` per stdout line, a `{ ready: true }` line once it can answer, and an exit when its stdin ends (its relay died). */
export const WARM_HELPER_ENV = "MURAGE_MCP_STOP_PROBE_WARM";
/** A warm helper that died before it was ready waits this long before its first restart; each further death before ready doubles the wait
 *  up to WARM_HELPER_RESTART_MAX_MS, and reaching ready resets it (MC63 backoff ruling: a helper that never starts is not respawned every
 *  250 ms for the relay's life). While it is not ready, a Stop spawns on demand under the same cap, so the backoff never delays a Stop. */
export const WARM_HELPER_RESTART_MS = 250;
export const WARM_HELPER_RESTART_MAX_MS = 30_000;

/** R8-C (MC63 2026-11-17): a relay's warm capture helper. Started at the relay's first desktop child and kept ready, so a Stop sends its
 *  capture request to a running helper instead of spawning one (C1). It is not ready while it starts or after it died: the caller then spawns
 *  an on-demand helper exactly as before, which still fails closed at the snapshot cap (C3). A cap, an abort or a crash SIGKILLs it and
 *  answers null (unknown) for every request it carried, never a smaller answer; it is then restarted. dispose() ends it with its relay, and
 *  its stdin pipe ends when the relay's process dies, which ends it too, so it is never left as an orphan. */
export class WarmHelper {
  readonly #script: string;
  readonly #cap: number;
  readonly #start: HelperSpawn;
  #child: ChildProcess | null = null;
  #ready = false;
  #disposed = false;
  #next = 1;
  #restartMs = WARM_HELPER_RESTART_MS;
  #pending = new Map<number, (value: unknown | null) => void>();
  constructor(options: { script: string; capMs?: number; spawn?: HelperSpawn }) {
    this.#script = options.script; this.#cap = options.capMs ?? HELPER_CAP_MS; this.#start = options.spawn ?? defaultSpawn;
  }
  get ready(): boolean { return this.#ready && !this.#disposed && this.#child !== null; }
  /** The running helper's pid (tests and the orphan witness). */
  get pid(): number | undefined { return this.#child?.pid; }

  start(): void {
    if (this.#disposed || this.#child) return;
    let child: ChildProcess;
    try { child = this.#start(this.#script, { ELECTRON_RUN_AS_NODE: "1", PATH: process.env.PATH ?? "", [WARM_HELPER_ENV]: "1" }); }
    catch { this.#restartLater(); return; }
    this.#child = child; this.#ready = false;
    let buffered = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.#child !== child) return;
      buffered += chunk.toString("utf8");
      if (buffered.length > 4_000_000) { this.#end(child); return; }
      for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
        const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
        let message: { ready?: boolean; id?: number; answer?: unknown };
        try { message = JSON.parse(line) as typeof message; } catch { continue; }
        if (message?.ready === true) { this.#ready = true; this.#restartMs = WARM_HELPER_RESTART_MS; continue; }
        const settle = typeof message?.id === "number" ? this.#pending.get(message.id) : undefined;
        if (settle) { this.#pending.delete(message.id!); settle(message.answer ?? null); }
      }
    });
    const gone = (): void => {
      if (this.#child !== child) return;
      const wasReady = this.#ready;
      this.#child = null; this.#ready = false;
      this.#failPending();
      if (wasReady) this.start(); else this.#restartLater();
    };
    child.once("error", gone);
    child.once("exit", gone);
    child.once("close", gone);
    child.stdin?.on("error", () => {});
  }

  /** One request on the warm helper; null when it could not answer in time. Only call while `ready`. */
  run: HelperRunner = (request, signal) => new Promise((resolve) => {
    const child = this.#child;
    if (!child || !this.ready || signal?.aborted) { resolve(null); return; }
    const id = this.#next++;
    let settled = false;
    const finish = (value: unknown | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      this.#pending.delete(id);
      resolve(value);
    };
    // a stalled synchronous read blocks the whole helper: the cap and the caller's abort end it (and every request it carried) for good
    const onAbort = (): void => { finish(null); this.#end(child); };
    const timer = setTimeout(onAbort, this.#cap);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    this.#pending.set(id, finish);
    try { child.stdin!.write(`${JSON.stringify({ id, request })}\n`); } catch { onAbort(); }
  });

  dispose(): void {
    this.#disposed = true;
    const child = this.#child;
    this.#child = null; this.#ready = false;
    this.#failPending();
    if (child) { try { child.stdin?.end(); } catch { /* gone */ } try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  }

  #end(child: ChildProcess): void { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  #failPending(): void { const pending = [...this.#pending.values()]; this.#pending.clear(); for (const settle of pending) settle(null); }
  #restartLater(): void {
    if (this.#disposed) return;
    const delay = this.#restartMs;
    this.#restartMs = Math.min(delay * 2, WARM_HELPER_RESTART_MAX_MS);
    const timer = setTimeout(() => this.start(), delay);
    timer.unref?.();
  }
}
