// B34 Q14 scripted procedure evaluator (Claude 4 lane test support).
//
// Loaded inside the isolated verification server by launch.instrumentationSource
// (scripts/control-murage.ts:320-324), never by the runner process. Importing
// this module has no side effect; installB34EvaluatorRuntime() does the work:
//
// 1. Registers the root-integrated verification hook
//    Symbol.for("murage.verification.procedure-evaluator") = {worker, evaluate}
//    (server/index.ts, read only when MURAGE_ALLOW_DEV_DESKTOP_SECRET=1 and not a
//    packaged desktop child). The worker never spawns and has a constant digest,
//    because the evaluation session identity includes it (procedure-evaluator.ts:98-99).
// 2. Starts a node:http OpenAI-compatible loopback endpoint on 127.0.0.1 and
//    registers it as the openai-compat instance "b34-evaluator" in the profile
//    config.json. The driver gives a loopback endpoint the placeholder key
//    "local" (server/drivers/openai-compat.ts:26,110): no credential, no Flux,
//    no provider, no network.
//
// evaluate() is a scripted controller, not GEPA. It calls the production
// evaluate/reflect callbacks it is given, so every callback goes through the
// actual lease.request, the shared extract-budget ledger and root's
// procedure-evaluation-charges row. The loopback answers are fixture decisions:
// evaluation applies b34ScriptedReport, reflection returns the frozen candidate
// for the requested plan. A skill review's first attempt is a held-out probe:
// the controller claims "accepted" for a measured, non-improving candidate so
// the product's held-out gate (procedure-review.ts:46) must refuse it.
//
// Ledgers in the profile directory (JSONL, codes and counts only, never bodies):
//   b34-evaluator-calls.jsonl    one line per loopback request
//   b34-evaluator-reviews.jsonl  one line per callback and per evaluate attempt
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvolutionRuntimeOptions } from "../evolution-runtime.ts";
import type { ProcedureEvaluatorOptions } from "../gepa-evaluator.ts";
import type { ProcedureEvaluationReceipt, ProcedureReviewSnapshot } from "../procedure-review.ts";

export const B34_EVALUATOR_INSTANCE_ID = "b34-evaluator";
export const B34_EVALUATOR_MODEL = "b34-scripted-evaluator";
export const B34_EVALUATOR_ROUTE = "/b34-eval/v1";
export const B34_EVALUATOR_CALLS = "b34-evaluator-calls.jsonl";
export const B34_EVALUATOR_REVIEWS = "b34-evaluator-reviews.jsonl";
export const B34_EVALUATOR_NAME = "b34-scripted-procedure-controller";

/** Opening words of the product's own system prompts. */
export const B34_EVALUATION_PREFIX = "Run the supplied procedure as a text-only simulation"; // gepa-procedure-corpus.ts:40
export const B34_REFLECTION_PREFIX = "Improve the supplied procedure against synthetic simulated outcomes"; // procedure-evaluator.ts:107
export const B34_EXTRACTION_PREFIX = "Extract only potentially durable factual assertions"; // extract.ts:20
export const B34_GROUNDING_PREFIX = "Independently judge whether the claim is entailed"; // extract.ts:15

const HOOK = Symbol.for("murage.verification.procedure-evaluator");
const MAX_REQUEST_BYTES = 262_144;
const MAX_RESPONSE_BYTES = 65_536;

/** Fixture text. Frontmatter and Preconditions stay byte-identical in every candidate (gepa-procedure-corpus.ts:38). */
export const B34_Q14 = Object.freeze({
  skillName: "b34-q14-outcome-report",
  seedStep: "Treat completed as verified.",
  learnedStep: "Verify receipts before reporting completion.",
  badStep: "Treat completed as verified. Report each completed task as verified.",
  skillOriginal: "---\nname: b34-q14-outcome-report\ndescription: Report simulated file task outcomes\n---\n## Preconditions\nOnly simulated-file-check-v1.\n\n## Steps\nTreat completed as verified.\n",
  /** Already trimmed: routine prompts are trimmed on write (routines.ts:523). */
  routineBase: "## Preconditions\nOnly simulated-file-check-v1.\n\n## Steps\nTreat completed as verified.",
  authoringTurn: "Q14 learned skill authoring turn",
  earlierSkillTurn: "Q14 earlier skill task report",
  nextSkillTurn: "Q14 next skill task report",
  postRollbackSkillTurn: "Q14 post rollback skill task report",
  routineName: "Q14 outcome routine",
  gist: "B34 Q14 learned outcome report",
});

export type B34Plan = "heldout-probe" | "improve";
export type B34Purpose = "evaluation" | "reflection";
export type B34Phase = "reflect-probe" | "baseline" | "candidate-probe" | "reflect" | "candidate";
export type B34CallFamily = "install" | "models" | "evaluation" | "reflection" | "unexpected-extract" | "unexpected-ground" | "refused";
export interface B34CallEntry {
  at: number; pid: number; family: B34CallFamily;
  inputBytes?: number; maxTokens?: number; plan?: B34Plan; procedureSha256?: string; reason?: string;
}
export interface B34ReviewEntry {
  at: number; pid: number;
  event: "callback" | "callback-failed" | "attempt";
  requestId: string; targetKind: string; attempt: number;
  purpose?: B34Purpose; phase?: B34Phase; loopbackHit?: boolean; score?: number; hardPass?: boolean;
  plan?: B34Plan; outcome?: "guard" | "returned" | "threw"; errorCode?: string;
  decision?: ProcedureEvaluationReceipt["decision"]; metricCalls?: number; reflectionCalls?: number;
}

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Replaces exactly one seed step with the plan's frozen step. */
export function b34ScriptedCandidate(plan: B34Plan, instruction: string): string {
  const at = instruction.indexOf(B34_Q14.seedStep);
  if (at < 0 || instruction.indexOf(B34_Q14.seedStep, at + 1) >= 0) throw new Error("B34_SEED_STEP_UNAVAILABLE");
  const step = plan === "heldout-probe" ? B34_Q14.badStep : B34_Q14.learnedStep;
  return `${instruction.slice(0, at)}${step}${instruction.slice(at + B34_Q14.seedStep.length)}`;
}
export const b34ReflectionPrompt = (plan: B34Plan, instruction: string) => JSON.stringify({ b34Plan: plan, instruction });
/** The complete instruction inside one outer triple-backtick envelope (procedure-evaluator.ts:107). */
export function b34ParseReflection(text: string): string {
  const match = /^```\n([\s\S]*)\n```$/.exec(text);
  if (!match) throw new Error("B34_REFLECTION_ENVELOPE_INVALID");
  return match[1]!;
}
/** Port of the accepted fixture model (procedure-evaluator.test.ts:42-43): only a procedure that
 * carries the learned step separates verified from unconfirmed completions. */
export function b34ScriptedReport(procedure: string, task: unknown): { results: Array<{ id: string; status: "verified" | "unconfirmed" | "failed"; evidenceIds: string[] }>; actions: string[] } {
  const observations = task && typeof task === "object" ? (task as { observations?: unknown }).observations : undefined;
  if (!Array.isArray(observations)) throw new Error("B34_TASK_INVALID");
  const learned = procedure.includes(B34_Q14.learnedStep);
  return {
    results: observations.map(value => {
      const item = (value && typeof value === "object" ? value : {}) as { id?: unknown; reported?: unknown; verified?: unknown; evidenceId?: unknown };
      const status = item.reported === "failed" ? "failed" as const : learned ? (item.verified === true ? "verified" as const : "unconfirmed" as const) : "verified" as const;
      return { id: String(item.id), status, evidenceIds: typeof item.evidenceId === "string" && item.evidenceId ? [item.evidenceId] : [] };
    }),
    actions: [],
  };
}

function readJsonLines<T>(path: string): T[] {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return []; }
  const entries: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try { entries.push(JSON.parse(line) as T); } catch { /* partial trailing line */ }
  }
  return entries;
}
/** Complete loopback ledger lines only. */
export const readB34EvaluatorCalls = (dataDir: string) => readJsonLines<B34CallEntry>(join(dataDir, B34_EVALUATOR_CALLS));
/** Complete controller ledger lines only. */
export const readB34EvaluatorReviews = (dataDir: string) => readJsonLines<B34ReviewEntry>(join(dataDir, B34_EVALUATOR_REVIEWS));

type VerificationProcedureEvaluator = { worker: EvolutionRuntimeOptions["worker"]; evaluate: NonNullable<EvolutionRuntimeOptions["evaluate"]> };
/** Loopback answers observed by this process, by purpose; a callback's delta proves it reached the loopback exactly once. */
const hits: Record<B34Purpose, number> = { evaluation: 0, reflection: 0 };

let installed: Promise<{ port: number }> | undefined;
/** Preload entry: refuses to run outside an isolated verification profile. */
export function installB34EvaluatorRuntime(): Promise<{ port: number }> {
  installed ??= install();
  return installed;
}

async function install(): Promise<{ port: number }> {
  const dataDir = process.env.MURAGE_DATA_DIR;
  // control-murage.ts:272 names the profile, :310 sets the dev flag and :320-321 writes the preload file; index.ts reads the hook only outside a desktop child.
  if (!dataDir || !basename(dataDir).startsWith("murage-verify-data-") || !existsSync(join(dataDir, ".verification-instrumentation.mjs"))
    || process.env.MURAGE_ALLOW_DEV_DESKTOP_SECRET !== "1" || process.env.MURAGE_DESKTOP_PARENT === "1")
    throw new Error("B34 scripted evaluator runs only inside an isolated verification profile");
  const workerPath = fileURLToPath(import.meta.url);
  const workerDigest = sha256(readFileSync(workerPath));
  const hook: VerificationProcedureEvaluator = {
    worker: () => ({ available: true, command: { executable: workerPath, args: [], cwd: dataDir, expectedPythonVersion: "3.13.15" }, workerDigest }),
    evaluate: (snapshot, options, signal) => b34ScriptedEvaluate(dataDir, snapshot, options, signal),
  };
  // Registered before the first await so server/index.ts sees it when its module body runs.
  (globalThis as Record<symbol, unknown>)[HOOK] = hook;

  const calls = join(dataDir, B34_EVALUATOR_CALLS);
  const record = (entry: Omit<B34CallEntry, "at" | "pid">) => appendFileSync(calls, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`, { mode: 0o600 });
  const server = createServer((request, response) => {
    handle(request, response, record).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  server.unref();
  const { port } = server.address() as AddressInfo;
  const file = join(dataDir, "config.json");
  const config = JSON.parse(readFileSync(file, "utf8")) as { instances?: Record<string, unknown> };
  config.instances = { ...config.instances, [B34_EVALUATOR_INSTANCE_ID]: {
    driver: "openai-compat", displayName: "B34 scripted procedure evaluator",
    config: { url: `http://127.0.0.1:${port}${B34_EVALUATOR_ROUTE}`, model: B34_EVALUATOR_MODEL },
  } };
  const temporary = `${file}.b34-eval-${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
  record({ family: "install" });
  return { port };
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let bytes = 0, over = false;
    request.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > MAX_REQUEST_BYTES) over = true; else parts.push(chunk); });
    request.on("end", () => resolve(over ? null : Buffer.concat(parts).toString("utf8")));
    request.on("error", reject);
  });
}
function reply(response: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
  response.end(text);
}
/** Exactly one choice, stop, no tool calls, under the transport cap (extract.ts:44-51). */
function completion(response: ServerResponse, content: string) {
  const body = { id: `b34-eval-${Date.now()}`, object: "chat.completion", model: B34_EVALUATOR_MODEL,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] };
  if (Buffer.byteLength(JSON.stringify(body)) >= MAX_RESPONSE_BYTES) return reply(response, 500, { error: "response-limit" });
  return reply(response, 200, body);
}

async function handle(request: IncomingMessage, response: ServerResponse, record: (entry: Omit<B34CallEntry, "at" | "pid">) => void) {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const refuse = (status: number, reason: string) => { record({ family: "refused", reason }); reply(response, status, { error: reason }); };
  if (request.method === "GET" && path === `${B34_EVALUATOR_ROUTE}/models`) {
    request.resume();
    record({ family: "models" });
    return reply(response, 200, { object: "list", data: [{ id: B34_EVALUATOR_MODEL, object: "model" }] });
  }
  if (request.method !== "POST" || path !== `${B34_EVALUATOR_ROUTE}/chat/completions`) { request.resume(); return refuse(404, "route"); }
  const raw = await readBody(request);
  if (raw === null) return refuse(413, "body-limit");
  if (request.headers.authorization !== "Bearer local") return refuse(401, "not-loopback-placeholder");
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { return refuse(400, "invalid-json"); }
  const messages = body.messages;
  if (body.model !== B34_EVALUATOR_MODEL || body.stream !== false || body.tools !== undefined || !Array.isArray(messages) || messages.length !== 2
    || messages[0]?.role !== "system" || typeof messages[0]?.content !== "string" || messages[1]?.role !== "user" || typeof messages[1]?.content !== "string"
    || !Number.isSafeInteger(body.max_tokens)) return refuse(400, "request-shape");
  const system = String(messages[0].content), user = String(messages[1].content), maxTokens = Number(body.max_tokens);
  const inputBytes = Buffer.byteLength(JSON.stringify(messages));
  if (system.startsWith(B34_EVALUATION_PREFIX)) {
    if (maxTokens < 1 || maxTokens > 2000) return refuse(400, "evaluation-output-cap");
    let input: { procedure?: unknown; task?: unknown };
    try { input = JSON.parse(user) as typeof input; } catch { return refuse(400, "evaluation-input"); }
    if (typeof input.procedure !== "string" || !input.task || typeof input.task !== "object") return refuse(400, "evaluation-input");
    let report: ReturnType<typeof b34ScriptedReport>;
    try { report = b34ScriptedReport(input.procedure, input.task); } catch { return refuse(400, "evaluation-task"); }
    hits.evaluation++;
    record({ family: "evaluation", inputBytes, maxTokens, procedureSha256: sha256(input.procedure) });
    return completion(response, JSON.stringify(report));
  }
  if (system.startsWith(B34_REFLECTION_PREFIX)) {
    if (maxTokens < 1 || maxTokens > 8000) return refuse(400, "reflection-output-cap");
    let input: { b34Plan?: unknown; instruction?: unknown };
    try { input = JSON.parse(user) as typeof input; } catch { return refuse(400, "reflection-input"); }
    if ((input.b34Plan !== "heldout-probe" && input.b34Plan !== "improve") || typeof input.instruction !== "string") return refuse(400, "reflection-input");
    let candidate: string;
    try { candidate = b34ScriptedCandidate(input.b34Plan, input.instruction); } catch { return refuse(400, "reflection-seed"); }
    hits.reflection++;
    record({ family: "reflection", inputBytes, maxTokens, plan: input.b34Plan, procedureSha256: sha256(input.instruction) });
    return completion(response, `\`\`\`\n${candidate}\n\`\`\``);
  }
  if (system.startsWith(B34_EXTRACTION_PREFIX)) {
    record({ family: "unexpected-extract", inputBytes, maxTokens });
    return completion(response, "[]");
  }
  if (system.startsWith(B34_GROUNDING_PREFIX)) {
    record({ family: "unexpected-ground", inputBytes, maxTokens });
    return completion(response, JSON.stringify({ supported: false }));
  }
  return refuse(400, "prompt-family");
}

type Measured = Awaited<ReturnType<ProcedureEvaluatorOptions["evaluate"]>>;
/** Gated held-out score: a hard failure scores 0 (gepa-evaluator.ts:128). */
const gated = (result: Measured) => result.hardPass[0] === true ? Number(result.evaluation.scores[0] ?? 0) : 0;
const errorCode = (error: unknown, notStarted: boolean) => notStarted ? "GEPA_CALL_NOT_STARTED"
  : error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "B34_EVALUATE_FAILED";

/** The scripted controller (same shape as procedure-evaluator.test.ts:45-50). In the server every callback it makes is a production
 * callback through lease.request. loopbackHits is the loopback answer counter; the pure test supplies its own. */
export async function b34ScriptedEvaluate(dataDir: string, snapshot: ProcedureReviewSnapshot, options: ProcedureEvaluatorOptions, signal: AbortSignal,
  loopbackHits: () => Readonly<Record<B34Purpose, number>> = () => hits): Promise<ProcedureEvaluationReceipt> {
  // Lazy imports resolve to the server's own module instances: the not-started marker is a module-local WeakSet (gepa-worker.ts:13-18).
  const { gepaCallNotStarted, isGepaCallNotStarted } = await import("../../gepa-worker.ts");
  const { procedureCandidateHash, procedureSnapshotDigest, procedureTargetDigest, validateProcedureEvaluationReceipt } = await import("../procedure-review.ts");
  options.assertCurrent(snapshot);
  const requestId = snapshot.requestId, kind = snapshot.target.kind;
  const ledgerPath = join(dataDir, B34_EVALUATOR_REVIEWS);
  const lines = readB34EvaluatorReviews(dataDir), mine = lines.filter(line => line.requestId === requestId);
  const started = (line: B34ReviewEntry) => line.event !== "attempt" || line.outcome !== "guard";
  const attempt = 1 + mine.filter(line => line.event === "attempt" && line.outcome !== "guard").length;
  const append = (entry: Omit<B34ReviewEntry, "at" | "pid" | "requestId" | "targetKind" | "attempt">) =>
    appendFileSync(ledgerPath, `${JSON.stringify({ at: Date.now(), pid: process.pid, requestId, targetKind: kind, attempt, ...entry })}\n`, { mode: 0o600 });

  // Defense in depth before any callback: one skill and one routine review, each published at most once.
  if ((kind !== "skill" && kind !== "routine")
    || lines.some(line => line.requestId !== requestId && line.targetKind === kind && started(line))
    || mine.some(line => line.event === "attempt" && line.outcome === "returned" && line.plan === "improve")) {
    append({ event: "attempt", outcome: "guard" });
    throw gepaCallNotStarted();
  }
  const plan: B34Plan = kind === "skill" && !mine.some(line => line.event === "attempt" && line.outcome === "returned" && line.plan === "heldout-probe") ? "heldout-probe" : "improve";
  const seed = options.seedInstruction, holdout = options.corpus.holdout;

  /** Strictly sequential. A lease refusal is a certain not-started outcome and is rethrown unrecorded;
   * any other failure keeps its charge (extract.ts:145), so it is recorded and counted. */
  const call = async <T>(purpose: B34Purpose, phase: B34Phase, run: () => Promise<T>, summarize?: (value: T) => { score: number; hardPass: boolean }): Promise<T> => {
    const before = loopbackHits()[purpose];
    let value: T;
    try { value = await run(); } catch (error) {
      if (!isGepaCallNotStarted(error)) append({ event: "callback-failed", purpose, phase });
      throw error;
    }
    append({ event: "callback", purpose, phase, loopbackHit: loopbackHits()[purpose] - before === 1, ...(summarize ? summarize(value) : {}) });
    return value;
  };
  const measure = (result: Measured) => ({ score: gated(result), hardPass: result.hardPass[0] === true });
  const evaluateHoldout = async (phase: B34Phase, instruction: string) => measure(await call("evaluation", phase, () => options.evaluate(instruction, holdout, signal), measure));
  const counted = () => readB34EvaluatorReviews(dataDir).filter(line => line.requestId === requestId && (line.event === "callback" || line.event === "callback-failed"));

  let outcome: "returned" | "threw" = "threw", decision: ProcedureEvaluationReceipt["decision"] | undefined, code: string | undefined;
  try {
    let candidate: string, base: { score: number; hardPass: boolean }, next: { score: number; hardPass: boolean };
    if (plan === "heldout-probe") {
      candidate = b34ParseReflection((await call("reflection", "reflect-probe", () => options.reflect(b34ReflectionPrompt(plan, seed), signal))).text);
      base = await evaluateHoldout("baseline", seed);
      next = await evaluateHoldout("candidate-probe", candidate);
    } else {
      const parsed = b34ParseReflection((await call("reflection", "reflect", () => options.reflect(b34ReflectionPrompt(plan, seed), signal))).text);
      // A routine prompt is trimmed on publication (routines.ts:894); skill bytes are published exactly (skills.ts:1896).
      candidate = kind === "routine" ? parsed.trim() : parsed;
      // The held-out baseline measured by an earlier attempt of this same review is reused, as GEPA reuses completed held-out calls (gepa-evaluator.ts:144-151).
      const cached = mine.filter(line => line.event === "callback" && line.phase === "baseline" && line.loopbackHit === true && typeof line.score === "number" && typeof line.hardPass === "boolean").at(-1);
      base = cached ? { score: cached.score!, hardPass: cached.hardPass! } : await evaluateHoldout("baseline", seed);
      next = await evaluateHoldout("candidate", candidate);
    }
    const regressions = next.score < base.score ? 1 : 0;
    const charged = counted();
    const metricCalls = charged.filter(line => line.purpose === "evaluation").length, reflectionCalls = charged.filter(line => line.purpose === "reflection").length;
    const allHit = charged.length > 0 && charged.every(line => line.event === "callback" && line.loopbackHit === true);
    decision = plan === "heldout-probe" ? "accepted"
      : candidate === seed ? "no-change" : next.hardPass && regressions === 0 && next.score > base.score ? "accepted" : "rejected";
    const corpus = options.corpus, digest = sha256(JSON.stringify(requestId));
    const receipt: ProcedureEvaluationReceipt = {
      id: `${plan === "heldout-probe" ? "b34-scripted-probe" : "b34-scripted"}:${digest}`,
      requestId, snapshotDigest: procedureSnapshotDigest(snapshot), targetDigest: procedureTargetDigest(snapshot.target), evidenceDigest: snapshot.evidenceDigest,
      corpusDigest: procedureCandidateHash(JSON.stringify(corpus)),
      candidate, candidateHash: procedureCandidateHash(candidate),
      evaluator: `${B34_EVALUATOR_NAME}:${options.workerDigest}`,
      decision,
      heldout: { corpusDigest: sha256(JSON.stringify([corpus.id, corpus.version, corpus.groupBy, corpus.holdout])), untouched: true, cases: corpus.holdout.length, baseline: base.score, candidate: next.score, regressions },
      budgetRespected: true, cancelled: false,
      // Known zero only because every counted callback was answered by this loopback; otherwise unknown.
      accounting: { costLimitUsd: options.budget.totalUsd, actualCostUsd: allHit ? 0 : null, costKnown: allHit, authorityReference: options.budget.authorityReference, metricCalls, reflectionCalls },
    };
    // The probe is a deliberate scripted acceptance claim on a non-improving candidate; the product validates and refuses it.
    const result = plan === "heldout-probe" ? receipt : validateProcedureEvaluationReceipt(snapshot, receipt);
    outcome = "returned";
    return result;
  } catch (error) {
    code = errorCode(error, isGepaCallNotStarted(error));
    throw error;
  } finally {
    const charged = counted();
    append({ event: "attempt", plan, outcome, ...(code === undefined ? {} : { errorCode: code }), ...(outcome === "returned" && decision ? { decision } : {}),
      metricCalls: charged.filter(line => line.purpose === "evaluation").length, reflectionCalls: charged.filter(line => line.purpose === "reflection").length });
  }
}
