// SEAN-ASK-GROK-IMAGE (1.0.19) reproduction: the xAI (Grok Imagine) image
// path end to end through ImageGenerationService with a fake key and a test
// double for the network. No live key, no owner data.
import { expect, it, vi } from "vitest";
import { ImageGenerationService, type ImageConnection } from "./image-generation.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function fixture(reply: () => Response = () => new Response(JSON.stringify({ data: [{ b64_json: PNG }] }))) {
  const connection: ImageConnection = { id: "xai", provider: "xai", apiKey: "FAKE_XAI_KEY_CANARY", revision: "initial" };
  const fetcher = vi.fn<typeof fetch>(async () => reply());
  const service = new ImageGenerationService({ resolveConnection: id => id === "xai" ? connection : null, connectionIds: () => ["xai"], fetch: fetcher });
  const finish = vi.fn(async () => {}), publish = vi.fn(async () => ({ id: "owned-artifact" })), assertActive = vi.fn(() => {});
  const reserve = vi.fn(async () => ({ finish }));
  return { service, fetcher, finish, publish, hooks: { assertActive, reserve, publish } };
}

it("lists the xAI connection with no default model, so a call must name grok-imagine-image-2.0", () => {
  expect(fixture().service.listConnections()).toEqual([{ id: "xai", provider: "xai", defaultModel: null }]);
});

it("generates through xAI with the named model: one POST to /v1/images/generations, b64 back, published", async () => {
  const f = fixture();
  await f.service.generate({ connectionId: "xai", model: "grok-imagine-image-2.0", prompt: "A watercolor mountain" }, f.hooks);
  const posts = f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(posts).toHaveLength(1);
  const [url, init] = posts[0]!;
  expect(String(url)).toBe("https://api.x.ai/v1/images/generations");
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  expect(body).toMatchObject({ model: "grok-imagine-image-2.0", prompt: "A watercolor mountain", response_format: "b64_json" });
  // xAI takes no size: none is sent.
  expect(body).not.toHaveProperty("size");
  expect(f.publish).toHaveBeenCalledOnce();
});

it("without a model it stops before anything is sent and says which model to name", async () => {
  const f = fixture();
  await expect(f.service.generate({ connectionId: "xai", prompt: "A watercolor mountain" }, f.hooks)).rejects.toMatchObject({ code: "model-required" });
  expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  await expect(f.service.generate({ connectionId: "xai", prompt: "x" }, f.hooks)).rejects.toThrow("grok-imagine-image-2.0");
});

it("an xAI refusal reaches the caller as a failure, never as an empty success", async () => {
  const f = fixture(() => new Response(JSON.stringify({ error: "Incorrect API key provided" }), { status: 401 }));
  await expect(f.service.generate({ connectionId: "xai", model: "grok-imagine-image-2.0", prompt: "A watercolor mountain" }, f.hooks)).rejects.toBeTruthy();
  expect(f.publish).not.toHaveBeenCalled();
});
