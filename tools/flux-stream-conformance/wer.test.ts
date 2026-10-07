// tools/flux-stream-conformance/wer.test.ts
import { describe, expect, it } from "vitest";

import { werAccepting, wer } from "./wer.ts";

describe("wer", () => {
  it("ignores case and punctuation", () => {
    expect(wer("Blues Brothers, and Heartbreak Ridge.", "blues brothers and heartbreak ridge")).toBe(0);
  });
  it("counts one substitution in four words as 25%", () => {
    expect(wer("a b c d", "a x c d")).toBeCloseTo(0.25);
  });
  it("accepts every rendering of a backchannel reference", () => {
    for (const h of ["Uh-huh.", "uh huh", "Aha", "MHM.", "Mm-hmm", "mm hmm!"]) expect(werAccepting("Uh-huh.", h)).toBe(0);
    expect(werAccepting("Uh-huh.", "hello there")).toBeGreaterThan(0.15);
  });
  it("leaves non-backchannel references to plain WER", () => {
    expect(werAccepting("a b c d", "a x c d")).toBeCloseTo(0.25);
    expect(werAccepting("a b c d", "aha")).toBe(wer("a b c d", "aha"));
  });
});
