// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { describe, expect, it } from "vitest";
import {
  FLUX_LEGACY_IDS, assembleImagePrompt, builtInImageCapabilities, exactTarget, fluxBuiltInModels, openRouterCapabilities, parseAspectRatio,
  parseFluxImageCatalogue, promptTooLongMessage, ratioLabel, resolveImageSize, sentModelFor, type SizeRule,
} from "./image-capabilities.ts";

const FREE16: SizeRule = { kind: "free", multiple: 16, minRatio: 1 / 3, maxRatio: 3, maxPixels: 8_294_400, maxEdge: 3840, minPixels: 655_360, experimentalAbovePixels: 3_686_400 };
const GEMINI: SizeRule = { kind: "ratioTier", ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"], tiers: ["1K", "2K", "4K"] };
const LIST: SizeRule = { kind: "list", sizes: ["1024x1024", "1536x1024"] };
const ok = (result: ReturnType<typeof resolveImageSize>) => { if (!result.ok) throw new Error(result.message); return result.size; };

describe("ratios", () => {
  it("parses W:H with whole numbers 1..64 and labels ratios simply", () => {
    expect(parseAspectRatio("9:16")).toMatchObject({ width: 9, height: 16 });
    expect(parseAspectRatio("0:1")).toBeNull(); expect(parseAspectRatio("65:1")).toBeNull(); expect(parseAspectRatio("1.91:1")).toBeNull();
    expect(ratioLabel(1 / 3)).toBe("1:3"); expect(ratioLabel(0.3333)).toBe("1:3"); expect(ratioLabel(16 / 9)).toBe("16:9"); expect(ratioLabel(3)).toBe("3:1");
  });
});

describe("resolveImageSize: free", () => {
  it("renders 9:16 large as legal portrait pixels in multiples of 16", () => {
    const size = ok(resolveImageSize(FREE16, { aspectRatio: "9:16", resolution: "large" }, "1024x1024"));
    expect(size.width! % 16).toBe(0); expect(size.height! % 16).toBe(0); expect(size.height!).toBeGreaterThan(size.width!);
    expect(size.width! / size.height!).toBeGreaterThanOrEqual(1 / 3); expect(size.width! * size.height!).toBeLessThanOrEqual(8_294_400);
    expect(Math.abs(size.width! / size.height! - 9 / 16) / (9 / 16)).toBeLessThan(0.03);
    expect(size).toMatchObject({ asked: "9:16 large", rendered: `${size.width}x${size.height}`, experimental: true });
    expect(size.exact).toBeUndefined();
  });
  it("refuses 1:8 on a 1:3 to 3:1 model, naming the nearest legal ratio", () => {
    const result = resolveImageSize(FREE16, { aspectRatio: "1:8" }, "1024x1024");
    expect(result).toEqual({ ok: false, message: expect.stringContaining("1:8 is outside this model's 1:3 to 3:1 range. The nearest it can do is 1:3.") });
    expect((result as { message: string }).message).toContain("Nothing was sent");
  });
  it("renders the clamped ratio and marks the crop for 1:8 with fit exact", () => {
    const size = ok(resolveImageSize(FREE16, { aspectRatio: "1:8", fit: "exact" }, "1024x1024"));
    expect(size.width! / size.height!).toBeCloseTo(1 / 3, 1); expect(size.exact).toEqual({ ratio: 1 / 8 });
  });
  it("keeps legal exact pixels and snaps 1080x1350 to the nearest legal render", () => {
    expect(ok(resolveImageSize(FREE16, { width: 1152, height: 2048 }, "1024x1024"))).toMatchObject({ width: 1152, height: 2048, rendered: "1152x2048" });
    const nearest = ok(resolveImageSize(FREE16, { width: 1080, height: 1350 }, "1024x1024"));
    expect(nearest.width! % 16 + nearest.height! % 16).toBe(0); expect(nearest.exact).toBeUndefined();
    const exact = ok(resolveImageSize(FREE16, { width: 1080, height: 1350, fit: "exact" }, "1024x1024"));
    expect(exact.exact).toEqual({ width: 1080, height: 1350, ratio: 0.8 }); expect(exact.asked).toBe("1080x1350");
  });
  it("accepts the legacy size field as width and height, and uses the default size when nothing is asked", () => {
    expect(ok(resolveImageSize(FREE16, { size: "1536x1024" }, "1024x1024"))).toMatchObject({ width: 1536, height: 1024 });
    expect(ok(resolveImageSize(FREE16, {}, "1024x1024"))).toMatchObject({ asked: "default", width: 1024, height: 1024 });
  });
  it("refuses mixed or malformed size fields plainly", () => {
    expect(resolveImageSize(FREE16, { aspectRatio: "9:16", width: 1024, height: 1024 }, "1024x1024").ok).toBe(false);
    expect(resolveImageSize(FREE16, { width: 1024 }, "1024x1024").ok).toBe(false);
    expect(resolveImageSize(FREE16, { width: 32, height: 1024 }, "1024x1024").ok).toBe(false);
    expect(resolveImageSize(FREE16, { size: "big" }, "1024x1024").ok).toBe(false);
  });
});

describe("resolveImageSize: ratioTier and list", () => {
  it("picks the nearest named ratio and the tier for the resolution", () => {
    expect(ok(resolveImageSize(GEMINI, { aspectRatio: "9:16", resolution: "large" }, "1024x1024"))).toMatchObject({ aspectRatio: "9:16", tier: "2K", rendered: "9:16 at 2K" });
    expect(ok(resolveImageSize(GEMINI, { resolution: "small" }, "1024x1024"))).toMatchObject({ aspectRatio: "1:1", tier: "1K" });
    expect(ok(resolveImageSize(GEMINI, {}, "1024x1024"))).toMatchObject({ aspectRatio: "1:1", tier: "1K" });
    expect(resolveImageSize(GEMINI, { aspectRatio: "1:8" }, "1024x1024")).toMatchObject({ ok: false, message: expect.stringContaining("The nearest it can do is 9:16") });
    expect(ok(resolveImageSize(GEMINI, { width: 1080, height: 1350 }, "1024x1024"))).toMatchObject({ aspectRatio: "4:5", tier: "2K" });
  });
  it("picks the nearest listed size by ratio then area and refuses a shape more than 3% off", () => {
    expect(ok(resolveImageSize(LIST, { aspectRatio: "3:2" }, "1024x1024"))).toMatchObject({ width: 1536, height: 1024 });
    const refused = resolveImageSize(LIST, { aspectRatio: "9:16" }, "1024x1024");
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("The nearest it can do is 1024x1024") });
    expect((refused as { message: string }).message).toContain('fit: "exact"');
    expect(ok(resolveImageSize(LIST, { aspectRatio: "9:16", fit: "exact" }, "1024x1024"))).toMatchObject({ width: 1024, height: 1024, exact: { ratio: 9 / 16 } });
    expect(ok(resolveImageSize({ kind: "list", sizes: [] }, {}, "1024x1024"))).toMatchObject({ sendsSize: false });
    expect(resolveImageSize({ kind: "list", sizes: [] }, { aspectRatio: "1:1" }, "1024x1024").ok).toBe(false);
  });
  it("computes the crop target from the real render", () => {
    expect(exactTarget({ ratio: 9 / 16 }, { width: 1024, height: 1024 })).toEqual({ width: 576, height: 1024 });
    expect(exactTarget({ width: 1080, height: 1350, ratio: 0.8 }, { width: 1088, height: 1344 })).toEqual({ width: 1080, height: 1350 });
  });
});

describe("quality and aliases", () => {
  const sunburst = builtInImageCapabilities("flux", "flux-image-gpt25-sunburst")!;
  const flare = builtInImageCapabilities("flux", "flux-image-gpt25")!;
  it("maps a base Flux id plus quality to its alias id and never sends quality with it", () => {
    expect(sentModelFor("flux-image-gpt25-sunburst", sunburst, "medium", "1024x1024")).toEqual({ ok: true, model: "flux-image-gpt25-sunburst-med", quality: "medium", sendQuality: false });
    expect(sentModelFor("flux-image-gpt25-sunburst", sunburst, undefined, "1024x1024")).toMatchObject({ model: "flux-image-gpt25-sunburst", quality: "high" });
    expect(sentModelFor("flux-image-gpt25-sunburst", sunburst, "high", "1536x1024")).toMatchObject({ model: "flux-image-gpt25-sunburst-xl" });
    expect(sentModelFor("flux-image-gpt25", flare, "high", "1536x1024")).toMatchObject({ model: "flux-image-gpt25-xl" });
    expect(sentModelFor("flux-image-gpt25", flare, "max", "1536x1024")).toMatchObject({ model: "flux-image-gpt25-max-xl" });
    expect(sentModelFor("flux-image-gpt25", flare, undefined, "1024x1024")).toMatchObject({ model: "flux-image-gpt25", quality: "medium" });
  });
  it("refuses a combination no alias serves, naming what exists", () => {
    expect(sentModelFor("flux-image-gpt25-sunburst", sunburst, "xhigh", "1536x1024")).toEqual({ ok: false, message: expect.stringContaining("exists only at quality high") });
    expect(sentModelFor("flux-image-gpt25-sunburst", sunburst, "max", "1024x1024")).toEqual({ ok: false, message: expect.stringContaining("low, medium, high, xhigh") });
  });
  it("sends quality as a parameter on OpenAI models", () => {
    expect(sentModelFor("gpt-image-2", builtInImageCapabilities("openai", "gpt-image-2")!, undefined, "1024x1024")).toEqual({ ok: true, model: "gpt-image-2", quality: "medium", sendQuality: true });
  });
  it("keeps every older Flux id as an alias with its fixed quality and size", () => {
    expect(FLUX_LEGACY_IDS["flux-image-gpt25-xhigh"]).toEqual({ base: "flux-image-gpt25", quality: "xhigh", size: "1024x1024" });
    expect(FLUX_LEGACY_IDS["flux-image-gpt25-max-xl"]).toEqual({ base: "flux-image-gpt25", quality: "max", size: "1536x1024" });
    const rows = fluxBuiltInModels();
    for (const id of ["flux-image", "flux-image-gpt25-high", "flux-image-gpt25-low", "flux-image-gpt25", "flux-image-gpt25-xhigh", "flux-image-gpt25-max", "flux-image-gpt25-xl", "flux-image-gpt25-max-xl",
      "flux-image-gpt25-sunburst-low", "flux-image-gpt25-sunburst-med", "flux-image-gpt25-sunburst", "flux-image-gpt25-sunburst-xhigh", "flux-image-gpt25-sunburst-xl", "flux-image-gpt2", "flux-image-gpt2-low",
      "flux-image-fast", "flux-image-nano-banana-2", "flux-image-lite"]) expect(rows.some(row => row.id === id)).toBe(true);
    expect(rows.find(row => row.id === "flux-image-gpt25-xhigh")).toMatchObject({ aliasOf: "flux-image-gpt25", capabilities: { qualities: ["xhigh"], sizeRule: { kind: "list", sizes: ["1024x1024"] } } });
    expect(rows.find(row => row.id === "flux-image-fast")!.capabilities).toMatchObject({ maxPromptChars: 2000, maxReferences: 0, sizeRule: { kind: "free", multiple: 32 } });
  });
});

describe("built-in tables", () => {
  it("states each direct provider's budget, sizes, references and delivery", () => {
    expect(builtInImageCapabilities("openai", "gpt-image-2")).toMatchObject({ maxPromptChars: 32000, maxReferences: 16, supports: { n: 10, background: false }, delivery: { stream: true }, sizeRule: { kind: "free" } });
    expect(builtInImageCapabilities("openai", "gpt-image-1")).toMatchObject({ sizeRule: { kind: "list", sizes: ["1024x1024", "1536x1024", "1024x1536"] }, supports: { background: true } });
    expect(builtInImageCapabilities("openai", "gpt-image-2.5-sunburst")).toMatchObject({ qualities: ["low", "medium", "high", "xhigh", "max"], supports: { background: true } });
    expect(builtInImageCapabilities("google", "gemini-3.1-flash-image")).toMatchObject({ maxReferences: 14, supports: { seed: true, n: 1 }, sizeRule: { kind: "ratioTier", tiers: ["512", "1K", "2K", "4K"] } });
    expect((builtInImageCapabilities("google", "gemini-3.1-flash-image")!.sizeRule as { ratios: string[] }).ratios).toContain("1:8");
    expect(builtInImageCapabilities("google", "gemini-3.1-flash-lite-image")).toMatchObject({ sizeRule: { tiers: ["1K"] } });
    expect(builtInImageCapabilities("xai", "grok-imagine-image-2.0")).toMatchObject({ maxPromptChars: 4000, promptBudgetNote: "Limit not published, Murage uses 4,000.", maxReferences: 4 });
    expect(builtInImageCapabilities("flux", "flux-image")).toMatchObject({ maxPromptChars: 32000, maxReferences: 4, delivery: { stream: true, streamEdits: false }, editTimeoutSeconds: 90 });
    expect(openRouterCapabilities("openai/gpt-image-2", ["1024x1024"], ["low"], 4, "png")).toMatchObject({ maxPromptChars: 32000 });
    expect(openRouterCapabilities("vendor/model", [], [], 0, "png")).toMatchObject({ maxPromptChars: 4000, promptBudgetSource: "default" });
  });
});

describe("Flux catalogue", () => {
  const entry = { id: "flux-image-gpt25-sunburst", label: "GPT Image 2.5 Sunburst", aliases: ["flux-image-gpt25-sunburst-med"], operations: ["generate", "edit"], maxPromptChars: 32000,
    sizeRule: { kind: "free", multiple: 16, minRatio: 0.3333, maxRatio: 3, maxPixels: 8294400, maxEdge: 3840, minPixels: 655360 }, qualities: ["low", "medium", "high", "xhigh"],
    qualityMode: "param", formats: ["png", "jpeg"], maxReferences: 16, supports: { edit: true, background: true, n: 10, compression: true }, delivery: { stream: true, jobs: true, keepaliveSeconds: 15 },
    status: { state: "ok", last_good_at: "2026-10-01T00:00:00Z" } };
  it("reads the contract body and ignores any other", () => {
    expect(parseFluxImageCatalogue({ data: [entry] })).toBeNull();
    expect(parseFluxImageCatalogue({ contract: 2, kind: "image-catalogue", data: [entry] })).toBeNull();
    const catalogue = parseFluxImageCatalogue({ contract: 1, kind: "image-catalogue", default_model: "flux-image-gpt25-sunburst", data: [entry] })!;
    expect(catalogue.defaultModel).toBe("flux-image-gpt25-sunburst");
    expect(catalogue.entries[0]).toMatchObject({ id: entry.id, aliases: entry.aliases, status: { state: "ok", lastGoodAt: "2026-10-01T00:00:00Z" },
      capabilities: { source: "catalogue", promptBudgetSource: "catalogue", maxReferences: 16, qualityMode: "param", supports: { n: 10, background: true }, delivery: { jobs: true, keepaliveSeconds: 15 } } });
  });
  it("skips malformed entries and keeps the built-in value for out-of-range fields", () => {
    const catalogue = parseFluxImageCatalogue({ contract: 1, kind: "image-catalogue", data: [{ id: "../evil" }, "row", { ...entry, id: "flux-image", maxReferences: 99, maxPromptChars: -5, supports: { n: 50 } }, entry, entry] })!;
    expect(catalogue.entries.map(item => item.id)).toEqual(["flux-image", "flux-image-gpt25-sunburst"]);
    expect(catalogue.entries[0]!.capabilities).toMatchObject({ maxReferences: 4, maxPromptChars: 32000, promptBudgetSource: "built-in", supports: { n: 1 } });
  });
  it("describes an unknown catalogue model conservatively", () => {
    const catalogue = parseFluxImageCatalogue({ contract: 1, kind: "image-catalogue", data: [{ id: "flux-image-new" }] })!;
    expect(catalogue.entries[0]).toMatchObject({ operations: ["generate"], capabilities: { maxPromptChars: 4000, supports: { edit: false, n: 1 }, formats: ["png"] } });
  });
});

describe("prompt budget", () => {
  it("assembles blocks, scene and an Avoid: line without cutting anything", () => {
    expect(assembleImagePrompt({ blocks: ["LOCK"], scene: " scene ", negative: "blur", nativeNegative: false })).toEqual({ prompt: "LOCK\n\nscene\n\nAvoid: blur", avoidLine: true });
    expect(assembleImagePrompt({ scene: "scene", negative: "blur", nativeNegative: true })).toEqual({ prompt: "scene", avoidLine: false });
  });
  it("states both numbers, the model and the way forward", () => {
    expect(promptTooLongMessage(12900, "flux-image-fast", 2000, ["flux-image", "flux-image-gpt25", "flux-image-gpt2", "x"]))
      .toBe("The prompt is 12,900 characters; flux-image-fast allows 2,000. Nothing was sent. Condense it (identity first, then camera, scene, and one short Avoid: line) and send it with condensed_from_chars, or choose a model with a larger budget: flux-image, flux-image-gpt25, flux-image-gpt2.");
    expect(promptTooLongMessage(200000, "m", 2000, [])).toContain("No other model on this connection takes that many.");
  });
});
