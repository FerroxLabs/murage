import { useEffect, useSyncExternalStore } from "react";

// How many skills an agent has, shared by everything that needs to know
// whether that agent is still unconfigured.
//
// Two places ask, and they must agree: the intake card decides whether to
// offer the setup question, and the transcript decides whether the old seeded
// four-option quiz is still worth showing. If they disagreed the person would
// be asked "what do you mostly want help with?" twice on one screen, in two
// different widgets, which is exactly the "don't make me think" failure the
// intake exists to remove.
//
// A count, not a boolean, because "not read yet" and "read, and it is zero"
// are different answers and only one of them should change the screen.

/** null = not read yet. -1 = the route could not be read, which says nothing
 *  about the agent and must never be treated as "unconfigured". */
export type SkillCount = number | null;

export type SkillCountRequest = (path: string) => Promise<any>;

const counts = new Map<string, number>();
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<void>>();

/** Bounded so a long session in a large workspace cannot grow this forever.
 *  Evicting is safe: the next read simply asks again. */
const MAX_TRACKED_BOTS = 200;

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeSkillCounts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSkillCount(botId: string): SkillCount {
  return counts.has(botId) ? counts.get(botId)! : null;
}

export function setSkillCount(botId: string, count: number): void {
  if (counts.get(botId) === count) return;
  if (!counts.has(botId) && counts.size >= MAX_TRACKED_BOTS) {
    const oldest = counts.keys().next().value;
    if (oldest !== undefined) counts.delete(oldest);
  }
  counts.set(botId, count);
  emit();
}

/** Read a bot's skill count once. Concurrent callers share one request, which
 *  is what lets the card and the transcript both ask without doubling it. */
export function loadSkillCount(botId: string, request: SkillCountRequest): Promise<void> {
  const existing = inflight.get(botId);
  if (existing) return existing;
  const pending = (async () => {
    try {
      const response = (await request(`/api/bots/${botId}/skills`)) as { skills?: unknown[] };
      setSkillCount(botId, Array.isArray(response.skills) ? response.skills.length : 0);
    } catch {
      // An unreachable route says nothing about what this bot has. -1 is
      // "unknown", and every caller treats it as "change nothing".
      setSkillCount(botId, -1);
    } finally {
      inflight.delete(botId);
    }
  })();
  inflight.set(botId, pending);
  return pending;
}

/** Forget a bot's count so the next read asks the server again. Called after
 *  anything installs skills. */
export function invalidateSkillCount(botId: string): void {
  counts.delete(botId);
  emit();
}

/** Test seam: an empty cache between cases. */
export function resetSkillCounts(): void {
  counts.clear();
  inflight.clear();
  emit();
}

/** True when we have READ this bot's skills and there are none — the one
 *  state that means "this agent was created and never configured". */
export function needsSetup(count: SkillCount): boolean {
  return count === 0;
}

/** True once we know the answer either way. The seeded four-option quiz is
 *  superseded by the intake whenever this holds: with no skills the intake is
 *  asking the same question better, and with skills there is nothing left to
 *  ask. Only an unreadable count leaves the old card alone. */
export function intakeOwnsTheQuestion(count: SkillCount): boolean {
  return count !== null && count !== -1;
}

export function useSkillCount(botId: string, request: SkillCountRequest): SkillCount {
  const count = useSyncExternalStore(
    subscribeSkillCounts,
    () => getSkillCount(botId),
    () => null,
  );
  useEffect(() => {
    if (getSkillCount(botId) === null) void loadSkillCount(botId, request);
  }, [botId, request, count]);
  return count;
}
