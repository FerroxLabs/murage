import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { compare, summarize } from "./b25-measure.mjs";

function fixture() {
  return { version: 1, kind: "product", attributionComplete: true,
    identity: { sourceSha: "a".repeat(40), fixture: "fixture-1", workload: "first-and-resumed", model: "fake", protocol: "fake-v1", effort: "medium", billingAccount: "synthetic" },
    expectedAttemptIds: ["a1"], tasks: [{ id: "task1", accepted: true, evidence: "synthetic-receipt", attemptIds: ["a1"],
      outcomes: { firstTurn: true, resumedTurn: true, toolDiscovery: true, retrievalFidelity: true, permissions: true } }],
    attempts: [{ id: "a1", taskId: "task1", role: "execution", status: "completed", events: [
      { type: "thread.token-usage.updated", usage: { input: 99999, output: 99999 }, costUsd: 999 },
      { type: "turn.completed", usage: { input: 100, output: 20, cachedInput: 30 }, costUsd: 0.5 } ] }] };
}
test("authoritative terminal usage replaces running indicators; cache is not added again", () => {
  const result = summarize(fixture());
  assert.deepEqual(result.totals, { input: 100, output: 20, cachedInput: 30, costUsd: 0.5 });
  assert.equal(result.costPerAcceptedTaskUsd, 0.5);
});
test("missing usage stays unknown, including when a terminal receipt is absent", () => {
  const data = fixture(); data.attempts[0].events = [];
  assert.deepEqual(summarize(data).totals, { input: null, output: null, cachedInput: null, costUsd: null });
  data.attempts[0].events = [{ type: "turn.completed", costUsd: 0 }];
  assert.equal(summarize(data).totals.costUsd, 0); assert.equal(summarize(data).totals.input, null);
  assert.throws(() => compare(fixture(), { ...data, attempts: [{ ...data.attempts[0], events: [] }] }), /complete terminal cost/);
});
test("cached input must remain a subset and terminal receipts cannot be counted twice", () => {
  const data = fixture(); data.attempts[0].events[1].usage.cachedInput = 101;
  assert.throws(() => summarize(data), /subset/);
  data.attempts[0].events[1].usage.cachedInput = 30;
  data.attempts[0].events.push(structuredClone(data.attempts[0].events[1]));
  assert.throws(() => summarize(data), /Multiple terminal/);
});
test("failure, review and recovery costs are included in accepted-task cost", () => {
  const data = fixture();
  for (const role of ["failure", "review", "recovery"]) {
    const id = role; data.expectedAttemptIds.push(id); data.tasks[0].attemptIds.push(id);
    data.attempts.push({ id, taskId: "task1", role, status: role === "failure" ? "failed" : "completed",
      events: [{ type: "turn.completed", usage: { input: 10, output: 2, cachedInput: 0 }, costUsd: 0.25 }] });
  }
  const result = summarize(data);
  assert.equal(result.costPerAcceptedTaskUsd, 1.25);
  assert.deepEqual(result.roles, { execution: 1, failure: 1, review: 1, recovery: 1 });
  data.attempts[3].events = [];
  assert.equal(summarize(data).costPerAcceptedTaskUsd, null);
});
test("missing, duplicate, orphaned or cross-task attempts are refused", () => {
  for (const mutate of [
    data => data.expectedAttemptIds.push("missing"),
    data => data.attempts.push(structuredClone(data.attempts[0])),
    data => { data.tasks[0].attemptIds = []; },
    data => { data.attempts[0].taskId = "other"; },
    data => { data.attributionComplete = false; },
    data => { data.attempts[0].status = "running"; },
  ]) { const data = fixture(); mutate(data); assert.throws(() => summarize(data)); }
});
test("outcome failures, mismatched identities, cohorts and mixed ledgers prevent comparison", () => {
  for (const key of ["firstTurn", "resumedTurn", "toolDiscovery", "retrievalFidelity", "permissions"]) {
    const candidate = fixture(); candidate.tasks[0].outcomes[key] = false;
    assert.throws(() => compare(fixture(), candidate), /outcomes/);
  }
  for (const key of ["fixture", "workload", "model", "protocol", "effort", "billingAccount"]) {
    const candidate = fixture(); candidate.identity[key] = "different";
    assert.throws(() => compare(fixture(), candidate), /Unmatched/);
  }
  const candidate = fixture(); candidate.kind = "build";
  assert.throws(() => compare(fixture(), candidate), /separate/);
  candidate.kind = "product"; candidate.tasks[0].id = "task2"; candidate.attempts[0].taskId = "task2";
  assert.throws(() => compare(fixture(), candidate), /cohort/);
});
test("matched costs compare with distinct pinned sources; zero baseline has no percentage", () => {
  const before = fixture(), after = fixture(); after.identity.sourceSha = "b".repeat(40);
  after.attempts[0].events[1].costUsd = 0.25;
  assert.equal(compare(before, after).costReductionPercent, 50);
  before.attempts[0].events[1].costUsd = 0;
  assert.equal(compare(before, after).costReductionPercent, null);
});
test("CLI processes only supplied synthetic exports and fingerprints its input", () => {
  const root = mkdtempSync(join(tmpdir(), "murage-b25-test-"));
  try {
    const path = join(root, "export.json"); writeFileSync(path, JSON.stringify(fixture()));
    const script = new URL("./b25-measure.mjs", import.meta.url).pathname;
    const result = spawnSync(process.execPath, [script, "compare", path, path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout); assert.equal(report.costReductionPercent, 0);
    assert.match(report.inputSha256[0], /^[a-f0-9]{64}$/);
    assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8" }).status, 2);
  } finally { safeWipeSync(root); }
});
