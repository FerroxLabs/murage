// Offline comparison of explicitly supplied, sanitized completed-task exports.
// This does not discover omitted calls, fetch prices, or run a benchmark.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const identities = ["sourceSha", "fixture", "workload", "model", "protocol", "effort", "billingAccount"];
const outcomes = ["firstTurn", "resumedTurn", "toolDiscovery", "retrievalFidelity", "permissions"];
const metrics = ["input", "output", "cachedInput", "costUsd"];
const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const named = value => typeof value === "string" && value.trim().length > 0;
function unique(values, label) {
  if (!Array.isArray(values) || values.some(value => !named(value)) || new Set(values).size !== values.length) fail(`${label}: expected unique nonempty IDs`);
  return new Set(values);
}
function sameSet(a, b) { return a.size === b.size && [...a].every(value => b.has(value)); }
function amount(value, key) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (key !== "costUsd" && !Number.isSafeInteger(value))) fail(`Invalid terminal ${key}`);
  return value;
}
function terminal(attempt) {
  if (!Array.isArray(attempt.events)) fail("Attempt events must be an array");
  if (attempt.events.some(event => !object(event) || !["turn.completed", "thread.token-usage.updated"].includes(event.type))) fail("Unknown usage event type");
  const terminals = attempt.events.filter(event => event.type === "turn.completed");
  if (terminals.length > 1) fail("Multiple terminal usage receipts for one attempt");
  const receipt = terminals[0];
  if (receipt?.usage !== undefined && !object(receipt.usage)) fail("Invalid terminal usage");
  const result = Object.fromEntries(metrics.map(key => [key, amount(key === "costUsd" ? receipt?.costUsd : receipt?.usage?.[key], key)]));
  if (result.cachedInput !== null && result.input !== null && result.cachedInput > result.input) fail("Cached input exceeds input; it must be a subset");
  return result;
}
function total(rows) {
  return Object.fromEntries(metrics.map(key => [key, rows.every(row => row[key] !== null) ? rows.reduce((sum, row) => sum + row[key], 0) : null]));
}

export function summarize(data) {
  if (!object(data) || data.version !== 1 || !["build", "product"].includes(data.kind)) fail("Expected version 1 build or product export");
  if (data.attributionComplete !== true) fail("Complete attempt attribution must be explicitly attested");
  if (!object(data.identity) || identities.some(key => !named(data.identity[key]))) fail("Missing pinned identity");
  if (!/^[a-f0-9]{40}$/.test(data.identity.sourceSha)) fail("sourceSha must be a full source commit SHA");
  const expected = unique(data.expectedAttemptIds, "Expected attempts");
  if (!Array.isArray(data.attempts) || !Array.isArray(data.tasks) || !data.tasks.length) fail("Attempts and accepted tasks are required");
  const attempts = unique(data.attempts.map(attempt => attempt?.id), "Attempts");
  const taskIds = unique(data.tasks.map(task => task?.id), "Tasks");
  if (!expected.size || !sameSet(expected, attempts)) fail("Missing or unexpected attempt receipts");
  const byId = new Map();
  const roles = { execution: 0, failure: 0, review: 0, recovery: 0 };
  for (const attempt of data.attempts) {
    if (!taskIds.has(attempt.taskId) || !Object.hasOwn(roles, attempt.role) || !["completed", "failed", "cancelled"].includes(attempt.status)) fail("Invalid attempt attribution, role or terminal status");
    byId.set(attempt.id, { ...attempt, totals: terminal(attempt) });
    roles[attempt.role]++;
  }
  const assigned = new Set();
  const tasks = data.tasks.map(task => {
    if (task.accepted !== true || !named(task.evidence) || !object(task.outcomes) || outcomes.some(key => task.outcomes[key] !== true)) fail("Task lacks accepted first/resumed/capability/permission outcomes and evidence");
    const taskAttempts = unique(task.attemptIds, "Task attempts");
    if (!taskAttempts.size) fail("An accepted task needs attempt receipts");
    for (const id of taskAttempts) {
      if (assigned.has(id) || byId.get(id)?.taskId !== task.id) fail("Attempt assigned twice or to the wrong task");
      assigned.add(id);
    }
    const rows = [...taskAttempts].map(id => byId.get(id));
    if (!rows.some(row => row.role === "execution" && row.status === "completed")) fail("Accepted task has no completed execution attempt");
    return { id: task.id, attempts: rows.length, totals: total(rows.map(row => row.totals)) };
  });
  if (!sameSet(assigned, expected)) fail("Not every attempt is attributed to an accepted task");
  const totals = total([...byId.values()].map(attempt => attempt.totals));
  return { kind: data.kind, identity: Object.fromEntries(identities.map(key => [key, data.identity[key]])),
    acceptedTasks: tasks.length, attempts: attempts.size, roles, totals,
    costPerAcceptedTaskUsd: totals.costUsd === null ? null : totals.costUsd / tasks.length,
    tasks, limitation: "Attribution completeness and outcome evidence are supplied attestations, not independently discovered by this tool." };
}

export function compare(baseline, candidate) {
  const before = summarize(baseline), after = summarize(candidate);
  if (before.kind !== after.kind) fail("Build and product ledgers must remain separate");
  for (const key of identities.filter(key => key !== "sourceSha")) if (before.identity[key] !== after.identity[key]) fail(`Unmatched comparison identity: ${key}`);
  if (!sameSet(new Set(before.tasks.map(task => task.id)), new Set(after.tasks.map(task => task.id)))) fail("Unmatched accepted-task cohort");
  if (before.totals.costUsd === null || after.totals.costUsd === null) fail("Cost comparison requires complete terminal cost receipts for every attempt");
  const delta = after.costPerAcceptedTaskUsd - before.costPerAcceptedTaskUsd;
  return { baseline: before, candidate: after, costPerAcceptedTaskDeltaUsd: delta,
    costReductionPercent: before.costPerAcceptedTaskUsd === 0 ? null : -100 * delta / before.costPerAcceptedTaskUsd,
    verdict: delta < 0 ? "lower-cost-for-declared-accepted-cohort" : delta > 0 ? "higher-cost-for-declared-accepted-cohort" : "same-cost-for-declared-accepted-cohort",
    limitation: "This measures supplied receipts; it does not establish a causal optimization or approve a product release." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...files] = process.argv.slice(2);
    if (!((command === "summary" && files.length === 1) || (command === "compare" && files.length === 2))) fail("Usage: b25-measure.mjs summary export.json | compare baseline.json candidate.json");
    const bytes = files.map(file => readFileSync(file));
    let exports;
    try { exports = bytes.map(value => JSON.parse(value.toString("utf8"))); } catch { fail("Invalid JSON export"); }
    const report = command === "summary" ? summarize(exports[0]) : compare(exports[0], exports[1]);
    process.stdout.write(JSON.stringify({ ...report, inputSha256: bytes.map(value => createHash("sha256").update(value).digest("hex")) }, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`B25 refused: ${error instanceof Error ? error.message : "invalid export"}\n`);
    process.exitCode = 2;
  }
}
