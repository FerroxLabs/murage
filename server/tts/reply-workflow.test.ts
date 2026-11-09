import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeReplySchema } from "./reply-schema.ts";
import { ReplyState, speechTransaction, type SpeechConnection } from "./reply-state.ts";
import { ReplyProvider } from "./reply-provider.ts";
import { ReplyCoordinator } from "./reply-coordinator.ts";
import { handleReplyRoute } from "./reply-route.ts";
import * as system from "./system-voices.ts";
import * as windows from "./windows-voices.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "murage-reply-workflow-")); cleanups.push(() => removeTempDirSync(dir));
  const db = new DatabaseSync(join(dir, "speech.db")); initializeReplySchema(db); cleanups.push(() => db.close());
  const connections = new Map<string, SpeechConnection>();
  let state!: ReplyState, coordinator!: ReplyCoordinator;
  const boot = () => {
    state = new ReplyState({ db: () => db, transaction: speechTransaction(db), emit: event => { for (const connection of connections.values()) connection.send(event); } }); state.boot();
    const provider = new ReplyProvider({ state, config: () => ({ tts: { provider: "flux", key: "own-fixture-key" } }), speech: () => [{ via: "flux", label: "Fixture", baseUrl: "https://speech.invalid/v1", key: "sk-flux-workflow", model: "flux-voice-speak" }], xai: () => null });
    coordinator = new ReplyCoordinator(state, provider, (threadId, messageId) => ({ threadId, messageId, botId: messageId.startsWith("own") ? "eleven" : "flux", eligible: threadId === "thread", source: "Hello. password: hst0001", voiceProvider: messageId.startsWith("own") ? "elevenlabs" : "flux", voice: messageId.startsWith("own") ? "fixtureVoice" : "marin" }));
  }; boot();
  const server = createServer((req, res) => { void handleReplyRoute(req.url!, res, { coordinator, principal: "desktop", ownerThread: thread => thread === "thread", connection: id => connections.get(id), readBody: async () => { let body = ""; for await (const chunk of req) body += chunk; return JSON.parse(body); } }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); cleanups.push(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, network = fetch;
  const payloads: Array<{ provider: string; body: any }> = [];
  const synthesize = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const own = String(url).includes("elevenlabs"); expect(String(url).startsWith("https://speech.invalid/") || own).toBe(true);
    expect(db.prepare("SELECT count(*) n FROM speech_attempts WHERE state='reserved'").get()?.n).toBe(1);
    payloads.push({ provider: own ? "elevenlabs" : "flux", body: JSON.parse(String(init?.body)) });
    return own ? new Response("synthetic-d24-audio-buffer-unique0123", { headers: { "content-type": "audio/mpeg" } }) : new Response("fixture budget", { status: 402 });
  }); vi.stubGlobal("fetch", synthesize);
  vi.spyOn(system, "systemVoicesAvailable").mockReturnValue(true); vi.spyOn(windows, "windowsVoicesAvailable").mockReturnValue(true);
  const native = vi.spyOn(system, "synthesizeSystem"), nativeWindows = vi.spyOn(windows, "synthesizeWindows");
  const { ReplyController } = await import("../../src/lib/tts/" + "reply-controller.ts");
  const client = async (connectionId: string) => {
    const players: any[] = [], posts: Array<{ path: string; body: any }> = [];
    const controller = new ReplyController({ enabled: true, post: (path: string, body: unknown, signal?: AbortSignal) => { posts.push({ path, body }); return network(base + path, { method: "POST", body: JSON.stringify(body), signal }); }, player: (_blob: unknown, ended: () => void) => { const player = { ended, play: vi.fn(async () => {}), stop: vi.fn() }; players.push(player); return player; } });
    const connection = { id: connectionId, principal: "desktop", send: (event: any) => { controller.receive(event); return true; }, terminate: () => controller.disconnect() };
    connections.set(connectionId, connection); cleanups.push(() => controller.disconnect());
    controller.configure({ desktop: true, hydrated: true, threadId: "thread", visible: true, call: false }); controller.hello(connectionId, state.bootId); controller.caughtUp(); await vi.waitFor(() => expect(controller.snapshot.status).toBe("idle"));
    return { controller, players, posts };
  };
  const settle = (messageId: string) => { state.begin("thread", messageId.startsWith("own") ? "eleven" : "flux", "g-" + messageId, "prompt"); state.bind("g-" + messageId, "p-" + messageId); state.settle("thread", "p-" + messageId, messageId, true); };
  return { db, boot, client, settle, payloads, synthesize, native, nativeWindows, persisted: () => readdirSync(dir).map(file => readFileSync(join(dir, file)).toString("utf8")).join(""), state: () => state };
}
it("S-budget real controller, routes and adapters keep a Flux hold across restart while own ElevenLabs manual and automatic speech work", async () => {
  const f = await fixture(), first = await f.client("first");
  f.settle("flux-a"); await vi.waitFor(() => expect(first.controller.snapshot.notice).toBe("budget")); expect(f.payloads.map(row => row.provider)).toEqual(["flux"]);
  first.controller.setEnabled(false); first.controller.manual({ threadId: "thread", messageId: "own-manual" }); await vi.waitFor(() => expect(first.players).toHaveLength(1)); first.players[0].ended();
  first.controller.setEnabled(true); f.settle("own-automatic"); await vi.waitFor(() => expect(first.players).toHaveLength(2)); first.players[1].ended();
  first.controller.manual({ threadId: "thread", messageId: "flux-alias" }); await vi.waitFor(() => expect(first.controller.snapshot.status).toBe("idle")); expect(f.payloads.filter(row => row.provider === "flux")).toHaveLength(1);
  const scope = f.db.prepare("SELECT account_scope_id FROM speech_accounts WHERE binding_id='flux'").get()?.account_scope_id;
  first.controller.disconnect(); f.boot(); const second = await f.client("second");
  second.controller.setEnabled(false); second.controller.manual({ threadId: "thread", messageId: "flux-after-restart" }); await vi.waitFor(() => expect(second.controller.snapshot.notice).toBe("budget")); expect(f.payloads.filter(row => row.provider === "flux")).toHaveLength(1);
  expect(f.db.prepare("SELECT account_scope_id FROM speech_accounts WHERE binding_id='flux'").get()?.account_scope_id).toBe(scope);
  second.controller.manual({ threadId: "thread", messageId: "own-after-restart" }); await vi.waitFor(() => expect(second.players).toHaveLength(1)); second.players[0].ended();
  second.controller.setEnabled(true); f.settle("own-auto-after-restart"); await vi.waitFor(() => expect(second.players).toHaveLength(2));
  expect(f.payloads.map(row => row.provider)).toEqual(["flux", "elevenlabs", "elevenlabs", "elevenlabs", "elevenlabs"]);
  expect(JSON.stringify(f.payloads)).not.toMatch(/hst0001|password:/); expect(f.native).not.toHaveBeenCalled(); expect(f.nativeWindows).not.toHaveBeenCalled();
  expect(f.persisted()).not.toMatch(/hst0001|Hello\.|own-fixture-key|sk-flux-workflow|synthetic-d24-audio-buffer-unique0123/);
});
it("S-restart-live a queued candidate cannot use the old session even before the client observes disconnect", async () => {
  const f = await fixture(), client = await f.client("first"); f.settle("own-a"); await vi.waitFor(() => expect(client.players).toHaveLength(1)); f.settle("own-b"); expect(client.controller.queue).toHaveLength(1);
  f.boot(); client.players[0].ended(); await vi.waitFor(() => expect(client.controller.snapshot.status).toBe("disconnected")); expect(f.payloads).toHaveLength(1); expect(client.players).toHaveLength(1);
  const fresh = await f.client("second"); expect(f.payloads).toHaveLength(1); f.settle("own-c"); await vi.waitFor(() => expect(fresh.players).toHaveLength(1)); expect(f.payloads).toHaveLength(2);
});
