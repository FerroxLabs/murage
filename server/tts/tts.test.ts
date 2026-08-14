// Voice providers, driven against a stub rather than the live services —
// same rule as the box and computer-proxy contract tests: the shape of the
// request we send and the way a refusal is reported are the things that
// break, so they are the things pinned here.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";

let server: Server;
let base = "";
/** every request the stub saw, so tests can assert on what we sent */
const seen: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = [];
/** flipped by tests that want the provider to refuse */
let refuse: { status: number; body: unknown } | null = null;

const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22, 0x33, 0x44]);

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
        body,
      });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (refuse) return send(refuse.status, refuse.body);

      const path = (req.url ?? "").split("?")[0];
      // ── ElevenLabs ──
      if (path === "/el/user") return send(200, { subscription: {} });
      if (path === "/el/voices") {
        return send(200, {
          voices: [{ voice_id: "v-1", name: "Rachel", labels: { accent: "american", description: "calm" } }],
        });
      }
      if (path.startsWith("/el/text-to-speech/")) {
        res.writeHead(200, { "content-type": "audio/mpeg" });
        return res.end(MP3);
      }
      // ── Cartesia ──
      if (path === "/ct/voices/") return send(200, { data: [{ id: "c-1", name: "Sonic", description: "warm" }] });
      if (path === "/ct/tts/bytes") {
        res.writeHead(200, { "content-type": "audio/mpeg" });
        return res.end(MP3);
      }
      send(404, { message: "no such stub route" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  process.env.OMB_ELEVENLABS_API = `${base}/el`;
  process.env.OMB_CARTESIA_API = `${base}/ct`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** Modules read their base URL at import time, so every test imports after
 * the stub is up. */
const providers = () => import("./index.ts");

const cfg = (tts: AppConfig["tts"]): AppConfig => ({ tts });

describe("provider selection", () => {
  it("defaults to the local voice, so a fresh install can speak", async () => {
    const { activeProvider, DEFAULT_PROVIDER_ID } = await providers();
    expect(activeProvider({}).id).toBe(DEFAULT_PROVIDER_ID);
    expect(activeProvider({}).needsKey).toBe(false);
  });

  it("falls back to the local voice when a hosted one has no key", async () => {
    const { activeProvider } = await providers();
    // a missing key must mean "a different voice", never silence
    expect(activeProvider(cfg({ provider: "elevenlabs" })).id).toBe("kokoro");
    expect(activeProvider(cfg({ provider: "elevenlabs", key: "k" })).id).toBe("elevenlabs");
  });

  it("treats a provider from a newer build as unknown, not fatal", async () => {
    const { activeProvider } = await providers();
    expect(activeProvider(cfg({ provider: "some-2027-voice", key: "k" })).id).toBe("kokoro");
  });

  it("never reports the key itself", async () => {
    const { describeProviders } = await providers();
    const described = describeProviders(cfg({ provider: "elevenlabs", key: "sk-secret", voice: "v-1" }));
    expect(described.configured).toBe(true);
    expect(JSON.stringify(described)).not.toContain("sk-secret");
    expect(described.voice).toBe("v-1");
  });

  it("hands the local voice back to the renderer instead of synthesizing it", async () => {
    const { speak, ClientSideVoice } = await providers();
    await expect(speak(cfg({ provider: "kokoro" }), "hello")).rejects.toBeInstanceOf(ClientSideVoice);
  });
});

describe("ElevenLabs", () => {
  const key = { provider: "elevenlabs", key: "el-key", voice: "v-1" };

  it("accepts a key the provider accepts", async () => {
    refuse = null;
    const { verifyVoiceKey } = await providers();
    expect(await verifyVoiceKey("elevenlabs", "el-key")).toEqual({ ok: true });
  });

  it("says what to do when the key is refused", async () => {
    refuse = { status: 401, body: { detail: "invalid api key" } };
    const { verifyVoiceKey } = await providers();
    const result = await verifyVoiceKey("elevenlabs", "nope");
    refuse = null;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/ElevenLabs rejected that key/i);
  });

  it("lists voices with their labels", async () => {
    const { listVoices } = await providers();
    const voices = await listVoices(cfg(key));
    expect(voices).toEqual([{ id: "v-1", label: "Rachel", description: "american · calm" }]);
  });

  it("asks for mp3 and sends the key as a header, never a query param", async () => {
    seen.length = 0;
    const { speak } = await providers();
    const audio = await speak(cfg(key), "hello there");
    expect(audio.mime).toBe("audio/mpeg");
    expect(Buffer.from(audio.bytes)).toEqual(MP3);

    const call = seen.at(-1)!;
    expect(call.method).toBe("POST");
    expect(call.url).toContain("/el/text-to-speech/v-1");
    expect(call.url).toContain("output_format=mp3");
    expect(call.headers["xi-api-key"]).toBe("el-key");
    expect(call.url).not.toContain("el-key");
    expect(JSON.parse(call.body)).toMatchObject({ text: "hello there", model_id: "eleven_flash_v2_5" });
  });

  it("surfaces the provider's own refusal rather than a bare status", async () => {
    refuse = { status: 429, body: { detail: "You have exceeded your quota." } };
    const { speak } = await providers();
    const failed = speak(cfg(key), "hi").catch((e: Error) => e.message);
    const message = await failed;
    refuse = null;
    expect(message).toContain("exceeded your quota");
  });
});

describe("Cartesia", () => {
  const key = { provider: "cartesia", key: "ct-key", voice: "c-1" };

  it("sends the dated version header the API requires", async () => {
    seen.length = 0;
    const { speak } = await providers();
    await speak(cfg(key), "hello");
    const call = seen.at(-1)!;
    expect(call.url).toContain("/ct/tts/bytes");
    expect(call.headers["cartesia-version"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(call.headers.authorization).toBe("Bearer ct-key");
    expect(JSON.parse(call.body)).toMatchObject({
      transcript: "hello",
      voice: { mode: "id", id: "c-1" },
      output_format: { container: "mp3" },
    });
  });

  it("lets config override the model and version when the API moves on", async () => {
    seen.length = 0;
    const { speak } = await providers();
    await speak(cfg({ ...key, options: { model: "sonic-9", version: "2027-01-01" } }), "hello");
    const call = seen.at(-1)!;
    expect(call.headers["cartesia-version"]).toBe("2027-01-01");
    expect(JSON.parse(call.body).model_id).toBe("sonic-9");
  });

  it("reads a paginated voice listing", async () => {
    const { listVoices } = await providers();
    expect(await listVoices(cfg(key))).toEqual([{ id: "c-1", label: "Sonic", description: "warm" }]);
  });
});
