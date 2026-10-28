import { expect, it, vi } from "vitest";
import { ImageGenerationService, imageFailureLogLine, type ImageConnection, type ImageProvider } from "./image-generation.ts";

// One line in the server log per failed image request, and a provider's
// own words reaching the bot. Sean's 1.0.8 log had no line at all for a
// failed Grok (xAI) image, so nothing could say why it failed.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const KEY = "xai-FAKECANARYKEYFAKECANARYKEYFAKECANARYKEY0000"; // secret-scan: fixture
const PROMPT = "PROMPT_CANARY a lighthouse at dusk";

function fixture(provider: ImageProvider, respond: () => Promise<Response>) {
  const connection: ImageConnection = { id: provider, provider, apiKey: KEY, revision: "initial" };
  const fetcher = vi.fn<typeof fetch>(async () => respond());
  const lines: string[] = [];
  const service = new ImageGenerationService({ resolveConnection: id => id === provider ? connection : null, connectionIds: () => [provider], fetch: fetcher, log: line => lines.push(line) });
  const hooks = { assertActive: () => {}, reserve: async () => ({ finish: async () => {} }), publish: async () => ({ id: "artifact" }) };
  return { service, fetcher, lines, hooks };
}
const xai = { connectionId: "xai", model: "grok-imagine-image-2.0", prompt: PROMPT };

it("tells the bot what xAI objected to when its error is a string under error", async () => {
  const f = fixture("xai", async () => new Response(JSON.stringify({ code: "Client specified an invalid argument", error: "Argument not supported: quality" }), { status: 400 }));
  await expect(f.service.generate(xai, f.hooks)).rejects.toMatchObject({ code: "provider-error", outcome: "failed",
    message: "The selected image provider rejected the request (HTTP 400): Client specified an invalid argument: Argument not supported: quality. No fallback or automatic retry was attempted." });
  expect(f.lines).toEqual(["[images] request failed provider=xai model=grok-imagine-image-2.0 status=400 code=provider-error outcome=failed"]);
});

it("keeps the object-shaped error body (Flux, OpenAI) as before", async () => {
  const f = fixture("xai", async () => new Response(JSON.stringify({ error: { code: "moderation_blocked", message: "Blocked by safety." } }), { status: 400 }));
  await expect(f.service.generate(xai, f.hooks)).rejects.toThrow("(HTTP 400): moderation_blocked: Blocked by safety.");
});

it("logs a request that never got a reply with which wall it hit, and tells the bot in words", async () => {
  const f = fixture("xai", async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.x.ai"), { code: "ENOTFOUND" }) }); });
  await expect(f.service.generate(xai, f.hooks)).rejects.toMatchObject({ code: "provider-unreachable", message: expect.stringContaining("could not be reached: its address could not be looked up") });
  expect(f.lines).toHaveLength(1);
  expect(f.lines[0]).toMatch(/^\[images\] request failed provider=xai model=grok-imagine-image-2\.0 status=none code=provider-unreachable transport=dns outcome=/);
});

it("logs local refusals once, with the model shown as default when none was named", async () => {
  const f = fixture("xai", async () => new Response("{}"));
  await expect(f.service.generate({ connectionId: "xai", prompt: PROMPT }, f.hooks)).rejects.toMatchObject({ code: "model-required", correctablePreflight: true });
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.lines).toEqual(["[images] request failed provider=xai model=default status=none code=model-required outcome=not-dispatched"]);
});

it("never puts the prompt, the key or the provider's message text in the log line", async () => {
  const f = fixture("xai", async () => new Response(JSON.stringify({ code: "Unauthenticated", error: `Incorrect API key provided: ${KEY}. ${PROMPT}` }), { status: 401 }));
  await expect(f.service.generate(xai, f.hooks)).rejects.toMatchObject({ code: "provider-error" });
  const all = f.lines.join("\n");
  expect(f.lines).toHaveLength(1);
  expect(all).toContain("status=401");
  for (const secret of [KEY, "PROMPT_CANARY", "Incorrect API key", "Unauthenticated"]) expect(all).not.toContain(secret);
  expect(imageFailureLogLine("xai", "not a model id; rm -rf", new Error("x"))).toContain("model=invalid");
  // A key passed by mistake as the model id is never printed.
  expect(imageFailureLogLine("xai", KEY, new Error("x"))).toContain("model=invalid");
  expect(imageFailureLogLine("openai", "sk-proj-FAKECANARYFAKECANARYFAKECANARY0000", new Error("x"))).toContain("model=invalid"); // secret-scan: fixture
});

it("logs nothing when the image arrives", async () => {
  const f = fixture("xai", async () => new Response(JSON.stringify({ data: [{ b64_json: PNG }] })));
  await f.service.generate(xai, f.hooks);
  expect(f.lines).toEqual([]);
});

it("a failing logger never changes what the bot is told", async () => {
  const connection: ImageConnection = { id: "xai", provider: "xai", apiKey: KEY, revision: "initial" };
  const service = new ImageGenerationService({ resolveConnection: () => connection, connectionIds: () => ["xai"], fetch: async () => new Response("{}", { status: 503 }), log: () => { throw new Error("log down"); } });
  await expect(service.generate(xai, { assertActive: () => {}, reserve: async () => ({ finish: async () => {} }), publish: async () => ({ id: "a" }) })).rejects.toMatchObject({ code: "provider-error", message: expect.stringContaining("HTTP 503") });
});
