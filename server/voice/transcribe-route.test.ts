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
  BUDGET_MAX_BILLED_SECONDS,
  BUDGET_MAX_REQUESTS,
  BUDGET_WINDOW_MS,
  MAX_CLIP_BYTES,
  createVoiceBudget,
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

/** Held open by the concurrency test so two clips can be in flight at once. */
let gate: Promise<void> | null = null;
/** Always callable, so a test that fails BEFORE its own release() cannot
 *  strand two requests parked on a promise nobody will ever resolve. That is
 *  not hypothetical: it stranded them, `afterAll` blocked closing the server,
 *  and the whole FILE died on "Hook timed out in 30000ms" — but only in the
 *  full suite, because only there was the machine slow enough to miss the
 *  8s deadline in the first place. A cleanup that depends on the happy path
 *  turns one flaky assertion into a file-wide failure. */
let releaseGate: () => void = () => {};
/** A fresh budget per test — a rolling window is deliberately stateful, and
 *  a suite that shared one would have its result depend on file order. */
let budget = createVoiceBudget();

let server: Server;
let base = "";

/** How many times `handleTranscribeRoute` has RETURNED.
 *
 * The only way to observe that the handler settled at all. A promise that
 * never resolves writes no response and throws nothing — from the client's
 * side it is indistinguishable from a slow network, and from the server's
 * side it is a leaked request object per abandoned upload. Counting returns
 * is what tells those apart. */
let completions = 0;
const awaitCompletions = (target: number, ms = 3_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (completions >= target) return resolve();
      if (Date.now() - started > ms) {
        return reject(new Error(`the handler never returned (${completions} of ${target} after ${ms}ms)`));
      }
      setTimeout(tick, 10);
    };
    tick();
  });

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
        if (gate) await gate;
        if ("throws" in answer) throw answer.throws;
        return answer.ok;
      },
      budget,
    });
    // The dispatcher's own fall-through, reproduced: a false return has to
    // leave the response untouched for every route below.
    if (!handled) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
    completions += 1;
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

beforeEach(() => {
  seen = [];
  completions = 0;
  releaseGate();
  releaseGate = () => {};
  gate = null;
  budget = createVoiceBudget();
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

  it("refuses an undocumented backing-engine synonym rather than passing it through", async () => {
    const bogus = await post(CLIP, { query: "?model=whisper-large-v3" });
    // never a passthrough Flux could withdraw without notice
    expect(bogus.status).toBe(400);
    expect(seen).toHaveLength(0);
    // NOTE: this used to also assert that `?model=flux-voice-accurate` was
    // honoured "deliberately". It is not honoured any more, and the reason is
    // in "does not let a remote caller select the more expensive arm" below:
    // the only caller that parameter ever had was one choosing to spend more
    // of somebody else's money on a route a phone can reach.
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
    const huge = new Uint8Array(MAX_CLIP_BYTES + 1);
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
            `content-length: ${MAX_CLIP_BYTES + 1}\r\n\r\n`,
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
    const atCap = new Uint8Array(MAX_CLIP_BYTES);
    atCap.set(CLIP);
    const res = await post(atCap);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].byteLength).toBe(MAX_CLIP_BYTES);
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

describe("a client that walks away mid-upload", () => {
  it("settles the read instead of leaking a permanently pending promise", async () => {
    // A phone that leaves tailnet range between the release and the end of
    // the upload. `readAudio` listened for "error" only, and an
    // IncomingMessage does NOT emit "error" when the peer vanishes — it emits
    // "aborted"/"close". So the promise never settled, the handler never
    // returned, and every abandoned upload left one request object and its
    // buffered chunks alive for as long as the harness ran.
    const { connect } = await import("node:net");
    const port = Number(new URL(base).port);
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          "POST /api/voice/transcribe HTTP/1.1\r\n" +
            "host: 127.0.0.1\r\n" +
            "content-type: audio/webm\r\n" +
            "content-length: 4096\r\n\r\n",
        );
        // eight of the promised four thousand bytes, and then the peer is gone
        socket.write(Buffer.from(CLIP));
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 50);
      });
      socket.on("error", reject);
    });
    await awaitCompletions(1);
    // and a half-received clip is never sent to be billed
    expect(seen).toHaveLength(0);
  });

  /** POSITIVE control: the counter moves for an ordinary request, so a
   *  stalled count above is the leak and not a counter that never ticks. */
  it("counts an ordinary request as completed", async () => {
    await post(CLIP);
    await awaitCompletions(1);
  });
});

describe("a chunked client that is still uploading when it is refused", () => {
  it("cuts the socket on the running-total 413 instead of draining to requestTimeout", async () => {
    // No content-length, so the header precheck cannot fire and the running
    // total is the only defence. Writing the 413 is not enough on its own:
    // the client is mid-upload and, with the request stream left open, Node
    // keeps reading its bytes into a discard loop until the default
    // 300-second `requestTimeout` notices. Five minutes of the harness's
    // uplink, per refused request, for bytes already refused.
    const { connect } = await import("node:net");
    const port = Number(new URL(base).port);
    const outcome = await new Promise<{ status: string; closed: boolean }>((resolve) => {
      let status = "";
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          "POST /api/voice/transcribe HTTP/1.1\r\n" +
            "host: 127.0.0.1\r\n" +
            "content-type: audio/webm\r\n" +
            "transfer-encoding: chunked\r\n\r\n",
        );
        const megabyte = Buffer.alloc(1024 * 1024, 0x61);
        for (let i = 0; i < 9; i += 1) {
          socket.write(`${megabyte.length.toString(16)}\r\n`);
          socket.write(megabyte);
          socket.write("\r\n");
        }
        // and deliberately NO terminating "0\r\n\r\n" — this client believes
        // it is still uploading.
      });
      socket.on("data", (chunk: Buffer) => {
        if (!status) status = chunk.toString("latin1").split("\r\n")[0];
      });
      const giveUp = setTimeout(() => {
        socket.destroy();
        resolve({ status, closed: false });
      }, 2_500);
      socket.on("error", () => {});
      socket.on("close", () => {
        clearTimeout(giveUp);
        resolve({ status, closed: true });
      });
    });
    expect(outcome.status).toContain("413");
    expect(outcome.closed).toBe(true);
    expect(seen).toHaveLength(0);
  });
});

// ── the bound on a billable path a phone can reach ───────────────────────
//
// The neighbouring TTS route says the risk out loud (`server/index.ts:9793`):
// "A hard ceiling prevents an arbitrary local request from turning the user's
// hosted voice account into an unbounded, billable synthesis job." It defends
// that with a 500-character cap. This route accepts a strictly larger and
// more expensive unit of work, and shipped with a single 8MB size check —
// which is not a bound on cost at all, because 8MB of Opus is around forty
// minutes of audio, billed by the second on the workspace's Flux key.
describe("what stops a stolen pairing token from spending the voice account", () => {
  it("refuses a third clip while two are already in flight", async () => {
    // Push to talk is a human holding a button. One person speaks once at a
    // time; two is slack for a previous request the client has already given
    // up on. Fifty concurrent 8MB POSTs is not a person, and without this the
    // harness buffers all fifty bodies at once and bills all fifty.
    let release = () => {};
    gate = new Promise<void>((r) => {
      release = r;
    });
    releaseGate = release;
    const first = post(CLIP);
    const second = post(CLIP);
    // Both must be INSIDE transcribe before the third arrives. DEADLINED, not
    // an open `while`: under full-suite load the two can be slow to arrive,
    // and an unbounded spin turns "the machine was busy" into a hang that
    // reads as a product bug. Say which it was instead.
    const deadline = Date.now() + 5_000;
    while (seen.length < 2) {
      if (Date.now() > deadline) {
        throw new Error(`only ${seen.length} of 2 clips reached transcribe in 5s — the machine was slow, not the cap`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    const third = await post(CLIP);
    expect(third.status).toBe(429);
    const body = await bodyOf(third);
    expect(body.reason).toBe("busy");
    expect(third.headers.get("retry-after")).toBeTruthy();
    // and the refused one never reached the meter
    expect(seen).toHaveLength(2);
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    // A short deadline on purpose: with no cap the third request is ACCEPTED
    // and blocks behind the same gate, so the honest failure here is a hang,
    // not a wrong status. Eight seconds names it as one.
  }, 8_000);

  it("refuses once the window's billed audio is spent", async () => {
    // Charged from what Flux actually reports it billed, not from a guess.
    answer = { ok: { text: "ship it", model: "flux-voice-fast", billedSeconds: BUDGET_MAX_BILLED_SECONDS } };
    expect((await post(CLIP)).status).toBe(200);
    const over = await post(CLIP);
    expect(over.status).toBe(429);
    expect((await bodyOf(over)).reason).toBe("budget");
    expect(seen).toHaveLength(1);
  });

  it("does not let a remote caller select the more expensive arm", async () => {
    // `?model=` was reachable from the phone and could ask for
    // `flux-voice-accurate`, or for `flux-voice` whose duration probe cannot
    // read a Matroska header and therefore falls to the accurate arm anyway.
    // Nothing in the tree sends it; the only thing it was reachable BY is an
    // attacker choosing the costlier engine.
    for (const model of ["flux-voice-accurate", "flux-voice"]) {
      const res = await post(CLIP, { query: `?model=${model}` });
      expect(res.status).toBe(400);
    }
    expect(seen).toHaveLength(0);
    // the pinned arm is still nameable, so a caller can be explicit
    expect((await post(CLIP, { query: "?model=flux-voice-fast" })).status).toBe(200);
    expect(seen[0].model).toBe("flux-voice-fast");
  });

  it("bounds one clip far below Flux's own 8MB, because 8MB is forty minutes", async () => {
    // The client stops itself at two minutes (`PushToTalk.MAX_CLIP_MS`).
    // MediaRecorder's most generous realistic audio bitrate is 128kbps, so
    // the largest clip a real person can produce is ~1.9MB. This cap is more
    // than double that — no normal user trips it — while cutting the
    // worst-case billed audio in a single request by half.
    expect(MAX_CLIP_BYTES).toBeLessThan(MAX_AUDIO_BYTES);
    const twoMinutesAt128kbps = (128_000 / 8) * 120;
    expect(MAX_CLIP_BYTES).toBeGreaterThan(twoMinutesAt128kbps * 2);
    const over = await post(new Uint8Array(MAX_CLIP_BYTES + 1));
    expect(over.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("forgets a spent window rather than locking a user out forever", () => {
    // Driven on its own clock, the way the sign-in limiter's is: a rolling
    // budget that never rolls is a permanent ban.
    const rolling = createVoiceBudget();
    const at = (now: number) => {
      const slot = rolling.begin(now);
      if (slot.ok) slot.done(BUDGET_MAX_BILLED_SECONDS, now);
      return slot.ok;
    };
    expect(at(0)).toBe(true);
    expect(at(1_000)).toBe(false);
    expect(at(BUDGET_WINDOW_MS + 1)).toBe(true);
  });

  it("never charges a user for a refusal that never reached the meter", () => {
    // A workspace with no Flux key would otherwise burn its whole budget on
    // 409s and then be told it is over budget, which is a lie and a loop.
    const rolling = createVoiceBudget();
    for (let i = 0; i < BUDGET_MAX_REQUESTS - 1; i += 1) {
      const slot = rolling.begin(0);
      expect(slot.ok).toBe(true);
      if (slot.ok) slot.done(0, 0);
    }
    const slot = rolling.begin(0);
    expect(slot.ok).toBe(true);
  });
});
