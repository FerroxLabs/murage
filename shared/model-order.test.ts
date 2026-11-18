import { describe, expect, it } from "vitest";
import { orderModels, parseModelVersion, type ModelOrderRow } from "./model-order.ts";

export const screenshotRows: ModelOrderRow[] = [
  ["fable-5", 5], ["fable-5-1", 5], ["fable-5-2", 5],
  ["haiku-4-5", 2], ["haiku-5-5", 1], ["opus-5", 4], ["opus-5-5", 4],
  ["sonnet-5", 3], ["sonnet-5-5", 3],
].map(([name, priceTier]) => ({ id: `claude-${name}`, label: `Claude ${name}${name === "haiku-4-5" ? " (latest)" : ""}`, group: "Engine models", priceTier: Number(priceTier) }));

describe("SEAN 1114-MODEL-ORDER", () => {
  it("orders the exact Claude screenshot, newest families above the older divider", () => {
    const rows = orderModels(screenshotRows);
    expect(rows.map(row => row.id)).toEqual([
      "claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5",
      "claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5",
    ]);
    expect(rows.map(row => row.older)).toEqual([false, false, false, false, true, true, true, true, true]);
    expect(rows.at(-1)!.label).not.toContain("latest");
  });
  it("deduplicates ids per group and distinguishes Flux variants with the same published name", () => {
    const rows = orderModels([
      { id: "flux-pinned-claude-fable-5-1", label: "Claude Fable 5.1", group: "Flux pinned models" },
      { id: "flux-pinned-claude-fable-5-1", label: "Claude Fable 5.1", group: "Flux pinned models" },
      { id: "flux-pinned-claude-fable-5-1-thinking", label: "Claude Fable 5.1", group: "Flux pinned models" },
      { id: "flux-pinned-claude-fable-5-1", label: "Claude Fable 5.1", group: "Other account" },
    ]);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.slice(0, 2).map(row => row.label)).size).toBe(2);
    expect(rows[1]!.label).toContain("thinking");
  });
  it("keeps a live Codex-like engine order when most prices are absent, only correcting labels and duplicates", () => {
    const input = [
      { id: "gpt-6.1-sol", label: "Sol" }, { id: "gpt-6-astra", label: "Astra" },
      { id: "gpt-6-sol", label: "Sol (latest)" }, { id: "gpt-5.9-terra", label: "Terra", priceTier: 5 },
    ];
    expect(orderModels(input).map(row => row.id)).toEqual(input.map(row => row.id));
    expect(orderModels(input).every(row => !row.older)).toBe(true);
    // MAIN RULING 1114-MODEL-ORDER: concise distinguishing versions precede truncated names.
    expect(orderModels(input)[2]!.label).toBe("6 · Sol");
  });
  it("parses version numbers and variant families without a model-name table", () => {
    for (const [id, family, version] of [
      ["claude-fable-5-2", "claude-fable", [5, 2]], ["claude-opus-5-5", "claude-opus", [5, 5]],
      ["gpt-6.1-sol", "gpt-sol", [6, 1]], ["gpt-6-astra", "gpt-astra", [6]],
      ["gemini-4-argon-high", "gemini-argon", [4]], ["grok-4.7", "grok", [4, 7]],
    ] as const) expect(parseModelVersion(id)).toMatchObject({ family, version });
  });
  it("makes an unparseable id its own family, keeps unknown price rows after priced rows", () => {
    const rows = orderModels([
      { id: "unknown-a", label: "Unknown", priceTier: 3 }, { id: "unknown-b", label: "Unknown", priceTier: 4 },
      { id: "custom-x", label: "X" }, { id: "custom-z", label: "Z" },
    ]);
    expect(rows.map(row => row.id)).toEqual(["unknown-b", "unknown-a", "custom-x", "custom-z"]);
    expect(rows.every(row => !row.older)).toBe(true);
    expect(parseModelVersion("unknown-a").family).not.toBe(parseModelVersion("unknown-b").family);
  });
  it("is stable, immutable, idempotent, memoized by list, and independent of conversation history", () => {
    const input = screenshotRows.map(row => Object.freeze({ ...row }));
    const original = JSON.stringify(input);
    const output = orderModels(input);
    expect(orderModels(input)).toBe(output);
    expect(orderModels(input.map(row => ({ ...row })))).toEqual(output);
    expect(orderModels(output)).toEqual(output);
    expect(JSON.stringify(input)).toBe(original);
  });
  it("does not renew a stale latest mark when an older version moves into Favorites", () => {
    const result = orderModels([
      { id: "model-1", label: "Model 1 (latest)", group: "Favorites", familyScope: "engine", priceTier: 1, groupRank: 0 },
      { id: "model-2", label: "Model 2", group: "Engine models", familyScope: "engine", priceTier: 1, groupRank: 1 },
    ]);
    expect(result[0]).toMatchObject({ id: "model-1", label: "Model 1", older: true });
  });
  it("keeps distinguishing labels unique even if a provider supplied another row's derived name", () => {
    const result = orderModels([{ id: "a", label: "Model" }, { id: "b", label: "Model" }, { id: "c", label: "Model · a" }]);
    expect(new Set(result.map(row => row.label)).size).toBe(3);
  });
  it("orders same-version variants by price tier before label", () => {
    const result = orderModels([
      { id: "model-2-high", label: "A variant", priceTier: 1 },
      { id: "model-2-low", label: "Z variant", priceTier: 5 },
    ]);
    expect(result.map(row => row.id)).toEqual(["model-2-low", "model-2-high"]);
  });
  it("interleaves equal-version variants across families by descending price", () => {
    const rows = orderModels([
      { id: "model-2-high", label: "High", priceTier: 5 },
      { id: "model-2-low", label: "Low", priceTier: 1 },
      { id: "other-2", label: "Other", priceTier: 3 },
    ]);
    expect(rows.map(row => row.priceTier)).toEqual([5, 3, 1]);
  });
  it("keeps both the variant and billing account in combined duplicate labels", () => {
    const rows = orderModels(["model-2", "model-2-thinking"].flatMap(id => ["Personal", "Work"].map(account => ({
      id, label: "Model 2", identity: `${account}:${id}`, identityLabel: account,
    }))));
    expect(rows.map(row => row.label)).toEqual([
      "base · Personal · Model 2", "base · Work · Model 2",
      "thinking · Personal · Model 2", "thinking · Work · Model 2",
    ]);
  });
  it("keeps mixed bare, pinned and thinking distinctions concise", () => {
    const rows = orderModels([
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "flux-pinned-claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "flux-pinned-claude-fable-5-1-thinking", label: "Claude Fable 5.1" },
    ]);
    expect(rows.map(row => row.label)).toEqual([
      "direct · Claude Fable 5.1", "flux pinned · Claude Fable 5.1", "flux pinned thinking · Claude Fable 5.1",
    ]);
  });
  it("puts concise variant distinctions first for narrow picker rows", () => {
    const rows = orderModels([
      { id: "flux-pinned-claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "flux-pinned-claude-fable-5-1-thinking", label: "Claude Fable 5.1" },
    ]);
    expect(rows.map(row => row.label)).toEqual(["base · Claude Fable 5.1", "thinking · Claude Fable 5.1"]);
  });
  it("keeps newer older-section versions ahead when their price decreased", () => {
    const rows = orderModels([
      { id: "model-3", label: "Model 3", priceTier: 5 },
      { id: "model-2", label: "Model 2", priceTier: 1 },
      { id: "model-1", label: "Model 1", priceTier: 5 },
      { id: "other-2", label: "Other 2", priceTier: 4 },
      { id: "other-1", label: "Other 1", priceTier: 3 },
    ]);
    expect(rows.map(row => row.id)).toEqual(["model-3", "other-2", "other-1", "model-2", "model-1"]);
  });
  it("orders 500 rows in under 5 ms, including a cold list", () => {
    const input = Array.from({ length: 500 }, (_, i) => ({ id: `vendor-family${i % 50}-${Math.floor(i / 50) + 1}`, label: `Model ${i}`, priceTier: i % 5 + 1 }));
    const start = performance.now();
    const rows = orderModels(input);
    expect(performance.now() - start).toBeLessThan(5);
    expect(rows).toHaveLength(500);
  });
});
