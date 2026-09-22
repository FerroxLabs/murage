// THE THIRTY SIX ROWS, AS A TEST.
//
// Every case below is a shape from the owner's real Inbox on 2026-09-22, or
// one of the ways a careless fix would have been worse than the bug: his
// night watch failing over and over on provider overload and then coming
// back on its own, and three routines across three bots stopped by one dead
// Gmail token that he could not pick out of the pile.
//
// EVERY RULE HERE HAS BEEN SHOWN TO FAIL. Deciding the verdict from the
// failure count instead of the last run: 4 red. Letting provider weather ask
// for attention: 3 red. One item per routine instead of per cause: 1 red.
// Testing the weather pattern before the credential pattern: 1 red. A check
// that has not been handed the thing it exists to catch is decoration, and
// this repo has produced several.
import { describe, expect, it } from "vitest";

import {
  STALLED_UPSTREAM_MS,
  connectionsToRestore,
  failureCause,
  recoversUnaided,
  rollUpRoutineRuns,
  type RoutineRunFact,
} from "./inbox-rollup.ts";

const HOUR = 60 * 60 * 1000;
const T0 = 1_758_500_000_000;

function run(over: Partial<RoutineRunFact> & Pick<RoutineRunFact, "at">): RoutineRunFact {
  return {
    routineKey: "rwa-night-watch",
    routineName: "RWA night watch",
    botLabel: "Dax (Closer)",
    failed: false,
    ...over,
  };
}

const OVERLOAD = "API Error: 529 Overloaded. This is a server-side issue, usually temporary.";
const DEAD_TOKEN = "Gmail is not authorized. Reconnect the account to continue.";

describe("what kind of failure this is", () => {
  it("knows the provider having a bad morning", () => {
    for (const text of [OVERLOAD, "429 rate limit exceeded", "503 Service Unavailable", "request timed out", "ETIMEDOUT"]) {
      expect(failureCause(text), text).toBe("upstream");
    }
    expect(recoversUnaided("upstream")).toBe(true);
  });

  it("knows a credential that has gone", () => {
    for (const text of [DEAD_TOKEN, "401 Unauthorized", "invalid_grant", "the token has expired", "permission denied"]) {
      expect(failureCause(text), text).toBe("connection");
    }
    expect(recoversUnaided("connection"), "nobody waits their way out of a dead token").toBe(false);
  });

  it("reads a mixed message as the half that needs a person", () => {
    // THE ORDER OF THE TWO TESTS IS LOAD-BEARING AND THIS IS WHY. Providers
    // write "401 Unauthorized, please try again in a moment" and mean the
    // first half. Calling it weather leaves a dead token unreported for ever,
    // which is the exact failure this module exists for; calling it a
    // connection costs one glance at something that then fixes itself.
    expect(failureCause("401 Unauthorized — please try again in a moment")).toBe("connection");
  });

  it("assumes nothing about a message it does not recognise", () => {
    // "unknown" must NOT be treated as self-healing. Guessing that an
    // unfamiliar fault will clear itself is how something silently never runs
    // again.
    expect(failureCause("Routine step 3 returned an empty plan")).toBe("unknown");
    expect(failureCause("")).toBe("unknown");
    expect(failureCause(null)).toBe("unknown");
    expect(recoversUnaided("unknown")).toBe(false);
  });
});

describe("rule 1: a failure a later run recovered from is not an event", () => {
  it("calls the owner's night watch recovered, not failing", () => {
    // Twelve failures then four clean runs. Today this is twelve rows.
    const runs = [
      ...Array.from({ length: 12 }, (_, index) => run({ at: T0 + index * 1800_000, failed: true, detail: OVERLOAD })),
      ...Array.from({ length: 4 }, (_, index) => run({ at: T0 + (12 + index) * 1800_000 })),
    ];
    const [rollup] = rollUpRoutineRuns(runs, T0 + 20 * 1800_000);

    expect(rollup?.verdict).toBe("recovered");
    expect(rollup?.runs, "one row per routine, never per run").toBe(16);
    expect(rollup?.failed, "the failures are still counted, just not listed").toBe(12);
    expect(rollup?.cause, "nothing is wrong now, so there is nothing to name").toBeNull();
  });

  it("is decided by the last run, not by the count", () => {
    // Twelve clean runs then one failure is BROKEN, however good the record.
    const runs = [
      ...Array.from({ length: 12 }, (_, index) => run({ at: T0 + index * 1800_000 })),
      run({ at: T0 + 12 * 1800_000, failed: true, detail: DEAD_TOKEN }),
    ];
    const [rollup] = rollUpRoutineRuns(runs, T0 + 13 * 1800_000);

    expect(rollup?.verdict).toBe("stuck");
    expect(rollup?.failed, "one bad run in thirteen").toBe(1);
  });

  it("names only the failures that are still true", () => {
    // An old failure of a DIFFERENT kind, recovered from, then a new run of
    // failures. Reading the whole history would call this mixed and bury the
    // live cause.
    const runs = [
      run({ at: T0, failed: true, detail: "Routine step 3 returned an empty plan" }),
      run({ at: T0 + HOUR }),
      run({ at: T0 + 2 * HOUR, failed: true, detail: DEAD_TOKEN }),
      run({ at: T0 + 3 * HOUR, failed: true, detail: DEAD_TOKEN }),
    ];
    const [rollup] = rollUpRoutineRuns(runs, T0 + 4 * HOUR);

    expect(rollup?.cause).toBe("connection");
    expect(rollup?.failingSince, "the current run of failures, not the first one ever").toBe(T0 + 2 * HOUR);
  });

  it("puts the routine nobody can rescue above the one that rescued itself", () => {
    const rollups = rollUpRoutineRuns([
      run({ routineKey: "fine", routineName: "TC-TIDE morning brief", at: T0 + HOUR }),
      run({ routineKey: "healed", routineName: "Trustpilot sweep", at: T0, failed: true, detail: OVERLOAD }),
      run({ routineKey: "healed", routineName: "Trustpilot sweep", at: T0 + 2 * HOUR }),
      run({ routineKey: "broken", routineName: "Gmail triage", at: T0 + 3 * HOUR, failed: true, detail: DEAD_TOKEN }),
    ], T0 + 4 * HOUR);

    expect(rollups.map((entry) => entry.routineName)).toEqual(["Gmail triage", "Trustpilot sweep", "TC-TIDE morning brief"]);
  });
});

describe("rule 4: a routine run is a notification, never a request", () => {
  it("asks for nothing when a routine is stuck on the provider", () => {
    // The owner's correction, as an assertion. An earlier draft escalated
    // this into "needs you", which puts the noise back in the badge a few
    // hours later. Waiting is the only available action, so nobody is asked.
    const runs = Array.from({ length: 12 }, (_, index) => run({ at: T0 + index * 1800_000, failed: true, detail: OVERLOAD }));
    const rollups = rollUpRoutineRuns(runs, T0 + 12 * 1800_000);

    expect(rollups[0]?.verdict).toBe("stuck");
    expect(connectionsToRestore(rollups), "a provider outage requires patience, not the owner").toEqual([]);
  });

  it("asks for nothing when a routine is stuck for a reason nobody recognises", () => {
    // "Something is broken, go and look" is news, not a request. A badge
    // meaning "go and look" is the badge this whole redesign removes.
    const rollups = rollUpRoutineRuns([
      run({ at: T0, failed: true, detail: "Routine step 3 returned an empty plan" }),
    ], T0 + HOUR);

    expect(rollups[0]?.cause).toBe("unknown");
    expect(connectionsToRestore(rollups)).toEqual([]);
  });

  it("still says loudly when the provider has been down for hours", () => {
    // Rule 2 must not become a gag. Six hours of silence is news even though
    // it is still nobody's job to fix it — so the ROW changes and the badge
    // does not.
    const runs = Array.from({ length: 14 }, (_, index) => run({ at: T0 + index * 1800_000, failed: true, detail: OVERLOAD }));
    const rollups = rollUpRoutineRuns(runs, T0 + 13 * 1800_000 + STALLED_UPSTREAM_MS);

    expect(rollups[0]?.stalled, "the row has to say so").toBe(true);
    expect(connectionsToRestore(rollups), "and still ask for nothing").toEqual([]);
  });

  it("does not call a fresh provider wobble stalled", () => {
    const runs = Array.from({ length: 3 }, (_, index) => run({ at: T0 + index * 1800_000, failed: true, detail: OVERLOAD }));
    const rollups = rollUpRoutineRuns(runs, T0 + 3 * 1800_000);

    expect(rollups[0]?.stalled).toBe(false);
  });
});

describe("rule 3: one cause, one row", () => {
  it("raises the dead connection, not the three routines behind it", () => {
    // The item the owner could not find, and the shape he asked for: the
    // thing that requires him is the connection. The runs stay notifications.
    const rollups = rollUpRoutineRuns([
      run({ routineKey: "triage", routineName: "Gmail triage", botLabel: "Moss (Secretary)", at: T0, failed: true, detail: DEAD_TOKEN }),
      run({ routineKey: "sweep", routineName: "RWA night watch", botLabel: "Dax (Closer)", at: T0 + HOUR, failed: true, detail: DEAD_TOKEN }),
      run({ routineKey: "reviews", routineName: "Trustpilot sweep", botLabel: "Petra (Rep Management)", at: T0 + 2 * HOUR, failed: true, detail: DEAD_TOKEN }),
    ], T0 + 3 * HOUR);

    const raised = connectionsToRestore(rollups);
    expect(raised, "one item, not three").toHaveLength(1);
    expect(raised[0]?.routines).toHaveLength(3);
    expect(raised[0]?.bots, "three bots, named once").toHaveLength(3);
    expect(raised[0]?.since, "since the FIRST one broke, which is what it has cost").toBe(T0);
    expect(raised[0]?.detail).toContain("3 routines");
  });

  it("speaks about one routine in the singular", () => {
    const rollups = rollUpRoutineRuns([
      run({ routineKey: "triage", routineName: "Gmail triage", at: T0, failed: true, detail: DEAD_TOKEN }),
    ], T0 + HOUR);

    expect(connectionsToRestore(rollups)[0]?.detail).toContain("Gmail triage");
    expect(connectionsToRestore(rollups)[0]?.detail).not.toContain("routines");
  });

  it("does not drag a healthy routine into the group", () => {
    // Without this, "everything is broken" is one grep away from being said
    // about a workspace that is mostly fine.
    const rollups = rollUpRoutineRuns([
      run({ routineKey: "triage", routineName: "Gmail triage", at: T0, failed: true, detail: DEAD_TOKEN }),
      run({ routineKey: "fine", routineName: "TC-TIDE morning brief", at: T0 + HOUR }),
      run({ routineKey: "healed", routineName: "Trustpilot sweep", at: T0, failed: true, detail: DEAD_TOKEN }),
      run({ routineKey: "healed", routineName: "Trustpilot sweep", at: T0 + 2 * HOUR }),
    ], T0 + 3 * HOUR);

    const raised = connectionsToRestore(rollups);
    expect(raised[0]?.routines, "only the one that is still broken").toEqual(["Gmail triage"]);
  });

  it("says nothing at all when nothing is broken", () => {
    const rollups = rollUpRoutineRuns([run({ at: T0 }), run({ at: T0 + HOUR })], T0 + 2 * HOUR);
    expect(rollups[0]?.verdict).toBe("ok");
    expect(connectionsToRestore(rollups)).toEqual([]);
  });
});

describe("the owner's actual morning, end to end", () => {
  it("turns thirty six rows into three notices and one request", () => {
    const runs: RoutineRunFact[] = [
      ...Array.from({ length: 26 }, (_, index) => run({
        at: T0 + index * 1800_000,
        failed: index < 22,
        detail: index < 22 ? OVERLOAD : null,
      })),
      ...Array.from({ length: 8 }, (_, index) => run({
        routineKey: "reviews", routineName: "Trustpilot sweep", botLabel: "Petra (Rep Management)",
        at: T0 + index * 3600_000, failed: index < 3, detail: index < 3 ? OVERLOAD : null,
      })),
      run({ routineKey: "brief", routineName: "TC-TIDE morning brief", botLabel: "Bruce (Smart Trader)", at: T0 + 7 * HOUR }),
      run({ routineKey: "triage", routineName: "Gmail triage", botLabel: "Moss (Secretary)", at: T0 + 6 * HOUR, failed: true, detail: DEAD_TOKEN }),
    ];
    expect(runs.length, "the pile he was shown").toBe(36);

    const rollups = rollUpRoutineRuns(runs, T0 + 8 * HOUR);
    const raised = connectionsToRestore(rollups);

    expect(rollups, "four routines ran, so four rows").toHaveLength(4);
    expect(raised, "and exactly one thing needed him").toHaveLength(1);
    expect(raised[0]?.routines).toEqual(["Gmail triage"]);

    const badged = raised.length;
    expect(badged, "36 became 1").toBe(1);
    expect(rollups.filter((entry) => entry.verdict === "recovered")).toHaveLength(2);
  });
});

// A ROUTINE THAT STOPPED TO ASK IS NOT A ROUTINE THAT BROKE.
//
// Rule 4 is right about the thirty five rows it was written for: a run that
// failed, retried or ran on a timer asks for nothing. It is not right about
// a run whose goal came back needing input. routines.ts parks that one at
// status 'waiting' with "The team needs your input" on it and says so in its
// own words: "a team asking the human a question is still waiting on them".
//
// Before this, that run arrived here as `failed: true` with no message, so
// the rules called it stuck on an unknown cause and the row said "Not
// recovering" — sending the owner to look for a breakage over a routine that
// was one sentence away from carrying on.
describe("a routine that is waiting on the owner", () => {
  it("says what it is waiting for, and outranks the ones that are merely broken", () => {
    const rollups = rollUpRoutineRuns([
      run({ at: T0 - 2 * HOUR, failed: true, detail: OVERLOAD }),
      run({ at: T0 - HOUR, owed: true, link: { threadId: "t", messageId: "m" } }),
      run({ routineKey: "other", routineName: "Inbox sweep", at: T0 - 30 * 60 * 1000, failed: true, detail: DEAD_TOKEN }),
    ], T0);
    expect(rollups[0]).toMatchObject({ routineKey: "rwa-night-watch", verdict: "waiting", cause: null, stalled: false });
    expect(rollups[0]!.link, "the summary has to lead back to the run").toEqual({ threadId: "t", messageId: "m" });
    // It is not a failure, so it is not counted as one inside its own row.
    expect(rollups[0]!.failed).toBe(1);
    expect(rollups[1], "a dead token is still worse news than an unanswered question is old")
      .toMatchObject({ routineKey: "other", verdict: "stuck", cause: "connection" });
  });

  it("asks for nothing through the connections channel", () => {
    // THE NEGATIVE CONTROL FOR RULE 4. `connectionsToRestore` is the only
    // thing in the module allowed to raise anything. A run waiting on an
    // answer is already counted once, as a decision, by the query in
    // server/inbox.ts. Raising it here too would ask the owner twice.
    const rollups = rollUpRoutineRuns([run({ at: T0 - HOUR, owed: true })], T0);
    expect(rollups[0]!.verdict).toBe("waiting");
    expect(connectionsToRestore(rollups)).toEqual([]);
  });

  it("goes back to being news the moment it is answered", () => {
    // The verdict is the LAST run, here as everywhere. An answered question
    // followed by a clean run is a routine that works.
    const rollups = rollUpRoutineRuns([
      run({ at: T0 - 2 * HOUR, owed: true }),
      run({ at: T0 - HOUR }),
    ], T0);
    expect(rollups[0]).toMatchObject({ verdict: "ok", cause: null });
    expect(rollups[0]!.verdict).not.toBe("waiting");
  });
});
