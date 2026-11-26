// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The fake Claude initializes MCP through the real relay before reading the owner prompt.
// The fixture supplies a failed lookup at initialize. The real fence decides whether to seal.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestHome, removeTempDir } from "./testing/cleanup.ts";
import { assertSafeToWipe } from "./testing/safe-wipe.mjs";
import { freePortBlock } from "./testing/ports.ts";
import { fixtureDisplayApi } from "./testing/display-fixture.ts";
import { prepareFixtureRecall } from "./testing/recall-ready-fixture.ts";
import { fixturePlatformEnv, stopFixtureServer } from "./testing/platform-fixtures.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const IDLE_LOAD_PRELOAD = pathToFileURL(join(SERVER_DIR, "testing", "idle-load-preload.mjs")).href;
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const REQUEST_CHECK = "deferringPendingFence(() => emitConsumingTurnResponse(binding, requestDescriptor, { bytes: Buffer.byteLength(text + delimiter), refs: [], write: () => { entered = true; return write(); } }));";
const LOOKUP = "return refsLookup(file, refs, open.reader!, true, open.preparedWindow);";
const CHECKING_HOOK = `
import { registerHooks } from "node:module";
import { existsSync, unlinkSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
function firstInitialize() {
  const gate = process.env.HOME + "/checking-first-mcp";
  if (!existsSync(gate)) return false;
  unlinkSync(gate);
  console.warn("[fixture] first MCP initialize reads checking:lookup-error");
  return true;
}
globalThis.__firstInitialize = firstInitialize;
if (isMainThread) registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  let anchor, replacement;
  if (url.endsWith("/server/consuming-turn-ingress.ts")) {
    anchor = ${JSON.stringify(REQUEST_CHECK)};
    replacement = 'globalThis.__sealedChecking = rpc.method === "initialize" && globalThis.__firstInitialize(); try { ' + anchor + ' } finally { globalThis.__sealedChecking = false; }';
  } else if (url.endsWith("/server/memory/send-fence.ts")) {
    anchor = ${JSON.stringify(LOOKUP)};
    replacement = 'if (globalThis.__sealedChecking) return { state: "checking", reason: "lookup-error" } as const; ' + anchor;
  } else return loaded;
  const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
  if (source.split(anchor).length !== 2) throw new Error("sealed fixture anchor must match exactly once");
  return { ...loaded, source: source.replace(anchor, replacement) };
} });
`;

let port: number, base: string, home: string, child: ChildProcess, stderr = "";
let desktopHeaders: Record<string, string> = {};
const rawRequest = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const message = method === "POST" && /^\/api\/bots\/([^/]+)\/messages$/.exec(path);
  if (message && typeof (body as { threadId?: unknown })?.threadId === "string") await prepareFixtureRecall(join(home, ".murage"), message[1]!, (body as { threadId: string }).threadId);
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) as any };
};
const request = fixtureDisplayApi(() => join(home, ".murage", "messages.db"), rawRequest);
const api = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);
const threadMessages = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as any[];
async function poll<T>(read: () => Promise<T | null>, ms = 20_000): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (value) return value; if (Date.now() > deadline) return null; await new Promise(r => setTimeout(r, 150)); }
}

describe("owner chat when Claude's first MCP request is refused", () => {
  beforeAll(async () => {
    port = await freePortBlock([0, 1], 18_999, 200);
    base = `http://127.0.0.1:${port}`;
    home = makeTestHome("murage-mount-sealed-");
    expect(() => assertSafeToWipe(home)).not.toThrow();
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances: {
      sealed: { driver: "claudeAgent", config: { cli: FAKE_CLAUDE }, environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: join(home, "claude-dump.json") } } } }));
    child = spawn(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(CHECKING_HOOK),
      "--import", new URL("./testing/recall-ready-preload.mjs", import.meta.url).href, "--import", IDLE_LOAD_PRELOAD,
      "--import", "data:text/javascript," + encodeURIComponent("globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;"), join(SERVER_DIR, "index.ts")], {
      windowsHide: true, cwd: join(SERVER_DIR, ".."),
      env: { ...fixturePlatformEnv(), NODE_ENV: "test", ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stderr!.on("data", c => (stderr += c));
    child.stdout!.on("data", c => (stderr += c));
    const deadline = Date.now() + 25_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise(r => setTimeout(r, 150));
    }
    const proof = await rawRequest("GET", "/api/desktop-secret");
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 45_000);
  afterAll(async () => { await stopFixtureServer(child); await removeTempDir(home); });

  it("ends with exactly one memory-check failure the owner can retry", async () => {
    const created = await api("POST", "/api/bots", { name: "Sealed reply", modelSelection: { instanceId: "sealed", model: "claude-sonnet-5-5" } });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    const seeded = new Set((await threadMessages(bot.threadId)).map(m => m.id));
    const fresh = async () => (await threadMessages(bot.threadId)).filter(m => !seeded.has(m.id));
    writeFileSync(join(home, "checking-first-mcp"), "");
    const before = stderr.length;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Fixture owner line" })).status).toBe(202);
    const closed = await poll(async () => /claude close [^\n]+reason=(mount-relay-sealed|mounted-single-use)/.test(stderr.slice(before)) || null);
    const events = ["first MCP initialize reads checking:lookup-error", "[memory] retained fence refused", "mount failure seals the relay", "native fence refusal", "claude first-token"];
    expect(closed, `Observed: ${events.filter(event => stderr.slice(before).includes(event)).join(", ")}`).toBe(true);
    const trace = stderr.slice(before);
    const observed = events.filter(event => trace.includes(event)).join(", ");
    expect(trace.includes("first MCP initialize reads checking:lookup-error"), observed).toBe(true);
    expect(trace.includes("[memory] retained fence refused"), observed).toBe(true);
    expect(/mount failure seals the relay [^\n]+cause=refusal/.test(trace), observed).toBe(true);
    expect(trace.includes("claude first-token"), observed).toBe(false);
    expect(existsSync(join(home, "claude-dump.json"))).toBe(false);
    await poll(async () => (await fresh()).some(m => m.tool?.ok === false) || null, 2_000);
    const rows = await fresh();
    const sent = rows.filter(m => m.role === "user" && m.text === "Fixture owner line");
    expect(sent).toHaveLength(1);
    expect(rows.filter(m => m.role === "bot" && m.kind === "text" && m.actorKind !== "murage")).toEqual([]);
    expect(rows.filter(m => m.tool?.ok === false).map(m => m.tool.name)).toEqual([
      "error: Murage couldn’t check memory, so your message was not sent.",
    ]);
    expect(rows.at(-1)?.tool?.name).toBe("error: Murage couldn’t check memory, so your message was not sent.");

    // The chat's Retry uses the edit endpoint to rerun the same owner message.
    const retried = await api("POST", `/api/bots/${bot.id}/messages/${sent[0].id}/edit`, { threadId: bot.threadId, text: sent[0].text });
    expect(retried.status, JSON.stringify(retried.body)).toBe(202);
    expect(await poll(async () => /claude first-token/.test(stderr.slice(before)) || null)).toBe(true);
  }, 120_000);
});
