import { describe, expect, it } from "vitest";
import { CallSpeechSource } from "./call-speech-source.ts";
import { MAX_SOURCE_BYTES, REST_ON_SCREEN } from "./speech-source.ts";

function fixture(limits?: ConstructorParameters<typeof CallSpeechSource>[0]) {
  const sources = new CallSpeechSource(limits);
  const call = sources.open("owner", "thread");
  const reply = sources.begin(call, "bot", "generation");
  return { sources, call, reply };
}
describe("D24 call source foundation", () => {
  it("red-at-aa73cb96d: custom sealing projection cannot introduce a trigger", () => {
    const { sources, call, reply } = fixture();
    sources.append(call, reply, 0, "Hello.");
    sources.seal(call, reply, undefined, () => ["Hello. %4", "1"]);
    expect(sources.presentation(call, reply)).toBe(REST_ON_SCREEN);
    sources.fallback(call, reply);
    expect([...sources.drain(call, reply)]).toEqual([REST_ON_SCREEN]);
  });
  it("red-at-aa73cb96d: projection errors stay whole-cut through fallback", () => {
    const { sources, call, reply } = fixture();
    sources.append(call, reply, 0, "Hello.");
    sources.seal(call, reply, undefined, () => { throw new Error("projection"); });
    expect(sources.presentation(call, reply)).toBe(REST_ON_SCREEN);
    sources.fallback(call, reply);
    expect([...sources.drain(call, reply)]).toEqual([REST_ON_SCREEN]);
  });
  it("red-at-aa73cb96d: final reparse cuts both sealed projections", () => {
    const { sources, call, reply } = fixture();
    sources.append(call, reply, 0, "Hello. `%4**1**`");
    sources.seal(call, reply);
    expect(sources.presentation(call, reply)).toBe(REST_ON_SCREEN);
    sources.fallback(call, reply);
    expect([...sources.drain(call, reply)]).toEqual([REST_ON_SCREEN]);
  });
  it("control: fallback sentence cap keeps its suffix", () => {
    const { sources, call, reply } = fixture();
    sources.append(call, reply, 0, "A readable sentence. ".repeat(40));
    sources.seal(call, reply);
    sources.fallback(call, reply);
    const text = [...sources.drain(call, reply)].join(" ");
    expect(text).toMatch(/^A readable sentence\./);
    expect(text.endsWith(REST_ON_SCREEN)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(450);
  });
  it.each([
    [true, "Safe introduction. password: correct horse. battery staple."], // red-at-head: label
    [false, "Safe introduction. ![password](x): correct horse. battery staple."], // control: head-only cut
    [true, 'Safe introduction. <img title="password"> correct horse. battery staple.'], // red-at-head: tag
    [false, "Safe introduction. «redacted 12 chars»!correct horse. battery staple."], // control: head-only cut
    [true, "Safe introduction.\n```\npassword:\n```\ncorrect horse. battery staple."], // red-at-head: label
  ] as const)("protects the complete source under every two-chunk partition (whole cut %s): %s", (wholeCut, raw) => {
    for (let at = 0; at <= raw.length; at++) {
      const { sources, call, reply } = fixture();
      sources.append(call, reply, 0, raw.slice(0, at));
      expect(() => sources.drain(call, reply)).toThrow("not sealed");
      sources.append(call, reply, 1, raw.slice(at));
      sources.seal(call, reply);
      const payloads = [...sources.drain(call, reply)];
      if (wholeCut) expect(payloads.join(" ")).toBe(REST_ON_SCREEN);
      else expect(payloads.join(" ")).toContain("Safe introduction.");
      expect(payloads.join(" ")).not.toMatch(/correct horse|battery staple/);
      expect(() => sources.drain(call, reply)).toThrow("closed");
    }
  });
  it("retains protection with one-character chunks, then admits an independent benign reply", () => {
    const { sources, call, reply } = fixture();
    [..."password: correct horse. battery staple."].forEach((char, i) => sources.append(call, reply, i, char));
    sources.seal(call, reply);
    expect([...sources.drain(call, reply)].join(" ")).not.toMatch(/correct horse|battery staple/);
    const next = sources.begin(call, "bot", "next");
    sources.append(call, next, 0, "A readable first sentence. A readable second sentence.");
    sources.seal(call, next);
    expect([...sources.drain(call, next)]).toHaveLength(2);
  });
  it("closes intake and drain permanently on Stop", () => {
    const { sources, call, reply } = fixture();
    sources.append(call, reply, 0, "First readable sentence. Second readable sentence.");
    sources.seal(call, reply);
    const drain = sources.drain(call, reply);
    expect(drain.next().value).toBe("First readable sentence.");
    sources.cancel(call, reply);
    expect(() => drain.next()).toThrow("closed");
    expect(() => sources.append(call, reply, 1, "late")).toThrow("closed");
    expect(() => sources.seal(call, reply)).toThrow("closed");
    const receiving = sources.begin(call, "bot", "receiving");
    sources.cancel(call, receiving);
    expect(() => sources.seal(call, receiving)).toThrow("closed");
  });
  it("rejects forged identities, another call, duplicate/out-of-order chunks and repeat seals", () => {
    const { sources, call, reply } = fixture();
    const other = sources.open("other-owner", "other-thread");
    expect(() => sources.append(other, reply, 0, "bad")).toThrow("closed");
    expect(() => sources.append({ ...call }, reply, 0, "bad")).toThrow("closed");
    expect(() => sources.append(call, { ...reply }, 0, "bad")).toThrow("closed");
    expect(() => sources.append(call, reply, 1, "bad")).toThrow("stale");
    sources.append(call, reply, 0, "Good.");
    expect(() => sources.append(call, reply, 0, "bad")).toThrow("stale");
    sources.seal(call, reply);
    expect(() => sources.seal(call, reply)).toThrow("stale");
    expect([...sources.drain(call, reply)].join(" ")).toBe("Good.");
  });
  it("never revives old authority after disconnect or restart", () => {
    const { sources, call, reply } = fixture();
    sources.append(call, reply, 0, "Incomplete.");
    sources.close(call);
    expect(() => sources.seal(call, reply)).toThrow("closed");
    const restarted = new CallSpeechSource();
    expect(() => restarted.append(call, reply, 1, "late")).toThrow("closed");
  });
  it("keeps a cut when authoritative final text replaces the deltas", () => {
    const { sources, call, reply } = fixture();
    sources.append(call, reply, 0, "password: hunter2");
    sources.seal(call, reply, "hunter2");
    expect([...sources.drain(call, reply)].join(" ")).not.toContain("hunter2");
  });
  it("supplies label-inclusive presentation text only after seal", () => {
    const { sources, call, reply } = fixture();
    expect(() => sources.presentation(call, reply)).toThrow("not sealed");
    sources.append(call, reply, 0, "Safe. password: hunter2");
    sources.seal(call, reply);
    expect(sources.presentation(call, reply)).not.toMatch(/password|hunter2/);
  });
  it("enforces raw, aggregate and context bounds without flushing a prefix", () => {
    const { sources, call, reply } = fixture({ perCallBytes: 10, installationBytes: 12, perCallContexts: 2 });
    sources.append(call, reply, 0, "123456");
    const next = sources.begin(call, "bot", "next");
    expect(() => sources.begin(call, "bot", "excess")).toThrow("context limit");
    expect(() => sources.append(call, next, 0, "12345")).toThrow("source limit");
    expect(() => sources.seal(call, next)).toThrow("closed");
    const other = sources.open("owner", "other-thread");
    const otherReply = sources.begin(other, "bot", "other");
    expect(() => sources.append(other, otherReply, 0, "1234567")).toThrow("source limit");
    sources.cancel(call, reply);
    const fresh = sources.begin(call, "bot", "fresh");
    sources.append(call, fresh, 0, "Fits.");
    sources.seal(call, fresh);
    expect([...sources.drain(call, fresh)]).toEqual(["Fits."]);
    const big = fixture();
    expect(() => big.sources.append(big.call, big.reply, 0, "a".repeat(MAX_SOURCE_BYTES + 1))).toThrow("source limit");
  });
  it("counts UTF-8 correctly across surrogate-pair chunk boundaries", () => {
    const { sources, call, reply } = fixture({ perCallBytes: 4, installationBytes: 4, perCallContexts: 1 });
    sources.append(call, reply, 0, "\uD83D");
    sources.append(call, reply, 1, "\uDE00");
    sources.seal(call, reply);
    expect([...sources.drain(call, reply)]).toEqual(["😀"]);
  });
});
