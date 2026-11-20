import { AsyncLocalStorage } from "node:async_hooks";
import type { IndependentThreadRuns } from "./independent-thread-runs.ts";
import type { TurnOwner } from "./turn-resources.ts";

type Scheduler = Pick<IndependentThreadRuns<unknown>, "get" | "current" | "claim" | "owns" | "releaseResources" | "subscribeChanges" | "takenCount">;
// Bound ownership reacquisition independently of the human decision time.
export const BROWSER_RESUME_TIMEOUT_MS = 5_000;
type Execution = {
  owner: TurnOwner;
  resources: readonly string[];
  releasable: readonly string[];
  questions: Set<string>;
  epoch: number;
  calls: number;
  suspended: boolean;
  snapshotRequired: boolean;
  /** Set when a wait handed the browser back: how often each releasable resource had changed hands then. The fresh-snapshot
   * fence trips only if another holder took one since (1.0.20 brsnap); an instant auto-answered ask nobody else used it in
   * leaves the page references valid. Cleared once this turn holds the browser again. */
  handedBack?: Map<string, number>;
  changed: Set<() => void>;
};
type ResumeApproval = (releaseAfter?: boolean, signal?: AbortSignal) => Promise<void>;
type BrowserCall = {
  authorized: () => boolean;
  finish: (success: boolean) => void;
  /** Only an extension open may attempt bootstrap recovery; the executor must
   * verify about:blank on its live document before allowing that navigation. */
  bootstrapOnly: boolean;
  within: <T>(work: () => T) => T;
};
/** What is known of the engine side of a run that holds the browser (BROWSERQ-1020, MAIN ruling). */
export type TurnGoneEvidence = {
  /** The conversation still exists. */
  conversationExists: boolean;
  threadId: string;
  providerTurnId?: string;
  /** The engine that ran the turn, when it is still registered. */
  adapter?: { knowsTurnClose?(threadId: string, turnId: string): boolean | undefined; turnChildTracked?(threadId: string, turnId: string): boolean };
};
/** True only on positive evidence that nothing of the turn is left to use the browser: its conversation was deleted, or its engine
 * says outright that it holds no child of that exact turn (knowsTurnClose false, else turnChildTracked false: contracts.ts). An
 * engine that is gone, has no close watch or does not answer is UNKNOWN, and unknown keeps the holder. */
export function turnGone(evidence: TurnGoneEvidence): boolean {
  if (!evidence.conversationExists) return true;
  const turnId = evidence.providerTurnId;
  if (!turnId || !evidence.adapter) return false;
  const knows = evidence.adapter.knowsTurnClose?.(evidence.threadId, turnId);
  if (knows !== undefined) return knows === false;
  return evidence.adapter.turnChildTracked?.(evidence.threadId, turnId) === false;
}
export class BrowserExecutionRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/** Execution reservations only. Selection leases, explicit owner holds and
 * protected pages belong to their existing controllers and survive suspension. */
export class BrowserTurnExecution {
  private readonly entries = new Map<string, Execution>();
  /** Entries whose browser use ended (forgetThread) while their run still holds the claims: kept only until those go back. */
  private readonly ended = new Map<string, Execution>();
  /** Positive evidence that a run past its live phases is gone (turnGone). Absent or false is unknown: the holder is kept. */
  gone?: (owner: TurnOwner) => boolean;
  private readonly runs: Scheduler;
  private readonly call = new AsyncLocalStorage<{ threadId: string; suspend: (requestId: string) => ResumeApproval }>();
  /** Called only at an extension card's await boundary, before browser work
   * resumes. Async context identifies the one parked RPC, never every call in
   * the thread. Unrelated in-flight calls still have to drain. */
  approvalWaiting(threadId: string, requestId: string): ResumeApproval | undefined {
    const call = this.call.getStore();
    return call?.threadId === threadId ? call.suspend(requestId) : undefined;
  }
  constructor(runs: Scheduler) {
    this.runs = runs;
    // BROWSERQ-1020 (MAIN ruling): a run that can make no browser call any more (current) gives the profile back to the turns in
    // line when the owner stopped it, or on positive evidence that it is gone; anything else is unknown and keeps it. The scheduler
    // tells every phase change and looks again every 30 s while a turn waits. Folder and computer leases are not touched here.
    runs.subscribeChanges(() => { for (const entry of [...this.entries.values(), ...this.ended.values()]) this.drain(entry); });
  }

  register(owner: TurnOwner, resources: readonly string[], releasable: readonly string[]): void {
    // Replaced, not released: the same generation registering again keeps the claims it has just taken.
    this.remove(owner.threadId);
    this.entries.set(owner.threadId, { owner, resources: [...resources], releasable: [...releasable], questions: new Set(), epoch: 0, calls: 0, suspended: false, snapshotRequired: false, changed: new Set() });
  }
  forget(owner: TurnOwner): void { this.forgetThread(owner.threadId, owner.generation); }
  /** The turn's browser use is over (Stop, turn end, engine reload): nothing can call the browser for it again. A stopped run's
   * browser claims go back now, whenever the run itself is released; another run's stay until it is stopped, proven gone or
   * released (BROWSERQ-1020). A call still in flight hands them back as it finishes. */
  forgetThread(threadId: string, generation?: string): void {
    const entry = this.remove(threadId, generation);
    if (!entry) return;
    this.ended.set(threadId, entry);
    this.drain(entry);
  }
  private remove(threadId: string, generation?: string): Execution | undefined {
    const entry = this.entries.get(threadId);
    if (!entry || (generation !== undefined && entry.owner.generation !== generation)) return undefined;
    this.entries.delete(threadId);
    this.changed(entry);
    return entry;
  }
  private changed(entry: Execution): void { for (const listener of [...entry.changed]) listener(); }
  private current(entry: Execution): boolean {
    const run = this.runs.get(entry.owner.threadId);
    return this.entries.get(entry.owner.threadId) === entry && run?.generation === entry.owner.generation
      && run.phase !== "stopping" && run.phase !== "settling" && run.phase !== "rebuilding";
  }
  waiting(owner: TurnOwner, requestId: string, waiting: boolean): void {
    const entry = this.entries.get(owner.threadId);
    if (!entry || entry.owner.generation !== owner.generation || !this.current(entry)) return;
    if (waiting) {
      if (entry.questions.has(requestId)) return;
      entry.questions.add(requestId);
      // Fence synchronously, before a sibling can claim. A result from the old
      // epoch can neither reach the model nor refresh its stale page references.
      entry.epoch++;
      entry.suspended = true;
      // Marked before the drain hands anything back. An older unsettled mark is kept: it covers the longer window.
      entry.handedBack ??= new Map(entry.releasable.map(resource => [resource, this.runs.takenCount(resource)]));
      this.drain(entry);
    } else entry.questions.delete(requestId);
    this.changed(entry);
    // Lazy reacquisition: an answer alone never reserves an idle browser again.
  }
  /** Hands the browser back, with no call in flight, when the turn waits for the person, or when it can make no browser call any
   * more (its run left the live phases, or its browser use was ended) AND the owner stopped it or it is proven gone. A forgotten
   * entry never releases what a newer entry of the same generation holds. */
  private drain(entry: Execution): void {
    if (entry.calls !== 0) return;
    const threadId = entry.owner.threadId;
    const forget = () => { if (this.ended.get(threadId) === entry) this.ended.delete(threadId); };
    const run = this.runs.get(threadId);
    const registered = this.entries.get(threadId);
    // the run was released or replaced, or the same turn registered again: nothing of this entry's is left to hand back
    if (run?.generation !== entry.owner.generation || (registered !== entry && registered?.owner.generation === entry.owner.generation)) { forget(); return; }
    const live = run.phase !== "stopping" && run.phase !== "settling" && run.phase !== "rebuilding";
    if (registered === entry && live) {
      if (entry.suspended) this.runs.releaseResources(entry.owner, entry.releasable);
      return;
    }
    // Stop is the owner's own release and always works; without it only positive evidence does, and never for a live run.
    if (run.phase === "stopping" || (!live && this.proven(entry.owner))) {
      this.runs.releaseResources(entry.owner, entry.releasable);
      forget();
    }
  }
  /** Called just before this turn claims again: anyone else having held a handed-back resource since makes its page
   * references and approvals stale, so the step needs a fresh snapshot first. */
  private settleHandBack(entry: Execution): void {
    if (entry.handedBack && entry.releasable.some(resource => this.runs.takenCount(resource) !== entry.handedBack!.get(resource))) entry.snapshotRequired = true;
  }
  private proven(owner: TurnOwner): boolean {
    try { return this.gone?.(owner) === true; } catch { return false; }
  }
  begin(owner: TurnOwner, method: string, name?: string, passive = false, extension = false, signal?: AbortSignal): BrowserCall {
    const entry = this.entries.get(owner.threadId);
    if (signal?.aborted || !entry || entry.owner.generation !== owner.generation || !this.current(entry)) {
      throw new BrowserExecutionRefusal("browser_not_authorized", "This browser turn has ended.");
    }
    if (entry.questions.size) throw new BrowserExecutionRefusal("browser_waiting_for_owner", "This conversation is waiting for your answer. Its browser is available to other conversations until you answer.");
    if (entry.suspended && entry.calls) throw new BrowserExecutionRefusal("browser_draining", "The previous browser step is still finishing. Try again after it finishes.");
    if (passive && entry.suspended) throw new BrowserExecutionRefusal("browser_snapshot_required", "Browser preview is paused until this conversation takes a fresh snapshot.");
    this.settleHandBack(entry);
    const snapshot = method === "tools/call" && name === "agent_browser_snapshot";
    const bootstrapOnly = entry.snapshotRequired && extension && method === "tools/call" && name === "agent_browser_open";
    if (entry.snapshotRequired && method === "tools/call" && !snapshot && !bootstrapOnly) {
      throw new BrowserExecutionRefusal("browser_snapshot_required", "The browser was released while waiting for your answer. Take a fresh browser snapshot and reconsider the step; previous page references and approvals are stale.");
    }
    // Claim atomically without releasing unrelated computer/folder resources.
    // If busy, return a plain reason; a retry must revalidate this generation.
    if (!this.runs.claim(owner, entry.resources)) throw new BrowserExecutionRefusal("browser_busy_sibling", "Another conversation is using this bot's browser. Try the browser snapshot again after it finishes; you can check the Browser panel.");
    entry.suspended = false;
    entry.handedBack = undefined;
    let epoch = entry.epoch;
    entry.calls++;
    let finished = false, counted = true;
    const authorized = () => !signal?.aborted && !finished && counted && this.current(entry) && entry.epoch === epoch && !entry.questions.size
      && entry.resources.every(resource => this.runs.owns(owner, resource));
    const suspend = (requestId: string): ResumeApproval => {
      if (!authorized()) throw new BrowserExecutionRefusal("browser_not_authorized", "This browser turn has ended.");
      this.waiting(owner, requestId, true);
      // Nothing is executing in this RPC while it awaits its card. Preserve its
      // stack and approval binding, but remove it from the active-call drain.
      counted = false;
      entry.calls--;
      this.drain(entry);
      let resuming: Promise<void> | undefined;
      return (releaseAfter = false, approvalSignal?: AbortSignal) => resuming ??= (async () => {
        this.waiting(owner, requestId, false);
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const signals = new Set([signal, approvalSignal].filter((value): value is AbortSignal => !!value));
          const finishWait = (error?: BrowserExecutionRefusal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe(); entry.changed.delete(attempt);
            for (const source of signals) source.removeEventListener("abort", attempt);
            if (error) reject(error); else resolve();
          };
          const attempt = () => {
            if (settled) return;
            if (finished || !this.current(entry) || [...signals].some(source => source.aborted)) {
              finishWait(new BrowserExecutionRefusal("browser_not_authorized", "This browser turn or request has ended."));
              return;
            }
            // Atomic claim keeps unrelated screen/folder ownership intact.
            if (entry.questions.size || entry.calls) return;
            this.settleHandBack(entry);
            if (!this.runs.claim(owner, entry.resources)) return;
            // Claim and authority restoration are synchronous: another notified
            // continuation cannot also enter before this one is counted.
            epoch = entry.epoch;
            entry.suspended = releaseAfter;
            // Still to be handed back after this step: the mark restarts from this turn's own claim.
            entry.handedBack = releaseAfter ? new Map(entry.releasable.map(resource => [resource, this.runs.takenCount(resource)])) : undefined;
            counted = true;
            entry.calls++;
            finishWait();
          };
          const unsubscribe = this.runs.subscribeChanges(attempt);
          entry.changed.add(attempt);
          const timer = setTimeout(() => finishWait(new BrowserExecutionRefusal("browser_resume_timeout",
            "This browser step timed out while waiting to resume. The step was not run. Any unanswered approval card remains available. Do not retry automatically; continue after the other conversation finishes.")), BROWSER_RESUME_TIMEOUT_MS);
          timer.unref?.();
          for (const source of signals) source.addEventListener("abort", attempt, { once: true });
          attempt();
        });
      })();
    };
    return { authorized, bootstrapOnly, within: work => this.call.run({ threadId: owner.threadId, suspend }, work), finish: success => {
      if (finished) return;
      if (success && snapshot && authorized()) entry.snapshotRequired = false;
      finished = true;
      if (counted) entry.calls--;
      counted = false;
      this.drain(entry);
      this.changed(entry);
    } };
  }
}
