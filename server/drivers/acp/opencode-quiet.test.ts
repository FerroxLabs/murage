import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { OpenCodeQuiet, parseOpenCodeFailure } from "./opencode-quiet.ts";
import { openCodeAcpSupport } from "./opencode-go.ts";
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

// OPENCODE-QUIET-1023 W1 new pins: only ERROR-level AI_APICallError records are owned failures.
it("W1 drops INFO-level and non-AI_APICallError records", () => {
  expect(parseOpenCodeFailure(main, session)).toBe("rate_limit");
  expect(parseOpenCodeFailure(main.replace("level=ERROR", "level=INFO"), session)).toBeUndefined();
  expect(parseOpenCodeFailure(main.replace("AI_APICallError: ", "TypeError: "), session)).toBeUndefined();
});

// W1/W1b/W1c: the same cases on every captured version (1.19.0 Cloud pin, 1.19.5, 1.19.6 npm latest at build time).
const fixture = (name: string) => readFileSync(new URL(`../../testing/fixtures/opencode-quiet/${name}`, import.meta.url), "utf8").split("\n");
for (const version of ["1.19.0", "1.19.5", "1.19.6"]) {
  it(`W1 ${version} capture: the main stream error is owned by its exact session only`, () => {
    const all = fixture(`${version}.stderr.log`);
    const owned = all.filter(line => line.includes('message="stream error"') && line.includes("small=false"));
    expect(owned.length).toBeGreaterThan(0);
    const id = /session.id=(\S+)/.exec(owned[0]!)![1]!;
    expect(parseOpenCodeFailure(owned[0]!, id)).toBe("rate_limit");
    expect(parseOpenCodeFailure(owned[0]!, id + "x")).toBeUndefined();
    const titles = all.filter(line => line.includes('message="stream error"') && line.includes("small=true"));
    expect(titles.length).toBeGreaterThan(0);
    for (const line of titles) expect(parseOpenCodeFailure(line, id)).toBeUndefined();
    for (const line of [owned[0]! + " small=false", owned[0]! + " extra=1", owned[0]!.replace("small=false", 'small="false'), owned[0]! + " x=" + "a".repeat(9 * 1024)]) {
      expect(parseOpenCodeFailure(line, id)).toBeUndefined();
    }
    for (const line of owned) expect(parseOpenCodeFailure(line, id)).toBe(line.includes(`session.id=${id} `) ? "rate_limit" : undefined);
  });
  it(`W1 ${version} long-retry capture: exactly one owned stream error, prompt answered after 65 s with a normal result`, () => {
    const all = fixture(`${version}.long.stderr.log`);
    const prompt = fixture(`${version}.long.stdout.jsonl`).filter(Boolean).map(line => JSON.parse(line));
    const id = prompt.find(m => m.result?.sessionId)!.result.sessionId as string;
    expect(all.map(line => parseOpenCodeFailure(line, id)).filter(Boolean)).toEqual(["rate_limit"]);
    const timeline: { t: number; event: string; update?: string; stopReason?: string }[] = JSON.parse(fixture(`${version}.long.timeline.json`).join("\n"));
    const sent = timeline.find(e => e.event === "prompt_sent")!.t;
    const answered = timeline.find(e => e.event === "prompt_answered")!;
    expect(answered.t - sent).toBeGreaterThanOrEqual(65000);
    expect(answered.stopReason).toBe("end_turn");
    expect(timeline.find(e => e.event === "stream_error")!.t - sent).toBeLessThan(60000);
    // No progress update while the retry is held (any would cancel the pending line).
    expect(timeline.filter(e => e.t > sent && e.t < answered.t && ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(e.update ?? "") && e.t < sent + 65000)).toEqual([]);
  });
}

// W2(a): progress() drops a pending category and its timer; only a later category fires, 60 s after progress.
it("W2 progress drops pending A and its timer; B fires once, never before progress + 60 s", async () => {
  vi.useFakeTimers();
  const emit = vi.fn();
  const observer = new OpenCodeQuiet(emit);
  observer.start(session);
  observer.feed(main + "\n");
  await vi.advanceTimersByTimeAsync(30000);
  observer.progress();
  observer.feed(main.replace("Local fixture rate limit", "service unavailable") + "\n");
  await vi.advanceTimersByTimeAsync(59999);
  expect(emit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(emit.mock.calls.map(call => call[0])).toEqual(["unavailable"]);
  expect(emit.mock.calls[0]![1]).toBeGreaterThanOrEqual(60000);
  await vi.advanceTimersByTimeAsync(120000);
  expect(emit).toHaveBeenCalledTimes(1);
  observer.stop();
});

// W4 new pin: the process epoch rests on OpenCode never being pooled.
it("W4 OpenCode is not pooled", () => {
  const table = openCodeAcpSupport(async () => ({ default: "fixture/mock", options: [] }));
  expect(table.driverKind).toBe("opencodeGo");
  expect(table.pooledSessions).not.toBe(true);
});

// W9(a): OpenCode's exit card names the category in plain words, never the internal JSON line.
it("W9 exitNote turns captured categories into plain words and leaves anything else to the generic card", () => {
  const table = openCodeAcpSupport(async () => ({ default: "fixture/mock", options: [] }));
  const note = table.exitNote?.(JSON.stringify({ type: "opencode_failure", category: "rate_limit" }));
  expect(note).toBe("OpenCode closed before replying. It reported a rate limit.");
  expect(table.exitNote?.([JSON.stringify({ type: "opencode_failure", category: "rate_limit" }), JSON.stringify({ type: "opencode_failure", category: "unavailable" })].join("\n")))
    .toBe("OpenCode closed before replying. It reported a rate limit and an unavailable provider.");
  for (const other of ["", "panic: something private", JSON.stringify({ type: "opencode_failure", category: "secret" }), JSON.stringify({ type: "other", category: "rate_limit" })]) {
    expect(table.exitNote?.(other)).toBeUndefined();
  }
});
