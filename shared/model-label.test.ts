import { describe, expect, it } from "vitest";

import { FLUX_MODELS } from "../server/flux-routing.ts";
import { FLUX_TIER_LABELS, bareModelId, fluxTierLabel, isDerivedLabel, resolveModelLabel, titleCaseModelId } from "./model-label.ts";

describe("the Flux tier table", () => {
  // shared/ may not import server/, so the table is mirrored. This is the
  // thing that stops the mirror drifting: a tier renamed in flux-routing.ts
  // and not here fails right there, instead of shipping a stale label.
  it("says exactly what server/flux-routing.ts says", () => {
    expect(FLUX_TIER_LABELS).toEqual(Object.fromEntries(FLUX_MODELS.map((row) => [row.id, row.label])));
    expect(FLUX_TIER_LABELS["flux-auto"]).toBe("Flux Auto");
  });
  it("answers for a tier and stays silent for anything else", () => {
    for (const row of FLUX_MODELS) expect(fluxTierLabel(row.id)).toBe(row.label);
    // A pinned route names a concrete model; it is title-cased, not tiered.
    expect(fluxTierLabel("flux-pinned-deepseek-flash-max")).toBe("");
    expect(fluxTierLabel("claude-opus-5")).toBe("");
  });
});

describe("bareModelId", () => {
  it("drops an engine qualifier and a vendor path", () => {
    expect(bareModelId("flux::flux-auto")).toBe("flux-auto");
    expect(bareModelId("llamacpp::qwen3.8-27b")).toBe("qwen3.8-27b");
    expect(bareModelId("meta-llama/llama-3.3-70b-instruct")).toBe("llama-3.3-70b-instruct");
    expect(bareModelId("claude-opus-5")).toBe("claude-opus-5");
  });
});

describe("titleCaseModelId", () => {
  it("renders Sean's example", () => {
    expect(titleCaseModelId("flux-pinned-deepseek-flash-max")).toBe("Flux Pinned Deepseek Flash Max");
  });
  it("leaves a word that is already capitalised alone", () => {
    expect(titleCaseModelId("MiniMax-M3")).toBe("MiniMax M3");
    expect(titleCaseModelId("llama-3.3-70b")).toBe("Llama 3.3 70b");
  });
  it("capitalises ASCII lowercase only, and leaves anything else as written", () => {
    // Deliberate: an unconditional toUpperCase() changes characters no rule
    // here understands ("ß" becomes "SS", "é" becomes "É"), and a model id is
    // somebody's identifier, not prose. Only a-z is touched.
    expect(titleCaseModelId("élan-v2")).toBe("élan V2");
    expect(titleCaseModelId("ßeta-1")).toBe("ßeta 1"); // not "SSeta 1"
    expect(titleCaseModelId("straße-1")).toBe("Straße 1"); // leading "s" IS a-z
  });
});

describe("isDerivedLabel", () => {
  it("rejects a label that is only the id", () => {
    expect(isDerivedLabel("flux-auto", "flux-auto")).toBe(true);
    expect(isDerivedLabel("flux::flux-auto", "flux-auto")).toBe(true);
    expect(isDerivedLabel("flux-pinned-deepseek-flash-max", "Flux Pinned Deepseek Flash Max")).toBe(true);
    expect(isDerivedLabel("claude-opus-5", "")).toBe(true);
    expect(isDerivedLabel("claude-opus-5", undefined)).toBe(true);
  });
  it("accepts a name a provider actually wrote", () => {
    expect(isDerivedLabel("gpt-4o", "GPT-4o")).toBe(false);
    expect(isDerivedLabel("claude-sonnet-4-6", "Claude Sonnet 4.6")).toBe(false);
  });
  it("calls a name that happens to equal the title-cased id derived, harmlessly", () => {
    // "Claude Opus 5" IS what title-casing claude-opus-5 produces, so this
    // cannot be told apart from the fallback. It does not matter: every later
    // step of the chain yields the same string, so the row reads identically.
    expect(isDerivedLabel("claude-opus-5", "Claude Opus 5")).toBe(true);
    expect(resolveModelLabel("claude-opus-5", { catalogLabel: "Claude Opus 5" })).toBe("Claude Opus 5");
  });
});

describe("resolveModelLabel", () => {
  it("prefers the provider's own name", () => {
    expect(resolveModelLabel("gpt-4o", { catalogLabel: "GPT-4o", metadataName: "Ignored" })).toBe("GPT-4o");
  });
  it("gives the Flux row the tier label the engine catalog already uses", () => {
    // The bug Sean saw: the Flux connection's catalog carries no name, so this
    // used to be the literal "flux-auto" sitting under a "Flux Auto" row.
    expect(resolveModelLabel("flux-auto", { catalogLabel: "flux-auto" })).toBe("Flux Auto");
    expect(resolveModelLabel("flux-fast", {})).toBe("Flux Fast");
    expect(resolveModelLabel("flux::flux-auto", { catalogLabel: "flux::flux-auto" })).toBe("Flux Auto");
  });
  it("falls to the bundled models.dev name before title-casing", () => {
    expect(resolveModelLabel("gpt-4o", { catalogLabel: "gpt-4o", metadataName: "GPT-4o" })).toBe("GPT-4o");
    // and title-cases only when nothing named it — the pinned-route case
    expect(resolveModelLabel("flux-pinned-deepseek-flash-max", { catalogLabel: "flux-pinned-deepseek-flash-max" })).toBe(
      "Flux Pinned Deepseek Flash Max",
    );
  });
  it("treats a title-cased label from an earlier pass as still unnamed", () => {
    // server/provider-connections.ts runs this chain without the snapshot, so
    // the renderer must be able to improve on its own fallback rather than
    // accept "Gpt 4o" as a name somebody chose.
    expect(resolveModelLabel("gpt-4o", { catalogLabel: "Gpt 4o", metadataName: "GPT-4o" })).toBe("GPT-4o");
  });
});
