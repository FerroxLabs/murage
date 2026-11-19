import { randomUUID } from "node:crypto";
import type { ProviderAdapter } from "./contracts.ts";
import { ProjectFolderLeaseError, ProjectFolderLeases, type ProjectFolderLease } from "./project-folder-leases.ts";

export const PROJECT_TURN_TOMBSTONE_LIMIT = 4096;
const warn = (message: string) => console.warn(`[project-turn-leases] ${message}`);
/** `name: message` of a throw, without its stack or any path it might carry
 * beyond what the thrower put in the message. */
export const describeThrow = (error: unknown): string => {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === "string" ? error : Object.prototype.toString.call(error);
};
/** What releaseStopHeld reads of the engine that ran the turn. */
export type StopHeldEvidence = Pick<ProviderAdapter, "awaitTurnTeardown" | "awaitTurnClose" | "turnChildTracked" | "knowsTurnClose">;
interface TurnLease {
  threadId: string;
  dispatched: boolean;
  providerKey?: string;
  outputOwnerId?: string;
  additionalOwnerIds?: string[];
  /** The host asked the engine to stop this turn and no longer counts it as
   * busy. The writer lease stays until the engine's terminal event: a stop
   * is "requested, not observed" (contracts.ts) and the child may still be
   * writing while it closes. */
  stopRequested?: boolean;
  /** An owner's Stop was asked for this turn (markStopAsked), before the
   * engine answered. Durable: the turn's terminal event no longer releases
   * the writer lease on its own (an unconfirmed stop still ends the turn);
   * only the engine's confirmed close (confirmClosed) does. */
  stopAsked?: boolean | string;
  closeUnconfirmed?: boolean;
}

/** Outcome of a restore admission (STOPRESTORE1).
 * - `conflict`: a live writer, another restore, or an unusable path holds
 *   the folder — refuse at once, exactly as before.
 * - `still-closing`: every holder is a stopped turn whose engine has not
 *   released the folder within the bound — refuse, tell the user to retry.
 * - `error`: the registry threw something other than its own refusal. Not a
 *   busy folder: a caller answers as it would for an unusable path (the
 *   synchronous `acquireRestore` path has always done so), never as a
 *   writing bot. The real registry throws only `ProjectFolderLeaseError`; a
 *   test double or a later change may not. */
export type RestoreAdmission =
  | { ok: true; lease: ProjectFolderLease }
  | { ok: false; reason: "still-closing" }
  /** `code` is the registry's own refusal (`conflict`, `owner-in-use`,
   * `invalid-path`, ...) so a caller can tell a busy folder from an unusable
   * path (STOPRESTORE2: the workspace editor answers `bot-writing` for the
   * former and `root-changed` for the latter). */
  | { ok: false; reason: "conflict"; code: ProjectFolderLeaseError["code"]; closeUnconfirmed?: true }
  | { ok: false; reason: "error"; error: unknown };

/** Writer admission bookkeeping for provider generations, not an OS lock.
 * Revoking a capability does not prove that its provider stopped writing. */
export class ProjectTurnLeases {
  readonly folders = new ProjectFolderLeases();
  private readonly owners = new Map<string, TurnLease>();
  private readonly providers = new Map<string, string>();
  private readonly completed = new Set<string>();
  /** Engines of tombstoned turns no generation was bound to yet (complete). */
  private readonly completedAdapters = new Map<string, StopHeldEvidence>();
  private readonly releaseWaiters = new Set<() => void>();

  acquire(threadId: string, generation: string, cwd: string): ProjectFolderLease {
    if (!threadId) throw new Error("Project turn requires a thread");
    const existing = this.owners.get(generation);
    if (existing && existing.threadId !== threadId) throw new Error("Project generation belongs to another thread");
    const lease = this.folders.acquireWriter(generation, cwd);
    if (!existing) this.owners.set(generation, { threadId, dispatched: false });
    return lease;
  }

  /** One separate output desk may accompany the engine's retained CWD. */
  acquireOutput(threadId: string, generation: string, root: string): ProjectFolderLease {
    const owner = this.owners.get(generation);
    if (!owner || owner.threadId !== threadId || owner.dispatched) throw new Error("Output workspace requires an undispatched project turn");
    const outputOwnerId = owner.outputOwnerId ?? `output:${randomUUID()}`;
    try {
      const lease = this.folders.acquireWriter(outputOwnerId, root);
      owner.outputOwnerId = outputOwnerId;
      return lease;
    } catch (error) {
      this.abandon(generation);
      throw error;
    }
  }

  /** A structured write approval can add a root after engine dispatch. */
  acquireAdditional(threadId: string, generation: string, root: string): ProjectFolderLease & { release(): void } {
    const owner = this.owners.get(generation);
    if (!owner || owner.threadId !== threadId) throw new Error("The writing turn is no longer available");
    const id = `late:${randomUUID()}`;
    const lease = this.folders.acquireWriter(id, root);
    (owner.additionalOwnerIds ??= []).push(id);
    return { ...lease, release: () => {
      const index = owner.additionalOwnerIds?.indexOf(id) ?? -1;
      if (index < 0) return;
      owner.additionalOwnerIds!.splice(index, 1);
      this.folders.release(id);
      for (const waiter of this.releaseWaiters) waiter();
    } };
  }

  /** Call immediately before invoking sendTurn, including its async setup. */
  markDispatched(generation: string): void {
    const owner = this.owners.get(generation);
    if (owner) {
      this.folders.assertCurrent(generation);
      if (owner.outputOwnerId) this.folders.assertCurrent(owner.outputOwnerId);
      owner.dispatched = true;
    }
  }

  bind(threadId: string, generation: string, turnId: string): boolean {
    const owner = this.owners.get(generation);
    if (!owner || owner.threadId !== threadId || !turnId) return false;
    const key = JSON.stringify([threadId, turnId]);
    // Legacy instance-owned Stop callers retain their idempotent bind receipt.
    if (owner.providerKey === key && (!this.completed.has(key) || typeof owner.stopAsked === "string")) return true;
    // A provider may emit completion before sendTurn reveals its id.
    if (this.completed.has(key)) {
      // A Stop-held owner keeps its folder through a late or repeated bind:
      // only its engine's evidence (releaseStopHeld) releases it. Bound now
      // when the terminal event came first, so that evidence is read here.
      if (owner.stopAsked) {
        if (owner.providerKey === undefined && this.providers.get(key) === undefined) {
          owner.providerKey = key;
          owner.dispatched = true;
          this.providers.set(key, generation);
          const adapter = this.completedAdapters.get(key);
          this.completedAdapters.delete(key);
          this.releaseStopHeld(threadId, turnId, adapter);
        }
        return false;
      }
      this.release(generation);
      return false;
    }
    const bound = this.providers.get(key);
    if ((bound !== undefined && bound !== generation) || (owner.providerKey !== undefined && owner.providerKey !== key)) return false;
    owner.providerKey = key;
    owner.dispatched = true;
    this.providers.set(key, generation);
    return true;
  }

  /** `adapter`: the engine that ended the turn, kept with its tombstone so a
   * Stop-held generation that binds after this terminal event is released on
   * that engine's evidence (bind), not on the tombstone alone. */
  complete(threadId: string, turnId: string, adapter?: StopHeldEvidence): { heldFor: string; generation: string } | undefined {
    if (!threadId || !turnId) return;
    const key = JSON.stringify([threadId, turnId]);
    this.completed.add(key);
    while (this.completed.size > PROJECT_TURN_TOMBSTONE_LIMIT) {
      const oldest = this.completed.values().next().value!;
      this.completed.delete(oldest);
      this.completedAdapters.delete(oldest);
    }
    const generation = this.providers.get(key);
    if (generation === undefined && adapter) this.completedAdapters.set(key, adapter);
    // A turn whose Stop was asked keeps the folder past its terminal event:
    // only confirmClosed (the engine's confirmed close) releases it.
    if (generation !== undefined) {
      const heldFor = this.owners.get(generation)?.stopAsked;
      if (!heldFor) this.release(generation);
      else if (typeof heldFor === "string") return { heldFor, generation };
    }
  }

  /** The owner's Stop reached this generation's turn: set BEFORE the engine is
   * asked, so however the turn then ends (stopped, or settled as not stopped
   * when the close is unconfirmed) its writer lease is held until
   * confirmClosed. Returns whether a lease is held. */
  markStopAsked(generation: string, instanceId?: string): boolean {
    const owner = this.owners.get(generation);
    if (!owner) return false;
    owner.stopAsked = instanceId ?? true;
    return true;
  }

  /** True when this provider turn's writer lease is held by an asked Stop
   * (its terminal event alone does not release it). */
  heldByStop(threadId: string, turnId: string): boolean {
    const generation = this.providers.get(JSON.stringify([threadId, turnId]));
    return generation !== undefined && Boolean(this.owners.get(generation)?.stopAsked);
  }

  /** The engine confirmed that this provider turn's child closed: release a
   * lease an asked Stop held past the terminal event. */
  confirmClosed(threadId: string, turnId: string): void {
    const generation = this.providers.get(JSON.stringify([threadId, turnId]));
    if (generation !== undefined) this.release(generation);
  }

  /** The bounded teardown of a held turn (`complete` returned it) did not
   * confirm the close. The lease stays held; a refused writer is told that
   * the stopped turn's engine has not confirmed it closed. */
  markCloseUnconfirmed(threadId: string, turnId: string): void {
    const generation = this.providers.get(JSON.stringify([threadId, turnId]));
    const owner = generation === undefined ? undefined : this.owners.get(generation);
    if (owner?.stopAsked !== undefined) owner.closeUnconfirmed = true;
  }

  /** At a Stop-held turn's terminal event (heldByStop): release its writer
   * lease on the engine's evidence. Released at once when the adapter has no
   * teardown receipt (the terminal event is all it gives, as before) or says
   * it holds no child of this turn (turnChildTracked false: the Stop raced
   * the turn's own end or found no running turn). Otherwise released by the
   * confirmed teardown or the child's later confirmed close; a child that
   * never closes keeps the folder (fail closed), said once in the log, and
   * the owner already holds Stop's provider_stop_unconfirmed answer. */
  releaseStopHeld(threadId: string, turnId: string,
    adapter: StopHeldEvidence | undefined): void {
    const release = () => this.confirmClosed(threadId, turnId);
    if (!adapter?.awaitTurnTeardown) return release();
    if ((adapter.knowsTurnClose ? adapter.knowsTurnClose(threadId, turnId) : adapter.turnChildTracked?.(threadId, turnId)) === false) return release();
    // Captured before the bounded wait: the adapter forgets a child once it closed.
    const lateClose = adapter.awaitTurnClose?.(threadId, turnId);
    if (lateClose) void lateClose.catch(() => {});
    const retain = () => {
      this.markCloseUnconfirmed(threadId, turnId);
      warn(`stopped turn ${turnId} keeps its folder until the engine's child exits`);
      if (lateClose) void lateClose.then(release, error => warn(`late close: ${describeThrow(error)}`));
    };
    void adapter.awaitTurnTeardown(threadId, turnId).then(result => result.closeConfirmed ? release() : retain(), retain)
      .catch(error => warn(`release failed: ${describeThrow(error)}`));
  }

  /** Pre-dispatch cancellation is safe to release. Once sendTurn was called,
   * keep holding until terminal evidence or confirmed fleet disposal. */
  abandon(generation: string): void {
    const owner = this.owners.get(generation);
    if (owner && !owner.dispatched) this.release(generation);
  }

  /** Record that the host stopped this generation's turn and released its
   * run. The writer lease is NOT released here — only the engine's terminal
   * event proves nothing writes any more — but a restore may now wait for
   * that release instead of refusing. Returns whether a lease is still held. */
  markStopRequested(generation: string): boolean {
    const owner = this.owners.get(generation);
    if (!owner) return false;
    owner.stopRequested = true;
    return true;
  }

  /** The engine's close of a stopped generation's turn was confirmed: nothing
   * writes any more, so its writer lease releases now instead of waiting for a
   * terminal event. Returns whether a lease was held. */
  releaseClosed(generation: string): boolean {
    if (!this.owners.has(generation)) return false;
    this.release(generation);
    return true;
  }

  /** Restore admission that tolerates the Stop → Restore window: acquire the
   * restore lease now, or, when every holder of the folder is a turn whose
   * stop was already requested (`markStopRequested`), wait up to `timeoutMs`
   * for those leases to release and then acquire. A live (not stopped)
   * writer or another restore refuses immediately: no writer may overlap a
   * held restore, and a stopped turn is only ever waited for, never
   * pre-empted. */
  async acquireRestoreWhenStopped(ownerId: string, cwd: string, options: { timeoutMs: number }): Promise<RestoreAdmission> {
    const deadline = Date.now() + Math.max(0, options.timeoutMs);
    // FOLLOW4: a throw that is not the registry's own refusal is folded into
    // an unusable-path answer by every caller; it is logged here, once, so a
    // registry change that breaks the "only throws its own refusals"
    // invariant is visible. No path: the caller's route logs what it logs.
    const unexpected = (stage: string, error: unknown): RestoreAdmission => {
      warn(`folder registry threw something other than its own refusal during ${stage}; answering as an unusable path: ${describeThrow(error)}`);
      return { ok: false, reason: "error", error };
    };
    for (;;) {
      try { return { ok: true, lease: this.folders.acquireRestore(ownerId, cwd) }; }
      catch (error) {
        if (!(error instanceof ProjectFolderLeaseError)) return unexpected("restore admission", error);
        if (error.code !== "conflict") return { ok: false, reason: "conflict", code: error.code };
      }
      let blockers: ProjectFolderLease[];
      try { blockers = this.folders.conflicts(cwd, "restore"); }
      catch (error) { return error instanceof ProjectFolderLeaseError ? { ok: false, reason: "conflict", code: error.code } : unexpected("conflict listing", error); }
      // Released between the refusal and this check: acquire on the next pass.
      if (blockers.length === 0) continue;
      const holders = blockers.map(lease => lease.mode === "writer" ? this.ownerOf(lease.ownerId) : undefined);
      if (holders.every(owner => owner?.closeUnconfirmed === true)) return { ok: false, reason: "conflict", code: "conflict", closeUnconfirmed: true };
      if (!holders.every(owner => owner?.stopRequested === true)) {
        return { ok: false, reason: "conflict", code: "conflict" };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, reason: "still-closing" };
      await this.nextRelease(remaining);
    }
  }

  private ownerOf(leaseOwnerId: string): TurnLease | undefined {
    return this.owners.get(leaseOwnerId)
      ?? [...this.owners.values()].find(owner => owner.outputOwnerId === leaseOwnerId || owner.additionalOwnerIds?.includes(leaseOwnerId));
  }

  /** Resolves on the next writer release, or after `ms` — whichever first. */
  private nextRelease(ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.releaseWaiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      this.releaseWaiters.add(done);
    });
  }

  /** Capture BEFORE awaiting registry.disposeAll; later generations must not
   * be released by completion of disposal of an older provider fleet. */
  generations(): string[] { return [...this.owners.keys()]; }
  /** The threads holding a generation now (a reload asks which of them still have an engine child open). */
  threadIds(): string[] { return [...new Set([...this.owners.values()].map((owner) => owner.threadId))]; }
  /** The generations of these threads only, for a reload that disposes some
   * engines and leaves the turns on every other engine running. */
  generationsForThreads(threadIds: ReadonlySet<string>): string[] {
    return [...this.owners].filter(([, owner]) => threadIds.has(owner.threadId)).map(([generation]) => generation);
  }
  disposed(generations: string[]): void {
    for (const generation of generations) this.release(generation);
  }

  private release(generation: string): void {
    const owner = this.owners.get(generation);
    if (!owner) return;
    if (owner.providerKey && this.providers.get(owner.providerKey) === generation) this.providers.delete(owner.providerKey);
    this.owners.delete(generation);
    this.folders.release(generation);
    if (owner.outputOwnerId) this.folders.release(owner.outputOwnerId);
    for (const id of owner.additionalOwnerIds ?? []) this.folders.release(id);
    for (const waiter of [...this.releaseWaiters]) waiter();
  }
}
