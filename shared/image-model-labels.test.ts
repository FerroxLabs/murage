// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 Settings pass, Search, images and dictation: the image model list names models in words, never by raw id
// (flux-image-gpt25-xhigh), a router label keeps the Grok spelling, and a size list reads once ("Sizes: 1024x1024.").
import { describe, expect, it } from "vitest";
import { FLUX_LEGACY_IDS, builtInImageCapabilities, describeSizeRule, fluxBuiltInModels, fluxImageModelLabel, parseFluxImageCatalogue } from "./image-capabilities";
import { imageModelLimits } from "../src/components/ImageSettings";

describe("image model names in words", () => {
  it("names each older Flux id by its family, quality and size", () => {
    expect(fluxImageModelLabel("flux-image-gpt25-xhigh")).toBe("GPT Image 2.5 Flare, extra high");
    expect(fluxImageModelLabel("flux-image-gpt25-max-xl")).toBe("GPT Image 2.5 Flare, max, wide (1536x1024)");
    expect(fluxImageModelLabel("flux-image-gpt25-sunburst-med")).toBe("GPT Image 2.5 Sunburst, medium");
    expect(fluxImageModelLabel("flux-image-gpt25")).toBe("GPT Image 2.5 Flare");
    expect(fluxImageModelLabel("flux-image-fast")).toBe("FLUX.2 (fast)");
    expect(fluxImageModelLabel("not-a-model")).toBeNull();
  });

  it("the built-in Flux list shows no row labelled with its own id", () => {
    const rows = fluxBuiltInModels();
    expect(rows.length).toBeGreaterThan(Object.keys(FLUX_LEGACY_IDS).length);
    for (const row of rows) expect(row.label, row.id).not.toBe(row.id);
    expect(rows.find(row => row.id === "flux-image-gpt25-xhigh")?.label).toBe("GPT Image 2.5 Flare, extra high");
  });

  it("a router row with no label, or one that repeats its id, gets Murage's name; a router label keeps the Grok spelling", () => {
    const catalogue = parseFluxImageCatalogue({ contract: 1, kind: "image-catalogue", data: [
      { id: "flux-image-gpt25-xhigh", label: "flux-image-gpt25-xhigh", operations: ["generate"] },
      { id: "flux-image-gpt25-high", operations: ["generate"] },
      { id: "flux-image-grok", label: "GRok Imagine", operations: ["generate"] },
    ] });
    expect(catalogue, "fixture parses").not.toBeNull();
    const label = (id: string) => catalogue!.entries.find(entry => entry.id === id)?.label;
    expect(label("flux-image-gpt25-xhigh")).toBe("GPT Image 2.5 Flare, extra high");
    expect(label("flux-image-gpt25-high")).toBe("GPT Image 2.5 Flare, high");
    expect(label("flux-image-grok")).toBe("Grok Imagine");
  });
});

describe("size list reads once", () => {
  it("a fixed list of sizes is just the sizes after Sizes:", () => {
    const caps = builtInImageCapabilities("flux", "flux-image-gpt25")!;
    expect(describeSizeRule(caps.sizeRule)).toBe("1024x1024, 1536x1024.");
    const limits = imageModelLimits(caps, "built-in");
    expect(limits).toContain("Sizes: 1024x1024, 1536x1024.");
    expect(limits).not.toMatch(/only these sizes/i);
  });
});
