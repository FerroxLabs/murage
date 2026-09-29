// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Image generation phase 2: saved blocks assembled before the budget check,
// reference packs counted against the model, model checks (paid and free)
// and the free Flux model list. No real key, no network.
import { describe, expect, it, vi } from "vitest";
import { builtInImageCapabilities } from "../shared/image-capabilities.ts";
import { IMAGE_PROBE_PROMPT, ImageGenerationService, imageApprovalSubtitle, imageModelsForBots, type ImageConnection, type ImageOperationDetails, type ImageProvider } from "./image-generation.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);
const ref = { bytes: Buffer.from(PNG, "base64"), mime: "image/png" as const };

function fixture(provider: ImageProvider = "openai", options: { fluxCatalogue?: boolean; route?: (url: string, init?: RequestInit) => Response | undefined } = {}) {
  const connection: ImageConnection = { id: provider, provider, apiKey: "FAKE_LIBRARY_CANARY", revision: "r1" };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => options.route?.(String(input), init) ?? (String(input).endsWith("/v1/images/models") || String(input).endsWith("/v1/models") ? new Response("not found", { status: 404 }) : json({ data: [{ b64_json: PNG }], usage: { cost: 0.02 } })));
  const service = new ImageGenerationService({ resolveConnection: id => id === provider ? connection : null, connectionIds: () => [provider], fetch: fetcher, fluxCatalogue: options.fluxCatalogue });
  const publish = vi.fn(async () => ({ id: "artifact" }));
  const reserve = vi.fn(async (_details: ImageOperationDetails, _card?: { prompt: string }) => ({ finish: async () => {} }));
  const hooks = { assertActive: () => {}, reserve, publish, operationId: "op-1" };
  const posts = () => fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
  const body = (index = 0) => JSON.parse(String(posts()[index]![1]!.body)) as Record<string, unknown>;
  const urls = () => fetcher.mock.calls.map(([input]) => String(input));
  return { service, fetcher, reserve, publish, hooks, posts, body, urls };
}
const lock = { name: "brand-lock", version: 3, scope: "workspace", text: "Identity: a red fox mascot with a blue scarf." };

describe("A.2 saved prompt blocks", () => {
  it("assembles blocks before the scene, states names and versions on the card, and returns facts, not the text", async () => {
    const f = fixture();
    const result = await f.service.generate({ connectionId: "openai", prompt: "At the beach at dawn." }, f.hooks, [], { blocks: [lock] });
    expect(f.body().prompt).toBe(`${lock.text}\n\nAt the beach at dawn.`);
    const [details, card] = f.reserve.mock.calls[0]!;
    expect(card!.prompt).toBe(`${lock.text}\n\nAt the beach at dawn.`);
    expect(imageApprovalSubtitle(details)).toContain(`Prompt: ${card!.prompt.length} characters: brand-lock v3 + scene.`);
    expect(result.metadata).toMatchObject({ promptChars: card!.prompt.length, promptBlocks: [{ name: "brand-lock", version: 3, scope: "workspace", chars: lock.text.length }] });
    expect(result.metadata.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result.metadata)).not.toContain("red fox");
  });

  it("takes blocks without a scene, and refuses neither", async () => {
    const f = fixture();
    await f.service.generate({ connectionId: "openai" }, f.hooks, [], { blocks: [lock] });
    expect(f.body().prompt).toBe(lock.text);
    expect(imageApprovalSubtitle(f.reserve.mock.calls[0]![0])).toContain(": brand-lock v3.");
    const g = fixture();
    await expect(g.service.generate({ connectionId: "openai" }, g.hooks)).rejects.toMatchObject({ code: "invalid-request", correctablePreflight: true });
    await expect(g.service.generate({ connectionId: "openai", prompt: "x" }, g.hooks, [], { blocks: Array.from({ length: 9 }, () => lock) })).rejects.toMatchObject({ code: "invalid-request", message: expect.stringContaining("at most 8") });
    expect(g.posts()).toHaveLength(0);
  });

  it("counts the blocks in the budget before the card", async () => {
    const f = fixture("flux");
    const big = { ...lock, text: "B".repeat(1_900) };
    const error = await f.service.generate({ connectionId: "flux", model: "flux-image-fast", prompt: "A scene of about two hundred characters. ".repeat(5) }, f.hooks, [], { blocks: [big] }).then(() => null, (reason: unknown) => reason as { code: string; message: string; correctablePreflight: boolean });
    expect(error).toMatchObject({ code: "prompt-too-long", correctablePreflight: true });
    expect(error!.message).toMatch(/The prompt is 2,\d{3} characters; flux-image-fast allows 2,000\. Nothing was sent\./);
    expect(f.reserve).not.toHaveBeenCalled(); expect(f.posts()).toHaveLength(0);
  });
});

describe("A.6 reference packs", () => {
  it("states pack and attached references against the model's cap", async () => {
    const f = fixture();
    await f.service.generate({ connectionId: "openai", operation: "edit", prompt: "Same character, new pose." }, f.hooks, [ref, ref, ref], { referencePack: { name: "hero-refs", version: 1, count: 2 } });
    expect(imageApprovalSubtitle(f.reserve.mock.calls[0]![0])).toContain("References: 2 from pack hero-refs v1 + 1 attached = 3 of 16.");
  });

  it("refuses pack plus attached references over the model's cap before the card", async () => {
    const f = fixture("xai");
    const error = await f.service.generate({ connectionId: "xai", model: "grok-imagine-image-2.0", operation: "edit", prompt: "Pose." }, f.hooks, [ref, ref, ref, ref, ref], { referencePack: { name: "hero-refs", version: 1, count: 3 } }).then(() => null, (reason: unknown) => reason as { code: string; message: string });
    expect(error).toMatchObject({ code: "invalid-references", message: expect.stringContaining("5 reference images; Grok Imagine Image 2.0 takes at most 4. Nothing was sent.") });
    expect(f.posts()).toHaveLength(0);
  });
});

describe("A.8 model checks", () => {
  it("renders the smallest legal square at the lowest quality once, keeps nothing and records the cost", async () => {
    const f = fixture();
    const result = await f.service.probe("openai", "gpt-image-2");
    expect(result).toMatchObject({ ok: true, free: false, costUsd: 0.02 });
    expect(f.posts()).toHaveLength(1);
    const sent = f.body();
    expect(sent).toMatchObject({ prompt: IMAGE_PROBE_PROMPT, n: 1, quality: "low" });
    const [width, height] = String(sent.size).split("x").map(Number);
    expect(width).toBe(height); expect(width! * height!).toBeLessThanOrEqual(1024 * 1024);
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("reports a failed check with its reason and never retries it", async () => {
    const f = fixture("openai", { route: (_url, init) => init?.method === "POST" ? json({ error: { code: "model_not_found", message: "No access" } }, { status: 404 }) : undefined });
    const result = await f.service.probe("openai", "gpt-image-2");
    expect(result).toMatchObject({ ok: false, errorCode: "provider-error", errorMessage: expect.stringContaining("model_not_found") });
    expect(f.posts()).toHaveLength(1);
  });

  it("uses Flux's free check only when the catalogue advertises it", async () => {
    const catalogue = { contract: 1, kind: "image-catalogue", probe: true, data: [{ id: "flux-image", operations: ["generate", "edit"] }] };
    const f = fixture("flux", { fluxCatalogue: true, route: (url, init) => url.endsWith("/v1/images/models") ? json(catalogue)
      : init?.method === "POST" ? json({ contract: 1, kind: "image-probe", model: "flux-image", state: "down", detail: "Arm unavailable" }) : undefined });
    expect(await f.service.probe("flux", "flux-image")).toMatchObject({ ok: false, free: true, errorCode: "down", errorMessage: "Arm unavailable" });
    expect(f.body()).toEqual({ model: "flux-image", probe: true });
    const g = fixture("flux", { fluxCatalogue: true });
    expect(await g.service.probe("flux", "flux-image")).toMatchObject({ ok: true, free: false });
    expect(g.body()).toMatchObject({ prompt: IMAGE_PROBE_PROMPT, n: 1 });
  });
});

describe("A.8 Flux model list", () => {
  const models = { data: [{ id: "flux-image" }, { id: "flux-image-gpt25-sunburst-med" }, { id: "gpt-6" }] };
  it("marks each model the key's list names or leaves out, only when asked", async () => {
    const f = fixture("flux", { fluxCatalogue: true, route: url => url.endsWith("/v1/models") ? json(models) : undefined });
    const plain = await f.service.getCatalog("flux");
    expect(plain.models.every(model => model.offeredToKey === undefined)).toBe(true);
    expect(f.urls().some(url => url.endsWith("/v1/models"))).toBe(false);
    const catalog = await f.service.getCatalog("flux", { offered: true });
    const byId = new Map(catalog.models.map(model => [model.id, model]));
    expect(byId.get("flux-image")).toMatchObject({ offeredToKey: true, availability: "catalog-listed" });
    expect(byId.get("flux-image-gpt25-sunburst")).toMatchObject({ offeredToKey: true });
    expect(byId.get("flux-image-fast")).toMatchObject({ offeredToKey: false, availability: "unverified" });
    await f.service.getCatalog("flux", { offered: true });
    expect(f.urls().filter(url => url.endsWith("/v1/models"))).toHaveLength(1);
    const view = imageModelsForBots(catalog) as Array<Record<string, unknown>>;
    expect(view.find(model => model.id === "flux-image-fast")).toMatchObject({ offeredToKey: false });
  });

  it("never reads the list for a render", async () => {
    const f = fixture("flux", { fluxCatalogue: true, route: url => url.endsWith("/v1/models") ? json(models) : undefined });
    await f.service.generate({ connectionId: "flux", prompt: "A mountain" }, f.hooks);
    expect(f.urls().some(url => url.endsWith("/v1/models"))).toBe(false);
  });

  it("gives a bot each model's last check", () => {
    const view = imageModelsForBots({ connectionId: "flux", provider: "flux", defaultModel: "a", models: [{ id: "a", label: "A", generate: true, edit: false, availability: "failed", lastGoodAt: 0, lastFailedAt: 86_400_000, lastError: "provider-error: HTTP 500",
      qualities: [], sizes: [], maxReferences: 0, capabilities: builtInImageCapabilities("openai", "gpt-image-2")! }] }) as Array<Record<string, unknown>>;
    expect(view[0]).toMatchObject({ availability: "failed", lastGoodAt: "1970-01-01T00:00:00.000Z", lastFailedAt: "1970-01-02T00:00:00.000Z", lastError: "provider-error: HTTP 500" });
  });
});
