import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { additionalNativeAnswerCohorts } from "./eval-memory.ts";
import { validateCorpus } from "../server/memory/testing/contracts.ts";

const bytes = readFileSync(new URL("../server/memory/testing/corpus.json", import.meta.url));
const corpus = validateCorpus(JSON.parse(bytes.toString("utf8")));
const document = JSON.parse(readFileSync(new URL("../server/memory/testing/answer-cohorts.json", import.meta.url), "utf8"));
it("reports the additional Grok cohort as wholly pending without changing the original sixty cases", () => {
  const before = JSON.stringify(corpus);
  const rows = additionalNativeAnswerCohorts(corpus, bytes, document);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: "grok-v1", driver: "grok", engineKinds: ["grok", "grokAgent"], required: 15, completed: 0, status: "PENDING_BOUNDED_NATIVE_EXECUTION" });
  expect(rows[0].cases).toEqual(document.cohorts[0].cases);
  expect(corpus.answerCases).toHaveLength(60); expect(JSON.stringify(corpus)).toBe(before);
});
it("binds the report to exact corpus bytes and rejects changed gold", () => {
  expect(() => additionalNativeAnswerCohorts(corpus, Buffer.concat([bytes, Buffer.from("\n")]), document)).toThrow("frozen corpus bytes");
  const changed = structuredClone(document); changed.cohorts[0].cases[0].requiredSource = "unrelated-source";
  expect(() => additionalNativeAnswerCohorts(corpus, bytes, changed)).toThrow("gold set");
});
