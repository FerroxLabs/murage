import { describe, expect, it } from "vitest";

import type { PublicProviderConnection, ProviderModel } from "../../shared/provider-connections.ts";
import { lookupModelMetadata } from "./model-metadata.ts";
import {
  type PickerEngine,
  type PickerModel,
  PRICE_UNKNOWN,
  isFluxRouterRow,
  isPriceUnknown,
  modelPriceLabel,
  orderedPickerModels,
  pickerKey,
  pickerModels,
} from "./provider-model-picker.ts";

function engine(options: PickerEngine["models"]["options"], overrides: Partial<PickerEngine> = {}): PickerEngine {
  return {
    instanceId: "claudeAgent",
    driverKind: "claudeAgent",
    displayName: "Claude",
    snapshot: { state: "available", authenticated: true },
    models: { default: options[0]?.id ?? "", options },
    ...overrides,
  };
}

function connection(models: ProviderModel[], overrides: Partial<PublicProviderConnection> = {}): PublicProviderConnection {
  return {
    id: "c1",
    preset: "flux",
    label: "Flux Router",
    enabled: true,
    revision: "r1",
    baseUrl: "https://api.fluxrouter.ai/v1",
    protocol: "openai",
    configured: true,
    state: "catalog-ready",
    catalog: { connectionId: "c1", models, stale: false, assurance: "catalog-only" },
    ...overrides,
  };
}

const fluxModel = (id: string, label = id): ProviderModel => ({
  connectionId: "c1",
  preset: "flux",
  id,
  label,
  enabled: true,
  chatEligible: true,
  capabilities: { chat: true },
  outputModalities: ["text"],
});

describe("pickerModels fills what the engine never sent", () => {
  it("gives an engine row a price, a context window and its capabilities", () => {
    // This is the whole bug: a Claude engine row arrives with a label and
    // nothing else, so the picker showed "Price unavailable" for a model whose
    // published rate has been the same all year.
    const [row] = pickerModels(engine([{ id: "claude-opus-5", label: "Claude Opus 5" }]), []);
    expect(row!.pricing?.source).toBe("https://models.dev/api.json");
    expect(row!.pricing?.outputPerMillion).toBe(25);
    expect(row!.contextWindow).toBeGreaterThan(100_000);
    expect(row!.capabilities).toEqual({ vision: true, tools: true, reasoning: true });
    expect(modelPriceLabel(row!)).toBe("$$$$");
  });

  it("leaves a local model unpriced, because it costs nothing per token", () => {
    const [row] = pickerModels(
      engine([{ id: "llamacpp::claude-opus-5", label: "claude-opus-5", localServer: "llama.cpp on seanbeast" }]),
      [],
    );
    // The id happens to resolve; pricing a model running on the user's own
    // hardware at Anthropic's rate would be a lie about their electricity bill.
    expect(lookupModelMetadata("llamacpp::claude-opus-5")).not.toBeNull();
    expect(row!.pricing).toBeUndefined();
    expect(row!.contextWindow).toBeUndefined();
  });

  it("does not overwrite a live catalog that already quoted a price", () => {
    const live = { ...fluxModel("claude-opus-5", "Claude Opus 5"), preset: "openrouter" as const,
      pricing: { inputPerMillion: 1, outputPerMillion: 4, source: "https://openrouter.ai/api/v1/models", updatedAt: 7 } };
    // openai-compat is the driver an OpenRouter connection actually attaches
    // to (shared/provider-engine.ts providerEngineProtocol).
    const rows = pickerModels(
      engine([], { instanceId: "openai-compat", driverKind: "openai-compat" }),
      [connection([live], { preset: "openrouter", label: "OpenRouter" })],
    );
    expect(rows[0]!.pricing).toEqual(live.pricing);
    expect(modelPriceLabel(rows[0]!)).toBe("$$");
  });

  it("fills a connection row the provider priced at nothing", () => {
    // Only openrouter's catalog carries prices, so an Anthropic connection's
    // rows arrive exactly as bare as an engine's do.
    const bare = { ...fluxModel("claude-opus-5", "Claude Opus 5"), preset: "anthropic" as const };
    const rows = pickerModels(
      engine([]),
      [connection([bare], { preset: "anthropic", protocol: "anthropic", label: "Anthropic" })],
    );
    expect(rows[0]!.pricing?.outputPerMillion).toBe(25);
    expect(rows[0]!.pricing?.source).toBe("https://models.dev/api.json");
    expect(rows[0]!.capabilities?.tools).toBe(true);
    expect(modelPriceLabel(rows[0]!)).toBe("$$$$");
  });

  it("labels the Flux connection's bare ids instead of showing them raw", () => {
    // Sean's screenshot: the Flux connection's /v1/models rows carry no name,
    // so `flux-auto` sat in the list beside the engine catalog's "Flux Auto".
    const rows = pickerModels(engine([]), [connection([fluxModel("flux-auto"), fluxModel("flux-pinned-deepseek-flash-max")])]);
    expect(rows.map((row) => row.label)).toEqual(["Flux Auto", "Flux Pinned Deepseek Flash Max"]);
  });
});

describe("modelPriceLabel", () => {
  it("shows a range for Flux Auto rather than a band it cannot justify", () => {
    const rows = pickerModels(engine([{ id: "flux-auto", label: "Flux Auto" }]), []);
    expect(modelPriceLabel(rows[0]!)).toBe("$–$$$");
    expect(rows[0]!.pricing).toBeUndefined();
  });
  it("gives a pinned Flux route the real band of the model it pins", () => {
    const rows = pickerModels(engine([{ id: "flux-pinned-claude-opus-5", label: "" }]), []);
    expect(modelPriceLabel(rows[0]!)).toBe("$$$$");
  });
});

describe("orderedPickerModels puts Flux Router first", () => {
  const row = (model: string, extra: Partial<PickerModel> = {}): PickerModel => ({
    key: pickerKey({ instanceId: "e", model }),
    selection: { instanceId: "e", model },
    label: model,
    group: "Engine models",
    provider: "Claude",
    ...extra,
  });
  const auto = row("flux-auto");
  const reasoning = row("flux-reasoning");
  const viaFlux = row("claude-opus-5", { provider: "flux", group: "Flux Router" });
  const other = row("gpt-5.4");
  const starred = row("claude-sonnet-5");

  it("leads with Flux Auto, then favourites, then the rest of Flux", () => {
    const ordered = orderedPickerModels([other, starred, reasoning, viaFlux, auto], "", [starred.key], []);
    expect(ordered.map((r) => r.selection.model)).toEqual([
      "flux-auto",
      "claude-sonnet-5", // starred: an explicit choice is never demoted
      // both are rank 2 (Flux); within a rank the pre-existing tie-break
      // stands — group name, then label — so "Engine models" precedes
      // "Flux Router". This rule reorders ranks, nothing inside one.
      "flux-reasoning",
      "claude-opus-5", // bought through a Flux connection
      "gpt-5.4",
    ]);
  });

  it("puts Flux above a recently used model from another provider", () => {
    const ordered = orderedPickerModels([other, reasoning], "", [], [other.key]);
    expect(ordered.map((r) => r.selection.model)).toEqual(["flux-reasoning", "gpt-5.4"]);
  });

  it("keeps a Flux row in the Flux rank even when it is also a recent", () => {
    // A row can match two rules at once. Flux must win, or a Flux model the
    // user just ran would be pushed BELOW the Flux models they have not — the
    // exact inversion this rule exists to prevent.
    const zzz = row("flux-zzz-last-by-label");
    const ordered = orderedPickerModels([zzz, reasoning], "", [], [zzz.key]);
    expect(ordered.map((r) => r.selection.model)).toEqual(["flux-reasoning", "flux-zzz-last-by-label"]);
    const recentFirst = orderedPickerModels([zzz, reasoning], "", [], [reasoning.key]);
    expect(recentFirst.map((r) => r.selection.model)).toEqual(["flux-reasoning", "flux-zzz-last-by-label"]);
  });

  it("counts both spellings of a Flux row", () => {
    expect(isFluxRouterRow(auto)).toBe(true);
    expect(isFluxRouterRow(row("flux::flux-auto"))).toBe(true);
    expect(isFluxRouterRow(viaFlux)).toBe(true);
    expect(isFluxRouterRow(other)).toBe(false);
  });

  it("still filters on the query before it orders", () => {
    expect(orderedPickerModels([auto, other], "gpt", [], []).map((r) => r.selection.model)).toEqual(["gpt-5.4"]);
  });
});

describe("how much of this repo's engine catalogs the snapshot can actually price", () => {
  // The production engine catalogs, id by id, as of 201bf422. Measured rather
  // than asserted at 100%: this records what the matching rule really achieves
  // so a regression in it shows up as a number moving, not as a vague feeling.
  const CATALOG: Array<[string, string | undefined]> = [
    ["claude-opus-4-6-thinking", "anthropic"], ["claude-sonnet-4-6", "anthropic"],
    ["gemini-3.1-pro-high", "google"], ["gemini-3.1-pro-low", "google"],
    ["gemini-3.6-flash-high", "google"], ["gemini-3.6-flash-low", "google"], ["gemini-3.6-flash-medium", "google"],
    ["gemini-3.7-flash-high", "google"], ["gemini-3.7-flash-low", "google"], ["gemini-3.7-flash-medium", "google"],
    ["gemini-3.8-flash-high", "google"], ["gemini-3.8-flash-low", "google"], ["gemini-3.8-flash-medium", "google"],
    ["gpt-oss-120b-medium", undefined],
    ["claude-fable-5-1", "anthropic"], ["claude-fable-5", "anthropic"], ["gpt-5.4", "openai"], ["sonnet", undefined],
    ["claude-haiku-4-5", "anthropic"], ["claude-opus-5", "anthropic"], ["claude-sonnet-5", "anthropic"],
    ["gpt-5.3-codex-spark", "openai"], ["gpt-5.4-mini", "openai"], ["gpt-5.5", "openai"],
    ["gpt-5.6-luna", "openai"], ["gpt-5.6-sol", "openai"], ["gpt-5.6-terra", "openai"], ["gpt-6-astra", "openai"],
    ["grok-3-mini", "xai"], ["grok-4-fast", "xai"], ["grok-4", "xai"],
    ["MiniMax-M2.7-highspeed", "minimax"], ["MiniMax-M2.7", "minimax"], ["MiniMax-M3", "minimax"],
    ["llama-3.3-70b-versatile", "groq"], ["meta-llama/llama-3.3-70b-instruct", "openrouter"],
    ["flux-auto", undefined], ["flux-fast", undefined], ["flux-reasoning", undefined], ["flux-standard", undefined],
  ];

  it("resolves the engine models it can and refuses the rest out loud", () => {
    const resolved = CATALOG.filter(([id, hint]) => lookupModelMetadata(id, hint) !== null);
    const unresolved = CATALOG.filter(([id, hint]) => lookupModelMetadata(id, hint) === null).map(([id]) => id);
    // 31 of 40. The nine misses are all honest: four are Flux ROUTES with no
    // single price, two are Gemini 3.1 Pro variants models.dev has no entry
    // for, one is `gpt-oss-120b-medium` whose base id three providers price
    // differently with no vendor among them, one is `grok-4-fast` (xAI renamed
    // it grok-4-fast-reasoning / -non-reasoning, so the old id is genuinely
    // gone) and one is the bare alias `sonnet`.
    expect(resolved.length).toBe(31);
    expect(unresolved).toEqual([
      "gemini-3.1-pro-high", "gemini-3.1-pro-low", "gpt-oss-120b-medium", "sonnet", "grok-4-fast",
      "flux-auto", "flux-fast", "flux-reasoning", "flux-standard",
    ]);
  });

  it("prices Flux Router's pinned catalogue by stripping the route prefix", () => {
    // The point of the whole pinned rule: Flux Router is what Sean steers
    // users to, and its rows showed nothing at all. Every id here is one this
    // repository actually contains; no id was invented.
    expect(lookupModelMetadata("flux-pinned-claude-opus-5")).toMatchObject({
      provider: "anthropic", modelId: "claude-opus-5", tier: "normalised",
    });
    expect(lookupModelMetadata("flux-pinned-gpt-5")).toMatchObject({ provider: "openai", modelId: "gpt-5" });
    // Flux's own names for its pinned tiers are not upstream ids, so they are
    // refused rather than approximated.
    expect(lookupModelMetadata("flux-pinned-glm-5-3")).toBeNull();
    expect(lookupModelMetadata("flux-pinned-deepseek-flash-max")).toBeNull();
  });

  it("never prices a Flux id that is not a pinned model", () => {
    // flux-voice and flux-image are not chat models at all; the four tiers are
    // routes. Force-matching any of them onto a concrete model would put a
    // confident band on something that has none.
    for (const id of ["flux-voice", "flux-image", "flux-auto", "flux-fast", "flux-reasoning", "flux-standard", "flux::flux-auto"]) {
      expect(lookupModelMetadata(id), id).toBeNull();
    }
  });

  it("settles a reseller disagreement on the vendor's own rate", () => {
    // claude-opus-5 is quoted by dozens of gateways. Anthropic's number is the
    // canonical one; an average or a first-seen would be a different model's
    // price wearing this one's name.
    const match = lookupModelMetadata("claude-opus-5");
    expect(match?.provider).toBe("anthropic");
    expect(match?.metadata.outputPerMillion).toBe(25);
  });

  it("reads as unknown, not as cheap, when nothing resolves", () => {
    const [row] = pickerModels(engine([{ id: "nobody-sells-this-model", label: "Mystery" }]), []);
    expect(row!.pricing).toBeUndefined();
    expect(modelPriceLabel(row!)).toBe(PRICE_UNKNOWN);
    expect(isPriceUnknown(row!)).toBe(true);
    // and a real band is never mistaken for it
    const [priced] = pickerModels(engine([{ id: "claude-opus-5", label: "Claude Opus 5" }]), []);
    expect(isPriceUnknown(priced!)).toBe(false);
    // nor is the Flux Auto range
    const [auto] = pickerModels(engine([{ id: "flux-auto", label: "Flux Auto" }]), []);
    expect(isPriceUnknown(auto!)).toBe(false);
  });
});
