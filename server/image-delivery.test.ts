// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { describe, expect, it, vi } from "vitest";
import { ImageDeliveryError, clampPollSeconds, idleTimeoutMs, idleWatch, parseImageJob, pollImageJob, readImageEventStream } from "./image-delivery.ts";

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
}
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

describe("readImageEventStream", () => {
  it("counts partial frames and keepalive comments as activity and returns the completed image", async () => {
    const onActivity = vi.fn();
    const result = await readImageEventStream(stream([": keepalive\n\n", frame({ type: "image_generation.partial_image", partial_image_index: 0, b64_json: "UA==" }),
      frame({ type: "image_generation.completed", data: [{ b64_json: "QUJD" }], usage: { output_tokens: 3 } }), "data: [DONE]\n\n"]), { onActivity, maxEventBytes: 1024, expected: 1 });
    expect(result).toEqual({ data: [{ b64_json: "QUJD" }], usage: { output_tokens: 3 } });
    expect(onActivity).toHaveBeenCalledTimes(4);
  });
  it("accepts OpenAI's completed frame shape and events split across chunks", async () => {
    const whole = frame({ type: "image_edit.completed", b64_json: "QUJD", usage: { total_tokens: 1 } });
    const result = await readImageEventStream(stream([whole.slice(0, 10), whole.slice(10)]), { maxEventBytes: 1024, expected: 1 });
    expect(result.data).toEqual([{ b64_json: "QUJD" }]);
  });
  it("collects n > 1 images from one frame or one frame per image", async () => {
    const one = await readImageEventStream(stream([frame({ type: "image_generation.completed", data: [{ b64_json: "QQ==" }, { b64_json: "Qg==" }] })]), { maxEventBytes: 1024, expected: 2 });
    expect(one.data.map(row => row.b64_json)).toEqual(["QQ==", "Qg=="]);
    const each = await readImageEventStream(stream([frame({ type: "image_generation.completed", image_index: 1, b64_json: "Qg==" }), frame({ type: "image_generation.completed", image_index: 0, b64_json: "QQ==" }), "data: [DONE]\n\n"]), { maxEventBytes: 1024, expected: 2 });
    expect(each.data.map(row => row.b64_json)).toEqual(["QQ==", "Qg=="]);
  });
  it("reports an error frame as a failed render with its code and message", async () => {
    await expect(readImageEventStream(stream([frame({ type: "error", error: { code: "moderation_blocked", message: "Not allowed." } })]), { maxEventBytes: 1024, expected: 1 }))
      .rejects.toMatchObject({ code: "provider-error", outcome: "failed", message: expect.stringContaining("moderation_blocked: Not allowed.") });
  });
  it("is uncertain when the stream ends without an image or an event grows past the cap", async () => {
    await expect(readImageEventStream(stream([": keepalive\n\n"]), { maxEventBytes: 1024, expected: 1 })).rejects.toMatchObject({ code: "invalid-image", outcome: "uncertain" });
    await expect(readImageEventStream(stream([`data: ${"x".repeat(2048)}`]), { maxEventBytes: 1024, expected: 1 })).rejects.toMatchObject({ code: "oversized-response" });
  });
});

describe("idle timeout", () => {
  it("fires only after the idle time with no activity", async () => {
    vi.useFakeTimers();
    try {
      const watch = idleWatch(1000);
      vi.advanceTimersByTime(900); watch.touch(); vi.advanceTimersByTime(900);
      expect(watch.signal.aborted).toBe(false);
      vi.advanceTimersByTime(200);
      expect(watch.signal.aborted).toBe(true); expect(watch.fired()).toBe(true);
    } finally { vi.useRealTimers(); }
    expect(idleTimeoutMs()).toBe(120_000); expect(idleTimeoutMs(15)).toBe(120_000); expect(idleTimeoutMs(60)).toBe(240_000);
  });
});

describe("jobs", () => {
  it("parses a 202 job and clamps the poll interval", () => {
    expect(parseImageJob({ contract: 1, kind: "image-job", id: "imgjob_1", status: "queued", poll_after_s: 5 })).toEqual({ id: "imgjob_1", status: "queued", pollAfterSeconds: 5 });
    expect(parseImageJob({ kind: "image-job", id: "x" })).toBeNull();
    expect(parseImageJob({ contract: 1, kind: "image-job", id: "../x" })).toBeNull();
    expect([clampPollSeconds(0), clampPollSeconds(100), clampPollSeconds(undefined)]).toEqual([2, 30, 5]);
  });
  const clock = () => { let now = 0; return { now: () => now, sleep: async (ms: number) => { now += ms; } }; };
  it("polls until succeeded and never submits anything", async () => {
    const time = clock();
    const get = vi.fn().mockResolvedValueOnce({ status: 200, body: { contract: 1, kind: "image-job", id: "j", status: "running", poll_after_s: 1 } })
      .mockResolvedValueOnce({ status: 200, body: { contract: 1, kind: "image-job", id: "j", status: "succeeded", data: [{ b64_json: "QQ==" }], usage: { cost: 1 } } });
    const result = await pollImageJob({ id: "j", get, signal: new AbortController().signal, ...time });
    expect(result).toEqual({ data: [{ b64_json: "QQ==" }], usage: { cost: 1 } }); expect(get).toHaveBeenCalledTimes(2);
  });
  it("reports a failed job as failed and an expired or vanished one as uncertain with its id", async () => {
    const failed = vi.fn().mockResolvedValue({ status: 200, body: { kind: "image-job", status: "failed", error: { code: "timeout", message: "Took too long." } } });
    await expect(pollImageJob({ id: "j", get: failed, signal: new AbortController().signal, ...clock() })).rejects.toMatchObject({ outcome: "failed", message: expect.stringContaining("timeout: Took too long.") });
    const expired = vi.fn().mockResolvedValue({ status: 200, body: { kind: "image-job", status: "expired" } });
    await expect(pollImageJob({ id: "j", get: expired, signal: new AbortController().signal, ...clock() })).rejects.toMatchObject({ code: "job-uncertain", outcome: "uncertain", message: expect.stringContaining("job j") });
    const gone = vi.fn().mockResolvedValue({ status: 404, body: {} });
    await expect(pollImageJob({ id: "j", get: gone, signal: new AbortController().signal, ...clock() })).rejects.toBeInstanceOf(ImageDeliveryError);
  });
  it("retries transport failures with backoff for five minutes, then is uncertain with the job id kept", async () => {
    const get = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(pollImageJob({ id: "imgjob_9", get, signal: new AbortController().signal, ...clock() })).rejects.toMatchObject({ code: "job-uncertain", message: expect.stringContaining("imgjob_9") });
    expect(get.mock.calls.length).toBeGreaterThan(5);
    const recovers = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce({ status: 200, body: { kind: "image-job", status: "succeeded", data: [{ b64_json: "QQ==" }] } });
    await expect(pollImageJob({ id: "j", get: recovers, signal: new AbortController().signal, ...clock() })).resolves.toMatchObject({ data: [{ b64_json: "QQ==" }] });
  });
  it("stops at the 30 minute ceiling", async () => {
    const get = vi.fn().mockResolvedValue({ status: 200, body: { kind: "image-job", status: "running", poll_after_s: 30 } });
    await expect(pollImageJob({ id: "j", get, signal: new AbortController().signal, ...clock() })).rejects.toMatchObject({ code: "job-uncertain", message: expect.stringContaining("30 minutes") });
  });
});
