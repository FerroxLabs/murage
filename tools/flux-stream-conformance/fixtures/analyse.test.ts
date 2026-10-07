// tools/flux-stream-conformance/fixtures/analyse.test.ts
import { describe, expect, it } from "vitest";

import { speechSegments, toneAndSilence, wavData } from "./analyse.ts";

describe("speechSegments", () => {
  it("finds two bursts separated by a long pause", () => {
    const segments = speechSegments(toneAndSilence([["silence", 200], ["tone", 1000], ["silence", 1300], ["tone", 800], ["silence", 500]]));
    expect(segments).toHaveLength(2);
    expect(segments[0][0]).toBeGreaterThanOrEqual(190);
    expect(segments[0][1]).toBeLessThanOrEqual(1220);
    expect(segments[1][0]).toBeGreaterThanOrEqual(2490);
    expect(segments[1][1]).toBeLessThanOrEqual(3320);
  });

  it("joins gaps shorter than 300 ms", () => {
    expect(speechSegments(toneAndSilence([["tone", 500], ["silence", 200], ["tone", 500]]))).toHaveLength(1);
  });

  it("returns nothing for silence", () => {
    expect(speechSegments(toneAndSilence([["silence", 2000]]))).toEqual([]);
  });
});

describe("wavData", () => {
  it("finds the data chunk after an extra chunk, the way afconvert writes it", () => {
    const pcm = Buffer.from(new Int16Array([1, -1, 2, -2]).buffer);
    const fmt = Buffer.alloc(24);
    fmt.write("fmt ", 0, "ascii");
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(1, 8); // PCM
    fmt.writeUInt16LE(1, 10); // mono
    fmt.writeUInt32LE(16000, 12);
    fmt.writeUInt32LE(32000, 16);
    fmt.writeUInt16LE(2, 20);
    fmt.writeUInt16LE(16, 22);
    const fllr = Buffer.alloc(8 + 4036);
    fllr.write("FLLR", 0, "ascii");
    fllr.writeUInt32LE(4036, 4);
    const data = Buffer.concat([Buffer.from("data"), Buffer.alloc(4), pcm]);
    data.writeUInt32LE(pcm.length, 4);
    const body = Buffer.concat([Buffer.from("WAVE"), fmt, fllr, data]);
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), body]);
    wav.writeUInt32LE(body.length, 4);
    const out = wavData(wav);
    expect(out).toMatchObject({ rate: 16000, channels: 1, bits: 16 });
    expect(out.data.equals(pcm)).toBe(true);
  });

  it("refuses a file that is not PCM WAV", () => {
    expect(() => wavData(Buffer.from("not a wav file at all"))).toThrow(/not a WAV/);
  });
});
