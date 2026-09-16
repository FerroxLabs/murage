import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  EXECUTABLE_TIERS, FROZEN_CORPUS_SHA256, LEASE_CHARGES_MISSING, MATRIX, Q14_READBACK_FACTS, TIERS, TIER_LABEL, answerCaseSets, apiPathRefusal, assertExecutableTier,
  compareQ14LeaseEvidence, compareQ14Readbacks, ledgerBindingRefusal, loadAdapter, matrixCoverage, pointedValue, readLedgerOutput, readQ14LeaseSnapshot, resolveTaskPinRevision,
  routinePair, routineSiblingPointers, selectRefusal, setupOutcome, validateAdapterArtifacts, validateReceipt,
  type AdapterSpec, type Q14LeaseSnapshot, type Q14ReadbackEvidence, type Q14ReviewEvidence, type Receipt,
} from "../../../scripts/b34-receipt-matrix.ts";

// Contract checks for the B34 receipt runner itself. Nothing here launches a
// server, engine or model; receipts, adapter artifacts and lease snapshots below
// are synthetic shapes, not evidence.
const ROOT = join(import.meta.dirname, "..", "..", "..");

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    schema: "murage-b34-receipt/1", row: "Q11", scenario: "Concurrent corrections and writes", tier: "deterministic",
    tierLabel: TIER_LABEL.deterministic, satisfiesRequiredTier: true, status: "PASS", startedAt: "2026-09-15T00:00:00.000Z", elapsedMs: 1,
    candidate: { head: "a".repeat(40), indexTree: "b".repeat(40), worktreeDiffSha256: "c".repeat(64), untrackedCount: 0, untrackedSha256: "d".repeat(64) },
    runner: { path: "scripts/b34-receipt-matrix.ts", sha256: "e".repeat(64), node: "v24", platform: "darwin-arm64" },
    engines: [], inputs: {}, audience: [], deliveredMemory: [], visibleResponse: null, sideEffects: {},
    checks: [{ name: "vitest-exit", status: "PASS" }], cost: { known: true, amountUsd: 0, basis: "scripted" }, limitations: ["synthetic"],
    ...overrides,
  };
}

const ref = (id: string, version = 1) => ({ id, version });
const hex = (digit: string) => digit.repeat(64);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ok = (value: string) => ({ ok: true as const, value });
const DAY = "2026-09-15";
const HISTORY = "/api/bots/bot-1/skills/checked-method/history?threadId=thread-3";
const LEDGER_SQL = "SELECT json_extract(intent,'$.output') AS output FROM memory_scope_bindings WHERE id=? AND subject_id=?";
const ledgerReadback = () => ({ fact: "budget-lease-charge", via: "sqlite", sql: LEDGER_SQL, params: [`extract-budget:${DAY}`, "extract-budget"], column: "output", observed: "16000" });
const skillReadback = () => [
  { fact: "current-revision", via: "api", method: "GET", path: HISTORY, pointer: "/currentRevision", observed: "rev-rollback" },
  { fact: "published-revision-in-history", via: "api", method: "GET", path: HISTORY, pointer: "/revisions/1/revision", observed: "rev-learned" },
  { fact: "rollback-history-entry", via: "api", method: "GET", path: HISTORY, pointer: "/current/rollbackOf", observed: "rev-base" },
  { fact: "earlier-task-pin", via: "api", method: "GET", path: "/api/bots", pointer: "/bots/0/tasks/0/procedurePin/bundleId", observed: hex("1") },
  { fact: "next-task-pin", via: "api", method: "GET", path: "/api/bots", pointer: "/bots/0/tasks/1/procedurePin/bundleId", observed: hex("2") },
  { fact: "post-rollback-task-pin", via: "api", method: "GET", path: "/api/bots", pointer: "/bots/0/tasks/2/procedurePin/bundleId", observed: hex("3") },
  ledgerReadback(),
];
// Routine review revisions are the product's JSON [instructionRevision, updatedAt] pair.
const pair = (revision: string, updatedAt: number) => JSON.stringify([revision, updatedAt]);
const ROUTINE = { base: pair("ins-base", 100), learned: pair("ins-learned", 200), rollback: pair("ins-rollback", 300) };
const routineReadback = () => [
  { fact: "current-revision", via: "api", method: "GET", path: "/api/routines", pointer: "/routines/0/instructionRevision", observed: "ins-rollback" },
  { fact: "published-revision-in-history", via: "api", method: "GET", path: "/api/routines", pointer: "/routines/0/instructionHistory/1/id", observed: "ins-learned" },
  { fact: "rollback-history-entry", via: "api", method: "GET", path: "/api/routines", pointer: "/routines/0/instructionHistory/2/rollbackOf", observed: "ins-base" },
  { fact: "earlier-task-pin", via: "api", method: "GET", path: "/api/bots", pointer: "/bots/0/tasks/3/procedurePin/bundleId", observed: hex("4") },
  { fact: "next-task-pin", via: "api", method: "GET", path: "/api/bots", pointer: "/bots/0/tasks/4/procedurePin/bundleId", observed: hex("5") },
  { fact: "post-rollback-task-pin", via: "api", method: "GET", path: "/api/bots", pointer: "/bots/0/tasks/5/procedurePin/bundleId", observed: hex("6") },
  ledgerReadback(),
];
const PINNED: Record<string, Record<string, string>> = {
  skill: { "earlier-task-pin": "rev-base", "next-task-pin": "rev-learned", "post-rollback-task-pin": "rev-rollback" },
  routine: { "earlier-task-pin": "ins-base", "next-task-pin": "ins-learned", "post-rollback-task-pin": "ins-rollback" },
};
const SIBLINGS: Record<string, Record<string, string>> = {
  "current-revision": { routineId: "routine-1", updatedAt: "300" },
  "published-revision-in-history": { routineId: "routine-1", author: "learned", receiptId: "fixture:2" },
  "rollback-history-entry": { routineId: "routine-1", author: "rollback", entryId: "ins-rollback" },
};
type VariantShape = { reviewId: string; publication: { kind: string }; budget: { authorityReference: string }; readback: Array<{ fact: string; observed: string }> };
/** Synthetic runner evidence that agrees with every claim of one variant; tests mutate one part at a time. */
const consistent = (v: VariantShape): Q14ReadbackEvidence => ({
  reread: v.readback.map(entry => ok(entry.observed)),
  pins: v.readback.map(entry => PINNED[v.publication.kind]![entry.fact] === undefined ? null : ok(PINNED[v.publication.kind]![entry.fact]!)),
  siblings: v.readback.map(entry => v.publication.kind === "routine" && SIBLINGS[entry.fact] ? Object.fromEntries(Object.entries(SIBLINGS[entry.fact]!).map(([key, value]) => [key, ok(value)])) : null),
  ledger: { id: `extract-budget:${DAY}`, windowDays: [DAY], value: ok("16000") },
  session: { reviewId: v.reviewId, grantId: v.budget.authorityReference },
});
const heldout = () => ({ corpusDigest: "f".repeat(64), untouched: true, cases: 1, baseline: 0, candidate: 1, regressions: 0 });
const skillVariant = () => ({ reviewId: "procedure-review:checked-method:abc", receiptId: "fixture:1", evaluator: "scripted-controller-fixture", heldout: heldout(),
  budget: { authorityReference: "procedure-evaluation-grant:skill", costKnown: true, actualCostUsd: 0, leaseCharge: "16000" },
  publication: { kind: "skill", artifactId: "checked-method", baseRevision: "rev-base", publishedRevision: "rev-learned" },
  earlierTask: { threadId: "thread-1", revisionAfterPublication: "rev-base", revisionAfterRollback: "rev-base" },
  nextTask: { threadId: "thread-2", revision: "rev-learned" },
  rollback: { fromRevision: "rev-learned", toRevision: "rev-rollback", nextTask: { threadId: "thread-3", revision: "rev-rollback" } },
  readback: skillReadback() });
const routineVariant = () => ({ reviewId: "procedure-review:routine-1:def", receiptId: "fixture:2", evaluator: "scripted-controller-fixture", heldout: heldout(),
  budget: { authorityReference: "procedure-evaluation-grant:routine", costKnown: true, actualCostUsd: 0, leaseCharge: "16000" },
  publication: { kind: "routine", artifactId: "routine-1", baseRevision: ROUTINE.base, publishedRevision: ROUTINE.learned },
  earlierTask: { threadId: "thread-4", revisionAfterPublication: ROUTINE.base, revisionAfterRollback: ROUTINE.base },
  nextTask: { threadId: "thread-5", revision: ROUTINE.learned },
  rollback: { fromRevision: ROUTINE.learned, toRevision: ROUTINE.rollback, nextTask: { threadId: "thread-6", revision: ROUTINE.rollback } },
  readback: routineReadback() });
const artifacts = {
  Q03: () => ({ row: "Q03", extractorInstanceId: "b34-extractor",
    distilled: [{ record: ref("fact-long"), sourceIds: ["src-long"] }, { record: ref("fact-short"), sourceIds: ["src-short"] }],
    correction: { superseded: ref("fact-long"), current: ref("fact-short") }, refused: [{ sourceId: "src-failed", outcome: "failed" }],
    reuse: { match: "b34-q03 which answer length (turn 3)", canary: "SHORT_CANARY" }, staleWithheld: { match: "b34-q03 which answer length (turn 3)", canary: "LONG_CANARY" } }),
  Q06: () => ({ row: "Q06", readiness: { sourceId: "src-old", sourceRevision: 1, indexed: ref("chunk-old") }, distractorSourceIds: ["src-recent"],
    supplied: { match: "b34-q06 which colour did I choose (turn 4)", canary: "CHARCOAL_CANARY" }, isolation: [{ match: "b34-q06 other bot asks (turn 5)" }] }),
  Q13: () => ({ row: "Q13", extractorInstanceId: "b34-extractor", budget: { sourceId: "src-timezone", deferredReason: "budget-exhausted",
    withheldWhileExhausted: { match: "b34-q13 my timezone (turn 1)", canary: "BANGKOK_CANARY" }, recovered: { record: ref("fact-timezone"), sourceIds: ["src-timezone"] } } }),
  Q14: () => ({ row: "Q14", variants: [skillVariant(), routineVariant()] }),
};
type Failed = Array<[string, string | undefined]>;
const failures = (v: any, evidence: Q14ReadbackEvidence): Failed => compareQ14Readbacks(v, evidence).filter(check => check.status === "FAIL").map((check): [string, string | undefined] => [check.name, check.detail]);
const editFor = (base: () => any) => (change: (evidence: Q14ReadbackEvidence) => void, variant: any = base()) => { const evidence = consistent(variant); change(evidence); return failures(variant, evidence); };

// Lease evidence as the runner snapshots it; the keys follow procedure-evaluator.ts hash(JSON.stringify(requestId)).
const sessionKey = (reviewId: string) => `procedure-evaluation-session:${sha(JSON.stringify(reviewId))}`;
const chargesKey = (reviewId: string) => `procedure-evaluation-charges:${sha(JSON.stringify(reviewId))}`;
const tally = (calls: number, output: number, input: number) => ({ calls, input, output });
const REVIEWS = (): Q14ReviewEvidence[] => [
  { kind: "skill", reviewId: skillVariant().reviewId, authorityReference: "procedure-evaluation-grant:skill", complete: true, learningRevision: 3, metricCalls: 2, reflectionCalls: 1 },
  { kind: "routine", reviewId: routineVariant().reviewId, authorityReference: "procedure-evaluation-grant:routine", complete: true, learningRevision: 3, metricCalls: 2, reflectionCalls: 0 },
];
const leaseBefore = (): Q14LeaseSnapshot => ({ day: DAY, ledger: {}, learning: { revision: 3, outputLimit: 20000 }, sessions: {}, charges: {} });
/** Skill: 2 evaluations (2x2000) + 1 reflection (8000); routine: 2 evaluations (2x2000) after one budget refusal. Ledger output 16000. */
const leaseAfter = (): Q14LeaseSnapshot => {
  const [skill, routine] = REVIEWS() as [Q14ReviewEvidence, Q14ReviewEvidence];
  return { day: DAY, ledger: { [DAY]: { input: 900, output: 16000 } }, learning: { revision: 3, outputLimit: 20000 },
    sessions: { [sessionKey(skill.reviewId)]: { reviewId: skill.reviewId, grantId: skill.authorityReference }, [sessionKey(routine.reviewId)]: { reviewId: routine.reviewId, grantId: routine.authorityReference } },
    charges: {
      [chargesKey(skill.reviewId)]: { reviewId: skill.reviewId, grantId: skill.authorityReference, evaluation: tally(2, 4000, 300), reflection: tally(1, 8000, 200), refusals: {} },
      [chargesKey(routine.reviewId)]: { reviewId: routine.reviewId, grantId: routine.authorityReference, evaluation: tally(2, 4000, 400), reflection: tally(0, 0, 0), refusals: { "budget-exhausted": 1 } },
    } };
};
const LEASE_CHECKS = ["q14-lease-sessions-recorded-in-window", "q14-lease-ledger-delta-matches-receipt-callbacks", "q14-lease-charges-attributable-to-sessions", "q14-lease-budget-refusal-resume-no-double-charge"];
const BINDINGS_TABLE = "CREATE TABLE memory_scope_bindings(id TEXT PRIMARY KEY, scope_id TEXT, subject_type TEXT, subject_id TEXT, revision INTEGER, state TEXT, intent TEXT)";

describe("B34 executable receipt matrix", () => {
  it("keeps the sixteen frozen rows, each with existing fixtures and an explicit server driver, adapter join or blocker", () => {
    expect(MATRIX.map(row => row.id)).toEqual(Array.from({ length: 16 }, (_, i) => `Q${String(i + 1).padStart(2, "0")}`));
    for (const row of MATRIX) {
      for (const path of row.deterministic) expect(existsSync(join(ROOT, path)), `${row.id} ${path}`).toBe(true);
      expect("blocked" in row.server ? row.server.blocked.length : row.server.uncovered.length).toBeGreaterThan(20);
      expect(row.required.length).toBeGreaterThan(0);
    }
    expect(MATRIX.filter(row => "blocked" in row.server).map(row => row.id)).toEqual(["Q15"]);
    const joins = MATRIX.flatMap(row => "adapter" in row.server ? [{ id: row.id, ...row.server.adapter }] : []);
    expect(joins.map(spec => spec.id)).toEqual(["Q03", "Q06", "Q13", "Q14"]);
    for (const spec of joins) { expect(spec.row).toBe(spec.id); expect(spec.module).toMatch(/^server\/memory\/testing\/b34-[a-z0-9-]+\.ts$/); }
    expect(new Set(joins.map(spec => `${spec.module}#${spec.export}`)).size).toBe(4);
    // Person isolation is an unmet Q06 gap at this tier: listed as uncovered, never claimed.
    const q06 = MATRIX.find(row => row.id === "Q06")!.server as { covers: string; uncovered: string };
    expect(q06.covers).not.toMatch(/person|human/i);
    expect(q06.uncovered).toContain("person (human principal) isolation");
    // Routine publication is a required, checked Q14 variant: claimed only together with the skill variant, no longer an uncovered label.
    const q14 = MATRIX.find(row => row.id === "Q14")!.server as { covers: string; uncovered: string };
    expect(q14.covers).toContain("one learned skill and one learned routine");
    expect(q14.covers).toContain("no double charge after a budget refusal");
    expect(q14.uncovered).not.toMatch(/routine/i);
  });

  it("keeps the map's required tiers and never runs gated tiers", () => {
    const required = Object.fromEntries(MATRIX.map(row => [row.id, row.required]));
    expect(required.Q08).toEqual(["named-model"]);
    expect(required.Q09).toEqual(["native-engine"]);
    expect(required.Q15).toEqual(["actual-optimizer"]);
    expect(required.Q16).toContain("packaged-install");
    expect(EXECUTABLE_TIERS).toEqual(["deterministic", "isolated-server"]);
    for (const tier of TIERS.filter(tier => !EXECUTABLE_TIERS.includes(tier))) expect(() => assertExecutableTier(tier)).toThrow("GATED");
    expect(() => assertExecutableTier("live")).toThrow("Unknown tier");
    expect(matrixCoverage().every(row => row.status === "NOT_RUN")).toBe(true);
  });

  it("refuses receipts that overstate tier, outcome, identity or cost", () => {
    expect(validateReceipt(receipt())).toBeTruthy();
    expect(() => validateReceipt(receipt({ checks: [{ name: "x", status: "FAIL" }] }))).toThrow("failed check");
    expect(() => validateReceipt(receipt({ status: "FAIL" }))).toThrow("no failed check");
    expect(() => validateReceipt(receipt({ row: "Q08", scenario: MATRIX[7].scenario, tier: "isolated-server", tierLabel: TIER_LABEL["isolated-server"], satisfiesRequiredTier: true }))).toThrow("misstates");
    expect(() => validateReceipt(receipt({ tier: "named-model", tierLabel: TIER_LABEL["named-model"] }))).toThrow("executable");
    expect(() => validateReceipt(receipt({ tierLabel: "live model proof" }))).toThrow("executable");
    expect(() => validateReceipt(receipt({ cost: { known: true, amountUsd: 0.5, basis: "x" } }))).toThrow("known zero cost");
    expect(() => validateReceipt(receipt({ limitations: [] }))).toThrow("limitations");
    expect(() => validateReceipt(receipt({ candidate: { ...receipt().candidate, head: "HEAD" } }))).toThrow("candidate identity");
    expect(() => validateReceipt(receipt({ status: "BLOCKED" }))).toThrow("inconsistent");
    expect(() => validateReceipt(receipt({ tier: "isolated-server", tierLabel: TIER_LABEL["isolated-server"] }))).toThrow("engine binary identity");
    expect(validateReceipt(receipt({ row: "Q03", scenario: MATRIX[2].scenario, tier: "isolated-server", tierLabel: TIER_LABEL["isolated-server"], status: "BLOCKED", checks: [] })).status).toBe("BLOCKED");
  });

  it("stops a scenario on an unexpected setup status with a safe METHOD path HTTP status detail and no body", () => {
    const leaked = { status: 404, body: { error: "no such route", secret: "SECRET_BODY_CANARY" } };
    const failed = setupOutcome("persona-set", "PATCH", "/api/bots/bot-1", leaked, 200);
    expect(failed).toEqual({ check: { name: "persona-set", status: "FAIL", detail: "PATCH /api/bots/bot-1 HTTP 404" }, error: "setup failed: PATCH /api/bots/bot-1 HTTP 404" });
    expect(JSON.stringify(failed)).not.toContain("SECRET_BODY_CANARY");
    expect(setupOutcome(null, "POST", "/api/bots", { status: 500, body: "SECRET_BODY_CANARY" }, 201)).toEqual({ check: null, error: "setup failed: POST /api/bots HTTP 500" });
    expect(setupOutcome("room-created", "POST", "/api/groups", { status: 201, body: {} }, 201)).toEqual({ check: { name: "room-created", status: "PASS", detail: "POST /api/groups HTTP 201" }, error: null });
    // A readback condition fails the named check without aborting on an accepted status.
    expect(setupOutcome("paused-accepted", "POST", "/api/memory/action", { status: 200, body: {} }, 200, () => ({ ok: false, note: "action configure; mode active" })))
      .toEqual({ check: { name: "paused-accepted", status: "FAIL", detail: "POST /api/memory/action HTTP 200; action configure; mode active" }, error: null });
  });

  it("reports each join row BLOCKED naming its adapter module and export until that file exists", () => {
    for (const row of matrixCoverage()) {
      const server = MATRIX.find(item => item.id === row.row)!.server;
      if (!("adapter" in server)) continue;
      const present = existsSync(join(ROOT, server.adapter.module));
      expect(row.isolatedServer.status).toBe(present ? "ADAPTER_PRESENT" : "BLOCKED");
      expect(row.isolatedServer.adapter).toEqual({ module: server.adapter.module, export: server.adapter.export });
      if (!present) { expect(row.isolatedServer.reason).toContain(server.adapter.module); expect(row.isolatedServer.reason).toContain(server.adapter.export); }
    }
  });

  it("loads a join adapter only from an existing module with the named export and row", async () => {
    const spec = (MATRIX.find(row => row.id === "Q06")!.server as { adapter: AdapterSpec }).adapter;
    const parent = mkdtempSync(join(tmpdir(), "b34-adapter-contract-"));
    const place = (name: string, source: string) => { const root = join(parent, name); mkdirSync(dirname(join(root, spec.module)), { recursive: true }); writeFileSync(join(root, spec.module), source); return root; };
    try {
      expect(await loadAdapter(spec, join(parent, "missing"))).toEqual({ blocked: expect.stringContaining(`${spec.module} must export ${spec.export}`) });
      expect(await loadAdapter(spec, place("unrelated", "export const unrelated = 1;\n"))).toEqual({ blocked: expect.stringContaining("Adapter unusable") });
      expect(await loadAdapter(spec, place("wrong-row", `export const ${spec.export} = { row: "Q03", run: async () => ({}) };\n`))).toEqual({ blocked: expect.stringContaining("Adapter unusable") });
      const loaded = await loadAdapter(spec, place("valid", `export const ${spec.export} = { row: "Q06", run: async () => ({}) };\n`));
      expect("adapter" in loaded && loaded.adapter.row).toBe("Q06");
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it("accepts only complete adapter artifacts for distillation, index readiness and evaluator semantics", () => {
    for (const row of ["Q03", "Q06", "Q13", "Q14"] as const) expect(validateAdapterArtifacts(row, artifacts[row]()).row).toBe(row);
    const reject = (row: keyof typeof artifacts, mutate: (value: any) => void, message: string) => {
      const value: any = artifacts[row](); mutate(value);
      expect(() => validateAdapterArtifacts(row, value)).toThrow(message);
    };
    reject("Q03", value => { value.vitestResults = { passed: 9 }; }, "Adapter artifacts invalid");
    reject("Q03", value => { value.row = "Q06"; }, "Adapter artifacts invalid");
    reject("Q03", value => { value.refused = []; }, "Adapter artifacts invalid");
    reject("Q03", value => { value.distilled.pop(); }, "current correction was not distilled");
    reject("Q03", value => { value.reuse.match = "b34-q03 SHORT_CANARY (turn 3)"; }, "query carries the answer");
    reject("Q06", value => { delete value.readiness; }, "Adapter artifacts invalid");
    reject("Q06", value => { value.distractorSourceIds = ["src-old"]; }, "distractor");
    reject("Q06", value => { value.supplied.match = "b34-q06 CHARCOAL_CANARY (turn 4)"; }, "query carries the answer");
    reject("Q13", value => { value.budget.recovered.sourceIds = ["src-other"]; }, "deferred source");
    reject("Q14", value => { value.variants[0].heldout.untouched = false; }, "Adapter artifacts invalid");
    reject("Q14", value => { value.variants[0].budget.actualCostUsd = 0.25; }, "Adapter artifacts invalid");
    reject("Q14", value => { value.variants[0].heldout.candidate = 0; }, "skill variant: held-out candidate");
    reject("Q14", value => { value.variants[0].earlierTask.revisionAfterPublication = "rev-learned"; }, "earlier task");
    reject("Q14", value => { value.variants[0].nextTask.revision = "rev-base"; }, "next task");
    reject("Q14", value => { value.variants[1].rollback.nextTask.revision = ROUTINE.learned; }, "routine variant: rollback");
    // Contract v3: exactly one skill and one routine variant from separate reviews; routine revisions are distinct instruction-revision pairs.
    reject("Q14", value => { value.variants.pop(); }, "Adapter artifacts invalid");
    reject("Q14", value => { value.reviewId = "procedure-review:flat-v2-shape"; }, "Adapter artifacts invalid");
    reject("Q14", value => { value.variants[1] = { ...skillVariant(), reviewId: "procedure-review:other:ghi", receiptId: "fixture:3" }; }, "one skill variant and one routine variant");
    reject("Q14", value => { value.variants[1].reviewId = value.variants[0].reviewId; }, "separate reviews and receipts");
    reject("Q14", value => { const r = value.variants[1]; r.publication.baseRevision = "ins-base"; r.earlierTask.revisionAfterPublication = "ins-base"; r.earlierTask.revisionAfterRollback = "ins-base"; },
      "routine variant: routine revisions must be distinct [instructionRevision, updatedAt] pairs");
    reject("Q14", value => { const r = value.variants[1], same = pair("ins-learned", 300); r.rollback.toRevision = same; r.rollback.nextTask.revision = same; }, "routine revisions must be distinct");
    expect(routinePair(ROUTINE.base)).toEqual(["ins-base", 100]);
    for (const text of ["ins-base", "[\"ins-base\", 100]", "[\"\",1]", "[\"ins-base\",-1]", "[\"ins-base\",1.5]", "[\"ins-base\",1,2]"]) expect(routinePair(text), text).toBeNull();
  });

  it("requires one product readback per Q14 fact and refuses non-GET, non-/api and non-SELECT reads", () => {
    const q14 = (mutate: (value: any) => void) => { const value: any = artifacts.Q14(); mutate(value.variants[0]); return () => validateAdapterArtifacts("Q14", value); };
    expect(validateAdapterArtifacts("Q14", artifacts.Q14()).row).toBe("Q14");
    expect(q14(value => { delete value.readback; })).toThrow("Adapter artifacts invalid");
    expect(q14(value => { value.readback = []; })).toThrow("Adapter artifacts invalid");
    expect(q14(value => { value.readback.pop(); })).toThrow("Adapter artifacts invalid");
    expect(q14(value => { value.readback[6] = { ...value.readback[0] }; })).toThrow("exactly once");
    expect(q14(value => { delete value.budget.leaseCharge; })).toThrow("Adapter artifacts invalid");
    expect(q14(value => { value.readback[0].method = "POST"; })).toThrow("Adapter artifacts invalid");
    expect(q14(value => { value.readback[0].path = "/internal/bots/bot-1/skills/checked-method/history"; })).toThrow("Adapter artifacts invalid");
    expect(q14(value => { value.readback[3].path = "/api/desktop-secret"; value.readback[3].pointer = "/secret"; })).toThrow("Adapter artifacts invalid");
    expect(q14(value => { value.readback[3].pointer = ""; })).toThrow("Adapter artifacts invalid");
    expect(apiPathRefusal("/api/bots/../desktop")).not.toBeNull();
    expect(apiPathRefusal(HISTORY)).toBeNull();
    expect(apiPathRefusal("/api/routines")).toBeNull();
    for (const sql of [
      "UPDATE memory_scope_bindings SET intent=? WHERE id=?",
      "SELECT intent AS output FROM memory_scope_bindings WHERE id=?; DELETE FROM memory_scope_bindings WHERE id=?",
      "PRAGMA table_info(memory_scope_bindings)",
      "ATTACH DATABASE ? AS other",
      "SELECT ? AS output FROM memory_scope_bindings WHERE id=?",
      "SELECT 4000 AS output FROM memory_meta",
      "SELECT intent AS output FROM memory_scope_bindings WHERE id IN (SELECT id FROM memory_meta) AND subject_id=?",
      "SELECT intent AS output FROM memory_scope_bindings WHERE id=? UNION SELECT data_revision FROM memory_meta",
      "SELECT intent AS output FROM memory_scope_bindings WHERE id=? -- comment",
    ]) {
      expect(selectRefusal(sql), sql).not.toBeNull();
      expect(q14(value => { value.readback[6].sql = sql; }), sql).toThrow("Adapter artifacts invalid");
    }
    expect(selectRefusal(LEDGER_SQL)).toBeNull();
    expect(q14(value => { value.readback[6].params = [`extract-budget:${DAY}`]; })).toThrow("parameter count");
    expect(q14(value => { value.readback[6].params[1] = "16000"; })).toThrow("echoes a query parameter");
    expect(q14(value => { value.readback[6].column = "intent"; })).toThrow("selected output name");
    expect(q14(value => { value.readback[0].path = "/api/bots/bot-1/skills/rev-rollback/history"; })).toThrow("echoes the request path");
  });

  it("passes consistent skill and routine readback sets and fails a missing claim, refused re-read or any mismatch", () => {
    for (const v of artifacts.Q14().variants as any[]) {
      const pass = compareQ14Readbacks(v, consistent(v));
      expect(pass.map(check => check.name)).toEqual(Q14_READBACK_FACTS.map(fact => `q14-${v.publication.kind}-readback-${fact}`));
      expect(pass.filter(check => check.status !== "PASS")).toEqual([]);
    }
    const edit = editFor(skillVariant), contains = (text: string) => expect.stringContaining(text);
    expect(edit(evidence => { evidence.reread[0] = ok("rev-other"); })).toEqual([["q14-skill-readback-current-revision", contains("re-read differs from observed")]]);
    const invented: any = skillVariant(); invented.readback[1].observed = "rev-invented";
    expect(edit(() => {}, invented)).toEqual([["q14-skill-readback-published-revision-in-history", contains("observed differs from publication.publishedRevision")]]);
    expect(edit(evidence => { evidence.pins[4] = ok("rev-base"); })).toEqual([["q14-skill-readback-next-task-pin", contains("pinned revision differs from nextTask.revision")]]);
    expect(edit(evidence => { evidence.pins[3] = { ok: false, reason: "task bundle bytes do not match the pinned id" }; })).toEqual([["q14-skill-readback-earlier-task-pin", contains("do not match")]]);
    expect(edit(evidence => { evidence.reread[5] = { ok: false, reason: "HTTP 404" }; })).toEqual([["q14-skill-readback-post-rollback-task-pin", contains("HTTP 404")]]);
    expect(edit(evidence => { evidence.session = null; })).toEqual([["q14-skill-readback-budget-lease-charge", contains("session inside the inference lease missing")]]);
    expect(edit(evidence => { evidence.session = { reviewId: skillVariant().reviewId, grantId: "procedure-evaluation-grant:other" }; })).toEqual([["q14-skill-readback-budget-lease-charge", contains("another review or authority")]]);
    const missing: any = skillVariant(); missing.readback.splice(2, 1);
    expect(edit(() => {}, missing)).toEqual([["q14-skill-readback-rollback-history-entry", "missing claim"]]);
    const leaf: any = skillVariant(); leaf.readback[2].pointer = "/revisions/0/revision";
    expect(edit(() => {}, leaf)).toEqual([["q14-skill-readback-rollback-history-entry", contains("pointer does not address")]]);
    const routinePointer: any = skillVariant(); routinePointer.readback[0].pointer = "/routines/0/instructionRevision";
    expect(edit(() => {}, routinePointer)).toEqual([["q14-skill-readback-current-revision", contains("pointer does not address the skill current-revision field")]]);
    const via: any = skillVariant(); via.readback[6] = { fact: "budget-lease-charge", via: "api", method: "GET", path: "/api/memory/status", pointer: "/budget/output", observed: "16000" };
    expect(edit(() => {}, via)).toEqual([["q14-skill-readback-budget-lease-charge", contains("must be read through sqlite")]]);
  });

  it("binds the budget fact to the extract-budget ledger row through the runner's own query; another table's integer column fails", () => {
    const edit = editFor(skillVariant), contains = (text: string) => expect.stringContaining(text), name = "q14-skill-readback-budget-lease-charge";
    expect(compareQ14Readbacks(skillVariant() as any, consistent(skillVariant()))[6]).toEqual({ name, status: "PASS", detail: "sqlite memory_scope_bindings extract-budget $.output (column output): runner ledger query matches observed and budget.leaseCharge" });
    // Another table's integer column: a single-table SELECT whose re-read equals observed and leaseCharge, still FAIL.
    const other: any = skillVariant(); other.readback[6] = { fact: "budget-lease-charge", via: "sqlite", sql: "SELECT revision AS output FROM memory_sources WHERE id=?", params: ["source-1"], column: "output", observed: "16000" };
    expect(selectRefusal(other.readback[6].sql)).toBeNull();
    expect(validateAdapterArtifacts("Q14", { row: "Q14", variants: [other, routineVariant()] }).row).toBe("Q14");
    expect(edit(() => {}, other)).toEqual([[name, contains("not bound to the extract-budget ledger row in memory_scope_bindings")]]);
    for (const change of [
      { sql: "SELECT json_extract(intent,'$.input') AS output FROM memory_scope_bindings WHERE id=? AND subject_id=?" },
      { sql: "SELECT json_extract(intent,'$.output') AS output FROM memory_scope_bindings WHERE id=? OR subject_id=?" },
      { params: ["procedure-review:checked-method:abc", "procedure-review"] },
      { params: [`extract-budget:${DAY}`, "consolidation"] },
      { params: ["extract-budget:today", "extract-budget"] },
    ]) {
      const variant: any = skillVariant(); Object.assign(variant.readback[6], change);
      expect(ledgerBindingRefusal(variant.readback[6]), JSON.stringify(change)).not.toBeNull();
      expect(edit(() => {}, variant)).toEqual([[name, contains("not bound to the extract-budget ledger")]]);
    }
    expect(ledgerBindingRefusal(ledgerReadback() as any)).toBeNull();
    // Bound SQL alone never passes: the runner's own ledger query must exist, fall in the window and agree.
    expect(edit(evidence => { evidence.ledger = null; })).toEqual([[name, contains("runner query of the memory_scope_bindings extract-budget row missing")]]);
    expect(edit(evidence => { evidence.ledger = { ...evidence.ledger!, value: ok("15999") }; })).toEqual([[name, contains("differs from observed")]]);
    expect(edit(evidence => { evidence.ledger = { ...evidence.ledger!, value: { ok: false, reason: "0 ledger rows" } }; })).toEqual([[name, contains("failed (0 ledger rows)")]]);
    expect(edit(evidence => { evidence.ledger = { ...evidence.ledger!, windowDays: ["2026-09-16"] }; })).toEqual([[name, contains("outside the scenario window days")]]);
    const charge: any = skillVariant(); charge.budget.leaseCharge = "12000";
    expect(edit(() => {}, charge)).toEqual([[name, contains("observed differs from budget.leaseCharge")]]);
    // The adapter's own SQL re-read is not what the fact uses.
    expect(edit(evidence => { evidence.reread[6] = ok("1"); })).toEqual([]);
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`${BINDINGS_TABLE}; CREATE TABLE memory_sources(id TEXT PRIMARY KEY, revision INTEGER)`);
      db.prepare("INSERT INTO memory_sources VALUES(?,?)").run("source-1", 16000);
      expect(Number((db.prepare(other.readback[6].sql).get("source-1") as { output: number }).output)).toBe(16000);
      expect(readLedgerOutput(db, "source-1")).toEqual({ ok: false, reason: "0 ledger rows" });
      expect(readLedgerOutput(db, `extract-budget:${DAY}`)).toEqual({ ok: false, reason: "0 ledger rows" });
      const put = db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,0,'granted',?)");
      put.run(`extract-budget:${DAY}`, "scope-1", "extract-budget", JSON.stringify({ input: 900, output: 16000, minute: 1, calls: 3 }));
      put.run("consolidation:x", "scope-1", "consolidation", JSON.stringify({ output: 16000 }));
      expect(readLedgerOutput(db, `extract-budget:${DAY}`)).toEqual(ok("16000"));
      expect(readLedgerOutput(db, "consolidation:x")).toEqual({ ok: false, reason: "0 ledger rows" });
    } finally { db.close(); }
  });

  it("checks routine publication through the routine store, its history entries and routine task pins", () => {
    const edit = editFor(routineVariant), contains = (text: string) => expect.stringContaining(text);
    const current = "q14-routine-readback-current-revision", published = "q14-routine-readback-published-revision-in-history", rollback = "q14-routine-readback-rollback-history-entry";
    expect(edit(evidence => { evidence.siblings[0] = { ...evidence.siblings[0]!, updatedAt: ok("299") }; })).toEqual([[current, contains("updatedAt differs from rollback.toRevision")]]);
    expect(edit(evidence => { evidence.siblings[0] = { ...evidence.siblings[0]!, routineId: ok("routine-2") }; })).toEqual([[current, contains("not publication.artifactId")]]);
    expect(edit(evidence => { evidence.siblings[1] = { ...evidence.siblings[1]!, receiptId: ok("fixture:9") }; })).toEqual([[published, contains("evaluationReceiptId")]]);
    expect(edit(evidence => { evidence.siblings[1] = { ...evidence.siblings[1]!, author: ok("owner") }; })).toEqual([[published, contains("not the learned revision")]]);
    expect(edit(evidence => { evidence.siblings[1] = null; })).toEqual([[published, contains("not publication.artifactId")]]);
    expect(edit(evidence => { evidence.siblings[2] = { ...evidence.siblings[2]!, author: ok("owner") }; })).toEqual([[rollback, contains("not the rollback revision")]]);
    expect(edit(evidence => { evidence.siblings[2] = { ...evidence.siblings[2]!, entryId: ok("ins-learned") }; })).toEqual([[rollback, contains("not the rollback revision")]]);
    expect(edit(evidence => { evidence.pins[3] = ok("ins-learned"); })).toEqual([["q14-routine-readback-earlier-task-pin", contains("pinned revision differs from earlierTask.revisionAfterRollback instruction revision")]]);
    const skillShaped: any = routineVariant(); skillShaped.readback[0] = { ...skillShaped.readback[0], path: HISTORY, pointer: "/currentRevision" };
    expect(edit(() => {}, skillShaped)).toEqual([[current, contains("pointer does not address the routine current-revision field under GET /api/routines")]]);
    const wholePair: any = routineVariant(); wholePair.readback[0].observed = ROUTINE.rollback;
    expect(edit(() => {}, wholePair)).toEqual([[current, contains("observed differs from rollback.toRevision instruction revision")]]);
    expect(routineSiblingPointers("published-revision-in-history", "/routines/2/instructionHistory/4/id"))
      .toEqual({ routineId: "/routines/2/id", author: "/routines/2/instructionHistory/4/author", receiptId: "/routines/2/instructionHistory/4/evaluationReceiptId" });
    expect(routineSiblingPointers("rollback-history-entry", "/routines/0/instructionHistory/2/rollbackOf"))
      .toEqual({ routineId: "/routines/0/id", author: "/routines/0/instructionHistory/2/author", entryId: "/routines/0/instructionHistory/2/id" });
    expect(routineSiblingPointers("current-revision", "/routines/1/instructionRevision")).toEqual({ routineId: "/routines/1/id", updatedAt: "/routines/1/updatedAt" });
    expect(routineSiblingPointers("current-revision", "/currentRevision")).toBeNull();
  });

  it("keeps only the pointed scalar and resolves skill and routine task pins from content-addressed bundles", () => {
    const body = { bots: [{ tasks: [{ procedurePin: { schema: 1, bundleId: hex("a") } }] }], "a/b": { "c~d": 7 }, secret: "SECRET_BODY_CANARY" };
    expect(pointedValue(body, "/bots/0/tasks/0/procedurePin/bundleId")).toEqual({ ok: true, value: hex("a") });
    expect(pointedValue(body, "/a~1b/c~0d")).toEqual({ ok: true, value: "7" });
    expect(pointedValue(body, "/bots/0/tasks/0/procedurePin")).toMatchObject({ ok: false });
    expect(pointedValue(body, "/bots/1/tasks")).toMatchObject({ ok: false });
    expect(pointedValue(body, "")).toMatchObject({ ok: false });
    expect(JSON.stringify([pointedValue(body, "/bots/0/tasks/0/procedurePin"), pointedValue(body, "/bots/0/tasks")])).not.toContain("SECRET_BODY_CANARY");
    const dataDir = mkdtempSync(join(tmpdir(), "b34-task-pin-"));
    try {
      const bundle = JSON.stringify({ schema: 1, botId: "bot-1", threadId: "thread-1", imported: [{ name: "checked-method", revision: "rev-base", sha256: hex("b"), editable: true }] });
      const id = sha(bundle), directory = join(dataDir, "skill-state", "bot-1", "task-bundles", "thread-1");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${id}.json`), bundle);
      expect(resolveTaskPinRevision(dataDir, "thread-1", id, "skill", "checked-method")).toEqual({ ok: true, value: "rev-base" });
      expect(resolveTaskPinRevision(dataDir, "thread-2", id, "skill", "checked-method")).toMatchObject({ ok: false });
      expect(resolveTaskPinRevision(dataDir, "thread-1", id, "skill", "other-method")).toMatchObject({ ok: false });
      expect(resolveTaskPinRevision(dataDir, "thread-1", id, "routine", "checked-method")).toMatchObject({ ok: false });
      expect(resolveTaskPinRevision(dataDir, "thread-1", "not-a-bundle", "skill", "checked-method")).toMatchObject({ ok: false });
      // A routine run's task bundle pins routine.instructionRevision for routine.id (procedure-bundles.ts createProcedurePin).
      const routineBundle = JSON.stringify({ schema: 1, botId: "bot-1", threadId: "thread-4", imported: [], routine: { id: "routine-1", instructionRevision: "ins-base" } });
      const routineId = sha(routineBundle), routineDirectory = join(dataDir, "skill-state", "bot-1", "task-bundles", "thread-4");
      mkdirSync(routineDirectory, { recursive: true });
      writeFileSync(join(routineDirectory, `${routineId}.json`), routineBundle);
      expect(resolveTaskPinRevision(dataDir, "thread-4", routineId, "routine", "routine-1")).toEqual({ ok: true, value: "ins-base" });
      expect(resolveTaskPinRevision(dataDir, "thread-4", routineId, "routine", "routine-2")).toEqual({ ok: false, reason: "task bundle pins no instruction revision for the routine" });
      expect(resolveTaskPinRevision(dataDir, "thread-4", routineId, "skill", "routine-1")).toMatchObject({ ok: false });
      writeFileSync(join(directory, `${id}.json`), bundle.replace("rev-base", "rev-forg"));
      expect(resolveTaskPinRevision(dataDir, "thread-1", id, "skill", "checked-method")).toEqual({ ok: false, reason: "task bundle bytes do not match the pinned id" });
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it("requires runner-snapshotted lease sessions, ledger delta and per-session charges consistent with each receipt's callbacks", () => {
    const run = (reviews = REVIEWS(), before: Q14LeaseSnapshot | null = leaseBefore(), after: Q14LeaseSnapshot | null = leaseAfter()) => compareQ14LeaseEvidence(reviews, before, after);
    const statuses = (checks: ReturnType<typeof run>) => Object.fromEntries(checks.map(check => [check.name, check.status]));
    const [sessions, delta, attributable, refusal] = LEASE_CHECKS as [string, string, string, string];
    const routineCharges = chargesKey(routineVariant().reviewId);
    const all = run();
    expect(all.map(check => check.name)).toEqual(LEASE_CHECKS);
    expect(all.filter(check => check.status !== "PASS")).toEqual([]);
    expect(all[1]!.detail).toBe("memory_scope_bindings extract-budget output delta 16000, input delta 900; receipt callbacks expect output 16000");
    // The product today writes no per-callback charge or refusal rows: sessions and the ledger delta can pass; the charge facts fail naming the missing join.
    const today = leaseAfter(); today.charges = {};
    const current = run(undefined, undefined, today);
    expect(statuses(current)).toEqual({ [sessions]: "PASS", [delta]: "PASS", [attributable]: "FAIL", [refusal]: "FAIL" });
    expect(current[2]!.detail).toBe(LEASE_CHARGES_MISSING);
    expect(LEASE_CHARGES_MISSING).toContain("SP-Q14-LEASE-CHARGES");
    // An automatic extraction or grounding charge on the shared ledger during the window is not attributable.
    const extra = leaseAfter(); extra.ledger[DAY] = { input: 1500, output: 18000 };
    expect(statuses(run(undefined, undefined, extra))).toEqual({ [sessions]: "PASS", [delta]: "FAIL", [attributable]: "FAIL", [refusal]: "PASS" });
    // A double charge after the refusal and resume: one evaluation callback charged twice.
    const double = leaseAfter(); double.ledger[DAY] = { input: 1300, output: 18000 }; double.charges[routineCharges]!.evaluation = tally(3, 6000, 800);
    expect(statuses(run(undefined, undefined, double))).toEqual({ [sessions]: "PASS", [delta]: "FAIL", [attributable]: "FAIL", [refusal]: "FAIL" });
    // No budget refusal recorded: the refusal-then-resume path was not exercised.
    const unrefused = leaseAfter(); unrefused.charges[routineCharges]!.refusals = {};
    expect(run(undefined, undefined, unrefused)[3]).toMatchObject({ status: "FAIL", detail: expect.stringContaining("not exercised") });
    const incomplete = REVIEWS(); incomplete[1]!.complete = false;
    expect(run(incomplete)[3]).toMatchObject({ status: "FAIL" });
    // A session present before adapter.run, a receipt without callback counts, or changed learning settings fail.
    const existed = leaseBefore(); existed.sessions = { ...leaseAfter().sessions };
    expect(run(undefined, existed)[0]).toMatchObject({ status: "FAIL", detail: expect.stringContaining("skill existed before") });
    const noCounts = REVIEWS(); noCounts[0]!.metricCalls = null;
    expect(run(noCounts)[1]).toMatchObject({ status: "FAIL", detail: expect.stringContaining("lacks callback counts (skill)") });
    const fenced = REVIEWS(); fenced[1]!.learningRevision = 2;
    expect(run(fenced)[1]).toMatchObject({ status: "FAIL", detail: expect.stringContaining("learning settings changed after the routine review snapshot") });
    const otherAuthority = leaseAfter(); otherAuthority.charges[routineCharges]!.grantId = "procedure-evaluation-grant:other";
    expect(statuses(run(undefined, undefined, otherAuthority))).toMatchObject({ [attributable]: "FAIL", [refusal]: "FAIL" });
    // The delta sums extract-budget rows across a UTC day boundary.
    const split = leaseAfter(); split.day = "2026-09-16"; split.ledger = { [DAY]: { input: 500, output: 8000 }, "2026-09-16": { input: 400, output: 8000 } };
    expect(run(undefined, undefined, split).filter(check => check.status !== "PASS")).toEqual([]);
    expect(run(undefined, null).every(check => check.status === "FAIL")).toBe(true);
  });

  it("reads the lease snapshot from the product rows with SQL and invents nothing for missing tables", () => {
    const reviewId = skillVariant().reviewId, db = new DatabaseSync(":memory:"), empty = new DatabaseSync(":memory:");
    try {
      db.exec(`${BINDINGS_TABLE}; CREATE TABLE memory_learning_config(id INTEGER PRIMARY KEY, revision INTEGER, settings TEXT)`);
      const put = db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,0,'granted',?)");
      put.run(`extract-budget:${DAY}`, "scope-1", "extract-budget", JSON.stringify({ input: 900, output: 16000, minute: 1, calls: 3 }));
      put.run("extract-budget:not-a-day", "scope-1", "extract-budget", JSON.stringify({ input: 1, output: 1 }));
      put.run("consolidation:x", "scope-1", "consolidation", JSON.stringify({ input: 5, output: 5 }));
      put.run(sessionKey(reviewId), "scope-1", "procedure-evaluation-session", JSON.stringify({ schema: 1, reviewId, grantId: "procedure-evaluation-grant:skill", snapshotDigest: hex("c") }));
      put.run(chargesKey(reviewId), "scope-1", "procedure-evaluation-charges", JSON.stringify({ schema: 1, reviewId, grantId: "procedure-evaluation-grant:skill",
        evaluation: { calls: 2, input: 300, output: 4000 }, reflection: { calls: 1, input: 200, output: 8000 }, refusals: { "budget-exhausted": 1, "Not A Reason": 2 } }));
      db.prepare("INSERT INTO memory_learning_config VALUES(1,3,?)").run(JSON.stringify({ automaticFacts: false, automaticProcedures: true, outputLimit: 20000 }));
      expect(readQ14LeaseSnapshot(db, Date.parse(`${DAY}T23:59:59Z`))).toEqual({ day: DAY, ledger: { [DAY]: { input: 900, output: 16000 } }, learning: { revision: 3, outputLimit: 20000 },
        sessions: { [sessionKey(reviewId)]: { reviewId, grantId: "procedure-evaluation-grant:skill" } },
        charges: { [chargesKey(reviewId)]: { reviewId, grantId: "procedure-evaluation-grant:skill", evaluation: tally(2, 4000, 300), reflection: tally(1, 8000, 200), refusals: { "budget-exhausted": 1 } } } });
      expect(readQ14LeaseSnapshot(empty, Date.parse(`${DAY}T00:00:00Z`))).toEqual({ day: DAY, ledger: {}, learning: null, sessions: {}, charges: {} });
    } finally { db.close(); empty.close(); }
  });

  it("keeps the frozen 60 original answer cases and the separate 15-case Grok cohort distinct", () => {
    const corpusBytes = readFileSync(join(ROOT, "server/memory/testing/corpus.json"));
    expect(FROZEN_CORPUS_SHA256).toBe("7dc0a4d0690c002b62602518846b2768ed877e02505d93769f46dfc4e1fe236f");
    expect(createHash("sha256").update(corpusBytes).digest("hex")).toBe(FROZEN_CORPUS_SHA256);
    const sets = answerCaseSets();
    expect(sets.original).toEqual({ path: "server/memory/testing/corpus.json", sha256: FROZEN_CORPUS_SHA256, cases: 60, drivers: { claude: 15, codex: 15, fuigo: 15, "api-only": 15 } });
    expect(sets.additional).toEqual([{ path: "server/memory/testing/answer-cohorts.json", id: "grok-v1", driver: "grok", cases: 15, status: "PENDING_BOUNDED_NATIVE_EXECUTION" }]);
    const corpus = JSON.parse(corpusBytes.toString("utf8")) as { answerCases: Array<{ id: string; driver: string }> };
    const cohorts = JSON.parse(readFileSync(join(ROOT, "server/memory/testing/answer-cohorts.json"), "utf8")) as { cohorts: Array<{ cases: Array<{ id: string }> }> };
    const original = new Set(corpus.answerCases.map(item => item.id)), grok = cohorts.cohorts.flatMap(cohort => cohort.cases.map(item => item.id));
    expect(original.size).toBe(60);
    expect(new Set(grok).size).toBe(15);
    expect(grok.filter(id => original.has(id))).toEqual([]);
    expect(corpus.answerCases.some(item => item.driver === "grok")).toBe(false);
  });

  it("names no Pi or driver-count gap: all eighteen driver payload tests already run offline", () => {
    const source = readFileSync(join(ROOT, "scripts/b34-receipt-matrix.ts"), "utf8");
    const PI = "\\bpi(?:[ -]?(?:agent|coding[ -]agent|driver))?\\b", GAP = "\\b(?:gap|missing|unsupported|uncovered|not (?:yet )?(?:covered|wired|supported|run))\\b";
    const piGap = new RegExp(`${PI}[^\\n]{0,80}${GAP}|${GAP}[^\\n]{0,80}${PI}|\\b17\\b[^\\n]{0,40}(?:driver|payload)|seventeen`, "i");
    for (const sample of ["Pi agent payload gap", "PiAgent gap", "missing Pi driver coverage", "pi-coding-agent not yet wired", "uncovered: pi agent", "17 driver payload tests", "Seventeen drivers"]) expect(sample).toMatch(piGap);
    for (const sample of ["pinned task bundle missing", "api readback gap", "pipeline uncovered"]) expect(sample).not.toMatch(piGap);
    expect(source).not.toMatch(piGap);
    expect(MATRIX.find(row => row.id === "Q08")!.deterministic).toContain("server/harness/memory-adapter.test.ts");
  });
});
