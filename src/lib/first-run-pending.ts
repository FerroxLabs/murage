// FIRSTRUN-1019 D2 (ruling 4, Sean 2026-11-09, "all ticked jobs get set up").
//
// The first ticked job runs in the chat as it always did (the `chat` note stays exactly one job id, guard 4). Every
// other ticked job waits in owner-prefs `firstRunJobs.pending` and is started AUTOMATICALLY, in order, one at a time,
// when the one before it has finished: the same explicit ask as a message to the Chief (FIRST_RUN_JOB_ASK), sent first,
// removed from the queue only once the server has accepted it. A crash in between offers the job once more and never
// loses it. A refused job shows its line and the rest keep going. This module is the pure half; the hook is
// src/components/today/use-pending-jobs.ts.

import { FIRST_RUN_COPY, FIRST_RUN_JOB_ASK } from "./first-run-copy";
import { FIRST_RUN_JOB_IDS, type FirstRunJobId } from "./first-run-jobs";
import { newSendId } from "./send-id";

export const PENDING_JOBS_PATH = "/api/owner/first-run-jobs";
export type PendingRequest = (path: string, init?: { method?: string; body?: string }) => Promise<any>;

/** Only known ids, no repeats, table order not required. */
export function sanitizeJobs(value: unknown): FirstRunJobId[] {
  if (!Array.isArray(value)) return [];
  const out: FirstRunJobId[] = [];
  for (const id of value) {
    if ((FIRST_RUN_JOB_IDS as readonly unknown[]).includes(id) && !out.includes(id as FirstRunJobId)) out.push(id as FirstRunJobId);
  }
  return out;
}

/** The ticked ids in the order the jobs are offered. */
export function inTableOrder(ticked: Iterable<FirstRunJobId>): FirstRunJobId[] {
  const set = new Set(ticked);
  return FIRST_RUN_JOB_IDS.filter((id) => set.has(id));
}

export function jobTitle(id: FirstRunJobId): string {
  return FIRST_RUN_COPY.chat.jobs.rows.find((row) => row.id === id)?.title ?? id;
}

/** The queue as the server holds it, or null when the read failed: a failed read is NOT an empty queue, so the caller retries. */
export async function readPendingJobs(request: PendingRequest): Promise<FirstRunJobId[] | null> {
  try {
    const answer = await request(PENDING_JOBS_PATH);
    return Array.isArray(answer?.pending) ? sanitizeJobs(answer.pending) : null;
  } catch {
    return null;
  }
}

export async function writePendingJobs(request: PendingRequest, ids: readonly FirstRunJobId[]): Promise<FirstRunJobId[]> {
  const answer = await request(PENDING_JOBS_PATH, { method: "POST", body: JSON.stringify({ pending: ids }) });
  return sanitizeJobs(answer?.pending);
}

/** The first pending job that has not already failed to start in this session. */
export function nextToStart(ids: readonly FirstRunJobId[], failed: ReadonlySet<FirstRunJobId>): FirstRunJobId | null {
  return ids.find((id) => !failed.has(id) && !accepted.has(id)) ?? null;
}

/** How long after a send is accepted the Chief may still be about to look busy. */
export const QUEUE_SETTLE_MS = 6_000;

export interface QueueGate {
  /** The first job has finished (its flow step is done or passed over, or there is no first run). */
  firstJobFinished: boolean;
  chiefBusy: boolean;
  /** A send is in flight right now. */
  sending: boolean;
  /** When the last accepted send was, or 0. */
  acceptedAt: number;
  /** The Chief has been seen busy since that send. */
  sawBusySince: boolean;
  now: number;
}

/** One at a time: nothing starts while the Chief is working, a send is out, or the last one has not yet had time to start. */
export function canStartNext(gate: QueueGate): boolean {
  if (!gate.firstJobFinished || gate.chiefBusy || gate.sending) return false;
  if (gate.acceptedAt > 0 && !gate.sawBusySince && gate.now - gate.acceptedAt < QUEUE_SETTLE_MS) return false;
  return true;
}

/**
 * Start one pending job: send its ask, and only when the server has accepted it, take it off the queue. A refused send
 * rejects and leaves the queue exactly as it was. Returns the queue as the server now holds it.
 */
export async function startPendingJob(
  id: FirstRunJobId,
  deps: { send(text: string, sendId: string): Promise<void>; request: PendingRequest; onAccepted?: () => void; retryDelayMs?: number },
): Promise<FirstRunJobId[]> {
  // The send id is stable for the job: a retry after an unanswered send carries the same id, which the server de-duplicates.
  await deps.send(FIRST_RUN_JOB_ASK[id], sendIdFor(id));
  // ACCEPTANCE IS RECORDED THE MOMENT THE SEND IS ACCEPTED, before anything else can fail. From here the job is sent: it is
  // never scheduled again and never restored by any queue snapshot (a Stop response, a read), a failed removal is retried
  // (only the removal, serialized with every other change), and if it keeps failing the job still leaves this session's
  // queue. The server copy then offers it once more after a restart, which is the documented worst case.
  accepted.add(id);
  deps.onAccepted?.();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const rest = await mutatePending(deps.request, (queue) => withoutJob(queue, id));
      sendIds.delete(id);
      return rest;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, (deps.retryDelayMs ?? 400) * (attempt + 1)));
    }
  }
  return serialized(async () => {
    setPendingLocal(withoutJob(current, id), false);
    return [...current];
  });
}

/** One change at a time, each starting from the one before. */
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work);
  chain = run.catch(() => undefined);
  return run;
}

/** Jobs whose send the server has accepted this session: never started again, never put back by a snapshot. */
const accepted = new Set<FirstRunJobId>();
const sendIds = new Map<FirstRunJobId, string>();
export function sendIdFor(id: FirstRunJobId): string {
  let found = sendIds.get(id);
  if (!found) {
    found = newSendId();
    sendIds.set(id, found);
  }
  return found;
}
export function forgetSendId(id: FirstRunJobId): void {
  sendIds.delete(id);
}
export function resetPendingForTests(): void {
  accepted.clear();
  sendIds.clear();
  chain = Promise.resolve();
  current = [];
  loaded = false;
}

/**
 * Every change to the queue goes through here, one at a time, each computed from the queue as the one before left it. So
 * "a job was accepted" and "Stop on another job" can never write each other's stale list back: whichever runs second
 * starts from the first one's result.
 */
let chain: Promise<unknown> = Promise.resolve();
export function mutatePending(request: PendingRequest, update: (queue: readonly FirstRunJobId[]) => FirstRunJobId[]): Promise<FirstRunJobId[]> {
  return serialized(async () => {
    const next = await writePendingJobs(request, update(current));
    setPendingLocal(next);
    return [...current];
  });
}

/** Stop removes one job from the queue and nothing else. */
export function withoutJob(ids: readonly FirstRunJobId[], id: FirstRunJobId): FirstRunJobId[] {
  return ids.filter((entry) => entry !== id);
}

// ── one shared copy of the queue for every mounted reader ───────────────
let current: FirstRunJobId[] = [];
let loaded = false;
const listeners = new Set<(ids: readonly FirstRunJobId[]) => void>();

export function pendingNow(): readonly FirstRunJobId[] {
  return current;
}
export function pendingLoaded(): boolean {
  return loaded;
}
/** `confirmed`: the list is the server's own answer, so an accepted job missing from it is really gone and is forgotten. */
export function setPendingLocal(ids: readonly FirstRunJobId[], confirmed = true): void {
  if (confirmed) for (const id of [...accepted]) if (!ids.includes(id)) accepted.delete(id);
  current = ids.filter((id) => !accepted.has(id));
  loaded = true;
  for (const listener of listeners) listener(current);
}
export function subscribePending(listener: (ids: readonly FirstRunJobId[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
