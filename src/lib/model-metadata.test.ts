import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import snapshot from "../data/model-metadata.json";
import {
  MODEL_METADATA_SOURCE,
  modelMetadataUpdatedAt,
  FLUX_AUTO_PRICE_LABEL,
  FLUX_TIER_BANDS,
  ROUTING_ALIAS_PRICE_LABEL,
  fillModelMetadata,
  fluxRoutePriceLabel,
  isRoutingAlias,
  lookupModelMetadata,
  providerHint,
} from "./model-metadata.ts";

const SNAPSHOT_PATH = fileURLToPath(new URL("../data/model-metadata.json", import.meta.url));
const FIELDS = ["name", "inputPerMillion", "outputPerMillion", "contextWindow", "vision", "tools", "reasoning"];

describe("the bundled snapshot", () => {
  it("parses and matches its schema", () => {
    expect(snapshot.format).toBe("murage.model-metadata");
    expect(snapshot.version).toBe(1);
    expect(snapshot.source.url).toBe("https://models.dev/api.json");
    expect(snapshot.source.license).toBe("MIT");
    expect(snapshot.source.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
    const providers = Object.entries(snapshot.providers as Record<string, { name: string; models: Record<string, Record<string, unknown>> }>);
    expect(providers.length).toBeGreaterThan(0);
    for (const [providerId, provider] of providers) {
      expect(typeof provider.name).toBe("string");
      for (const [modelId, model] of Object.entries(provider.models)) {
        expect(typeof model.name, `${providerId}/${modelId}`).toBe("string");
        expect(Object.keys(model).filter((key) => !FIELDS.includes(key)), `${providerId}/${modelId}`).toEqual([]);
        for (const key of ["inputPerMillion", "outputPerMillion", "contextWindow"]) {
          if (model[key] !== undefined) expect(typeof model[key], `${providerId}/${modelId}.${key}`).toBe("number");
        }
        for (const key of ["vision", "tools", "reasoning"]) {
          // Absent beats false: a flag is present only when upstream asserted it.
          if (model[key] !== undefined) expect(model[key], `${providerId}/${modelId}.${key}`).toBe(true);
        }
      }
    }
  });

  it("covers every provider models.dev knows, and stays a bundle rather than a download", () => {
    // Coverage first (Sean, 2026-09-18): an openai-compat connection can point
    // at any of these, so trimming to first-party vendors just moved the
    // "Price unavailable" problem somewhere less visible.
    expect(Object.keys(snapshot.providers).length).toBeGreaterThan(200);
    for (const preset of ["anthropic", "openai", "openrouter", "deepseek", "mistral", "groq", "xai"]) {
      expect(Object.keys(snapshot.providers), preset).toContain(preset);
    }
    // Still compiled into the renderer bundle, so nothing reads it at runtime
    // and nothing needs an electron-builder allow-list entry.
    expect(readFileSync(SNAPSHOT_PATH).byteLength).toBeLessThan(3_000_000);
  });

  it("dates its own prices", () => {
    expect(MODEL_METADATA_SOURCE).toBe("https://models.dev/api.json");
    expect(Number.isFinite(modelMetadataUpdatedAt())).toBe(true);
    expect(new Date(modelMetadataUpdatedAt()).toISOString().slice(0, 10)).toBe(snapshot.source.fetchedAt);
  });
});

describe("lookupModelMetadata", () => {
  it("resolves an engine model id exactly", () => {
    const match = lookupModelMetadata("claude-opus-5", "anthropic");
    expect(match?.tier).toBe("exact");
    expect(match?.provider).toBe("anthropic");
    expect(match?.metadata.name).toBe("Claude Opus 5");
    expect(typeof match?.metadata.outputPerMillion).toBe("number");
  });

  it("is case-insensitive on the id but not creative about it", () => {
    expect(lookupModelMetadata("CLAUDE-OPUS-5")?.modelId).toBe("claude-opus-5");
    expect(lookupModelMetadata("claude-opus")).toBeNull();
    expect(lookupModelMetadata("claude-opus-5-turbo-max")).toBeNull();
    expect(lookupModelMetadata("")).toBeNull();
  });

  it("normalises an engine qualifier and a pinned Flux route", () => {
    expect(lookupModelMetadata("flux::claude-opus-5")?.modelId).toBe("claude-opus-5");
    const pinned = lookupModelMetadata("flux-pinned-claude-opus-5");
    expect(pinned?.modelId).toBe("claude-opus-5");
    expect(pinned?.tier).toBe("normalised");
  });

  it("normalises one reasoning-effort suffix, because effort is not a price", () => {
    const high = lookupModelMetadata("gemini-3.8-flash-high", "google");
    const plain = lookupModelMetadata("gemini-3.8-flash", "google");
    expect(high?.modelId).toBe("gemini-3.8-flash");
    expect(high?.tier).toBe("normalised");
    expect(high?.metadata.outputPerMillion).toBe(plain?.metadata.outputPerMillion);
  });

  it("never prices a Flux routing alias", () => {
    for (const alias of ["flux-auto", "flux-fast", "flux-standard", "flux-reasoning", "flux::flux-auto"]) {
      expect(isRoutingAlias(alias), alias).toBe(true);
      expect(lookupModelMetadata(alias), alias).toBeNull();
    }
    expect(isRoutingAlias("flux-pinned-claude-opus-5")).toBe(false);
  });

  it("refuses an id several providers price differently, unless hinted", () => {
    // The same id is resold by several providers at different prices. With no
    // hint there is no single true answer, so there is no answer — a wrong
    // price is worse than no price.
    // openai/gpt-oss-20b: groq $0.30/M out, openrouter $0.13/M out (measured
    // in the committed snapshot, 2026-09-18).
    const id = "openai/gpt-oss-20b";
    expect(lookupModelMetadata(id)).toBeNull();
    const hinted = lookupModelMetadata(id, "groq");
    expect(hinted?.provider).toBe("groq");
    expect(typeof hinted?.metadata.outputPerMillion).toBe("number");
  });
});

describe("providerHint", () => {
  it("maps a connection preset onto the provider that sells it", () => {
    expect(providerHint("anthropic")).toBe("anthropic");
    expect(providerHint("xai")).toBe("xai");
  });
  it("gives a Flux connection no hint, because Flux resells several vendors", () => {
    expect(providerHint("flux")).toBeUndefined();
  });
  it("prefers an upstream provider the engine reported itself", () => {
    expect(providerHint("openrouter", "zai")).toBe("zai");
    expect(providerHint("openrouter", "not-a-provider")).toBe("openrouter");
  });
});

describe("fillModelMetadata", () => {
  it("fills a row that arrived with nothing", () => {
    const filled = fillModelMetadata({ label: "Claude Opus 5" }, "claude-opus-5", "anthropic");
    expect(filled.pricing?.source).toBe(MODEL_METADATA_SOURCE);
    expect(filled.pricing?.updatedAt).toBe(modelMetadataUpdatedAt());
    expect(typeof filled.pricing?.outputPerMillion).toBe("number");
    expect(typeof filled.contextWindow).toBe("number");
    expect(filled.capabilities?.tools).toBe(true);
  });

  it("does NOT override a live provider catalog", () => {
    // A live catalog is authoritative even when the snapshot is newer: the
    // provider is the only party that can quote its own price.
    const live = {
      label: "Claude Opus 5",
      contextWindow: 123_456,
      pricing: { inputPerMillion: 1, outputPerMillion: 2, source: "https://openrouter.ai/api/v1/models", updatedAt: 99 },
      capabilities: { vision: false as boolean | undefined, tools: true as boolean | undefined },
    };
    const filled = fillModelMetadata(live, "claude-opus-5", "anthropic");
    expect(filled.pricing).toEqual(live.pricing);
    expect(filled.contextWindow).toBe(123_456);
    expect(filled.capabilities?.vision).toBe(false);
  });

  it("fills only the capability the catalog left unsaid", () => {
    const filled = fillModelMetadata({ label: "Claude Opus 5", capabilities: { vision: false } }, "claude-opus-5", "anthropic");
    expect(filled.capabilities?.vision).toBe(false);
    expect(filled.capabilities?.tools).toBe(true);
  });

  it("maps vision from the input modalities and reasoning from the flag", () => {
    const vision = fillModelMetadata({ label: "" }, "claude-opus-5", "anthropic");
    expect(vision.capabilities?.vision).toBe(true);
    expect(vision.capabilities?.reasoning).toBe(true);
    // deepseek-chat carries no image input upstream, so vision stays unsaid
    const text = fillModelMetadata({ label: "" }, "deepseek-chat", "deepseek");
    expect(text.capabilities?.vision).toBeUndefined();
  });

  it("leaves a row it cannot resolve exactly as it was", () => {
    const row = { label: "flux-auto" };
    expect(fillModelMetadata(row, "flux-auto")).toEqual(row);
  });

  it("upgrades a raw id label with the models.dev name", () => {
    expect(fillModelMetadata({ label: "claude-opus-5" }, "claude-opus-5", "anthropic").label).toBe("Claude Opus 5");
  });

  it("names the honest label for a route that has no single price", () => {
    expect(ROUTING_ALIAS_PRICE_LABEL).toBe("Price varies by route");
  });
});

describe("the Flux routes' price cells", () => {
  it("spans the tiers for Flux Auto rather than picking one", () => {
    // flux-auto dispatches across fast..reasoning, so a single band would be a
    // fabrication. The span is the true statement.
    expect(FLUX_AUTO_PRICE_LABEL).toBe("$\u2013$$$");
    expect(fluxRoutePriceLabel("flux-auto")).toBe("$\u2013$$$");
    expect(fluxRoutePriceLabel("flux::flux-auto")).toBe("$\u2013$$$");
  });
  it("gives each fixed tier the band Sean stated for it", () => {
    expect(FLUX_TIER_BANDS).toEqual({ "flux-fast": "$", "flux-standard": "$$", "flux-reasoning": "$$$" });
    expect(fluxRoutePriceLabel("flux-fast")).toBe("$");
    expect(fluxRoutePriceLabel("flux-standard")).toBe("$$");
    expect(fluxRoutePriceLabel("flux-reasoning")).toBe("$$$");
  });
  it("says nothing about a model that is not a Flux route", () => {
    expect(fluxRoutePriceLabel("claude-opus-5")).toBe("");
    expect(fluxRoutePriceLabel("flux-pinned-claude-opus-5")).toBe("");
  });
});
