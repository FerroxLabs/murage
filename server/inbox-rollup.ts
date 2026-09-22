// WHAT IT COSTS YOU TO IGNORE IT.
//
// THE INBOX THIS REPLACES SORTED BY TIME. On 2026-09-22 the owner opened his
// and found thirty six items. Thirty five were the same upstream outage,
// listed once per run, every one of which had already fixed itself. The
// thirty sixth was Gmail losing its authorization, which stops three routines
// across three bots and recovers only when a person reconnects it. It was
// rendered identically to the thirty five and he could not see it.
//
// That is not a labelling problem. A list ordered by when things happened
// cannot tell you which of them is costing you something, so the rules below
// order by that instead. They are stated as four, and each is a decision
// about whether a person needs to know:
//
//   1. A FAILURE A LATER RUN RECOVERED FROM IS NOT AN EVENT. If a newer run
//      of the same routine succeeded, the failure is history. It becomes a
//      number inside the routine's row and never gets a row of its own.
//   2. UPSTREAM WEATHER IS NEVER LISTED RUN BY RUN. 429, 503 and 529 are the
//      provider having a bad morning. There is no action attached to one, so
//      it is counted and never surfaced alone.
//   3. ONE CAUSE, ONE ROW. Group by what went wrong, not by which bot it
//      happened to. A dead Gmail token that stops three routines is one item
//      naming three, not three items naming none.
//   4. A ROUTINE RUN IS A NOTIFICATION, NEVER A REQUEST. This one was got
//      wrong first and the owner corrected it: an earlier draft escalated a
//      stuck routine into "needs you", which puts the noise back in the badge
//      a few hours later. Routines are things that HAPPENED. They are told,
//      grouped, and they never badge, however badly they are going.
//
// WHICH LEAVES THE QUESTION THIS MODULE ACTUALLY ANSWERS. Three kinds of
// thing genuinely require a person, and they are not interchangeable:
// APPROVALS (permission to do a specific act), DECISIONS (a question only
// they can answer) and CONNECTIONS (something that needs their hands). The
// first two already arrive as their own message kinds. The third is the one
// a routine can reveal: when runs keep failing because a credential has gone,
// the thing that requires the person is THE DEAD CONNECTION, not the runs.
//
// So `connectionsToRestore` raises that, once per cause, and nothing else in
// here is ever allowed to ask for attention. A provider outage lasting six
// hours requires patience, not the owner; it stays a routine notice, loudly,
// badging nothing.
//
// Kept free of SQL and of the database so every rule above can be tested
// against a list of runs instead of against a fixture workspace.

/** Why a run failed, to the only resolution that changes what a person does. */
export type FailureCause =
  /** The provider is overloaded, rate limiting, or timed out. Clears itself. */
  | "upstream"
  /** A connection or credential has gone. Clears only when somebody acts. */
  | "connection"
  /** Something else. It is not known to self-heal, so it is not assumed to. */
  | "unknown";

/** How long a routine may fail on nothing but upstream weather before the
 *  routine row says so in stronger terms. Six hours: long enough that a
 *  morning of provider trouble stays quiet, short enough that a person finds
 *  out before a day's work is gone.
 *
 *  IT CHANGES HOW A ROUTINE ROW READS, AND NOTHING ELSE. It does not badge
 *  and it does not raise a request: a provider being down needs patience, not
 *  the owner. */
export const STALLED_UPSTREAM_MS = 6 * 60 * 60 * 1000;

// Matched against the message a run failed with. Deliberately narrow: a
// phrase that only sometimes means "temporary" must NOT be here, because the
// cost of miscalling a permanent fault as weather is that nobody is ever
// told. Anything unrecognised falls to "unknown" and is treated as needing a
// person, which is the safe direction.
const UPSTREAM = /\b(429|503|529)\b|overloaded|rate.?limit|too many requests|temporarily unavailable|service unavailable|timed? ?out|etimedout|econnreset|try again in a moment/i;
const CONNECTION = /not authorized|unauthorized|reauthoriz|re-?authenticat|reconnect|disconnected|invalid[_ ]?grant|token (?:has )?expired|credential|\b401\b|\b403\b|permission denied|access denied/i;

/**
 * What kind of failure this text describes.
 *
 * CONNECTION IS TESTED FIRST, and that order is load-bearing. "401
 * Unauthorized, please try again in a moment" carries both shapes, and
 * calling it weather would leave a dead token silently unreported for ever —
 * the exact failure this module exists for. Erring the other way only costs
 * a person one glance at something that then fixes itself.
 */
export function failureCause(text: string | null | undefined): FailureCause {
  const value = (text ?? "").trim();
  if (!value) return "unknown";
  if (CONNECTION.test(value)) return "connection";
  if (UPSTREAM.test(value)) return "upstream";
  return "unknown";
}

/** Whether a failure of this kind clears without anybody doing anything. */
export function recoversUnaided(cause: FailureCause): boolean {
  return cause === "upstream";
}

/** One run of one routine, reduced to what the rules need. */
export interface RoutineRunFact {
  /** Stable identity of the routine, so runs group across bots and renames. */
  routineKey: string;
  routineName: string;
  /** How the person refers to whoever runs it. */
  botLabel: string;
  /** When it ran. */
  at: number;
  /** True when this run did not complete its work. */
  failed: boolean;
  /** The failure message, when it failed. */
  detail?: string | null;
}

export type RoutineVerdict =
  /** Every run in the window completed. */
  | "ok"
  /** Some runs failed and a LATER one succeeded. Rule 1: not an event. */
  | "recovered"
  /** The most recent run failed and nothing has succeeded since. */
  | "stuck";

export interface RoutineRollup {
  routineKey: string;
  routineName: string;
  botLabel: string;
  runs: number;
  failed: number;
  /** When the most recent run of this routine happened. */
  lastAt: number;
  verdict: RoutineVerdict;
  /** Why it is stuck. `null` unless the verdict is "stuck". */
  cause: FailureCause | null;
  /** When the current unbroken run of failures began. `null` unless stuck. */
  failingSince: number | null;
  /** Stuck on nothing but provider weather for longer than a person would
   *  expect to wait. It changes how the row READS and nothing else: it never
   *  badges, because waiting is still the only available action. */
  stalled: boolean;
}

/**
 * Rule 1 and rule 2, applied to a flat list of runs.
 *
 * One row per routine, never per run, ordered worst first: a routine nobody
 * can rescue sits above one that rescued itself, and ties break on recency.
 */
export function rollUpRoutineRuns(
  runs: readonly RoutineRunFact[],
  now: number = Date.now(),
  stalledAfterMs: number = STALLED_UPSTREAM_MS,
): RoutineRollup[] {
  const byRoutine = new Map<string, RoutineRunFact[]>();
  for (const run of runs) {
    const bucket = byRoutine.get(run.routineKey);
    if (bucket) bucket.push(run);
    else byRoutine.set(run.routineKey, [run]);
  }

  const rollups: RoutineRollup[] = [];
  for (const [routineKey, bucket] of byRoutine) {
    // Oldest first, so "since" and "latest" are both read off one pass and a
    // caller handing runs in any order gets the same answer.
    const ordered = [...bucket].sort((a, b) => a.at - b.at || (a.failed === b.failed ? 0 : a.failed ? -1 : 1));
    const latest = ordered[ordered.length - 1]!;
    const failed = ordered.filter((run) => run.failed);

    // RULE 1. The verdict is decided by the LAST run, not by the count. A
    // routine that failed twelve times and then worked is a routine that
    // works; one that worked twelve times and then broke is broken.
    let verdict: RoutineVerdict = "ok";
    if (latest.failed) verdict = "stuck";
    else if (failed.length > 0) verdict = "recovered";

    let cause: FailureCause | null = null;
    let failingSince: number | null = null;
    if (verdict === "stuck") {
      // The unbroken tail of failures, which is the only part still true.
      // An earlier, different failure that was recovered from says nothing
      // about why it is stuck now.
      const tail: RoutineRunFact[] = [];
      for (let index = ordered.length - 1; index >= 0 && ordered[index]!.failed; index -= 1) tail.unshift(ordered[index]!);
      failingSince = tail[0]!.at;
      const causes = new Set(tail.map((run) => failureCause(run.detail)));
      // Mixed causes are not weather. If anything in the tail needs a person,
      // the routine needs a person: calling it upstream because most of the
      // failures were would bury the one that was not.
      cause = causes.size === 1 ? [...causes][0]! : causes.has("connection") ? "connection" : causes.has("unknown") ? "unknown" : "upstream";
    }

    rollups.push({
      routineKey,
      routineName: latest.routineName,
      botLabel: latest.botLabel,
      runs: ordered.length,
      failed: failed.length,
      lastAt: latest.at,
      verdict,
      cause,
      failingSince,
      stalled: verdict === "stuck" && cause !== null && recoversUnaided(cause)
        && now - (failingSince ?? latest.at) >= stalledAfterMs,
    });
  }

  const rank: Record<RoutineVerdict, number> = { stuck: 0, recovered: 1, ok: 2 };
  return rollups.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.lastAt - a.lastAt);
}

/**
 * Rule 3, and the only thing in this module allowed to ask for attention.
 *
 * A routine that keeps failing on a dead credential is not a routine problem.
 * The routine is fine; the connection under it is gone, and THAT is the thing
 * a person can act on. So this returns connections to restore, one per cause,
 * naming everything stopped behind it — never the runs themselves.
 *
 * Everything else a routine can be doing wrong stays a notification. A stuck
 * routine with an unrecognised cause is reported on its own row, loudly, and
 * still does not appear here: "something is broken, go and look" is news, not
 * a request, and a badge that means "go and look" is the badge this whole
 * redesign exists to get rid of.
 */
export interface ConnectionToRestore {
  /** Stable enough to key a list on, and to carry a read mark later. */
  id: string;
  /** Routine names this has stopped, in the order they broke. */
  routines: string[];
  /** Distinct bots affected, so the row can say "three bots" honestly. */
  bots: string[];
  /** When the earliest still-failing routine started failing. */
  since: number;
  /** One sentence naming what a person has to do. */
  detail: string;
}

export function connectionsToRestore(rollups: readonly RoutineRollup[]): ConnectionToRestore[] {
  const routines: string[] = [];
  const bots = new Set<string>();
  let since = Number.POSITIVE_INFINITY;

  for (const rollup of rollups) {
    // ONLY `connection`. Not `upstream`, which fixes itself, and not
    // `unknown`, which is news rather than a request.
    if (rollup.verdict !== "stuck" || rollup.cause !== "connection") continue;
    routines.push(rollup.routineName);
    bots.add(rollup.botLabel);
    since = Math.min(since, rollup.failingSince ?? rollup.lastAt);
  }

  if (routines.length === 0) return [];
  return [{
    id: "connection:restore",
    routines,
    bots: [...bots],
    since,
    detail: routines.length === 1
      ? `A connection ${routines[0]} depends on is no longer authorized.`
      : `A connection ${routines.length} routines depend on is no longer authorized.`,
  }];
}
