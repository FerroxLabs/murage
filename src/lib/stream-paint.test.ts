import { describe, expect, it } from "vitest";

import { GROUP_GOAL_CONTROL_OPEN } from "../../server/group-goal-run";
import { stripGoalEnvelopes } from "../../server/goal-envelope-v2";
import { isMemoryProvenanceEcho } from "../../server/memory/provenance-echo";
import {
  GOAL_ENVELOPE_OPEN,
  STREAM_PAINT_INTERVAL_MS,
  couldBeProvenanceEcho,
  paintDelay,
  paintedText,
  streamPaintText,
} from "./stream-paint";

const busy = { busy: true };
const handle = { sourceId: "s1", revision: 2, startByte: 0, endByte: 40 };
const echoes = [
  JSON.stringify(handle),
  JSON.stringify([handle, handle]),
  JSON.stringify({ id: "m1", version: 1, text: "likes tea", evidence: [handle] }, null, 2),
  "```json\n" + JSON.stringify({ id: "m1", evidence: [handle] }, null, 2) + "\n```",
  "```\n" + JSON.stringify([handle]) + "\n```",
];
const prefixes = (text: string) => Array.from({ length: text.length }, (_, i) => text.slice(0, i + 1));

describe("what the live bubble may show", () => {
  it("shows ordinary text exactly as the settled message will read", () => {
    const finals = [
      "Hello there.",
      "Sure.\n\n- one\n- two",
      "Here is code:\n```ts\nconst a = 1;\n```",
      "[Note] this starts with a bracket",
      "{not json} but braces",
      "Use `{ id }` for the key.",
      "<b>html-ish</b> and a < b",
    ];
    for (const final of finals) {
      expect(isMemoryProvenanceEcho(final)).toBe(false);
      // the server applies no change to these, so the stream is the final text
      expect(streamPaintText(final, busy)).toBe(final);
      // and every prefix that is not a held-back start is shown unchanged
      for (const prefix of prefixes(final)) {
        const shown = streamPaintText(prefix, busy);
        expect(shown === "" || shown === prefix).toBe(true);
      }
    }
  });

  it("never shows any prefix of a provenance echo, which the server drops from the conversation", () => {
    for (const echo of echoes) {
      expect(isMemoryProvenanceEcho(echo)).toBe(true);
      for (const prefix of prefixes(echo)) expect(streamPaintText(prefix, busy)).toBe("");
    }
  });

  it("releases a reply as soon as it cannot be an echo", () => {
    expect(couldBeProvenanceEcho('{"')).toBe(true);
    expect(couldBeProvenanceEcho('{"sourceI')).toBe(true);
    expect(couldBeProvenanceEcho('{"title": 1}')).toBe(false);
    expect(couldBeProvenanceEcho("[1, 2]")).toBe(false);
    expect(couldBeProvenanceEcho("```python\nx = {")).toBe(false);
    expect(couldBeProvenanceEcho("```ts")).toBe(false);
    expect(couldBeProvenanceEcho("```jso")).toBe(true);
    expect(streamPaintText('{"title": "Plan"}', busy)).toBe('{"title": "Plan"}');
  });

  it("never shows a goal envelope or text holding one", () => {
    expect(GOAL_ENVELOPE_OPEN).toBe(GROUP_GOAL_CONTROL_OPEN);
    const text = `Working on it.\n${GOAL_ENVELOPE_OPEN}{"v":2,"decision":"continue"}</murage-goal>`;
    expect(stripGoalEnvelopes(text)).toBe("Working on it.");
    expect(streamPaintText(text, busy)).toBe("");
    expect(streamPaintText(`Working on it.\n${GOAL_ENVELOPE_OPEN}{"v":`, busy)).toBe("");
  });

  it("shows nothing for empty, whitespace-only or stale (turn over) text", () => {
    expect(streamPaintText(undefined, busy)).toBe("");
    expect(streamPaintText("", busy)).toBe("");
    expect(streamPaintText(" \n\t", busy)).toBe("");
    expect(streamPaintText("Done.", { busy: false })).toBe("");
  });
});

describe("the paint throttle", () => {
  it("paints the first text at once and then at most every interval", () => {
    expect(paintDelay(null, 1_000)).toBe(0);
    expect(paintDelay(1_000, 1_000)).toBe(STREAM_PAINT_INTERVAL_MS);
    expect(paintDelay(1_000, 1_010)).toBe(STREAM_PAINT_INTERVAL_MS - 10);
    expect(paintDelay(1_000, 1_000 + STREAM_PAINT_INTERVAL_MS)).toBe(0);
    expect(paintDelay(1_000, 5_000)).toBe(0);
  });

  it("holds 100 deltas inside one second to about 30 paints", () => {
    let last: number | null = null;
    let paints = 0;
    let at = 0;
    for (let t = 0; t < 1_000; t += 10) {
      at = t;
      if (paintDelay(last, at) === 0) {
        last = at;
        paints += 1;
      }
    }
    expect(paints).toBeLessThanOrEqual(31);
    expect(paints).toBeGreaterThanOrEqual(24);
  });

  it("never shows a stale bubble: a cleared or new stream shows the live text", () => {
    expect(paintedText("", "old reply")).toBe("");
    expect(paintedText("A new turn", "old reply")).toBe("A new turn");
    expect(paintedText("Hello wor", "Hello")).toBe("Hello");
    expect(paintedText("Hello", "")).toBe("Hello");
  });
});
