// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Forget on delete (FLUX-SPACES-CAPTURE-FORGET-106 R4). A deleted conversation is forgotten in every bot space it was captured
// to: POST /v1/memory/spaces/{space}/forget {"thread": tag}, then GET /v1/memory/operations/{id} until it is done. A deleted bot's
// space is deleted: DELETE /v1/memory/spaces/{space} (a hard shred), then the same poll. The obligation is a row in flux_mem_owed
// written in the deletion's own transaction (owner-deletions.ts recordOwnerDeletion), so it survives a crash or a restart:
// `start()` resumes every row.
//
// While forget-by-thread is not live (400/404/405/422), the receipted captures are forgotten by id (<= 100 per call), and the row
// stays owed (hourly) until a thread forget answers: only that covers a capture whose receipt a crash lost (R4.7).
// A row is bound forever to the key it was captured with: another key sends nothing (another account's answer proves nothing).
// A 409 latches "Flux Memory is off" for that key (no more capture) and the forget keeps going on the slow cadence.
import type { DatabaseSync } from "node:sqlite";
import { fluxUsageHeaders } from "./flux-usage-tags.ts";

import { FLUX_MEMORY_API_BASE } from "./flux-memory-capture.ts";
import { FLUX_MEMORY_APP, FLUX_MEMORY_APP_HEADER } from "./flux-memory-wire.ts";
import {
  dropFluxReceipts, dueFluxForgets, finishFluxForget, fluxKeyFingerprint, fluxThreadReceipts, nextFluxForgetAt, setFluxKeyOff, updateFluxForget,
  type FluxForgetRow,
} from "./flux-memory-spaces.ts";

/** DELETE backoff by attempts, then SLOW_MS. */
export const FORGET_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
/** Poll backoff by polls, then POLL_CAP_MS. */
export const POLL_BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000] as const;
export const POLL_CAP_MS = 30 * 60_000;
export const SLOW_MS = 6 * 60 * 60_000;
export const NO_KEY_MS = 10 * 60_000;
export const BUSY_MS = 10_000;
export const ERROR_MS = 60_000;
export const FORGET_TIMEOUT_MS = 30_000;
/** Forget-by-thread not live yet: the row is tried again this often (the ids fallback runs each time). */
export const FALLBACK_MS = 60 * 60_000;
/** The ids fallback sends at most this many source ids per call. */
export const FALLBACK_BATCH = 100;
const OP_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const BODY_MAX = 65_536;

export interface FluxForgetDeps {
  db: () => DatabaseSync;
  key: () => string | null;
  /** A capture for the row's thread (a thread row) or of the row's bot (a bot row) is in flight or within its grace
   * (flux-memory-capture.ts busy / botBusy). */
  busy: (row: FluxForgetRow) => boolean;
  fetch?: typeof globalThis.fetch;
  dispatcher?: (url: string) => unknown;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  log?: (line: string) => void;
}

interface Answer { status: number; body: unknown }

const backoff = (list: readonly number[], index: number, cap: number): number => list[index] ?? cap;

/** Tolerant reading of FluxMain's answers (section 6); the shape is pinned again when the spaces PR lands. */
export function readOperation(body: unknown): { id: string | null; status: "completed" | "failed" | "pending" | "already_deleted" } {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const nested = value.operation && typeof value.operation === "object" ? value.operation as Record<string, unknown> : {};
  const rawId = value.operation_id ?? value.id ?? nested.id;
  const id = typeof rawId === "string" && OP_ID.test(rawId) ? rawId : null;
  const rawStatus = String(value.status ?? value.state ?? nested.status ?? "").toLowerCase();
  // flux-router PR #492: an erasure request is 'pending', 'done' or 'failed'; a DELETE of a space already gone answers 'already_deleted'
  const status = rawStatus === "done" || rawStatus === "completed" || rawStatus === "succeeded" ? "completed"
    : rawStatus === "already_deleted" ? "already_deleted"
    : rawStatus === "failed" || rawStatus === "error" ? "failed" : "pending";
  return { id, status };
}

export function errorCode(body: unknown): string | null {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const error = value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : {};
  const code = error.code ?? value.code;
  return typeof code === "string" ? code : null;
}

export class FluxMemoryForget {
  private readonly deps: FluxForgetDeps;
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  // No parameter property: the server runs under Node type stripping.
  constructor(deps: FluxForgetDeps) { this.deps = deps; }

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private log(line: string): void { try { (this.deps.log ?? console.info)(line); } catch { /* ignore */ } }

  /** At boot: every row a crash or a restart left behind is resumed. */
  start(): Promise<void> { this.stopped = false; return this.tick(); }

  /** A deletion was recorded (onOwnerDeletion) or the key changed: look again soon. */
  poke(): void { if (!this.stopped) this.arm(0); }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) (this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  private arm(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== null) (this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    const set = this.deps.setTimer ?? ((run: () => void, delay: number) => { const t = setTimeout(run, delay); (t as { unref?: () => void }).unref?.(); return t; });
    this.timer = set(() => { this.timer = null; void this.tick(); }, Math.max(0, ms));
  }

  /** One pass over the due rows. Only one pass runs at a time; a poke during it runs another after it. */
  tick(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && !this.stopped);
      } finally {
        this.running = null;
        this.rearm();
      }
    })();
    return this.running;
  }

  private rearm(): void {
    if (this.stopped) return;
    try {
      const db = this.deps.db();
      const at = nextFluxForgetAt(db);
      if (at === null) return;
      this.arm(at - this.now());
    } catch {
      this.arm(ERROR_MS);
    }
  }

  private async pass(): Promise<void> {
    let rows: FluxForgetRow[];
    try { rows = dueFluxForgets(this.deps.db(), this.now()); } catch { return; }
    for (const row of rows) {
      if (this.stopped) return;
      try { await this.step(row); }
      catch {
        // a database or parse error leaves the row as it was, due again soon
        try { updateFluxForget(this.deps.db(), row, { nextAt: this.now() + ERROR_MS }); } catch { /* the next pass sees it */ }
      }
    }
  }

  private async request(method: "DELETE" | "GET" | "POST", url: string, key: string, payload?: unknown, row?: FluxForgetRow): Promise<Answer> {
    const doFetch = this.deps.fetch ?? globalThis.fetch;
    try {
      const response = await doFetch(url, {
        method,
        headers: { authorization: `Bearer ${key}`, [FLUX_MEMORY_APP_HEADER]: FLUX_MEMORY_APP, ...fluxUsageHeaders({ feature: "memory", botId: row?.botId, threadId: row?.threadId }), ...(payload === undefined ? {} : { "content-type": "application/json" }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        redirect: "manual",
        signal: AbortSignal.timeout(FORGET_TIMEOUT_MS),
        ...(this.deps.dispatcher ? { dispatcher: this.deps.dispatcher(url) } : {}),
      } as RequestInit);
      let body: unknown = null;
      try {
        const text = await response.text();
        body = text.length <= BODY_MAX ? JSON.parse(text) : null;
      } catch { body = null; }
      return { status: response.status, body };
    } catch {
      return { status: 0, body: null };
    }
  }

  private async step(row: FluxForgetRow): Promise<void> {
    const db = this.deps.db();
    const now = this.now();
    const key = this.deps.key();
    if (!key) { updateFluxForget(db, row, { nextAt: now + NO_KEY_MS }); return; }
    const fp = fluxKeyFingerprint(key);
    // bound to the key it was captured with: another key sends nothing
    if (fp !== row.keyFp) { updateFluxForget(db, row, { nextAt: now + SLOW_MS, lastStatus: -1 }); return; }
    // a capture of this thread (or of this bot, anywhere) in flight: wait until it settles, then the grace
    if (this.deps.busy(row)) { updateFluxForget(db, row, { nextAt: now + BUSY_MS }); return; }
    const retry = (at: number, status: number) => updateFluxForget(db, row, { state: "owed", opId: null, attempts: row.attempts + 1, nextAt: at + backoff(FORGET_BACKOFF_MS, row.attempts, SLOW_MS), lastStatus: status });
    const done = (status: number | string) => { finishFluxForget(db, row); this.log(`[flux] memory-forget ok kind=${row.kind} status=${status}`); };

    if (row.state === "polling" && row.opId) {
      const answer = await this.request("GET", `${FLUX_MEMORY_API_BASE}/operations/${encodeURIComponent(row.opId)}`, key, undefined, row);
      const at = this.now();
      if (answer.status === 409) {
        setFluxKeyOff(db, fp, errorCode(answer.body), at);
        updateFluxForget(db, row, { nextAt: at + SLOW_MS, lastStatus: 409 });
        return;
      }
      // the operation is unknown: owed again, one forget backoff step (no spin)
      if (answer.status === 404) { retry(at, 404); return; }
      if (answer.status >= 200 && answer.status < 300) {
        const op = readOperation(answer.body);
        if (op.status === "completed" || op.status === "already_deleted") { done("poll"); return; }
        if (op.status === "failed") { retry(at, answer.status); return; }
      }
      updateFluxForget(db, row, { polls: row.polls + 1, nextAt: at + backoff(POLL_BACKOFF_MS, row.polls, POLL_CAP_MS), lastStatus: answer.status });
      return;
    }

    const spaceUrl = `${FLUX_MEMORY_API_BASE}/spaces/${encodeURIComponent(row.space)}`;
    const answer = row.kind === "bot"
      ? await this.request("DELETE", spaceUrl, key, undefined, row)
      : await this.request("POST", `${spaceUrl}/forget`, key, { thread: row.threadTag }, row);
    const at = this.now();
    const code = errorCode(answer.body);
    if (answer.status >= 200 && answer.status < 300) {
      const op = readOperation(answer.body);
      // the row's own key was told it is gone, or a replayed request already finished: done
      if (op.status === "already_deleted" || op.status === "completed") { done(answer.status); return; }
      if (op.id && op.status === "failed") { retry(at, answer.status); return; }
      if (op.id) {
        updateFluxForget(db, row, { state: "polling", opId: op.id, polls: 0, nextAt: at + POLL_BACKOFF_MS[0], lastStatus: answer.status });
        this.log(`[flux] memory-forget waiting kind=${row.kind} status=${answer.status}`);
        return;
      }
      // a success with no operation id proves nothing: ask again
      retry(at, answer.status);
      return;
    }
    // the row's own space is gone for the row's own key: done
    if (answer.status === 404 && code === "memory_not_found") { done(404); return; }
    if (answer.status === 409 && row.kind === "thread" && code === "memory_thread_forgotten") { done("409 thread_forgotten"); return; }
    if (answer.status === 409) {
      setFluxKeyOff(db, fp, code, at);
      updateFluxForget(db, row, { nextAt: at + SLOW_MS, lastStatus: 409 });
      this.log("[flux] memory-forget waiting status=409");
      return;
    }
    const transient = answer.status === 0 || answer.status === 408 || answer.status === 429 || answer.status >= 500 || (answer.status >= 300 && answer.status < 400);
    if (transient) { retry(at, answer.status); return; }
    if (row.kind === "thread" && (answer.status === 400 || answer.status === 404 || answer.status === 405 || answer.status === 422)) {
      // forget-by-thread is not live: the receipted captures are forgotten by id; the row stays owed for the thread forget
      await this.fallback(row, key, answer.status);
      return;
    }
    // other 4xx (401, 403, a DELETE refused by an older proxy): the slow cadence
    updateFluxForget(db, row, { nextAt: at + SLOW_MS, lastStatus: answer.status });
    this.log(`[flux] memory-forget waiting kind=${row.kind} status=${answer.status}`);
  }

  /** The ids fallback (R4.4): receipts of (space, key, thread) in batches of 100. The row is never DONE from here (R4.7). */
  private async fallback(row: FluxForgetRow, key: string, status: number): Promise<void> {
    const db = this.deps.db();
    const url = `${FLUX_MEMORY_API_BASE}/spaces/${encodeURIComponent(row.space)}/forget`;
    for (;;) {
      if (this.stopped) return;
      const ids = fluxThreadReceipts(db, row, FALLBACK_BATCH);
      if (ids.length === 0) break;
      const answer = await this.request("POST", url, key, { source_ids: ids }, row);
      const code = errorCode(answer.body);
      // the main path's 409 policy (Astra M2): a forgotten thread is done; any other 409 latches Flux Memory off for the key and
      // the row goes on the slow cadence
      if (answer.status === 409 && code === "memory_thread_forgotten") {
        finishFluxForget(db, row);
        this.log("[flux] memory-forget ok kind=thread status=409 thread_forgotten");
        return;
      }
      if (answer.status === 409) {
        const at = this.now();
        setFluxKeyOff(db, row.keyFp, code, at);
        updateFluxForget(db, row, { nextAt: at + SLOW_MS, lastStatus: 409 });
        this.log("[flux] memory-forget waiting status=409");
        return;
      }
      // the receipts go only when Flux says those captures are forgotten: 200, or 410 / already_deleted. A 202 (accepted, not yet
      // done) or any other 2xx proves nothing, so the receipts stay and the batch is asked again after a backoff
      const ok = answer.status === 200 || answer.status === 410 || code === "already_deleted"
        || (answer.status >= 200 && answer.status < 300 && readOperation(answer.body).status === "already_deleted");
      if (!ok) {
        const at = this.now();
        updateFluxForget(db, row, { attempts: row.attempts + 1, nextAt: at + backoff(FORGET_BACKOFF_MS, row.attempts, SLOW_MS), lastStatus: answer.status });
        return;
      }
      dropFluxReceipts(db, row, ids);
    }
    const at = this.now();
    updateFluxForget(db, row, { nextAt: at + FALLBACK_MS, lastStatus: status, fallbackAt: at });
    this.log(`[flux] memory-forget fallback status=${status}`);
  }
}
