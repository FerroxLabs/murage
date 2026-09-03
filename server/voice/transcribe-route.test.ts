// The transcription route, driven against the registrar directly rather than
// through the whole harness. `handleTranscribeRoute` takes the four things
// the dispatcher already has, so a real `node:http` server that calls nothing
// but this function is the complete route — no 8811 port dance, no config
// file, no provider fleet.
//
// The refusals carry most of the weight, and one of them is not hypothetical:
// this workspace's real Flux key answers 402 `premium_locked` for
// transcription today (verified against api.fluxrouter.ai). A route that
// flattened that into a 502 would tell a user with a perfectly good key to
// keep checking their key forever.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MAX_AUDIO_BYTES, TranscriptionUnavailable, type Transcript } from "./flux-voice.ts";
import {
  ACCEPTED_CONTAINERS,
  DEFAULT_MODEL,
  TRANSCRIBE_PATH,
  containerOf,
  filenameFor,
  handleTranscribeRoute,
  isTranscriptionModel,
  statusForFailure,
} from "./transcribe-route.ts";

/** Every call the route made into flux-voice, so a test can assert on what
 *  it decided rather than on what it said. */
interface Seen {
  filename: string;
  mime?: string;
  byteLength: number;
  model?: string;
  language?: string;
  prompt?: string;
}
let seen: Seen[] = [];
/** What the stubbed transcribe should do next. */
let answer: { ok: Transcript } | { throws: unknown } = {
  ok: { text: "ship it", language: "en", duration: 3.2, model: "flux-voice-fast", billedSeconds: 4 },
};

let server: Server;
let base = "";

/** A token webm header. Nothing decodes it; the route only measures it. */
const CLIP = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await handleTranscribeRoute(req.method ?? "GET", url, req, res, {
      transcribe: async (recording, options) => {
        seen.push({
          filename: recording.filename,
          mime: recording.mime,
          byteLength: recording.bytes.byteLength,
          model: options?.model,
          language: options?.language,
          prompt: options?.prompt,
        });
        if ("throws" in answer) throw answer.throws;
        return answer.ok;
      },
    });
    // The dispatcher's own fall-through, reproduced: a false return has to
    // leave the response untouched for every route below.
    if (!handled) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

beforeEach(() => {
  seen = [];
  answer = { ok: { text: "ship it", language: "en", duration: 3.2, model: "flux-voice-fast", billedSeconds: 4 } };
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** The server tsconfig has no DOM lib, so `Response.json()` is `unknown`
 *  here rather than `any`. One cast, in one place. */
type Body = Record<string, unknown>;
const bodyOf = async (res: Response): Promise<Body> => ((await res.json()) as Body) ?? {};

function post(
  body: Uint8Array | string | null,
  init: { type?: string | null; query?: string; method?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.type !== null) headers["content-type"] = init.type ?? "audio/webm;codecs=opus";
  return fetch(`${base}${TRANSCRIBE_PATH}${init.query ?? ""}`, {
    method: init.method ?? "POST",
    headers,
    body,
  });
}

describe("what the route sends to Flux", () => {
  it("names the clip from the content-type, not from anything the client claims", async () => {
    const res = await post(CLIP);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    // the filename is the sniff, so a webm clip must not arrive called .ogg
    expect(seen[0].filename).toBe("clip.webm");
    expect(seen[0].mime).toBe("audio/webm");
    expect(seen[0].byteLength).toBe(CLIP.byteLength);
  });

  it("pins the fast Groq arm by default so the container stops picking the model", async () => {
    await post(CLIP);
    expect(seen[0].model).toBe("flux-voice-fast");
    expect(DEFAULT_MODEL).toBe("flux-voice-fast");
    // NOT the auto-picker: its duration probe cannot read a Matroska header,
    // which is the whole reason a webm clip used to fall to the slow arm.
    expect(seen[0].model).not.toBe("flux-voice");
  });

  it("lets a caller ask for the accurate arm deliberately, and refuses anything else", async () => {
    await post(CLIP, { query: "?model=flux-voice-accurate" });
    expect(seen[0].model).toBe("flux-voice-accurate");

    seen = [];
    const bogus = await post(CLIP, { query: "?model=whisper-large-v3" });
    // an undocumented backing-engine synonym is a 400 here, never a
    // passthrough Flux could withdraw
    expect(bogus.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("passes language and prompt through, and omits them when absent", async () => {
    await post(CLIP, { query: "?language=en&prompt=Murage" });
    expect(seen[0].language).toBe("en");
    expect(seen[0].prompt).toBe("Murage");

    seen = [];
    await post(CLIP);
    expect(seen[0].language).toBeUndefined();
    expect(seen[0].prompt).toBeUndefined();
  });

  it("returns the transcript and the transparency fields unchanged", async () => {
    const res = await post(CLIP);
    expect(await res.json()).toEqual({
      text: "ship it",
      language: "en",
      duration: 3.2,
      model: "flux-voice-fast",
      billedSeconds: 4,
    });
  });
});

describe("containers", () => {
  it("accepts every container Flux does, by the extension that tells the truth", () => {
    expect(filenameFor("audio/ogg")).toBe("clip.ogg");
    expect(filenameFor("audio/webm")).toBe("clip.webm");
    // Safari emits audio/mp4; .m4a is the spelling that says "no video track"
    expect(filenameFor("audio/mp4")).toBe("clip.m4a");
    expect(filenameFor("audio/wav")).toBe("clip.wav");
    expect(filenameFor("audio/mpeg")).toBe("clip.mp3");
    expect(filenameFor("audio/flac")).toBe("clip.flac");
  });

  it("strips the codecs parameter and lowercases before matching", () => {
    expect(containerOf("Audio/WebM;codecs=opus")).toBe("audio/webm");
    expect(containerOf(undefined)).toBeNull();
  });

  it("refuses an unknown container with 415, and never spends the upload on it", async () => {
    const res = await post(CLIP, { type: "video/mp4" });
    expect(res.status).toBe(415);
    expect((await bodyOf(res)).accepted).toBe(ACCEPTED_CONTAINERS);
    expect(seen).toHaveLength(0);
  });

  it("refuses a request with no content-type at all", async () => {
    const res = await post(CLIP, { type: null });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe("the cap, enforced before the uplink is spent", () => {
  it("refuses an oversize body with 413", async () => {
    // NOTE this one does NOT prove the header precheck on its own: with the
    // precheck removed it stays green, because the running total catches the
    // same body a moment later. The socket test below is the one that tells
    // the two apart, and it is where that claim lives.
    const huge = new Uint8Array(MAX_AUDIO_BYTES + 1);
    const res = await post(huge);
    expect(res.status).toBe(413);
    expect((await bodyOf(res)).reason).toBe("too_large");
    expect(seen).toHaveLength(0);
  });

  it("answers the declared oversize BEFORE the body arrives, not after", async () => {
    // The distinguishing test for the content-length precheck, and the only
    // one that can tell it apart from the running total: this socket declares
    // nine megabytes, sends eight bytes, and then says nothing ever. A route
    // that waited for the body would still be waiting. A 413 arriving here is
    // the header check firing on its own — which is the entire reason a phone
    // on a slow uplink learns now instead of after the upload.
    const { connect } = await import("node:net");
    const port = Number(new URL(base).port);
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          "POST /api/voice/transcribe HTTP/1.1\r\n" +
            "host: 127.0.0.1\r\n" +
            "content-type: audio/webm\r\n" +
            `content-length: ${MAX_AUDIO_BYTES + 1}\r\n\r\n`,
        );
        // eight bytes and then deliberate silence — the body never completes
        socket.write(Buffer.from(CLIP));
      });
      socket.setTimeout(4_000, () => {
        socket.destroy();
        reject(new Error("no response before the body finished — the precheck did not fire"));
      });
      socket.once("data", (chunk: Buffer) => {
        socket.destroy();
        resolve(chunk.toString("latin1").split("\r\n")[0]);
      });
      socket.on("error", reject);
    });
    expect(status).toContain("413");
    expect(seen).toHaveLength(0);
  });

  it("cuts a chunked body that lies about its size at the cap", async () => {
    // No content-length at all: the only defence left is the running total.
    const oversize = new ReadableStream<Uint8Array>({
      start(controller) {
        const megabyte = new Uint8Array(1024 * 1024);
        for (let i = 0; i < 9; i += 1) controller.enqueue(megabyte);
        controller.close();
      },
    });
    const res = await fetch(`${base}${TRANSCRIBE_PATH}`, {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: oversize,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  /** POSITIVE CONTROL for both refusals above: the rig can SEE a clip at the
   *  cap go through, so an empty `seen` is evidence of a refusal and not of a
   *  route that never calls anything. */
  it("sends a clip that is exactly at the cap", async () => {
    const atCap = new Uint8Array(MAX_AUDIO_BYTES);
    atCap.set(CLIP);
    const res = await post(atCap);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].byteLength).toBe(MAX_AUDIO_BYTES);
  });

  it("refuses an empty recording", async () => {
    const res = await post(new Uint8Array());
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).reason).toBe("format");
    expect(seen).toHaveLength(0);
  });
});

describe("refusals keep their meaning", () => {
  async function refuseWith(reason: Parameters<typeof statusForFailure>[0], message: string) {
    answer = { throws: new TranscriptionUnavailable(reason, message) };
    const res = await post(CLIP);
    return { status: res.status, body: await bodyOf(res) };
  }

  it("does not flatten a paid-plan refusal into a provider failure", async () => {
    // LIVE STATE, not a hypothetical: this workspace's key answers
    // 402 premium_locked for transcription right now.
    const paid = await refuseWith("premium", "Voice typing needs a paid Flux plan.");
    expect(paid.status).toBe(402);
    expect(paid.status).not.toBe(502);
    expect(paid.body.reason).toBe("premium");
    // and never 409 either — Settings has nothing to fix, the key is fine
    expect(paid.status).not.toBe(409);
    expect(paid.body.retryable).toBe(false);
  });

  it("says 'you have not set this up' with 409 and keeps it apart from a bad key", async () => {
    const noKey = await refuseWith("key", "Add a Flux key in Settings on the computer.");
    expect(noKey.status).toBe(409);
    const dark = await refuseWith("unavailable", "Voice typing is not switched on for this Flux account yet.");
    expect(dark.status).toBe(409);

    // a key that is PRESENT and rejected is a different sentence
    const rejected = await refuseWith("auth", "Flux rejected that key.");
    expect(rejected.status).toBe(401);
    expect(rejected.status).not.toBe(noKey.status);
  });

  it("maps the rest of the table the way the TTS routes would", async () => {
    expect((await refuseWith("too_large", "too big")).status).toBe(413);
    expect((await refuseWith("rate_limit", "slow down")).status).toBe(429);
    expect((await refuseWith("format", "unreadable")).status).toBe(400);
    expect((await refuseWith("upstream", "flux fell over")).status).toBe(502);
  });

  it("carries the reason in the body so a client branches on a value", async () => {
    const rate = await refuseWith("rate_limit", "slow down");
    expect(rate.body.reason).toBe("rate_limit");
    expect(rate.body.retryable).toBe(true);
    const format = await refuseWith("format", "unreadable");
    expect(format.body.retryable).toBe(false);
  });

  it("turns an unexpected throw into a 502 rather than a hang or a 500", async () => {
    answer = { throws: new Error("something nobody planned for") };
    const res = await post(CLIP);
    expect(res.status).toBe(502);
    expect((await bodyOf(res)).reason).toBe("upstream");
  });
});

describe("the registrar contract", () => {
  it("declines a path it does not own so every route below still runs", async () => {
    const res = await fetch(`${base}/api/tts/speak`, { method: "POST" });
    // 404 is the harness's fall-through in this rig, which only happens
    // because the registrar returned false and wrote nothing.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("answers 405 with an Allow header for its own path on the wrong verb", async () => {
    const res = await fetch(`${base}${TRANSCRIBE_PATH}`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("only admits the three public aliases", () => {
    expect(isTranscriptionModel("flux-voice")).toBe(true);
    expect(isTranscriptionModel("flux-voice-fast")).toBe(true);
    expect(isTranscriptionModel("flux-voice-accurate")).toBe(true);
    expect(isTranscriptionModel("whisper-large-v3-turbo")).toBe(false);
  });
});
