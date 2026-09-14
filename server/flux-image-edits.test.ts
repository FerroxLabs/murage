import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { ImageGenerationService, type ImageReference } from "./image-generation.ts";
import { ImageOperations, imageReferences } from "./image-operations.ts";
import { Store } from "./store.ts";
import { saveImage } from "./attachments.ts";
import { closeDatabase } from "./database.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const reference = { bytes: png, mime: "image/png" as const };
const request = { connectionId: "flux", operation: "edit", prompt: "A blue winter jacket in a snowy park" };
const response = (cost = 0.073184) => ({ data: [{ b64_json: png.toString("base64") }], model: "flux-image", usage: { input_tokens: 1047, output_tokens: 1756, total_tokens: 2803, cost } });
afterEach(closeDatabase);
function fixture() {
 const fetcher = vi.fn<typeof fetch>(async () => Response.json(response()));
 const service = new ImageGenerationService({ resolveConnection: () => ({ id: "flux", provider: "flux", apiKey: "FAKE_B16_KEY", revision: "1" }), connectionIds: () => ["flux"], fetch: fetcher });
 const finish = vi.fn(), reserve = vi.fn(async () => ({ finish })), publish = vi.fn(async () => ({ id: "artifact" }));
 return { service, fetcher, finish, reserve, publish, hooks: { assertActive: () => {}, reserve, publish } };
}
it("B16 serializes one/four scoped references over real local HTTP after approval and publishes one PNG with charged cost", async () => {
 for (const count of [1, 4]) {
  const f = fixture(), store = new Store(() => ({ instanceId: "b16", model: "fixture" })), bot = store.createBot();
  const controller = new AbortController(), actor = { botId: bot.id, threadId: bot.threadId, generation: randomUUID(), signal: controller.signal, assertActive: () => {} };
  const uploads = Array.from({ length: count }, (_, i) => saveImage(Buffer.concat([png, Buffer.from([i])]), "image/png"));
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Edit these", attachments: uploads.map(item => ({ kind: "image", path: item.path, mime: item.mime })) });
  const refs = imageReferences(store, bot.threadId, uploads.map(item => basename(item.path)));
  let posts = 0;
  const forms: FormData[] = [];
  const server = createServer(async (req, res) => {
   posts++; const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
   forms.push(await new Request("http://fixture.invalid", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: Buffer.concat(chunks) }).formData());
   res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(response(count === 1 ? 0.073184 : 0)));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
   const address = server.address(); if (!address || typeof address === "string") throw Error("local fixture did not bind");
   f.fetcher.mockImplementation(async (url, init) => {
    expect(String(url)).toBe("https://api.fluxrouter.ai/v1/images/edits"); expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer FAKE_B16_KEY");
    return fetch(`http://127.0.0.1:${address.port}/v1/images/edits`, init);
   });
   const operations = new ImageOperations({ store, waiting: () => {} });
   const job = operations.execute(actor, "edit", request, (reserve, publish) => f.service.generate(request, { assertActive: actor.assertActive, reserve, publish }, refs));
   await vi.waitFor(() => expect(store.messagesFor(bot.threadId).some(message => message.card?.tool === "generate_image")).toBe(true));
   expect(posts).toBe(0); expect(f.fetcher).not.toHaveBeenCalled();
   const card = store.messagesFor(bot.threadId).find(message => message.card?.tool === "generate_image")!;
   expect(card.card?.subtitle).toContain(`${count === 1 ? "1 reference image" : "4 reference images"}`);
   operations.resolve(bot.threadId, card.card!.requestId!, "allow");
   const result = await job;
   expect(posts).toBe(1); expect(f.fetcher).toHaveBeenCalledOnce();
   const form = forms[0]!; expect(form.get("model")).toBe("flux-image"); expect(form.get("prompt")).toBe(request.prompt);
   expect(form.get("response_format")).toBe("b64_json"); expect(form.get("size")).toBe("1024x1024");
   expect(form.has("n")).toBe(false); expect(form.has("quality")).toBe(false);
   const files = form.getAll("image[]") as File[]; expect(files).toHaveLength(count);
   for (const [i, file] of files.entries()) { expect(file.name).toBe(`reference-${i}.png`); expect(file.type).toBe("image/png"); expect(Buffer.from(await file.arrayBuffer())).toEqual(refs[i]!.bytes); }
   expect(readFileSync(result.artifact.path)).toEqual(png); expect(result.artifact.mime).toBe("image/png");
   expect(result.metadata.usage).toEqual({ inputTokens: 1047, outputTokens: 1756, totalTokens: 2803, costUsd: count === 1 ? 0.073184 : 0 });
   expect(store.messagesFor(bot.threadId).filter(message => message.role === "bot" && message.attachments?.some(item => item.kind === "image"))).toHaveLength(1);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
 }
});
it("B16 admits the exact default alias without remapping explicit high or legacy selections", async () => {
 const catalogFixture=fixture();expect(catalogFixture.service.listConnections()).toEqual([{id:"flux",provider:"flux",defaultModel:"flux-image"}]);
 const catalog=await catalogFixture.service.getCatalog("flux");expect(catalog.models).toHaveLength(15);expect(catalog.models.find(model=>model.id==="flux-image")).toMatchObject({generate:true,edit:true,maxReferences:4,qualities:["high"],sizes:["1024x1024"],outputFormat:"png"});expect(catalogFixture.fetcher).not.toHaveBeenCalled();
 for(const model of ["flux-image","flux-image-gpt25-high","flux-image-gpt2","flux-image-gpt2-low"]){
  const f=fixture(),selected=Object.freeze({...request,model});const result=await f.service.generate(selected,f.hooks,[reference]);
  expect(selected.model).toBe(model);expect(result.metadata.model).toBe(model);expect(f.reserve).toHaveBeenCalledWith(expect.objectContaining({model}));expect((f.fetcher.mock.calls[0]![1]!.body as FormData).get("model")).toBe(model);expect(f.fetcher).toHaveBeenCalledOnce();
 }
});
it("B16 verifies all twelve GPT25 aliases and preserves provider-specific quality checks", async () => {
 const rows = [["high","high",false],["low","low",false],["","medium",false],["xhigh","xhigh",false],["max","max",false],["xl","high",true],["max-xl","max",true],["sunburst-low","low",false],["sunburst-med","medium",false],["sunburst","high",false],["sunburst-xhigh","xhigh",false],["sunburst-xl","high",true]] as const;
 for (const [suffix, quality, xl] of rows) {
  const f = fixture(), model = `flux-image-gpt25${suffix ? `-${suffix}` : ""}`, size = xl ? "1536x1024" : "1024x1024";
  const result = await f.service.generate({ ...request, model, quality, size }, f.hooks, [reference]);
  expect(result.metadata).toMatchObject({ model, quality, size }); expect((f.fetcher.mock.calls[0]![1]!.body as FormData).get("model")).toBe(model);
 }
 for (const provider of ["openai", "xai"] as const) {
  const f = fixture(), service = new ImageGenerationService({ resolveConnection: () => ({ id: provider, provider, apiKey: "FAKE", revision: "1" }), connectionIds: () => [provider], fetch: f.fetcher });
  for (const quality of ["xhigh", "max"]) await expect(service.generate({ connectionId: provider, prompt: "fixture", quality, ...(provider === "xai" ? { model: "grok-imagine-image-2.0" } : {}) }, f.hooks)).rejects.toMatchObject({ code: "unsupported-quality" });
  expect(f.fetcher).not.toHaveBeenCalled();
 }
});
it("B16 rejects ungranted aliases, foreign presets, noncatalog models and invalid references before approval or POST", async () => {
 for (const model of ["flux-image-gpt2-high", "flux-image-gpt2-xl", "fuigo-imagine-image-quality", "flux-image-nano-banana-2"]) {
  const f = fixture(); await expect(f.service.generate({ ...request, model }, f.hooks, [reference])).rejects.toMatchObject({ code: "unsupported-model", correctablePreflight: true });
  expect(f.reserve).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
 }
 const invalid: ImageReference[][] = [[], Array(5).fill(reference), [{ bytes: Buffer.alloc(10 * 1024 * 1024 + 1), mime: "image/png" }], Array(3).fill({ bytes: Buffer.alloc(7 * 1024 * 1024), mime: "image/png" }), [{ bytes: png, mime: "image/jpeg" }]];
 for (const refs of invalid) { const f = fixture(); await expect(f.service.generate(request, f.hooks, refs)).rejects.toMatchObject({ code: "invalid-references" }); expect(f.reserve).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); }
});
it("B16 never retries rejected, uncertain, redirected or malformed Flux edits", async () => {
 for (const mode of [400, 403, 502, "timeout", "redirect", "multiple", "jpeg", "url"] as const) {
  const f = fixture(); f.fetcher.mockImplementationOnce(async () => {
   if (typeof mode === "number") return new Response("private provider error", { status: mode });
   if (mode === "timeout" || mode === "redirect") throw Error(mode);
   return Response.json({ data: mode === "multiple" ? [...response().data, ...response().data] : mode === "jpeg" ? [{ b64_json: Buffer.from([255,216,255,0]).toString("base64") }] : [{ url: "https://invalid.test/image.png" }] });
  });
  await expect(f.service.generate(request, f.hooks, [reference])).rejects.toMatchObject({ outcome: typeof mode === "number" && mode < 500 ? "failed" : "uncertain" });
  expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.publish).not.toHaveBeenCalled(); expect(f.finish).toHaveBeenCalledOnce();
 }
});
