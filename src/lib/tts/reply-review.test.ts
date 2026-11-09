import { expect, it, vi } from "vitest";
import { ReplyController } from "./reply-controller";
import { replyFrame, REPLY_AUDIO_MIME } from "../../../shared/reply-speech";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const plan = () => json({ accountScopeId: "account", planVersion: "plan", holdUntil: 0, serverNow: 0 });
const audio = () => new Response(new Blob([
  replyFrame({ type: "start", value: { attemptId: "attempt", revision: 0, mime: "audio/mpeg" } }),
  replyFrame({ type: "audio", bytes: Uint8Array.of(1, 2, 3) }), replyFrame({ type: "complete" }),
]), { headers: { "content-type": REPLY_AUDIO_MIME } });
const context = { desktop: true, hydrated: true, threadId: "a", visible: true, call: false };
async function fixture() {
  let now = 0;
  const players: Array<{ ended(): void; failed(): void; stop: ReturnType<typeof vi.fn> }> = [];
  const post = vi.fn(async (path: string, body: any, _signal?: AbortSignal) => {
    if (path.endsWith("/session")) return json({ sessionId: "session-" + body.threadId, bootId: "boot", threadId: body.threadId, revision: 0 });
    if (path.endsWith("/target")) return plan();
    if (path.endsWith("/cancel")) return new Response(null, { status: 204 });
    return audio();
  });
  const controller = new ReplyController({ post, now: () => now, enabled: true, player: (_blob, ended, failed) => {
    const player = { ended, failed, stop: vi.fn(), play: vi.fn(async () => {}) }; players.push(player); return player;
  } });
  controller.configure(context); controller.hello("connection", "boot"); controller.caughtUp();
  await vi.waitFor(() => expect(controller.snapshot.status).toBe("idle"));
  return { controller, post, players, time: (value: number) => { now = value; }, ready: (id: string) => controller.receive({ kind: "speech.ready", threadId: "a", messageId: id, settlementId: "s-" + id, bootId: "boot", revision: 0 }) };
}
it.each(["metadata", "audio"])("A-D24-B1 expiry during %s releases the owned slot silently and admits a fresh queued reply", async stage => {
  const f = await fixture(); let release!: (response: Response) => void, signal!: AbortSignal;
  if (stage === "audio") f.post.mockImplementationOnce(async () => plan());
  f.post.mockImplementationOnce((_path, _body, requestSignal) => { signal = requestSignal!; return new Promise<Response>(resolve => { release = resolve; }); });
  f.ready("expired"); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  f.time(60_001); f.ready("fresh"); release(stage === "audio" ? audio() : plan());
  await vi.waitFor(() => expect(f.players).toHaveLength(1));
  expect(signal.aborted).toBe(true); expect(f.controller.snapshot).toMatchObject({ status: "waiting-for-player-end", messageId: "fresh" });
  expect(f.controller.snapshot.notice).toBeUndefined(); f.controller.stop();
});
it("A-D24-B1 a player error after the admission age expires still releases its own slot", async () => {
  const f = await fixture(); f.ready("a"); await vi.waitFor(() => expect(f.players).toHaveLength(1));
  f.time(60_001); f.ready("b"); f.players[0].failed();
  await vi.waitFor(() => expect(f.players).toHaveLength(2)); expect(f.players[0].stop).toHaveBeenCalledOnce();
  f.players[0].ended(); f.players[0].failed(); expect(f.controller.snapshot.messageId).toBe("b"); f.controller.stop();
});
it("A-D24-B2 thread switches serialize session handshakes on one connection before accepting the current context", async () => {
  const requests: Array<{ threadId: string; finish(): void }> = [], players: unknown[] = [];
  let serverSession = "";
  const post = vi.fn(async (path: string, body: any) => {
    if (path.endsWith("/session")) return new Promise<Response>(resolve => requests.push({ threadId: body.threadId, finish: () => {
      serverSession = "session-" + body.threadId; resolve(json({ sessionId: serverSession, bootId: "boot", threadId: body.threadId, revision: 0 }));
    } }));
    if (path.endsWith("/cancel")) return new Response(null, { status: 204 });
    expect(body.sessionId).toBe(serverSession);
    return path.endsWith("/target") ? plan() : audio();
  });
  const controller = new ReplyController({ post, player: () => { const player = { play: async () => {}, stop() {} }; players.push(player); return player; } });
  controller.configure(context); controller.hello("connection", "boot"); controller.caughtUp(); expect(requests).toHaveLength(1);
  controller.configure({ ...context, threadId: "b" }); controller.configure({ ...context, threadId: "b" });
  expect(requests).toHaveLength(1); requests[0].finish();
  await vi.waitFor(() => expect(requests).toHaveLength(2)); expect(requests[1].threadId).toBe("b"); requests[1].finish();
  await vi.waitFor(() => expect(controller.snapshot.status).toBe("idle"));
  controller.manual({ threadId: "b", messageId: "historical" }); await vi.waitFor(() => expect(players).toHaveLength(1));
  expect(serverSession).toBe("session-b"); controller.stop();
});
it("M1 invalidation between session creation and response acceptance advances playback revision", async () => {
  let accept!: () => void;
  const players: unknown[] = [];
  const post = vi.fn(async (path: string) => {
    if (path.endsWith("/session")) return new Promise<Response>(resolve => { accept = () => resolve(json({ sessionId: "session", bootId: "boot", threadId: "a", revision: 0 })); });
    if (path.endsWith("/target")) return plan();
    if (path.endsWith("/cancel")) return new Response(null, { status: 204 });
    return new Response(new Blob([
      replyFrame({ type: "start", value: { attemptId: "attempt", revision: 2, mime: "audio/mpeg" } }),
      replyFrame({ type: "audio", bytes: Uint8Array.of(1) }), replyFrame({ type: "complete" }),
    ]), { headers: { "content-type": REPLY_AUDIO_MIME } });
  });
  const controller = new ReplyController({ post, enabled: true, player: () => {
    const player = { play: async () => {}, stop() {} }; players.push(player); return player;
  } });
  controller.configure(context); controller.hello("connection", "boot"); controller.caughtUp();
  for (const revision of [2, 1]) controller.receive({ kind: "speech.invalidate", threadId: "a", bootId: "boot", revision });
  accept(); await vi.waitFor(() => expect(controller.snapshot.status).toBe("idle"));
  controller.receive({ kind: "speech.ready", threadId: "a", bootId: "boot", revision: 0, messageId: "stale", settlementId: "stale" });
  expect(post.mock.calls).toHaveLength(1);
  controller.receive({ kind: "speech.ready", threadId: "a", bootId: "boot", revision: 2, messageId: "new", settlementId: "new" });
  await vi.waitFor(() => expect(players).toHaveLength(1));
  controller.stop(); controller.manual({ threadId: "a", messageId: "manual" });
  await vi.waitFor(() => expect(players).toHaveLength(2)); controller.stop();
});
