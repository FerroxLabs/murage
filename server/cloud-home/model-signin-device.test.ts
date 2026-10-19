import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeviceAcquirer, type HomeSignInProvider } from "./model-signin-device.ts";
import { s256Challenge } from "../../electron/model-signin-oauth.mjs";
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => vi.useRealTimers());
const grok = { device_code: "private-device", user_code: "CODE-1", verification_uri: "https://auth.x.ai/device", expires_in: 90, interval: 5 };
const chat = { device_auth_id: "private-device", usercode: "CODE-1", interval: "5" };
const json = (body: unknown, status = 200, headers = {}) => Response.json(body, { status, headers });
function run(replies: Array<Response | (() => Promise<Response>)>, provider: HomeSignInProvider = "supergrok") {
  const fetcher = vi.fn(async () => { const reply = replies.shift(); if (!reply) throw new Error("unexpected request"); return typeof reply === "function" ? reply() : reply; });
  const adapter = createDeviceAcquirer({ fetch: fetcher as typeof fetch }), controller = new AbortController(), challenge = vi.fn();
  const result = adapter.acquire({ provider, clientId: "test-client", signal: controller.signal, epoch: 1, isCurrent: () => true, onChallenge: challenge });
  return { result, fetcher, controller, challenge };
}
it.each([
  { ...grok, verification_uri: "https://evil.test/" },
  { ...grok, verification_uri: "http://auth.x.ai/" },
  { ...grok, verification_uri: "https://name:pass@auth.x.ai/" },
  { ...grok, verification_uri_complete: "https://evil.test/" },
  { ...grok, verification_uri: "https://auth.x.ai/#secret" },
  { ...grok, interval: 0 }, { ...grok, interval: 61 }, { ...grok, interval: "5" },
  { ...grok, expires_in: 0 }, { ...grok, user_code: "bad\ncode" }, { ...grok, device_code: "x".repeat(4097) },
])("rejects malformed or unpinned challenge %#", async data => {
  const h = run([json(data)]); expect(await h.result).toMatchObject({ kind: "error", error: "unauthorized" }); expect(h.challenge).not.toHaveBeenCalled(); expect(h.fetcher).toHaveBeenCalledTimes(1);
});
it("enforces body limit before parsing", async () => {
  const h = run([new Response("x".repeat(65537))]); expect(await h.result).toMatchObject({ kind: "error", error: "unauthorized" });
});
it("short expiry is not extended to vendor CLI floor", async () => {
  const h = run([json({ ...grok, expires_in: 3 })]); await vi.advanceTimersByTimeAsync(3000); expect(await h.result).toMatchObject({ error: "timeout" }); expect(h.fetcher).toHaveBeenCalledTimes(1);
});
it("Grok pending, slow_down and Retry-After increase polling delay", async () => {
  const h = run([json(grok), json({ error: "authorization_pending" }, 400), json({ error: "slow_down" }, 400), json({}, 429, { "retry-after": "20" }), json({ access_token: "fake-token" })]);
  await vi.advanceTimersByTimeAsync(5000); expect(h.fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000); expect(h.fetcher).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(9999); expect(h.fetcher).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1); expect(h.fetcher).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(20_000); expect(await h.result).toMatchObject({ kind: "tokens" });
});
it.each(["access_denied", "expired_token", "unknown_error"])("Grok %s stops safely", async error => {
  const h = run([json(grok), json({ error, error_description: "sensitive details" }, 400)]); await vi.advanceTimersByTimeAsync(5000); expect(await h.result).toEqual({ kind: "error", error: "unauthorized", epoch: 1 });
});
it("ChatGPT 403 and 404 are pending, S256 mismatch refuses exchange", async () => {
  const h = run([json(chat), json({}, 403), json({}, 404), json({ authorization_code: "code", code_verifier: "v".repeat(43), code_challenge: "wrong" })], "chatgpt");
  await vi.advanceTimersByTimeAsync(15_000); expect(await h.result).toMatchObject({ error: "unauthorized" }); expect(h.fetcher).toHaveBeenCalledTimes(4);
});
it("ambiguous ChatGPT exchange is not replayed", async () => {
  const verifier = "v".repeat(43);
  const h = run([json(chat), json({ authorization_code: "code", code_verifier: verifier, code_challenge: s256Challenge(verifier) }), async () => { throw new Error("transport timeout"); }], "chatgpt");
  await vi.advanceTimersByTimeAsync(5000); expect(await h.result).toMatchObject({ error: "offline" }); await vi.advanceTimersByTimeAsync(900_000); expect(h.fetcher).toHaveBeenCalledTimes(3);
});
it("cancellation aborts pending wait with no poll", async () => {
  const h = run([json(grok)]); await vi.advanceTimersByTimeAsync(0); h.controller.abort(); expect(await h.result).toMatchObject({ error: "cancelled" }); expect(h.fetcher).toHaveBeenCalledTimes(1);
});
it("15 second network abort is passed to fetch", async () => {
  let signal!: AbortSignal;
  const adapter = createDeviceAcquirer({ fetch: (async (_url: unknown, init: RequestInit) => { signal = init.signal!; return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("timeout")))); }) as typeof fetch });
  const result = adapter.acquire({ provider: "supergrok", clientId: "test-client", signal: new AbortController().signal, epoch: 1, isCurrent: () => true });
  await vi.advanceTimersByTimeAsync(15_000); expect(signal.aborted).toBe(true); expect(await result).toMatchObject({ error: "offline" });
});
