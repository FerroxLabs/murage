// Flux transcription, driven against a stub rather than the live service —
// same rule as tts.test.ts: what we send, and how a refusal is reported,
// are the things that break.
//
// The refusal half carries most of the weight here. Flux returns 402 for a
// VALID key on a plan that does not cover voice, and that is the one status
// no other transcription service returns; collapsing it into a generic
// failure would tell a paying-capable user to check their key forever.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  MAX_AUDIO_BYTES,
  TranscriptionUnavailable,
  transcribe,
  transcriptionConfigured,
} from "./flux-voice.ts";

let server: Server;
/** every request the stub saw, so tests can assert on what we sent */
const seen: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = [];
/** flipped by tests that want Flux to refuse */
let refuse: { status: number; body: unknown } | null = null;

const KEY = "sk-flux-test-key";
/** a token OGG header; the stub never decodes it, the client never inspects it */
const CLIP = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);

function env() {
  return { FLUX_API_KEY: KEY } as unknown as NodeJS.ProcessEnv;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
        // latin1 keeps the multipart field headers readable without
        // mangling the binary part in between them
        body: Buffer.concat(chunks).toString("latin1"),
      });
      if (refuse) {
        res.writeHead(refuse.status, { "content-type": "application/json" });
        return res.end(JSON.stringify(refuse.body));
      }
      if ((req.url ?? "").split("?")[0] === "/audio/transcriptions") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-flux-routed-model": "flux-voice-accurate",
          "x-flux-billed-seconds": "10",
        });
        return res.end(
          JSON.stringify({ task: "transcribe", language: "en", duration: 3.2, text: "  ship it  ", segments: [] }),
        );
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "no such stub route" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  process.env.MURAGE_FLUX_AUDIO_API = `http://127.0.0.1:${port}`;
});

afterEach(() => {
  seen.length = 0;
  refuse = null;
});

afterAll(async () => {
  delete process.env.MURAGE_FLUX_AUDIO_API;
  await new Promise<void>((r) => server.close(() => r()));
});

describe("what we send", () => {
  it("posts the clip as multipart with the public alias and the verbose shape", async () => {
    await transcribe({ bytes: CLIP, filename: "clip.ogg", mime: "audio/ogg" }, { env: env() });

    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/audio/transcriptions");
    // Bearer, not a vendor header: the same credential the chat surfaces use
    expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(request.body).toContain('name="file"; filename="clip.ogg"');
    // the PUBLIC alias, never a backing engine name Flux could withdraw
    expect(request.body).toContain('name="model"');
    expect(request.body).toContain("flux-voice");
    expect(request.body).not.toMatch(/whisper/i);
    // verbose_json is what carries duration and language back
    expect(request.body).toContain("verbose_json");
  });

  it("omits language and prompt when they were not asked for, and truncates an oversized prompt", async () => {
    await transcribe({ bytes: CLIP, filename: "clip.ogg" }, { env: env() });
    expect(seen[0].body).not.toContain('name="language"');
    expect(seen[0].body).not.toContain('name="prompt"');

    seen.length = 0;
    await transcribe(
      { bytes: CLIP, filename: "clip.ogg" },
      { env: env(), language: "en", prompt: "x".repeat(5_000) },
    );
    expect(seen[0].body).toContain('name="language"');
    // capped at the documented 2000, so an overlong hint is a shorter hint
    // rather than a 400 the user cannot act on
    expect(seen[0].body.match(/x{100,}/)?.[0].length).toBe(2000);
  });
});

describe("what we get back", () => {
  it("returns the trimmed text plus the transparency headers", async () => {
    const result = await transcribe({ bytes: CLIP, filename: "clip.ogg" }, { env: env() });
    expect(result.text).toBe("ship it");
    expect(result.language).toBe("en");
    expect(result.duration).toBe(3.2);
    expect(result.model).toBe("flux-voice-accurate");
    expect(result.billedSeconds).toBe(10);
  });
});

describe("refusals", () => {
  /** Every refusal must arrive as a reason a caller can branch on, never a
   *  message a caller has to parse. */
  async function reasonFor(status: number, body: unknown): Promise<TranscriptionUnavailable> {
    refuse = { status, body };
    try {
      await transcribe({ bytes: CLIP, filename: "clip.ogg" }, { env: env() });
    } catch (error) {
      return error as TranscriptionUnavailable;
    }
    throw new Error(`expected ${status} to refuse`);
  }

  it("keeps 402 distinct from a bad key, and does not mark it retryable", async () => {
    const paid = await reasonFor(402, { error: { code: "premium_locked", message: "premium locked" } });
    expect(paid).toBeInstanceOf(TranscriptionUnavailable);
    // the key is FINE; retrying it forever is the failure this guards
    expect(paid.reason).toBe("premium");
    expect(paid.retryable).toBe(false);
    expect(paid.message).toMatch(/paid Flux plan/);

    const badKey = await reasonFor(401, { error: { message: "invalid key" } });
    expect(badKey.reason).toBe("auth");
    expect(badKey.reason).not.toBe(paid.reason);
  });

  it("maps the rest of the status table onto its own reason", async () => {
    expect((await reasonFor(404, {})).reason).toBe("unavailable");
    expect((await reasonFor(413, {})).reason).toBe("too_large");
    expect((await reasonFor(400, {})).reason).toBe("format");
    expect((await reasonFor(502, {})).reason).toBe("upstream");
  });

  it("marks only the transient statuses retryable", async () => {
    expect((await reasonFor(429, {})).retryable).toBe(true);
    expect((await reasonFor(502, {})).retryable).toBe(true);
    expect((await reasonFor(413, {})).retryable).toBe(false);
    expect((await reasonFor(400, {})).retryable).toBe(false);
  });

  it("never puts the key in a message it could show someone", async () => {
    const failure = await reasonFor(401, { error: { message: `key ${KEY} is invalid` } });
    expect(failure.message).not.toContain(KEY);
  });
});

describe("refusals decided locally", () => {
  it("refuses with no key, without reaching the network", async () => {
    const empty = {} as unknown as NodeJS.ProcessEnv;
    await expect(transcribe({ bytes: CLIP, filename: "clip.ogg" }, { env: empty })).rejects.toMatchObject({
      reason: "key",
    });
    expect(seen).toHaveLength(0);
    expect(transcriptionConfigured(empty)).toBe(false);
    expect(transcriptionConfigured(env())).toBe(true);
  });

  it("refuses an oversized clip before spending the uplink on it", async () => {
    const huge = new Uint8Array(MAX_AUDIO_BYTES + 1);
    await expect(transcribe({ bytes: huge, filename: "clip.ogg" }, { env: env() })).rejects.toMatchObject({
      reason: "too_large",
    });
    // the point of the local cap: a phone learns now, not after the upload
    expect(seen).toHaveLength(0);
  });

  /** POSITIVE CONTROL for the two assertions above: the rig must be able to
   *  SEE a request. A clip one byte under the cap goes out, so "seen is
   *  empty" above is evidence of a refusal and not of a blind stub. */
  it("sends a clip that is exactly at the cap", async () => {
    const atCap = new Uint8Array(MAX_AUDIO_BYTES);
    atCap.set(CLIP);
    await transcribe({ bytes: atCap, filename: "clip.ogg" }, { env: env() });
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("refuses an empty recording", async () => {
    await expect(transcribe({ bytes: new Uint8Array(), filename: "clip.ogg" }, { env: env() })).rejects.toMatchObject({
      reason: "format",
    });
    expect(seen).toHaveLength(0);
  });
});
