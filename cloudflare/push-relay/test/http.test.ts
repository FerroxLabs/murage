import { describe, expect, it } from "vitest";
import { HTTPError, readJson } from "../src/http";

function streamOf(chunks: number, size: number) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) { controller.close(); return; }
      state.pulled++;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
    cancel() { state.cancelled = true; },
  });
  return { state, body };
}
const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("https://push.murage.test/v1/devices", { method: "POST", body, headers, duplex: "half" } as RequestInit);

describe("readJson (B2)", () => {
  it("refuses an over-cap Content-Length without reading the body", async () => {
    const { state, body } = streamOf(1000, 1024);
    const request = post(body, { "content-length": String(1000 * 1024) });
    await expect(readJson(request)).rejects.toMatchObject({ status: 413, code: "request_too_large" });
    expect(state.pulled).toBe(0);
  });
  it("without a Content-Length, stops reading past the cap and cancels the stream", async () => {
    const { state, body } = streamOf(10_000, 1024); // 10 MB on offer
    await expect(readJson(post(body))).rejects.toBeInstanceOf(HTTPError);
    await expect(readJson(post(streamOf(10_000, 1024).body))).rejects.toMatchObject({ status: 413 });
    expect(state.pulled).toBeLessThanOrEqual(2000); // far below 10,000 chunks (the stream may prefetch a little)
    const probe = streamOf(10_000, 1024);
    await readJson(post(probe.body)).catch(() => {});
    expect(probe.state.pulled).toBeLessThan(100);
    expect(probe.state.cancelled).toBe(true);
  });
  it("a lying Content-Length does not lift the cap", async () => {
    const probe = streamOf(10_000, 1024);
    await expect(readJson(post(probe.body, { "content-length": "10" }))).rejects.toMatchObject({ status: 413 });
    expect(probe.state.pulled).toBeLessThan(100);
  });
  it("still parses an in-cap body and still answers 400 for bad JSON", async () => {
    expect(await readJson(post(JSON.stringify({ a: 1 })))).toEqual({ a: 1 });
    await expect(readJson(post("{nope"))).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  });
});
