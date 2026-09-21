import { describe, expect, it } from "vitest";
import { ToolResults, TOOL_RESULT_MAX_CHARS, TOOL_RESULT_PREVIEW_CHARS, TOOL_RESULT_TTL_MS, toolResultPrefix } from "./tool-results.ts";

const OWNER = { botId: "bot-a", threadId: "thread-1" };

describe("ToolResults overflow cache", () => {
  it("pages a saved result back in preview-sized chunks", () => {
    const cache = new ToolResults();
    const text = "x".repeat(TOOL_RESULT_PREVIEW_CHARS * 2 + 25);
    const saved = cache.save(OWNER, text);
    expect(saved.id).toMatch(/^r-[0-9a-f-]{36}$/);
    expect(saved.length).toBe(text.length);
    expect(saved.truncated).toBe(false);

    const first = cache.read(OWNER, saved.id, 0)!;
    expect(first.text.length).toBe(TOOL_RESULT_PREVIEW_CHARS);
    expect(first.nextOffset).toBe(TOOL_RESULT_PREVIEW_CHARS);
    expect(first.nextOffset).toBeLessThan(first.length);

    const second = cache.read(OWNER, saved.id, first.nextOffset)!;
    const third = cache.read(OWNER, saved.id, second.nextOffset)!;
    expect(third.text.length).toBe(25);
    expect(third.nextOffset).toBe(third.length);
  });

  it("refuses a read from another bot or another conversation", () => {
    const cache = new ToolResults();
    const saved = cache.save(OWNER, "y".repeat(100));
    expect(cache.read(OWNER, saved.id, 0)).not.toBeNull();
    expect(cache.read({ botId: "bot-b", threadId: "thread-1" }, saved.id, 0)).toBeNull();
    expect(cache.read({ botId: "bot-a", threadId: "thread-2" }, saved.id, 0)).toBeNull();
  });

  it("refuses an offset past the end and a non-integer offset", () => {
    const cache = new ToolResults();
    const saved = cache.save(OWNER, "z".repeat(50));
    expect(cache.read(OWNER, saved.id, 50)).not.toBeNull();
    expect(cache.read(OWNER, saved.id, 51)).toBeNull();
    expect(cache.read(OWNER, saved.id, -1)).toBeNull();
    expect(cache.read(OWNER, saved.id, 1.5)).toBeNull();
  });

  it("caps what it retains and says so", () => {
    const cache = new ToolResults();
    const saved = cache.save(OWNER, "w".repeat(TOOL_RESULT_MAX_CHARS + 1_000));
    expect(saved.length).toBe(TOOL_RESULT_MAX_CHARS);
    expect(saved.truncated).toBe(true);
  });

  it("expires a saved result and a read never extends it", () => {
    let now = 1_000;
    const cache = new ToolResults(() => now);
    const saved = cache.save(OWNER, "a".repeat(100));
    now += TOOL_RESULT_TTL_MS - 1;
    expect(cache.read(OWNER, saved.id, 0)).not.toBeNull();
    now += 1;
    expect(cache.read(OWNER, saved.id, 0)).toBeNull();
  });

  it("evicts one owner's oldest entries without touching a neighbour's", () => {
    const cache = new ToolResults();
    const neighbour = { botId: "bot-b", threadId: "thread-9" };
    const kept = cache.save(neighbour, "n".repeat(100));
    const ids = Array.from({ length: 20 }, (_, i) => cache.save(OWNER, `${i}`.repeat(100)).id);
    expect(cache.read(neighbour, kept.id, 0)).not.toBeNull();
    // 16 per owner: the first four are gone, the last sixteen survive.
    expect(ids.slice(0, 4).every((id) => cache.read(OWNER, id, 0) === null)).toBe(true);
    expect(ids.slice(4).every((id) => cache.read(OWNER, id, 0) !== null)).toBe(true);
  });

  it("masks a credential in the parked copy", () => {
    const cache = new ToolResults();
    const saved = cache.save(OWNER, `prefix ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz suffix`);
    const read = cache.read(OWNER, saved.id, 0)!;
    expect(read.text).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz");
    expect(read.text).toContain("«redacted");
  });

  it("never cuts a surrogate pair in half", () => {
    // One astral character is two UTF-16 units; a cut at an odd count would
    // leave a lone high surrogate and shift every later offset by one.
    const pairs = "\u{1F600}".repeat(10);
    expect(toolResultPrefix(pairs, 5)).toBe("\u{1F600}".repeat(2));
    expect(toolResultPrefix(pairs, 6)).toBe("\u{1F600}".repeat(3));

    const cache = new ToolResults();
    const saved = cache.save(OWNER, pairs);
    // An offset landing on a low surrogate steps back to the pair's start.
    const read = cache.read(OWNER, saved.id, 5)!;
    expect(read.offset).toBe(4);
    expect(read.text.startsWith("\u{1F600}")).toBe(true);
  });
});
