import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { initializeReplySchema } from "./reply-schema.ts";
import { ReplyState, speechTransaction } from "./reply-state.ts";
import { ReplyProvider } from "./reply-provider.ts";
import { ReplyCoordinator } from "./reply-coordinator.ts";
import { handleReplyRoute } from "./reply-route.ts";
import { ReplyFrameReader, type ReplyFrame } from "../../shared/reply-speech.ts";
const cleanups: (() => void)[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function fixture() {
  const db = new DatabaseSync(":memory:"); initializeReplySchema(db); cleanups.push(() => { try { db.close(); } catch {} });
  const state = new ReplyState({ db: () => db, transaction: speechTransaction(db) }); state.boot();
  const connection = { id: "stream", principal: "desktop", send: vi.fn(() => true), terminate: vi.fn() };
  const session = state.session(connection, "thread");
  let allowed = true, principal: string | null = "desktop", voice = "marin";
  const provider = new ReplyProvider({ state, config: () => ({ tts: { provider: "flux" } }), speech: () => [{ via: "flux", label: "Fixture", baseUrl: "https://speech.invalid/v1", key: "sk-flux-route-fixture", model: "flux-voice-speak" }], xai: () => null });
  const coordinator = new ReplyCoordinator(state, provider, (threadId, messageId) => ({ threadId, messageId, botId: "bot", eligible: messageId === "message", source: "Hello.\n```\ncode\n```", voice, voiceProvider: "flux" }), 500);
  const server = createServer((req, res) => { void handleReplyRoute(req.url!, res, { principal, coordinator, ownerThread: () => allowed, connection: id => id === connection.id ? connection : undefined, readBody: async () => { let text = ""; for await (const chunk of req) text += chunk; return JSON.parse(text); } }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); cleanups.push(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port, network = globalThis.fetch;
  const post = (body: unknown, suffix = "", signal?: AbortSignal) => network(`http://127.0.0.1:${port}/api/tts/reply${suffix}`, { method: "POST", body: JSON.stringify(body), signal });
  const input = (sequence = 1) => ({ sessionId: session.sessionId, threadId: "thread", messageId: "message", action: "speak", commandSequence: sequence });
  const fetch = vi.fn(async () => {
    expect(db.prepare("SELECT count(*) n FROM speech_attempts WHERE state='reserved'").get()?.n).toBe(1);
    return new Response(Uint8Array.of(255, 243, 68), { headers: { "content-type": "audio/mpeg" } });
  }); vi.stubGlobal("fetch", fetch);
  return { db, state, session, connection, coordinator, post, input, fetch, setAllowed: (value: boolean) => { allowed = value; }, setPrincipal: (value: string | null) => { principal = value; }, setVoice: (value: string) => { voice = value; } };
}
async function frames(response: Response) { const seen: ReplyFrame[] = [], reader = new ReplyFrameReader(frame => seen.push(frame)); reader.push(new Uint8Array(await response.arrayBuffer())); reader.finish(); return seen; }
it("real route reserves before the real adapter, compiles complete source and gives one observable completion", async () => {
  const f = await fixture(); const response = await f.post(f.input()); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await frames(response)).map(frame => frame.type)).toEqual(["start", "audio", "complete"]);
  const init = (f.fetch.mock.calls as unknown as [unknown, RequestInit][])[0][1]; expect(JSON.parse(String(init.body)).input.toLowerCase()).toContain("code omitted");
  expect(f.db.prepare("SELECT state FROM speech_attempts").get()?.state).toBe("complete");
  const duplicate = await f.post(f.input()); expect(duplicate.status).toBe(200); expect(f.fetch).toHaveBeenCalledTimes(1);
});
it("strict bodies, desktop door, owner thread, stream binding and target membership precede every fetch", async () => {
  const f = await fixture();
  for (const extra of [{ text: "unsafe" }, { auto: true }, { accountScopeId: "forged" }, { action: "other" }]) expect((await f.post({ ...f.input(), ...extra })).status).toBe(400);
  expect((await f.post({ ...f.input(), messageId: "unknown" })).status).toBe(404);
  expect((await f.post({ threadId: "thread", connectionId: "forged" }, "/session")).status).toBe(409);
  f.setPrincipal(null); expect((await f.post(f.input())).status).toBe(403); f.setPrincipal("other"); expect((await f.post(f.input())).status).toBe(409);
  f.setPrincipal("desktop"); f.setAllowed(false); expect((await f.post(f.input())).status).toBe(404); expect(f.fetch).not.toHaveBeenCalled();
});
it("target metadata spends nothing, reveals no text and follows a changed plan", async () => {
  const f = await fixture(), body = { sessionId: f.session.sessionId, threadId: "thread", messageId: "message" };
  const a = await (await f.post(body, "/target")).json() as Record<string, unknown>; f.setVoice("cedar"); const b = await (await f.post(body, "/target")).json() as Record<string, unknown>;
  expect(Object.keys(a).sort()).toEqual(["accountScopeId", "available", "holdUntil", "planVersion", "serverNow"]); expect(b.accountScopeId).toBe(a.accountScopeId); expect(b.planVersion).not.toBe(a.planVersion);
  expect(f.db.prepare("SELECT count(*) n FROM speech_attempts").get()?.n).toBe(0); expect(f.fetch).not.toHaveBeenCalled();
});
it("automatic claims need a fresh successful settlement and are permanent across sessions", async () => {
  const f = await fixture(); f.state.begin("thread", "bot", "g", "p"); f.state.bind("g", "provider"); const settlement = f.state.settle("thread", "provider", "message", true)!;
  if (settlement.kind !== "speech.ready") throw new Error("wrong event");
  const { action: _, ...input } = f.input(); const body = { ...input, settlementId: settlement.settlementId };
  expect((await f.post({ ...body, settlementId: "forged" })).status).toBe(204); await frames(await f.post(body));
  const session = f.state.session(f.connection, "thread"); expect((await f.post({ ...body, sessionId: session.sessionId })).status).toBe(204); expect(f.fetch).toHaveBeenCalledTimes(1);
});
it("S-drop a provider body error never produces a successful terminal even after playable audio", async () => {
  const f = await fixture(); let controller!: ReadableStreamDefaultController<Uint8Array>;
  f.fetch.mockImplementation(async () => new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(Uint8Array.of(255, 243, 68)); } }), { headers: { "content-type": "audio/mpeg" } }));
  const pending = f.post(f.input()); await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
  const response = await pending; controller.error(new Error("private provider body"));
  await expect(frames(response)).rejects.toThrow("speech_incomplete"); expect(f.db.prepare("SELECT state FROM speech_attempts").get()?.state).toBe("failed");
});
it("S-remote cancellation stops the actual reader; stale commands cannot relaunch", async () => {
  const f = await fixture(), cancel = vi.fn();
  f.fetch.mockImplementation(async () => new Response(new ReadableStream({ start(c) { c.enqueue(Uint8Array.of(255)); }, cancel }), { headers: { "content-type": "audio/mpeg" } }));
  const response = await f.post(f.input());
  expect((await f.post({ sessionId: f.session.sessionId, threadId: "thread", commandSequence: 2 }, "/cancel")).status).toBe(204);
  await expect(frames(response)).rejects.toThrow(); expect(cancel).toHaveBeenCalledOnce(); expect((await f.post(f.input())).status).toBe(204); expect(f.fetch).toHaveBeenCalledOnce();
});
it("manual replacement waits for reader cancellation, not the old HTTP close", async () => {
  const f = await fixture(); let confirm!: () => void; const cancelled = new Promise<void>(resolve => { confirm = resolve; });
  f.fetch.mockImplementationOnce(async () => new Response(new ReadableStream({ start(c) { c.enqueue(Uint8Array.of(255)); }, cancel: () => cancelled }), { headers: { "content-type": "audio/mpeg" } }));
  const old = await f.post(f.input()); const replacement = f.post(f.input(2));
  await vi.waitFor(() => expect(f.db.prepare("SELECT state FROM speech_attempts").get()?.state).toBe("cancelled")); expect(f.fetch).toHaveBeenCalledOnce(); confirm();
  await frames(await replacement); await expect(frames(old)).rejects.toThrow(); expect(f.fetch).toHaveBeenCalledTimes(2);
});
it("unconfirmed cancellation refuses replacement without another provider invocation", async () => {
  const f = await fixture(); f.fetch.mockImplementationOnce(async () => new Response(new ReadableStream({ start(c) { c.enqueue(Uint8Array.of(255)); }, cancel: () => Promise.reject(new Error("cannot confirm")) }), { headers: { "content-type": "audio/mpeg" } }));
  const old = await f.post(f.input()); expect((await f.post(f.input(2))).status).toBe(409); await expect(frames(old)).rejects.toThrow(); expect(f.fetch).toHaveBeenCalledOnce();
});
it("budget response carries the durable opaque account hold without provider body", async () => {
  const f = await fixture(); f.fetch.mockImplementation(async () => new Response("private account text", { status: 402 }));
  const response = await f.post(f.input()), body = await response.json() as Record<string, unknown>; expect(response.status).toBe(402); expect(body.error).toBe("voice_budget_reached"); expect(body.accountScopeId).toEqual(expect.any(String)); expect(body.holdUntil).toBeGreaterThan(Number(body.serverNow)); expect(JSON.stringify(body)).not.toContain("private");
});

it("S-db 402 keeps opaque hold metadata when the database disappears after reservation", async () => {
  const f = await fixture();
  f.fetch.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 0)); f.db.close(); return new Response("private refusal", { status: 402 }); });
  const response = await f.post(f.input()), body = await response.json() as Record<string, unknown>;
  expect(response.status).toBe(402); expect(body.accountScopeId).toEqual(expect.any(String)); expect(body.planVersion).toEqual(expect.any(String)); expect(Number(body.holdUntil)).toBeGreaterThan(Number(body.serverNow));
  expect(f.fetch).toHaveBeenCalledOnce(); expect(JSON.stringify(body)).not.toContain("private");
});
it.each(["speech_accounts", "speech_plans", "speech_attempts", "speech_commands", "speech_sessions"])("S-db %s commit failure never admits an unreserved provider request", async table => {
  const f = await fixture();
  f.db.exec(`CREATE TRIGGER fail_reservation BEFORE ${table === "speech_sessions" ? "UPDATE" : "INSERT"} ON ${table} BEGIN SELECT RAISE(ABORT,'fixture'); END`);
  const response = await f.post(f.input()); expect(response.status).toBeGreaterThanOrEqual(400); expect(f.fetch).not.toHaveBeenCalled(); expect(f.db.prepare("SELECT count(*) n FROM speech_attempts").get()?.n).toBe(0);
});
it("S-db failed outcome commit cannot send a complete terminal or erase the uncertain reservation", async () => {
  const f = await fixture(); f.db.exec("CREATE TRIGGER fail_outcome BEFORE UPDATE ON speech_attempts WHEN NEW.state='complete' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  await expect(frames(await f.post(f.input()))).rejects.toThrow("speech_incomplete"); expect(f.fetch).toHaveBeenCalledOnce(); expect(f.db.prepare("SELECT state FROM speech_attempts").get()?.state).toBe("reserved");
});
