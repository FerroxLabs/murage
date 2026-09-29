// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Image generation v2 (A.1 to A.7, delivery): per-model limits refused
// before the card with numbers, size by intent, quality aliases, n, formats,
// the Flux catalogue, streaming and jobs. No real key, no network.
import { describe, expect, it, vi } from "vitest";
import { IMAGE_RESPONSE_MAX_BYTES, ImageGenerationService, imageApprovalSubtitle, imageModelsForBots, imageResultSummary, imageResponseCap, type ImageConnection, type ImageProvider, type ImageOperationDetails } from "./image-generation.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
/** A PNG whose header says `width` x `height` (enough for the header reader). */
function pngOf(width: number, height: number): Buffer {
  const header = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
  header.writeUInt32BE(13, 8); header.write("IHDR", 12, "ascii"); header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20);
  return header;
}
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);
const imageBody = (count = 1) => ({ data: Array.from({ length: count }, () => ({ b64_json: PNG })), usage: { cost: 0.01 } });
const sse = (frames: unknown[]) => new Response(frames.map(frame => typeof frame === "string" ? frame : `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

function fixture(provider: ImageProvider = "openai", options: { fluxCatalogue?: boolean; crop?: boolean } = {}) {
  const connection: ImageConnection = { id: provider, provider, apiKey: "FAKE_V2_CANARY", revision: "r1" };
  const fetcher = vi.fn<typeof fetch>(async input => String(input).endsWith("/v1/images/models") ? new Response("not found", { status: 404 }) : json(imageBody()));
  const crop = vi.fn(async (_bytes: Buffer, width: number, height: number) => pngOf(width, height));
  let now = 0;
  const service = new ImageGenerationService({ resolveConnection: id => id === provider ? connection : null, connectionIds: () => [provider], fetch: fetcher,
    fluxCatalogue: options.fluxCatalogue, crop: async () => options.crop === false ? null : crop, sleep: async ms => { now += ms; }, now: () => now });
  const finish = vi.fn(async () => {}), publish = vi.fn(async (_image: unknown, metadata: unknown) => ({ id: `artifact-${publish.mock.calls.length}`, metadata }));
  const reserve = vi.fn(async (_details: ImageOperationDetails, _card?: { prompt: string }) => ({ finish }));
  const jobStarted = vi.fn();
  const hooks = { assertActive: () => {}, reserve, publish, jobStarted, operationId: "op-1" };
  const posts = () => fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
  const body = (index = 0) => JSON.parse(String(posts()[index]![1]!.body)) as Record<string, unknown>;
  return { service, fetcher, reserve, publish, finish, crop, jobStarted, hooks, posts, body, request: { connectionId: provider, prompt: "A watercolor mountain" } };
}
const refused = async (f: ReturnType<typeof fixture>, request: Record<string, unknown>, code: string, text?: string, refs: Array<{ bytes: Buffer; mime: "image/png" }> = []) => {
  const error = await f.service.generate({ ...f.request, ...request }, f.hooks, refs).then(() => null, (reason: unknown) => reason as { code: string; message: string; correctablePreflight: boolean });
  expect(error).toMatchObject({ code, correctablePreflight: true });
  if (text) expect(error!.message).toContain(text);
  expect(f.reserve).not.toHaveBeenCalled(); expect(f.posts()).toHaveLength(0);
  return error!.message;
};
const ref = { bytes: Buffer.from(PNG, "base64"), mime: "image/png" as const };

describe("A.1 prompt budget", () => {
  it("sends a long prompt whole to a model with a large budget and states its length", async () => {
    const f = fixture(), prompt = `${"L".repeat(12_334)}\n\n${"S".repeat(2_000)}`;
    const result = await f.service.generate({ ...f.request, prompt }, f.hooks);
    expect((f.body().prompt as string).length).toBe(14_336); expect(result.metadata.promptChars).toBe(14_336);
    expect(f.reserve.mock.calls[0]![1]).toEqual({ prompt });
    expect(imageApprovalSubtitle(f.reserve.mock.calls[0]![0])).toContain("Prompt: 14,336 characters.");
  });
  it("refuses a prompt over the model's budget before the card with both numbers and never cuts it", async () => {
    const f = fixture("flux");
    const message = await refused(f, { model: "flux-image-fast", prompt: "p".repeat(2_500) }, "prompt-too-long");
    expect(message).toBe("The prompt is 2,500 characters; flux-image-fast allows 2,000. Nothing was sent. Condense it (identity first, then camera, scene, and one short Avoid: line) and send it with condensed_from_chars, or choose a model with a larger budget: flux-image, flux-image-gpt25, flux-image-gpt25-sunburst.");
    await refused(fixture("xai"), { model: "grok-imagine-image-2.0", prompt: "p".repeat(6_000) }, "prompt-too-long", "allows 4,000");
  });
  it("A.3 states a condensed prompt on the card and the result, and refuses a condensed length that is not longer", async () => {
    const f = fixture("flux");
    const result = await f.service.generate({ ...f.request, model: "flux-image-fast", prompt: "p".repeat(1_900), condensedFromChars: 12_900 }, f.hooks);
    expect(imageApprovalSubtitle(f.reserve.mock.calls[0]![0])).toContain("Condensed from 12,900 to 1,900 characters for flux-image-fast.");
    expect(result.metadata.summary).toContain("Condensed from 12,900 to 1,900 characters for flux-image-fast.");
    await refused(fixture("flux"), { model: "flux-image-fast", prompt: "p".repeat(1_900), condensedFromChars: 1_900 }, "unsupported-parameter", "must be more than");
  });
});

describe("A.4 size by intent", () => {
  it("renders 9:16 large as legal portrait pixels on OpenAI and states asked and delivered", async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(json({ data: [{ b64_json: pngOf(1536, 2736).toString("base64") }] }));
    const result = await f.service.generate({ ...f.request, aspectRatio: "9:16", resolution: "large" }, f.hooks);
    expect(f.body().size).toBe("1536x2736");
    expect(imageApprovalSubtitle(f.reserve.mock.calls[0]![0])).toContain("9:16 large asked, 1536x2736 rendered.");
    expect(result.metadata.delivered).toEqual([{ width: 1536, height: 2736, mime: "image/png", bytes: 33 }]);
    expect(result.metadata.summary).toContain("9:16 large asked, 1536x2736 rendered.");
  });
  it("reads the delivered pixels from the image, never from the request", async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(json({ data: [{ b64_json: pngOf(1024, 1024).toString("base64") }] }));
    const result = await f.service.generate({ ...f.request, width: 1152, height: 2048 }, f.hooks);
    expect(f.body().size).toBe("1152x2048"); expect(result.metadata.delivered![0]).toMatchObject({ width: 1024, height: 1024 });
    expect(result.metadata.summary).toContain("1152x2048 asked, 1024x1024 rendered.");
  });
  it("refuses a portrait on a square-only Flux model, naming the nearest and the models that render it natively", async () => {
    const message = await refused(fixture("flux"), { model: "flux-image-gpt25-sunburst", aspectRatio: "9:16" }, "unsupported-size", "The nearest it can do is 1024x1024.");
    expect(message).toContain('fit: "exact"'); expect(message).toContain("Models on this connection that render it natively: flux-image-fast.");
    await refused(fixture(), { aspectRatio: "1:8" }, "unsupported-size", "1:8 is outside this model's 1:3 to 3:1 range. The nearest it can do is 1:3.");
  });
  it("renders the nearest size and crops and resizes it here for fit exact", async () => {
    const f = fixture("flux");
    const result = await f.service.generate({ ...f.request, model: "flux-image-gpt25-sunburst", width: 1080, height: 1350, fit: "exact" }, f.hooks);
    expect(f.body().size).toBe("1024x1024"); expect(f.crop).toHaveBeenCalledWith(expect.any(Buffer), 1080, 1350);
    expect(imageApprovalSubtitle(f.reserve.mock.calls[0]![0])).toContain("1080x1350 asked, 1024x1024 rendered, cropped and resized here to 1080x1350.");
    expect(result.metadata.delivered![0]).toMatchObject({ width: 1080, height: 1350, cropped: true });
    expect(await refused(fixture("flux", { crop: false }), { model: "flux-image-gpt25-sunburst", width: 1080, height: 1350, fit: "exact" }, "unsupported-size")).toContain("cannot crop images on this computer");
  });
  it("sends Gemini a named ratio and tier, and only a tier when nothing is asked", async () => {
    const f = fixture("google"); f.fetcher.mockImplementation(async () => json({ candidates: [{ content: { parts: [{ inlineData: { data: PNG } }] } }] }));
    await f.service.generate({ ...f.request, aspectRatio: "9:16", resolution: "large", seed: 7 }, f.hooks);
    expect(f.body().generationConfig).toEqual({ responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "9:16", imageSize: "2K" }, seed: 7 });
    await f.service.generate({ ...f.request, aspectRatio: "1:8", resolution: "max" }, f.hooks);
    expect((f.body(1).generationConfig as { imageConfig: unknown }).imageConfig).toEqual({ aspectRatio: "1:8", imageSize: "4K" });
  });
});

describe("A.5 quality", () => {
  it("sends the quality alias as the model on a Flux base id, and a size variant for 1536x1024", async () => {
    const f = fixture("flux");
    await f.service.generate({ ...f.request, model: "flux-image-gpt25-sunburst", quality: "medium" }, f.hooks);
    expect(f.body()).toMatchObject({ model: "flux-image-gpt25-sunburst-med" }); expect(f.body()).not.toHaveProperty("quality");
    expect(f.reserve.mock.calls[0]![0]).toMatchObject({ model: "flux-image-gpt25-sunburst", sentModel: "flux-image-gpt25-sunburst-med", quality: "medium" });
    expect(imageApprovalSubtitle(f.reserve.mock.calls[0]![0])).toContain("flux-image-gpt25-sunburst (sent as flux-image-gpt25-sunburst-med)");
    await f.service.generate({ ...f.request, model: "flux-image-gpt25", quality: "max", size: "1536x1024" }, f.hooks);
    expect(f.body(1)).toMatchObject({ model: "flux-image-gpt25-max-xl", size: "1536x1024" });
    await refused(fixture("flux"), { model: "flux-image-gpt25-sunburst", quality: "xhigh", size: "1536x1024" }, "unsupported-quality", "exists only at quality high");
  });
  it("lists base models with their qualities and each older id as an alias", async () => {
    const catalog = await fixture("flux").service.getCatalog("flux");
    expect(catalog.models.find(model => model.id === "flux-image-gpt25-sunburst")).toMatchObject({ qualities: ["low", "medium", "high", "xhigh"], capabilities: { qualityMode: "alias" } });
    expect(catalog.models.find(model => model.id === "flux-image-gpt25-sunburst-med")).toMatchObject({ aliasOf: "flux-image-gpt25-sunburst", qualities: ["medium"] });
    expect(catalog.capabilitySource).toBe("built-in");
  });
});

describe("A.6 references", () => {
  it("names the model's cap when there are too many references, before the card", async () => {
    await refused(fixture("flux"), { operation: "edit" }, "invalid-references", "5 reference images; GPT Image 2.5 Flare high takes at most 4. Nothing was sent.", Array(5).fill(ref));
    await refused(fixture(), { operation: "edit" }, "invalid-references", "17 reference images; Murage takes at most 16. Nothing was sent.", Array(17).fill(ref));
    const f = fixture(); await f.service.generate({ ...f.request, operation: "edit" }, f.hooks, Array(16).fill(ref));
    expect(imageApprovalSubtitle(f.reserve.mock.calls[0]![0])).toContain("References: 16 of 16.");
  });
});

describe("A.7 n, formats, background, seed and negative prompt", () => {
  it("publishes every image of an n > 1 render and does not stream OpenAI with n > 1", async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(json(imageBody(4)));
    const result = await f.service.generate({ ...f.request, n: 4 }, f.hooks);
    expect(f.body()).toMatchObject({ n: 4 }); expect(f.body()).not.toHaveProperty("stream");
    expect(f.publish).toHaveBeenCalledTimes(4); expect(result.artifacts).toHaveLength(4);
    expect(f.publish.mock.calls.map(call => (call[1] as { imageIndex: number }).imageIndex)).toEqual([0, 1, 2, 3]);
    expect(imageApprovalSubtitle(f.reserve.mock.calls[0]![0])).toMatch(/^4 images · openai · gpt-image-2/);
    expect(imageResultSummary(result.metadata)).toMatch(/^4 images with gpt-image-2/);
  });
  it("refuses what a model does not take, plainly and before the card", async () => {
    await refused(fixture("flux"), { n: 2 }, "unsupported-parameter", "flux-image makes at most 1 image per request.");
    await refused(fixture("flux"), { outputFormat: "jpeg" }, "unsupported-parameter", "returns png, not jpeg");
    await refused(fixture(), { background: "transparent" }, "unsupported-parameter", "does not take a transparent background");
    await refused(fixture("flux"), { seed: 42 }, "unsupported-parameter", "This model does not take a seed. Nothing was sent. Leave seed out or no other model on this connection takes one.");
    await refused(fixture(), { outputCompression: 50 }, "unsupported-parameter", "needs output_format jpeg or webp");
  });
  it("sends format, compression and background where supported", async () => {
    const f = fixture(); await f.service.generate({ ...f.request, model: "gpt-image-1", outputFormat: "webp", outputCompression: 80, background: "transparent" }, f.hooks);
    expect(f.body()).toMatchObject({ model: "gpt-image-1", output_format: "webp", output_compression: 80, background: "transparent" });
    expect(imageApprovalSubtitle(f.reserve.mock.calls[0]![0])).toContain("Format: webp, compression 80. Transparent background.");
  });
  it("adds a negative prompt as an Avoid: line, counts it and says so", async () => {
    const f = fixture(); const result = await f.service.generate({ ...f.request, negativePrompt: "text, watermark" }, f.hooks);
    expect(f.body().prompt).toBe("A watercolor mountain\n\nAvoid: text, watermark");
    expect(result.metadata).toMatchObject({ avoidLine: true, promptChars: "A watercolor mountain\n\nAvoid: text, watermark".length });
    expect(imageApprovalSubtitle(f.reserve.mock.calls[0]![0])).toContain("Negative prompt added as an Avoid: line.");
    expect(f.reserve.mock.calls[0]![1]).toEqual({ prompt: "A watercolor mountain\n\nAvoid: text, watermark" });
  });
  it("never shows a cost on the card", () => {
    const text = imageApprovalSubtitle({ connectionId: "flux", provider: "flux", model: "m", operation: "generate", count: 2, referenceCount: 0, promptChars: 10, sizeAsked: "9:16", sizeRendered: "1024x1024", cropTo: "576x1024" });
    expect(text).not.toMatch(/\$|cost|price|USD/i);
  });
});

describe("Flux catalogue", () => {
  const catalogue = { contract: 1, kind: "image-catalogue", default_model: "flux-image-gpt25-sunburst", data: [{
    id: "flux-image-gpt25-sunburst", label: "GPT Image 2.5 Sunburst", aliases: ["flux-image-gpt25-sunburst-med"], operations: ["generate", "edit"], maxPromptChars: 32000,
    sizeRule: { kind: "free", multiple: 16, minRatio: 0.3333, maxRatio: 3, maxPixels: 8294400, maxEdge: 3840, minPixels: 655360 },
    qualities: ["low", "medium", "high", "xhigh"], qualityMode: "param", formats: ["png", "jpeg"], maxReferences: 16,
    supports: { edit: true, background: true, n: 10 }, delivery: { stream: true, jobs: true, keepaliveSeconds: 15 }, expectedSeconds: { high: 32, xhigh: 55 },
    status: { state: "ok", last_good_at: "2026-10-01T00:00:00Z" } }] };
  it("reads the catalogue once per key with the Flux key only, and uses it for sizes and quality", async () => {
    const f = fixture("flux", { fluxCatalogue: true });
    f.fetcher.mockImplementation(async input => String(input).endsWith("/v1/images/models") ? json(catalogue) : json(imageBody()));
    const catalog = await f.service.getCatalog("flux");
    expect(catalog).toMatchObject({ capabilitySource: "catalogue", defaultModel: "flux-image-gpt25-sunburst" });
    expect(catalog.models[0]).toMatchObject({ id: "flux-image-gpt25-sunburst", availability: "catalog-listed", status: { state: "ok", lastGoodAt: "2026-10-01T00:00:00Z" } });
    expect(catalog.models.some(model => model.id === "flux-image")).toBe(true);
    const [url, init] = f.fetcher.mock.calls[0]!; expect(url).toBe("https://api.fluxrouter.ai/v1/images/models"); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer FAKE_V2_CANARY");
    await f.service.generate({ ...f.request, model: "flux-image-gpt25-sunburst", quality: "high", aspectRatio: "9:16" }, f.hooks);
    expect(f.fetcher.mock.calls.filter(([input]) => String(input).endsWith("/v1/images/models"))).toHaveLength(1);
    expect(f.body()).toMatchObject({ model: "flux-image-gpt25-sunburst", quality: "high", size: "768x1360", stream: true });
    expect(f.body()).not.toHaveProperty("partial_images");
    expect(new Headers(f.posts()[0]![1]!.headers).get("idempotency-key")).toMatch(/^[a-f0-9]{64}$/);
  });
  it("falls back to the built-in table when the router has no catalogue", async () => {
    const f = fixture("flux", { fluxCatalogue: true });
    const catalog = await f.service.getCatalog("flux");
    expect(catalog.capabilitySource).toBe("built-in"); expect(catalog.defaultModel).toBe("flux-image");
    await f.service.generate(f.request, f.hooks);
    expect(f.fetcher.mock.calls.filter(([input]) => String(input).endsWith("/v1/images/models"))).toHaveLength(1);
  });
  it("runs a long render as a job: records the job id before polling, and resumes it without a second render", async () => {
    const f = fixture("flux", { fluxCatalogue: true });
    f.fetcher.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/images/models")) return json(catalogue);
      if (init?.method === "POST") return json({ contract: 1, kind: "image-job", id: "imgjob_7", status: "queued", poll_after_s: 3 }, { status: 202 });
      expect(f.jobStarted).toHaveBeenCalledWith({ id: "imgjob_7" });
      return json({ contract: 1, kind: "image-job", id: "imgjob_7", status: "succeeded", data: [{ b64_json: PNG }] });
    });
    const result = await f.service.generate({ ...f.request, model: "flux-image-gpt25-sunburst", quality: "xhigh", width: 2048, height: 2048 }, f.hooks);
    expect(new Headers(f.posts()[0]![1]!.headers).get("prefer")).toBe("respond-async");
    expect(f.fetcher.mock.calls.some(([input]) => String(input) === "https://api.fluxrouter.ai/v1/images/jobs/imgjob_7")).toBe(true);
    expect(result.metadata).toMatchObject({ delivery: "job", jobId: "imgjob_7" }); expect(f.publish).toHaveBeenCalledOnce();
    const again = fixture("flux", { fluxCatalogue: true });
    again.fetcher.mockImplementation(async input => String(input).endsWith("/v1/images/models") ? json(catalogue) : json({ contract: 1, kind: "image-job", id: "imgjob_7", status: "succeeded", data: [{ b64_json: PNG }] }));
    await again.service.generate({ ...again.request, model: "flux-image-gpt25-sunburst", quality: "xhigh", width: 2048, height: 2048 }, { ...again.hooks, resumeJob: { id: "imgjob_7" } });
    expect(again.posts()).toHaveLength(0); expect(again.publish).toHaveBeenCalledOnce();
  });
});

describe("streaming", () => {
  it("reads a Flux event stream with keepalives and partial frames", async () => {
    const f = fixture("flux");
    f.fetcher.mockResolvedValueOnce(sse([": keepalive\n\n", { type: "image_generation.partial_image", b64_json: PNG }, { type: "image_generation.completed", data: [{ b64_json: PNG }], usage: { cost: 0.02 } }, "data: [DONE]\n\n"]));
    const result = await f.service.generate(f.request, f.hooks);
    expect(f.body()).toMatchObject({ stream: true }); expect(result.metadata.usage).toEqual({ costUsd: 0.02 }); expect(f.publish).toHaveBeenCalledOnce();
  });
  it("asks for one preview frame on a long render when the router sends no keepalive", async () => {
    const f = fixture("flux"); await f.service.generate({ ...f.request, model: "flux-image-gpt25-xhigh" }, f.hooks);
    expect(f.body()).toMatchObject({ stream: true, partial_images: 1 });
  });
  it("reports an error frame as a failed render and publishes nothing", async () => {
    const f = fixture("flux"); f.fetcher.mockResolvedValueOnce(sse([{ type: "error", error: { code: "moderation_blocked", message: "Blocked." } }]));
    await expect(f.service.generate(f.request, f.hooks)).rejects.toMatchObject({ code: "provider-error", outcome: "failed" });
    expect(f.finish).toHaveBeenCalledWith("failed"); expect(f.publish).not.toHaveBeenCalled();
  });
});

describe("list_image_models for bots", () => {
  it("states every model's limits compactly, well under the tool result cap", async () => {
    for (const provider of ["flux", "openai", "google", "xai"] as const) {
      const models = imageModelsForBots(await fixture(provider).service.getCatalog(provider)) as Array<Record<string, unknown>>;
      expect(JSON.stringify(models).length).toBeLessThan(16_000);
      for (const model of models) expect(model.aliasOf ? model.quality : (model.capabilities as { maxPromptChars: number }).maxPromptChars).toBeTruthy();
    }
    const flux = imageModelsForBots(await fixture("flux").service.getCatalog("flux")) as Array<Record<string, unknown>>;
    expect(flux.find(model => model.id === "flux-image-gpt25-sunburst-med")).toEqual(expect.objectContaining({ aliasOf: "flux-image-gpt25-sunburst", quality: "medium", sizes: ["1024x1024"] }));
    expect(flux.find(model => model.id === "flux-image-fast")).toMatchObject({ capabilities: { maxPromptChars: 2000, sizeRuleText: expect.stringContaining("multiples of 32"), supports: { n: 1 } } });
  });
});

describe("coordinator additions", () => {
  it("names the connection by its label on the card, never its raw id", async () => {
    const f = fixture(); await f.service.generate(f.request, { ...f.hooks, connectionLabel: "Studio OpenAI" });
    const subtitle = imageApprovalSubtitle(f.reserve.mock.calls[0]![0]);
    expect(subtitle).toMatch(/^One image · Studio OpenAI · gpt-image-2/); expect(f.reserve.mock.calls[0]![0].connectionId).toBe("openai");
    expect(imageApprovalSubtitle({ connectionId: "model:1234", provider: "openai", model: "m", operation: "generate", count: 1, referenceCount: 0 })).not.toContain("model:1234");
  });
  it("says plainly why Gemini returned no image, with the provider's reason code", async () => {
    const cases: Array<[unknown, string]> = [
      [{ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }, "Gemini did not return an image: it blocked the request (reason: PROHIBITED_CONTENT)."],
      [{ candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [] } }] }, "Gemini did not return an image: it stopped the render (reason: IMAGE_SAFETY)."],
      [{ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "I can only describe this scene." }] } }] }, 'Gemini did not return an image. It replied: "I can only describe this scene."'],
      [{ candidates: [{ finishReason: "bad code <script>", content: { parts: [] } }] }, "Gemini did not return an image."],
    ];
    for (const [body, message] of cases) {
      const f = fixture("google"); f.fetcher.mockResolvedValueOnce(json(body));
      const error = await f.service.generate(f.request, f.hooks).then(() => null, (reason: { code: string; message: string }) => reason);
      expect(error).toMatchObject({ code: "invalid-image" }); expect(error!.message).toContain(message);
      expect(error!.message).not.toMatch(/<script>|\bsafety\b/);
      expect(f.publish).not.toHaveBeenCalled();
    }
  });
});


describe("review fixes", () => {
  it("bounds the whole response at a fixed cap, whatever n is", () => {
    expect(IMAGE_RESPONSE_MAX_BYTES).toBe(128 * 1024 * 1024);
    expect(imageResponseCap(10)).toBe(IMAGE_RESPONSE_MAX_BYTES);
    expect(imageResponseCap(1)).toBeLessThanOrEqual(IMAGE_RESPONSE_MAX_BYTES);
  });
  it("shows a native negative prompt on the card, in full, beside the prompt", async () => {
    const catalogue = { contract: 1, kind: "image-catalogue", data: [{ id: "flux-image-fast", operations: ["generate"], maxPromptChars: 2000,
      sizeRule: { kind: "list", sizes: ["1024x1024"] }, qualities: ["low"], supports: { negative: true, n: 1 }, delivery: { stream: false } }] };
    const f = fixture("flux", { fluxCatalogue: true });
    f.fetcher.mockImplementation(async input => String(input).endsWith("/v1/images/models") ? json(catalogue) : json(imageBody()));
    await f.service.generate({ ...f.request, model: "flux-image-fast", negativePrompt: "blurry hands" }, f.hooks);
    expect(f.body()).toMatchObject({ negative_prompt: "blurry hands" }); expect(f.body().prompt).toBe("A watercolor mountain");
    const [details, card] = f.reserve.mock.calls[0]!;
    expect(card).toEqual({ prompt: "A watercolor mountain", negativePrompt: "blurry hands" });
    expect(imageApprovalSubtitle(details)).toContain("Negative prompt sent in its own field: 12 characters.");
  });
  it("follows a 202 job answer only from Flux", async () => {
    const f = fixture("openai");
    f.fetcher.mockResolvedValueOnce(json({ contract: 1, kind: "image-job", id: "imgjob_9", status: "queued" }, { status: 202 }));
    await expect(f.service.generate(f.request, f.hooks)).rejects.toMatchObject({ code: "invalid-image" });
    expect(f.fetcher.mock.calls.some(([input]) => String(input).includes("/v1/images/jobs/"))).toBe(false);
    expect(f.jobStarted).not.toHaveBeenCalled();
  });
  it("refuses fit exact pixels past the model's largest render before the card", async () => {
    await refused(fixture(), { width: 8192, height: 8192, fit: "exact" }, "unsupported-size", "at most 8,294,400 pixels");
  });
  it("keeps the paid render when the crop here fails or returns something unreadable, and says so", async () => {
    const f = fixture(); f.crop.mockResolvedValueOnce(Buffer.from("not an image"));
    const result = await f.service.generate({ ...f.request, width: 1080, height: 1350, fit: "exact" }, f.hooks);
    expect(f.publish).toHaveBeenCalledOnce(); expect(result.metadata.delivered![0]).toMatchObject({ cropFailed: true });
    expect(result.metadata.summary).toContain("could not be cropped here to 1080x1350, so it is delivered as rendered.");
  });
});

describe("review fixes: delivery and sizes", () => {
  it("always asks a direct OpenAI stream for one preview frame", async () => {
    const f = fixture(); await f.service.generate(f.request, f.hooks);
    expect(f.body()).toMatchObject({ stream: true, partial_images: 1 });
  });
  it("refuses a render over the kept image cap with its size, publishing nothing", async () => {
    const f = fixture(); const big = Buffer.concat([pngOf(1024, 1024), Buffer.alloc(26 * 1024 * 1024)]);
    f.fetcher.mockResolvedValueOnce(json({ data: [{ b64_json: big.toString("base64") }] }));
    await expect(f.service.generate(f.request, f.hooks)).rejects.toMatchObject({ code: "image-too-large", message: expect.stringContaining("keeps images up to 25 MB") });
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("keeps generated images inside what Files, the viewer and Save accept", async () => {
    const [{ GENERATED_IMAGE_MAX_BYTES }, { ARTIFACT_MAX_BYTES }, { MEDIA_IMAGE_MAX_BYTES }, { OUTPUT_PUBLICATION_LIMITS }] = await Promise.all([
      import("./attachments.ts"), import("./artifacts.ts"), import("./media-assets.ts"), import("../shared/output-publication.ts")]);
    for (const cap of [ARTIFACT_MAX_BYTES, MEDIA_IMAGE_MAX_BYTES, OUTPUT_PUBLICATION_LIMITS.maxFileBytes]) expect(GENERATED_IMAGE_MAX_BYTES).toBeLessThanOrEqual(cap);
  });
  it("sends no size to xAI and says the provider's default size", async () => {
    const f = fixture("xai"); await f.service.generate({ ...f.request, model: "grok-imagine-image-2.0" }, f.hooks);
    expect(f.body()).not.toHaveProperty("size");
    const text = imageApprovalSubtitle(f.reserve.mock.calls[0]![0]);
    expect(text).not.toContain("1024x1024");
  });
  it("stops polling at once when the connection changes, naming the change", async () => {
    const catalogue = { contract: 1, kind: "image-catalogue", data: [{ id: "flux-image-gpt25-sunburst", operations: ["generate"], maxPromptChars: 32000,
      sizeRule: { kind: "list", sizes: ["1024x1024"] }, qualities: ["xhigh"], qualityMode: "param", supports: { n: 1 }, delivery: { jobs: true }, expectedSeconds: { xhigh: 120 } }] };
    let revision = "r1"; const connection = () => ({ id: "flux", provider: "flux" as const, apiKey: "FAKE_V2_CANARY", revision });
    let polls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/v1/images/models")) return json(catalogue);
      if (init?.method === "POST") { revision = "r2"; return json({ contract: 1, kind: "image-job", id: "imgjob_1", status: "queued", poll_after_s: 2 }, { status: 202 }); }
      polls++; return json({ contract: 1, kind: "image-job", id: "imgjob_1", status: "running" });
    });
    let now = 0;
    const service = new ImageGenerationService({ resolveConnection: () => connection(), connectionIds: () => ["flux"], fetch: fetcher, fluxCatalogue: true, sleep: async ms => { now += ms; }, now: () => now });
    const hooks = { assertActive: () => {}, reserve: vi.fn(async () => ({ finish: async () => {} })), publish: vi.fn(), jobStarted: vi.fn(), operationId: "op" };
    await expect(service.generate({ connectionId: "flux", prompt: "x", model: "flux-image-gpt25-sunburst", quality: "xhigh" }, hooks)).rejects.toMatchObject({ code: "connection-changed" });
    expect(polls).toBe(0); expect(now).toBeLessThan(60_000);
  });
});

describe("review round 2", () => {
  it("does not treat the daily check preference as a settings change for a running render", async () => {
    const { imageSettingsIdentity } = await import("./image-generation.ts");
    expect(imageSettingsIdentity({ enabled: true, connectionId: "openai", model: "gpt-image-2", dailyProbe: false }))
      .toBe(imageSettingsIdentity({ enabled: true, connectionId: "openai", model: "gpt-image-2", dailyProbe: true }));
    expect(imageSettingsIdentity({ enabled: true, model: "a" })).not.toBe(imageSettingsIdentity({ enabled: true, model: "b" }));
  });
});

describe("review round 2: error bodies", () => {
  it("reads a provider's error body only up to 64 KB, even with no length header", async () => {
    const f = fixture();
    const huge = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`{"error":{"message":"${"x".repeat(200_000)}"}}`)); controller.close(); } });
    f.fetcher.mockResolvedValueOnce(new Response(huge, { status: 400 }));
    await expect(f.service.generate(f.request, f.hooks)).rejects.toMatchObject({ code: "provider-error", message: "The selected image provider rejected the request (HTTP 400). No fallback or automatic retry was attempted." });
  });
});

describe("review round 2: silence", () => {
  it("lets a direct OpenAI stream stay quiet for 10 minutes, and Flux for 2 or 4 keepalives", async () => {
    const { streamIdleMs } = await import("./image-generation.ts");
    expect(streamIdleMs("openai")).toBe(600_000); expect(streamIdleMs("flux")).toBe(120_000); expect(streamIdleMs("flux", 60)).toBe(240_000);
  });
});

describe("review round 2: one image over the cap", () => {
  it("keeps the images of a multi-image render that fit and names the one that did not", async () => {
    const f = fixture(); const big = Buffer.concat([pngOf(1024, 1024), Buffer.alloc(26 * 1024 * 1024)]);
    f.fetcher.mockResolvedValueOnce(json({ data: [{ b64_json: PNG }, { b64_json: big.toString("base64") }] }));
    const result = await f.service.generate({ ...f.request, n: 2 }, f.hooks);
    expect(f.publish).toHaveBeenCalledOnce();
    expect(result.metadata.notKept).toEqual([{ index: 1, bytes: big.length }]);
    expect(result.metadata.summary).toContain("Image 2 arrived at 26 MB, over the 25 MB Murage keeps, so it was not kept.");
  });
});
