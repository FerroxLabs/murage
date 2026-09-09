import { randomUUID } from "node:crypto";
import { TurnResources, type TurnOwner } from "./turn-resources.ts";

export const MAX_CONCURRENT_BOT_THREADS = 3;
export type DirectThreadRun<T> = Readonly<TurnOwner & {
  botId: string;
  snapshot: T;
  phase: "setup" | "dispatching" | "running" | "stopping" | "settling";
  providerTurnId?: string;
}>;

/** A run's detached routing snapshot survives UI selection changes. Cancelling
 * retires dispatch authority immediately; resource and capacity leases remain
 * until the caller confirms provider teardown/final screen settlement. */
export class IndependentThreadRuns<T> {
  private readonly runs = new Map<string, DirectThreadRun<T>>();
  private readonly resources = new TurnResources();

  admit(botId: string, threadId: string, snapshot: T, resources: readonly string[] = []): DirectThreadRun<T> {
    if (this.runs.has(threadId)) throw conflict("thread_busy", "This thread is already running or stopping.");
    if ([...this.runs.values()].filter(run => run.botId === botId).length >= MAX_CONCURRENT_BOT_THREADS) {
      throw conflict("thread_limit", "This bot is already running three threads. Wait for one to finish.");
    }
    const copied = structuredClone(snapshot);
    const owner = { threadId, generation: randomUUID() };
    if (!this.resources.claimAll(resources, owner)) throw conflict("resource_busy", "Another thread is using this browser, computer or working folder.");
    const run: DirectThreadRun<T> = Object.freeze({ ...owner, botId, snapshot: copied, phase: "setup" });
    this.runs.set(threadId, run);
    return run;
  }

  get(threadId: string): DirectThreadRun<T> | undefined { return this.runs.get(threadId); }
  forBot(botId: string): readonly DirectThreadRun<T>[] { return [...this.runs.values()].filter(run => run.botId === botId); }
  current(owner: TurnOwner): boolean { return this.runs.get(owner.threadId)?.generation === owner.generation; }

  claim(owner: TurnOwner, resources: readonly string[]): boolean {
    const run = this.runs.get(owner.threadId);
    return Boolean(run && this.current(owner) && run.phase !== "stopping" && run.phase !== "settling" && this.resources.claimAll(resources, owner));
  }
  owns(owner: TurnOwner, resource: string): boolean { return this.current(owner) && this.resources.owns(resource, owner); }

  dispatch(owner: TurnOwner): boolean {
    const run = this.runs.get(owner.threadId);
    if (!run || !this.current(owner) || run.phase !== "setup") return false;
    this.runs.set(owner.threadId, Object.freeze({ ...run, phase: "dispatching" }));
    return true;
  }

  accepted(owner: TurnOwner, providerTurnId: string): boolean {
    const run = this.runs.get(owner.threadId);
    // A synchronous completion may already have moved to settling or removed
    // this generation before sendTurn returns. Never reactivate it here.
    if (!run || !this.current(owner) || run.phase !== "dispatching") return false;
    this.runs.set(owner.threadId, Object.freeze({ ...run, phase: "running", providerTurnId }));
    return true;
  }

  cancel(owner: TurnOwner): boolean {
    const run = this.runs.get(owner.threadId);
    if (!run || !this.current(owner)) return false;
    this.runs.set(owner.threadId, Object.freeze({ ...run, phase: "stopping" }));
    return true;
  }

  settling(owner: TurnOwner): boolean {
    const run = this.runs.get(owner.threadId);
    if (!run || !this.current(owner)) return false;
    this.runs.set(owner.threadId, Object.freeze({ ...run, phase: "settling" }));
    return true;
  }

  /** Only after teardown/final capture is confirmed. Late cleanup is harmless. */
  release(owner: TurnOwner): boolean {
    if (!this.current(owner)) return false;
    this.resources.release(owner);
    this.runs.delete(owner.threadId);
    return true;
  }
}

function conflict(code: string, message: string) { return Object.assign(new Error(message), { status: 409, code }); }

/** Old clients may omit a target only while there is exactly one direct task.
 * Always validate supplied targets; never redirect an explicit wrong target. */
export function requireDirectThreadTarget(taskIds: readonly string[], requested: unknown): string {
  if (requested === undefined) {
    if (taskIds.length !== 1) throw conflict("thread_required", "Choose a thread explicitly. Update this client to use independent threads.");
    return taskIds[0];
  }
  if (typeof requested !== "string" || !/^[\w-]+$/.test(requested)) throw Object.assign(new Error("threadId must be a task id"), { status: 400 });
  if (!taskIds.includes(requested)) throw Object.assign(new Error("No such thread for this bot."), { status: 404 });
  return requested;
}
