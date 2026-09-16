// B34 executable receipt matrix. The sixteen rows are the frozen pre-run
// traceability map in BUILD-PLAN B34; this runner connects each row to the
// executable drivers that exist today and writes one receipt per row and tier.
// Only two tiers execute, both with scripted providers and no network:
//   deterministic    existing Vitest fixtures named by the map
//   isolated-server  real server/index.ts in a temporary profile through
//                    scripts/control-murage.ts, fake Claude CLI (plus the fake
//                    Codex app-server for the cross-engine row)
// named-model, native-engine, packaged-install and actual-optimizer tiers refuse:
// they need a root authority manifest naming models, budgets and windows.
// Q03, Q06, Q13 and Q14 join fixture adapters (server/memory/testing/b34-*.ts)
// through the private B34 adapter contract: a missing module or export is a
// BLOCKED receipt naming it; a present adapter drives the same isolated server
// through a narrowed context and the runner validates its returned artifacts
// against the live profile. Q14 artifacts carry one skill and one routine variant,
// each with product readbacks (a GET route plus JSON pointer, or one single-table
// SELECT); the runner re-reads each one itself after the adapter returns and
// compares it with the observed value and the matching artifact field. The budget
// fact is read by the runner's own fixed extract-budget ledger query, and the
// runner snapshots the lease ledger, evaluation sessions and per-session charges
// itself before and after the adapter runs. Setup HTTP steps stop a scenario at once with a
// "METHOD path HTTP status" check detail; bodies, headers and secrets are never
// recorded. --list also reports the frozen 60 original answer cases and each
// additional cohort as separate sets; nothing here generates or scores answers.
// Usage (receipts go to an absolute directory outside the repository):
//   node --experimental-strip-types scripts/b34-receipt-matrix.ts --list
//   node --experimental-strip-types scripts/b34-receipt-matrix.ts --rows Q01,Q08 --tier isolated-server --out /abs/dir
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { personalityImprint } from "../shared/bot-identity.ts";
import { MEMORY_REFERENCE_CLOSE, MEMORY_REFERENCE_OPEN, MEMORY_REFERENCE_PREAMBLE } from "../shared/memory.ts";
import { validateAnswerCohorts, validateCorpus } from "../server/memory/testing/contracts.ts";
import type { VerificationServer } from "./control-murage.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLAUDE = join(ROOT, "server", "testing", "fake-claude-cli.ts");
const FAKE_CODEX = join(ROOT, "server", "testing", "fake-codex-app-server.ts");

export const TIERS = ["deterministic", "isolated-server", "named-model", "native-engine", "packaged-install", "actual-optimizer"] as const;
export type Tier = typeof TIERS[number];
export const EXECUTABLE_TIERS: readonly Tier[] = ["deterministic", "isolated-server"];
export const TIER_LABEL: Record<Tier, string> = {
  deterministic: "deterministic: existing Vitest fixtures with injected or scripted providers; not named-model, native-engine or packaged evidence",
  "isolated-server": "isolated-server: real server in a temporary profile with scripted fake engine CLIs; not named-model, native-engine or packaged evidence",
  "named-model": "named-model: actual provider model identities under a root authority manifest",
  "native-engine": "native-engine: actual engine binaries and sessions under a root authority manifest",
  "packaged-install": "packaged-install: packaged candidate installation, migration, backup and restore",
  "actual-optimizer": "actual-optimizer: pinned GEPA worker; scripted and real-model reflection labelled separately",
};

type Scenario = "blank-personality" | "owner-identity" | "supersession" | "turn-outcomes" | "interrupt-restart" | "model-switch"
  | "engine-switch" | "room-membership" | "concurrent-correction" | "forget" | "memory-mode";
export type AdapterRow = "Q03" | "Q06" | "Q13" | "Q14";
/** A join row names the exact adapter module and export the runner loads when that file exists. */
export interface AdapterSpec { row: AdapterRow; module: string; export: string }
export interface MatrixRow {
  id: string; scenario: string; required: Tier[]; deterministic: string[];
  server: { scenario: Scenario; covers: string; uncovered: string } | { adapter: AdapterSpec; covers: string; uncovered: string } | { blocked: string };
}
const M = "server/memory/";
export const MATRIX: readonly MatrixRow[] = [
  { id: "Q01", scenario: "Blank personality; fresh task", required: ["isolated-server", "named-model"], deterministic: [`${M}identity.test.ts`],
    server: { scenario: "blank-personality", covers: "dispatched system imprint default and no identity memory", uncovered: "visible reply quality from a named model" } },
  { id: "Q02", scenario: "Set imprint, invited canon and partly revealed story", required: ["isolated-server", "named-model"], deterministic: [`${M}identity.test.ts`, `${M}reveal-capture.test.ts`],
    server: { scenario: "owner-identity", covers: "owner-authored imprint, continuity and reveal delivery with canon withheld", uncovered: "automatic reveal capture from a model reply" } },
  { id: "Q03", scenario: "Explicit owner correction reused in another task", required: ["isolated-server", "named-model"], deterministic: [`${M}automatic-learning.test.ts`, `${M}procedure-evaluator.test.ts`],
    server: { adapter: { row: "Q03", module: `${M}testing/b34-extractor-adapter.ts`, export: "b34Q03Adapter" },
      covers: "deterministic extractor capture, distillation and recall with source provenance; failed, cancelled or interrupted outcomes never become current facts; the owner correction supersedes with history and is reused in another task",
      uncovered: "extraction, grounding and answer quality from a named model" } },
  { id: "Q04", scenario: "Old fact superseded by current fact", required: ["isolated-server", "named-model"], deterministic: [`${M}fresh-recall.test.ts`, `${M}experience.test.ts`],
    server: { scenario: "supersession", covers: "owner correction supersedes a pinned fact before dispatch", uncovered: "historical chronology answer from a named model" } },
  { id: "Q05", scenario: "Completed, failed and uncertain actions", required: ["isolated-server", "named-model"], deterministic: [`${M}experience.test.ts`],
    server: { scenario: "turn-outcomes", covers: "completed and failed turn outcomes captured distinctly", uncovered: "tool-level uncertain outcome (launcher cannot select a fake tool failure mode)" } },
  { id: "Q06", scenario: "Old episodic evidence with unrelated recent context", required: ["isolated-server", "named-model"], deterministic: [`${M}relevance.test.ts`, `${M}fresh-recall.test.ts`, `${M}p00.test.ts`],
    server: { adapter: { row: "Q06", module: `${M}testing/b34-index-readiness-adapter.ts`, export: "b34Q06Adapter" },
      covers: "actual capture job and index readiness before recall; the intended old source is processed and supplied to a later task past unrelated recent context; bot and room isolation preserved",
      uncovered: "semantic paraphrase retrieval through a named embedding or model route; person (human principal) isolation: human bindings exist only through channel services" } },
  { id: "Q07", scenario: "Interrupt active task; restart same installation", required: ["isolated-server", "native-engine"], deterministic: [`${M}consolidate-resume.test.ts`, `${M}stale-lease-requeue.test.ts`, `${M}gepa-ledger.test.ts`],
    server: { scenario: "interrupt-restart", covers: "held turn interrupted, server restarted on the same profile, identity kept and no completed claim", uncovered: "native engine process and spend accounting" } },
  { id: "Q08", scenario: "Switch actual model within one engine", required: ["named-model"], deterministic: ["server/harness/memory-adapter.test.ts"],
    server: { scenario: "model-switch", covers: "same imprint and pinned knowledge across two declared fake model selections", uncovered: "two actual model identities" } },
  { id: "Q09", scenario: "Switch actual engine", required: ["native-engine"], deterministic: ["server/memory-submission-boundary-api.test.ts", "server/harness/memory-adapter.test.ts"],
    server: { scenario: "engine-switch", covers: "Claude-protocol fake to Codex-protocol fake with the same imprint and memory frame", uncovered: "actual cross-engine binaries and sessions" } },
  { id: "Q10", scenario: "Private and shared team knowledge; add/remove member", required: ["isolated-server", "named-model"], deterministic: [`${M}search-authorization.test.ts`, `${M}dispatch.test.ts`],
    server: { scenario: "room-membership", covers: "room/private pins across member addition and removal", uncovered: "named-model answers about room versus private knowledge" } },
  { id: "Q11", scenario: "Concurrent corrections and writes", required: ["deterministic", "isolated-server"], deterministic: [`${M}automatic-learning.test.ts`, `${M}consolidate-resume.test.ts`],
    server: { scenario: "concurrent-correction", covers: "two simultaneous owner corrections against one version", uncovered: "concurrent automatic learning writes" } },
  { id: "Q12", scenario: "Forget supporting evidence, then restore old backup", required: ["isolated-server", "packaged-install"], deterministic: [`${M}evolution-forgetting.test.ts`, `${M}schema-v2.test.ts`],
    server: { scenario: "forget", covers: "owner forget removes a delivered pin from the next dispatch", uncovered: "encrypted installed restore of an older backup" } },
  { id: "Q13", scenario: "Missing/stale semantic index or exhausted processing budget", required: ["isolated-server", "named-model"], deterministic: [`${M}index-upsert.test.ts`, `${M}health.test.ts`, `${M}inference-lease.test.ts`],
    server: { adapter: { row: "Q13", module: `${M}testing/b34-extractor-adapter.ts`, export: "b34Q13Adapter" },
      covers: "exhausted processing budget defers learning and withholds the fact, then the same source distils once with provenance when budget returns",
      uncovered: "missing or stale semantic index under a named model route (index-unavailable state stays deterministic-fixture evidence)" } },
  { id: "Q14", scenario: "Learned skill/routine; next task and rollback", required: ["isolated-server", "named-model"], deterministic: [`${M}procedure-evaluator.test.ts`, "server/procedure-review-host.test.ts"],
    server: { adapter: { row: "Q14", module: `${M}testing/b34-evaluator-adapter.ts`, export: "b34Q14Adapter" },
      covers: "admitted procedure evaluator runtime for one learned skill and one learned routine: held-out evaluation, publication to the next task, earlier task version immutability, rollback, evaluation and reflection callbacks charged through the inference lease with no double charge after a budget refusal, and a known zero-cost budget",
      uncovered: "named-model reflection and actual GEPA optimisation (Q15 actual-optimizer tier)" } },
  { id: "Q15", scenario: "Actual GEPA bad/better proposals and holdout", required: ["actual-optimizer"], deterministic: [`${M}gepa-evaluator.test.ts`],
    server: { blocked: "Optimizer evidence belongs to the actual-optimizer tier; the GEPA worker is not an isolated-server path." } },
  { id: "Q16", scenario: "Migrate installation with explicit off/paused settings", required: ["isolated-server", "packaged-install"], deterministic: [`${M}schema-v2.test.ts`, `${M}notebook-continuity.test.ts`, `${M}native-platform.test.ts`],
    server: { scenario: "memory-mode", covers: "paused and off modes suppress memory delivery; off stops capture", uncovered: "packaged migration preserving an existing opt-out" } },
];

export function assertExecutableTier(tier: string): asserts tier is Tier {
  if (!(TIERS as readonly string[]).includes(tier)) throw new Error(`Unknown tier ${tier}`);
  if (!EXECUTABLE_TIERS.includes(tier as Tier)) throw new Error(`GATED: ${tier} requires a root authority manifest (models, budgets, windows); this runner never dispatches it`);
}

export interface CoverageRow {
  row: string; scenario: string; required: Tier[]; deterministicFixtures: string[];
  isolatedServer: { status: "BLOCKED" | "CONNECTED" | "ADAPTER_PRESENT"; reason?: string; scenario?: string; adapter?: { module: string; export: string }; covers?: string; uncovered?: string };
  gatedTiers: Tier[]; status: "NOT_RUN";
}
const adapterMissing = (spec: AdapterSpec) => `Adapter not published: ${spec.module} must export ${spec.export} per the B34 adapter contract; no behavioural attempt made.`;
export function matrixCoverage(root = ROOT): CoverageRow[] {
  return MATRIX.map(row => ({
    row: row.id, scenario: row.scenario, required: row.required, deterministicFixtures: row.deterministic,
    isolatedServer: "blocked" in row.server ? { status: "BLOCKED" as const, reason: row.server.blocked }
      : "adapter" in row.server ? { ...(existsSync(join(root, row.server.adapter.module)) ? { status: "ADAPTER_PRESENT" as const } : { status: "BLOCKED" as const, reason: adapterMissing(row.server.adapter) }),
        adapter: { module: row.server.adapter.module, export: row.server.adapter.export }, covers: row.server.covers, uncovered: row.server.uncovered }
      : { status: "CONNECTED" as const, scenario: row.server.scenario, covers: row.server.covers, uncovered: row.server.uncovered },
    gatedTiers: row.required.filter(tier => !EXECUTABLE_TIERS.includes(tier)), status: "NOT_RUN" as const,
  }));
}

export const FROZEN_CORPUS_SHA256 = "7dc0a4d0690c002b62602518846b2768ed877e02505d93769f46dfc4e1fe236f";
/** The frozen 60 original answer cases and every additional cohort stay separate sets; nothing is merged, generated or scored. */
export function answerCaseSets(root = ROOT) {
  const corpusPath = "server/memory/testing/corpus.json", cohortPath = "server/memory/testing/answer-cohorts.json";
  const bytes = readFileSync(join(root, corpusPath)), corpusSha256 = sha256(bytes);
  if (corpusSha256 !== FROZEN_CORPUS_SHA256) throw new Error("Answer corpus bytes differ from the frozen corpus");
  const corpus = validateCorpus(JSON.parse(bytes.toString("utf8")));
  const cohorts = validateAnswerCohorts(corpus, corpusSha256, JSON.parse(readFileSync(join(root, cohortPath), "utf8")));
  const drivers: Record<string, number> = {};
  for (const item of corpus.answerCases) drivers[item.driver] = (drivers[item.driver] ?? 0) + 1;
  return {
    original: { path: corpusPath, sha256: corpusSha256, cases: corpus.answerCases.length, drivers },
    additional: cohorts.cohorts.map(cohort => ({ path: cohortPath, id: cohort.id, driver: cohort.driver, cases: cohort.cases.length, status: "PENDING_BOUNDED_NATIVE_EXECUTION" as const })),
  };
}

// Adapter artifacts: identifiers and synthetic canaries only, never bodies, test
// reports or secrets. Strict objects refuse any extra field (such as copied test results).
const identifier = z.string().min(1).max(200), revisionId = z.string().min(1).max(200);
const recordRef = z.object({ id: identifier, version: z.number().int().positive() }).strict();
const distilledRecord = z.object({ record: recordRef, sourceIds: z.array(identifier).min(1) }).strict();
const marked = z.object({ match: z.string().min(8).max(200), canary: z.string().min(6).max(120) }).strict();
// Q14 readback (contract v2): each entry names one product fact, how to read it
// and the value the adapter observed. The runner re-reads every entry itself.
export const Q14_READBACK_FACTS = ["current-revision", "published-revision-in-history", "earlier-task-pin", "next-task-pin", "post-rollback-task-pin", "rollback-history-entry", "budget-lease-charge"] as const;
export type Q14ReadbackFact = typeof Q14_READBACK_FACTS[number];
const readbackValue = z.string().min(1).max(400);
const apiReadback = z.object({ fact: z.enum(Q14_READBACK_FACTS), via: z.literal("api"), method: z.literal("GET"),
  path: z.string().max(400).refine(path => apiPathRefusal(path) === null, "API readback path refused"),
  pointer: z.string().max(400).refine(pointer => jsonPointerRefusal(pointer) === null, "API readback pointer refused"), observed: readbackValue }).strict();
const sqliteReadback = z.object({ fact: z.enum(Q14_READBACK_FACTS), via: z.literal("sqlite"),
  sql: z.string().max(1000).refine(sql => selectRefusal(sql) === null, "SQL readback refused"),
  params: z.array(z.union([z.string().max(400), z.number().int()])).max(8), column: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), observed: readbackValue }).strict();
export const Q14_READBACK = z.union([apiReadback, sqliteReadback]);
export type Q14Readback = z.infer<typeof Q14_READBACK>;

/** A GET route under /api/ only; never the desktop handshake or another credential route. */
export function apiPathRefusal(path: string): string | null {
  if (!path.startsWith("/api/")) return "path must start with /api/";
  if (/[\s#\\]|\.\.|\/\//.test(path)) return "path must be a plain route";
  if (/secret|token|credential|password|api-?key/i.test(path)) return "path may not address a credential route";
  return null;
}
export function jsonPointerRefusal(pointer: string): string | null {
  return /^(?:\/(?:[^~/]|~[01])*)+$/.test(pointer) ? null : "pointer must be an RFC 6901 JSON pointer with at least one token";
}
const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const SELECT_SHAPE = new RegExp(`^select\\s+(?:(${IDENT}(?:\\.${IDENT})?)|json_extract\\(\\s*${IDENT}(?:\\.${IDENT})?\\s*,\\s*'\\$(?:\\.${IDENT}|\\[\\d{1,3}\\])+'\\s*\\))(?:\\s+as\\s+(${IDENT}))?\\s+from\\s+(${IDENT})(?:\\s+(?!where\\b)${IDENT})?(?:\\s+where\\s+([\\s\\S]+))?$`, "i");
/** One single-table SELECT whose value comes from a stored column, so no literal or parameter can become the observed value. */
function selectShape(sql: string): { output: string } | string {
  const text = sql.trim();
  if (/;|--|\/\*/.test(text)) return "SQL must be one statement without comments";
  if (/\b(?:pragma|attach|detach)\b/i.test(text)) return "SQL may not use PRAGMA, ATTACH or DETACH";
  const shape = SELECT_SHAPE.exec(text);
  if (!shape) return "SQL must be SELECT <column | json_extract(column,'$.path')> [AS name] FROM <table> [WHERE predicate]";
  if (/^(?:sqlite_|pragma_)/i.test(shape[3] ?? "")) return "SQL may not read SQLite internal tables";
  const predicate = (shape[4] ?? "").replace(/'(?:[^']|'')*'/g, "''");
  if (/\b(?:select|union|intersect|except|join|values|insert|update|delete|replace|create|drop|alter|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|load_extension)\b|[:@$][A-Za-z_]|\?\d/i.test(predicate))
    return "SQL predicate may not contain subqueries, joins, compound or write keywords, or named parameters";
  const output = shape[2] ?? shape[1]?.split(".").at(-1);
  return output ? { output } : "json_extract readback needs AS <name>";
}
export function selectRefusal(sql: string): string | null {
  const shape = selectShape(sql);
  return typeof shape === "string" ? shape : null;
}
/** Everything a readback must satisfy before it is trusted; the runner re-checks before executing it. */
export function readbackRefusal(entry: Q14Readback): string | null {
  if (entry.via === "api") {
    if (entry.method !== "GET") return "method must be GET";
    return apiPathRefusal(entry.path) ?? jsonPointerRefusal(entry.pointer) ?? (entry.path.includes(entry.observed) ? "observed value echoes the request path" : null);
  }
  const shape = selectShape(entry.sql);
  if (typeof shape === "string") return shape;
  if ((entry.sql.match(/\?/g) ?? []).length !== entry.params.length) return "parameter count differs from placeholders";
  if (entry.column !== shape.output) return "column is not the selected output name";
  return entry.params.some(param => String(param) === entry.observed) ? "observed value echoes a query parameter" : null;
}
export const ADAPTER_ARTIFACTS = {
  Q03: z.object({ row: z.literal("Q03"), extractorInstanceId: identifier, distilled: z.array(distilledRecord).min(1),
    correction: z.object({ superseded: recordRef, current: recordRef }).strict(),
    refused: z.array(z.object({ sourceId: identifier, outcome: z.enum(["failed", "cancelled", "interrupted"]) }).strict()).min(1),
    reuse: marked, staleWithheld: marked }).strict(),
  Q06: z.object({ row: z.literal("Q06"), readiness: z.object({ sourceId: identifier, sourceRevision: z.number().int().nonnegative(), indexed: recordRef }).strict(),
    distractorSourceIds: z.array(identifier).min(1), supplied: marked, isolation: z.array(z.object({ match: z.string().min(8).max(200) }).strict()).min(1) }).strict(),
  Q13: z.object({ row: z.literal("Q13"), extractorInstanceId: identifier,
    budget: z.object({ sourceId: identifier, deferredReason: z.literal("budget-exhausted"), withheldWhileExhausted: marked, recovered: distilledRecord }).strict() }).strict(),
  // Contract v3: one learned skill variant and one learned routine variant, each a complete v2 evaluation.
  Q14: z.object({ row: z.literal("Q14"), variants: z.array(z.object({ reviewId: z.string().regex(/^procedure-review:/).max(400), receiptId: identifier, evaluator: identifier,
    heldout: z.object({ corpusDigest: z.string().regex(/^[0-9a-f]{64}$/), untouched: z.literal(true), cases: z.number().int().positive(), baseline: z.number(), candidate: z.number(), regressions: z.literal(0) }).strict(),
    budget: z.object({ authorityReference: identifier, costKnown: z.literal(true), actualCostUsd: z.literal(0), leaseCharge: z.string().regex(/^[1-9][0-9]{0,15}$/) }).strict(),
    publication: z.object({ kind: z.enum(["skill", "routine"]), artifactId: identifier, baseRevision: revisionId, publishedRevision: revisionId }).strict(),
    earlierTask: z.object({ threadId: identifier, revisionAfterPublication: revisionId, revisionAfterRollback: revisionId }).strict(),
    nextTask: z.object({ threadId: identifier, revision: revisionId }).strict(),
    rollback: z.object({ fromRevision: revisionId, toRevision: revisionId, nextTask: z.object({ threadId: identifier, revision: revisionId }).strict() }).strict(),
    readback: z.array(Q14_READBACK).length(Q14_READBACK_FACTS.length) }).strict()).length(2) }).strict(),
};
/** A routine review revision is the JSON pair [instructionRevision, updatedAt] (procedure-review-host.ts routineBase). */
export function routinePair(value: string): [string, number] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || !parsed[0] || parsed[0].length > 200 || !Number.isSafeInteger(parsed[1]) || (parsed[1] as number) < 0) return null;
    return JSON.stringify(parsed) === value ? [parsed[0], parsed[1] as number] : null;
  } catch { return null; }
}
export type AdapterArtifacts = { [K in AdapterRow]: z.infer<typeof ADAPTER_ARTIFACTS[K]> }[AdapterRow];

/** Shape plus internal consistency; the runner separately cross-checks the live profile. */
export function validateAdapterArtifacts(row: AdapterRow, value: unknown): AdapterArtifacts {
  const schema: z.ZodType = ADAPTER_ARTIFACTS[row];
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Adapter artifacts invalid: ${parsed.error.issues.map(issue => `${issue.path.map(String).join(".") || "root"} ${issue.code}`).join("; ").slice(0, 300)}`);
  const a = parsed.data as AdapterArtifacts;
  const rule = (ok: boolean, message: string) => { if (!ok) throw new Error(`Adapter artifacts invalid: ${message}`); };
  const same = (x: { id: string; version: number }, y: { id: string; version: number }) => x.id === y.id && x.version === y.version;
  if (a.row === "Q03") {
    rule(a.distilled.some(item => same(item.record, a.correction.current)), "current correction was not distilled from captured sources");
    rule(!same(a.correction.superseded, a.correction.current), "superseded and current correction are the same record version");
    rule(a.reuse.canary !== a.staleWithheld.canary, "reuse and stale canaries must differ");
    rule(!a.reuse.match.includes(a.reuse.canary), "reuse query carries the answer");
  } else if (a.row === "Q06") {
    rule(!a.distractorSourceIds.includes(a.readiness.sourceId), "distractor sources must differ from the intended source");
    rule(!a.supplied.match.includes(a.supplied.canary), "supplied query carries the answer");
  } else if (a.row === "Q13") {
    rule(a.budget.recovered.sourceIds.includes(a.budget.sourceId), "recovered learning must cite the deferred source");
  } else {
    rule(a.variants.map(item => item.publication.kind).sort().join(",") === "routine,skill", "Q14 needs exactly one skill variant and one routine variant");
    rule(a.variants[0]!.reviewId !== a.variants[1]!.reviewId && a.variants[0]!.receiptId !== a.variants[1]!.receiptId, "Q14 variants must come from separate reviews and receipts");
    for (const v of a.variants) {
      const at = (message: string) => `${v.publication.kind} variant: ${message}`;
      rule(v.heldout.candidate > v.heldout.baseline, at("held-out candidate must beat the baseline"));
      rule(v.publication.publishedRevision !== v.publication.baseRevision, at("publication must change the revision"));
      rule(v.earlierTask.revisionAfterPublication === v.publication.baseRevision && v.earlierTask.revisionAfterRollback === v.publication.baseRevision, at("earlier task version must stay at the base revision"));
      rule(v.nextTask.revision === v.publication.publishedRevision && v.nextTask.threadId !== v.earlierTask.threadId, at("next task must use the published revision in a new task"));
      rule(v.rollback.fromRevision === v.publication.publishedRevision && v.rollback.toRevision !== v.publication.publishedRevision
        && v.rollback.nextTask.revision === v.rollback.toRevision && ![v.earlierTask.threadId, v.nextTask.threadId].includes(v.rollback.nextTask.threadId), at("rollback must leave the published revision for a new task"));
      if (v.publication.kind === "routine") rule([v.publication.baseRevision, v.publication.publishedRevision, v.rollback.toRevision].every(value => routinePair(value) !== null)
        && routinePair(v.rollback.toRevision)![0] !== routinePair(v.publication.publishedRevision)![0], at("routine revisions must be distinct [instructionRevision, updatedAt] pairs"));
      rule(Q14_READBACK_FACTS.every(fact => v.readback.filter(entry => entry.fact === fact).length === 1), at("readback must claim each Q14 fact exactly once"));
      for (const [index, entry] of v.readback.entries()) {
        const refusal = readbackRefusal(entry);
        rule(refusal === null, at(`readback ${index} ${entry.fact} refused: ${refusal}`));
      }
    }
  }
  return a;
}

export type ReadbackOutcome = { ok: true; value: string } | { ok: false; reason: string };
type Q14Artifacts = Extract<AdapterArtifacts, { row: "Q14" }>;
export type Q14Variant = Q14Artifacts["variants"][number];
type FactRule = { field: string; value(v: Q14Variant): string; via: "api" | "sqlite"; path?: string; pointer?: RegExp; leaves?: string[]; within?: RegExp; ledger?: true; pinThread?(v: Q14Variant): string };
const INDEX = "(?:0|[1-9]\\d*)";
const SHARED_RULES: Record<"earlier-task-pin" | "next-task-pin" | "post-rollback-task-pin" | "budget-lease-charge", FactRule> = {
  "earlier-task-pin": { field: "earlierTask.revisionAfterRollback", value: v => v.earlierTask.revisionAfterRollback, via: "api", leaves: ["bundleId"], pinThread: v => v.earlierTask.threadId },
  "next-task-pin": { field: "nextTask.revision", value: v => v.nextTask.revision, via: "api", leaves: ["bundleId"], pinThread: v => v.nextTask.threadId },
  "post-rollback-task-pin": { field: "rollback.nextTask.revision", value: v => v.rollback.nextTask.revision, via: "api", leaves: ["bundleId"], pinThread: v => v.rollback.nextTask.threadId },
  "budget-lease-charge": { field: "budget.leaseCharge", value: v => v.budget.leaseCharge, via: "sqlite", ledger: true },
};
/** Concrete product store per fact and publication kind (contract v3): skill history route, routine store, task pin bundle ids, extraction ledger row. */
export const Q14_FACT_RULES: Record<"skill" | "routine", Record<Q14ReadbackFact, FactRule>> = {
  skill: {
    "current-revision": { field: "rollback.toRevision", value: v => v.rollback.toRevision, via: "api", leaves: ["currentRevision"] },
    "published-revision-in-history": { field: "publication.publishedRevision", value: v => v.publication.publishedRevision, via: "api", within: new RegExp(`/revisions/${INDEX}/(?:revision|id)$`) },
    "rollback-history-entry": { field: "publication.baseRevision", value: v => v.publication.baseRevision, via: "api", leaves: ["rollbackOf"] },
    ...SHARED_RULES,
  },
  // Routine revisions are [instructionRevision, updatedAt] pairs; the store, history and pins carry the instruction revision.
  routine: {
    "current-revision": { field: "rollback.toRevision", value: v => v.rollback.toRevision, via: "api", path: "/api/routines", pointer: new RegExp(`^/routines/${INDEX}/instructionRevision$`) },
    "published-revision-in-history": { field: "publication.publishedRevision", value: v => v.publication.publishedRevision, via: "api", path: "/api/routines", pointer: new RegExp(`^/routines/${INDEX}/instructionHistory/${INDEX}/id$`) },
    "rollback-history-entry": { field: "publication.baseRevision", value: v => v.publication.baseRevision, via: "api", path: "/api/routines", pointer: new RegExp(`^/routines/${INDEX}/instructionHistory/${INDEX}/rollbackOf$`) },
    ...SHARED_RULES,
  },
};
/** Sibling scalars the runner reads from the same GET /api/routines body to bind a routine fact to its routine and history entry. */
export function routineSiblingPointers(fact: Q14ReadbackFact, pointer: string): Record<string, string> | null {
  const current = new RegExp(`^(/routines/${INDEX})/instructionRevision$`).exec(pointer);
  const history = new RegExp(`^(/routines/${INDEX})(/instructionHistory/${INDEX})/(?:id|rollbackOf)$`).exec(pointer);
  if (fact === "current-revision" && current) return { routineId: `${current[1]}/id`, updatedAt: `${current[1]}/updatedAt` };
  if (fact === "published-revision-in-history" && history) return { routineId: `${history[1]}/id`, author: `${history[1]}${history[2]}/author`, receiptId: `${history[1]}${history[2]}/evaluationReceiptId` };
  if (fact === "rollback-history-entry" && history) return { routineId: `${history[1]}/id`, author: `${history[1]}${history[2]}/author`, entryId: `${history[1]}${history[2]}/id` };
  return null;
}
export const LEDGER_TABLE = "memory_scope_bindings";
const LEDGER_SELECT = /^select\s+json_extract\(\s*intent\s*,\s*'\$\.output'\s*\)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s+from\s+memory_scope_bindings\s+where\s+id\s*=\s*\?\s+and\s+subject_id\s*=\s*\?$/i;
/** The budget fact may name only the product's daily extraction ledger row and its output field. */
export function ledgerBindingRefusal(entry: Q14Readback): string | null {
  if (entry.via !== "sqlite") return "the ledger fact is read through sqlite";
  const shape = LEDGER_SELECT.exec(entry.sql.trim());
  if (!shape || shape[1] !== entry.column) return "SQL must be SELECT json_extract(intent,'$.output') AS <column> FROM memory_scope_bindings WHERE id=? AND subject_id=?";
  if (entry.params.length !== 2 || typeof entry.params[0] !== "string" || !/^extract-budget:\d{4}-\d{2}-\d{2}$/.test(entry.params[0]) || entry.params[1] !== "extract-budget")
    return "params must be [extract-budget:<UTC yyyy-mm-dd>, extract-budget]";
  return null;
}
/** The runner's own fixed ledger query; adapter SQL is never executed for the budget fact. */
export function readLedgerOutput(db: DatabaseSync, id: string): ReadbackOutcome {
  try {
    const rows = db.prepare("SELECT json_extract(intent,'$.output') AS output FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id='extract-budget'").all(id);
    return rows.length === 1 ? scalarOutcome(rows[0]!.output) : { ok: false, reason: `${rows.length} ledger rows` };
  } catch { return { ok: false, reason: "ledger query refused by SQLite" }; }
}
const decodeToken = (token: string) => token.replace(/~1/g, "/").replace(/~0/g, "~");
const scalarOutcome = (value: unknown): ReadbackOutcome => typeof value === "string" ? { ok: true, value }
  : (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" || typeof value === "bigint" ? { ok: true, value: String(value) }
  : { ok: false, reason: "value is missing or not a scalar" };
/** Resolves an RFC 6901 pointer to one scalar; nothing else from the body is kept. */
export function pointedValue(body: unknown, pointer: string): ReadbackOutcome {
  if (jsonPointerRefusal(pointer) !== null) return { ok: false, reason: "pointer refused" };
  let value: unknown = body;
  for (const token of pointer.slice(1).split("/").map(decodeToken)) {
    if (Array.isArray(value) ? !/^(?:0|[1-9]\d*)$/.test(token) : !(value !== null && typeof value === "object" && Object.hasOwn(value, token))) return { ok: false, reason: "pointer does not resolve" };
    value = (value as Record<string, unknown>)[token];
  }
  return scalarOutcome(value);
}
/** A task pin is a content-addressed bundle: its bytes must hash to the pinned id and name the task thread.
 * Skill pins yield imported[name=artifactId].revision; routine pins yield routine.instructionRevision for routine.id=artifactId. */
export function resolveTaskPinRevision(dataDir: string, threadId: string, bundleId: string, kind: "skill" | "routine", artifactId: string): ReadbackOutcome {
  const fail = (reason: string): ReadbackOutcome => ({ ok: false, reason });
  if (!/^[a-f0-9]{64}$/.test(bundleId)) return fail("pin readback is not a task bundle id");
  if (!/^[\w-]+$/.test(threadId)) return fail("task thread is not a plain identifier");
  const root = join(dataDir, "skill-state");
  let owners: string[];
  try { owners = readdirSync(root).filter(name => /^[\w-]+$/.test(name) && existsSync(join(root, name, "task-bundles", threadId, `${bundleId}.json`))); } catch { return fail("task bundle store unavailable"); }
  if (owners.length !== 1) return fail(`${owners.length} task bundles match the pin`);
  try {
    const bytes = readFileSync(join(root, owners[0]!, "task-bundles", threadId, `${bundleId}.json`));
    if (sha256(bytes) !== bundleId) return fail("task bundle bytes do not match the pinned id");
    const bundle = JSON.parse(bytes.toString("utf8")) as { schema?: unknown; botId?: unknown; threadId?: unknown; imported?: unknown; routine?: { id?: unknown; instructionRevision?: unknown } };
    if (bundle.schema !== 1 || bundle.botId !== owners[0] || bundle.threadId !== threadId) return fail("task bundle names another task");
    if (kind === "routine") {
      const routine = bundle.routine;
      return routine?.id === artifactId && typeof routine.instructionRevision === "string" && routine.instructionRevision ? { ok: true, value: routine.instructionRevision } : fail("task bundle pins no instruction revision for the routine");
    }
    const item = Array.isArray(bundle.imported) ? (bundle.imported as Array<{ name?: unknown; revision?: unknown }>).find(entry => entry?.name === artifactId) : undefined;
    return typeof item?.revision === "string" && item.revision ? { ok: true, value: item.revision } : fail("task bundle pins no revision for the artifact");
  } catch { return fail("task bundle unreadable"); }
}
export interface Q14ReadbackEvidence {
  /** The runner's own re-read of each claimed readback, index-aligned with variant.readback (the ledger fact holds the runner's ledger query). */
  reread: ReadbackOutcome[];
  /** For pin facts, the revision resolved from the pinned task bundle; null for every other fact. */
  pins: Array<ReadbackOutcome | null>;
  /** For routine history facts, sibling scalars from the same GET body (routineSiblingPointers); null otherwise. */
  siblings: Array<Record<string, ReadbackOutcome> | null>;
  /** The runner's fixed query of the bound extract-budget row, with the UTC days its lease snapshots were taken on. */
  ledger: { id: string; windowDays: string[]; value: ReadbackOutcome } | null;
  /** The runner's lookup of the evaluation session written inside the inference lease. */
  session: { reviewId: string; grantId: string } | null;
}
/** Pure comparison for one variant: re-read equals observed, and observed (or the pinned revision) equals the artifact field.
 * Routine fields compare on the instruction revision of their [instructionRevision, updatedAt] pair. */
export function compareQ14Readbacks(v: Q14Variant, evidence: Q14ReadbackEvidence): Check[] {
  const kind = v.publication.kind, rules = Q14_FACT_RULES[kind];
  return Q14_READBACK_FACTS.map(fact => {
    const rule = rules[fact], name = `q14-${kind}-readback-${fact}`;
    const fail = (detail: string): Check => ({ name, status: "FAIL", detail: detail.slice(0, 300) });
    const claims = [...v.readback.entries()].filter(([, entry]) => entry.fact === fact);
    if (claims.length !== 1) return fail(claims.length ? `${fact} claimed ${claims.length} times` : "missing claim");
    const [index, entry] = claims[0]!;
    const label = entry.via === "api" ? `api GET ${entry.path} ${entry.pointer}`
      : rule.ledger && ledgerBindingRefusal(entry) === null ? `sqlite ${LEDGER_TABLE} extract-budget $.output (column ${entry.column})` : `sqlite column ${entry.column}`;
    const refusal = readbackRefusal(entry);
    if (refusal !== null) return fail(`${label}: refused (${refusal})`);
    if (entry.via !== rule.via) return fail(`${label}: ${fact} must be read through ${rule.via}`);
    if (entry.via === "api") {
      const leaf = decodeToken(entry.pointer.slice(entry.pointer.lastIndexOf("/") + 1));
      if ((rule.path && entry.path !== rule.path) || (rule.pointer && !rule.pointer.test(entry.pointer)) || (rule.leaves && !rule.leaves.includes(leaf)) || (rule.within && !rule.within.test(entry.pointer)))
        return fail(`${label}: pointer does not address the ${kind} ${fact} field${rule.path ? ` under GET ${rule.path}` : ""}`);
    }
    if (rule.ledger) {
      const binding = ledgerBindingRefusal(entry), ledger = evidence.ledger;
      if (binding !== null) return fail(`${label}: not bound to the extract-budget ledger row in ${LEDGER_TABLE} (${binding})`);
      if (!ledger || entry.via !== "sqlite" || ledger.id !== entry.params[0]) return fail(`${label}: runner query of the ${LEDGER_TABLE} extract-budget row missing`);
      if (!ledger.windowDays.includes(ledger.id.slice("extract-budget:".length))) return fail(`${label}: ${ledger.id} is outside the scenario window days`);
      if (!ledger.value.ok) return fail(`${label}: runner ledger query of ${ledger.id} failed (${ledger.value.reason})`);
      if (ledger.value.value !== entry.observed) return fail(`${label}: runner ledger query of ${ledger.id} differs from observed`);
    } else {
      const reread = evidence.reread[index];
      if (!reread) return fail(`${label}: not re-read by the runner`);
      if (!reread.ok) return fail(`${label}: re-read failed (${reread.reason})`);
      if (reread.value !== entry.observed) return fail(`${label}: re-read differs from observed`);
    }
    let claimed = entry.observed;
    if (rule.pinThread) {
      const pin = evidence.pins[index];
      if (!pin?.ok) return fail(`${label}: pinned bundle ${pin ? pin.reason : "not resolved"}`);
      claimed = pin.value;
    }
    const pair = kind === "routine" && !rule.ledger ? routinePair(rule.value(v)) : null;
    if (kind === "routine" && !rule.ledger && !pair) return fail(`${label}: ${rule.field} is not an [instructionRevision, updatedAt] pair`);
    if (claimed !== (pair ? pair[0] : rule.value(v))) return fail(`${label}: ${rule.pinThread ? "pinned revision" : "observed"} differs from ${rule.field}${pair ? " instruction revision" : ""}`);
    if (kind === "routine" && entry.via === "api" && !rule.pinThread) {
      const near = evidence.siblings[index], sibling = (key: string) => { const item = near?.[key]; return item?.ok ? item.value : undefined; };
      const toRevision = routinePair(v.rollback.toRevision);
      if (sibling("routineId") !== v.publication.artifactId) return fail(`${label}: routine at the pointer is not publication.artifactId`);
      if (fact === "current-revision" && sibling("updatedAt") !== String(toRevision?.[1])) return fail(`${label}: routine updatedAt differs from rollback.toRevision`);
      if (fact === "published-revision-in-history" && (sibling("author") !== "learned" || sibling("receiptId") !== v.receiptId)) return fail(`${label}: history entry is not the learned revision with evaluationReceiptId receiptId`);
      if (fact === "rollback-history-entry" && (sibling("author") !== "rollback" || sibling("entryId") !== toRevision?.[0])) return fail(`${label}: history entry is not the rollback revision named by rollback.toRevision`);
    }
    const session = evidence.session;
    if (rule.ledger && (!session || session.reviewId !== v.reviewId || session.grantId !== v.budget.authorityReference))
      return fail(`${label}: evaluation session inside the inference lease ${session ? "names another review or authority" : "missing"}`);
    return { name, status: "PASS", detail: `${label}: ${rule.ledger ? "runner ledger query" : "re-read"} matches observed and ${rule.field}` };
  });
}

// Lease evidence (contract v3). The runner snapshots these product rows itself
// before adapter.run and after it returns; nothing here comes from the adapter.
export type LeaseTally = { calls: number; input: number; output: number };
export interface Q14LeaseSnapshot {
  /** UTC day (the product's extract-budget key) when the snapshot was taken. */
  day: string;
  /** extract-budget:<day> rows in memory_scope_bindings, by day. */
  ledger: Record<string, { input: number; output: number }>;
  /** memory_learning_config revision and the daily output limit that caps each reservation. */
  learning: { revision: number; outputLimit: number } | null;
  /** procedure-evaluation-session rows, by row id. */
  sessions: Record<string, { reviewId: string; grantId: string }>;
  /** procedure-evaluation-charges rows (proposed shared patch SP-Q14-LEASE-CHARGES), by row id. */
  charges: Record<string, { reviewId: string; grantId: string; evaluation: LeaseTally; reflection: LeaseTally; refusals: Record<string, number> }>;
}
export const LEASE_CHARGES_MISSING = "product records no per-callback lease charge or refusal: extract.ts withMemoryInferenceLease/reserveExtraction and procedure-evaluator.ts evaluate() persist nothing per lease.request (shared patch SP-Q14-LEASE-CHARGES)";
const leaseKey = (prefix: "procedure-evaluation-session" | "procedure-evaluation-charges", reviewId: string) => `${prefix}:${sha256(JSON.stringify(reviewId))}`;
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
/** Reads the lease evidence rows through a read-only handle; unreadable tables yield empty sections. */
export function readQ14LeaseSnapshot(db: DatabaseSync, now = Date.now()): Q14LeaseSnapshot {
  const snapshot: Q14LeaseSnapshot = { day: new Date(now).toISOString().slice(0, 10), ledger: {}, learning: null, sessions: {}, charges: {} };
  const rows = (subject: string) => { try { return db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id=?").all(subject); } catch { return []; } };
  const parse = (text: unknown): Record<string, any> | null => { try { const value = JSON.parse(String(text)); return value && typeof value === "object" ? value : null; } catch { return null; } };
  const tally = (value: any): LeaseTally | null => { const calls = count(value?.calls), input = count(value?.input), output = count(value?.output); return calls === null || input === null || output === null ? null : { calls, input, output }; };
  for (const row of rows("extract-budget")) {
    const day = /^extract-budget:(\d{4}-\d{2}-\d{2})$/.exec(String(row.id))?.[1], intent = parse(row.intent), input = count(intent?.input), output = count(intent?.output);
    if (day && input !== null && output !== null) snapshot.ledger[day] = { input, output };
  }
  try {
    const row = db.prepare("SELECT revision,settings FROM memory_learning_config WHERE id=1").get();
    const revision = count(row?.revision), outputLimit = count(parse(row?.settings)?.outputLimit);
    if (revision !== null && outputLimit !== null) snapshot.learning = { revision, outputLimit };
  } catch { snapshot.learning = null; }
  for (const row of rows("procedure-evaluation-session")) {
    const intent = parse(row.intent);
    if (typeof intent?.reviewId === "string" && typeof intent.grantId === "string") snapshot.sessions[String(row.id)] = { reviewId: intent.reviewId, grantId: intent.grantId };
  }
  for (const row of rows("procedure-evaluation-charges")) {
    const intent = parse(row.intent), evaluation = tally(intent?.evaluation), reflection = tally(intent?.reflection);
    const refusals = Object.fromEntries(Object.entries(intent?.refusals ?? {}).flatMap(([reason, n]): Array<[string, number]> => /^[a-z-]{1,40}$/.test(reason) && count(n) !== null ? [[reason, n as number]] : []));
    if (typeof intent?.reviewId === "string" && typeof intent.grantId === "string" && evaluation && reflection) snapshot.charges[String(row.id)] = { reviewId: intent.reviewId, grantId: intent.grantId, evaluation, reflection, refusals };
  }
  return snapshot;
}
/** What the runner read from each variant's stored review row. */
export interface Q14ReviewEvidence { kind: "skill" | "routine"; reviewId: string; authorityReference: string; complete: boolean; learningRevision: number | null; metricCalls: number | null; reflectionCalls: number | null }
/** Pure comparison of the runner's own before/after lease snapshots with the callbacks each stored receipt claims.
 * Each evaluation callback reserves min(2000, outputLimit) and each reflection min(8000, outputLimit) (procedure-evaluator.ts request). */
export function compareQ14LeaseEvidence(reviews: Q14ReviewEvidence[], before: Q14LeaseSnapshot | null, after: Q14LeaseSnapshot | null): Check[] {
  const check = (name: string, ok: boolean, detail: string): Check => ({ name, status: ok ? "PASS" : "FAIL", detail: detail.slice(0, 300) });
  const names = ["q14-lease-sessions-recorded-in-window", "q14-lease-ledger-delta-matches-receipt-callbacks", "q14-lease-charges-attributable-to-sessions", "q14-lease-budget-refusal-resume-no-double-charge"];
  if (!before || !after) return names.map(name => check(name, false, "runner lease snapshot unavailable before or after adapter.run"));
  const sessions = reviews.map(r => {
    const key = leaseKey("procedure-evaluation-session", r.reviewId), row = after.sessions[key];
    return { kind: r.kind, ok: !before.sessions[key] && row?.reviewId === r.reviewId && row.grantId === r.authorityReference, state: before.sessions[key] ? "existed before" : row ? (row.grantId === r.authorityReference ? "new" : "other authority") : "missing" };
  });
  const days = [...new Set([...Object.keys(before.ledger), ...Object.keys(after.ledger)])];
  const delta = days.reduce((sum, day) => ({ input: sum.input + (after.ledger[day]?.input ?? 0) - (before.ledger[day]?.input ?? 0), output: sum.output + (after.ledger[day]?.output ?? 0) - (before.ledger[day]?.output ?? 0) }), { input: 0, output: 0 });
  const limit = after.learning?.outputLimit, each = (r: Q14ReviewEvidence) => limit === undefined || r.metricCalls === null || r.reflectionCalls === null ? null
    : { evaluation: r.metricCalls * Math.min(2000, limit), reflection: r.reflectionCalls * Math.min(8000, limit) };
  const unknown = reviews.filter(r => r.metricCalls === null || r.reflectionCalls === null).map(r => r.kind);
  const fenced = limit === undefined ? reviews.map(r => r.kind) : reviews.filter(r => r.learningRevision === null || r.learningRevision !== after.learning?.revision).map(r => r.kind);
  const expected = reviews.reduce((sum, r) => sum + (each(r)?.evaluation ?? 0) + (each(r)?.reflection ?? 0), 0);
  const ledgerDetail = `${LEDGER_TABLE} extract-budget output delta ${delta.output}, input delta ${delta.input}; receipt callbacks expect output ${expected}`;
  const deltaReason = limit === undefined ? "; memory_learning_config unreadable" : unknown.length ? `; stored receipt accounting lacks callback counts (${unknown.join(",")})`
    : fenced.length ? `; learning settings changed after the ${fenced.join(",")} review snapshot` : "";
  const results = [
    check(names[0]!, sessions.every(item => item.ok), `${LEDGER_TABLE} procedure-evaluation-session: ${sessions.map(item => `${item.kind} ${item.state}`).join(", ")}`),
    check(names[1]!, !unknown.length && !fenced.length && expected > 0 && delta.output === expected && delta.input > 0, `${ledgerDetail}${deltaReason}`),
  ];
  if (!Object.keys(after.charges).length) return [...results, check(names[2]!, false, LEASE_CHARGES_MISSING), check(names[3]!, false, LEASE_CHARGES_MISSING)];
  const exact = (r: Q14ReviewEvidence) => {
    const key = leaseKey("procedure-evaluation-charges", r.reviewId), row = after.charges[key], want = each(r);
    return Boolean(row && want && !before.charges[key] && row.reviewId === r.reviewId && row.grantId === r.authorityReference
      && row.evaluation.calls === r.metricCalls && row.reflection.calls === r.reflectionCalls && row.evaluation.output === want.evaluation && row.reflection.output === want.reflection);
  };
  const charged = Object.entries(after.charges).reduce((sum, [key, row]) => {
    const prior = before.charges[key], was = (part: "evaluation" | "reflection", field: "input" | "output") => prior?.[part][field] ?? 0;
    return { input: sum.input + row.evaluation.input + row.reflection.input - was("evaluation", "input") - was("reflection", "input"), output: sum.output + row.evaluation.output + row.reflection.output - was("evaluation", "output") - was("reflection", "output") };
  }, { input: 0, output: 0 });
  const refused = reviews.filter(r => (after.charges[leaseKey("procedure-evaluation-charges", r.reviewId)]?.refusals["budget-exhausted"] ?? 0) > 0);
  return [...results,
    check(names[2]!, !unknown.length && !fenced.length && reviews.every(exact) && charged.input === delta.input && charged.output === delta.output,
      `procedure-evaluation-charges output ${charged.output}, input ${charged.input}; ${LEDGER_TABLE} extract-budget delta output ${delta.output}, input ${delta.input}; exact per-session callbacks: ${reviews.map(r => `${r.kind} ${exact(r) ? "yes" : "no"}`).join(", ")}`),
    check(names[3]!, refused.length > 0 && refused.every(r => r.complete && exact(r)),
      refused.length ? `budget-exhausted refusal recorded for ${refused.map(r => r.kind).join(",")}; resumed review complete with each callback charged once: ${refused.every(r => r.complete && exact(r)) ? "yes" : "no"}` : "no budget-exhausted refusal recorded for either evaluation session; the refusal-then-resume path was not exercised"),
  ];
}

/** Loads a join adapter only when its module file exists; otherwise a BLOCKED reason names the module and export. */
export async function loadAdapter(spec: AdapterSpec, root = ROOT): Promise<{ adapter: B34Adapter } | { blocked: string }> {
  const path = join(root, spec.module);
  if (!existsSync(path)) return { blocked: adapterMissing(spec) };
  let loaded: Partial<B34Adapter> | undefined;
  try { loaded = (await import(pathToFileURL(path).href) as Record<string, Partial<B34Adapter> | undefined>)[spec.export]; }
  catch (error) { return { blocked: `Adapter import failed: ${spec.module} (${(error instanceof Error ? error.message : String(error)).slice(0, 200)}); no behavioural attempt made.` }; }
  const launch = loaded?.launch;
  if (!loaded || typeof loaded.run !== "function" || loaded.row !== spec.row
    || (launch !== undefined && (typeof launch !== "object" || launch === null || (launch.instrumentationSource !== undefined && typeof launch.instrumentationSource !== "string"))))
    return { blocked: `Adapter unusable: ${spec.module} export ${spec.export} is not { row: "${spec.row}", run(ctx), launch?: { instrumentationSource?: string } }; no behavioural attempt made.` };
  return { adapter: loaded as B34Adapter };
}

type Check = { name: string; status: "PASS" | "FAIL"; detail?: string };
export interface Receipt {
  schema: "murage-b34-receipt/1"; row: string; scenario: string; tier: Tier; tierLabel: string; satisfiesRequiredTier: boolean;
  status: "PASS" | "FAIL" | "BLOCKED"; startedAt: string; elapsedMs: number;
  candidate: { head: string; indexTree: string; worktreeDiffSha256: string; untrackedCount: number; untrackedSha256: string };
  runner: { path: string; sha256: string; node: string; platform: string };
  engines: Array<{ instanceId: string; driverKind: string; binary: string; binarySha256: string; models: string[] }>;
  inputs: Record<string, unknown>; audience: string[]; deliveredMemory: string[]; visibleResponse: string | null;
  sideEffects: Record<string, unknown>; checks: Check[];
  cost: { known: boolean; amountUsd: number | null; basis: string }; limitations: string[];
}

export function validateReceipt(receipt: Receipt): Receipt {
  const row = MATRIX.find(item => item.id === receipt.row);
  if (receipt.schema !== "murage-b34-receipt/1" || !row || receipt.scenario !== row.scenario) throw new Error("Receipt row identity invalid");
  if (!EXECUTABLE_TIERS.includes(receipt.tier) || receipt.tierLabel !== TIER_LABEL[receipt.tier]) throw new Error("Receipt tier is not an executable, exactly labelled tier");
  if (receipt.satisfiesRequiredTier !== row.required.includes(receipt.tier)) throw new Error("Receipt misstates whether its tier satisfies the row");
  if (!/^[0-9a-f]{40}$/.test(receipt.candidate?.head ?? "") || !/^[0-9a-f]{40}$/.test(receipt.candidate?.indexTree ?? "")) throw new Error("Receipt lacks candidate identity");
  if (!receipt.cost?.known || receipt.cost.amountUsd !== 0) throw new Error("Scripted tiers must record a known zero cost");
  if (!receipt.limitations?.length) throw new Error("Receipt must state its limitations");
  if (receipt.status === "BLOCKED" ? receipt.checks.length !== 0 : !receipt.checks.length) throw new Error("Receipt checks inconsistent with status");
  if (receipt.status === "PASS" && receipt.checks.some(check => check.status !== "PASS")) throw new Error("PASS receipt carries a failed check");
  if (receipt.status === "FAIL" && receipt.checks.every(check => check.status === "PASS")) throw new Error("FAIL receipt has no failed check");
  if (receipt.tier === "isolated-server" && receipt.status !== "BLOCKED"
    && (!receipt.engines.length || receipt.engines.some(engine => !/^[0-9a-f]{64}$/.test(engine.binarySha256)))) throw new Error("Server receipt lacks engine binary identity");
  return receipt;
}

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export function candidateIdentity(root = ROOT): Receipt["candidate"] {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const path of untracked) { hash.update(`${path}\0`); hash.update(readFileSync(join(root, path))); }
  return { head: git("rev-parse", "HEAD"), indexTree: git("write-tree"), worktreeDiffSha256: sha256(execFileSync("git", ["diff", "--binary"], { cwd: root, maxBuffer: 64 * 1024 * 1024 })),
    untrackedCount: untracked.length, untrackedSha256: hash.digest("hex") };
}

function baseReceipt(row: MatrixRow, tier: Tier, candidate: Receipt["candidate"]): Receipt {
  return { schema: "murage-b34-receipt/1", row: row.id, scenario: row.scenario, tier, tierLabel: TIER_LABEL[tier], satisfiesRequiredTier: row.required.includes(tier),
    status: "BLOCKED", startedAt: new Date().toISOString(), elapsedMs: 0, candidate,
    runner: { path: "scripts/b34-receipt-matrix.ts", sha256: sha256(readFileSync(fileURLToPath(import.meta.url))), node: process.version, platform: `${process.platform}-${process.arch}` },
    engines: [], inputs: {}, audience: [], deliveredMemory: [], visibleResponse: null, sideEffects: {}, checks: [],
    cost: { known: true, amountUsd: 0, basis: "scripted fixtures only; no network, credential or model call" }, limitations: [] };
}
function finish(receipt: Receipt, started: number): Receipt {
  receipt.elapsedMs = Date.now() - started;
  receipt.status = receipt.checks.length ? (receipt.checks.every(check => check.status === "PASS") ? "PASS" : "FAIL") : "BLOCKED";
  return receipt;
}

function runDeterministic(row: MatrixRow, out: string, candidate: Receipt["candidate"]): Receipt {
  const receipt = baseReceipt(row, "deterministic", candidate), started = Date.now();
  const report = join(out, `${row.id}-deterministic-vitest.json`);
  rmSync(report, { force: true });
  const run = spawnSync(join(ROOT, "node_modules", ".bin", "vitest"), ["run", ...row.deterministic, "--reporter=json", `--outputFile=${report}`],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(out, `${row.id}-deterministic-vitest.log`), `${run.stdout ?? ""}${run.stderr ?? ""}`);
  receipt.inputs = { fixtures: row.deterministic.map(path => ({ path, sha256: sha256(readFileSync(join(ROOT, path))) })), report: relative(out, report) };
  receipt.checks.push({ name: "vitest-exit", status: run.status === 0 ? "PASS" : "FAIL", detail: `exit ${run.status} signal ${run.signal}` });
  const parsed = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) as { numTotalTests: number; testResults: Array<{ name: string; assertionResults: Array<{ status: string }> }> } : null;
  receipt.checks.push({ name: "tests-discovered", status: parsed && parsed.numTotalTests > 0 ? "PASS" : "FAIL", detail: `${parsed?.numTotalTests ?? 0} tests` });
  let skipped = 0;
  for (const path of row.deterministic) {
    const file = parsed?.testResults.find(result => resolve(result.name) === resolve(ROOT, path));
    const counts = { passed: 0, failed: 0, other: 0 };
    for (const assertion of file?.assertionResults ?? []) counts[assertion.status === "passed" ? "passed" : assertion.status === "failed" ? "failed" : "other"]++;
    skipped += counts.other;
    receipt.checks.push({ name: `fixture:${path}`, status: file && counts.passed > 0 && counts.failed === 0 ? "PASS" : "FAIL", detail: `${counts.passed} passed, ${counts.failed} failed, ${counts.other} not executed` });
  }
  receipt.limitations.push(`Deterministic fixtures named by the traceability map; they do not satisfy ${row.required.filter(tier => tier !== "deterministic").join(", ") || "any further"} tier(s).`);
  if (skipped) receipt.limitations.push(`${skipped} selected test(s) were skipped or pending and are not evidence.`);
  return finish(receipt, started);
}

export type Bot = { id: string; threadId: string; name: string; modelSelection: { instanceId: string; model: string } };
export type Dump = { pid: number; argv: string[]; prompt: { message: { content: string } }; systemPrompt: string | null };
export type Api = { status: number; body: any };
type SetupVerify = (response: Api) => { ok: boolean; note?: string };
/** Setup HTTP step outcome: the detail is only "METHOD path HTTP status" plus a caller note, never a body or header. */
export function setupOutcome(name: string | null, method: string, path: string, response: Api, expected: number, verify?: SetupVerify): { check: Check | null; error: string | null } {
  const extra = verify?.(response);
  const detail = `${method} ${path} HTTP ${response.status}${extra?.note === undefined ? "" : `; ${extra.note}`}`;
  return { check: name === null ? null : { name, status: response.status === expected && (extra?.ok ?? true) ? "PASS" : "FAIL", detail },
    error: response.status === expected ? null : `setup failed: ${detail}` };
}
/** What a join adapter receives: the runner's isolated server, without direct memory seeding or receipt access. */
export interface B34AdapterContext {
  row: AdapterRow; url: string; dataDir: string; fixtureDumpPath: string; fixtureFinishGateDir: string;
  api(method: string, path: string, body?: unknown): Promise<Api>;
  action(body: Record<string, unknown>): Promise<Api>;
  setup(name: string | null, method: string, path: string, body: unknown, expected: number, verify?: SetupVerify): Promise<Api>;
  bot(name: string): Promise<Bot>;
  /** Direct message (optionally to another task thread); the request is recorded as runner-observed with its thread. */
  send(bot: Bot, text: string, hold?: boolean, threadId?: string): Promise<Dump>;
  /** Waits for a fake Claude request containing match (room or held turns) and records it as runner-observed without a thread. */
  dispatched(match: string, timeout?: number): Promise<Dump>;
  settled(kind: "bot" | "channel", id: string): Promise<void>;
  until<T>(label: string, read: () => T | undefined | Promise<T | undefined>, timeout?: number): Promise<T>;
  restart(): Promise<void>;
  check(name: string, ok: boolean, detail?: string): void;
  /** Read-only connection to the isolated profile database. */
  db(): DatabaseSync;
}
export interface B34Adapter { row: AdapterRow; launch?: { instrumentationSource?: string }; run(ctx: B34AdapterContext): Promise<unknown> }
interface Ctx {
  receipt: Receipt; dataDir: string;
  api(method: string, path: string, body?: unknown): Promise<Api>;
  action(body: Record<string, unknown>): Promise<Api>;
  setup(name: string | null, method: string, path: string, body: unknown, expected: number, verify?: SetupVerify): Promise<Api>;
  db(): DatabaseSync; closeDb(): void; restart(): Promise<void>;
  bot(name: string): Promise<Bot>;
  send(bot: Bot, text: string, hold?: boolean, threadId?: string): Promise<Dump>;
  settled(kind: "bot" | "channel", id: string): Promise<void>;
  until<T>(label: string, read: () => T | undefined | Promise<T | undefined>, timeout?: number): Promise<T>;
  pin(scopeKind: string, owner: string, threadId: string, id: string, text: string): { id: string; sourceId: string; scopeId: string };
  check(name: string, ok: boolean, detail?: string): void;
  engine(instanceId: string, driverKind: string, binary: string, ...models: string[]): void;
}
function frame(text: string | null | undefined): string[] {
  const start = `${MEMORY_REFERENCE_PREAMBLE}\n${MEMORY_REFERENCE_OPEN}\n`, at = text?.indexOf(start) ?? -1;
  if (!text || at < 0) return [];
  const end = text.indexOf(`\n${MEMORY_REFERENCE_CLOSE}`, at + start.length);
  return end < 0 ? [] : text.slice(at + start.length, end).split("\n");
}
const has = (lines: string[], canary: string) => lines.some(line => line.includes(canary));
const modelOf = (dump: Dump) => dump.argv[dump.argv.indexOf("--model") + 1] ?? "unknown";
const personaLine = (dump: Dump) => /Personality: [^\n]*/.exec(dump.systemPrompt ?? "")?.[0] ?? null;
// The persona is one sentence inside a longer joined system line; compare the exact imprint clause.
const hasImprint = (text: string | null | undefined, persona: string) => Boolean(text?.includes(`Personality: ${persona}`));
const visible = async (ctx: Ctx, threadId: string) => {
  const messages = (await ctx.api("GET", `/api/threads/${threadId}/messages?limit=50`)).body?.messages as Array<{ role: string; kind: string; text?: string }> | undefined;
  return messages?.filter(message => message.role === "bot" && message.kind === "text").at(-1)?.text ?? null;
};
const outcomes = (ctx: Ctx, threadId: string) => ctx.db().prepare("SELECT outcome FROM memory_sources WHERE thread_id=? AND kind='turn'").all(threadId).map(row => String(row.outcome));
const meta = (ctx: Ctx) => ctx.db().prepare("SELECT mode,policy_revision,deletion_epoch FROM memory_meta WHERE id=1").get() as { mode: string; policy_revision: number; deletion_epoch: number };

const SCENARIOS: Record<Scenario, (ctx: Ctx) => Promise<void>> = {
  async "blank-personality"(ctx) {
    const bot = await ctx.bot("B34 Q01 blank");
    const dump = await ctx.send(bot, "b34-q01 who are you");
    ctx.engine("verification", "claudeAgent", FAKE_CLAUDE, modelOf(dump));
    ctx.receipt.audience = [`bot:${bot.id}`]; ctx.receipt.inputs = { persona: null }; ctx.receipt.deliveredMemory = frame(dump.prompt.message.content);
    ctx.check("system-imprint-default", hasImprint(dump.systemPrompt, personalityImprint("")), personaLine(dump)?.slice(0, 120) ?? "missing");
    const identity = Number(ctx.db().prepare("SELECT count(*) AS n FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version JOIN memory_scopes s ON s.id=r.scope_id WHERE d.partition='identity' AND s.kind='bot' AND s.owner_key=?").get(bot.id)!.n);
    ctx.check("no-identity-memory-invented", identity === 0 && !ctx.receipt.deliveredMemory.some(line => /continuity|reveal|canon/i.test(line)), `${identity} identity records`);
    ctx.receipt.visibleResponse = await visible(ctx, bot.threadId);
  },
  async "owner-identity"(ctx) {
    const bot = await ctx.bot("B34 Q02 imprint");
    const persona = "Dry wit; calls the owner Captain.";
    await ctx.setup("persona-set", "PATCH", `/api/bots/${bot.id}`, { persona }, 200);
    const write = (body: Record<string, unknown>) => ctx.setup(null, "POST", "/api/memory/action", { action: "identity-write", botId: bot.id, audience: "owner-private", expectedVersion: 0, ...body }, 200,
      () => ({ ok: true, note: `action identity-write ${String(body.kind)}` }));
    const core = await write({ kind: "continuity-brief", key: "core", basis: "owner-fact", text: "CONTINUITY_CORE Keeps launch notes brief." });
    const canon = await write({ kind: "character-canon", key: "origin", basis: "fiction", text: "CANON_HIDDEN_ORIGIN Grew up tending a lighthouse." });
    const reveal = await write({ kind: "reveal-state", key: "origin-reveal", basis: "fiction", canon: { id: canon.body?.id, version: canon.body?.version }, revealed: true, text: "REVEAL_NOTE Told the owner about the lighthouse." });
    ctx.check("identity-writes-accepted", [core, canon, reveal].every(result => result.status === 200), `POST /api/memory/action HTTP ${[core, canon, reveal].map(result => result.status).join(",")}`);
    const dump = await ctx.send(bot, "b34-q02 introduce yourself");
    ctx.engine("verification", "claudeAgent", FAKE_CLAUDE, modelOf(dump));
    const lines = frame(dump.prompt.message.content);
    ctx.receipt.audience = [`bot:${bot.id}`, "owner-private"]; ctx.receipt.deliveredMemory = lines;
    ctx.receipt.inputs = { persona, identity: [core.body, canon.body, reveal.body].map(record => record && { id: record.id, version: record.version, kind: record.kind }) };
    ctx.check("system-imprint-exact", hasImprint(dump.systemPrompt, persona), personaLine(dump)?.slice(0, 120) ?? "missing");
    ctx.check("continuity-delivered", has(lines, "CONTINUITY_CORE"));
    ctx.check("reveal-state-delivered", has(lines, "REVEAL_NOTE"));
    ctx.check("hidden-canon-withheld", !`${dump.prompt.message.content}\n${dump.systemPrompt}`.includes("CANON_HIDDEN_ORIGIN"));
    const basis = ctx.db().prepare("SELECT confidence_basis FROM memory_record_details WHERE record_id=? AND record_version=?").get(canon.body?.id ?? "", canon.body?.version ?? 0);
    ctx.check("canon-labelled-fiction", /fictional/i.test(String(basis?.confidence_basis ?? "")), String(basis?.confidence_basis ?? "missing"));
    ctx.check("reveal-derived-from-canon", Boolean(ctx.db().prepare("SELECT 1 FROM memory_derivations WHERE parent_id=? AND child_id=?").get(canon.body?.id ?? "", reveal.body?.id ?? "")));
    ctx.receipt.visibleResponse = await visible(ctx, bot.threadId);
  },
  async supersession(ctx) {
    const bot = await ctx.bot("B34 Q04 supersession");
    const stale = ctx.pin("bot", bot.id, bot.threadId, "b34-q04-deadline", "DEADLINE_STALE Launch is on 1 March.");
    await ctx.setup("owner-correction-accepted", "POST", "/api/memory/action", { action: "correct", id: stale.id, version: 1, text: "DEADLINE_CURRENT Launch is on 15 March." }, 200,
      response => ({ ok: response.body?.record?.version === 2, note: `action correct; record version ${typeof response.body?.record?.version === "number" ? response.body.record.version : "missing"}` }));
    const dump = await ctx.send(bot, "b34-q04 when is launch");
    ctx.engine("verification", "claudeAgent", FAKE_CLAUDE, modelOf(dump));
    const lines = frame(dump.prompt.message.content);
    ctx.receipt.audience = [`bot:${bot.id}`]; ctx.receipt.deliveredMemory = lines; ctx.receipt.inputs = { record: stale.id, versions: [1, 2] };
    ctx.check("current-fact-delivered", has(lines, "DEADLINE_CURRENT"));
    ctx.check("stale-fact-not-delivered", !dump.prompt.message.content.includes("DEADLINE_STALE"));
    const versions = ctx.db().prepare("SELECT version,state,valid_to FROM memory_records WHERE id=? ORDER BY version").all(stale.id);
    ctx.receipt.sideEffects = { versions };
    ctx.check("history-retained-as-superseded", versions.length === 2 && versions[0].state === "superseded" && versions[0].valid_to !== null && versions[1].state === "active");
    ctx.check("supersession-lineage", Boolean(ctx.db().prepare("SELECT 1 FROM memory_derivations WHERE parent_id=? AND parent_version=1 AND child_id=? AND child_version=2").get(stale.id, stale.id)));
    ctx.receipt.visibleResponse = await visible(ctx, bot.threadId);
  },
  async "turn-outcomes"(ctx) {
    const done = await ctx.bot("B34 Q05 completed"), failed = await ctx.bot("B34 Q05 failed");
    const first = await ctx.send(done, "b34-q05 complete this");
    await ctx.send(failed, "__fixture_fail_turn__ b34-q05 fail this");
    ctx.engine("verification", "claudeAgent", FAKE_CLAUDE, modelOf(first));
    const completed = await ctx.until("completed turn outcome", () => { const rows = outcomes(ctx, done.threadId); return rows.some(row => row !== "working") ? rows : undefined; });
    const failure = await ctx.until("failed turn outcome", () => { const rows = outcomes(ctx, failed.threadId); return rows.some(row => row !== "working") ? rows : undefined; });
    ctx.receipt.audience = [`bot:${done.id}`, `bot:${failed.id}`]; ctx.receipt.sideEffects = { completed, failure };
    ctx.check("completed-turn-recorded-completed", completed.includes("completed") && !completed.includes("failed"), completed.join(","));
    ctx.check("failed-turn-not-recorded-completed", failure.includes("failed") && !failure.includes("completed"), failure.join(","));
    ctx.receipt.limitations.push("Tool-level uncertain outcome not exercised: the launcher cannot select the fake CLI tool failure mode. Root should confirm how capture.ts classifies a tool result without a boolean ok before a named-model run.");
  },
  async "interrupt-restart"(ctx) {
    const bot = await ctx.bot("B34 Q07 restart");
    const held = await ctx.send(bot, "__fixture_hold_authority__ b34-q07 long task", true);
    await ctx.setup("interrupt-accepted", "POST", `/api/bots/${bot.id}/interrupt`, {}, 200);
    await ctx.settled("bot", bot.id);
    await ctx.restart();
    const bots = (await ctx.api("GET", "/api/bots")).body?.bots as Bot[] | undefined;
    ctx.check("bot-survives-restart", Boolean(bots?.some(item => item.id === bot.id && item.name === bot.name)));
    const recorded = outcomes(ctx, bot.threadId);
    ctx.check("interrupted-turn-not-completed", !recorded.includes("completed") && !recorded.includes("working") && recorded.some(row => row === "interrupted" || row === "cancelled"), recorded.join(","));
    const after = await ctx.send(bot, "b34-q07 after restart");
    ctx.engine("verification", "claudeAgent", FAKE_CLAUDE, modelOf(held), modelOf(after));
    ctx.receipt.audience = [`bot:${bot.id}`]; ctx.receipt.deliveredMemory = frame(after.prompt.message.content); ctx.receipt.sideEffects = { outcomes: recorded, pids: [held.pid, after.pid] };
    ctx.check("fresh-engine-process-after-restart", after.pid !== held.pid);
    ctx.check("identity-kept-after-restart", personaLine(after) !== null && personaLine(after) === personaLine(held), personaLine(after) ?? "missing");
    ctx.check("interrupted-request-not-replayed-as-current", after.prompt.message.content.endsWith("b34-q07 after restart"));
    ctx.receipt.visibleResponse = await visible(ctx, bot.threadId);
  },
  async "model-switch"(ctx) {
    const bot = await ctx.bot("B34 Q08 model");
    ctx.pin("bot", bot.id, bot.threadId, "b34-q08-fact", "MODEL_SWITCH_FACT Use the reviewed checklist.");
    const before = await ctx.send(bot, "b34-q08 before switch");
    const instances = (await ctx.setup(null, "GET", "/api/instances", undefined, 200)).body?.instances as Array<{ instanceId: string; models?: { options?: Array<{ id: string }> } }>;
    const other = instances.find(row => row.instanceId === bot.modelSelection.instanceId)?.models?.options?.find(model => model.id !== modelOf(before))?.id;
    ctx.check("second-declared-model-available", Boolean(other), other ?? "none");
    if (!other) throw new Error("setup failed: no second declared fixture model");
    await ctx.setup("model-selection-patched", "PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: bot.modelSelection.instanceId, model: other } }, 200);
    const after = await ctx.send(bot, "b34-q08 after switch");
    ctx.engine("verification", "claudeAgent", FAKE_CLAUDE, modelOf(before), modelOf(after));
    ctx.receipt.audience = [`bot:${bot.id}`]; ctx.receipt.deliveredMemory = frame(after.prompt.message.content);
    ctx.check("fake-model-identity-changed", modelOf(before) !== modelOf(after) && modelOf(after) === other, `${modelOf(before)} -> ${modelOf(after)}`);
    ctx.check("imprint-unchanged", personaLine(before) !== null && personaLine(before) === personaLine(after));
    ctx.check("pinned-knowledge-unchanged", has(frame(before.prompt.message.content), "MODEL_SWITCH_FACT") && has(frame(after.prompt.message.content), "MODEL_SWITCH_FACT"));
  },
  async "engine-switch"(ctx) {
    const configPath = join(ctx.dataDir, "config.json"), codexDump = join(ctx.dataDir, "fake-codex-dump.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances["b34-codex"] = { driver: "codex", displayName: "B34 Codex fixture", config: { cli: FAKE_CODEX }, environment: { FAKE_CODEX_DUMP: codexDump, FAKE_CODEX_MODE: "happy" } };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    await ctx.restart();
    const bot = await ctx.bot("B34 Q09 engine");
    const persona = "Precise and calm.";
    const personaResponse = await ctx.api("PATCH", `/api/bots/${bot.id}`, { persona });
    ctx.check("persona-set", personaResponse.status === 200, `HTTP ${personaResponse.status}`);
    if (personaResponse.status !== 200) throw new Error(`Q09 persona setup HTTP ${personaResponse.status}`);
    const fact = ctx.pin("bot", bot.id, bot.threadId, "b34-q09-fact", "ENGINE_SWITCH_FACT Keep the public checklist.");
    const before = await ctx.send(bot, "b34-q09 before engine switch");
    const instances = (await ctx.api("GET", "/api/instances")).body?.instances as Array<{ instanceId: string; models?: { default?: string; options?: Array<{ id: string }> } }>;
    const codex = instances.find(row => row.instanceId === "b34-codex");
    const model = codex?.models?.default ?? codex?.models?.options?.[0]?.id;
    ctx.check("codex-fixture-instance-live", Boolean(codex && model), JSON.stringify(codex ?? null).slice(0, 300));
    if (!codex || typeof model !== "string" || !model) throw new Error("Q09 fixture model unavailable");
    const selection = await ctx.api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "b34-codex", model } });
    ctx.check("engine-selection-patched", selection.status === 200, `HTTP ${selection.status}`);
    if (selection.status !== 200) throw new Error(`Q09 model setup HTTP ${selection.status}`);
    const listed = await ctx.api("GET", "/api/bots");
    const selected = listed.body?.bots?.find((item: Bot) => item.id === bot.id);
    const task = selected?.tasks?.find((item: { threadId: string }) => item.threadId === bot.threadId);
    const matches = listed.status === 200 && selected?.tasks?.length === 1
      && task?.modelSelection?.instanceId === "b34-codex" && task?.modelSelection?.model === model;
    ctx.check("original-task-selection-readback", matches, JSON.stringify({ status: listed.status, taskCount: selected?.tasks?.length ?? null,
      threadMatches: task?.threadId === bot.threadId, instanceMatches: task?.modelSelection?.instanceId === "b34-codex", modelMatches: task?.modelSelection?.model === model }));
    if (!matches) throw new Error("Q09 original task model selection did not match");
    rmSync(codexDump, { force: true });
    const response = await ctx.api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "b34-q09 after engine switch" });
    ctx.check("post-switch-send-accepted", response.status === 202, `HTTP ${response.status}`);
    if (response.status !== 202) throw new Error(`Q09 message admission HTTP ${response.status}`);
    const payload = await ctx.until("codex fixture received the turn", () => {
      try {
        const calls = JSON.parse(readFileSync(codexDump, "utf8")).calls as Array<{ method: string; params: any }>;
        const start = calls.find(call => call.method === "turn/start");
        return start ? (start.params.input as Array<{ text?: string }>).map(item => item.text ?? "").join("\n") : undefined;
      } catch { return undefined; }
    }, 30_000);
    await ctx.settled("bot", bot.id);
    ctx.engine("verification", "claudeAgent", FAKE_CLAUDE, modelOf(before));
    ctx.engine("b34-codex", "codex", FAKE_CODEX, String(model));
    const lines = frame(payload);
    ctx.receipt.audience = [`bot:${bot.id}`]; ctx.receipt.deliveredMemory = lines;
    ctx.check("imprint-kept-across-engines", hasImprint(before.systemPrompt, persona) && hasImprint(payload, persona));
    ctx.check("knowledge-kept-across-engines", has(frame(before.prompt.message.content), "ENGINE_SWITCH_FACT") && has(lines, "ENGINE_SWITCH_FACT"));
    ctx.check("no-provenance-json-to-new-engine", !["sourceId", "startByte", fact.sourceId, fact.scopeId].some(token => payload.includes(token)));
    const disclosure = await ctx.until("codex disclosure receipt", () => ctx.db().prepare("SELECT driver_instance FROM memory_disclosures WHERE thread_id=? AND driver_instance='b34-codex' LIMIT 1").get(bot.threadId) ?? undefined);
    ctx.receipt.sideEffects = { disclosureInstance: disclosure.driver_instance };
    ctx.check("receipt-names-new-engine-instance", disclosure.driver_instance === "b34-codex");
  },
  async "room-membership"(ctx) {
    const a = await ctx.bot("B34 Q10 A"), b = await ctx.bot("B34 Q10 B"), c = await ctx.bot("B34 Q10 C");
    const made = await ctx.setup("room-created", "POST", "/api/groups", { name: "B34 Q10 room", memberIds: [a.id, b.id], setup: { bulletin: "Fixture only", defaultResponder: { kind: "mentions" } } }, 201);
    const room = made.body?.group as { id: string; threadId: string };
    const privateA = ctx.pin("bot", a.id, a.threadId, "b34-q10-private-a", "PRIVATE_A_CANARY Keep the launch date confidential.");
    const privateC = ctx.pin("bot", c.id, c.threadId, "b34-q10-private-c", "PRIVATE_C_CANARY Keep the vendor confidential.");
    ctx.pin("room", room.id, room.threadId, "b34-q10-shared", "ROOM_SHARED_DECISION Use the reviewed checklist.");
    const roomSend = async (bot: Bot, text: string) => {
      await ctx.setup(null, "POST", `/api/groups/${room.id}/messages`, { text: `@${bot.name} ${text}` }, 202);
      const dump = await ctx.until<Dump>("room member dispatched", () => { try { const parsed = JSON.parse(readFileSync(join(ctx.dataDir, "fake-claude-dump.json"), "utf8")) as Dump; return parsed.prompt.message.content.includes(text) ? parsed : undefined; } catch { return undefined; } }, 30_000);
      await ctx.settled("channel", room.id);
      return dump;
    };
    const forbidden = [privateA, privateC].map(pin => pin.id === privateA.id ? "PRIVATE_A_CANARY" : "PRIVATE_C_CANARY");
    const revision0 = meta(ctx).policy_revision;
    rmSync(join(ctx.dataDir, "fake-claude-dump.json"), { force: true });
    const toA = await roomSend(a, "b34-q10 room before change");
    ctx.check("room-shared-delivered-to-member", has(frame(toA.prompt.message.content), "ROOM_SHARED_DECISION"));
    ctx.check("private-pins-excluded-in-room", !forbidden.some(canary => toA.prompt.message.content.includes(canary)));
    await ctx.setup("member-added", "PATCH", `/api/groups/${room.id}`, { memberIds: [a.id, b.id, c.id] }, 200);
    rmSync(join(ctx.dataDir, "fake-claude-dump.json"), { force: true });
    const toC = await roomSend(c, "b34-q10 room after adding C");
    ctx.check("new-member-gets-room-knowledge", has(frame(toC.prompt.message.content), "ROOM_SHARED_DECISION"));
    ctx.check("new-member-room-turn-excludes-private", !forbidden.some(canary => toC.prompt.message.content.includes(canary)));
    await ctx.setup("member-removed", "PATCH", `/api/groups/${room.id}`, { memberIds: [a.id, c.id] }, 200);
    const toB = await ctx.send(b, "b34-q10 direct after removal");
    ctx.engine("verification", "claudeAgent", FAKE_CLAUDE, modelOf(toA));
    ctx.check("removed-member-loses-room-knowledge", !toB.prompt.message.content.includes("ROOM_SHARED_DECISION") && !forbidden.some(canary => toB.prompt.message.content.includes(canary)));
    const revision1 = meta(ctx).policy_revision;
    ctx.check("membership-changes-advance-policy", revision1 > revision0, `${revision0} -> ${revision1}`);
    ctx.receipt.audience = [`room:${room.id}`, `bot:${a.id}`, `bot:${b.id}`, `bot:${c.id}`];
    ctx.receipt.deliveredMemory = frame(toC.prompt.message.content); ctx.receipt.sideEffects = { policyRevision: [revision0, revision1] };
  },
  async "concurrent-correction"(ctx) {
    const bot = await ctx.bot("B34 Q11 concurrent");
    const base = ctx.pin("bot", bot.id, bot.threadId, "b34-q11-budget", "CONCURRENT_BASE Budget is 30k.");
    const [first, second] = await Promise.all([
      ctx.action({ action: "correct", id: base.id, version: 1, text: "CONCURRENT_A Budget is 40k." }),
      ctx.action({ action: "correct", id: base.id, version: 1, text: "CONCURRENT_B Budget is 45k." }),
    ]);
    const winners = [first, second].filter(result => result.status === 200), losers = [first, second].filter(result => result.status !== 200);
    ctx.check("exactly-one-correction-wins", winners.length === 1 && losers.length === 1, `${first.status},${second.status}`);
    ctx.check("loser-reports-version-conflict", losers.length === 1 && /MEMORY_VERSION_CONFLICT/.test(JSON.stringify(losers[0].body)), `HTTP ${losers[0]?.status ?? "none"}`);
    const versions = ctx.db().prepare("SELECT version,state,text FROM memory_records WHERE id=? ORDER BY version").all(base.id);
    ctx.receipt.sideEffects = { versions: versions.map(row => ({ version: row.version, state: row.state })) };
    ctx.check("no-lost-or-duplicate-version", versions.length === 2 && versions[0].state === "superseded" && versions[1].state === "active");
    const winnerText = String(versions[1]?.text ?? ""), loserCanary = winnerText.includes("CONCURRENT_A") ? "CONCURRENT_B" : "CONCURRENT_A";
    const dump = await ctx.send(bot, "b34-q11 what is the budget");
    ctx.engine("verification", "claudeAgent", FAKE_CLAUDE, modelOf(dump));
    const lines = frame(dump.prompt.message.content);
    ctx.receipt.audience = [`bot:${bot.id}`]; ctx.receipt.deliveredMemory = lines;
    ctx.check("only-winning-version-delivered", has(lines, winnerText.split(" ")[0]) && !dump.prompt.message.content.includes(loserCanary) && !dump.prompt.message.content.includes("CONCURRENT_BASE"));
  },
  async forget(ctx) {
    const bot = await ctx.bot("B34 Q12 forget");
    const secret = ctx.pin("bot", bot.id, bot.threadId, "b34-q12-code", "FORGET_CANARY Door code is fixture-only.");
    const before = await ctx.send(bot, "b34-q12 before forget");
    ctx.check("fact-delivered-before-forget", has(frame(before.prompt.message.content), "FORGET_CANARY"));
    const epoch0 = meta(ctx).deletion_epoch;
    await ctx.setup("forget-accepted", "POST", "/api/memory/action", { action: "forget", kind: "record", id: secret.id }, 200, () => ({ ok: true, note: "action forget" }));
    const after = await ctx.send(bot, "b34-q12 after forget");
    ctx.engine("verification", "claudeAgent", FAKE_CLAUDE, modelOf(before), modelOf(after));
    ctx.receipt.audience = [`bot:${bot.id}`]; ctx.receipt.deliveredMemory = frame(after.prompt.message.content);
    ctx.check("forgotten-fact-absent-from-next-dispatch", !`${after.prompt.message.content}\n${after.systemPrompt}`.includes("FORGET_CANARY"));
    ctx.check("revoked-history-not-resumed", after.pid !== before.pid && !after.argv.includes("--resume"));
    const tombstones = ctx.db().prepare("SELECT reason FROM memory_tombstones WHERE target_id IN (?,?)").all(secret.id, secret.sourceId).map(row => String(row.reason));
    ctx.receipt.sideEffects = { tombstones, deletionEpoch: [epoch0, meta(ctx).deletion_epoch] };
    ctx.check("tombstones-recorded", tombstones.includes("owner-forget") && tombstones.includes("forgotten-supporting-source"), tombstones.join(","));
    ctx.check("deletion-epoch-advanced", meta(ctx).deletion_epoch > epoch0);
  },
  async "memory-mode"(ctx) {
    await ctx.setup("paused-accepted", "POST", "/api/memory/action", { action: "configure", mode: "paused" }, 200, () => ({ ok: meta(ctx).mode === "paused", note: `action configure; mode ${meta(ctx).mode}` }));
    const pausedBot = await ctx.bot("B34 Q16 paused");
    ctx.pin("bot", pausedBot.id, pausedBot.threadId, "b34-q16-paused", "PAUSED_CANARY Should not be delivered.");
    const whilePaused = await ctx.send(pausedBot, "b34-q16 while paused");
    ctx.check("paused-delivers-no-memory", !whilePaused.prompt.message.content.includes(MEMORY_REFERENCE_PREAMBLE) && !whilePaused.prompt.message.content.includes("PAUSED_CANARY"));
    await ctx.setup("off-accepted", "POST", "/api/memory/action", { action: "configure", mode: "off" }, 200, () => ({ ok: meta(ctx).mode === "off", note: `action configure; mode ${meta(ctx).mode}` }));
    const offBot = await ctx.bot("B34 Q16 off");
    const whileOff = await ctx.send(offBot, "b34-q16 while off");
    ctx.engine("verification", "claudeAgent", FAKE_CLAUDE, modelOf(whilePaused));
    const captured = Number(ctx.db().prepare("SELECT count(*) AS n FROM memory_sources WHERE thread_id=?").get(offBot.threadId)!.n);
    ctx.check("off-delivers-no-memory", !whileOff.prompt.message.content.includes(MEMORY_REFERENCE_PREAMBLE));
    ctx.check("off-captures-nothing", captured === 0, `${captured} sources`);
    ctx.receipt.audience = [`bot:${pausedBot.id}`, `bot:${offBot.id}`]; ctx.receipt.sideEffects = { modes: ["paused", "off"], offSources: captured };
  },
};

async function runServer(row: MatrixRow, out: string, candidate: Receipt["candidate"]): Promise<Receipt> {
  const receipt = baseReceipt(row, "isolated-server", candidate), started = Date.now();
  if ("blocked" in row.server) { receipt.limitations.push(row.server.blocked); return finish(receipt, started); }
  const server = row.server;
  let adapter: B34Adapter | undefined;
  if ("adapter" in server) {
    const loaded = await loadAdapter(server.adapter);
    if ("blocked" in loaded) { receipt.limitations.push(loaded.blocked); return finish(receipt, started); }
    adapter = loaded.adapter;
  }
  const { launchVerificationServer, runControlMurage } = await import("./control-murage.ts");
  const instrumentationSource = adapter?.launch?.instrumentationSource;
  const fixture = instrumentationSource === undefined ? await launchVerificationServer() : await launchVerificationServer(process.env, undefined, { instrumentationSource });
  let database: DatabaseSync | undefined, headers: Record<string, string> = {};
  const logs: string[] = [];
  async function refreshDesktopAuthority() {
    const response = await fetch(`${fixture.info.url}/api/desktop-secret`, { signal: AbortSignal.timeout(15_000) });
    if (response.status !== 200) throw new Error(`desktop fixture handshake HTTP ${response.status}`);
    let value: unknown;
    try { value = await response.json(); } catch { throw new Error("desktop fixture handshake invalid JSON"); }
    const secret = value && typeof value === "object" && "secret" in value ? value.secret : undefined;
    if (typeof secret !== "string" || !secret.trim()) throw new Error("desktop fixture handshake missing secret");
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  }
  const ctx: Ctx = {
    receipt, dataDir: fixture.info.dataDir,
    async api(method, path, body) {
      const init: RequestInit = { method, headers: { "content-type": "application/json", ...headers }, signal: AbortSignal.timeout(15_000) };
      if (body !== undefined) init.body = JSON.stringify(body);
      const response = await fetch(`${fixture.info.url}${path}`, init);
      const text = await response.text();
      try { return { status: response.status, body: JSON.parse(text) }; } catch { return { status: response.status, body: text }; }
    },
    action: body => ctx.api("POST", "/api/memory/action", body),
    db() {
      if (!database) { database = new DatabaseSync(join(fixture.info.dataDir, "messages.db")); database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000"); }
      return database;
    },
    closeDb() { database?.close(); database = undefined; },
    async restart() { logs.push(fixture.info.logPath); ctx.closeDb(); await fixture.restart(); await refreshDesktopAuthority(); },
    async setup(name, method, path, body, expected, verify) {
      const response = await ctx.api(method, path, body);
      const outcome = setupOutcome(name, method, path, response, expected, verify);
      if (outcome.check) receipt.checks.push(outcome.check);
      if (outcome.error) throw new Error(outcome.error);
      return response;
    },
    async bot(name) {
      const made = await ctx.setup(null, "POST", "/api/bots", { name, section: "B34Fixture" }, 201);
      return made.body.bot as Bot;
    },
    async send(bot, text, hold = false, threadId) {
      rmSync(fixture.fixtureDumpPath, { force: true });
      await ctx.setup(null, "POST", `/api/bots/${bot.id}/messages`, threadId === undefined ? { text } : { threadId, text }, 202);
      const dump = await ctx.until<Dump>(`fake provider accepted ${text}`, () => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as Dump; } catch { return undefined; } });
      if (!hold) await ctx.settled("bot", bot.id);
      return dump;
    },
    async settled(kind, id) {
      const result = await runControlMurage(["wait", `--${kind}`, id, "--timeout", "30", "--url", fixture.info.url]) as { status: string };
      if (result.status !== "settled") throw new Error(`${kind} ${id} did not settle`);
    },
    async until(label, read, timeout = 15_000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
        await new Promise(done => setTimeout(done, 50));
      }
    },
    pin(scopeKind, owner, threadId, id, text) {
      const db = ctx.db();
      const scope = db.prepare("SELECT id FROM memory_scopes WHERE kind=? AND owner_key=?").get(scopeKind, owner);
      if (!scope) throw new Error(`Fixture scope missing: ${scopeKind}`);
      const scopeId = String(scope.id), sourceId = `source-${id}`, payload = JSON.stringify({ text, kind: "text", speaker: "owner", outcome: "recorded" }), hash = sha256(payload);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state) VALUES(?,?,?,?,1,?,'text','owner','recorded','active')").run(sourceId, scopeId, threadId, `fixture-message-${id}`, hash);
        db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES(?,1,?,?,1)").run(sourceId, hash, payload);
        db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,created_at) VALUES(?,1,?,'fact',?,'owner-statement','active',1,1,1)").run(id, scopeId, text);
        db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,1,?,1,0,?)").run(id, sourceId, Buffer.byteLength(text));
        db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1; COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return { id, sourceId, scopeId };
    },
    check(name, ok, detail) { receipt.checks.push({ name, status: ok ? "PASS" : "FAIL", ...(detail === undefined ? {} : { detail }) }); },
    engine(instanceId, driverKind, binary, ...models) {
      const existing = receipt.engines.find(engine => engine.instanceId === instanceId);
      if (existing) { existing.models = [...new Set([...existing.models, ...models])]; return; }
      receipt.engines.push({ instanceId, driverKind, binary: relative(ROOT, binary), binarySha256: sha256(readFileSync(binary)), models });
    },
  };
  try {
    await refreshDesktopAuthority();
    ctx.engine("verification", "claudeAgent", FAKE_CLAUDE);
    if ("scenario" in server) await SCENARIOS[server.scenario](ctx);
    else if (adapter) await runAdapter(server.adapter, adapter, ctx, fixture, instrumentationSource);
  } catch (error) {
    receipt.checks.push({ name: "scenario-completed", status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
  } finally {
    ctx.closeDb();
    logs.push(fixture.info.logPath);
    for (const [index, path] of logs.entries()) if (existsSync(path)) copyFileSync(path, join(out, `${row.id}-isolated-server-${index}.log`));
    await fixture.close();
  }
  receipt.limitations.push(`Scripted fake engine only; uncovered here: ${row.server.uncovered}.`);
  const gated = row.required.filter(tier => !EXECUTABLE_TIERS.includes(tier));
  if (gated.length) receipt.limitations.push(`Row still requires ${gated.join(", ")} tier evidence.`);
  return finish(receipt, started);
}

type Observed = { threadId: string | null; content: string; system: string; memory: string[] };
async function runAdapter(spec: AdapterSpec, adapter: B34Adapter, ctx: Ctx, fixture: VerificationServer, instrumentationSource: string | undefined) {
  const { receipt } = ctx, observed: Observed[] = [];
  receipt.inputs = { adapter: { module: spec.module, export: spec.export, sha256: sha256(readFileSync(join(ROOT, spec.module))),
    instrumentationSha256: instrumentationSource === undefined ? null : sha256(instrumentationSource) } };
  let view: DatabaseSync | undefined;
  const closeView = () => { view?.close(); view = undefined; };
  const record = (dump: Dump, threadId: string | null) => {
    const content = String(dump.prompt?.message?.content ?? "");
    observed.push({ threadId, content, system: String(dump.systemPrompt ?? ""), memory: frame(content) });
    return dump;
  };
  const context: B34AdapterContext = {
    row: spec.row, url: fixture.info.url, dataDir: ctx.dataDir, fixtureDumpPath: fixture.fixtureDumpPath, fixtureFinishGateDir: fixture.fixtureFinishGateDir,
    api: ctx.api, action: ctx.action, setup: ctx.setup, bot: ctx.bot, settled: ctx.settled, until: ctx.until, check: ctx.check,
    async send(bot, text, hold, threadId) { return record(await ctx.send(bot, text, hold, threadId), threadId ?? bot.threadId); },
    async dispatched(match, timeout = 30_000) {
      return record(await ctx.until<Dump>("fake provider received the adapter turn", () => {
        try { const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as Dump; return JSON.stringify(dump.prompt ?? null).includes(match) ? dump : undefined; } catch { return undefined; }
      }, timeout), null);
    },
    async restart() { closeView(); await ctx.restart(); },
    db() { if (!view) { view = new DatabaseSync(join(ctx.dataDir, "messages.db"), { readOnly: true }); view.exec("PRAGMA busy_timeout=5000"); } return view; },
  };
  // Q14 lease evidence is snapshotted by the runner itself, immediately around adapter.run.
  const leaseSnapshot = () => {
    if (spec.row !== "Q14") return null;
    let handle: DatabaseSync | undefined;
    try { handle = new DatabaseSync(join(ctx.dataDir, "messages.db"), { readOnly: true }); handle.exec("PRAGMA busy_timeout=5000"); return readQ14LeaseSnapshot(handle); }
    catch { return null; } finally { handle?.close(); }
  };
  const before = receipt.checks.length, leaseBefore = leaseSnapshot();
  let value: unknown;
  try { value = await adapter.run(context); } finally { closeView(); }
  const leaseAfter = leaseSnapshot();
  ctx.check("adapter-recorded-behavioural-checks", receipt.checks.length > before, `${receipt.checks.length - before} adapter checks`);
  let artifacts: AdapterArtifacts;
  try { artifacts = validateAdapterArtifacts(spec.row, value); }
  catch (error) { ctx.check("adapter-artifacts-valid", false, (error instanceof Error ? error.message : String(error)).slice(0, 300)); return; }
  ctx.check("adapter-artifacts-valid", true);
  receipt.sideEffects = { artifacts };
  await verifyAdapterArtifacts(artifacts, ctx, observed, { before: leaseBefore, after: leaseAfter });
}

/** Cross-checks adapter claims against the runner's own profile database and the requests it observed. */
type LeaseWindow = { before: Q14LeaseSnapshot | null; after: Q14LeaseSnapshot | null };
async function verifyAdapterArtifacts(a: AdapterArtifacts, ctx: Ctx, observed: Observed[], lease: LeaseWindow = { before: null, after: null }) {
  const db = ctx.db();
  const one = (sql: string, ...values: Array<string | number>) => db.prepare(sql).get(...values) as Record<string, unknown> | undefined;
  const all = (sql: string, ...values: Array<string | number>) => db.prepare(sql).all(...values) as Array<Record<string, unknown>>;
  // Captured by the server itself: not a runner pin, and its capture job completed.
  const captured = (sourceId: string) => {
    const source = one("SELECT thread_id,message_id FROM memory_sources WHERE id=? AND state='active'", sourceId);
    return source && !String(source.message_id ?? "").startsWith("fixture-message-")
      && one("SELECT 1 AS ok FROM memory_jobs WHERE source_id=? AND stage='capture' AND status='complete'", sourceId) ? source : undefined;
  };
  const distilled = (item: { record: { id: string; version: number }; sourceIds: string[] }) => {
    const record = one("SELECT kind,owner_pinned FROM memory_records WHERE id=? AND version=?", item.record.id, item.record.version);
    const evidence = new Set(all("SELECT DISTINCT source_id FROM memory_evidence WHERE record_id=? AND record_version=?", item.record.id, item.record.version).map(row => String(row.source_id)));
    return record?.kind === "fact" && Number(record.owner_pinned) === 0 && evidence.size === new Set(item.sourceIds).size && item.sourceIds.every(id => evidence.has(id) && captured(id) !== undefined);
  };
  const delivered = (claim: { match: string; canary: string }) => observed.find(item => item.threadId !== null && item.content.includes(claim.match) && has(item.memory, claim.canary));
  const withheld = (match: string, canary: string) => { const item = observed.find(entry => entry.content.includes(match)); return Boolean(item && !`${item.content}\n${item.system}`.includes(canary)); };
  const seeded = Number(one("SELECT count(*) AS n FROM memory_sources WHERE message_id LIKE 'fixture-message-%'")?.n ?? 0);
  if (a.row === "Q03" || a.row === "Q13") {
    const status = await ctx.api("GET", "/api/memory/status"), selected = status.body?.configuration?.extractorInstanceId;
    ctx.check("deterministic-extractor-selected", status.status === 200 && selected === a.extractorInstanceId && !String(selected).startsWith("@murage/flux-"), `GET /api/memory/status HTTP ${status.status}`);
  }
  if (a.row !== "Q14") ctx.check("no-runner-pinned-memory", seeded === 0, `${seeded} runner pins`);
  if (a.row === "Q03") {
    ctx.check("distillation-provenance", a.distilled.every(distilled), `${a.distilled.length} distilled records`);
    const { superseded, current } = a.correction;
    const old = one("SELECT state,valid_to FROM memory_records WHERE id=? AND version=?", superseded.id, superseded.version);
    const now = one("SELECT state,text,supersedes_id FROM memory_records WHERE id=? AND version=?", current.id, current.version);
    const lineage = Boolean(one("SELECT 1 AS ok FROM memory_derivations WHERE parent_id=? AND parent_version=? AND child_id=? AND child_version=?", superseded.id, superseded.version, current.id, current.version))
      || now?.supersedes_id === superseded.id;
    ctx.check("correction-supersedes-with-history", old?.state === "superseded" && old.valid_to !== null && now?.state === "active" && lineage, `${String(old?.state ?? "missing")} -> ${String(now?.state ?? "missing")}`);
    ctx.check("failure-outcomes-not-current-facts", a.refused.every(item => {
      const source = one("SELECT thread_id,turn_id,outcome FROM memory_sources WHERE id=?", item.sourceId);
      const settledAs = source?.outcome === item.outcome || Boolean(source?.turn_id
        && one("SELECT 1 AS ok FROM memory_sources WHERE kind='turn' AND thread_id=? AND turn_id=? AND outcome=?", String(source.thread_id), String(source.turn_id), item.outcome));
      return settledAs && !one("SELECT 1 AS ok FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version WHERE e.source_id=? AND r.kind='fact' AND r.state='active'", item.sourceId);
    }), `${a.refused.length} refused sources`);
    const sourceThreads = new Set(all("SELECT DISTINCT s.thread_id FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=?", current.id, current.version).map(row => String(row.thread_id)));
    const reuse = delivered(a.reuse);
    ctx.check("correction-reused-in-another-task", Boolean(reuse && reuse.threadId !== null && !sourceThreads.has(reuse.threadId) && String(now?.text ?? "").includes(a.reuse.canary)));
    ctx.check("superseded-fact-withheld", withheld(a.staleWithheld.match, a.staleWithheld.canary));
    ctx.receipt.deliveredMemory = reuse?.memory ?? [];
  } else if (a.row === "Q13") {
    ctx.check("distillation-provenance", distilled(a.budget.recovered), `${a.budget.recovered.sourceIds.length} sources`);
    ctx.check("exhausted-budget-withheld-learning", withheld(a.budget.withheldWhileExhausted.match, a.budget.withheldWhileExhausted.canary));
  } else if (a.row === "Q06") {
    const { sourceId, sourceRevision, indexed } = a.readiness;
    const source = captured(sourceId);
    const job = one("SELECT status FROM memory_jobs WHERE source_id=? AND source_revision=? AND stage='capture'", sourceId, sourceRevision);
    const chunk = one("SELECT r.kind,r.state FROM memory_records r JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version WHERE r.id=? AND r.version=? AND e.source_id=? AND e.source_revision=?", indexed.id, indexed.version, sourceId, sourceRevision);
    ctx.check("intended-source-processed-and-indexed", Boolean(source) && job?.status === "complete" && chunk?.kind === "source" && chunk.state === "active", `capture job ${String(job?.status ?? "missing")}; indexed ${String(chunk?.kind ?? "missing")}`);
    const createdAt = (id: string) => Number(one("SELECT v.created_at FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=?", id)?.created_at ?? Number.NaN);
    ctx.check("unrelated-recent-context-present", a.distractorSourceIds.every(id => captured(id) !== undefined && createdAt(id) >= createdAt(sourceId)), `${a.distractorSourceIds.length} distractor sources`);
    const supplied = delivered(a.supplied);
    ctx.check("old-evidence-supplied-to-later-task", Boolean(supplied && source && supplied.threadId !== String(source.thread_id)));
    ctx.check("isolation-preserved", a.isolation.every(item => withheld(item.match, a.supplied.canary)), `${a.isolation.length} isolated requests`);
    ctx.receipt.deliveredMemory = supplied?.memory ?? [];
  } else {
    const reviews: Q14ReviewEvidence[] = [];
    for (const v of a.variants) {
      const kind = v.publication.kind;
      const intent = one("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id='procedure-review'", v.reviewId);
      let review: any = null;
      try { review = intent ? JSON.parse(String(intent.intent)) : null; } catch { review = null; }
      const stored = review?.receipt, target = review?.snapshot?.target;
      const heldout = v.heldout;
      ctx.check(`q14-${kind}-evaluator-receipt-recorded-by-runtime`, review?.status === "complete" && stored?.id === v.receiptId && stored?.evaluator === v.evaluator && stored?.decision === "accepted"
        && (["corpusDigest", "untouched", "cases", "baseline", "candidate", "regressions"] as const).every(key => stored?.heldout?.[key] === heldout[key]), `review ${String(review?.status ?? "missing")}`);
      ctx.check(`q14-${kind}-budget-respected-at-known-zero-cost`, stored?.budgetRespected === true && stored?.cancelled === false
        && (stored?.accounting === undefined || (stored.accounting.costKnown === true && stored.accounting.actualCostUsd === 0)));
      ctx.check(`q14-${kind}-publication-target-matches-review`, target?.kind === v.publication.kind && target?.artifactId === v.publication.artifactId && target?.baseRevision === v.publication.baseRevision);
      reviews.push({ kind, reviewId: v.reviewId, authorityReference: v.budget.authorityReference, complete: review?.status === "complete" && stored?.id === v.receiptId,
        learningRevision: count(review?.snapshot?.learningRevision), metricCalls: count(stored?.accounting?.metricCalls), reflectionCalls: count(stored?.accounting?.reflectionCalls) });
    }
    await verifyQ14Readbacks(a, ctx, lease);
    ctx.receipt.checks.push(...compareQ14LeaseEvidence(reviews, lease.before, lease.after));
  }
}

/** Re-executes every Q14 readback after the adapter returned: API through the runner's desktop authority, SQL on a fresh read-only handle,
 * and the budget fact through the runner's own fixed extract-budget ledger query. */
async function verifyQ14Readbacks(a: Q14Artifacts, ctx: Ctx, lease: LeaseWindow) {
  let view: DatabaseSync | undefined;
  try { view = new DatabaseSync(join(ctx.dataDir, "messages.db"), { readOnly: true }); view.exec("PRAGMA busy_timeout=5000"); } catch { view = undefined; }
  try {
    const windowDays = [...new Set([lease.before?.day, lease.after?.day].filter((day): day is string => typeof day === "string"))];
    for (const v of a.variants) {
      const rules = Q14_FACT_RULES[v.publication.kind];
      const reread: ReadbackOutcome[] = [], pins: Array<ReadbackOutcome | null> = [], siblings: Q14ReadbackEvidence["siblings"] = [];
      let ledger: Q14ReadbackEvidence["ledger"] = null;
      for (const entry of v.readback) {
        const rule = rules[entry.fact];
        let outcome: ReadbackOutcome, near: Record<string, ReadbackOutcome> | null = null;
        if (readbackRefusal(entry) !== null) outcome = { ok: false, reason: "refused" };
        else if (rule.ledger) {
          if (entry.via !== "sqlite" || ledgerBindingRefusal(entry) !== null) outcome = { ok: false, reason: "not bound to the extract-budget ledger" };
          else {
            const id = String(entry.params[0]);
            outcome = view ? readLedgerOutput(view, id) : { ok: false, reason: "read-only database unavailable" };
            ledger = { id, windowDays, value: outcome };
          }
        } else if (entry.via === "api") {
          const response = await ctx.api("GET", entry.path).catch(() => undefined);
          outcome = !response ? { ok: false, reason: "request failed" } : response.status === 200 ? pointedValue(response.body, entry.pointer) : { ok: false, reason: `HTTP ${response.status}` };
          const pointers = v.publication.kind === "routine" && response?.status === 200 ? routineSiblingPointers(entry.fact, entry.pointer) : null;
          if (pointers) near = Object.fromEntries(Object.entries(pointers).map(([key, pointer]): [string, ReadbackOutcome] => [key, pointedValue(response!.body, pointer)]));
        } else if (!view) outcome = { ok: false, reason: "read-only database unavailable" };
        else {
          try {
            const rows = view.prepare(entry.sql).all(...entry.params);
            outcome = rows.length === 1 ? scalarOutcome(rows[0]![entry.column]) : { ok: false, reason: `${rows.length} rows` };
          } catch { outcome = { ok: false, reason: "query refused by SQLite" }; }
        }
        reread.push(outcome); siblings.push(near);
        const thread = rule.pinThread?.(v);
        pins.push(thread === undefined ? null : outcome.ok ? resolveTaskPinRevision(ctx.dataDir, thread, outcome.value, v.publication.kind, v.publication.artifactId) : { ok: false, reason: "pin not re-read" });
      }
      let session: Q14ReadbackEvidence["session"] = null;
      try {
        const row = view?.prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id='procedure-evaluation-session'").get(leaseKey("procedure-evaluation-session", v.reviewId));
        const intent = row ? JSON.parse(String(row.intent)) as { reviewId?: unknown; grantId?: unknown } : null;
        if (typeof intent?.reviewId === "string" && typeof intent.grantId === "string") session = { reviewId: intent.reviewId, grantId: intent.grantId };
      } catch { session = null; }
      ctx.receipt.checks.push(...compareQ14Readbacks(v, { reread, pins, siblings, ledger, session }));
    }
  } finally { view?.close(); }
}

function option(args: string[], name: string) {
  const at = args.indexOf(name), value = at < 0 ? undefined : args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`);
  return value;
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) { console.log(JSON.stringify({ rows: matrixCoverage(), answerCases: answerCaseSets() }, null, 2)); return; }
  const tier = option(args, "--tier"); assertExecutableTier(tier);
  const out = option(args, "--out");
  if (!isAbsolute(out) || !relative(ROOT, resolve(out)).startsWith("..")) throw new Error("--out must be an absolute directory outside the repository");
  const ids = option(args, "--rows").split(",");
  const rows = ids.map(id => MATRIX.find(row => row.id === id) ?? (() => { throw new Error(`Unknown row ${id}`); })());
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const candidate = candidateIdentity();
  const summary: Array<{ row: string; status: string; checks: string }> = [];
  for (const row of rows) {
    const receipt = tier === "deterministic" ? runDeterministic(row, out, candidate) : await runServer(row, out, candidate);
    try {
      validateReceipt(receipt);
      writeFileSync(join(out, `${row.id}-${tier}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      summary.push({ row: row.id, status: receipt.status, checks: `${receipt.checks.filter(check => check.status === "PASS").length}/${receipt.checks.length}` });
    } catch (error) {
      // An invalid receipt is a runner defect: keep it for diagnosis, never as evidence, and continue.
      writeFileSync(join(out, `${row.id}-${tier}.invalid.json`), `${JSON.stringify({ error: error instanceof Error ? error.message : String(error), receipt }, null, 2)}\n`, { mode: 0o600 });
      summary.push({ row: row.id, status: "INVALID", checks: `${receipt.checks.filter(check => check.status === "PASS").length}/${receipt.checks.length}` });
    }
  }
  const unchanged = JSON.stringify(candidateIdentity()) === JSON.stringify(candidate);
  console.log(JSON.stringify({ tier, candidate, candidateUnchangedDuringRun: unchanged, summary }, null, 2));
  if (!unchanged || summary.some(item => item.status === "FAIL" || item.status === "INVALID")) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
