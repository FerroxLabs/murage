// SPDX-License-Identifier: AGPL-3.0-or-later
// OVERREACH #5 (1.0.24 q1024-power), the server's own decision: a booted server (real dispatch, real index.ts resolver, real ACP driver, fake ACP CLI)
// with the power wrapper made live (a sandbox stand-in that logs each launch it is asked for and passes the command through). The owner's own chat turn must never reach the wrapper and
// must complete; a routine run (unattended) must still be wrapped. Entry point: POST /api/bots/:id/messages and
// POST /api/routines/:id/run -> server/index.ts installOwnerTurnResolver -> power-owner-adapter decorator -> acp core spawn -> spawnCli.
// (Claude, Codex and Fuigo are not wrapped on POSIX at all, so the POSIX witness uses the ACP engine; their Windows spawn is witnessed in
// drivers/power-owner-turn-engines-1024.test.ts.)
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
let base: string, desktop: Record<string, string>, child: ChildProcess, home: string, launchLog: string, output = "";
const launches = () => (existsSync(launchLog) ? readFileSync(launchLog, "utf8").split("\n").filter(Boolean).length : 0);
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...desktop, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
const messages = async (thread: string) => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).body.messages as any[];
const REPLY = "hello from fake acp";
/** The fake engine's own answer after `after` (a refusal or an error card is not it). */
const answered = async (thread: string, after: string) => { const all = await messages(thread); const at = all.findIndex(m => m.role === "user" && String(m.text).includes(after)); return at >= 0 && all.slice(at + 1).some(m => m.role === "bot" && String(m.text ?? "").includes(REPLY)); };
/** An automated run's own thread holds the engine's answer. */
const runAnswered = async (runId: string) => { const run = ((await api("GET", "/api/routines")).body.runs as any[]).find(r => r.id === runId); return run?.status === "completed" && run.threadId !== undefined && (await messages(run.threadId)).some(m => m.role === "bot" && String(m.text ?? "").includes(REPLY)); };
async function bot(name: string) {
  const made = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "acp", model: "fake-acp-model" } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  expect((await api("PATCH", `/api/bots/${made.body.bot.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);
  return made.body.bot as { id: string; threadId: string };
}

beforeAll(async () => {
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  chmodSync(FAKE_ACP, 0o755);
  home = mkdtempSync(join(tmpdir(), "murage-power-owner-index-"));
  launchLog = join(home, "launches");
  const wrapper = join(home, "sandbox");
  writeFileSync(wrapper, `#!/bin/sh\necho launched >> '${launchLog}'\nshift 2\nexec "$@"\n`);
  chmodSync(wrapper, 0o755);
  const preload = join(home, "wrap-preload.mjs");
  writeFileSync(preload, `const hp = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "host-power.ts")).href)});
Object.assign(hp.hostPowerDeps, { platform: () => 'darwin', sandboxExec: ${JSON.stringify(wrapper)} });
Object.assign(hp.hostPowerProbeDeps, { runSync: () => ({ code: 0, stderr: '' }) });
globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = false;
`);
  mkdirSync(join(home, ".murage"), { recursive: true });
  writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: { acp: { driver: "grokAgent", environment: { FAKE_ACP_UNIQUE_SESSIONS: "1", FAKE_ACP_MCP_LIST: "all:ready", FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized" }, config: { cli: FAKE_ACP } } } }));
  child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, join(SERVER_DIR, "index.ts")], {
    windowsHide: true, cwd: join(SERVER_DIR, ".."), stdio: ["ignore", "pipe", "pipe"],
    env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_MODEL_PROVIDER_CONNECTIONS: "", MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "" },
  });
  child.stderr!.on("data", (c) => (output += c)); child.stdout!.on("data", (c) => (output += c));
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server never came up. output:\n${output.slice(-3000)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const proof = await (await fetch(`${base}/api/desktop-secret`)).json() as { secret: string };
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 60_000);
afterAll(async () => { await waitForExit(child, { signal: "SIGTERM" }); await removeTempDir(home); });

describe.skipIf(process.platform === "win32")("W-OWNER booted server: who gets the power wrapper", () => {
  it("the owner's own chat turn is never handed to the wrapper and completes", async () => {
    const b = await bot("Power owner");
    const before = launches();
    expect((await api("POST", `/api/bots/${b.id}/messages`, { threadId: b.threadId, text: "owner says hello" })).status).toBe(202);
    await expect.poll(() => answered(b.threadId, "owner says hello"), { timeout: 60_000 }).toBe(true);
    expect(launches() - before, `the owner turn reached the power wrapper\n${output.slice(-1500)}`).toBe(0);
  }, 120_000);

  it("a routine run (unattended) is still wrapped, and the owner's next turn still is not", async () => {
    const b = await bot("Power routine");
    const before = launches();
    const made = await api("POST", "/api/routines", { botId: b.id, name: "Wrapped routine", prompt: "routine says hello", enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() } });
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    const routineId = made.body.routine?.id ?? made.body.id;
    const started = await api("POST", `/api/routines/${routineId}/run`);
    expect(started.status).toBe(201);
    await expect.poll(() => launches() - before, { timeout: 60_000 }).toBeGreaterThan(0);
    // The run did reach the engine through the wrapper (not merely failed before spawn): the engine's own answer arrives.
    await expect.poll(() => runAnswered(started.body.run.id), { timeout: 60_000 }).toBe(true);
    const afterRoutine = launches();
    expect((await api("POST", `/api/bots/${b.id}/messages`, { threadId: b.threadId, text: "owner after routine" })).status).toBe(202);
    await expect.poll(() => answered(b.threadId, "owner after routine"), { timeout: 60_000 }).toBe(true);
    expect(launches() - afterRoutine).toBe(0);
  }, 150_000);

  it("a webhook turn (unattended) is wrapped", async () => {
    const b = await bot("Power webhook");
    const before = launches();
    const made = await api("POST", "/api/webhooks", { name: "Wrapped hook", prompt: "webhook says hello", botId: b.id });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const posted = await fetch(made.body.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "webhook says hello" }) });
    expect(posted.status, await posted.text()).toBeLessThan(300);
    await expect.poll(() => launches() - before, { timeout: 60_000 }).toBeGreaterThan(0);
    const attempts = (await api("GET", "/api/webhooks")).body.attempts as any[];
    await expect.poll(() => runAnswered(attempts.find(a => a.webhookId === made.body.webhook.id)?.runId), { timeout: 60_000 }).toBe(true);
  }, 150_000);
});
