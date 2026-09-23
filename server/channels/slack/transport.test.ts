import { expect, it, vi } from "vitest";
import { SlackSocketTransport, type SlackSDKFactory } from "./transport.ts";
function fixture() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const post = vi.fn(async (_input: Record<string, unknown>): Promise<unknown> => ({ ok: true, channel: "DOWNER", ts: "1.2" }));
  const update = vi.fn(async (_input: Record<string, unknown>): Promise<unknown> => ({ ok: true, channel: "DOWNER", ts: "1.2" }));
  const factory: SlackSDKFactory = vi.fn(async () => ({ socket: { on: (n: string, fn: (...args: unknown[]) => void) => listeners.set(n, fn), start: async () => {}, disconnect: async () => {} },
    web: { auth: { test: async () => ({ ok: true, team_id: "TEAM", user_id: "UBOT", bot_id: "BOT" }) }, chat: { postMessage: post, update } } }));
  return { post, update, listeners, transport: new SlackSocketTransport({ appToken: "fake-app", botToken: "fake-bot", factory }) };
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

const approveId = `murage:${"a".repeat(48)}:a`, denyId = approveId.slice(0, -1) + "d";
it("sends exact plain summary and buttons, refuses truncation and removes original actions", async () => {
  const f=fixture(),signal=new AbortController().signal,text="Run <!channel> & <@UOWNER>";
  await f.transport.sendPermission({dmId:"DOWNER",text,approveId,denyId,signal});
  expect(f.post.mock.calls[0][0]).toMatchObject({text:"Run &lt;!channel&gt; &amp; &lt;@UOWNER&gt;",mrkdwn:false,parse:"none",blocks:[{text:{type:"plain_text",text}},{elements:[{text:{text:"Approve once"},action_id:approveId},{text:{text:"Deny"},action_id:denyId}]}]});
  await expect(f.transport.sendPermission({dmId:"DOWNER",text:"x".repeat(3001),approveId,denyId,signal})).rejects.toMatchObject({code:"invalid-request",uncertain:false});expect(f.post).toHaveBeenCalledTimes(1);
  await f.transport.settlePermission({dmId:"DOWNER",messageId:"1.2",text:"Denied",signal});
  expect(f.update.mock.calls[0][0]).toMatchObject({channel:"DOWNER",ts:"1.2",blocks:[{type:"section",text:{type:"plain_text",text:"Denied"}}]});
});
it("acks interactive payloads before identity-bound delivery and fails closed on failed ack", async () => {
  const f=fixture(),receive=vi.fn(),envelope=vi.fn(),health=vi.fn(),ack=vi.fn(async()=>{});
  f.transport.onPermissionAction(receive);await f.transport.verifyBot();await f.transport.start(envelope,health);
  const body={type:"block_actions",api_app_id:"APP",team:{id:"TEAM"},user:{id:"UOWNER"},channel:{id:"DOWNER"},message:{ts:"1.2",user:"UBOT",bot_id:"BOT"},container:{type:"message",channel_id:"DOWNER",message_ts:"1.2"},actions:[{type:"button",action_id:approveId}]};
  const emit=(patch={})=>f.listeners.get("slack_event")!({type:"interactive",body:{...body,...patch},ack});
  emit();await vi.waitFor(()=>expect(receive).toHaveBeenCalledTimes(1));expect(ack).toHaveBeenCalledTimes(1);
  await receive.mock.calls[0][0].ack();expect(ack).toHaveBeenCalledTimes(1);
  expect(receive.mock.calls[0][0]).toMatchObject({provider:"slack",applicationId:"APP",teamId:"TEAM",userId:"UOWNER",channelId:"DOWNER",messageId:"1.2",actionId:approveId});
  for(const patch of [{team:{id:"OTHER"}},{channel:{id:"CROOM"}},{message:{ts:"1.2",user:"UOTHER",bot_id:"OTHER"}},{actions:[]}]) emit(patch);
  await vi.waitFor(()=>expect(ack).toHaveBeenCalledTimes(5));expect(receive).toHaveBeenCalledTimes(1);expect(envelope).not.toHaveBeenCalled();
  ack.mockRejectedValueOnce(new Error("secret"));emit();await vi.waitFor(()=>expect(health).toHaveBeenCalledWith("error"));expect(receive).toHaveBeenCalledTimes(1);
  emit({user:{id:"WOWNER"}});await vi.waitFor(()=>expect(receive).toHaveBeenCalledTimes(2));
  await f.transport.stop();emit();expect(ack).toHaveBeenCalledTimes(7);
});
it("uploads a voice note to the owner's DM, and says forbidden when files:write is missing", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const uploadV2 = vi.fn(async (_input: Record<string, unknown>): Promise<unknown> => ({ ok: true }));
  const withFiles: SlackSDKFactory = async () => ({ socket: { on: () => {}, start: async () => {}, disconnect: async () => {} },
    web: { auth: { test: async () => ({ ok: true, team_id: "TEAM", user_id: "UBOT", bot_id: "BOT" }) }, chat: { postMessage: f.post }, files: { uploadV2 } } });
  const transport = new SlackSocketTransport({ appToken: "fake-app", botToken: "fake-bot", factory: withFiles });
  await transport.sendAudio({ dmId: "DOWNER", name: "Voice note from Sable.mp3", mime: "audio/mpeg", bytes: new Uint8Array([1, 2]), title: "Voice note from Sable", signal });
  expect(uploadV2.mock.calls[0]![0]).toMatchObject({ channel_id: "DOWNER", filename: "Voice note from Sable.mp3", title: "Voice note from Sable" });
  expect(Buffer.isBuffer(uploadV2.mock.calls[0]![0].file)).toBe(true);
  uploadV2.mockRejectedValue({ data: { ok: false, error: "missing_scope" } });
  await expect(transport.sendAudio({ dmId: "DOWNER", name: "a.mp3", mime: "audio/mpeg", bytes: new Uint8Array([1]), title: "t", signal })).rejects.toMatchObject({ code: "forbidden" });
  await expect(transport.sendAudio({ dmId: "CPUBLIC", name: "a.mp3", mime: "audio/mpeg", bytes: new Uint8Array([1]), title: "t", signal })).rejects.toMatchObject({ code: "invalid-request" });
});
