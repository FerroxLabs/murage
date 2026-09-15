import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILT_IN_DRIVERS } from "../../drivers/builtIn.ts";
import { validateAnswerCohorts, validateCorpus } from "./contracts.ts";

// Contract checks only. No answer is generated and no Grok engine is contacted:
// this cohort remains pending until a named, root-authorised native run.
const corpusBytes = readFileSync(new URL("./corpus.json", import.meta.url));
const corpusSha256 = createHash("sha256").update(corpusBytes).digest("hex");
const corpus = validateCorpus(JSON.parse(corpusBytes.toString("utf8")));
const raw = JSON.parse(readFileSync(new URL("./answer-cohorts.json", import.meta.url), "utf8"));

describe("additional native answer cohorts over the frozen corpus", () => {
  it("adds Grok without altering the frozen corpus, its four answer cohorts or gold", () => {
    expect(corpusSha256).toBe("7dc0a4d0690c002b62602518846b2768ed877e02505d93769f46dfc4e1fe236f");
    expect(corpus.answerCases).toHaveLength(60);
    const doc = validateAnswerCohorts(corpus, corpusSha256, raw);
    const grok = doc.cohorts.find(cohort => cohort.driver === "grok")!;
    expect(grok.cases.map(c => c.queryId)).toEqual(Array.from({ length: 15 }, (_, i) => `exact-${String(20 + i).padStart(2, "0")}`));
    const kinds = new Set(BUILT_IN_DRIVERS.map(driver => driver.driverKind));
    for (const kind of grok.engineKinds) expect(kinds.has(kind)).toBe(true);
  });

  it("refuses a cohort bound to different corpus bytes", () => {
    expect(() => validateAnswerCohorts(corpus, "0".repeat(64), raw)).toThrow("frozen corpus bytes");
  });

  it("refuses changed gold, unfrozen rubric, non-gold source and duplicate identity", () => {
    const gold = structuredClone(raw); gold.cohorts[0].cases[0].requiredSource = "source-21";
    expect(() => validateAnswerCohorts(corpus, corpusSha256, gold)).toThrow();
    const rubric = structuredClone(raw); rubric.cohorts[0].cases[0].rubric = "Be friendly and confident.";
    expect(() => validateAnswerCohorts(corpus, corpusSha256, rubric)).toThrow("unfrozen rubric");
    const duplicate = structuredClone(raw); duplicate.cohorts[0].cases[1].id = "answer-00";
    expect(() => validateAnswerCohorts(corpus, corpusSha256, duplicate)).toThrow("duplicate answer case identity");
  });

  it("refuses an unbalanced cohort or a relabelled existing driver", () => {
    const short = structuredClone(raw); short.cohorts[0].cases.pop();
    expect(() => validateAnswerCohorts(corpus, corpusSha256, short)).toThrow("unbalanced");
    const relabel = structuredClone(raw); relabel.cohorts[0].driver = "fuigo";
    expect(() => validateAnswerCohorts(corpus, corpusSha256, relabel)).toThrow("already has a cohort");
  });
});
