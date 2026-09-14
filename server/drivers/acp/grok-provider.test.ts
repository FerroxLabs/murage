import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DATA_DIR } from "../../config.ts";
import { applyProviderRoute, grokProviderIdentity, grokResumeBinding, removeGrokProviderHome, type ProviderTurnRoute } from "../../provider-routing.ts";
import { recordEvents } from "../../testing/events.ts";
import { GrokAgentDriver } from "./grok.ts";
import type { ProviderInstance, SendTurnInput } from "../../contracts.ts";
const fake = join(import.meta.dirname, "../../testing/fake-grok-provider-cli.ts");
const baseRoute: ProviderTurnRoute = { connectionId: "fixture-flux", revision: "revision-one", preset: "flux", protocol: "openai", baseUrl: "http://127.0.0.1:49999/v1", apiKey: "fake-selected-key", model: "vendor/pinned-model-v2" };
const threadPath = (threadId: string) => join(DATA_DIR, "native/grok-provider-context", createHash("sha256").update(threadId).digest("hex"));
async function turn(instance: ProviderInstance, input: SendTurnInput) {
  const events = recordEvents(instance.adapter);
  try {
    const sent = await instance.adapter.sendTurn(input);
    const completed = await events.until(e => e.type === "turn.completed" && e.turnId === sent.turnId);
    expect(await instance.adapter.awaitTurnTeardown?.(input.threadId, sent.turnId)).toMatchObject({ closeConfirmed: true });
    const started = events.events.find(e => e.type === "session.started");
    return { completed, sessionId: started?.type === "session.started" ? started.sessionId : undefined };
  } finally { events.stop(); }
}
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "murage-grok-routed-")), threadId = "grok-routing-" + randomUUID(), native = join(home, ".grok");
  mkdirSync(native); writeFileSync(join(native, "config.toml"), "# Native user configuration stays unchanged\n");
  const received: Array<{ path: string; auth?: string; body: any }> = [];
  const server = createServer(async (req, res) => { let bytes = ""; for await (const chunk of req) bytes += chunk;
    received.push({ path: req.url!, auth: req.headers.authorization, body: JSON.parse(bytes) }); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: "loopback fixture reply" } }] })); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const route = { ...baseRoute, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` }, dump = join(home, "dump.json");
  let instance: ProviderInstance | undefined;
  const create = async (environment = {}, cli = fake) => {
    instance = await GrokAgentDriver.create({ instanceId: "fixture-grok", displayName: "Grok fixture", enabled: true,
      environment: { HOME: home, USERPROFILE: home, GROK_HOME: native, GROK_CODE_XAI_API_KEY: "native-fallback-canary", FAKE_GROK_DUMP: dump, ...environment }, config: GrokAgentDriver.decodeConfig({ cli, fullAuto: false }) }); return instance;
  };
  return { home, native, threadId, route, received, create, dump: () => JSON.parse(readFileSync(dump, "utf8")),
    dispose: async () => { await instance?.dispose(); instance = undefined; },
    cleanup: async () => { await instance?.dispose(); await new Promise<void>(done => server.close(() => done())); rmSync(home, { recursive: true, force: true }); rmSync(threadPath(threadId), { recursive: true, force: true }); } };
}
it("creates a retained owned config with exact remote ID and no plaintext credentials or native config changes", () => {
  const thread = "grok-routing-" + randomUUID(), native = mkdtempSync(join(tmpdir(), "grok-native-canary-"));
  writeFileSync(join(native, "config.toml"), "keep native");
  const env: NodeJS.ProcessEnv = { GROK_HOME: native, GROK_CODE_XAI_API_KEY: "wrong", OPENAI_API_KEY: "wrong", GROK_SESSION_SUMMARY_MODEL: "unselected-model" };
  try {
    const first = applyProviderRoute("grokAgent", env, baseRoute, { threadId: thread });
    const config = readFileSync(join(env.GROK_HOME!, "config.toml"), "utf8");
    expect(config).toContain(`model = "${baseRoute.model}"`); expect(config).toContain('env_key = "MURAGE_GROK_PROVIDER_API_KEY"');
    expect(config).not.toContain(baseRoute.apiKey); expect(config).toContain(`default = "${first.model}"`);
    expect(config).toContain(`session_summary = "${first.model}"`); expect(env.GROK_SESSION_SUMMARY_MODEL).toBe(first.model);
    expect(env.MURAGE_GROK_PROVIDER_API_KEY).toBe(baseRoute.apiKey); expect(env.GROK_CODE_XAI_API_KEY).toBeUndefined();
    if (process.platform !== "win32") { expect(statSync(env.GROK_HOME!).mode & 0o077).toBe(0); expect(statSync(join(env.GROK_HOME!, "config.toml")).mode & 0o077).toBe(0); }
    const retained = env.GROK_HOME; first.cleanup(); expect(existsSync(retained!)).toBe(true);
    const second = applyProviderRoute("grokAgent", env, baseRoute, { threadId: thread }); expect(second.identity).toBe(first.identity); expect(env.GROK_HOME).toBe(retained);
    expect(readFileSync(join(native, "config.toml"), "utf8")).toBe("keep native");
    expect(() => removeGrokProviderHome(thread, first.identity!, false)).toThrow();
    removeGrokProviderHome(thread, first.identity!, true); expect(existsSync(retained!)).toBe(false);
  } finally { rmSync(native, { recursive: true, force: true }); rmSync(threadPath(thread), { recursive: true, force: true }); }
});
it("binds native cursor IDs to exact routing identity and refuses linked or malformed state", () => {
  const thread = "grok-routing-" + randomUUID(), env: NodeJS.ProcessEnv = {};
  try {
    const b = applyProviderRoute("grokAgent", env, baseRoute, { threadId: thread });
    grokResumeBinding(thread, b.identity!, undefined).record("native-session-id");
    expect(grokResumeBinding(thread, b.identity!, "native-session-id")).toMatchObject({ cursor: "native-session-id", replay: false });
    expect(grokResumeBinding(thread, grokProviderIdentity({ ...baseRoute, revision: "new" }, thread), "native-session-id")).toMatchObject({ cursor: null, replay: true });
    expect(grokResumeBinding(thread, null, "native-session-id")).toMatchObject({ cursor: null, replay: true });
    const file = join(env.GROK_HOME!, "config.toml"), original = readFileSync(file, "utf8"), target = join(threadPath(thread), "target");
    writeFileSync(target, "preserve", { mode: 0o600 }); unlinkSync(file); symlinkSync(target, file);
    expect(() => applyProviderRoute("grokAgent", env, baseRoute, { threadId: thread })).toThrow(); expect(readFileSync(target, "utf8")).toBe("preserve");
    unlinkSync(file); writeFileSync(file, original, { mode: 0o600 });
    writeFileSync(join(threadPath(thread), "resume-binding.json"), "invalid", { mode: 0o600 });
    expect(() => grokResumeBinding(thread, b.identity!, "native-session-id")).toThrow();
  } finally { rmSync(threadPath(thread), { recursive: true, force: true }); }
});
it("uses arbitrary selected catalog models through actual fake ACP and loopback, including resumed and restarted turns", async () => {
  const f = await fixture();
  try {
    let instance = await f.create();
    const first = await turn(instance, { threadId: f.threadId, text: "first", model: f.route.model, providerRoute: f.route,
      integrations: { agents: { command: "node", args: ["fixture-tools"], env: {} } } });
    expect(first.completed).toMatchObject({ ok: true }); const one = f.dump(), retained = one.grokHome;
    expect(one.calls.some((c: any) => c.method === "authenticate")).toBe(false); expect(one.nativeFallback).toBeNull();
    const slug = one.argv[one.argv.indexOf("-m") + 1]; expect(slug).toMatch(/^murage_/); expect(one.argv.indexOf("-m")).toBeGreaterThan(one.argv.indexOf("agent"));
    expect(one.calls.find((c: any) => c.method === "session/set_model").params.modelId).toBe(slug);
    expect(JSON.stringify(one.calls.find((c: any) => c.method === "session/new").params.mcpServers)).toContain("fixture-tools");
    await turn(instance, { threadId: f.threadId, text: "second", model: f.route.model, providerRoute: f.route, resumeCursor: first.sessionId });
    expect(f.dump().grokHome).toBe(retained); expect(f.dump().calls.some((c: any) => c.method === "session/load")).toBe(true);
    await f.dispose(); instance = await f.create();
    await turn(instance, { threadId: f.threadId, text: "after instance restart", model: f.route.model, providerRoute: f.route, resumeCursor: first.sessionId });
    expect(f.dump().grokHome).toBe(retained); expect(f.dump().calls.some((c: any) => c.method === "session/load")).toBe(true);
    expect(f.received).toHaveLength(3); for (const r of f.received) expect(r).toMatchObject({ path: "/v1/chat/completions", auth: "Bearer " + f.route.apiKey, body: { model: f.route.model } });
    expect(readFileSync(join(retained, "config.toml"), "utf8")).not.toContain(f.route.apiKey);
    expect(readFileSync(join(f.native, "config.toml"), "utf8")).toContain("Native user configuration stays unchanged");
  } finally { await f.cleanup(); }
});
it("replays authorised history on route revision and native switches without loading a cursor in the wrong home", async () => {
  const f = await fixture();
  try {
    const instance = await f.create(); const history = [{ role: "user" as const, text: "prior conversation fact" }];
    const first = await turn(instance, { threadId: f.threadId, text: "first", providerRoute: f.route, model: f.route.model }); const firstHome = f.dump().grokHome;
    const changed = { ...f.route, revision: "revision-two", model: "another/arbitrary-model" };
    const next = await turn(instance, { threadId: f.threadId, text: "changed route", providerRoute: changed, model: changed.model, resumeCursor: first.sessionId, transcript: history });
    expect(f.dump().grokHome).not.toBe(firstHome); expect(f.dump().calls.some((c: any) => c.method === "session/load")).toBe(false);
    expect(f.received.at(-1)!.body.messages[0].content).toContain("prior conversation fact"); expect(f.received.at(-1)!.body.model).toBe(changed.model);
    const native = await turn(instance, { threadId: f.threadId, text: "native now", model: "grok-4.6", resumeCursor: next.sessionId, transcript: history });
    expect(f.dump().grokHome).toBe(f.native); expect(f.dump().calls.some((c: any) => c.method === "authenticate")).toBe(true); expect(f.dump().calls.some((c: any) => c.method === "session/load")).toBe(false);
    await turn(instance, { threadId: f.threadId, text: "provider again", model: changed.model, providerRoute: changed, resumeCursor: native.sessionId, transcript: history });
    expect(f.dump().calls.some((c: any) => c.method === "session/load")).toBe(false); expect(f.received).toHaveLength(3);
  } finally { await f.cleanup(); }
});
it("rejects model pin failure and changed submission authority before any provider request", async () => {
  const f = await fixture();
  try {
    let instance = await f.create({ FAKE_GROK_REJECT_MODEL: "1" });
    const failed = await turn(instance, { threadId: f.threadId, text: "must not submit", model: f.route.model, providerRoute: f.route }); expect(failed.completed).toMatchObject({ ok: false }); expect(f.received).toHaveLength(0);
    await f.dispose(); instance = await f.create();
    const fenced = await turn(instance, { threadId: f.threadId, text: "must not submit", model: f.route.model, providerRoute: f.route, beforeSubmit: () => { throw new Error("Selected connection revision changed"); } });
    expect(fenced.completed).toMatchObject({ ok: false }); expect(f.dump().calls.some((c: any) => c.method === "session/prompt")).toBe(false); expect(f.received).toHaveLength(0);
    await expect(instance.adapter.sendTurn({ threadId: f.threadId, text: "invalid protocol", providerRoute: { ...f.route, protocol: "responses" } })).rejects.toThrow();
    await expect(instance.adapter.sendTurn({ threadId: f.threadId, text: "missing replay", providerRoute: { ...f.route, revision: "changed" }, resumeCursor: "foreign-native-id" })).rejects.toThrow("Reload the conversation");
  } finally { await f.cleanup(); }
});
it("preserves permission denial and cancellation on routed Grok ACP turns", async () => {
  const f = await fixture();
  try {
    for (const mode of ["permission", "hang"]) {
      const instance = await f.create({ FAKE_ACP_MODE: mode }, join(import.meta.dirname, "../../testing/fake-acp-cli.ts"));
      const events = recordEvents(instance.adapter);
      try {
        const sent = await instance.adapter.sendTurn({ threadId: f.threadId, text: "fixture only", model: f.route.model, providerRoute: f.route });
        if (mode === "permission") {
          const request = await events.until(e => e.type === "request.opened");
          if (request.type !== "request.opened" || !request.requestId) throw new Error("Missing permission identity");
          expect(await instance.adapter.respondToRequest(f.threadId, request.requestId, { behavior: "deny" })).toBe("rejected");
        } else await instance.adapter.interruptTurn(f.threadId);
        await events.until(e => e.type === "turn.completed" && e.turnId === sent.turnId);
      } finally { events.stop(); await f.dispose(); }
    }
  } finally { await f.cleanup(); }
});
