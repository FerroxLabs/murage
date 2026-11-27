import { checkTurnMemory } from "./memory.mjs";

const NETWORK_SENSITIVE = new Set(["TURN_ERROR", "TURN_TIMEOUT", "RELAUNCH", "FEED"]);
const PRODUCT = new Set([
  "ARTIFACT_MISMATCH", "PUBLIC_MISMATCH", "SIGNATURE", "INSTALL", "LAUNCH", "IDENTITY",
  "CONSUMED_MISMATCH", "TOKEN_MISSING", "UI_API_DISAGREE", "TOOL_MISSING", "TURN_MISSING",
  "MEMORY_STUCK", "TEARDOWN", "NEVER_LIST_BLOCKED", "ASSETS_CHANGED",
]);
const HARNESS = new Set(["RESTORE", "SECRET_IN_EVIDENCE", "DESTROY_UNCONFIRMED"]);
const INCOMPLETE = new Set([
  "OBSERVATION_LOST", "BASELINE_UNHEALTHY", "DATA_CHANGED", "DATA_NOT_ALLOWED", "NOT_CANARY_ACCOUNT",
  "ISOLATION", "OFFLINE", "BUSY", "PROFILE_STALE", "UPSTREAM", "NO_CREDENTIAL", "NOT_FRESH",
  "NO_GRACEFUL_QUIT", "TRANSFER", "DATA_STALE", "DATA_SMALL", "DATA_COPY_LIVE", "NO_BACKGROUND_SESSION", "NETWORK",
]);
const DENY = [
  ["D1", /RELAY_SEALED/], ["D2", /seals the relay/], ["D3", /mount-relay-sealed/],
  ["D4", /relay\.seal/], ["D5", /\[mount-relay\].*failed/], ["D6", /\[mount-relay\] engine connection (?:error|closed) seals the relay/],
  ["D7", /ERR_MODULE_NOT_FOUND|Cannot find module/], ["D8", /uncaughtException|unhandledRejection/],
  ["D9", /render-process-gone|child-process-gone/],
];

export class LegFailure extends Error {
  constructor(reason, stage, { baseline = false, probe } = {}) {
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

export async function runLeg({ phase, attempt, work, restore }) {
  const launches = [];
  const turns = [];
  const recall = [];
  const reasons = [];
  const cleanup_reasons = [];
  const unexpected = [];
  const baselineTurnErrors = new WeakSet();

  function record(reason, stage, launch, { baseline, probe, cleanup } = {}) {
    const classification = reasonClass(reason);
    const original = reason;
    // N-1 evidence never counts against N: only an in-app update failure may leave a baseline launch unheld.
    if (baseline === true || (launch?.baseline && stage !== "IN-APP")) reason = "BASELINE_UNHEALTHY";
    else if (NETWORK_SENSITIVE.has(reason) && probe === "unhealthy") reason = "NETWORK";
    const row = {
      reason, class: cleanup ? "harness" : reason === original ? classification : "incomplete", stage,
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
    const launch = { ...steps, number: launches.length + 1 };
    launches.push(launch);
    return {
      async turns(requiredTurns) {
        for (const runTurn of requiredTurns) {
          let turn;
          try {
            turn = await runTurn();
          } catch (error) {
            if (launch.baseline && error instanceof Error) baselineTurnErrors.add(error);
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
    await work(started);
  } catch (error) {
    try {
      if (!(error instanceof LegFailure)) throw error;
      const { probe } = error;
      const baseline = error.baseline === true || baselineTurnErrors.has(error);
      record(error.message, error.stage, launches.at(-1), { baseline, probe });
    } catch (failure) {
      unexpected.push(failure);
    }
  } finally {
    for (const launch of launches) {
      try {
        await launch.quit();
      } catch {
        record("TEARDOWN", "QUIT+TEARDOWN", launch, { cleanup: !launch.baseline && reasons.length > 0 });
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
