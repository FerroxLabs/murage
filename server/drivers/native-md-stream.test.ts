// REDACT-MD-SINKS §3 stream rows 14-18 (designs/REDACT-MD-SINKS-1104.md §5),
// plus the row 18 split-equivalence test and the row 19 stream clock. Each
// describe loads a fresh native.ts so per-process stream state (latched
// entries, overflow mode) never leaks between rows. Every row fails on the base
// (int/1015 b47ece583) on an assertion.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ensureDirs, NATIVE_DIR } from "../config.ts";

type Native = typeof import("./native.ts");
async function freshNative(): Promise<Native> {
  vi.resetModules();
  return import("./native.ts");
}
let seq = 0;
const thread = (tag: string) => `t-rds-${tag}-${process.pid}-${++seq}`;
const frame = (text: string, field: "text" | "thinking" = "text") =>
  ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: field === "text" ? { type: "text_delta", text } : { type: "thinking_delta", thinking: text } } });
// Stream frames go in as dir "in", as the Claude driver logs every SDK frame (claude.ts appendNative "in").
const send = (n: Native, t: string, text: string, field: "text" | "thinking" = "text") => n.appendNative(t, { dir: "in", source: "test", msg: frame(text, field) });
const sendIn = (n: Native, t: string) => n.appendNative(t, { dir: "in", source: "test", msg: { type: "user", text: "next prompt" } });
const raw = (t: string) => readFileSync(join(NATIVE_DIR, `${t}.ndjson`), "utf8");
const written = (t: string, field: "text" | "thinking" = "text") => raw(t).trimEnd().split("\n").map((line) => JSON.parse(line).msg?.event?.delta?.[field]).filter((v) => typeof v === "string").join("");
/** Nothing but blanks and masks after the label's separator. */
const afterLabel = (text: string, label = "**password**:") => {
  const at = text.indexOf(label);
  return at < 0 ? text : text.slice(at + label.length).replace(/«redacted[^»]*»|\[hidden\]/g, "").trim();
};

beforeAll(() => ensureDirs());

describe("row 14: a wrapped label masks the rest of the stream", () => {
  it("(a) label then 600 chars in 20-char deltas", async () => {
    const n = await freshNative(), t = thread("14a");
    send(n, t, "**password**: hunter2");
    for (let i = 0; i < 30; i++) send(n, t, "CONTINUEcontinue1234");
    expect(raw(t)).not.toContain("hunter2");
    expect(raw(t)).not.toContain("CONTINUE");
  });
  it("(b) label + 600 spaces, then the separator and value", async () => {
    const n = await freshNative(), t = thread("14b");
    send(n, t, "**password**" + " ".repeat(600));
    send(n, t, ": hunter2");
    expect(raw(t)).not.toContain("hunter2");
  });
  it("(c) label + separator + 600 spaces, then a blank line and the value", async () => {
    const n = await freshNative(), t = thread("14c");
    send(n, t, "**password**:" + " ".repeat(600));
    send(n, t, "\n\nhunter2");
    expect(raw(t)).not.toContain("hunter2");
  });
  it("(d) 70 KiB after the label ends in «redacted»", async () => {
    const n = await freshNative(), t = thread("14d");
    send(n, t, "**password**:");
    for (let i = 0; i < 70; i++) send(n, t, "x".repeat(1024));
    send(n, t, "\n\nAfter");
    expect(raw(t)).not.toContain("After");
    expect(written(t).endsWith("«redacted»")).toBe(true);
  });
});

describe("row 15: eviction never drops context unmasked", () => {
  const crowd = (n: Native) => { for (let i = 0; i < 300; i++) send(n, thread("15crowd"), "hello"); };
  it.each([["**password**", ": hunter2"], ["**pass", "word**: hunter2"]])("%j, 300 threads, then %j", async (first, second) => {
    const n = await freshNative(), t = thread("15");
    send(n, t, first);
    crowd(n);
    send(n, t, second);
    expect(raw(t)).not.toContain("hunter2");
  });
  it("a latched thread stays masked after 300 other threads", async () => {
    const n = await freshNative(), t = thread("15l");
    send(n, t, "**password**: x");
    crowd(n);
    send(n, t, "hunter2");
    expect(raw(t)).not.toContain("hunter2");
  });
});

describe("row 16: an over-long unfinished line latches, never truncates", () => {
  it.each([64 * 1024 - 1, 64 * 1024, 64 * 1024 + 1])("label + spaces to %i, then the separator", async (size) => {
    const n = await freshNative(), t = thread("16");
    send(n, t, "**password**");
    let left = size - "**password**".length;
    while (left > 0) { const k = Math.min(left, 4096); send(n, t, " ".repeat(k)); left -= k; }
    send(n, t, ": hunter2");
    expect(raw(t)).not.toContain("hunter2");
  });
});

describe("row 17: latched capacity overflows closed", () => {
  it("65,537 latched threads, a new thread is masked until its in entry", async () => {
    const n = await freshNative();
    const cap = (n as unknown as { LATCHED_MAX?: number }).LATCHED_MAX ?? 65_536;
    for (let i = 0; i <= cap; i++) send(n, thread("17l"), "**password**: x");
    const t = thread("17");
    send(n, t, "hunter2");
    expect(raw(t)).not.toContain("hunter2");
    sendIn(n, t);
    send(n, t, "clean text after the prompt");
    expect(written(t)).toContain("clean text after the prompt");
  }, 600_000);
});

// GrokBuild round 1 H2: ONLY a prompt or tool result resets. Every other frame of the live reply, and every other
// `out` entry, keeps the latch. Each frame is logged twice between the label and the value (the first latched an
// unfinished line on 27f3d1489, the second released it).
describe("row 18: only a prompt or tool result resets", () => {
  const FRAMES: [string, "in" | "out", unknown][] = [
    ["system thinking_tokens", "in", { type: "system", subtype: "thinking_tokens", tokens: 12 }],
    ["system status", "in", { type: "system", subtype: "status", status: "thinking" }],
    ["assistant", "in", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "partial reply" }] } }],
    ["tool_progress", "in", { type: "tool_progress", tool_use_id: "tu1", tool_name: "Bash", elapsed_time_seconds: 1 }],
    ["control_request", "in", { type: "control_request", request_id: "r1", request: { subtype: "can_use_tool" } }],
    ["control_response", "in", { type: "control_response", response: { subtype: "success", request_id: "r1" } }],
    ["task_started", "in", { type: "task_started", task_id: "k1" }],
    ["task_progress", "in", { type: "task_progress", task_id: "k1" }],
    ["result", "in", { type: "result", subtype: "success" }],
    ["out close", "out", { close: "replaced" }],
    ["out control_request", "out", { type: "control_request", request_id: "r2", request: { subtype: "interrupt" } }],
    ["out acpPool", "out", { acpPool: "park" }],
  ];
  it.each(FRAMES)("%s does not reset a latch", async (_name, dir, msg) => {
    const n = await freshNative(), t = thread("18n");
    send(n, t, "**password**: ");
    n.appendNative(t, { dir, source: "test", msg });
    n.appendNative(t, { dir, source: "test", msg });
    send(n, t, "hunter2");
    send(n, t, " more hunter2");
    expect(raw(t)).not.toContain("hunter2");
  });
  it.each([
    ["a prompt (out)", "out" as const, { type: "user", message: { role: "user", content: "next prompt" } }],
    ["a tool result (in)", "in" as const, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } }],
  ])("%s resets", async (_name, dir, msg) => {
    const n = await freshNative(), t = thread("18y");
    send(n, t, "**password**: x\n");
    send(n, t, "hunter2");
    n.appendNative(t, { dir, source: "test", msg });
    send(n, t, "clean text");
    expect(raw(t)).not.toContain("hunter2");
    expect(written(t)).toContain("clean text");
  });
});

describe("row 18: reset and splits", () => {
  it("a stream_event frame between the label and the value (ping, block stop) does not reset", async () => {
    const n = await freshNative(), t = thread("18p");
    send(n, t, "**password**: ");
    n.appendNative(t, { dir: "in", source: "test", msg: { type: "stream_event", event: { type: "ping" } } });
    send(n, t, "hunter2");
    n.appendNative(t, { dir: "out", source: "test", msg: { type: "stream_event", event: { type: "content_block_stop", index: 0 } } });
    send(n, t, "hunter2 again");
    expect(raw(t)).not.toContain("hunter2");
  });
  it.each([["**password**: x\n"], ["**password**: x\r\n"]])("latched %j, in entry, clean text is written", async (first) => {
    const n = await freshNative(), t = thread("18r");
    send(n, t, first);
    send(n, t, "hunter2");
    sendIn(n, t);
    send(n, t, "clean text");
    expect(raw(t)).not.toContain("hunter2");
    expect(written(t)).toContain("clean text");
  });
  it("interleaved fields keep their own lines", async () => {
    const n = await freshNative(), t = thread("18f");
    send(n, t, "**password**");
    send(n, t, "thinking aloud", "thinking");
    send(n, t, ": hunter2");
    expect(raw(t)).not.toContain("hunter2");
    expect(written(t, "thinking")).toContain("thinking aloud");
  });
  it.each(["**password**: hunter2", "~~**password**~~: hunter2", "`token`: hunter2", "**The password: hunter2**"])("every split of %j is masked", async (line) => {
    const n = await freshNative();
    const label = line.slice(0, line.indexOf(":") + 1);
    for (let i = 1; i < line.length; i++) {
      const t = thread("18s");
      send(n, t, line.slice(0, i));
      send(n, t, line.slice(i));
      expect(afterLabel(written(t), label), `split at ${i}`).toBe("");
      expect(raw(t)).not.toContain("hunter2");
    }
  });
  it.each([["**password**", ": hunter2"], ["**pass", "word**: hunter2"]])("%j, in entry, %j writes no hunter2", async (first, second) => {
    const n = await freshNative(), t = thread("18i");
    send(n, t, first);
    sendIn(n, t);
    send(n, t, second);
    expect(raw(t)).not.toContain("hunter2");
  });
});

// MurageMain ruling: the stream detector gives the same result as the
// whole-line detector at every split point. Same result = both find a wrapped
// label or neither; when both do, the stream masks from the same label's
// separator (only blanks may sit between sepEnd and where the stream starts).
type Label = { sepEnd: number; wrapped: boolean };
type Shared = {
  findSecretLabels(line: string): Label[];
  createLabelStream(): unknown;
  scanLabelDelta(state: unknown, raw: string): number;
};
async function loadShared(): Promise<Shared | null> {
  const path = "../../shared/md-secret-label.mjs";
  return import(/* @vite-ignore */ path).catch(() => null) as Promise<Shared | null>;
}

describe("row 18: split equivalence of the stream detector", () => {
  it("equals findSecretLabels at every split point of a seeded corpus", async () => {
    const lib = await loadShared();
    expect(lib, "shared/md-secret-label.mjs is present").not.toBeNull();
    const { findSecretLabels, createLabelStream, scanLabelDelta } = lib!;
    const parts = ["*", "**", "_", "`", "~", "«", "»", " ", "\t", "-", ">", "+", ":", "=", "a", "x9", "my_", "password", "token", "api_key", "Secret", "s", "hunter2"];
    let seed = 0x5eed;
    const rnd = (k: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
    const corpus = [
      "**password**: hunter2", "password: **x", "password:   ", "token: prose; **password**: hunter2", "the token: note **password**: x",
      "my_token: x", "a_token: **x**", "_token=4096", "  api_key: x", "**The password: correct horse**", "token:token:token:(",
      "use a **strong password** here", "`token`: string", "~~**password**~~: x9", "x_ token: y", "x_\ttoken: y",
    ];
    for (let i = 0; i < 1500; i++) { let s = ""; for (let k = 1 + rnd(10); k > 0; k--) s += parts[rnd(parts.length)]; corpus.push(s); }
    for (const line of corpus) {
      const hit = findSecretLabels(line).find((label) => label.wrapped);
      for (let i = 0; i <= line.length; i++) {
        const st = createLabelStream();
        const a = scanLabelDelta(st, line.slice(0, i));
        const b = a >= 0 ? -1 : scanLabelDelta(st, line.slice(i));
        const start = a >= 0 ? a : b >= 0 ? i + b : -1;
        const where = `${JSON.stringify(line)} split ${i}`;
        expect(start >= 0, where).toBe(Boolean(hit));
        if (hit) {
          expect(start, where).toBeGreaterThanOrEqual(hit.sepEnd);
          expect(line.slice(hit.sepEnd, start).trim(), where).toBe("");
        }
      }
    }
  });
});

describe("row 19: stream detector clock, 1-char deltas", () => {
  it("stays linear at 64 and 256 KiB", async () => {
    const lib = await loadShared();
    expect(lib, "shared/md-secret-label.mjs is present").not.toBeNull();
    const run = (unit: string, bytes: number) => {
      const text = unit.repeat(Math.ceil(bytes / unit.length)), st = lib!.createLabelStream();
      const t = performance.now();
      for (let i = 0; i < text.length; i++) lib!.scanLabelDelta(st, text[i]!);
      return performance.now() - t;
    };
    for (const unit of ["a_", "«", "`", "token", "**pass "]) {
      const best = (bytes: number) => Math.min(run(unit, bytes), run(unit, bytes), run(unit, bytes));
      const t64 = Math.max(best(64 * 1024), 1), t256 = best(256 * 1024);
      expect(t256 / t64, unit).toBeLessThan(6);
      expect(t256, unit).toBeLessThan(250);
    }
  });
});
