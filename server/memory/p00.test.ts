import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { validateCorpus, requireMeasuredHit } from "./testing/contracts.ts";

const raw = JSON.parse(readFileSync(new URL("./testing/corpus.json", import.meta.url), "utf8"));
describe("P00 frozen evidence contract", () => {
  it("validates all 240 queries, 60 answer cases and twelve audit scenarios", () => {
    const corpus = validateCorpus(raw);
    expect(corpus.queries).toHaveLength(240);
    expect(corpus.sources.some(s => s.scope === "private-other")).toBe(true);
    expect(new Set(corpus.queries.flatMap(q => q.language ? [q.language] : []))).toEqual(new Set(["en", "th", "zh"]));
  });
  it("refuses a gold label that would reward a private disclosure", () => {
    const invalid = structuredClone(raw);
    invalid.queries[0].expected = ["source-00-private"];
    expect(() => validateCorpus(invalid)).toThrow("invalid expected evidence");
  });
  it("refuses missing evidence and zero-case fixtures", () => {
    expect(() => validateCorpus({ ...raw, queries: [] })).toThrow();
    const invalid = structuredClone(raw);
    invalid.queries[0].expected = ["nonexistent"];
    expect(() => validateCorpus(invalid)).toThrow("unknown source");
  });
  it("refuses noop or wrong-path timing results", () => {
    expect(() => requireMeasuredHit({ backend: "fts5", visited: 0, ids: [] }, "gold")).toThrow();
    expect(() => requireMeasuredHit({ backend: "fts5", visited: 3, ids: ["wrong"] }, "gold")).toThrow();
    expect(() => requireMeasuredHit({ backend: "fts5", visited: 3, ids: ["gold"] }, "gold")).not.toThrow();
  });
  it("pins model revision and required asset digests", () => {
    const m = JSON.parse(readFileSync(new URL("../../shared/memory-model-manifest.json", import.meta.url), "utf8"));
    expect(m.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(m.files.find((f: {path: string}) => f.path === "onnx/model_quantized.onnx")).toBeDefined();
    for (const f of m.files) expect(f.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
