// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
interface ProjectRunEvent { type: string; threadId: string; turnId?: string }
interface ProjectRunIdentity { threadId: string; generation: string; turnId: string }

/** A thread is reused across cards. Only this dispatch can bind its provider id. */
export function createProjectRunMatcher<E extends ProjectRunEvent = ProjectRunEvent>(threadId: string) {
  let generation: string | undefined, turnId: string | undefined;
  const pending = new Map<string, E>();
  return {
    dispatch(value: string) { generation = value; turnId = undefined; pending.clear(); },
    accept(value: string, providerTurnId: string): E | undefined {
      if (value !== generation || (turnId && turnId !== providerTurnId)) return;
      turnId = providerTurnId;
      const terminal = pending.get(turnId);
      pending.clear();
      return terminal;
    },
    observe(event: E, eventGeneration: string | undefined, ignored: boolean): boolean {
      if (ignored || event.threadId !== threadId || !generation) return false;
      // Earlier subscribers may already have admitted the next queued turn.
      // Generation fences binding; the captured provider identity fences completion.
      if (turnId) return event.type === "turn.completed" && event.turnId === turnId;
      if (eventGeneration && eventGeneration !== generation) return false;
      if (event.type === "turn.started" && eventGeneration === generation && event.turnId && !turnId) turnId = event.turnId;
      if (event.type === "turn.completed" && !turnId && event.turnId && eventGeneration === generation) {
        pending.set(event.turnId, event);
        if (pending.size > 32) pending.delete(pending.keys().next().value!);
      }
      return event.type === "turn.completed" && Boolean(turnId) && event.turnId === turnId;
    },
  };
}

/** Retain late roots and their retry timers under the acquiring turn, including
 * room turns which have no directRuns entry. Stop does not release these. */
export class ProjectLateWrites {
  private readonly runs = new Map<string, { identity: ProjectRunIdentity; releases: Array<() => void>; timers: Map<string, ReturnType<typeof setTimeout>> }>();
  private run(identity: ProjectRunIdentity) {
    const key = JSON.stringify([identity.threadId, identity.generation, identity.turnId]);
    let run = this.runs.get(key);
    if (!run) { run = { identity, releases: [], timers: new Map() }; this.runs.set(key, run); }
    return run;
  }
  add(identity: ProjectRunIdentity, release: () => void): void { this.run(identity).releases.push(release); }
  retry(identity: ProjectRunIdentity, requestId: string, retry: () => void): void {
    const run = this.run(identity);
    if (run.timers.has(requestId)) return;
    const timer = setTimeout(() => { run.timers.delete(requestId); retry(); }, 250);
    timer.unref?.(); run.timers.set(requestId, timer);
  }
  complete(event: ProjectRunEvent): void {
    // Retired output is ignored, but its terminal still closes its own resources.
    if (event.type !== "turn.completed" || !event.turnId) return;
    for (const [key, run] of this.runs) {
      if (run.identity.threadId !== event.threadId || run.identity.turnId !== event.turnId) continue;
      this.runs.delete(key);
      for (const timer of run.timers.values()) clearTimeout(timer);
      for (const release of run.releases) release();
    }
  }
}

/** An approval may need several roots. A failed attempt retains none of them. */
export function acquireProjectWriteRoots<T>(roots: readonly T[], claim: (root: T) => (() => void) | null,
  lease: (root: T) => () => void): Array<() => void> | null {
  const releases: Array<() => void> = [];
  try {
    for (const root of roots) {
      const release = claim(root);
      if (!release) { for (const undo of releases.reverse()) undo(); return null; }
      releases.push(release);
      releases.push(lease(root));
    }
    return releases;
  } catch {
    for (const undo of releases.reverse()) undo();
    return null;
  }
}
