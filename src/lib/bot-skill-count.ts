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

/** What the intake knows about an agent WITHOUT asking the server anything.
 *
 *  Structural on purpose: `Bot` from the store satisfies it, and so does a
 *  three-line literal in a test. Nothing here is fetched — every field is
 *  already on the bot the card was handed. */
export interface BotSetupEvidence {
  title?: string;
  description?: string;
  /** Every context this agent has. `usage.turns` is the closest thing the
   *  renderer holds to "how many times has a person talked to it". */
  tasks?: ReadonlyArray<{ usage?: { turns?: number } | undefined }>;
}

/** Past this many turns the agent is IN USE, and an unprompted "what do you
 *  mostly want help with?" is an interruption rather than an offer. Three is
 *  the first count that cannot be a person poking at a new bot. */
export const INTAKE_MAX_TURNS = 3;

/** Turns this agent has actually had, across all its contexts. */
export function botTurnCount(bot: BotSetupEvidence): number {
  let turns = 0;
  for (const task of bot.tasks ?? []) {
    const count = task?.usage?.turns;
    if (typeof count === "number" && Number.isFinite(count) && count > 0) turns += count;
  }
  return turns;
}

/** Does this agent still look like the blank one "New Bot" made?
 *
 *  Skill count alone said yes for Sable — a bot with a hand-written title, a
 *  description, and a conversation behind it, whose skills simply live
 *  somewhere other than the library. The card then offered to RENAME it. A
 *  title, a description, or a real conversation are each independently proof
 *  that a person has already told this agent what it is for, and the intake
 *  must not ask again. */
export function looksUnconfigured(bot: BotSetupEvidence): boolean {
  if ((bot.title ?? "").trim()) return false;
  if ((bot.description ?? "").trim()) return false;
  return botTurnCount(bot) < INTAKE_MAX_TURNS;
}

/** What the COMPOSER DOCK puts on screen. Two answers, and one of them is
 *  nothing at all.
 *
 *  There is no collapsed chip here any more, and its absence is the design.
 *  Sable — a Chief of Staff with 1.4M tokens of conversation behind her, a
 *  profile, and a full set of skills — had "What do you mostly want help
 *  with?" parked under every message. A quieter chip in the same place is the
 *  same noise in the same place: the composer belongs to the conversation.
 *
 *  This is NOT a one-way door, because the door moved rather than closed. Set
 *  up lives on the bot's own profile now (`BotSetupAction` in
 *  BotIntakeCard.tsx, rendered by SettingsPanel beside the role control),
 *  where a person goes deliberately to change what a bot IS — and where it can
 *  warn before it touches an established agent instead of ambushing one. */
export type IntakeMode = "question" | "none";

export function intakeMode(count: SkillCount, bot: BotSetupEvidence): IntakeMode {
  // Still counting, unreadable, or already carrying skills — nothing to offer.
  if (count !== 0) return "none";
  return looksUnconfigured(bot) ? "question" : "none";
}

/** Would running setup on this agent CHANGE something a person put there?
 *
 *  The gate on the profile path. Reached deliberately, setup is always
 *  available — but on an agent that already has skills, or a description, or a
 *  real conversation behind it, it says what it is about to touch and waits.
 *  `count` may be null or -1 (not read, unreadable): both are "unknown", and
 *  unknown warns, because the safe direction here is the cautious one. */
export function setupWouldOverwrite(count: SkillCount, bot: BotSetupEvidence): boolean {
  if (count === null || count === -1) return true;
  if (count > 0) return true;
  return !looksUnconfigured(bot);
}

/** What the warning names, so it is never a vague "are you sure?". */
export function setupOverwriteReasons(count: SkillCount, bot: BotSetupEvidence): string[] {
  const reasons: string[] = [];
  if (typeof count === "number" && count > 0) {
    reasons.push(count === 1 ? "1 skill it already has" : `${count} skills it already has`);
  }
  if ((bot.title ?? "").trim()) reasons.push("its title");
  if ((bot.description ?? "").trim()) reasons.push("its description");
  const turns = botTurnCount(bot);
  if (turns >= INTAKE_MAX_TURNS) reasons.push(`a conversation ${turns} turns long`);
  return reasons;
}

/** True when we have READ this bot's skills, there are none, AND nothing else
 *  about the agent says a person already configured it. The one state that
 *  earns an unprompted question. */
export function needsSetup(count: SkillCount, bot: BotSetupEvidence): boolean {
  return intakeMode(count, bot) === "question";
}

/** True once we know the answer either way. The seeded four-option quiz is
 *  superseded by the intake whenever this holds: with no skills the intake is
 *  asking the same question better — as the full card or as the chip, but
 *  ALWAYS as something — and with skills there is nothing left to ask. Only an
 *  unreadable count leaves the old card alone.
 *
 *  This moves in lock-step with `intakeMode` by construction: the invariant is
 *  that whenever this returns true and `intakeMode` is "none", the count is
 *  above zero and there is genuinely no question left. A test pins it, because
 *  the failure — the quiz suppressed while the intake also renders nothing —
 *  is a screen with no way to configure the agent on it at all. */
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
