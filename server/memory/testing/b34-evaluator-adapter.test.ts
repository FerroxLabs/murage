// B34 Q14 join adapter, Claude 4 lane evidence only (never a row receipt).
// The pure block checks the scripted evaluator against the product's own
// procedure corpus, objective and frozen sections, and the scripted controller's
// callback counting and receipt shape without a server. The journey runs the
// adapter the way Claude 5's runner v3 does (b34-adapter-harness.ts) on the
// isolated fake-engine server with the scripted loopback evaluator.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gepaCallNotStarted, isGepaCallNotStarted } from "../../gepa-worker.ts";
import { memoryExtractionMessages, memoryGroundingMessages } from "../extract.ts";
import type { ProcedureEvaluatorOptions } from "../gepa-evaluator.ts";
import { procedureFrozenSections, procedureOutcomeCorpus, procedureOutcomeEvaluator } from "../gepa-procedure-corpus.ts";
import { validateProcedureEvaluationReceipt, type ProcedureReviewSnapshot } from "../procedure-review.ts";
import { expectAllPass, ledgerBindingRefusal, readbackRefusal, runAdapterLikeRunner, validateAdapterArtifacts } from "./b34-adapter-harness.ts";
import type { Q14Readback } from "./b34-adapter-types.ts";
import { B34_EVALUATOR_INSTRUMENTATION, b34Q14Adapter } from "./b34-evaluator-adapter.ts";
import {
  B34_EVALUATION_PREFIX, B34_EXTRACTION_PREFIX, B34_GROUNDING_PREFIX, B34_Q14, B34_REFLECTION_PREFIX,
  b34ParseReflection, b34ReflectionPrompt, b34ScriptedCandidate, b34ScriptedEvaluate, b34ScriptedReport, readB34EvaluatorReviews, type B34Purpose,
} from "./b34-evaluator-runtime.ts";

type Kind = "skill" | "routine";
const SEEDS: ReadonlyArray<readonly [Kind, string]> = [["skill", B34_Q14.skillOriginal], ["routine", B34_Q14.routineBase]];
const signal = () => new AbortController().signal;
const UUID_A = "0b8f6a52-6c1e-4d8e-9a3b-1f2e3d4c5b6a", UUID_B = "7c9d0e1f-2a3b-4c5d-8e6f-7a8b9c0d1e2f";
const RUNNER_CHECKS = [
  "adapter-recorded-behavioural-checks", "adapter-artifacts-valid",
  ...(["skill", "routine"] as const).flatMap(kind => [
    `q14-${kind}-evaluator-receipt-recorded-by-runtime`, `q14-${kind}-budget-respected-at-known-zero-cost`, `q14-${kind}-publication-target-matches-review`,
    ...["current-revision", "published-revision-in-history", "earlier-task-pin", "next-task-pin", "post-rollback-task-pin", "rollback-history-entry", "budget-lease-charge"].map(fact => `q14-${kind}-readback-${fact}`),
  ]),
  "q14-lease-sessions-recorded-in-window", "q14-lease-ledger-delta-matches-receipt-callbacks", "q14-lease-charges-attributable-to-sessions", "q14-lease-budget-refusal-resume-no-double-charge",
];
const ADAPTER_CHECKS = [
  "q14-owner-enables-learned-skills", "q14-owner-learning-configured-before-reviews", "q14-skill-owner-approves-card", "q14-owner-selects-scripted-evaluator",
  "q14-owner-unselects-evaluator-after-reviews", "q14-skill-owner-rollback", "q14-routine-owner-rollback",
  "q14-scripted-evaluator-installed", "q14-skill-learned-through-owner-card", "q14-skill-earlier-task-pins-base", "q14-routine-earlier-run-pins-base",
  "q14-reviews-wait-without-selected-model", "q14-routine-review-targets-canonical-pair", "q14-skill-owner-preview-authorize", "q14-skill-heldout-bad-candidate-refused",
  "q14-skill-retry-evaluates-and-publishes-scoped", "q14-routine-owner-preview-authorize", "q14-routine-budget-refusal-on-first-callback",
  "q14-routine-resume-after-minute-publishes-instruction-only", "q14-lease-window-attributable", "q14-known-zero-cost-scripted-loopback-only",
  "q14-skill-next-task-pins-published", "q14-skill-rollback-restores-base", "q14-skill-post-rollback-task-pins-rollback", "q14-routine-next-run-uses-published",
  "q14-routine-rollback-restores-base-instruction", "q14-routine-post-rollback-run-uses-rollback", "q14-later-reviews-not-evaluated", "q14-final-readbacks-asserted",
];

/** Stand-in for the loopback transport: the same scripted answers, with its own answer counter. */
function scriptedTransport() {
  const hits: Record<B34Purpose, number> = { evaluation: 0, reflection: 0 };
  const systems: string[] = [];
  let refuseNext = false;
  const request = async (_source: string, messages: ReadonlyArray<Readonly<{ role: string; content: string }>>) => {
    systems.push(messages[0]!.content);
    const input = JSON.parse(messages[1]!.content) as { procedure: string; task: unknown };
    hits.evaluation++;
    return { text: JSON.stringify(b34ScriptedReport(input.procedure, input.task)), costUsd: null };
  };
  const reflect = async (prompt: string) => {
    if (refuseNext) { refuseNext = false; throw gepaCallNotStarted(); }
    const input = JSON.parse(prompt) as { b34Plan: "heldout-probe" | "improve"; instruction: string };
    hits.reflection++;
    return { text: `\`\`\`\n${b34ScriptedCandidate(input.b34Plan, input.instruction)}\n\`\`\``, costUsd: null };
  };
  return { hits, systems, request, reflect, refuseReflection: () => { refuseNext = true; } };
}
function snapshotFor(kind: Kind, requestId: string): ProcedureReviewSnapshot {
  return { requestId, scopeId: "scope-fixture", target: { kind, scopeId: "scope-fixture", ownerId: "bot-fixture", artifactId: kind === "skill" ? B34_Q14.skillName : UUID_A, baseRevision: "base-fixture", threadId: "thread-fixture", bundleId: "b".repeat(64) },
    evidenceDigest: "c".repeat(64), policyRevision: 1, deletionEpoch: 0, learningRevision: 2, evidence: [], outcomeBasis: "source-reported" };
}
function optionsFor(kind: Kind, seed: string, transport: ReturnType<typeof scriptedTransport>): ProcedureEvaluatorOptions {
  return { command: { executable: "/synthetic/worker", args: [], cwd: "/synthetic", expectedPythonVersion: "3.13.15" }, workerDigest: "a".repeat(64), evaluatorId: "fixture", seedInstruction: seed,
    corpus: procedureOutcomeCorpus(), budget: { totalUsd: null, evaluationPerCaseUsd: null, reflectionUsd: null, authorityReference: `grant-${kind}` },
    evaluate: procedureOutcomeEvaluator(seed, kind, transport.request), reflect: transport.reflect, assertCurrent: () => {} };
}

describe("B34 Q14 scripted evaluator script", () => {
  it("scores the seed and the held-out probe equally and the learned candidate higher under the production objective", async () => {
    for (const [kind, seed] of SEEDS) {
      const transport = scriptedTransport(), corpus = procedureOutcomeCorpus();
      const evaluate = procedureOutcomeEvaluator(seed, kind, transport.request);
      const probe = b34ScriptedCandidate("heldout-probe", seed), learned = b34ScriptedCandidate("improve", seed);
      const base = await evaluate(seed, corpus.holdout, signal()), bad = await evaluate(probe, corpus.holdout, signal()), good = await evaluate(learned, corpus.holdout, signal());
      expect(base.hardPass).toEqual([false]);
      expect(bad.hardPass).toEqual([false]);
      expect(bad.evaluation.scores).toEqual(base.evaluation.scores);
      expect(good.hardPass).toEqual([true]);
      expect(good.evaluation.scores).toEqual([1]);
      expect(transport.hits.evaluation).toBe(3);
      expect(transport.systems.every(system => system.startsWith(B34_EVALUATION_PREFIX))).toBe(true);
      for (const candidate of [probe, learned]) expect(procedureFrozenSections(candidate, kind)).toEqual(procedureFrozenSections(seed, kind));
      expect(probe).not.toContain(B34_Q14.learnedStep);
      expect(learned).toContain(B34_Q14.learnedStep);
      expect(b34ParseReflection(`\`\`\`\n${learned}\n\`\`\``)).toBe(learned);
      expect(JSON.parse(b34ReflectionPrompt("improve", seed))).toEqual({ b34Plan: "improve", instruction: seed });
    }
    expect(B34_Q14.routineBase).toBe(B34_Q14.routineBase.trim());
    expect(b34ScriptedCandidate("improve", B34_Q14.routineBase)).toBe(b34ScriptedCandidate("improve", B34_Q14.routineBase).trim());
    expect(() => b34ScriptedCandidate("improve", "no seed step here")).toThrow("B34_SEED_STEP_UNAVAILABLE");
    expect(() => b34ParseReflection("no envelope")).toThrow("B34_REFLECTION_ENVELOPE_INVALID");
  });

  it("recognises the product's own prompt families", () => {
    expect(memoryExtractionMessages("fixture source")[0]!.content.startsWith(B34_EXTRACTION_PREFIX)).toBe(true);
    expect(memoryGroundingMessages({ text: "a", quote: "a", claimType: "owner-statement", speaker: "owner", outcome: "recorded" })[0]!.content.startsWith(B34_GROUNDING_PREFIX)).toBe(true);
    // The reflection system prompt is inline in the leased evaluator bridge (procedure-evaluator.ts:107).
    expect(readFileSync(new URL("../procedure-evaluator.ts", import.meta.url), "utf8")).toContain(`content:"${B34_REFLECTION_PREFIX}`);
    expect(B34_EVALUATOR_INSTRUMENTATION).toContain("installB34EvaluatorRuntime");
  });

  it("counts callbacks per review across attempts and returns receipts the product gate validates or refuses", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "b34-q14-controller-"));
    try {
      // Skill review: attempt 1 is the measured held-out probe, refused by the product's receipt gate.
      const skill = scriptedTransport(), skillSnapshot = snapshotFor("skill", "procedure-review:skill:fixture"), skillOptions = optionsFor("skill", B34_Q14.skillOriginal, skill);
      const probe = await b34ScriptedEvaluate(dataDir, skillSnapshot, skillOptions, signal(), () => skill.hits);
      expect(probe.decision).toBe("accepted");
      expect(probe.heldout).toMatchObject({ untouched: true, cases: 1, baseline: 0, candidate: 0, regressions: 0 });
      expect(probe.accounting).toEqual({ costLimitUsd: null, actualCostUsd: 0, costKnown: true, authorityReference: "grant-skill", metricCalls: 2, reflectionCalls: 1 });
      expect(() => validateProcedureEvaluationReceipt(skillSnapshot, probe)).toThrow("PROCEDURE_HELDOUT_REJECTED");
      // Attempt 2 reuses the measured baseline: one reflection and one evaluation more, cumulative per review.
      const accepted = await b34ScriptedEvaluate(dataDir, skillSnapshot, skillOptions, signal(), () => skill.hits);
      expect(skill.hits).toEqual({ evaluation: 3, reflection: 2 });
      expect(accepted.id).toMatch(/^b34-scripted:[a-f0-9]{64}$/);
      expect(accepted.candidate).toBe(B34_Q14.skillOriginal.replace(B34_Q14.seedStep, B34_Q14.learnedStep));
      expect(accepted.heldout).toMatchObject({ baseline: 0, candidate: 1, regressions: 0 });
      expect(accepted.accounting).toEqual({ costLimitUsd: null, actualCostUsd: 0, costKnown: true, authorityReference: "grant-skill", metricCalls: 3, reflectionCalls: 2 });
      expect(accepted.evaluator).toBe(`b34-scripted-procedure-controller:${"a".repeat(64)}`);
      expect(accepted.corpusDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(validateProcedureEvaluationReceipt(skillSnapshot, accepted).decision).toBe("accepted");
      // A published review is never evaluated again, and a second review of the same kind is refused before any callback.
      for (const snapshot of [skillSnapshot, snapshotFor("skill", "procedure-review:skill:other")]) {
        const refused = await b34ScriptedEvaluate(dataDir, snapshot, skillOptions, signal(), () => skill.hits).catch((error: unknown) => error);
        expect(isGepaCallNotStarted(refused)).toBe(true);
      }
      expect(skill.hits).toEqual({ evaluation: 3, reflection: 2 });

      // Routine review: a lease refusal on the first callback is rethrown as the same not-started error and counts nothing.
      const routine = scriptedTransport(), routineSnapshot = snapshotFor("routine", "procedure-review:routine:fixture"), routineOptions = optionsFor("routine", B34_Q14.routineBase, routine);
      routine.refuseReflection();
      const notStarted = await b34ScriptedEvaluate(dataDir, routineSnapshot, routineOptions, signal(), () => routine.hits).catch((error: unknown) => error);
      expect(isGepaCallNotStarted(notStarted)).toBe(true);
      expect(routine.hits).toEqual({ evaluation: 0, reflection: 0 });
      const resumed = await b34ScriptedEvaluate(dataDir, routineSnapshot, routineOptions, signal(), () => routine.hits);
      expect(routine.hits).toEqual({ evaluation: 2, reflection: 1 });
      expect(resumed.candidate).toBe(B34_Q14.routineBase.replace(B34_Q14.seedStep, B34_Q14.learnedStep));
      expect(resumed.accounting).toMatchObject({ costKnown: true, actualCostUsd: 0, metricCalls: 2, reflectionCalls: 1 });
      expect(validateProcedureEvaluationReceipt(routineSnapshot, resumed).decision).toBe("accepted");

      const lines = readB34EvaluatorReviews(dataDir);
      expect(lines.filter(line => line.requestId === routineSnapshot.requestId).map(line => [line.event, line.phase ?? line.outcome, line.attempt])).toEqual([
        ["attempt", "threw", 1], ["callback", "reflect", 2], ["callback", "baseline", 2], ["callback", "candidate", 2], ["attempt", "returned", 2],
      ]);
      expect(lines.find(line => line.requestId === routineSnapshot.requestId && line.outcome === "threw")?.errorCode).toBe("GEPA_CALL_NOT_STARTED");
      expect(lines.filter(line => line.requestId === skillSnapshot.requestId && line.event === "callback").map(line => line.phase)).toEqual(["reflect-probe", "baseline", "candidate-probe", "reflect", "candidate"]);
      expect(lines.every(line => line.event !== "callback" || line.loopbackHit === true)).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps identifiers and readbacks inside the runner v3 rules", () => {
    expect(B34_Q14.skillName).toMatch(/^[a-z0-9-]+$/);
    expect(B34_Q14.skillName).not.toMatch(/secret|token|credential|password|api-?key/i);
    const evaluated = `evaluated:b34-scripted:${"f".repeat(64)}`;
    expect(evaluated.length).toBeLessThanOrEqual(200);
    const skillPath = `/api/bots/${UUID_A}/skills/${B34_Q14.skillName}/history?threadId=${UUID_B}`;
    const ledger: Q14Readback = { fact: "budget-lease-charge", via: "sqlite", sql: "SELECT json_extract(intent,'$.output') AS output FROM memory_scope_bindings WHERE id=? AND subject_id=?",
      params: ["extract-budget:2026-09-15", "extract-budget"], column: "output", observed: "34000" };
    const samples: Q14Readback[] = [
      { fact: "current-revision", via: "api", method: "GET", path: skillPath, pointer: "/currentRevision", observed: `rollback:${UUID_B}` },
      { fact: "published-revision-in-history", via: "api", method: "GET", path: skillPath, pointer: "/revisions/1/revision", observed: evaluated },
      { fact: "rollback-history-entry", via: "api", method: "GET", path: skillPath, pointer: "/current/rollbackOf", observed: UUID_B.replace("7c", "8d") },
      { fact: "earlier-task-pin", via: "api", method: "GET", path: "/api/bots?messages=0", pointer: "/bots/1/tasks/2/procedurePin/bundleId", observed: "e".repeat(64) },
      { fact: "current-revision", via: "api", method: "GET", path: "/api/routines", pointer: "/routines/0/instructionRevision", observed: UUID_B },
      { fact: "published-revision-in-history", via: "api", method: "GET", path: "/api/routines", pointer: "/routines/0/instructionHistory/1/id", observed: UUID_A },
      { fact: "rollback-history-entry", via: "api", method: "GET", path: "/api/routines", pointer: "/routines/0/instructionHistory/2/rollbackOf", observed: "d".repeat(64) },
      ledger,
    ];
    for (const sample of samples) expect(readbackRefusal(sample)).toBeNull();
    expect(ledgerBindingRefusal(ledger)).toBeNull();

    // One claim per fact, in the order the adapter returns them.
    const facts = ["current-revision", "published-revision-in-history", "rollback-history-entry", "earlier-task-pin", "next-task-pin", "post-rollback-task-pin", "budget-lease-charge"] as const;
    const claims = (entries: Q14Readback[]): Q14Readback[] => entries.map((entry, index) => ({ ...entry, fact: facts[index]! }));
    const pin = samples[3]!;
    const pair = (revision: string, at: number) => JSON.stringify([revision, at]);
    const variant = (kind: Kind, base: string, published: string, rolledBack: string, threads: readonly [string, string, string], readback: Q14Readback[]) => ({
      reviewId: `procedure-review:${kind}:${"1".repeat(64)}`, receiptId: `b34-scripted:${(kind === "skill" ? "2" : "3").repeat(64)}`, evaluator: `b34-scripted-procedure-controller:${"a".repeat(64)}`,
      heldout: { corpusDigest: "4".repeat(64), untouched: true, cases: 1, baseline: 0, candidate: 1, regressions: 0 },
      budget: { authorityReference: `procedure-evaluation-grant:${kind}`, costKnown: true, actualCostUsd: 0, leaseCharge: "34000" },
      publication: { kind, artifactId: kind === "skill" ? B34_Q14.skillName : UUID_A, baseRevision: base, publishedRevision: published },
      earlierTask: { threadId: threads[0], revisionAfterPublication: base, revisionAfterRollback: base },
      nextTask: { threadId: threads[1], revision: published },
      rollback: { fromRevision: published, toRevision: rolledBack, nextTask: { threadId: threads[2], revision: rolledBack } },
      readback,
    });
    const skillVariant = variant("skill", UUID_B.replace("7c", "8d"), evaluated, `rollback:${UUID_B}`, ["t-1", "t-2", "t-3"],
      claims([samples[0]!, samples[1]!, samples[2]!, pin, pin, pin, ledger]));
    const routineVariant = variant("routine", pair("d".repeat(64), 1), pair(UUID_A, 2), pair(UUID_B, 3), ["r-1", "r-1", "r-1"],
      claims([samples[4]!, samples[5]!, samples[6]!, pin, pin, pin, ledger]));
    expect(() => validateAdapterArtifacts("Q14", { row: "Q14", variants: [skillVariant, routineVariant] })).not.toThrow();
    // A routine's runs share its one conversation; a skill's tasks never do.
    expect(() => validateAdapterArtifacts("Q14", { row: "Q14", variants: [skillVariant, { ...routineVariant, nextTask: { ...routineVariant.nextTask, threadId: "r-2" } }] })).toThrow();
    expect(() => validateAdapterArtifacts("Q14", { row: "Q14", variants: [{ ...skillVariant, nextTask: { ...skillVariant.nextTask, threadId: "t-1" } }, routineVariant] })).toThrow();
    // The flat v2 artifact and a same-kind pair are refused.
    expect(() => validateAdapterArtifacts("Q14", { row: "Q14", ...skillVariant })).toThrow();
    expect(() => validateAdapterArtifacts("Q14", { row: "Q14", variants: [skillVariant, { ...skillVariant, reviewId: `${skillVariant.reviewId}x` }] })).toThrow();
  });
});

describe.skipIf(process.platform === "win32")("B34 Q14 evaluator adapter through the isolated server", () => {
  it("Q14: skill and routine evaluations publish, pin, refuse the held-out probe, refuse then resume the budget and roll back", async () => {
    const result = await runAdapterLikeRunner(b34Q14Adapter);
    expectAllPass(result);
    const passed = result.checks.filter(check => check.status === "PASS").map(check => check.name);
    for (const name of [...RUNNER_CHECKS, ...ADAPTER_CHECKS]) expect(passed.filter(item => item === name), name).toHaveLength(1);
    expect(result.checks.some(check => check.name === "scenario-completed")).toBe(false);
    expect(result.artifacts?.row).toBe("Q14");
    const variants = result.artifacts && result.artifacts.row === "Q14" ? result.artifacts.variants : [];
    expect(variants.map(item => item.publication.kind)).toEqual(["skill", "routine"]);
  }, 580_000);
});
