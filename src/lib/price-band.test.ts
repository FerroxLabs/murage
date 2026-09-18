import { describe, expect, it } from "vitest";

import snapshot from "../data/model-metadata.json";
import { modelMetadataUpdatedAt } from "./model-metadata.ts";
import { dollarOfTokens, priceBand, priceBandNote } from "./provider-model-picker.ts";

const band = (outputPerMillion: number) => priceBand({ outputPerMillion, source: "fixture", updatedAt: 1 });

describe("priceBand", () => {
  it("reproduces Sean's table (2026-09-18) from the published output rates", () => {
    // Every figure here is the `outputPerMillion` the committed snapshot
    // carries for that model — the assertion below re-reads them so a refresh
    // that moves a price is caught rather than silently re-banded.
    expect(band(0.6)).toBe("$"); // DeepSeek V4 Flash
    expect(band(5)).toBe("$$"); // Claude Haiku 4.5
    expect(band(6)).toBe("$$"); // Grok 4.6
    expect(band(10)).toBe("$$$"); // Claude Sonnet 5
    expect(band(15)).toBe("$$$"); // Claude Sonnet 4.6
    expect(band(25)).toBe("$$$$"); // Claude Opus 5
    expect(band(50)).toBe("$$$$$"); // Claude Fable 5.1
    expect(band(120)).toBe("$$$$$"); // GPT-5 Pro
    expect(band(600)).toBe("$$$$$"); // o1-pro
  });

  it("puts each named model in Sean's band using the snapshot's own number", () => {
    const models = snapshot.providers as Record<string, { models: Record<string, { outputPerMillion?: number }> }>;
    const rate = (provider: string, id: string) => models[provider]!.models[id]!.outputPerMillion!;
    expect(band(rate("anthropic", "claude-haiku-4-5"))).toBe("$$");
    expect(band(rate("anthropic", "claude-sonnet-5"))).toBe("$$$");
    expect(band(rate("anthropic", "claude-opus-5"))).toBe("$$$$");
    expect(band(rate("anthropic", "claude-fable-5-1"))).toBe("$$$$$");
  });

  it("holds exactly at each boundary", () => {
    expect(band(1.99)).toBe("$");
    expect(band(2)).toBe("$$");
    expect(band(9.99)).toBe("$$");
    expect(band(10)).toBe("$$$");
    expect(band(19.99)).toBe("$$$");
    expect(band(20)).toBe("$$$$");
    expect(band(39.99)).toBe("$$$$");
    expect(band(40)).toBe("$$$$$");
  });

  it("says nothing rather than something wrong when there is no number", () => {
    expect(priceBand(undefined)).toBe("Price unavailable");
    expect(band(Number.NaN)).toBe("Price unavailable");
    expect(band(-1)).toBe("Price unavailable");
    expect(band(0)).toBe("$");
  });

  it("never returns a band no one asked for", () => {
    const priced = Object.values(snapshot.providers as Record<string, { models: Record<string, { outputPerMillion?: number }> }>)
      .flatMap((provider) => Object.values(provider.models))
      .map((model) => model.outputPerMillion)
      .filter((value): value is number => typeof value === "number");
    expect(priced.length).toBeGreaterThan(500);
    for (const value of priced) expect(["$", "$$", "$$$", "$$$$", "$$$$$"]).toContain(band(value));
  });
});

describe("priceBandNote", () => {
  it("dates itself from the snapshot, once, for the whole list", () => {
    expect(priceBandNote(Date.parse("2026-09-18T00:00:00Z"))).toBe(
      "Bands are approximate, from published rates, September 2026",
    );
    expect(priceBandNote()).toBe(priceBandNote(modelMetadataUpdatedAt()));
  });
  it("still says the approximate part when it has no date", () => {
    expect(priceBandNote(Number.NaN)).toBe("Bands are approximate, from published rates");
  });
});

describe("dollarOfTokens", () => {
  it("restates the rate in tokens a dollar buys", () => {
    expect(dollarOfTokens({ outputPerMillion: 50, source: "f", updatedAt: 1 })).toBe("$1 ≈ 20K output tokens");
    expect(dollarOfTokens({ outputPerMillion: 25, source: "f", updatedAt: 1 })).toBe("$1 ≈ 40K output tokens");
    expect(dollarOfTokens({ outputPerMillion: 0.6, source: "f", updatedAt: 1 })).toBe("$1 ≈ 1.7M output tokens");
    expect(dollarOfTokens({ outputPerMillion: 600, source: "f", updatedAt: 1 })).toBe("$1 ≈ 1.7K output tokens");
  });
  it("offers nothing when there is no rate to restate", () => {
    expect(dollarOfTokens(undefined)).toBe("");
    expect(dollarOfTokens({ outputPerMillion: 0, source: "f", updatedAt: 1 })).toBe("");
    expect(dollarOfTokens({ inputPerMillion: 3, source: "f", updatedAt: 1 })).toBe("");
  });
});
