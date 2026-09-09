import { afterEach, expect, it, vi } from "vitest";
import { postClip } from "./PushToTalk";
afterEach(() => vi.restoreAllMocks());
it("does not upload an already-cancelled transcription", async () => {
  const fetch = vi.spyOn(globalThis, "fetch"); const cancel = new AbortController(); cancel.abort();
  await expect(postClip(new Blob(["clip"], { type: "audio/wav" }), 1000, cancel.signal)).rejects.toThrow(/cancelled locally/);
  expect(fetch).not.toHaveBeenCalled();
});
it("cancels while waiting for a response body, not just its headers", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Response(new ReadableStream({ start(controller) {
    init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
  } }), { status: 200, headers: { "content-type": "application/json" } }));
  const cancel = new AbortController();
  const pending = postClip(new Blob(["clip"], { type: "audio/wav" }), 1000, cancel.signal);
  await Promise.resolve(); await Promise.resolve(); cancel.abort();
  await expect(pending).rejects.toThrow(/Flux may still process/);
});
