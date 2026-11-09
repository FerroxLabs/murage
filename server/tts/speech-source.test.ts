import { describe, expect, it } from "vitest";
import { capSpeech, compileSpeechSource, MAX_SOURCE_BYTES, protectSpeechSource, REST_ON_SCREEN } from "./speech-source.ts";

describe("D24 source protection foundation", () => {
  const corpus = [
    [true, "password: hunter2\nnext secretword"], // red-at-head: label
    [true, "**pass**word: hunter2\nnext secretword"], // red-at-head: normalized label
    [true, "<b>password</b>: hunter2\nnext secretword"], // red-at-head: tag
    [false, "![password](x): hunter2\nnext secretword"], // control: image label, head cut
    [false, "[password](https://x): hunter2\nnext secretword"], // control: link label, head cut
    [true, '<img alt="password" width="20" title="picture">: hunter2\nnext secretword'], // red-at-head: tag
    [true, '<img title="picture" password="hunter2"> secretword'], // red-at-head: tag
    [true, '<span title="password: hunter2">safe</span> secretword'], // red-at-head: tag
    [true, "```txt\npassword:\n```\nhunter2\nnext secretword"], // red-at-head: collapsed label
    [true, "    password:\n\nhunter2\nnext secretword"], // red-at-head: label
    [true, "<tool_output>password:</tool_output>\nhunter2\nnext secretword"], // red-at-head: tag
    [true, "| password: |\n| --- |\nhunter2\nnext secretword"], // red-at-head: label
    [true, '<td title="password">hunter2</td> secretword'], // red-at-head: tag
    [true, "pass&#119;ord: hunter2\nnext secretword"], // red-at-head: numeric entity
    [true, "password&#58; hunter2\nnext secretword"], // red-at-head: numeric entity
    [false, "[**password**](x): hunter2\nnext secretword"], // control: link label, head cut
    [false, "«redacted 12 chars»!hunter2\nnext secretword"], // control: malformed marker
    [true, "«redacted private key»<b>hunter2</b> secretword"], // red-at-head: tag
    [false, "«not our marker» hunter2\nnext secretword"], // control: malformed marker
    [false, "«redacted hunter2\nnext secretword"], // control: unclosed marker
    [true, "<unknown>hunter2</unknown> secretword"], // red-at-head: tag
    [false, "[password](x hunter2 secretword"], // control: unclosed link
  ] as const;
  it.each(corpus)("P-source covers the entire protected suffix (whole cut %s): %s", (wholeCut, raw) => {
    const source = `Safe opening. ${raw}`;
    const result = protectSpeechSource(source);
    const payload = compileSpeechSource(source);
    if (wholeCut) expect(payload).toBe(REST_ON_SCREEN);
    else expect(payload).toContain("Safe opening.");
    expect(payload).not.toMatch(/hunter2|secretword/);
    expect(payload).toContain(REST_ON_SCREEN);
    expect(result.cut).not.toBeNull();
    expect(result.intervals).toEqual([{ start: result.cut, end: source.length }]);
    expect(protectSpeechSource(result)).toBe(result);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each(["«redacted»", "«redacted 12 chars»", "«redacted private key»", "«redacted provider credentials»"])("P-source keeps a separated marker atomic: %s", (marker) => {
    expect(compileSpeechSource(`Before ${marker} after.`)).toBe("Before redacted after.");
  });
  it("rejects forged protected values", () => {
    expect(() => protectSpeechSource({ text: "unsafe", cut: null, sourceLength: 6, intervals: [] })).toThrow("invalid protected speech");
  });
  it("presentation whole-cuts triggers and retains preceding prose for head-only cuts", () => {
    for (const [label, wholeCut] of [
      ["password:", true], // red-at-head: label, HEAD retains introduction
      ["**password**:", true], // red-at-head: normalized label
      ["![password](x):", false], // control: head-only image label cut
      ["<b>password</b>:", true], // red-at-head: tag
      ["authorization =", true], // red-at-head: label
    ] as const) {
      const result = compileSpeechSource(`Safe introduction. ${label} hunter2`, { presentation: true });
      if (wholeCut) expect(result).toBe(REST_ON_SCREEN);
      else expect(result).toContain("Safe introduction.");
      expect(result).not.toMatch(/password|authorization|hunter2/);
    }
  });
  it("P-render preserves prose, inline code and link labels, with fixed omission phrases", () => {
    expect(compileSpeechSource("Hello **world**. Use `count`. [The guide](https://example.test). ![diagram](x)"))
      .toBe("Hello world. Use count. The guide. image omitted");
    expect(compileSpeechSource("Example:\n```ts\nlet n = 1;\n```\nDone."))
      .toBe("Example: code omitted Done.");
    expect(compileSpeechSource("Visit https://example.test/path now.")).toBe("Visit link now.");
  });
  it("P-prose retains the stated unlabelled prose boundary", () => {
    expect(compileSpeechSource("The thing you pasted was hunter2.")).toBe("The thing you pasted was hunter2.");
  });
  it("P-cap applies once after pronunciation and room prefix protection", () => {
    const payload = compileSpeechSource("Sept 14. ".repeat(300), { prefix: "Alice" });
    expect(payload.length).toBeLessThanOrEqual(1500);
    expect(payload).toContain("Alice says September 14.");
    expect(payload.endsWith(REST_ON_SCREEN)).toBe(true);
    expect(payload.split(REST_ON_SCREEN)).toHaveLength(2);
    expect(compileSpeechSource("Fine.", { prefix: "password: hunter2" })).not.toContain("hunter2");
  });
  it.each([1499, 1500, 1501, 3000])("P-cap bounds unbroken Unicode at %i units", (length) => {
    const result = capSpeech("😀".repeat(length), 1500);
    expect(result.length).toBeLessThanOrEqual(1500);
    expect(result).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(result.endsWith(REST_ON_SCREEN)).toBe(true);
  });
  // red-at-head: HEAD throws for both byte-overflow cases.
  it("P-source whole-cuts oversize source", () => {
    expect(compileSpeechSource("a".repeat(MAX_SOURCE_BYTES + 1))).toBe(REST_ON_SCREEN);
    expect(compileSpeechSource("😀".repeat(MAX_SOURCE_BYTES / 4 + 1))).toBe(REST_ON_SCREEN);
  });
  it.each([1, 64 * 1024, MAX_SOURCE_BYTES])("P-source accepts bounded benign input of %i bytes", (size) => {
    expect(compileSpeechSource("a".repeat(size)).length).toBeLessThanOrEqual(1500);
  });
});

// red-at-head: all three tag triggers retain 'Plan is set.' at HEAD.
it("D24 whole-cuts benign, secret and unfinished goal envelopes", () => {
  expect(compileSpeechSource('Plan is set. <murage-goal>{"goal":"internal protocol"}</murage-goal> Next up is the review.')).toBe(REST_ON_SCREEN);
  expect(compileSpeechSource('Plan is set. <murage-goal>password:</murage-goal> hunter2')).toBe(REST_ON_SCREEN);
  expect(compileSpeechSource('Plan is set. <murage-goal>unfinished')).toBe(REST_ON_SCREEN);
});
