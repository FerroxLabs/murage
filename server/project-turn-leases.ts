import { ProjectFolderLeases, type ProjectFolderLease } from "./project-folder-leases.ts";

export const PROJECT_TURN_TOMBSTONE_LIMIT = 4096;
interface TurnLease {
  threadId: string;
  dispatched: boolean;
  providerKey?: string;
}

/** Writer admission bookkeeping for provider generations, not an OS lock.
 * Revoking a capability does not prove that its provider stopped writing. */
export class ProjectTurnLeases {
  readonly folders = new ProjectFolderLeases();
  private readonly owners = new Map<string, TurnLease>();
  private readonly providers = new Map<string, string>();
  private readonly completed = new Set<string>();

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
  }
}
