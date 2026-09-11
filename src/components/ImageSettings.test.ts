// F1-T4: the settings surface states each model's edit capability from the
// server's per-model record and never claims more than an edit will accept.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IMAGE_REFERENCE_LIMITS } from "../../shared/media-assets";
import { ImageSettingsView, imageModelCapability, imageModelOptionLabel, type ImageModel, type ImageSettingsSnapshot } from "./ImageSettings";

const base = { availability: "unverified" as const, qualities: ["low", "medium", "high"], sizes: ["1024x1024"] };
const openai: ImageModel = { ...base, id: "gpt-image-2", label: "gpt-image-2", generate: true, edit: true, maxReferences: 4 };
const flux: ImageModel = { ...base, id: "flux-image-gpt2", label: "flux-image-gpt2", generate: true, edit: false, maxReferences: 0, editUnavailableReason: "Flux Router offers image generation only. It has no reference-edit contract." };
const xai: ImageModel = { ...base, id: "grok-imagine-image-2.0", label: "Grok Imagine Image 2.0", generate: true, edit: true, maxReferences: 4, qualities: ["low", "medium"], editQualities: [], sizes: [] };
const openRouterVerified: ImageModel = { ...base, id: "openai/gpt-image-2", label: "OpenAI: GPT Image 2", generate: true, edit: true, maxReferences: 4, availability: "catalog-listed" };
const openRouterUnverified: ImageModel = { ...openRouterVerified, edit: false, maxReferences: 0, editUnavailableReason: "Reference editing could not be verified on this model's pinned endpoint." };
const openRouterOther: ImageModel = { ...base, id: "google/gemini-image", label: "Google: Gemini Image", generate: true, edit: false, maxReferences: 0, availability: "catalog-listed", editUnavailableReason: "Reference editing is not enabled for this OpenRouter model." };
const vector: ImageModel = { ...base, id: "acme/vectors", label: "Acme Vectors", generate: false, edit: false, maxReferences: 0, availability: "catalog-listed", disabledReason: "A supported raster output format is not advertised by this adapter." };

const snapshot = (provider: string, connectionId: string, models: ImageModel[], model: string | null, defaultModel: string | null = models[0]?.id ?? null): ImageSettingsSnapshot => ({
  enabled: Boolean(model), connections: [{ id: connectionId, label: `${provider} label`, provider }],
  selected: model ? { connectionId, model } : null, catalog: { connectionId, provider, defaultModel, models },
});
const render = (value: ImageSettingsSnapshot | null, busy: "load" | "save" | null = null) =>
  renderToStaticMarkup(createElement(ImageSettingsView, { snapshot: value, busy, error: "", notice: "", onChange: () => {}, onRefresh: () => {} }));
const capabilityLine = (html: string) => html.match(/data-image-capability="([a-z]+)"[^>]*>([^<]*)</) ?? [];

describe("imageModelCapability", () => {
  it("states editing with the reference limit for models the adapter can edit", () => {
    expect(imageModelCapability(openai)).toEqual({ kind: "edits", maxReferences: 4, sentences: ["Creates and edits images.", "Up to 4 reference images per edit."] });
    expect(imageModelCapability({ ...openai, maxReferences: 1 }).sentences).toContain("One reference image per edit.");
  });
  it("never advertises more references than Murage's shared cap", () => {
    const inflated = imageModelCapability({ ...openRouterVerified, maxReferences: 16 });
    expect(inflated).toMatchObject({ kind: "edits", maxReferences: IMAGE_REFERENCE_LIMITS.maxCount });
    expect(inflated.sentences.join(" ")).toContain(`Up to ${IMAGE_REFERENCE_LIMITS.maxCount} reference images per edit.`);
    expect(inflated.sentences.join(" ")).not.toContain("16");
  });
  it("does not invent a reference count from an older server record", () => {
    const legacy = imageModelCapability({ ...openai, maxReferences: undefined });
    expect(legacy).toMatchObject({ kind: "edits", maxReferences: null });
    expect(legacy.sentences).toEqual(["Creates and edits images.", "The reference-image limit is checked when an edit runs."]);
    for (const bad of [0, -1, 2.5, Number.NaN] as const) expect(imageModelCapability({ ...openai, maxReferences: bad })).toMatchObject({ maxReferences: null });
  });
  it("gives the server's reason when editing is unavailable, and a plain fallback without one", () => {
    expect(imageModelCapability(flux)).toEqual({ kind: "generates", sentences: ["Creates images only.", "Flux Router offers image generation only. It has no reference-edit contract."] });
    expect(imageModelCapability(openRouterUnverified).sentences[1]).toBe("Reference editing could not be verified on this model's pinned endpoint.");
    expect(imageModelCapability(openRouterOther).sentences[1]).toBe("Reference editing is not enabled for this OpenRouter model.");
    expect(imageModelCapability({ ...flux, editUnavailableReason: "  " }).sentences).toEqual(["Creates images only.", "Editing is unavailable with this model."]);
    expect(imageModelCapability({ ...flux, editUnavailableReason: undefined }).sentences).toEqual(["Creates images only.", "Editing is unavailable with this model."]);
  });
  it("treats only the edit flag as support, never a stray reference count", () => {
    const inconsistent = imageModelCapability({ ...flux, maxReferences: 4 });
    expect(inconsistent.kind).toBe("generates");
    expect(inconsistent.sentences.join(" ")).not.toMatch(/edits images|reference images per edit/);
  });
  it("says when edits take no quality setting or a narrower one", () => {
    expect(imageModelCapability(xai).sentences).toEqual(["Creates and edits images.", "Up to 4 reference images per edit.", "Edits do not use the quality setting."]);
    expect(imageModelCapability({ ...openai, editQualities: ["low", "medium"] }).sentences).toContain("Edits accept these quality settings: low, medium.");
    expect(imageModelCapability({ ...openai, editQualities: ["low", "medium", "high"] }).sentences).toHaveLength(2);
  });
  it("keeps disabled reasons ahead of any capability claim", () => {
    expect(imageModelCapability(vector)).toEqual({ kind: "disabled", sentences: ["A supported raster output format is not advertised by this adapter."] });
    expect(imageModelCapability({ ...openai, generate: false })).toEqual({ kind: "disabled", sentences: ["This model cannot generate images here."] });
    expect(imageModelCapability({ ...openai, disabledReason: "Blocked." }).sentences).toEqual(["Blocked."]);
  });
});

describe("imageModelOptionLabel", () => {
  it("marks each model's capability in the dropdown", () => {
    expect(imageModelOptionLabel(openai, "gpt-image-2")).toBe("gpt-image-2 · default · edits");
    expect(imageModelOptionLabel(flux, "flux-image-gpt2")).toBe("flux-image-gpt2 · default · creates only");
    expect(imageModelOptionLabel(openRouterOther, "openai/gpt-image-2")).toBe("Google: Gemini Image · creates only");
    expect(imageModelOptionLabel(vector, null)).toBe("Acme Vectors · unavailable");
    expect(imageModelOptionLabel({ ...openai, generate: false }, null)).toBe("gpt-image-2 · unavailable");
  });
});

describe("ImageSettingsView", () => {
  it("shows OpenAI as create-and-edit with the shared reference cap", () => {
    const html = render(snapshot("openai", "openai", [openai], "gpt-image-2"));
    expect(capabilityLine(html)[1]).toBe("edits");
    expect(html).toContain("Creates and edits images. Up to 4 reference images per edit.");
    expect(html).toContain("gpt-image-2 · default · edits");
    expect(html).toContain("Account access has not been verified for this model.");
    expect(html).toContain("Editing is offered only when the selected model supports it.");
  });
  it("keeps Flux usable for generation while naming why editing is unavailable", () => {
    const html = render(snapshot("flux", "flux", [flux], "flux-image-gpt2"));
    expect(capabilityLine(html)[1]).toBe("generates");
    expect(html).toContain("Creates images only. Flux Router offers image generation only. It has no reference-edit contract.");
    expect(html).not.toContain("Creates and edits");
    expect(html).not.toContain("Choose an available model before enabling image requests.");
    expect(html).toMatch(/<input type="checkbox" [^>]*checked=""/);
    expect(html).not.toMatch(/<input type="checkbox" [^>]*disabled=""/);
  });
  it("shows the xAI edit contract without a quality setting", () => {
    const html = render(snapshot("xai", "xai", [xai], "grok-imagine-image-2.0", null));
    expect(html).toContain("Creates and edits images. Up to 4 reference images per edit. Edits do not use the quality setting.");
    expect(html).toContain("Grok Imagine Image 2.0 · edits");
    expect(html).not.toContain("Choose an Imagine model to use xAI.");
  });
  it("asks for an explicit Imagine choice on xAI when nothing is selected", () => {
    const html = render(snapshot("xai", "xai", [xai], null, null));
    expect(html).toContain("GPT Image 2 is not available on this connection. Choose an Imagine model to use xAI.");
    expect(html).not.toContain("data-image-capability");
    expect(html).toContain("Choose an available model before enabling image requests.");
  });
  it("reflects the OpenRouter endpoint check per model instead of a catalog-wide promise", () => {
    const models = [openRouterVerified, openRouterOther, vector];
    const verified = render(snapshot("openrouter", "openrouter", models, "openai/gpt-image-2"));
    expect(verified).toContain("Creates and edits images. Up to 4 reference images per edit.");
    expect(verified).toContain("OpenAI: GPT Image 2 · default · edits");
    expect(verified).toContain("Google: Gemini Image · creates only");
    expect(verified).toContain("Acme Vectors · unavailable");
    expect(verified).toContain("Listed by the provider. Account access is checked when a request runs.");
    expect(verified).toMatch(/<option value="acme\/vectors" disabled=""/);

    const other = render(snapshot("openrouter", "openrouter", models, "google/gemini-image"));
    expect(capabilityLine(other)[1]).toBe("generates");
    expect(other).toContain("Creates images only. Reference editing is not enabled for this OpenRouter model.");

    const unverified = render(snapshot("openrouter", "openrouter", [openRouterUnverified, openRouterOther], "openai/gpt-image-2"));
    expect(capabilityLine(unverified)[1]).toBe("generates");
    expect(unverified).toContain("Creates images only. Reference editing could not be verified on this model&#x27;s pinned endpoint.");
    expect(unverified).toContain("OpenAI: GPT Image 2 · default · creates only");
    expect(unverified).not.toContain("· edits");
  });
  it("shows a disabled model's reason and blocks enabling until an available model is chosen", () => {
    const html = render({ ...snapshot("openrouter", "openrouter", [vector, openRouterOther], null), enabled: false });
    expect(html).not.toContain("data-image-capability");
    expect(html).toContain("Choose an available model before enabling image requests.");
    expect(html).toMatch(/<input type="checkbox" [^>]*disabled=""/);
  });
  it("names a saved model that is no longer in the catalog as unavailable", () => {
    const html = render(snapshot("openai", "openai", [openai], "gpt-image-9"));
    expect(html).toContain("gpt-image-9 — unavailable");
    expect(html).not.toContain("data-image-capability");
  });
  it("renders without a snapshot and without connections", () => {
    expect(render(null, "load")).toContain("Loading connections…");
    const html = render({ enabled: false, connections: [], selected: null, catalog: null });
    expect(html).toContain("No supported image connections are available.");
    expect(html).not.toContain("Image model");
  });
});
