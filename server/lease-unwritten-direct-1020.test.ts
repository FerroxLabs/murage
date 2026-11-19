// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.20 A-1 (lease retry for an accepted, unwritten direct turn). Owners: ctxstop-lease builder owns this witness and the direct
// lease's retry flag (index.ts admitLedgerLease); the ledger lease lifecycle (ledger-refusal.ts) and the submission boundary
// (turn-dispatch-guard.ts sealFencedUnwritten) are unchanged and owned by their modules.
// The live shape (owner chat on a Fuigo-style engine): session/new answered, the first session/prompt held on MCP readiness,
// a roster change revokes every receipt, the ledger lease refuses the turn (site lease.ledger, generation null) and the
// owner saw "<engine> could not start this reply" with the engine stopped and no prompt ever written.
// Real server, real dispatch, real fake ACP process; the only fixture hook holds the engine's readiness announcement.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");

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
const promptDump = (name: string) => existsSync(join(home, `${name}.prompt`)) ? readFileSync(join(home, `${name}.prompt`), "utf8") : "";
async function poll<T>(read: () => Promise<T | null>, ms = 20_000): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (value) return value; if (Date.now() > deadline) return null; await new Promise(r => setTimeout(r, 150)); }
}
async function makeBot(name: string, instanceId: string) {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-model" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
}

describe("A-1 an accepted, unwritten direct owner turn refused by the ledger lease is rebuilt, not ended", () => {
  beforeAll(async () => {
    port = await freePortBlock([0, 1], 18_999, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = makeTestHome("murage-lease-unwritten-");
    expect(() => assertSafeToWipe(home)).not.toThrow();
    mkdirSync(join(home, ".murage"), { recursive: true });
    const engine = (name: string) => ({ driver: "grokAgent", config: { cli: FAKE_CLI, fullAuto: false }, environment: {
      FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized", FAKE_ACP_TOOL_KIND: "think",
      FAKE_ACP_MCP_READY_GATE_FILE: join(home, `${name}-ready`), FAKE_ACP_PROMPT_DUMP: join(home, `${name}.prompt`) } });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances: { held: engine("held"), other: engine("other") } }));
    writeFileSync(join(home, "other-ready"), "");
    child = spawn(process.execPath, ["--import", new URL("./testing/recall-ready-preload.mjs", import.meta.url).href, "--import", IDLE_LOAD_PRELOAD,
      "--import", "data:text/javascript," + encodeURIComponent("globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;"), join(SERVER_DIR, "index.ts")], {
      windowsHide: true, cwd: join(SERVER_DIR, ".."),
      env: { ...fixturePlatformEnv(), NODE_ENV: "test", ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stderr!.on("data", c => (stderr += c));
    child.stdout!.on("data", () => {});
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

  it("A-1 roster revoke after session/new and before session/prompt: one rebuilt prompt, a reply, no refusal row", async () => {
    const bot = await makeBot("Held reply", "held"), bystander = await makeBot("Roster bystander", "other");
    const gate = join(home, "held-ready");
    // the bot's seeded intro rows are not this turn's reply
    const seeded = new Set((await threadMessages(bot.threadId)).map(m => m.id));
    const fresh = async () => (await threadMessages(bot.threadId)).filter(m => !seeded.has(m.id));
    const replies = (rows: any[]) => rows.filter(m => m.role === "bot" && m.kind === "text" && m.actorKind !== "murage" && (m.text ?? "").trim());
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Fixture owner line" })).status).toBe(202);
    // the engine answered session/new (the turn id is handed back) and its first prompt waits on readiness
    expect(await poll(async () => existsSync(`${gate}.waiting`) || null), stderr.slice(-2000)).toBe(true);
    expect(promptDump("held")).toBe("");
    const before = stderr.length;
    // an audience change of another bot: the roster revokes every receipt on the machine (the live global revoke)
    expect((await api("PATCH", `/api/bots/${bystander.id}`, { section: "Moved while the reply waited" })).status).toBe(200);
    expect(await poll(async () => /ledger refusal|lease\.ledger|context revoked/.test(stderr.slice(before)) || null, 15_000), stderr.slice(before).slice(-3000)).toBe(true);
    writeFileSync(gate, "");
    expect(await poll(async () => replies(await fresh()).length > 0 || null, 60_000),
      `no reply; rows: ${JSON.stringify((await fresh()).map(m => [m.role, m.kind, m.text ?? m.tool?.name]))}\n${stderr.slice(before).slice(-4000)}`).toBe(true);
    const rows = await fresh();
    expect(rows.filter(m => /could not start this reply|couldn't start this reply|context is no longer available/i.test(`${m.text ?? ""} ${m.tool?.name ?? ""}`))).toEqual([]);
    expect(rows.filter(m => m.tool?.ok === false)).toEqual([]);
    expect(rows.filter(m => m.role === "user" && m.text === "Fixture owner line")).toHaveLength(1);
    // the rebuilt prompt Murage finally wrote carries the owner's line, and the turn has exactly one reply
    expect(promptDump("held")).toContain("Fixture owner line");
    expect(replies(rows)).toHaveLength(1);
    expect(stderr.slice(before)).not.toMatch(/turn_failure[^\n]*promptSent[^\n]*false/);
  }, 120_000);
});
