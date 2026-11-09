// ELD250 rebase onto b13z17: appendNative runs the lane's early size check first, then the tip's phone check and nativeTraceFrame
// projection. Both behaviours must stay: an oversized frame is dropped before anything reads it, and a frame that fits is written
// projected (a tool or result frame keeps its ids and enums, never its text).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureDirs, NATIVE_DIR } from "../config.ts";
import { appendNative } from "./native.ts";

beforeAll(() => ensureDirs());
const rows = (thread: string) => readFileSync(join(NATIVE_DIR, `${thread}.ndjson`), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));

describe("appendNative keeps both the size check and the trace projection (ELD250 on b13z17)", () => {
  it("the size check runs first: an oversized frame writes only the omitted marker and nothing of it is read", () => {
    const thread = "t-size-first";
    let touched = false;
    const msg = { id: 4, result: { content: [{ type: "text", text: "never written" }] } };
    Object.defineProperty(msg, "late", { enumerable: true, get: () => { touched = true; return 1; } });
    appendNative(thread, { dir: "in", source: "fixture", msg }, { rawChars: 200_000 });
    expect(touched).toBe(false);
    const written = rows(thread);
    expect(written).toHaveLength(1);
    expect(written[0].msg).toMatchObject({ type: "native_trace_record_omitted", reason: "frame exceeds byte limit before redaction", limitBytes: 64 * 1024 });
  });

  it("the projection runs after it: a frame that fits is written as the projected frame, text dropped and ids kept", () => {
    const thread = "t-projection-after";
    const secret = "confidential plan text 7f3a";
    appendNative(thread, { dir: "in", source: "fixture", msg: { jsonrpc: "2.0", id: 8, result: { content: [{ type: "text", text: secret }], structuredContent: { secret } } } }, { rawChars: 300 });
    appendNative(thread, { dir: "in", source: "fixture", msg: { jsonrpc: "2.0", id: 5, result: { stopReason: "refusal", usage: { inputTokens: 3 } } } }, { rawChars: 100 });
    const log = readFileSync(join(NATIVE_DIR, `${thread}.ndjson`), "utf8");
    expect(log).not.toContain(secret);
    const written = rows(thread);
    expect(written).toHaveLength(2);
    expect(written[0].msg).toMatchObject({ jsonrpc: "2.0", id: 8 });
    expect(written[1].msg).toEqual({ jsonrpc: "2.0", id: 5, result: { stopReason: "refusal", usage: { inputTokens: 3 } } });
  });
});
