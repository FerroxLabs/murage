import { checkTurnMemory } from "./memory.mjs";

const NETWORK_SENSITIVE = new Set(["TURN_ERROR", "TURN_TIMEOUT", "RELAUNCH", "FEED"]);
const PRODUCT = new Set([
  "ARTIFACT_MISMATCH", "PUBLIC_MISMATCH", "SIGNATURE", "INSTALL", "LAUNCH", "IDENTITY",
  "CONSUMED_MISMATCH", "TOKEN_MISSING", "UI_API_DISAGREE", "TOOL_MISSING", "TURN_MISSING",
  "MEMORY_STUCK", "TEARDOWN", "NEVER_LIST_BLOCKED", "ASSETS_CHANGED",
]);
const HARNESS = new Set(["RESTORE", "SECRET_IN_EVIDENCE", "DESTROY_UNCONFIRMED", "ATTRIBUTION_CONFLICT"]);
// Segments only move forward; the segment, not the thrower's flag, decides who owns a failure (O23 section 5).
const SEGMENTS = ["BASELINE", "UPDATE", "CANDIDATE"];
const UPDATE_ONLY = new Set(["FEED", "CONSUMED_MISMATCH", "RELAUNCH", "IDENTITY"]);
// Reasons that are about the harness or the qualification, never about N-1 or N: segment never rewrites them.
const SEGMENT_NEUTRAL = new Set(["ATTRIBUTION_CONFLICT", "QUAL_STALE", "QUAL_UNVERIFIED"]);
const INCOMPLETE = new Set([
  "OBSERVATION_LOST", "BASELINE_UNHEALTHY", "DATA_CHANGED", "DATA_NOT_ALLOWED", "NOT_CANARY_ACCOUNT",
  "ISOLATION", "OFFLINE", "BUSY", "PROFILE_STALE", "UPSTREAM", "NO_CREDENTIAL", "NOT_FRESH",
  "NO_GRACEFUL_QUIT", "QUAL_STALE", "QUAL_UNVERIFIED", "TRANSFER", "DATA_STALE", "DATA_SMALL", "DATA_COPY_LIVE", "NO_BACKGROUND_SESSION", "NETWORK",
]);
const DENY = [
  ["D1", /RELAY_SEALED/], ["D2", /seals the relay/], ["D3", /mount-relay-sealed/],
  ["D4", /relay\.seal/], ["D5", /\[mount-relay\].*failed/], ["D6", /\[mount-relay\] engine connection (?:error|closed) seals the relay/],
  ["D7", /ERR_MODULE_NOT_FOUND|Cannot find module/], ["D8", /uncaughtException|unhandledRejection/],
  ["D9", /render-process-gone|child-process-gone/],
];

export class LegFailure extends Error {
  constructor(reason, stage, { baseline, probe } = {}) {
    super(reason);
    this.stage = stage;
    this.baseline = baseline;
    this.probe = probe;
  }
}

function reasonClass(reason) {
  if (INCOMPLETE.has(reason)) return "incomplete";
  if (HARNESS.has(reason)) return "harness";
  if (PRODUCT.has(reason) || NETWORK_SENSITIVE.has(reason) || /^LOG_DENY:D[1-9]$/.test(reason)) return "rollback";
  throw new Error(`Unknown leg reason ${reason}`);
}

function priority(row) {
  if (row.class === "rollback") return NETWORK_SENSITIVE.has(row.reason) ? 4 : 5;
  if (row.class === "harness") return 3;
  return row.reason === "NETWORK" ? 2 : 1;
}

function turnReason({ outcome, channelOpen, appAlive }) {
  if (appAlive === false) return "LAUNCH";
  if (channelOpen === false && appAlive === true) return "OBSERVATION_LOST";
  if (channelOpen === false) throw new Error("Missing process observation");
  if (outcome === "pass") return null;
  if (outcome === "timeout" && channelOpen === true) return "TURN_TIMEOUT";
  if (outcome === "upstream") return "UPSTREAM";
  if (outcome === "error") return "TURN_ERROR";
  throw new Error("Unclassified turn outcome");
}

export async function runLeg({ phase, attempt, work, restore, preflight }) {
  const launches = [];
  const turns = [];
  const recall = [];
  const reasons = [];
  const cleanup_reasons = [];
  const unexpected = [];
  const baselineTurnErrors = new WeakMap();
  // PRE legs have no N-1; POST and LATEST legs start on N-1 (a pre-launch N-1 failure is held).
  let segment = phase === "pre" ? "CANDIDATE" : "BASELINE";
  let entered = false;

  function enter(next) {
    const to = SEGMENTS.indexOf(next);
    if (to < 0 || to < SEGMENTS.indexOf(segment)) {
      throw new LegFailure("ATTRIBUTION_CONFLICT", "ENTER");
    }
    segment = next;
    entered = true;
  }

  // seg: the segment that owns the row. Launch-bound rows pass launch.segment; thrown failures pass the segment at the throw.
  function record(reason, stage, launch, { seg = launch?.segment ?? segment, baseline, probe, cleanup, thrown } = {}) {
    const original = reason;
    if (!SEGMENT_NEUTRAL.has(reason)) {
      // An explicit flag only confirms the segment; a contradiction is held and alerted, never rolled back.
      if ((baseline === true && seg !== "BASELINE") || (baseline === false && seg === "BASELINE") ||
          (thrown && seg === "BASELINE" && UPDATE_ONLY.has(reason))) reason = "ATTRIBUTION_CONFLICT";
      // N-1 evidence never counts against N.
      else if (seg === "BASELINE") reason = "BASELINE_UNHEALTHY";
    }
    reasonClass(original);
    const classification = reasonClass(reason);
    if (reason === original && NETWORK_SENSITIVE.has(reason) && probe === "unhealthy") reason = "NETWORK";
    const row = {
      reason, class: cleanup ? "harness" : reason === original || reason === "ATTRIBUTION_CONFLICT" ? classification : "incomplete", stage,
      launch: launch?.number ?? null, attempt, observed_build: launch?.observed_build ?? null,
      ...(reason !== original && { original_reason: original }),
    };
    (cleanup ? cleanup_reasons : reasons).push(row);
    return row;
  }

  async function scan(read, launch) {
    try {
      const lines = (await read()).split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        for (const [rule, pattern] of DENY) {
          if (pattern.test(line)) record(`LOG_DENY:${rule}`, "LOG-SCAN", launch).line = index + 1;
        }
      }
    } catch (error) {
      unexpected.push(error);
    }
  }

  function started(steps) {
    const launch = { ...steps, number: launches.length + 1, segment };
    launches.push(launch);
    return {
      async turns(requiredTurns) {
        for (const runTurn of requiredTurns) {
          let turn;
          try {
            turn = await runTurn();
          } catch (error) {
            if (error instanceof Error) baselineTurnErrors.set(error, launch);
            throw error;
          }
          const reason = turnReason(turn);
          const row = reason && record(reason, "TURNS", launch, { probe: turn.probe });
          let memory = null;
          if (turn.memory && (typeof turn.memory.log === "string" || turn.memory.reply != null)) {
            const { log, recallCode, ...observation } = turn.memory;
            const seen = checkTurnMemory(log ?? "", {
              ...observation, outcome: turn.outcome,
              recallCode: reason && observation.reply == null ? undefined : recallCode,
            });
            const { reason: memoryReason, ...details } = seen;
            recall.push({ ...details, launch: launch.number });
            if (memoryReason) memory = record(memoryReason, "TURNS", launch);
          }
          if (turn.outcome === "pass" && (!turn.memory?.thread || turn.memory.reply == null ||
              (turn.kind === "recall" && !turn.memory.recallCode))) {
            memory = record("MEMORY_STUCK", "TURNS", launch);
          }
          const failure = memory || row;
          turns.push({
            kind: turn.kind, launch: launch.number,
            verdict: failure ? (failure.class === "incomplete" ? "INCOMPLETE" : "FAIL") : "PASS",
          });
          if (turn.appAlive === false || turn.channelOpen === false) break;
        }
      },
    };
  }

  try {
    if (preflight) await preflight();
    await work(started, { enter });
    if (phase !== "pre" && segment === "BASELINE" && !reasons.length) {
      // The harness never called enter(): N-1's proof would pass as N's. Held, never PASS.
      record("ATTRIBUTION_CONFLICT", "ATTRIBUTION", null);
    }
  } catch (error) {
    try {
      if (!(error instanceof LegFailure)) throw error;
      const { probe, baseline } = error;
      // A failure thrown from a turn callback belongs to the launch it ran on, not to the segment now current.
      const owner = baselineTurnErrors.get(error);
      record(error.message, error.stage, owner ?? launches.at(-1), {
        seg: owner ? owner.segment : segment, baseline, probe, thrown: !owner,
      });
    } catch (failure) {
      unexpected.push(failure);
    }
  } finally {
    for (const launch of launches) {
      try {
        await launch.quit();
      } catch {
        record("TEARDOWN", "QUIT+TEARDOWN", launch, { cleanup: launch.segment !== "BASELINE" && reasons.length > 0 });
      }
      await scan(launch.readLog, launch);
      await scan(launch.readCrashes, launch);
    }
    try {
      await restore();
    } catch {
      record("RESTORE", "RESTORE", null, { cleanup: true });
    }
  }

  const primary = [...reasons, ...cleanup_reasons].reduce((top, row) => {
    if (!top || priority(row) > priority(top)) return row;
    if (top.reason === "LAUNCH" && row.reason === "LOG_DENY:D9" && row.launch === top.launch) return row;
    return top;
  }, null);
  const verdict = primary ? (primary.class === "incomplete" ? "INCOMPLETE" : "FAIL") : "PASS";
  let latest_state = null;
  if (phase === "latest") {
    if (primary?.class === "rollback") latest_state = "confirming";
    else latest_state = primary ? "held" : "pass";
  }
  const result = {
    verdict, latest_state, turns, recall, reasons, cleanup_reasons,
    reason: primary?.reason ?? null, reason_class: primary?.class ?? null,
    stage: primary?.stage ?? null, observed_build: primary?.observed_build ?? null,
  };
  if (unexpected.length) {
    throw new AggregateError(unexpected, "Leg evidence could not be completed", {
      cause: { ...result, verdict: "FAIL", latest_state: latest_state === "pass" ? "held" : latest_state },
    });
  }
  return result;
}
