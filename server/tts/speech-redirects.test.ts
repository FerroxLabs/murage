// A speech key is never sent on to wherever a redirect points.
//
// fetch keeps a custom header such as ElevenLabs' xi-api-key across a
// redirect, even to another origin, and a 307 or 308 also replays the body,
// which is the text being spoken. Every speech request that carries a key
// sets `redirect: "error"`. Here a local server answers every request with a
// 307 to a second local server, and the second one must never be reached.
import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { VoiceEndpoint } from "../voice/voice-routes.ts";

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

const reached: Array<{ url: string; key: string | undefined; authorization: string | undefined; body: string }> = [];
const elsewhere = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    reached.push({
      url: req.url ?? "",
      key: req.headers["xi-api-key"] as string | undefined,
      authorization: req.headers.authorization,
      body,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ voices: [] }));
  });
});
let elsewhereBase = "";
let redirects = 0;
const redirector = createServer((req, res) => {
  req.resume();
  redirects += 1;
  res.writeHead(307, { location: `${elsewhereBase}${req.url}` });
  res.end();
});
let redirectorBase = "";

let eleven: typeof import("./elevenlabs.ts");
let flux: typeof import("./flux-speech.ts");

beforeAll(async () => {
  elsewhereBase = await listen(elsewhere);
  redirectorBase = await listen(redirector);
  // elevenlabs.ts reads its base URL once, when it loads.
  vi.stubEnv("MURAGE_ELEVENLABS_API", `${redirectorBase}/v1`);
  vi.stubEnv("MURAGE_FLUX_AUDIO_API", "");
  vi.resetModules();
  eleven = await import("./elevenlabs.ts");
  flux = await import("./flux-speech.ts");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all([elsewhere, redirector].map((server) => new Promise((resolve) => server.close(resolve))));
});

const fresh = () => {
  reached.length = 0;
  redirects = 0;
};

describe("ElevenLabs requests refuse redirects", () => {
  it("does not send the key on when checking it", async () => {
    fresh();
    expect((await eleven.verifyKey("el-secret")).ok).toBe(false);
    expect(redirects).toBe(1);
    expect(reached).toEqual([]);
  });

  it("does not send the key on when listing voices", async () => {
    fresh();
    await expect(eleven.listVoices("el-secret")).rejects.toThrow();
    expect(redirects).toBe(1);
    expect(reached).toEqual([]);
  });

  it("does not send the key or the words on when speaking, streamed or not", async () => {
    fresh();
    await expect(eleven.synthesize("private words", "v-1", "el-secret")).rejects.toThrow();
    await expect(eleven.synthesizeClip("private words", "v-1", "el-secret", true)).rejects.toThrow();
    expect(redirects).toBe(2);
    expect(reached).toEqual([]);
  });
});

describe("OpenAI-shaped speech requests refuse redirects", () => {
  const direct = (): VoiceEndpoint => ({ via: "openai", label: "OpenAI", baseUrl: `${redirectorBase}/v1`, key: "sk-secret", model: "gpt-4o-mini-tts" });
  const viaFlux = (): VoiceEndpoint => ({ via: "flux", label: "Flux", baseUrl: `${redirectorBase}/v1`, key: "flux-secret", model: "gpt-4o-mini-tts" });

  it("does not send the key or the words on when speaking", async () => {
    fresh();
    await expect(flux.synthesizeClip("private words", "marin", direct(), false, fetch, 0)).rejects.toThrow();
    await expect(flux.synthesizeClip("private words", "marin", viaFlux(), false, fetch, 0)).rejects.toThrow();
    // one fast retry each, and every attempt stops at the redirect
    expect(redirects).toBeGreaterThanOrEqual(2);
    expect(reached).toEqual([]);
  });

  it("does not send the key on when reading Flux's ElevenLabs voices", async () => {
    fresh();
    expect(await flux.readElevenCatalog(viaFlux(), fetch).catch(() => null)).toBeNull();
    expect(redirects).toBe(1);
    expect(reached).toEqual([]);
  });
});
