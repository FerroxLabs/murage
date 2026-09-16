import { createHash } from "node:crypto";
import { database, transaction } from "../database.ts";
import { gepaEvaluationSchema, type GepaEvaluation, type GepaJson } from "../gepa-protocol.ts";
import { runGepaWorker, isGepaCallNotStarted, type GepaWorkerCommand } from "../gepa-worker.ts";
import { createGepaCallLedger } from "./gepa-ledger.ts";
import { procedureCandidateHash, procedureSnapshotDigest, procedureTargetDigest, validateProcedureEvaluationReceipt, type ProcedureEvaluationReceipt, type ProcedureReviewSnapshot } from "./procedure-review.ts";

type SplitAxis = "person" | "project" | "time";
export interface ProcedureEvaluationCase {
  id: string;
  groups: Record<SplitAxis, string>;
  input: GepaJson;
  expected: GepaJson;
}
export interface ProcedureCorpus {
  id: string; version: string;
  /** Chosen by the host for this artifact, never by the optimizer. */
  groupBy: SplitAxis[];
  train: ProcedureEvaluationCase[];
  validation: ProcedureEvaluationCase[];
  holdout: ProcedureEvaluationCase[];
}
export interface ProcedureEvaluatorOptions {
  command: GepaWorkerCommand;
  workerDigest: string;
  evaluatorId: string;
  seedInstruction: string;
  corpus: ProcedureCorpus;
  /** Ceilings must be established by the admitted provider adapter. */
  budget: { totalUsd: number | null; evaluationPerCaseUsd: number | null; reflectionUsd: number | null; authorityReference: string };
  /** Trusted objective harness: model-written scores are not an implementation. */
  evaluate(instruction: string, cases: readonly ProcedureEvaluationCase[], signal: AbortSignal): Promise<{ evaluation: GepaEvaluation; hardPass: boolean[]; costUsd: number | null }>;
  reflect(prompt: string, signal: AbortSignal): Promise<{ text: string; costUsd: number | null }>;
  assertCurrent(snapshot: ProcedureReviewSnapshot): void;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
async function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw Error("GEPA_CANCELLED");
  let cancel!: () => void;
  const stopped = new Promise<never>((_, reject) => { cancel = () => reject(Error("GEPA_CANCELLED")); signal.addEventListener("abort", cancel, { once: true }); });
  try { return await Promise.race([work(), stopped]); }
  finally { signal.removeEventListener("abort", cancel); }
}
function safeFailure(error: unknown, fallback: string): Error {
  if (isGepaCallNotStarted(error)) return error as Error;
  return Error(error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message) ? error.message : fallback);
}
function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeJson); Object.freeze(value); }
  return value;
}
function corpusSnapshot(input: ProcedureCorpus): ProcedureCorpus {
  const corpus = JSON.parse(JSON.stringify(input, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value) || ["undefined", "function", "symbol", "bigint"].includes(typeof value)) throw Error("GEPA_CORPUS_INVALID");
    return value;
  })) as ProcedureCorpus;
  if (!corpus.id || !corpus.version || !corpus.groupBy?.length || new Set(corpus.groupBy).size !== corpus.groupBy.length || corpus.groupBy.some(axis => !["person", "project", "time"].includes(axis))) throw Error("GEPA_CORPUS_INVALID");
  const partitions = [corpus.train, corpus.validation, corpus.holdout];
  if (partitions.some(cases => !Array.isArray(cases) || !cases.length || cases.length > 8)) throw Error("GEPA_CORPUS_INVALID");
  const all = partitions.flat();
  if (all.some(item => !/^[A-Za-z0-9._:-]{1,200}$/.test(item.id)) || new Set(all.map(item => item.id)).size !== all.length) throw Error("GEPA_CORPUS_OVERLAP");
  for (const axis of corpus.groupBy) {
    const seen = new Set<string>();
    for (const partition of partitions) {
      const keys = new Set(partition.map(item => item.groups?.[axis]));
      if ([...keys].some(key => typeof key !== "string" || !key || seen.has(key))) throw Error("GEPA_CORPUS_GROUP_OVERLAP");
      keys.forEach(key => seen.add(key));
    }
  }
  if (Buffer.byteLength(JSON.stringify(corpus)) > 256 * 1024 || corpus.holdout.length * 2 + corpus.validation.length + 4 > 24) throw Error("GEPA_CORPUS_BUDGET");
  return freezeJson(corpus);
}

/** One actual optimizer cycle plus a separate, parent-only heldout comparison.
 * All external calls have durable request and cost reservations before dispatch. */
export async function evaluateProcedureWithGepa(snapshot: ProcedureReviewSnapshot, options: ProcedureEvaluatorOptions, signal: AbortSignal): Promise<ProcedureEvaluationReceipt> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  options.assertCurrent(snapshot);
  if (signal.aborted) throw Error("GEPA_CANCELLED");
  if (!/^[a-f0-9]{64}$/.test(options.workerDigest) || !options.evaluatorId || options.evaluatorId.length > 100) throw Error("GEPA_EVALUATOR_IDENTITY_INVALID");
  const corpus = corpusSnapshot(options.corpus);
  const budget = structuredClone(options.budget);
  if (!budget.authorityReference || [budget.totalUsd, budget.evaluationPerCaseUsd, budget.reflectionUsd].some(value => value !== null && (!Number.isFinite(value) || value < 0)) || budget.totalUsd !== null && (budget.evaluationPerCaseUsd === null || budget.reflectionUsd === null)) throw Error("GEPA_COST_AUTHORITY_REQUIRED");
  const identity = digest([procedureSnapshotDigest(snapshot), options.evaluatorId, options.workerDigest, corpus, budget, options.seedInstruction, options.command.expectedPythonVersion]);
  const jobId = `gepa:${identity}`, charges = `gepa-charges:${identity}`;
  const assertCurrent = () => { if (deadline.aborted) throw Error("GEPA_CANCELLED"); options.assertCurrent(snapshot); };
  const ledger = createGepaCallLedger({ scopeId: snapshot.target.scopeId, jobId, snapshotDigest: identity, evidence: snapshot.evidence.map(({ kind, id, revision }) => ({ kind, id, revision })), maxMetricCalls: 24, maxReflections: 2, assertCurrent });
  const reserveCost = (callId: string, ceiling: number | null) => transaction(db => {
    assertCurrent();
    const id = `gepa-charge:${digest([jobId, callId])}`;
    const prior = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id);
    if (prior && JSON.parse(String(prior.intent)).notStarted !== true) throw Error("GEPA_COST_OUTCOME_UNCERTAIN");
    const rows = db.prepare("SELECT intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id=?").all(charges);
    const reserved = rows.reduce((sum, row) => { const entry = JSON.parse(String(row.intent)); return sum + Number(entry.actualUsd ?? entry.ceilingUsd ?? Infinity); }, 0);
    if (!prior && rows.length >= 26 || budget.totalUsd !== null && reserved + (ceiling ?? Infinity) > budget.totalUsd + 1e-12) throw Error("GEPA_COST_LIMIT");
    db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,1,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(id, snapshot.target.scopeId, charges, JSON.stringify({ callId, ceilingUsd: ceiling, actualUsd: null, confirmed: false, authorityReference: budget.authorityReference }));
    return id;
  });
  const releaseUnstartedCost = (id: string, error: unknown) => {
    if (!isGepaCallNotStarted(error)) return;
    transaction(db => {
      const row = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_id=?").get(id, charges);
      if (!row) throw Error("GEPA_COST_RECEIPT_MISSING");
      const entry = JSON.parse(String(row.intent));
      db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify({ ...entry, actualUsd: 0, confirmed: true, notStarted: true }), id);
    });
  };
  const settleCost = (id: string, actualUsd: number | null) => {
    if (actualUsd === null ? budget.totalUsd !== null : !Number.isFinite(actualUsd) || actualUsd < 0) throw Error("GEPA_COST_UNAVAILABLE");
    const exceeded = transaction(db => {
      const row = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_id=?").get(id, charges);
      if (!row) throw Error("GEPA_COST_RECEIPT_MISSING");
      const entry = JSON.parse(String(row.intent));
      db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify({ ...entry, actualUsd, confirmed: true }), id);
      return actualUsd !== null && entry.ceilingUsd !== null && actualUsd > Number(entry.ceilingUsd) + 1e-12;
    });
    if (exceeded) throw Error("GEPA_COST_CEILING_EXCEEDED");
  };
  const evaluate = async (callId: string, instruction: string, cases: readonly ProcedureEvaluationCase[], callSignal: AbortSignal): Promise<GepaEvaluation> => {
    assertCurrent();
    const charge = reserveCost(callId, budget.evaluationPerCaseUsd === null ? null : cases.length * budget.evaluationPerCaseUsd);
    const result = await bounded(() => options.evaluate(instruction, cases, callSignal), callSignal).catch(error => { releaseUnstartedCost(charge, error); throw safeFailure(error, "GEPA_OBJECTIVE_CALL_FAILED"); });
    settleCost(charge, result.costUsd);
    assertCurrent();
    const evaluation = gepaEvaluationSchema.parse(result.evaluation);
    if (evaluation.outputs.length !== cases.length || evaluation.scores.length !== cases.length || result.hardPass.length !== cases.length || result.hardPass.some(value => typeof value !== "boolean") || evaluation.scores.some(score => score < 0 || score > 1)) throw Error("GEPA_OBJECTIVE_RESULT_INVALID");
    return { ...evaluation, scores: evaluation.scores.map((score, index) => result.hardPass[index] ? score : 0),
      outputs: evaluation.outputs.map((response, index) => ({ response, objective: { hardPass: result.hardPass[index], caseId: cases[index].id } })) };
  };
  const training = new Map([...corpus.train, ...corpus.validation].map(item => [item.id, item]));
  const job = { v: 1 as const, type: "start" as const, jobId, candidate: { instruction: options.seedInstruction }, trainIds: corpus.train.map(item => item.id), validationIds: corpus.validation.map(item => item.id), limits: { maxMetricCalls: 24 - corpus.holdout.length * 2, maxReflections: 2, wallMs: 30_000 }, randomSeed: 0 };
  const outcome = await runGepaWorker({ command: options.command, job, ledger, signal: deadline, handlers: {
    evaluate: async (frame, childSignal) => {
      const value = await evaluate(frame.callId, frame.candidate.instruction, frame.caseIds.map(id => { const item = training.get(id); if (!item) throw Error("GEPA_HOLDOUT_ACCESS_REFUSED"); return item; }), childSignal);
      return { ...value, trajectories: frame.captureTraces ? value.trajectories : null };
    },
    reflect: async (frame, childSignal) => {
      assertCurrent(); const charge = reserveCost(frame.callId, budget.reflectionUsd);
      const response = await bounded(() => options.reflect(frame.prompt, childSignal), childSignal).catch(error => { releaseUnstartedCost(charge, error); throw safeFailure(error, "GEPA_REFLECTION_CALL_FAILED"); });
      settleCost(charge, response.costUsd); assertCurrent(); return response.text;
    },
  } });
  const heldout = async (phase: string, instruction: string) => {
    assertCurrent();
    const callId = `${jobId}:evaluate:holdout-${phase}`, inputHash = digest([phase, instruction, corpus.holdout]);
    const prior = ledger.lookupOrReserve(callId, inputHash, "evaluate");
    if (prior.state === "complete") return gepaEvaluationSchema.parse(prior.value);
    try { const result = await evaluate(callId, instruction, corpus.holdout, deadline); ledger.complete(callId, inputHash, result); return result; }
    catch (error) { if (isGepaCallNotStarted(error)) ledger.releaseNotStarted(callId, inputHash); throw error; }
  };
  const baseline = await heldout("baseline", options.seedInstruction);
  const selected = outcome.result.bestCandidate.instruction;
  const candidate = selected === options.seedInstruction ? baseline : await heldout("candidate", selected);
  assertCurrent();
  const costRows = database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id=?").all(charges).map(row => JSON.parse(String(row.intent)));
  const costKnown = costRows.every(row => row.confirmed === true && Number.isFinite(row.actualUsd) && row.actualUsd >= 0);
  const actualCostUsd = costKnown ? costRows.reduce((sum, row) => sum + Number(row.actualUsd), 0) : null;
  if (costRows.some(row => row.confirmed !== true) || budget.totalUsd !== null && (actualCostUsd === null || actualCostUsd > budget.totalUsd + 1e-12)) throw Error("GEPA_COST_UNSETTLED");
  const hardPass = candidate.outputs.every(output => Boolean(output && typeof output === "object" && !Array.isArray(output) && output.objective && typeof output.objective === "object" && !Array.isArray(output.objective) && output.objective.hardPass === true));
  const regressions = candidate.scores.filter((score, index) => score + 1e-12 < baseline.scores[index]).length;
  const receipt: ProcedureEvaluationReceipt = { id: `gepa:${identity}`, requestId: snapshot.requestId, targetDigest: procedureTargetDigest(snapshot.target), snapshotDigest: procedureSnapshotDigest(snapshot), evidenceDigest: snapshot.evidenceDigest,
    candidate: selected, candidateHash: procedureCandidateHash(selected), evaluator: `${options.evaluatorId}:${options.workerDigest}`, corpusDigest: digest(corpus),
    decision: selected === options.seedInstruction ? "no-change" : hardPass && !regressions && mean(candidate.scores) > mean(baseline.scores) ? "accepted" : "rejected",
    heldout: { corpusDigest: digest([corpus.id, corpus.version, corpus.groupBy, corpus.holdout]), untouched: true, cases: corpus.holdout.length, baseline: mean(baseline.scores), candidate: mean(candidate.scores), regressions }, budgetRespected: true, cancelled: false,
    accounting: { costLimitUsd: budget.totalUsd, actualCostUsd, costKnown, authorityReference: budget.authorityReference, metricCalls: outcome.result.metricCalls + corpus.holdout.length * (selected === options.seedInstruction ? 1 : 2), reflectionCalls: outcome.result.reflectionCalls } };
  return validateProcedureEvaluationReceipt(snapshot, receipt);
}
