// tools/flux-stream-conformance/owner.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { alignWords, commitDue, loadOwnerLines, ownerPasses, pct, scoreOwner, type OwnerLine } from "./owner.ts";

const RATE = 16_000;
/** Speech-like tone over a low noise floor (true digital silence is not a floor). */
function audio(parts: Array<["tone" | "quiet", number]>): Int16Array {
  const total = parts.reduce((n, [, ms]) => n + (ms * RATE) / 1000, 0);
  const out = new Int16Array(total);
  let at = 0;
  let seed = 1;
  for (const [kind, ms] of parts) {
    const n = (ms * RATE) / 1000;
    for (let i = 0; i < n; i += 1) {
      seed = (seed * 16807) % 2147483647;
      const noise = ((seed % 61) - 30);
      out[at + i] = kind === "tone" ? Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * 8000) : noise;
    }
    at += n;
  }
  return out;
}
const line = (id: number, text: string, startMs: number, endMs: number, pause = false): OwnerLine => ({ id, text, startMs, endMs, pause });

describe("owner-voice scoring, as the bake-off scored it (Astra 3 I10)", () => {
  it("aligns and interpolates exactly like the bake-off's score.mjs and lib.mjs", () => {
    expect(alignWords(["a", "b", "c"], ["a", "x", "c"]).map((o) => o.type)).toEqual(["match", "sub", "match"]);
    expect(pct([100, 200, 300, 400], 0.5)).toBe(250); // interpolated, not nearest rank
    expect(pct([100, 200, 300, 400], 0.9)).toBe(370);
  });

  it("slices a merged turn back into its lines, each timed from its own true end of speech", () => {
    // line 1 speaks 0-800, line 2 1500-2700, line 3 3500-4600; one turn arrives at 5200
    const pcm = audio([["tone", 800], ["quiet", 700], ["tone", 1200], ["quiet", 800], ["tone", 1100], ["quiet", 1400]]);
    const lines = [line(1, "At six.", 0, 1400), line(2, "Call Casper at 4:30.", 1400, 3400), line(3, "Did Dr. Patel reply?", 3400, 6000)]; // each line starts just before its speech, as in the bake-off
    const o = scoreOwner("clean", lines, [{ at: 5200, text: "At 6. Call Casper at four thirty. Did Doctor Patel reply?", turn: 0 }], pcm, (ms) => ms);
    expect(o.lines.map((r) => r.trueEosMs)).toEqual([800, 2700, 4600]);
    expect(o.lines.map((r) => r.latencyMs)).toEqual([4400, 2500, 600]);
    expect(o.wer).toBe(0);
  });

  it("marks a line nothing aligned to as missing, and a missing line fails the condition", () => {
    const pcm = audio([["tone", 400], ["quiet", 600], ["tone", 400], ["quiet", 600], ["tone", 400], ["quiet", 600]]);
    const lines = [line(1, "Yes.", 0, 950), line(2, "Absolutely not.", 950, 1950), line(3, "Yes.", 1950, 3000)];
    const o = scoreOwner("clean", lines, [{ at: 700, text: "Yes.", turn: 0 }, { at: 2900, text: "Yes.", turn: 1 }], pcm, (ms) => ms);
    expect(o.lines.map((r) => r.status)).toEqual(["ok", "missing", "ok"]);
    expect(o.complete).toBe(false);
    expect(ownerPasses(o)).toBe(false);
  });

  it("never passes a sample that is not all 25 lines", () => {
    const pcm = audio([["tone", 500], ["quiet", 1500]]);
    const o = scoreOwner("clean", [line(1, "Stop.", 0, 2000)], [{ at: 700, text: "Stop.", turn: 0 }], pcm, (ms) => ms);
    expect(o.missing).toEqual([]);
    expect(ownerPasses(o)).toBe(false); // one line, fast and exact, is still not the qualification
  });

  it("refuses a manifest that is not the 25-line bake-off script", () => {
    const dir = mkdtempSync(join(tmpdir(), "owner-"));
    writeFileSync(join(dir, "lines.json"), JSON.stringify({ lines: [line(1, "Stop.", 0, 2000)] }));
    expect(() => loadOwnerLines(dir)).toThrow(/25/);
  });

  it("commits in a pause inside a line exactly as StreamMic would, never on silence alone", () => {
    const segments: Array<[number, number]> = [[0, 1000], [1600, 2500]]; // one line, a 600 ms pause inside it
    expect(commitDue(segments, 1450, "Blues Brothers.")).toBe(true); // 450 ms into the pause: StreamMic commits here
    expect(commitDue(segments, 1300, "Blues Brothers.")).toBe(false); // only 300 ms
    expect(commitDue(segments, 1450, "Blues Brothers,")).toBe(false); // not terminal
    expect(commitDue(segments, 1450, "because...")).toBe(false); // an ellipsis
    expect(commitDue(segments, 2000, "Blues Brothers.")).toBe(false); // speaking
  });
});
