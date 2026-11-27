// 1.0.21 group B support rows (cause22-eng-design3-fable/DESIGN.md U3 + OPUS H1 on it; owner lane cause22-eng): fitJson with a
// small injected limit, the splitter limit read from node, and appendTurnText. The behaviour rows with the REAL limit are in
// bounded-lines-fit-1021.test.ts.
import { constants } from "node:buffer";
import { describe, expect, it } from "vitest";

import { appendTurnText, LINE_UNIT_LIMIT, TURN_TEXT_CUT_MARK, TURN_TEXT_MAX } from "./bounded-lines.ts";
import { fitJson } from "../owner-turn-caps.ts";

it("the splitter reads the limit from node", () => {
  expect(LINE_UNIT_LIMIT).toBe(constants.MAX_STRING_LENGTH);
});

describe("U3 fitJson (a small injected limit; the only place a limit is injected)", () => {
  const fit = (text: string, limit: number, chunk = 7, opts = { stringKeep: 16, tokenKeep: 8, margin: 40 }) => {
    const f = fitJson(limit, opts);
    for (let i = 0; i < text.length; i += chunk) f.write(text.slice(i, i + chunk));
    return f.end();
  };
  it("keeps ids first, middle and last and cuts only long strings (never an escape, never half a surrogate pair)", () => {
    const value = { id: "first", big: "a".repeat(100), mid: 3, esc: "\"{}\\".repeat(20), pair: "😀".repeat(20), last: { id: 9 } };
    const out = fit(JSON.stringify(value), 100_000);
    const msg = JSON.parse(out);
    expect(Object.keys(msg)).toEqual(Object.keys(value));
    expect(msg.id).toBe("first");
    expect(msg.mid).toBe(3);
    expect(msg.last).toEqual({ id: 9 });
    expect(msg.big).toMatch(/^a{16} …\[cut 84 units\]$/);
    expect(msg.esc.startsWith("\"{}\\")).toBe(true);
    expect(msg.pair.includes("\ud83d …")).toBe(false);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(msg.pair)).toBe(false);
  });
  it("F4: past half the limit, nested containers close at the next comma; later top-level members stay (containers as {} / [])", () => {
    const leaves = Array.from({ length: 1000 }, (_, i) => `leaf-${i}-` + "z".repeat(20));
    const value = { a: { list: leaves }, b: "kept", c: { deep: [1, 2, 3] }, d: 4 };
    const out = fit(JSON.stringify(value), 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    const msg = JSON.parse(out);
    expect(Object.keys(msg)).toEqual(["a", "b", "c", "d"]);
    expect(msg.b).toBe("kept");
    expect(msg.c).toEqual({});
    expect(msg.d).toBe(4);
    expect(msg.a.list.length).toBeLessThan(1000);
  });
  it("F5: one million top-level members close the top level and stay under the limit", () => {
    const text = "[" + Array.from({ length: 1_000_000 }, (_, i) => i).join(",") + "]";
    const out = fit(text, 5000, 4096);
    expect(out.length).toBeLessThanOrEqual(5000);
    expect(Array.isArray(JSON.parse(out))).toBe(true);
  });
  it("F3: depth 100 becomes the marker string; non-JSON never throws", () => {
    const deep = "[".repeat(100) + "]".repeat(100);
    expect(() => JSON.parse(fit(`{"x":${deep},"y":1}`, 100_000))).not.toThrow();
    expect(JSON.parse(fit(`{"x":${deep},"y":1}`, 100_000)).y).toBe(1);
    expect(() => fit("\u0000￿ not json {{{ \"open", 100)).not.toThrow();
  });
});

describe("appendTurnText (OPUS H1: a turn's reply text never grows past the string limit)", () => {
  it("keeps the head, adds the marker once and runs onCut once", () => {
    let cuts = 0;
    const big = "y".repeat(TURN_TEXT_MAX - 10);
    let text = appendTurnText("", big, () => cuts++);
    text = appendTurnText(text, "z".repeat(100), () => cuts++);
    text = appendTurnText(text, "more", () => cuts++);
    expect(cuts).toBe(1);
    expect(text.endsWith("z".repeat(10) + TURN_TEXT_CUT_MARK)).toBe(true);
    expect(text.length).toBe(TURN_TEXT_MAX + TURN_TEXT_CUT_MARK.length);
  });
});
