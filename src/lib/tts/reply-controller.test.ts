import { expect, it, vi } from "vitest";
import { ReplyController, type ReplyContext } from "./reply-controller";
import { replyFrame, REPLY_AUDIO_MIME } from "../../../shared/reply-speech";
const packet = (complete = true) => new Response(new Blob([
  replyFrame({ type: "start", value: { attemptId: "attempt", revision: 0, mime: "audio/mpeg" } }),
  replyFrame({ type: "audio", bytes: Uint8Array.of(255, 243, 68) }),
  ...(complete ? [replyFrame({ type: "complete" })] : []),
]), { headers: { "content-type": REPLY_AUDIO_MIME } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
async function fixture(enabled = true) {
  let now = 10_000, budget = false, incomplete = false;
  const plays: Array<{ ended(): void; failed(): void; play: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  const requests: Array<{ path: string; body: any; signal?: AbortSignal }> = [];
  const post = vi.fn(async (path: string, body: any, signal?: AbortSignal) => {
    requests.push({ path, body, signal });
    if (path.endsWith("/session")) return json({ sessionId: "session", bootId: "boot", threadId: body.threadId, revision: 0 });
    if (path.endsWith("/cancel")) return new Response(null, { status: 204 });
    const independent = body.messageId.startsWith("own"), scope = independent ? "eleven" : "flux";
    if (path.endsWith("/target")) return json({ accountScopeId: scope, planVersion: scope, holdUntil: budget && !independent ? 610_000 : 0, serverNow: now, available: true });
    if (budget && !independent) return json({ error: "voice_budget_reached", accountScopeId: scope, planVersion: scope, holdUntil: 610_000, serverNow: now }, 402);
    return packet(!incomplete);
  });
  const save = vi.fn();
  const controller = new ReplyController({ post, now: () => now, enabled, saveEnabled: save, player: (_blob, ended, failed) => { const player = { ended, failed, play: vi.fn(async () => {}), stop: vi.fn() }; plays.push(player); return player; } });
  const context: ReplyContext = { desktop: true, hydrated: true, threadId: "thread", visible: true, call: false };
  controller.configure(context); controller.hello("stream", "boot"); controller.caughtUp();
  await vi.waitFor(() => expect(controller.snapshot.status).toBe("idle"));
  const ready = (messageId: string, extra = {}, replayed = false) => controller.receive({ kind: "speech.ready", threadId: "thread", messageId, settlementId: `settled-${messageId}`, bootId: "boot", revision: 0, ...extra }, replayed);
  const syntheses = () => requests.filter(request => request.path === "/api/tts/reply");
  return { controller, context, ready, post, plays, requests, syntheses, save, time: (time: number) => { now = time; }, budget: () => { budget = true; }, incomplete: () => { incomplete = true; } };
}
it("S-end and S-room own playback through ended, with three waiting FIFO items and no automatic preemption", async () => {
  const f = await fixture(); f.ready("a"); await vi.waitFor(() => expect(f.plays).toHaveLength(1));
  for (const id of ["b", "c", "d", "e"]) f.ready(id);
  expect(f.syntheses()).toHaveLength(1); expect(f.controller.snapshot).toMatchObject({ status: "waiting-for-player-end", messageId: "a" });
  f.plays[0].ended(); await vi.waitFor(() => expect(f.plays).toHaveLength(2)); expect(f.syntheses().map(request => request.body.messageId)).toEqual(["a", "c"]);
  f.plays[0].ended(); f.plays[0].failed(); expect(f.controller.snapshot.messageId).toBe("c");
  f.plays[1].ended(); await vi.waitFor(() => expect(f.plays).toHaveLength(3)); expect(f.controller.snapshot.messageId).toBe("d"); f.controller.stop();
});
it("S-manual and S-toggle manual works with the switch off, replaces by identity and the second press stops", async () => {
  const f = await fixture(false); f.ready("automatic"); expect(f.syntheses()).toHaveLength(0);
  f.controller.manual({ threadId: "thread", messageId: "historical" }); await vi.waitFor(() => expect(f.plays).toHaveLength(1));
  f.controller.manual({ threadId: "thread", messageId: "replacement" }); expect(f.plays[0].stop).toHaveBeenCalledOnce(); await vi.waitFor(() => expect(f.plays).toHaveLength(2));
  f.plays[0].ended(); expect(f.controller.snapshot.messageId).toBe("replacement");
  f.controller.manual({ threadId: "thread", messageId: "replacement" }); expect(f.plays[1].stop).toHaveBeenCalledOnce(); expect(f.controller.snapshot.status).toBe("idle");
  expect(f.syntheses().map(request => request.body.action)).toEqual(["speak", "speak"]); expect(f.syntheses().every(request => !Object.hasOwn(request.body, "text"))).toBe(true);
});
it("S-hydrate and S-patch discard raw ineligible or replayed events permanently", async () => {
  const f = await fixture();
  f.controller.receive({ kind: "message", threadId: "thread", message: { role: "bot", turnTerminal: true, text: "reply" } });
  f.controller.receive({ kind: "message.patch", threadId: "thread" }); f.ready("replay", {}, true); f.ready("other", { threadId: "other" }); f.ready("old-boot", { bootId: "old" });
  f.controller.configure({ ...f.context, hydrated: false }); f.ready("pre-hydration");
  f.controller.configure(f.context); await vi.waitFor(() => expect(f.controller.snapshot.status).toBe("idle"));
  expect(f.syntheses()).toHaveLength(0); f.ready("fresh"); await vi.waitFor(() => expect(f.plays).toHaveLength(1)); f.controller.stop();
});
it.each(["hidden", "call", "thread", "disconnect", "sessionClosed", "invalidate"])("S-stop %s tears down fully downloaded audio and all queued work", async kind => {
  const f = await fixture(); f.ready("a"); await vi.waitFor(() => expect(f.plays).toHaveLength(1)); f.ready("b");
  if (kind === "hidden") f.controller.setVisible(false);
  if (kind === "call") f.controller.setCall(true);
  if (kind === "thread") f.controller.configure({ ...f.context, threadId: "other" });
  if (kind === "disconnect") f.controller.disconnect();
  if (kind === "sessionClosed") f.controller.receive({ kind: "speech.sessionClosed", sessionId: "session", bootId: "boot", reason: "durable_stop_failed" });
  if (kind === "invalidate") f.controller.receive({ kind: "speech.invalidate", threadId: "thread", revision: 1, bootId: "boot" });
  expect(f.plays[0].stop).toHaveBeenCalledOnce(); f.plays[0].ended(); expect(f.syntheses()).toHaveLength(1); expect(f.controller.snapshot.messageId).toBeUndefined();
});
it("switch off drops automatic work but preserves manual playback and later manual commands", async () => {
  const f = await fixture(); f.ready("a"); await vi.waitFor(() => expect(f.plays).toHaveLength(1)); f.ready("b"); f.controller.setEnabled(false);
  expect(f.plays[0].stop).toHaveBeenCalledOnce(); expect(f.save).toHaveBeenCalledWith(false);
  f.controller.manual({ threadId: "thread", messageId: "manual" }); await vi.waitFor(() => expect(f.plays).toHaveLength(2)); f.controller.setEnabled(false); expect(f.plays[1].stop).not.toHaveBeenCalled();
  f.controller.setEnabled(true); f.plays[1].ended(); expect(f.syntheses()).toHaveLength(2);
});
it("S-drop missing completion cannot create a player even for decodable partial audio", async () => {
  const f = await fixture(); f.incomplete(); f.ready("a"); await vi.waitFor(() => expect(f.controller.snapshot.notice).toBe("failed")); expect(f.plays).toHaveLength(0);
});
it("P-budget-scope resolves unknown targets independently and expiry does not revive dropped items", async () => {
  const f = await fixture(); f.budget(); f.ready("held"); f.ready("queued"); await vi.waitFor(() => expect(f.controller.snapshot.notice).toBe("budget")); expect(f.syntheses()).toHaveLength(0);
  f.controller.setEnabled(false); f.controller.manual({ threadId: "thread", messageId: "own-manual" }); await vi.waitFor(() => expect(f.plays).toHaveLength(1)); f.plays[0].ended();
  f.controller.setEnabled(true); f.ready("own-auto"); await vi.waitFor(() => expect(f.plays).toHaveLength(2)); f.plays[1].ended();
  f.time(700_000); expect(f.syntheses().map(request => request.body.messageId)).toEqual(["own-manual", "own-auto"]);
});
it("S-visible queued freshness is measured from raw arrival, never from dequeue", async () => {
  const f = await fixture(); f.ready("a"); await vi.waitFor(() => expect(f.plays).toHaveLength(1)); f.ready("b"); f.time(70_000); f.plays[0].ended(); expect(f.syntheses()).toHaveLength(1);
});
it("stale metadata responses cannot speak after local cancellation", async () => {
  const f = await fixture(); let resolve!: (response: Response) => void; f.post.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; })); f.ready("a"); f.controller.stop();
  resolve(json({ accountScopeId: "flux", planVersion: "flux", holdUntil: 0, serverNow: 0 })); await Promise.resolve(); await Promise.resolve(); expect(f.syntheses()).toHaveLength(0); expect(f.plays).toHaveLength(0);
});

it("S-budget actual 402 clears waiting work and an independent account remains usable in the same controller", async () => {
  const f = await fixture();
  f.post.mockImplementationOnce(async () => json({ accountScopeId: "flux", planVersion: "flux", holdUntil: 0, serverNow: 10_000 }));
  f.post.mockImplementationOnce(async () => json({ error: "voice_budget_reached", accountScopeId: "flux", planVersion: "flux", holdUntil: 610_000, serverNow: 10_000 }, 402));
  f.ready("a"); f.ready("dropped"); f.budget(); await vi.waitFor(() => expect(f.controller.snapshot.notice).toBe("budget")); expect(f.plays).toHaveLength(0);
  f.controller.setEnabled(false); f.controller.manual({ threadId: "thread", messageId: "own-manual" }); await vi.waitFor(() => expect(f.plays).toHaveLength(1));
  f.plays[0].ended(); f.controller.setEnabled(true); f.ready("own-auto"); await vi.waitFor(() => expect(f.plays).toHaveLength(2)); f.controller.stop();
});
it("P-prose the device switch starts off without a saved affirmative choice", () => {
  const controller = new ReplyController({ post: vi.fn(), player: vi.fn() }); expect(controller.snapshot.enabled).toBe(false);
});
