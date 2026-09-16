// B34 Q03/Q13 join adapters, Claude 4 lane evidence only (never a row receipt).
// The pure block checks the scripted extractor's frozen script against the
// adapter contract and the product's own prompt builders. The journeys run
// each adapter the way Claude 5's runner does (b34-adapter-harness.ts) on the
// isolated fake-engine server with the scripted loopback extractor.
import { describe, expect, it } from "vitest";
import { memoryExtractionMessages, memoryGroundingMessages, parseMemoryExtractionCandidates } from "../extract.ts";
import { expectAllPass, runAdapterLikeRunner, validateAdapterArtifacts } from "./b34-adapter-harness.ts";
import { b34Q03Adapter, b34Q13Adapter } from "./b34-extractor-adapter.ts";
import { B34_EXTRACTION_PREFIX, B34_GROUNDING_PREFIX, B34_Q03, B34_Q13, B34_SCRIPT, b34ScriptedExtraction, b34ScriptedGrounding, type B34RuleId } from "./b34-scripted-extractor.ts";

// relevance.ts:10 treats these query shapes as opaque references that candidates must contain verbatim.
const OPAQUE_REFERENCE = /`([^`\n]+)`|\bhttps?:\/\/[^\s<>]+|\b[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)+\b|\b[A-Z][A-Z\d]*-\d+\b|(?:\/[\w.-]+){2,}/u;
const OWNER_MESSAGES = [B34_Q03.factMessage, B34_Q03.temporaryMessage, B34_Q03.correctionMessage, B34_Q03.failedTurnMessage, B34_Q13.statement];
const MATCHES = [B34_Q03.question, B34_Q13.question, B34_Q13.followUp];
const CANARIES = [B34_Q03.staleCanary, B34_Q03.currentCanary, B34_Q13.canary];
const rule = (id: B34RuleId) => B34_SCRIPT.find(item => item.id === id)!;

describe("B34 scripted extractor script", () => {
  it("keeps canaries and matches inside the adapter contract", () => {
    expect(new Set(CANARIES).size).toBe(CANARIES.length);
    for (const canary of CANARIES) {
      expect(canary.length).toBeGreaterThanOrEqual(6);
      expect(canary.length).toBeLessThanOrEqual(120);
    }
    const sent = [...OWNER_MESSAGES, ...MATCHES];
    for (const match of MATCHES) {
      expect(match.length).toBeGreaterThanOrEqual(8);
      expect(match.length).toBeLessThanOrEqual(200);
      expect(OPAQUE_REFERENCE.test(match)).toBe(false);
      expect(sent.filter(text => text.includes(match))).toEqual([match]);
    }
    for (const text of sent) for (const canary of CANARIES) expect(text).not.toContain(canary);
    expect(B34_Q03.failedTurnReply).not.toMatch(/B34_/);
    expect(rule("q03-fact").text).toContain(B34_Q03.staleCanary);
    expect(rule("q03-correction").text).toContain(B34_Q03.currentCanary);
    expect(rule("q03-correction").text).not.toContain(B34_Q03.staleCanary);
    expect(rule("q13-fact").text).toContain(B34_Q13.canary);
    const refA = { id: "candidate:a", version: 1 }, refB = { id: "candidate:b", version: 1 };
    expect(() => validateAdapterArtifacts("Q03", { row: "Q03", extractorInstanceId: "b34-extractor",
      distilled: [{ record: refA, sourceIds: ["message:task:a"] }, { record: refB, sourceIds: ["message:task:b"] }],
      correction: { superseded: refA, current: refB }, refused: [{ sourceId: "message:failed:c", outcome: "failed" }],
      reuse: { match: B34_Q03.question, canary: B34_Q03.currentCanary }, staleWithheld: { match: B34_Q03.question, canary: B34_Q03.staleCanary } })).not.toThrow();
    expect(() => validateAdapterArtifacts("Q13", { row: "Q13", extractorInstanceId: "b34-extractor",
      budget: { sourceId: "message:main:a", deferredReason: "budget-exhausted", withheldWhileExhausted: { match: B34_Q13.question, canary: B34_Q13.canary },
        recovered: { record: refA, sourceIds: ["message:main:a"] } } })).not.toThrow();
  });

  it("answers the product's own extraction and grounding prompts deterministically", () => {
    expect(memoryExtractionMessages("fixture source")[0].content.startsWith(B34_EXTRACTION_PREFIX)).toBe(true);
    expect(memoryGroundingMessages({ text: "a", quote: "a", claimType: "owner-statement", speaker: "owner", outcome: "recorded" })[0].content.startsWith(B34_GROUNDING_PREFIX)).toBe(true);
    for (const item of B34_SCRIPT) {
      const source = `é earlier words ${item.trigger} later words`;
      const { candidates, rules } = b34ScriptedExtraction(source);
      expect(rules).toEqual([item.id]);
      expect(parseMemoryExtractionCandidates(source, JSON.stringify(candidates))).toHaveLength(1);
      // Owner statements are paraphrases, so the product grounds them (consolidate.ts:163); the others are exact quotes.
      expect(candidates[0].text !== candidates[0].quote).toBe(item.claimType === "owner-statement");
    }
    expect(OWNER_MESSAGES.map(text => b34ScriptedExtraction(text).rules)).toEqual([["q03-fact"], ["q03-temporary"], ["q03-correction"], [], ["q13-fact"]]);
    for (const text of [...MATCHES, "hello from fake claude", "Bash"]) expect(b34ScriptedExtraction(text).rules).toEqual([]);
    const owner = { claimType: "owner-statement", speaker: "owner", outcome: "recorded" };
    const fact = rule("q03-fact"), correction = rule("q03-correction"), temporary = rule("q03-temporary");
    expect(b34ScriptedGrounding({ ...owner, text: fact.text, quote: fact.trigger })).toEqual({ supported: true, rule: "q03-fact", previousClaim: false });
    expect(b34ScriptedGrounding({ ...owner, text: correction.text, quote: correction.trigger, previousClaim: fact.text }).supported).toBe(true);
    expect(b34ScriptedGrounding({ ...owner, text: correction.text, quote: correction.trigger }).supported).toBe(false);
    expect(b34ScriptedGrounding({ ...owner, text: correction.text, quote: correction.trigger, previousClaim: correction.text }).supported).toBe(false);
    expect(b34ScriptedGrounding({ ...owner, text: fact.text, quote: fact.trigger, previousClaim: fact.text }).supported).toBe(false);
    expect(b34ScriptedGrounding({ ...owner, speaker: "bot-1", text: fact.text, quote: fact.trigger }).supported).toBe(false);
    expect(b34ScriptedGrounding({ ...owner, text: temporary.text, quote: temporary.trigger }).supported).toBe(false);
    expect(b34ScriptedGrounding({ ...owner, text: "unknown", quote: "unknown" })).toEqual({ supported: false, rule: null, previousClaim: false });
  });
});

describe.skipIf(process.platform === "win32")("B34 Q03/Q13 adapters through the isolated server", () => {
  it("Q03: distilled owner correction reaches another task, the stale fact and failed-turn claim do not", async () => {
    const result = await runAdapterLikeRunner(b34Q03Adapter);
    expectAllPass(result);
    expect(result.artifacts?.row).toBe("Q03");
    expect(result.checks.map(check => check.name)).toEqual(expect.arrayContaining(["deterministic-extractor-selected", "no-runner-pinned-memory", "distillation-provenance",
      "correction-supersedes-with-history", "failure-outcomes-not-current-facts", "correction-reused-in-another-task", "superseded-fact-withheld"]));
  }, 240_000);

  it("Q13: exhausted processing budget defers learning, withholds it, then learns the source once", async () => {
    const result = await runAdapterLikeRunner(b34Q13Adapter);
    expectAllPass(result);
    expect(result.artifacts?.row).toBe("Q13");
    expect(result.checks.map(check => check.name)).toEqual(expect.arrayContaining(["deterministic-extractor-selected", "no-runner-pinned-memory", "distillation-provenance",
      "exhausted-budget-withheld-learning", "recovered-source-extracted-once"]));
  }, 300_000);
});
