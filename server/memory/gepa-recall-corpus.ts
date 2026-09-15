import { z } from "zod";
import { selectMemoryEvidence } from "./relevance.ts";
import { memoryEvolutionFieldsSchema, type MemoryEvolutionFields } from "./evolution-policy.ts";
import type { ProcedureCorpus, ProcedureEvaluationCase, ProcedureEvaluatorOptions } from "./gepa-evaluator.ts";

const recordSchema = z.object({ id: z.string(), text: z.string(), similarity: z.number().finite() }).strict();
const querySchema = z.object({ query: z.string(), records: z.array(recordSchema), expected: z.array(z.string()), invariant: z.boolean() }).strict();
const groupSchema = z.object({ queries: z.array(querySchema).length(4) }).strict();

/** Each sample is one synthetic person's project/time group with four objective
 * checks. There are no canonical user memories or mutable oracle instructions. */
export function memoryRecallCorpus(): ProcedureCorpus {
  const group = (partition: string, index: number): ProcedureEvaluationCase => {
    const key = `${partition}-${index}`, reference = `reference_${partition}_${index}`;
    return { id: key, groups: { person: `person-${key}`, project: `project-${key}`, time: `time-${key}` }, expected: null, input: { queries: [
      { query: "Travel lodging", invariant: false, expected: ["route", "inn"], records: [
        { id: "route", text: `Rail itinerary for synthetic journey ${key}.`, similarity: 1 },
        { id: "inn", text: `Confirmed inn reservation for synthetic guest ${key}.`, similarity: 0.72 + index * 0.01 },
        ...[0, 1, 2].map(n => ({ id: `noise-${n}`, text: `Unrelated wallpaper catalogue ${key} ${n}.`, similarity: 0.64 - n * 0.01 + index * 0.003 })),
      ] },
      { query: "cobalt audit", invariant: false, expected: ["overview", "facet-a", "facet-b"], records: [
        { id: "overview", text: `Audit overview ${key}.`, similarity: 1 },
        { id: "facet-a", text: `Cobalt audit measurements ${key}.`, similarity: 0.2 },
        { id: "facet-b", text: `Cobalt audit calibration ${key}.`, similarity: 0.21 },
        ...Array.from({ length: 5 }, (_, n) => ({ id: `common-${n}`, text: `General audit stationery ${key} ${n}.`, similarity: 0.1 })),
      ] },
      { query: "finance variance", invariant: false, expected: ["variance"], records: [
        { id: "variance", text: `Variance reconciliation ${key}.`, similarity: 1 },
        ...Array.from({ length: 4 }, (_, n) => ({ id: `broad-${n}`, text: `Finance office stationery ${key} ${n}.`, similarity: 0.1 })),
        ...Array.from({ length: 7 }, (_, n) => ({ id: `other-${n}`, text: `Unrelated bicycle gearing ${key} ${n}.`, similarity: 0.1 })),
      ] },
      { query: `Where is \`${reference}\`?`, invariant: true, expected: ["literal"], records: [
        { id: "wrong", text: `An unrelated document ${key}.`, similarity: 1 },
        { id: "literal", text: `Saved ${reference} is in its synthetic folder.`, similarity: 0.01 },
      ] },
    ] } };
  };
  return { id: "memory-recall-groups", version: "1", groupBy: ["person", "project", "time"],
    train: [group("train", 0), group("train", 1)], validation: [group("validation", 2), group("validation", 3)], holdout: [group("holdout", 4), group("holdout", 5)] };
}

/** Calls the production optional-evidence selector; gold sets are fixed by the
 * corpus. This measures selection over frozen scores, not embedding quality. */
export function recallPolicyEvaluator(seed: MemoryEvolutionFields): ProcedureEvaluatorOptions["evaluate"] {
  return async (instruction, cases, signal) => {
    if (signal.aborted) throw Error("GEPA_CANCELLED");
    const parsed = memoryEvolutionFieldsSchema.safeParse((() => { try { return JSON.parse(instruction); } catch { return null; } })());
    if (!parsed.success || parsed.data.extraction.classificationGuidance !== seed.extraction.classificationGuidance) {
      return { evaluation: { outputs: cases.map(() => ({ error: "Only the bounded retrieval fields may change in this corpus." })), scores: cases.map(() => 0), trajectories: cases.map(() => ({ immutable: "classificationGuidance" })) }, hardPass: cases.map(() => false), costUsd: 0 };
    }
    const policy = { revision: "candidate", ...parsed.data };
    const results = cases.map(sample => {
      const { queries } = groupSchema.parse(sample.input);
      const checks = queries.map(query => {
        const selected = selectMemoryEvidence(query.query, query.records, policy).map(record => record.id);
        const wanted = new Set(query.expected), actual = new Set(selected);
        const correct = selected.filter(id => wanted.has(id)).length;
        const score = wanted.size + actual.size ? 2 * correct / (wanted.size + actual.size) : 1;
        return { query: query.query, records: query.records, selected, expected: query.expected, score, hardPass: !query.invariant || score === 1 };
      });
      return { checks, score: checks.reduce((sum, check) => sum + check.score, 0) / checks.length, hardPass: checks.every(check => check.hardPass) };
    });
    return { evaluation: { outputs: results.map(result => ({ selected: result.checks.map(check => check.selected), queryCount: result.checks.length })), scores: results.map(result => result.score), trajectories: results.map(result => ({ checks: result.checks })) }, hardPass: results.map(result => result.hardPass), costUsd: 0 };
  };
}
