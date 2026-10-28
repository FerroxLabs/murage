// 1.0.9 share and ask: which phone's ask started which turn, and which queued starts are still entitled to run.
//
// The asking phone is keyed by the turn's generation, never by the thread: a later batch on the same thread must not be able to
// overwrite the device a still-pending earlier turn will push its reply to. A queued start is one attempt at admission: a refusal because
// the thread is taken sends its rows back into the queue in place (steer-queue.ts), so no line is dropped and none is passed.

import { START_REQUEUE } from "./steer-queue.ts";

const MAX_TURNS = 1_000;

export class AskTurnDevices {
  private readonly byGeneration = new Map<string, { threadId: string; deviceId: string }>();

  /** Record the phone whose ask started this turn (its generation). */
  set(generation: string, threadId: string, deviceId: string): void {
    if (this.byGeneration.size >= MAX_TURNS) this.byGeneration.delete(this.byGeneration.keys().next().value!);
    this.byGeneration.set(generation, { threadId, deviceId });
  }

  /** Taken by that turn's own end (done, failed or stopped); a second take finds nothing. */
  take(generation: string): string | undefined {
    const found = this.byGeneration.get(generation);
    this.byGeneration.delete(generation);
    return found?.deviceId;
  }

  /** A turn that never started is forgotten. */
  drop(generation: string): void { this.byGeneration.delete(generation); }

  forgetThreads(threadIds: Iterable<string>): void {
    const gone = new Set(threadIds);
    for (const [generation, entry] of this.byGeneration) if (gone.has(entry.threadId)) this.byGeneration.delete(generation);
  }
}

/** Refusals that mean the thread is taken right now: a direct run on it (thread_busy), its bot speaking in a room (room_busy), the bot at
 * its thread limit (thread_limit), or a browser, computer or folder another thread holds (resource_busy). */
export const OCCUPIED_REFUSALS: ReadonlySet<string> = new Set(["thread_busy", "room_busy", "thread_limit", "resource_busy"]);
/** Refusals that pass by themselves: engines still starting, a provider fence, a files restore, a busy database, a prepared restart, a thread fill that outlasted its deadline. */
export const TRANSIENT_REFUSALS: ReadonlySet<string> = new Set(["engine_starting", "provider_fenced", "files_restoring", "DATABASE_BUSY", "BACKUP_RESTART_PREPARED", "prepare_timeout"]);

/** "wait": the line stays queued and is tried again. "fail": a refusal of its own, shown as could-not-start. A coded refusal is judged by
 * its code alone. A conflict with no code counts as busy when the thread is held at that moment, whatever its words; anything else fails. */
export function classifyStartRefusal(error: unknown, occupiedNow: boolean): "wait" | "fail" {
  const refusal = error as { code?: unknown; status?: unknown } | null | undefined;
  const code = typeof refusal?.code === "string" ? refusal.code : undefined;
  if (code !== undefined) return OCCUPIED_REFUSALS.has(code) || TRANSIENT_REFUSALS.has(code) ? "wait" : "fail";
  return refusal?.status === 409 && occupiedNow ? "wait" : "fail";
}

/** How long a queued start waits for the thread's fill (store.prepareThread) before it gives the thread back and tries again. */
export const PREPARE_DEADLINE_MS = 60_000;

/** Wait for `work`, at most `ms`. On the deadline this rejects with the coded wait refusal `prepare_timeout`; the work itself is left to
 * finish on its own (a fill is shared and idempotent) and its late result is ignored, so it can never start anything. */
function within(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("The thread is still being prepared. Trying again shortly."), { status: 409, code: "prepare_timeout" })), ms);
    work.then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export interface QueuedStartPlan {
  /** The wait startTurn would make for the thread's fill before admission, bounded here by PREPARE_DEADLINE_MS. `start` runs only after it
   * settles in time, so an attempt that timed out can never admit a turn later. */
  prepare?: () => Promise<unknown>;
  /** Builds the prompt and starts the turn; resolves once the turn is admitted. A throw while building is a failure like any other. */
  start: () => Promise<unknown>;
  /** True while a turn holds the thread (read at the refusal, to judge a conflict that carries no code). */
  occupied: () => boolean;
  /** A start that failed for a reason other than the thread being taken: the line stays, and says it could not start. */
  onFail: (error: unknown) => void;
}

/** One attempt at a drained batch. The busy check is the one startTurn makes in the same tick as admission, so there is no gap between
 * checking and taking the thread. A refusal because the thread is taken resolves START_REQUEUE (the drain puts the rows back in place and
 * tries again); any other refusal is shown once. Never rejects; the fill deadline timer is cleared when the wait ends. */
export async function runQueuedStart(plan: QueuedStartPlan): Promise<"started" | typeof START_REQUEUE | "failed"> {
  try {
    if (plan.prepare) await within(plan.prepare(), PREPARE_DEADLINE_MS);
    await plan.start();
    return "started";
  } catch (error) {
    let occupiedNow = true;
    try { occupiedNow = plan.occupied(); } catch { /* unknown: a conflict is then treated as busy */ }
    if (classifyStartRefusal(error, occupiedNow) === "wait") return START_REQUEUE;
    try { plan.onFail(error); } catch { /* the line is in the transcript either way */ }
    return "failed";
  }
}
