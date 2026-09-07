import { z } from "zod";

export const families = ["exact-paraphrase", "temporal-corrections", "long-history", "privacy", "multilingual", "no-answer-negation"] as const;
const source = z.object({
  id: z.string().min(1), revision: z.number().int().nonnegative(), scope: z.string().min(1),
  threadId: z.string(), messageId: z.string(), role: z.enum(["user", "assistant", "tool"]),
  state: z.enum(["active", "superseded", "deleted"]), text: z.string().min(1), assertion: z.string(),
});
const query = z.object({
  id: z.string(), family: z.enum(families), query: z.string().min(1), allowedScopes: z.array(z.string()).min(1),
  expected: z.array(z.string()), forbidden: z.array(z.string()), abstain: z.boolean().optional(),
  language: z.enum(["en", "th", "zh"]).optional(), distractorCount: z.number().int().nonnegative().optional(),
});
const schema = z.object({
  version: z.literal(1), provenance: z.string(), sources: z.array(source), queries: z.array(query),
  answerCases: z.array(z.object({id: z.string(), driver: z.enum(["claude", "codex", "fuigo", "api-only"]), queryId: z.string(), requiredSource: z.string(), rubric: z.string()})),
  faultCases: z.array(z.string()),
  faultProtocols: z.array(z.object({ id: z.string(), preconditions: z.array(z.string()).min(1), operations: z.array(z.string()).min(1), expected: z.array(z.string()).min(1) })),
});
export type MemoryCorpus = z.infer<typeof schema>;

export function validateCorpus(input: unknown): MemoryCorpus {
  const corpus = schema.parse(input);
  const sources = new Map(corpus.sources.map(s => [s.id, s]));
  if (sources.size !== corpus.sources.length) throw new Error("duplicate source identity");
  if (new Set(corpus.queries.map(q => q.id)).size !== corpus.queries.length) throw new Error("duplicate query identity");
  if (corpus.queries.length !== 240 || families.some(f => corpus.queries.filter(q => q.family === f).length !== 40)) throw new Error("corpus must contain 40 queries per family");
  for (const q of corpus.queries) {
    if (q.abstain && q.expected.length) throw new Error("abstention has expected evidence");
    for (const id of [...q.expected, ...q.forbidden]) if (!sources.has(id)) throw new Error(`unknown source ${id}`);
    for (const id of q.expected) {
      const s = sources.get(id)!;
      if (!q.allowedScopes.includes(s.scope) || s.state !== "active" || q.forbidden.includes(id)) throw new Error(`invalid expected evidence ${q.id}`);
    }
  }
  if (corpus.answerCases.length !== 60) throw new Error("expected 60 answer cases");
  for (const driver of ["claude", "codex", "fuigo", "api-only"]) if (corpus.answerCases.filter(a => a.driver === driver).length !== 15) throw new Error("unbalanced answer drivers");
  for (const a of corpus.answerCases) if (!corpus.queries.find(q => q.id === a.queryId)?.expected.includes(a.requiredSource)) throw new Error("answer source not in query gold set");
  for (let n = 1; n <= 12; n++) if (!corpus.faultCases.some(f => f.startsWith(`F${String(n).padStart(2, "0")}-`))) throw new Error("missing audit scenario");
  if (corpus.faultProtocols.length !== 12 || new Set(corpus.faultProtocols.map(f => f.id)).size !== 12) throw new Error("missing fault protocols");
  return corpus;
}

/** The harness verifies evidence, not merely a fast successful function return. */
export function requireMeasuredHit(result: { backend: string; visited: number; ids: string[] }, expected: string) {
  if (!result.backend || result.visited < 1 || !result.ids.includes(expected)) throw new Error("benchmark did not exercise expected retrieval path");
}
