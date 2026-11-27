// A line typed while a bot turn runs must be sent when that turn ends, whatever way it ends (1.0.23 queuedsend).
// Real harness server (server/index.ts) + the fake ACP CLI; every row sends through POST /api/bots/:id/messages while a turn
// holds the thread, ends the turn one way, and asserts the queued text reached the engine as the next prompt exactly once
// and left the queue (no `queued` line, no pending chip).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { fakeEngineImportArgs, powerBlockTestEnv } from "./testing/power-block-test.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const GROK_MCP_READY = { FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized" };

/** one row per way a turn ends: how the fake engine is held, and what the test does to end the turn */
const ENDS: Array<{ id: string; mode: string; end: "gate" | "interrupt"; steer?: true }> = [
  { id: "reply", mode: "gated-result:text", end: "gate" },
  { id: "empty", mode: "gated-result:empty", end: "gate" },
  { id: "cut-short", mode: "gated-result:other", end: "gate" },
  { id: "error", mode: "gated-result:error", end: "gate" },
  { id: "stop-acked", mode: "cancel-ack", end: "interrupt" },
  { id: "stop-rejected", mode: "cancel-reject", end: "interrupt" },
  { id: "stop-other-reason", mode: "cancel-other-reason", end: "interrupt" },
  { id: "stop-ignored", mode: "cancel-ignore", end: "interrupt" },
  { id: "stop-hung", mode: "hang", end: "interrupt" },
  // an engine that steers: the line goes into the running prompt (Fuigo's interject), and the turn then ends the same ways
  // (the control row: Fuigo runs the steered line as its own fallback turn right after the prompt's result, never as a second prompt)
  { id: "reply", mode: "gated-result:text", end: "gate", steer: true },
  { id: "error", mode: "gated-result:error", end: "gate", steer: true },
  { id: "stop-acked", mode: "cancel-ack", end: "interrupt", steer: true },
  { id: "stop-ignored", mode: "cancel-ignore", end: "interrupt", steer: true },
  { id: "stop-hung", mode: "hang", end: "interrupt", steer: true },
];

for (const steer of [false, true]) describe(`a line sent behind a running turn on an engine that ${steer ? "steers it in" : "queues it"} is sent when the turn ends, however it ends`, () => {
  const PORT = 18800 + Math.floor(Math.random() * 10_000) + (steer ? 20_000 : 0);
  const BASE = `http://127.0.0.1:${PORT}`;
  const rows = ENDS.filter((row) => Boolean(row.steer) === steer);
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let headers: Record<string, string> = {};
  const gate = (id: string) => join(home, "gates", `${id}.gate`);
  const rpc = (id: string) => join(home, "gates", `${id}.rpc`);
  const promptCount = (id: string) => (read(rpc(id)).match(/session\/prompt"/g) ?? []).length;
  /** a steerable engine keeps one process, so its prompts are counted; the others respawn per turn, so the last prompt is read */
  const firstInFlight = (row: (typeof ENDS)[number]) => (row.steer ? promptCount(row.id) >= 1 : read(lastPrompt(row.id)).includes(`first ${row.id}`));
  /** the control row's line ran as the engine's own fallback turn; every other row's line must come back as a prompt of its own
   * (a failed or stopped steering engine is respawned, so the rpc dump restarts: the last prompt is read, as for the queueing ones) */
  const fallbackRan = async (botId: string) => ((await botById(botId)).messages as any[]).some((m) => m.role === "bot" && String(m.text ?? "").includes("fallback reply #1"));
  const delivered = async (row: (typeof ENDS)[number], text: string, botId: string) => (row.steer ? (row.id === "reply" ? fallbackRan(botId) : read(lastPrompt(row.id)).includes(text)) : read(lastPrompt(row.id)).includes(text));
  const lastPrompt = (id: string) => join(home, "gates", `${id}.prompt`);

  const api = async (method: string, path: string, body?: Record<string, unknown>) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() as any };
  };
  const botById = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const until = async (probe: () => Promise<boolean>, what: string | (() => string), timeoutMs = 40_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await probe()) return;
      if (Date.now() > deadline) throw new Error(`${typeof what === "function" ? what() : what} never happened. stderr: ${stderr.slice(-1500)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-queued-ends-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    mkdirSync(join(home, "gates"), { recursive: true });
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
    const instances: Record<string, unknown> = {};
    for (const row of rows) {
      instances[`end_${row.id.replaceAll("-", "_")}`] = {
        driver: row.steer ? "fuigoAgent" : "customAcp",
        environment: { ...(row.steer ? { FAKE_ACP_MCP_READY: "1", FAKE_ACP_INTERJECT: "fallback", FAKE_ACP_LATE_ECHO_MS: "300" } : GROK_MCP_READY), FAKE_ACP_MODE: row.mode, FAKE_ACP_PROMPT_GATE: gate(row.id), FAKE_ACP_RPC_DUMP: rpc(row.id), FAKE_ACP_PROMPT_DUMP: lastPrompt(row.id) },
        config: { cli: FAKE_CLI, fullAuto: true },
      };
    }
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances }));
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, MURAGE_PORT: String(PORT), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1" };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    // one fixture host for both: the steering engine (Fuigo) gets its interject timing through the environment
    const steerEnv = steer ? { MURAGE_WEBHOOK_PORT: String(PORT + 1), MURAGE_MODEL_PROVIDER_CONNECTIONS: "", MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "", MURAGE_FUIGO_INTERJECT_ACK_MS: "500", MURAGE_FUIGO_FALLBACK_GRACE_MS: "500" } : {};
    child = spawn(process.execPath, [...fakeEngineImportArgs(), "--import", "data:text/javascript," + encodeURIComponent(`const { customAcpSupport: localFixtureHost } = await import(${JSON.stringify(new URL("./drivers/acp/custom.ts", import.meta.url).href)}); localFixtureHost.fluxReach = () => "elsewhere";`), join(SERVER_DIR, "index.ts")], {
      windowsHide: true, cwd: join(SERVER_DIR, ".."), env: { ...env, ...powerBlockTestEnv(), ...steerEnv }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    child.stdout!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 25_000;
    for (;;) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const proof = await (await fetch(`${BASE}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 40_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => child.kill("SIGKILL"), 15_000).unref?.(); // the data folder is wiped only once the server has really exited
    });
    removeTempDirSync(home);
  });

  for (const row of rows) {
    it(`${row.id}: the queued line is sent as the next turn, once`, async () => {
      const instanceId = `end_${row.id.replaceAll("-", "_")}`;
      const instance = (await api("GET", "/api/instances")).body.instances.find((entry: { instanceId: string }) => entry.instanceId === instanceId);
      if (!row.steer) expect(instance?.snapshot.state).toBe("available");
      const created = await api("POST", "/api/bots", { name: `Ends ${row.id}`, modelSelection: { instanceId, model: row.steer ? "fake-acp-model" : instance.models.default as string }, ...(row.steer ? {} : { requireAvailableModel: true }) });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const botId = created.body.bot.id as string;
      if (row.steer) expect((await api("PATCH", `/api/bots/${botId}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);
      const queuedText = `typed while running ${row.id}`;

      expect((await api("POST", `/api/bots/${botId}/messages`, { text: `first ${row.id}` })).status).toBe(202);
      await until(async () => firstInFlight(row), () => `the first prompt in flight (rpc ${read(rpc(row.id)).slice(0, 400)})`);
      const queued = await api("POST", `/api/bots/${botId}/messages`, { text: queuedText });
      expect(queued.body).toMatchObject(row.steer ? { ok: true, steered: true } : { ok: true, queued: true });

      if (row.end === "gate") writeFileSync(gate(row.id), "open");
      else expect((await api("POST", `/api/bots/${botId}/interrupt`)).status).toBe(200);

      // the queued words reach the engine as the next prompt, and the line leaves the queue
      await expect.poll(() => delivered(row, queuedText, botId), { timeout: 15_000, interval: 200, message: `the queued line sent as the next turn (prompts seen ${promptCount(row.id)})` }).toBe(true);
      await until(async () => {
        const line = (await botById(botId)).messages.find((m: any) => m.text === queuedText);
        return Boolean(line) && !line.queued;
      }, "the queued line out of the queue");
      // exactly once: give a duplicate drain time to show itself
      await new Promise((r) => setTimeout(r, 2_500));
      if (row.steer && row.id === "reply") expect(promptCount(row.id)).toBe(1); else expect((read(lastPrompt(row.id)).match(new RegExp(queuedText, "g")) ?? []).length).toBe(1);
      const snapshot = await botById(botId);
      expect(snapshot.messages.filter((m: any) => m.role === "user" && m.text === queuedText)).toHaveLength(1);
    }, 120_000);
  }
});
