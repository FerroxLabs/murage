// F1-T4: the settings surface states each model's edit capability from the
// server's per-model record and never claims more than an edit will accept.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IMAGE_GENERATION_REFERENCE_MAX } from "../../shared/media-assets";
import { builtInImageCapabilities } from "../../shared/image-capabilities";
import { ImageSettingsView, imageModelCapability, imageModelCheckLines, imageModelLimits, imageModelOptionLabel, relativeTime, type ImageModel, type ImageSettingsSnapshot } from "./ImageSettings";
import { ImageLibraryView, libraryBlockLine, libraryPackLine } from "./ImageLibrary";

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
  it("never advertises more references than image generation's shared cap", () => {
    const inflated = imageModelCapability({ ...openRouterVerified, maxReferences: 40 });
    expect(inflated).toMatchObject({ kind: "edits", maxReferences: IMAGE_GENERATION_REFERENCE_MAX });
    expect(inflated.sentences.join(" ")).toContain(`Up to ${IMAGE_GENERATION_REFERENCE_MAX} reference images per edit.`);
    expect(inflated.sentences.join(" ")).not.toContain("40");
  });
  it("states a model's prompt budget, sizes and where the details came from", () => {
    expect(imageModelLimits(builtInImageCapabilities("flux", "flux-image-fast")!, "built-in")).toBe("Prompt budget: 2,000 characters. Sizes: Any width and height in multiples of 32, ratio 1:3 to 3:1, 65,536 to 4,194,304 pixels, longest side at most 4096. Model details: built in.");
    expect(imageModelLimits(builtInImageCapabilities("xai", "grok-imagine-image-2.0")!)).toBe("Prompt budget: 4,000 characters (Limit not published, Murage uses 4,000). Sizes: The provider's default size only.");
    const html = render(snapshot("flux", "flux", [{ ...openai, id: "flux-image", capabilities: builtInImageCapabilities("flux", "flux-image")! }], "flux-image"));
    expect(html).toContain("Prompt budget: 32,000 characters.");
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
    expect(html).toContain("Not checked yet.");
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
    expect(html).toContain("gpt-image-9: unavailable");
    expect(html).not.toContain("data-image-capability");
  });
  it("renders without a snapshot and without connections", () => {
    expect(render(null, "load")).toContain("Loading connections…");
    const html = render({ enabled: false, connections: [], selected: null, catalog: null });
    expect(html).toContain("No supported image connections are available.");
    expect(html).not.toContain("Image model");
  });
  it("claims no model capability on a keyless install, keeps enabling blocked and Refresh available (IMGSET1)", () => {
    // The user smoke's keyless fixture reaches exactly this snapshot: the server
    // lists no image connection, so there is no model to state a capability for.
    const html = render({ enabled: false, connections: [], selected: null, catalog: null });
    expect(html).not.toContain("data-image-capability");
    expect(html).not.toMatch(/Creates and edits images\.|Creates images only\.|Editing is unavailable with this model\.|This model cannot generate images here\./);
    expect(html).toMatch(/<input type="checkbox" [^>]*disabled=""/);
    expect(html).toMatch(/<button type="button"[^>]*>Refresh connections<\/button>/);
    expect(html).not.toMatch(/<button type="button"[^>]*disabled=""[^>]*>Refresh connections/);
  });
});

describe("model checks and the library (image generation v2 A.2, A.6, A.8)", () => {
  const hour = 60 * 60_000, now = 100 * 24 * hour;
  it("states the last check, marks a failed model and a model the key is not offered, never hiding either", () => {
    expect(relativeTime(now - 2 * hour, now)).toBe("2 hours ago");
    expect(imageModelCheckLines({ ...openai, availability: "verified", lastGoodAt: now - 2 * hour }, now)).toEqual(["Last worked 2 hours ago."]);
    expect(imageModelCheckLines({ ...openai, availability: "failed", lastGoodAt: now - 48 * hour, lastFailedAt: now - 5 * 60_000, lastError: "provider-error: HTTP 500" }, now))
      .toEqual(["Last check failed 5 minutes ago: provider-error: HTTP 500", "Last worked 2 days ago."]);
    expect(imageModelCheckLines({ ...flux, offeredToKey: false, status: { state: "degraded" } }, now)).toEqual(["Not offered to this key: Flux does not list it for this account.", "Flux reports: degraded."]);
    const failed = { ...openai, availability: "failed" as const, lastFailedAt: now, lastError: "down" };
    const html = renderToStaticMarkup(createElement(ImageSettingsView, { snapshot: snapshot("openai", "openai", [failed], "gpt-image-2"), busy: null, error: "", notice: "", onChange: () => {}, onRefresh: () => {}, onProbe: () => {} }));
    expect(html).toContain("gpt-image-2 · default · edits");
    expect(html).toContain('data-image-check="failed"');
  });
  it("offers the owner a check and the daily check, off by default, and the library behind a button", () => {
    const html = renderToStaticMarkup(createElement(ImageSettingsView, { snapshot: snapshot("openai", "openai", [openai], "gpt-image-2"), busy: null, error: "", notice: "", onChange: () => {}, onRefresh: () => {}, onProbe: () => {} }));
    expect(html).toContain("Check this model now");
    expect(html).toContain("Check the default model once a day");
    expect(html).not.toMatch(/checked=""[^>]*>\s*<span>Check the default model/);
    expect(html).toContain("Saved prompt blocks and reference packs");
    const older = renderToStaticMarkup(createElement(ImageSettingsView, { snapshot: snapshot("openai", "openai", [openai], "gpt-image-2"), busy: null, error: "", notice: "", onChange: () => {}, onRefresh: () => {} }));
    expect(older).not.toContain("Check this model now");
  });
  it("lists blocks and packs with scope, version and size", () => {
    expect(libraryBlockLine({ id: "b", name: "brand-lock", version: 3, chars: 14336, scope: "bot", botId: "x", botName: "Ada" })).toBe("Ada · v3 · 14,336 characters");
    expect(libraryPackLine({ id: "p", name: "hero-refs", version: 1, count: 10, scope: "workspace" })).toBe("Workspace · v1 · 10 images");
    const noop = () => {};
    const html = renderToStaticMarkup(createElement(ImageLibraryView, { snapshot: { blocks: [{ id: "b", name: "brand-lock", version: 2, chars: 40, scope: "workspace" }], packs: [] },
      open: { id: "b", text: "Identity" }, draft: { name: "", text: "" }, busy: false, error: "", notice: "",
      onView: noop, onClose: noop, onEdit: noop, onSaveVersion: noop, onDraft: noop, onAdd: noop, onDeleteBlock: noop, onDeletePack: noop }));
    expect(html).toContain("brand-lock"); expect(html).toContain("Workspace · v2 · 40 characters");
    expect(html).toContain("Save as a new version"); expect(html).toContain("Identity");
    expect(html).toContain("No saved reference packs yet.");
  });
});

describe("review round 2: size rules in the reader's language", () => {
  it("says every size rule through the catalogue, word for word with the server's English", async () => {
    const { imageSizeRuleWords } = await import("./ImageSettings");
    const shared = await import("../../shared/image-capabilities");
    for (const [provider, id] of [["openai", "gpt-image-2"], ["google", "gemini-3.1-flash-image"], ["xai", "grok-imagine-image-2.0"], ["openai", "gpt-image-1"]] as const) {
      const capabilities = shared.builtInImageCapabilities(provider, id)!;
      expect(imageSizeRuleWords(capabilities.sizeRule)).toBe(shared.describeSizeRule(capabilities.sizeRule));
    }
  });
});
