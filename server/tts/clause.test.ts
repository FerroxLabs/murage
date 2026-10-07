import { afterEach, describe, expect, it, vi } from "vitest";

import { firstClauseBreak as firstClauseEnd, splitFirstClause, toUtterances } from "./speech-text.ts";
import { SentenceSplitter } from "../voice/voice-host.ts";
import { synthesizeClip } from "./flux-speech.ts";
import { RateLimitedError, retryOnRateLimit } from "./rate-limit.ts";
import type { VoiceEndpoint } from "../voice/voice-routes.ts";

const FLUX: VoiceEndpoint = { via: "flux", label: "Flux Router", baseUrl: "https://api.fluxrouter.ai/v1", key: "flux-test", model: "flux-voice-speak-grok" };
const words = (pieces: string[]) => pieces.join(" ").split(/\s+/).filter(Boolean);

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MURAGE_FLUX_AUDIO_API;
});

describe("the first clause", () => {
  it("breaks after 4 to 8 words at a comma, semicolon or colon followed by a space", () => {
    expect(splitFirstClause("Well, as far as I know, the meeting is on Tuesday at noon.")).toEqual(["Well, as far as I know,", "the meeting is on Tuesday at noon."]);
    expect(splitFirstClause("Here is what I found; the report is ready for you.")).toEqual(["Here is what I found;", "the report is ready for you."]);
  });
  it("waits past a break that is too early, and ignores one that is too late", () => {
    expect(firstClauseEnd("Yes, sure, I can look at that now, thanks")).toBe("Yes, sure, I can look at that now,".length);
    expect(firstClauseEnd("This opening clause has far too many words in it, so wait")).toBe(-1);
  });
  it("never splits numbers, times or a sentence with too little left", () => {
    expect(firstClauseEnd("It costs about 1,000 dollars for all of it")).toBe(-1);
    expect(firstClauseEnd("Come at 3:30 to the main office on time")).toBe(-1);
    expect(splitFirstClause("I think that is right, yes.")).toBeNull();
  });
  it("leaves the first utterance of a prepared reply as a clause and its rest, losing nothing", () => {
    const text = "Sure, I can move the call to Thursday, and send everyone a note. Then we are done.";
    const out = toUtterances(text);
    expect(out[0]).toBe("Sure, I can move the call to Thursday,");
    expect(out.join(" ")).toBe(text);
  });
});

describe("the streamed split", () => {
  it("sends the clause as soon as it is complete, then the rest of the sentence once, with nothing repeated or lost", () => {
    const text = "Okay, so the invoice went out on Monday, and the client paid it already. Anything else?";
    const splitter = new SentenceSplitter({ rule: "short" });
    const out: string[] = [];
    let atClause = -1;
    for (const [i, piece] of (text.match(/.{1,5}/g) ?? []).entries()) {
      const got = splitter.push(piece);
      if (got.length && atClause < 0) atClause = i;
      out.push(...got);
    }
    out.push(...splitter.flush());
    expect(out[0]).toBe("Okay, so the invoice went out on Monday,");
    expect(out).toEqual(["Okay, so the invoice went out on Monday,", "and the client paid it already.", "Anything else?"]);
    expect(words(out)).toEqual(words([text]));
    // the clause left long before the sentence ended
    expect(atClause).toBeLessThan(Math.floor(text.indexOf("already") / 5));
  });
  it("only the first sentence of a reply is split", () => {
    const splitter = new SentenceSplitter();
    const out = splitter.push("Yes. Well, as far as I know, the plan holds for now. ");
    expect(out).toEqual(["Yes.", "Well, as far as I know, the plan holds for now."]);
  });
  it("splits a whole first sentence that arrives in one piece", () => {
    const out = new SentenceSplitter({ rule: "short" }).push("Well, as far as I know, the plan holds for now. ");
    expect(out).toEqual(["Well, as far as I know,", "the plan holds for now."]);
  });
  it("keeps a clause the promise filter would drop inside its sentence", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push("I will be right back shortly, with the numbers now ")).toEqual([]);
  });
  it("records timing as numbers only, never the words", () => {
    let t = 1000;
    const splitter = new SentenceSplitter({ rule: "short", now: () => t });
    splitter.push("Okay, ");
    t = 1450;
    splitter.push("so the invoice went out on Monday, and");
    expect(splitter.clauseTiming).toEqual({ afterFirstTokenMs: 450, words: 8 });
    expect(JSON.stringify(splitter.clauseTiming)).not.toMatch(/invoice|Monday/);
  });
});

describe("rate limits", () => {
  it("waits once and tries again on a 429", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await retryOnRateLimit(
      async () => {
        calls += 1;
        if (calls === 1) throw new RateLimitedError("slow down");
        return "audio";
      },
      { wait: async (ms) => void waits.push(ms) },
    );
    expect(result).toBe("audio");
    expect(calls).toBe(2);
    expect(waits).toHaveLength(1);
  });
  it("gives up after the second 429, and never retries another failure", async () => {
    const wait = vi.fn(async () => {});
    await expect(retryOnRateLimit(async () => { throw new RateLimitedError("again"); }, { wait })).rejects.toBeInstanceOf(RateLimitedError);
    expect(wait).toHaveBeenCalledTimes(1);
    const other = vi.fn(async () => { throw new Error("boom"); });
    await expect(retryOnRateLimit(other, { wait })).rejects.toThrow("boom");
    expect(other).toHaveBeenCalledTimes(1);
  });
  it("Flux's 429 is a RateLimitedError carrying a capped retry-after", async () => {
    const call = (async () => new Response("{}", { status: 429, headers: { "retry-after": "999" } })) as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = await synthesizeClip("Hello there friend.", "eve", FLUX, true, call).catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.retryAfterMs).toBe(3000);
  });
});

describe("speech timing", () => {
  it("reads x-flux-ttfb-ms from the Flux stub and carries it with the clip, sent to the stub's base", async () => {
    process.env.MURAGE_FLUX_AUDIO_API = "http://127.0.0.1:9/v1/";
    let url = "";
    const call = (async (u: string) => {
      url = u;
      return new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/mpeg", "x-flux-ttfb-ms": "412" } });
    }) as typeof fetch;
    const clip = await synthesizeClip("Hello there friend.", "eve", FLUX, false, call);
    expect(url).toBe("http://127.0.0.1:9/v1/audio/speech");
    expect(clip.timing?.fluxTtfbMs).toBe(412);
    expect(clip.timing?.headersMs).toBeGreaterThanOrEqual(0);
  });
  it("ignores a header that is not a number", async () => {
    const call = (async () => new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "audio/mpeg", "x-flux-ttfb-ms": "soon" } })) as typeof fetch;
    const clip = await synthesizeClip("Hello there friend.", "eve", FLUX, false, call);
    expect(clip.timing?.fluxTtfbMs).toBeUndefined();
  });
  it("an own OpenAI key carries no gateway time", async () => {
    const call = (async () => new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "audio/mpeg", "x-flux-ttfb-ms": "5" } })) as typeof fetch;
    const clip = await synthesizeClip("Hello there friend.", "marin", { ...FLUX, via: "openai", model: "gpt-4o-mini-tts" }, false, call);
    expect(clip.timing?.fluxTtfbMs).toBeUndefined();
  });
  it("the voice-diag lines carry no text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const text = "Okay, so the secret invoice went out on Monday, and it is paid already. ";
    new SentenceSplitter().push(text);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|invoice|Monday/);
  });
});
