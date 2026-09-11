import { ProjectFolderLeaseError, ProjectFolderLeases, type ProjectFolderLease } from "./project-folder-leases.ts";

export const PROJECT_TURN_TOMBSTONE_LIMIT = 4096;
interface TurnLease {
  threadId: string;
  dispatched: boolean;
  providerKey?: string;
  /** The host asked the engine to stop this turn and no longer counts it as
   * busy. The writer lease stays until the engine's terminal event: a stop
   * is "requested, not observed" (contracts.ts) and the child may still be
   * writing while it closes. */
  stopRequested?: boolean;
}

/** Outcome of a restore admission (STOPRESTORE1).
 * - `conflict`: a live writer, another restore, or an unusable path holds
 *   the folder — refuse at once, exactly as before.
 * - `still-closing`: every holder is a stopped turn whose engine has not
 *   released the folder within the bound — refuse, tell the user to retry. */
export type RestoreAdmission =
  | { ok: true; lease: ProjectFolderLease }
  | { ok: false; reason: "conflict" | "still-closing" };

/** Writer admission bookkeeping for provider generations, not an OS lock.
 * Revoking a capability does not prove that its provider stopped writing. */
export class ProjectTurnLeases {
  readonly folders = new ProjectFolderLeases();
  private readonly owners = new Map<string, TurnLease>();
  private readonly providers = new Map<string, string>();
  private readonly completed = new Set<string>();
  private readonly releaseWaiters = new Set<() => void>();

  acquire(threadId: string, generation: string, cwd: string): ProjectFolderLease {
    if (!threadId) throw new Error("Project turn requires a thread");
    const existing = this.owners.get(generation);
    if (existing && existing.threadId !== threadId) throw new Error("Project generation belongs to another thread");
    const lease = this.folders.acquireWriter(generation, cwd);
    if (!existing) this.owners.set(generation, { threadId, dispatched: false });
    return lease;
  }

  /** Call immediately before invoking sendTurn, including its async setup. */
  markDispatched(generation: string): void {
    const owner = this.owners.get(generation);
    if (owner) {
      this.folders.assertCurrent(generation);
      owner.dispatched = true;
    }
  }

  bind(threadId: string, generation: string, turnId: string): boolean {
    const owner = this.owners.get(generation);
    if (!owner || owner.threadId !== threadId || !turnId) return false;
    const key = JSON.stringify([threadId, turnId]);
    // A provider may emit completion before sendTurn reveals its id.
    if (this.completed.has(key)) {
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

  complete(threadId: string, turnId: string): void {
    if (!threadId || !turnId) return;
    const key = JSON.stringify([threadId, turnId]);
    this.completed.add(key);
    while (this.completed.size > PROJECT_TURN_TOMBSTONE_LIMIT) this.completed.delete(this.completed.values().next().value!);
    const generation = this.providers.get(key);
    if (generation !== undefined) this.release(generation);
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

  /** Restore admission that tolerates the Stop → Restore window: acquire the
   * restore lease now, or, when every holder of the folder is a turn whose
   * stop was already requested (`markStopRequested`), wait up to `timeoutMs`
   * for those leases to release and then acquire. A live (not stopped)
   * writer or another restore refuses immediately: no writer may overlap a
   * held restore, and a stopped turn is only ever waited for, never
   * pre-empted. */
  async acquireRestoreWhenStopped(ownerId: string, cwd: string, options: { timeoutMs: number }): Promise<RestoreAdmission> {
    const deadline = Date.now() + Math.max(0, options.timeoutMs);
    for (;;) {
      try { return { ok: true, lease: this.folders.acquireRestore(ownerId, cwd) }; }
      catch (error) {
        if (!(error instanceof ProjectFolderLeaseError) || error.code !== "conflict") return { ok: false, reason: "conflict" };
      }
      let blockers: ProjectFolderLease[];
      try { blockers = this.folders.conflicts(cwd, "restore"); }
      catch { return { ok: false, reason: "conflict" }; }
      // Released between the refusal and this check: acquire on the next pass.
      if (blockers.length === 0) continue;
      if (!blockers.every(lease => lease.mode === "writer" && this.owners.get(lease.ownerId)?.stopRequested === true)) {
        return { ok: false, reason: "conflict" };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, reason: "still-closing" };
      await this.nextRelease(remaining);
    }
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
  disposed(generations: string[]): void {
    for (const generation of generations) this.release(generation);
  }

  private release(generation: string): void {
    const owner = this.owners.get(generation);
    if (!owner) return;
    if (owner.providerKey && this.providers.get(owner.providerKey) === generation) this.providers.delete(owner.providerKey);
    this.owners.delete(generation);
    this.folders.release(generation);
    for (const waiter of [...this.releaseWaiters]) waiter();
  }
}
