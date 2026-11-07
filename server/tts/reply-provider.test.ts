import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { ReplyProvider } from "./reply-provider.ts";
import { ReplyState, speechTransaction } from "./reply-state.ts";
import { initializeReplySchema } from "./reply-schema.ts";
import { markBudgetReached, resetUnavailable, type VoiceEndpoint } from "../voice/voice-routes.ts";
import { SpeechBudgetReached } from "./flux-speech.ts";
import { ProviderBudgetReached } from "./speech-policy.ts";
import { REST_ON_SCREEN } from "./speech-source.ts";
import type { AppConfig } from "../config.ts";
const databases: DatabaseSync[] = [];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetUnavailable(); for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new DatabaseSync(":memory:"); databases.push(db); initializeReplySchema(db);
  const state = new ReplyState({ db: () => db, transaction: speechTransaction(db) }); state.boot();
  const cfg: Pick<AppConfig, "tts"> = { tts: { provider: "flux", key: "own-eleven-fixture", voice: "marin" } };
  const routes: VoiceEndpoint[] = [
    { via: "flux", label: "fixture", key: "flux-fixture", baseUrl: "https://flux.invalid/v1", model: "flux-voice-speak" },
    { via: "openai", label: "alternate", key: "openai-fixture", baseUrl: "https://openai.invalid/v1", model: "gpt-4o-mini-tts" },
  ];
  const own = { key: "xai-fixture", baseUrl: "https://xai.invalid/v1" };
  const provider = new ReplyProvider({ config: () => cfg, speech: () => routes, xai: () => own, state });
  return { db, state, cfg, routes, own, provider };
}
async function consume(run: ReturnType<ReplyProvider["start"]>) {
  const clip = await run.audio; const bytes = "stream" in clip ? new Uint8Array(await new Response(clip.stream).arrayBuffer()) : clip.bytes;
  await run.closed; return bytes;
}
it.each([
  [{ voiceProvider: "flux", voice: "marin" }, "flux.invalid", "flux-voice-speak"],
  [{ voiceProvider: "flux", voice: "eve" }, "flux.invalid", "flux-voice-speak-grok"],
  [{ voiceProvider: "flux", voice: "Aria" }, "flux.invalid", "flux-voice-speak-eleven"],
  [{ voiceProvider: "xai", voice: "eve" }, "xai.invalid", undefined],
  [{ voiceProvider: "elevenlabs", voice: "fixtureVoiceId" }, "api.elevenlabs.io", "eleven_flash_v2_5"],
] as const)("resolves %j once and invokes only its selected adapter", async (target, hostname, model) => {
  const f = fixture(); let body: any;
  const call = vi.fn(async (url: string, init: RequestInit) => { expect(new URL(url).hostname).toBe(hostname); body = JSON.parse(String(init.body)); return new Response(Uint8Array.of(1, 2), { headers: { "content-type": "audio/mpeg" } }); }); vi.stubGlobal("fetch", call);
  const prepared = f.provider.prepare(target, "Safe words.");
  expect(await consume(f.provider.start(prepared, new AbortController().signal))).toEqual(Uint8Array.of(1, 2));
  expect(call).toHaveBeenCalledOnce(); if (model) expect(body.model ?? body.model_id).toBe(model);
  expect(() => f.provider.start(prepared, new AbortController().signal)).toThrow();
});
it.each([400, 401, 403, 404, 429, 500, 502, 503])("P-fallback refuses HTTP %s without an alternate route, key or system call", async status => {
  const f = fixture();
  const call = vi.fn(async (url: string) => { expect(url).toContain("flux.invalid"); return new Response(JSON.stringify({ error: { code: "model_not_allowed", param: "voice", message: "password: fixture-sentinel" } }), { status }); }); vi.stubGlobal("fetch", call);
  const run = f.provider.start(f.provider.prepare({ voice: "Aria" }, "Safe words."), new AbortController().signal);
  await expect(run.audio).rejects.toThrow(); await run.closed; expect(call).toHaveBeenCalledOnce();
});
it.each(["flux", "xai", "elevenlabs"] as const)("H-G1-4 %s 402 ends the selected attempt with a fixed budget outcome", async voiceProvider => {
  const f = fixture(); const call = vi.fn(async () => new Response("password: synthetic-budget-body", { status: 402 })); vi.stubGlobal("fetch", call);
  const run = f.provider.start(f.provider.prepare({ voiceProvider, voice: voiceProvider === "elevenlabs" ? "fixtureVoiceId" : voiceProvider === "xai" ? "eve" : "marin" }, "Safe words."), new AbortController().signal);
  const error = await run.audio.catch(error => error); expect(error instanceof SpeechBudgetReached || error instanceof ProviderBudgetReached).toBe(true);
  await run.closed; expect(call).toHaveBeenCalledOnce(); expect(error.message).not.toContain("synthetic-budget-body");
});
it("a held Flux key makes zero fetches, while an independent own account is usable", async () => {
  const f = fixture(); markBudgetReached(f.routes[0]); const call = vi.fn(async () => new Response(Uint8Array.of(1), { headers: { "content-type": "audio/mpeg" } })); vi.stubGlobal("fetch", call);
  const held = f.provider.start(f.provider.prepare({}, "Safe words."), new AbortController().signal);
  await expect(held.audio).rejects.toBeInstanceOf(SpeechBudgetReached); await held.closed; expect(call).not.toHaveBeenCalled();
  await consume(f.provider.start(f.provider.prepare({ voiceProvider: "elevenlabs", voice: "fixtureVoiceId" }, "Safe words."), new AbortController().signal)); expect(call).toHaveBeenCalledOnce();
});
it("P-budget-scope keeps random account ids across aliases, rename, selection toggles and restart; credentials and voice plans change separately", () => {
  const f = fixture(), initial = f.provider.resolve({});
  f.routes[0].label = "renamed";
  expect(f.provider.resolve({})).toMatchObject({ accountScopeId: initial.accountScopeId, planVersion: initial.planVersion });
  const anotherVoice = f.provider.resolve({ voice: "Aria" }); expect(anotherVoice.accountScopeId).toBe(initial.accountScopeId); expect(anotherVoice.planVersion).not.toBe(initial.planVersion);
  f.cfg.tts!.provider = "xai"; expect(f.provider.resolve({ voice: "eve" }).accountScopeId).not.toBe(initial.accountScopeId);
  f.cfg.tts!.provider = "flux"; expect(f.provider.resolve({}).accountScopeId).toBe(initial.accountScopeId);
  const state = new ReplyState({ db: () => f.db, transaction: speechTransaction(f.db) }); state.boot();
  const fresh = new ReplyProvider({ config: () => f.cfg, speech: () => f.routes, xai: () => f.own, state });
  expect(fresh.resolve({})).toMatchObject({ accountScopeId: initial.accountScopeId, planVersion: initial.planVersion });
  f.routes[0].key = "replacement-fixture"; expect(fresh.resolve({}).accountScopeId).not.toBe(initial.accountScopeId);
  const rows = JSON.stringify(f.db.prepare("SELECT * FROM speech_accounts").all()); expect(rows).not.toMatch(/flux-fixture|replacement-fixture|Safe words|renamed/);
  expect(initial.accountScopeId).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
});
it.each(["system", "missing", "voice", "forged"])("rejects %s plans before any provider call", mode => {
  const f = fixture(); const call = vi.fn(); vi.stubGlobal("fetch", call);
  if (mode === "system") expect(() => f.provider.prepare({ voiceProvider: "system" }, "Safe words.")).toThrow();
  else if (mode === "missing") { f.routes.splice(0); expect(() => f.provider.prepare({}, "Safe words.")).toThrow(); }
  else if (mode === "voice") expect(() => f.provider.prepare({ voice: "not-offered" }, "Safe words.")).toThrow();
  else expect(() => f.provider.start({ plan: f.provider.resolve({}), text: "forged" }, new AbortController().signal)).toThrow();
  expect(call).not.toHaveBeenCalled();
});
it.each([
  [false, "a".repeat(3000)], // control: length cap, keeps Room member says
  [false, "Safe. ".repeat(400)], // control: length cap
  [false, "😀".repeat(1800)], // control: length cap
  [false, "cost $100 ".repeat(200)], // control: length cap
  [true, "Hello. password: hunter2"], // red-at-head: label; HEAD retains Room member says
] as const)("P-cap actual adapter payload bounds speech (whole cut %s)", async (wholeCut, source) => {
  const f = fixture(); let payload = "";
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => { payload = JSON.parse(String(init.body)).input; return new Response(Uint8Array.of(1), { headers: { "content-type": "audio/mpeg" } }); }));
  const prepared = f.provider.prepare({}, source, "Room member"); await consume(f.provider.start(prepared, new AbortController().signal));
  expect(payload).toBe(prepared.text); expect(payload.length).toBeLessThanOrEqual(1500); expect(payload).not.toContain("hunter2");
  if (wholeCut) expect(payload).toBe(REST_ON_SCREEN);
  else { expect(payload).toContain("Room member says"); expect(payload).toContain("The rest is on screen."); }
  expect(payload).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});

it("P-private success, refusal and abort leave no speech or credentials in metadata, diagnostics or temporary files", async () => {
  const { mkdtempSync, readdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const priorTmp = process.env.TMPDIR, isolated = mkdtempSync(join(tmpdir(), "p-private-"));
  process.env.TMPDIR = isolated;
  onTestFinished(() => { if (priorTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = priorTmp; rmSync(isolated, { recursive: true, force: true }); });
  expect(resolve(tmpdir())).toBe(resolve(isolated));
  const f = fixture(), before = new Set(readdirSync(tmpdir(), { recursive: true, encoding: "utf8" }));
  const logs: unknown[][] = [];
  for (const level of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args) => { logs.push(args); });
  const text = "Synthetic reply marker fixture-safe-text. password: secret-marker";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(Uint8Array.of(31, 41, 59), { headers: { "content-type": "audio/mpeg" } })));
  await consume(f.provider.start(f.provider.prepare({}, text), new AbortController().signal));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: text + " flux-fixture" } }), { status: 500 })));
  const failure = f.provider.start(f.provider.prepare({}, text), new AbortController().signal); await expect(failure.audio).rejects.toThrow(); await failure.closed;
  const control = new AbortController(); const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ pull() {}, cancel }), { headers: { "content-type": "audio/mpeg" } })));
  const aborted = f.provider.start(f.provider.prepare({}, text), control.signal); const clip = await aborted.audio; control.abort(); await aborted.closed;
  expect("stream" in clip).toBe(true); expect(cancel).toHaveBeenCalledOnce();
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'speech_%'").all();
  const records = JSON.stringify(tables.map(row => f.db.prepare(`SELECT * FROM ${String(row.name)}`).all()));
  expect(records + JSON.stringify(logs)).not.toMatch(/fixture-safe-text|secret-marker|flux-fixture|31,41,59/);
  expect(readdirSync(tmpdir(), { recursive: true, encoding: "utf8" }).filter(name => !before.has(name))).toEqual([]);
});
it("P-budget-scope a durable hold follows the configured account across voice aliases but not an independent account", () => {
  const f = fixture(); const plan = f.provider.resolve({ voice: "marin" });
  const session = f.state.session({ id: "connection", principal: "owner", send: () => true, terminate: () => {} }, "thread");
  const input = { sessionId: session.sessionId, principal: "owner", connectionId: "connection", threadId: "thread", messageId: "message", commandSequence: 1, action: "speak" as const };
  const attempt = f.state.reserve(input, () => ({ target: { threadId: "thread", messageId: "message", botId: "bot", eligible: true }, account: plan }));
  f.state.finish(attempt, "budget");
  const alias = f.provider.resolve({ voice: "Aria" }); expect(alias.accountScopeId).toBe(plan.accountScopeId); expect(alias.holdUntil).toBeGreaterThan(alias.serverNow);
  const independent = f.provider.resolve({ voiceProvider: "elevenlabs", voice: "fixtureVoiceId" }); expect(independent.holdUntil).toBe(0);
  expect(() => f.state.reserve({ ...input, commandSequence: 2 }, () => ({ target: { threadId: "thread", messageId: "message", botId: "bot", eligible: true }, account: alias }))).toThrow("voice_budget_reached");
});
