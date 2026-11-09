import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { OpenCodeQuiet, parseOpenCodeFailure } from "./opencode-quiet.ts";
const capture = readFileSync(new URL("../../testing/fixtures/opencode-quiet/1.19.5.stderr.log", import.meta.url), "utf8");
const lines = capture.split("\n");
const main = lines.find(line => line.includes('message="stream error"') && line.includes('small=false'))!;
const session = /session.id=(\S+)/.exec(main)![1]!;
afterEach(() => vi.useRealTimers());
it("reads captured main errors and rejects captured title and other session errors", () => {
  expect(parseOpenCodeFailure(main, session)).toBe("rate_limit");
  for (const line of lines.filter(line => line.includes('small=true'))) expect(parseOpenCodeFailure(line, session)).toBeUndefined();
  expect(parseOpenCodeFailure(main, "different")).toBeUndefined();
  const sessions = new Set(lines.filter(line => line.includes('message="stream error"') && line.includes('small=false'))
    .map(line => /session.id=(\S+)/.exec(line)![1]!));
  expect(sessions.size).toBe(2);
  for (const id of sessions) {
    for (const line of lines.filter(line => line.includes('message="stream error"') && line.includes('small=false'))) {
      expect(parseOpenCodeFailure(line, id)).toBe(line.includes(`session.id=${id} `) ? "rate_limit" : undefined);
    }
  }
});
it("rejects duplicate, malformed, oversized and unsupported records", () => {
  for (const line of [main + ' small=false', main + ' broken', main.replace('small=false', 'small="false'), main + ' x=' + 'a'.repeat(8192), main.replace('message="stream error"', 'message=process')]) expect(parseOpenCodeFailure(line, session)).toBeUndefined();
});
it("does not expose provider text or unrecognized categories", () => {
  expect(parseOpenCodeFailure(main.replace('Local fixture rate limit', 'secret private error'), session)).toBeUndefined();
  expect(parseOpenCodeFailure(main.replace('Local fixture rate limit', 'invalid API key: secret'), session)).toBe("authentication");
});
it("fences partial and pre-prompt lines, suppresses pending errors on progress, stops on end", async () => {
  vi.useFakeTimers();
  const emit = vi.fn();
  const observer = new OpenCodeQuiet(emit);
  observer.feed(main + '\n');
  observer.start(session);
  await vi.advanceTimersByTimeAsync(60000);
  expect(emit).not.toHaveBeenCalled();
  observer.feed(main.slice(0, 40)); observer.feed(main.slice(40) + '\n');
  observer.progress();
  await vi.advanceTimersByTimeAsync(60000);
  expect(emit).not.toHaveBeenCalled();
  observer.feed(main + '\n');
  await vi.advanceTimersByTimeAsync(60000);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(emit.mock.calls[0]![0]).toBe('rate_limit');
  observer.feed(main + '\n');
  await vi.advanceTimersByTimeAsync(60000);
  expect(emit).toHaveBeenCalledTimes(1);
  observer.stop(); observer.feed(main + '\n');
  await vi.advanceTimersByTimeAsync(60000);
  expect(emit).toHaveBeenCalledTimes(1);
});
it("bounds oversized chunks", async () => {
  vi.useFakeTimers();
  const emit = vi.fn(); const observer = new OpenCodeQuiet(emit); observer.start(session);
  observer.feed('x'.repeat(1000000)); observer.feed('\n');
  await vi.advanceTimersByTimeAsync(60000); expect(emit).not.toHaveBeenCalled(); observer.stop();
});
it("emits at most three distinct categories and never quotes raw errors", async () => {
  vi.useFakeTimers();
  const emit = vi.fn(); const observer = new OpenCodeQuiet(emit); observer.start(session);
  for (const error of ['invalid API key: private', 'service unavailable private', 'maximum 128 tools private', 'rate limit private']) {
    observer.feed(main.replace('Local fixture rate limit', error) + '\n');
    await vi.advanceTimersByTimeAsync(60000);
  }
  expect(emit.mock.calls.map(call => call[0])).toEqual(['authentication', 'unavailable', 'tool_count']);
  expect(JSON.stringify(emit.mock.calls)).not.toContain('private'); observer.stop();
});

it("invalidates a partial record across progress with an unspent parsing budget", async () => {
  vi.useFakeTimers();
  for (const progress of [false, true]) {
    const emit = vi.fn();
    const observer = new OpenCodeQuiet(emit);
    observer.start(session);
    observer.feed(main.slice(0, 30));
    if (progress) observer.progress();
    observer.feed(main.slice(30) + '\n');
    await vi.advanceTimersByTimeAsync(60000);
    expect(emit).toHaveBeenCalledTimes(progress ? 0 : 1);
    observer.stop();
  }
});

it("drops classifiable short records after the per-tick budget and resumes after refill", async () => {
  vi.useFakeTimers();
  const emit = vi.fn();
  const observer = new OpenCodeQuiet(emit);
  observer.start(session);
  // Spend the budget on separate tiny records, never the 8 KiB record cap.
  observer.feed("x\n".repeat(32768));
  const record = main + "\n";
  expect(Buffer.byteLength(record)).toBeLessThan(8192);
  expect(parseOpenCodeFailure(main, session)).toBe("rate_limit");
  for (let bytes = 0; bytes < 65536; bytes += record.length) observer.feed(record);
  await vi.advanceTimersByTimeAsync(60000);
  expect(emit).not.toHaveBeenCalled();
  // The refill restores parsing, including the newline fence after dropped input.
  observer.feed("\n" + record);
  await vi.advanceTimersByTimeAsync(60000);
  expect(emit.mock.calls.map(call => call[0])).toEqual(["rate_limit"]);
  observer.stop();
});
