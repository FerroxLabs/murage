import { expect, it, vi } from "vitest";
import { SlackSocketTransport, type SlackSDKFactory } from "./transport.ts";
function fixture() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const post = vi.fn(async (_input: Record<string, unknown>): Promise<unknown> => ({ ok: true, channel: "DOWNER", ts: "1.2" }));
  const factory: SlackSDKFactory = vi.fn(async () => ({ socket: { on: (n: string, fn: (...args: unknown[]) => void) => listeners.set(n, fn), start: async () => {}, disconnect: async () => {} },
    web: { auth: { test: async () => ({ ok: true, team_id: "TEAM", user_id: "UBOT", bot_id: "BOT" }) }, chat: { postMessage: post } } }));
  return { post, listeners, transport: new SlackSocketTransport({ appToken: "fake-app", botToken: "fake-bot", factory }) };
}
it("uses explicit ACK once, ignores stopped callbacks and exposes no raw health errors", async () => {
  const f = fixture(), receive = vi.fn(), health = vi.fn(), ack = vi.fn(async () => {});
  expect(await f.transport.verifyBot()).toEqual({ teamId: "TEAM", userId: "UBOT", botId: "BOT" });
  await f.transport.start(receive, health); f.listeners.get("slack_event")!({ type: "events_api", body: { text: "private" }, ack });
  expect(ack).not.toHaveBeenCalled(); await receive.mock.calls[0][1](); expect(ack).toHaveBeenCalledTimes(1);
  f.listeners.get("error")!(new Error("secret")); expect(health).toHaveBeenCalledWith("error");
  await f.transport.stop(); f.listeners.get("slack_event")!({ ack }); expect(receive).toHaveBeenCalledTimes(1);
});
it("binds text destination and makes no recipient fallback or automatic retry", async () => {
  const f = fixture(), signal = new AbortController().signal;
  await expect(f.transport.sendText({ dmId: "DOWNER", text: "hello", signal })).resolves.toEqual({ channel: "DOWNER", ts: "1.2" });
  expect(f.post.mock.calls[0][0]).toMatchObject({ channel: "DOWNER", mrkdwn: false, unfurl_links: false });
  f.post.mockRejectedValue({ code: "slack_webapi_rate_limited_error", retryAfter: 9 });
  await expect(f.transport.sendText({ dmId: "DOWNER", text: "hello", signal })).rejects.toMatchObject({ code: "rate-limit", uncertain: false, retryAfterSeconds: 9 });
  expect(f.post).toHaveBeenCalledTimes(2);
  f.post.mockRejectedValue(new Error("token-secret"));
  await expect(f.transport.sendText({ dmId: "DOWNER", text: "hello", signal })).rejects.toMatchObject({ message: "unavailable", uncertain: true });
});
it("rejects mismatched success, terminal permissions and pre-dispatch cancellation", async () => {
  const f = fixture(), controller = new AbortController();
  f.post.mockResolvedValue({ ok: true, channel: "DOTHER", ts: "1.2" });
  await expect(f.transport.sendText({ dmId: "DOWNER", text: "hi", signal: controller.signal })).rejects.toMatchObject({ uncertain: true });
  f.post.mockRejectedValue({ data: { error: "missing_scope" } });
  await expect(f.transport.sendText({ dmId: "DOWNER", text: "hi", signal: controller.signal })).rejects.toMatchObject({ uncertain: false, code: "forbidden" });
  controller.abort(); await expect(f.transport.sendText({ dmId: "DOWNER", text: "hi", signal: controller.signal })).rejects.toMatchObject({ uncertain: false });
  expect(f.post).toHaveBeenCalledTimes(2);
});
