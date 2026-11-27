import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { removeTempDir } from "../../server/testing/cleanup.ts";
import { LegFailure, runLeg } from "./leg.mjs";

const dirs = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

async function fixture(work, { restoreFails = false, quitFails = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "canary-leg-"));
  dirs.push(dir);
  const order = [];
  const restore = async () => {
    order.push("restore");
    if (restoreFails) throw new Error("fixture restore unavailable");
  };
  const launch = async (register, { baseline = false, line = "", crash = "" } = {}) => {
    const id = order.filter((step) => step.startsWith("start:")).length + 1;
    const log = join(dir, `log-${id}`);
    const crashes = join(dir, `crashes-${id}`);
    await writeFile(log, line);
    await writeFile(crashes, crash);
    order.push(`start:${id}`);
    return register({
      baseline, observed_build: baseline ? "1.2.2" : "1.2.3",
      quit: async () => {
        order.push(`quit:${id}`);
        await appendFile(log, "\nquit completed");
        if (quitFails) throw new Error("fixture quit unavailable");
      },
      readLog: async () => {
        order.push(`log:${id}`);
        return readFile(log, "utf8");
      },
      readCrashes: async () => {
        order.push(`crashes:${id}`);
        return readFile(crashes, "utf8");
      },
    });
  };
  const result = await runLeg({ phase: "latest", attempt: 1, restore, work: (register) => work(register, launch) });
  return { result, order };
}

const openTimeout = { kind: "claude", outcome: "timeout", channelOpen: true, appAlive: true };
const lost = { ...openTimeout, channelOpen: false };
const recall = {
  kind: "recall", outcome: "pass",
  memory: {
    thread: "sample", reply: "CANARY-RECALL-sample", recallCode: "CANARY-RECALL-sample",
    log: "turn dispatch recall=full thread=sample",
  },
};

test("W17b transport loss with a live app is INCOMPLETE and still scans before restore", async () => {
  const { result, order } = await fixture(async (register, launch) => {
    const leg = await launch(register);
    await leg.turns([async () => ({
      ...recall, ...lost, kind: "recall",
      memory: { ...recall.memory, reply: null },
    })]);
  });
  expect(result).toMatchObject({
    verdict: "INCOMPLETE", reason: "OBSERVATION_LOST", latest_state: "held",
    stage: "TURNS", observed_build: "1.2.3",
  });
  expect(order).toEqual(["start:1", "quit:1", "log:1", "crashes:1", "restore"]);
});

test("W17b open channel times out and a closed channel with a crash preserves product evidence", async () => {
  const open = await fixture(async (register, launch) => {
    await (await launch(register)).turns([async () => openTimeout]);
  });
  expect(open.result).toMatchObject({ verdict: "FAIL", reason: "TURN_TIMEOUT", latest_state: "confirming" });
  const crash = await fixture(async (register, launch) => {
    await (await launch(register, { crash: "render-process-gone" })).turns([async () => ({ ...lost, appAlive: false })]);
  });
  expect(crash.result).toMatchObject({ verdict: "FAIL", reason: "LOG_DENY:D9", latest_state: "confirming" });
  const seal = await fixture(async (register, launch) => {
    await (await launch(register, { line: "engine seals the relay" })).turns([async () => lost]);
  });
  expect(seal.result).toMatchObject({ verdict: "FAIL", reason: "LOG_DENY:D2", latest_state: "confirming" });
});

test("W17b any baseline turn or log failure is held without attributing it to the candidate", async () => {
  const { result } = await fixture(async (register, launch) => {
    const baseline = await launch(register, { baseline: true, line: "engine seals the relay" });
    await baseline.turns([async () => ({ ...openTimeout, outcome: "error" })]);
  });
  expect(result).toMatchObject({
    verdict: "INCOMPLETE", reason: "BASELINE_UNHEALTHY", latest_state: "held",
    observed_build: "1.2.2",
    reasons: [
      { reason: "BASELINE_UNHEALTHY", stage: "TURNS", original_reason: "TURN_ERROR", launch: 1, attempt: 1 },
      { reason: "BASELINE_UNHEALTHY", stage: "LOG-SCAN", original_reason: "LOG_DENY:D2", launch: 1, attempt: 1 },
    ],
  });
});

test.each(["FEED", "CONSUMED_MISMATCH", "RELAUNCH", "IDENTITY"])(
  "in-app %s after a healthy baseline enters confirming",
  async (reason) => {
    const { result, order } = await fixture(async (register, launch) => {
      const baseline = await launch(register, { baseline: true });
      await baseline.turns([async () => recall]);
      throw new LegFailure(reason, "IN-APP", { baseline: false, probe: "healthy" });
    });
    expect(result).toMatchObject({
      verdict: "FAIL", reason, reason_class: "rollback", latest_state: "confirming", stage: "IN-APP",
      turns: [{ kind: "recall", launch: 1, verdict: "PASS" }],
      reasons: [{ reason, stage: "IN-APP", launch: 1, observed_build: "1.2.2" }],
    });
    expect(order).toEqual(["start:1", "quit:1", "log:1", "crashes:1", "restore"]);
  },
);

test.each([
  ["FEED", "NETWORK", "INCOMPLETE", "held"],
  ["RELAUNCH", "NETWORK", "INCOMPLETE", "held"],
  ["CONSUMED_MISMATCH", "CONSUMED_MISMATCH", "FAIL", "confirming"],
  ["IDENTITY", "IDENTITY", "FAIL", "confirming"],
])("in-app %s with an unhealthy probe yields %s", async (reason, expected, verdict, latest_state) => {
  const { result } = await fixture(async (register, launch) => {
    await launch(register, { baseline: true });
    throw new LegFailure(reason, "IN-APP", { probe: "unhealthy" });
  });
  expect(result).toMatchObject({ verdict, reason: expected, latest_state });
});

test.each([
  ["turn callback rejects, flag omitted", "TURN_ERROR", "TURNS", undefined, true],
  ["turn callback rejects, flag false", "TURN_ERROR", "TURNS", false, true],
  ["turn callback rejects with a mislabelled stage", "TURN_TIMEOUT", "IN-APP", undefined, true],
  ["thrown after the baseline turns, flag omitted", "TURN_ERROR", "TURNS", undefined, false],
])("a thrown N-1 turn failure (%s) is held and never confirms N", async (_, reason, stage, baseline, inTurn) => {
  const failure = () => new LegFailure(reason, stage, baseline === undefined ? {} : { baseline });
  for (let repeat = 1; repeat <= 2; repeat += 1) {
    const { result, order } = await fixture(async (register, launch) => {
      const n1 = await launch(register, { baseline: true });
      await n1.turns([async () => recall, ...(inTurn ? [async () => { throw failure(); }] : [])]);
      if (!inTurn) throw failure();
    });
    expect(result).toMatchObject({
      verdict: "INCOMPLETE", reason: "BASELINE_UNHEALTHY", reason_class: "incomplete", latest_state: "held",
      observed_build: "1.2.2",
      reasons: [{ reason: "BASELINE_UNHEALTHY", original_reason: reason, stage, launch: 1 }],
    });
    expect(result.reasons).toHaveLength(1);
    expect(order).toEqual(["start:1", "quit:1", "log:1", "crashes:1", "restore"]);
  }
});

test("W5 early upstream exit keeps quit, launch slice and crash evidence ahead of a failed restore", async () => {
  const { result, order } = await fixture(async (register, launch) => {
    await launch(register, { line: "engine seals the relay" });
    await Promise.reject(new LegFailure("UPSTREAM", "TURNS"));
  }, { restoreFails: true });
  expect(order).toEqual(["start:1", "quit:1", "log:1", "crashes:1", "restore"]);
  expect(result).toMatchObject({
    verdict: "FAIL", reason_class: "rollback", reason: "LOG_DENY:D2", latest_state: "confirming",
    reasons: [{ reason: "UPSTREAM" }, { reason: "LOG_DENY:D2" }],
    cleanup_reasons: [{ reason: "RESTORE" }],
  });
});

test("W5 scans after quit failure and finalizes every started launch before restore", async () => {
  const { result, order } = await fixture(async (register, launch) => {
    await launch(register, { baseline: true });
    await launch(register, { line: "engine seals the relay" });
    throw new LegFailure("UPSTREAM", "TURNS");
  }, { quitFails: true });
  expect(order).toEqual(["start:1", "start:2", "quit:1", "log:1", "crashes:1", "quit:2", "log:2", "crashes:2", "restore"]);
  expect(result.reasons.map(({ reason }) => reason)).toEqual(["UPSTREAM", "BASELINE_UNHEALTHY", "LOG_DENY:D2"]);
  expect(result.cleanup_reasons).toMatchObject([{ reason: "TEARDOWN" }]);
  expect(result.reason).toBe("LOG_DENY:D2");
});

test("W1 each required turn is judged even when an earlier turn fails", async () => {
  const { result } = await fixture(async (register, launch) => {
    await (await launch(register)).turns([
      async () => ({ ...openTimeout, outcome: "error" }),
      async () => ({ ...openTimeout, kind: "tool" }),
      async () => recall,
    ]);
  });
  expect(result.turns).toMatchObject([
    { kind: "claude", verdict: "FAIL" }, { kind: "tool", verdict: "FAIL" }, { kind: "recall", verdict: "PASS" },
  ]);
  expect(result.reasons.map(({ reason }) => reason)).toEqual(["TURN_ERROR", "TURN_TIMEOUT"]);
});

test("a pre-launch error restores without creating launch evidence", async () => {
  const { result, order } = await fixture(async () => { throw new LegFailure("OFFLINE", "PREFLIGHT"); });
  expect(order).toEqual(["restore"]);
  expect(result).toMatchObject({ verdict: "INCOMPLETE", reason: "OFFLINE", observed_build: null });
});

test("an explicit baseline install failure is held before the first launch", async () => {
  const { result, order } = await fixture(async () => {
    throw new LegFailure("INSTALL", "BASELINE", { baseline: true });
  });
  expect(order).toEqual(["restore"]);
  expect(result).toMatchObject({
    verdict: "INCOMPLETE", reason: "BASELINE_UNHEALTHY", latest_state: "held",
    reasons: [{ reason: "BASELINE_UNHEALTHY", original_reason: "INSTALL", launch: null }],
  });
});

test("W15a a held recall with the expected code still fails the leg", async () => {
  const { result } = await fixture(async (register, launch) => {
    const leg = await launch(register);
    const log = [
      "[memory] fence recovery tier=0 thread=sample refused=none parts=0 omitted=37 cause=checking",
      "turn dispatch recall=held thread=sample",
      "claude first-token thread=sample",
    ].join("\n");
    await leg.turns([async () => ({ ...recall, memory: { ...recall.memory, log } })]);
  });
  expect(result).toMatchObject({
    verdict: "FAIL", reason: "MEMORY_STUCK",
    recall: [{ thread: "sample", dispatch: "held", fence_checking: true }],
  });
});
