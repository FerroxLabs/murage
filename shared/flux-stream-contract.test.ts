// shared/flux-stream-contract.test.ts
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  MAX_SESSION_CLOSE_REASON,
  SESSION_STARTS_PER_MINUTE,
  applyUpdate,
  billedSeconds,
  closeCodeFor,
  fatal,
  forbiddenQueryName,
  frameProblem,
  parseClientMessage,
  parseConnectQuery,
  parseServerMessage,
  reconcileTextEnd,
  resolveSilences,
  splitAfterFinals,
  spokenWords,
  settledThrough,
  streamUrl,
} from "./flux-stream-contract.ts";

describe("parseConnectQuery", () => {
  it("fills every default and reports unknown params", () => {
    expect(parseConnectQuery(new URLSearchParams("foo=1"))).toEqual({ ok: true, config: DEFAULT_CONFIG, ignored: ["foo"] });
  });

  it("reads scalars and repeated keyterms", () => {
    const parsed = parseConnectQuery(new URLSearchParams("sample_rate=24000&eagerness=low&keyterms=Sable&keyterms=Heartbreak Ridge&words=true"));
    expect(parsed.ok && parsed.config).toMatchObject({ sample_rate: 24000, eagerness: "low", keyterms: ["Sable", "Heartbreak Ridge"], words: true });
  });

  it("accepts a comma list for keyterms", () => {
    const parsed = parseConnectQuery(new URLSearchParams("keyterms=Sable,Murage"));
    expect(parsed.ok && parsed.config.keyterms).toEqual(["Sable", "Murage"]);
  });

  it("rejects a bad sample rate with the param named", () => {
    expect(parseConnectQuery(new URLSearchParams("sample_rate=44100"))).toMatchObject({ ok: false, error: { code: "invalid_param", param: "sample_rate", close_code: 4400, fatal: true } });
  });

  it("refuses a key in the query string, naming the parameter as sent", () => {
    expect(parseConnectQuery(new URLSearchParams("APIKEY=not-a-flux-key"))).toMatchObject({ ok: false, error: { code: "invalid_param", param: "APIKEY", close_code: 4400 } });
    expect(forbiddenQueryName(new URLSearchParams("a=1&access_token=not-a-flux-key"))).toBe("access_token");
  });

  it("names a reserved model as not available", () => {
    expect(parseConnectQuery(new URLSearchParams("model=flux-voice-stream-multilingual"))).toMatchObject({ ok: false, error: { code: "model_not_available", close_code: 4400 } });
  });

  it("rejects max_silence_ms below min_silence_ms", () => {
    expect(parseConnectQuery(new URLSearchParams("min_silence_ms=900&max_silence_ms=500"))).toMatchObject({ ok: false, error: { param: "max_silence_ms" } });
  });

  it("validates the silences a preset resolves to, not only explicit pairs (Astra 2 I16)", () => {
    expect(parseConnectQuery(new URLSearchParams("eagerness=low&max_silence_ms=500"))).toMatchObject({ ok: false, error: { param: "max_silence_ms" } });
    const ok = parseConnectQuery(new URLSearchParams("eagerness=low&min_silence_ms=200&max_silence_ms=500"));
    expect(ok.ok && resolveSilences(ok.config)).toEqual({ min: 200, max: 500 });
    expect(resolveSilences(DEFAULT_CONFIG)).toEqual({ min: 400, max: 1280 });
  });

  it("treats sim-only params as known when asked", () => {
    const parsed = parseConnectQuery(new URLSearchParams("sim_script=f02-comma"), ["sim_script"]);
    expect(parsed.ok && parsed.ignored).toEqual([]);
  });
});

describe("applyUpdate", () => {
  it("changes a mutable field and clears keyterms with an empty list", () => {
    const { config, problem } = applyUpdate({ ...DEFAULT_CONFIG, keyterms: ["Sable"] }, { eagerness: "high", keyterms: [] });
    expect(problem).toBeNull();
    expect(config).toMatchObject({ eagerness: "high", keyterms: [] });
  });

  it("refuses an update whose resolved silences cross, keeping the config it had", () => {
    const { config, problem } = applyUpdate({ ...DEFAULT_CONFIG, max_silence_ms: 500 }, { eagerness: "low" });
    expect(problem).toMatchObject({ param: "max_silence_ms", fatal: false });
    expect(config.eagerness).toBe("medium");
  });

  it.each(["sample_rate", "format", "turn_detection", "idle_timeout_s"])("refuses immutable %s without changing anything", (field) => {
    const { config, problem } = applyUpdate(DEFAULT_CONFIG, { [field]: "x", eagerness: "low" });
    expect(config).toBe(DEFAULT_CONFIG);
    expect(problem).toMatchObject({ code: "config_immutable", param: field, fatal: false });
  });
});

describe("frames, codes and billing", () => {
  it("measures frames in milliseconds of 16-bit mono at any rate", () => {
    expect(frameProblem(2048, 16000)).toBeNull();
    expect(frameProblem(2047, 16000)).toMatchObject({ code: "invalid_audio_frame", close_code: 4400 });
    expect(frameProblem(320, 16000)).toMatchObject({ code: "invalid_audio_frame" });
    expect(frameProblem(35200, 16000)).toMatchObject({ code: "frame_too_large", close_code: 4413 });
    expect(frameProblem(960, 24000)).toBeNull();
    expect(frameProblem(320, 8000)).toBeNull();
  });

  it("closes with 4000 plus the Flux HTTP status", () => {
    for (const [code, close] of [["unauthorized", 4401], ["premium_locked", 4402], ["billing_unavailable", 4402], ["credit_exhausted", 4402], ["daily_cap", 4402],
      ["monthly_cap", 4402], ["credit_unresolved", 4402], ["forbidden", 4403], ["idle_timeout", 4408], ["concurrency_limit", 4429],
      ["capability_unavailable", 4502], ["slow_consumer", 4503], ["upstream_timeout", 4504], ["no_such_code", 4500]] as const) {
      expect(closeCodeFor(code)).toBe(close);
    }
    expect(fatal("rate_limit_error", "slow down", { retry_after_ms: 5000 })).toMatchObject({ type: "rate_limit_error", retry_after_ms: 5000 });
  });

  it("bills whole session seconds with a ten second floor, cumulatively", () => {
    expect(billedSeconds(3_200)).toBe(10);
    expect(billedSeconds(61_001)).toBe(62);
    expect(settledThrough(60_050, false)).toBe(60);
    expect(settledThrough(120_100, false)).toBe(120);
    expect(settledThrough(125_100, true)).toBe(126);
  });

  it("builds the stream url from a /v1 base", () => {
    expect(streamUrl("ws://127.0.0.1:8787/v1/", new URLSearchParams("sample_rate=16000"))).toBe("ws://127.0.0.1:8787/v1/audio/transcriptions/stream?sample_rate=16000");
  });
});

describe("messages", () => {
  it("parses a turn.end with server_lag_ms", () => {
    const raw = JSON.stringify({ type: "turn.end", seq: 9, received_audio_ms: 4410, turn: 0, text: "Blues Brothers, and Heartbreak Ridge.", reason: "endpoint", confidence: 1, audio_start_ms: 1150, audio_end_ms: 3470, server_lag_ms: 640 });
    expect(parseServerMessage(raw)).toMatchObject({ type: "turn.end", turn: 0, reason: "endpoint", server_lag_ms: 640 });
    // the provider's confidence is a silence ramp: no reason claims "semantic" (spike)
    expect(parseServerMessage(raw.replace('"endpoint"', '"semantic"'))).toBeNull();
  });

  it("parses turn.cancelled and a warning with at_audio_ms", () => {
    expect(parseServerMessage(JSON.stringify({ type: "turn.cancelled", seq: 3, received_audio_ms: 900, turn: 1 }))).toMatchObject({ type: "turn.cancelled", turn: 1 });
    expect(parseServerMessage(JSON.stringify({ type: "warning", seq: 2, received_audio_ms: 0, code: "audio_dropped", message: "x", dropped_ms: 640, at_audio_ms: 0 }))).toMatchObject({ at_audio_ms: 0 });
  });

  it("rejects a message missing seq", () => {
    expect(parseServerMessage(JSON.stringify({ type: "speech.started", received_audio_ms: 0, turn: 0, audio_ms: 10 }))).toBeNull();
  });

  it("classifies client messages", () => {
    expect(parseClientMessage('{"type":"turn.commit"}')).toEqual({ type: "turn.commit" });
    expect(parseClientMessage("{nope")).toEqual({ invalid: "invalid_json" });
    expect(parseClientMessage('{"type":"dance"}')).toEqual({ invalid: "unknown_message_type" });
  });
});

describe("spoken forms and text-only ends (Astra 3 I1, I10)", () => {
  it("reads numbers, times, ordinals and abbreviations aloud as the bake-off did", () => {
    expect(spokenWords("Call Casper at 4:30 about flight QF12.")).toEqual(["call", "casper", "at", "four", "thirty", "about", "flight", "qf", "twelve"]);
    expect(spokenWords("March 3rd")).toEqual(spokenWords("March third"));
    expect(spokenWords("Dr. Patel, 1945")).toEqual(["doctor", "patel", "nineteen", "forty", "five"]);
  });
  it("adds only the words after the finals, and lets a contradiction change nothing", () => {
    expect(reconcileTextEnd("twenty five", "25 dollars")).toEqual({ newFinal: "dollars", endText: "25 dollars", conflict: false });
    expect(reconcileTextEnd("", "Okay.")).toEqual({ newFinal: "Okay.", endText: "Okay.", conflict: false });
    expect(reconcileTextEnd("hello there", "Hello there.")).toEqual({ newFinal: null, endText: "Hello there.", conflict: false });
    expect(reconcileTextEnd("hello", "Bye.")).toEqual({ newFinal: null, endText: "hello", conflict: true });
  });
  it("keeps the new words when one formatted token covers a final and new words (Astra 4 I4)", () => {
    expect(splitAfterFinals("twenty", ["25", "dollars"])).toEqual({ k: 1, carry: ["five"] });
    expect(splitAfterFinals("twenty five", ["25", "dollars"])).toEqual({ k: 1, carry: [] });
    expect(splitAfterFinals("hello", ["Bye."])).toBeNull();
    expect(reconcileTextEnd("twenty", "25 dollars")).toEqual({ newFinal: "five dollars", endText: "25 dollars", conflict: false });
  });
});

describe("session limits (controller ruling R6)", () => {
  it("defaults the maximum session to three hours and closes with max_duration", () => {
    expect(DEFAULT_CONFIG.max_session_s).toBe(10_800);
    expect(MAX_SESSION_CLOSE_REASON).toBe("max_duration");
    const parsed = parseConnectQuery(new URLSearchParams("max_session_s=10800"));
    expect(parsed.ok && parsed.config.max_session_s).toBe(10_800);
    expect(parseConnectQuery(new URLSearchParams("max_session_s=10801"))).toMatchObject({ ok: false, error: { param: "max_session_s" } });
  });

  it("limits session starts to 90 a minute fleet-wide, refused as a retryable service_unavailable", () => {
    expect(SESSION_STARTS_PER_MINUTE).toBe(90);
    const refusal = fatal("service_unavailable", "too many session starts", { retry_after_ms: 1000 });
    expect(refusal).toMatchObject({ code: "service_unavailable", type: "api_error", fatal: true, close_code: 4503, retry_after_ms: 1000 });
    expect(refusal.retry_after_ms).not.toBeNull();
    expect(closeCodeFor("concurrency_limit")).toBe(4429);
    expect(closeCodeFor("seconds_limit")).toBe(4429);
  });
});

describe("prototype-chain names are unknown names, never a throw", () => {
  it.each(["__proto__", "constructor", "toString"])("ignores %s in a connect query", (name) => {
    const parsed = parseConnectQuery(new URLSearchParams(`${name}=1`));
    expect(parsed).toEqual({ ok: true, config: DEFAULT_CONFIG, ignored: [name] });
    expect(parsed.ok && Object.hasOwn(parsed.config, name)).toBe(false);
  });

  it.each(["__proto__", "constructor", "toString"])("refuses %s in an update patch without throwing", (name) => {
    const patch = JSON.parse(`{"${name}":1}`) as Record<string, unknown>;
    const { config, problem } = applyUpdate(DEFAULT_CONFIG, patch);
    expect(config).toBe(DEFAULT_CONFIG);
    expect(problem).toMatchObject({ code: "invalid_param", param: name, fatal: false, close_code: null });
  });
});
