// A message sent while a Fuigo bot works steers its running turn, through the
// real server and the fake ACP CLI (no Flux key). The server records the
// steered message itself, so each steer must end as exactly ONE persisted
// user message: when Fuigo runs it as its own `interject-fallback-` turn after
// the prompt result, and when Fuigo neither answers nor echoes it in time
// (uncertain: recorded once, marked unconfirmed, never queued, and the late
// echo clears the mark).
//
// Same server-spawn pattern as fuigo-unbound-image-api.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...desktopHeaders, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const messages = async (threadId: string) => (await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const busy = async (botId: string) => (await request("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId)?.busy;
const prompts = (instance: string) => {
  const dump = join(home, `${instance}-rpc.json`);
  return (existsSync(dump) ? (JSON.parse(readFileSync(dump, "utf8")) as string[]) : []).filter((method) => method === "session/prompt").length;
};
const userCopies = async (threadId: string, text: string) => (await messages(threadId)).filter((m) => m.role === "user" && m.text === text);

async function bootServer(homeDir: string, port: number): Promise<{ child: ChildProcess; desktop: Record<string, string> }> {
  const url = `http://127.0.0.1:${port}`;
  mkdirSync(join(homeDir, ".murage"), { recursive: true });
  mkdirSync(join(homeDir, ".fuigo"), { recursive: true });
  writeFileSync(join(homeDir, ".fuigo", "auth.json"), "{}");
  const instance = (name: string, interject: string) => ({
    driver: "fuigoAgent",
    environment: {
      FAKE_ACP_MODE: "echo-gated",
      FAKE_ACP_GATE_FILE: join(homeDir, `${name}.gate`),
      FAKE_ACP_RPC_DUMP: join(homeDir, `${name}-rpc.json`),
      FAKE_ACP_INTERJECT: interject,
      FAKE_ACP_LATE_ECHO_MS: "1500",
    },
    config: { cli: FAKE_ACP, fullAuto: false },
  });
  writeFileSync(
    join(homeDir, ".murage", "config.json"),
    JSON.stringify({ engineDiscovery: "explicit", instances: { fuigo: instance("fuigo", "fallback"), fuigoSilent: instance("fuigoSilent", "silent") } }),
  );
  const proc = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: homeDir,
      USERPROFILE: homeDir,
      MURAGE_PORT: String(port),
      MURAGE_WEBHOOK_PORT: String(port + 1),
      MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
      MURAGE_MODEL_PROVIDER_CONNECTIONS: "",
      MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "",
      MURAGE_FUIGO_INTERJECT_ACK_MS: "500",
      MURAGE_FUIGO_FALLBACK_GRACE_MS: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr!.on("data", (c) => (stderr += c));
  proc.stdout!.on("data", (c) => (stderr += c));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const proof = (await fetch(`${url}/api/desktop-secret`).then((r) => r.json())) as { secret: string };
  return { child: proc, desktop: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret } };
}

/** A bot on `instanceId` whose first turn is running and held at its gate. */
async function busyBot(name: string, instanceId: string): Promise<{ id: string; threadId: string }> {
  const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-acp-model" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await request("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);
  const first = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Count the invoices" });
  expect(first.status, JSON.stringify(first.body)).toBe(202);
  await expect.poll(() => prompts(instanceId), { timeout: 30_000 }).toBe(1);
  expect(await busy(bot.id)).toBe(true);
  return bot;
}

posixOnly("Fuigo steer persists one user message (fake ACP CLI through the server)", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-fuigo-steer-"));
    ({ child, desktop: desktopHeaders } = await bootServer(home, port));
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("a steer Fuigo runs as a fallback turn is one user message, and its reply lands in the same turn", async () => {
    const bot = await busyBot("Fuigo steer fallback", "fuigo");
    const steer = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Also check the totals" });
    expect(steer.status, JSON.stringify(steer.body)).toBe(202);
    expect(steer.body).toMatchObject({ steered: true });
    expect(steer.body.queued).toBeUndefined();
    writeFileSync(join(home, "fuigo.gate"), "go");
    await expect.poll(() => busy(bot.id), { timeout: 30_000 }).toBe(false);
    expect(await userCopies(bot.threadId, "Also check the totals")).toHaveLength(1);
    expect((await messages(bot.threadId)).some((m) => m.role === "bot" && String(m.text ?? "").includes("fallback reply #1"))).toBe(true);
    // Nothing queued behind it: no second prompt ran it again.
    await new Promise((r) => setTimeout(r, 1000));
    expect(prompts("fuigo")).toBe(1);
    expect(await userCopies(bot.threadId, "Also check the totals")).toHaveLength(1);
  }, 60_000);

  it("an unconfirmed steer is recorded once, never queued, and its late echo clears the status", async () => {
    const bot = await busyBot("Fuigo steer silent", "fuigoSilent");
    const steer = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "And the tax line" });
    expect(steer.status, JSON.stringify(steer.body)).toBe(202);
    expect(steer.body).toMatchObject({ steered: true });
    expect(steer.body.queued).toBeUndefined();
    const [recorded] = await userCopies(bot.threadId, "And the tax line");
    expect(recorded).toMatchObject({ steered: true, steerUnconfirmed: true });
    expect(typeof recorded.steerId).toBe("string");
    // Fuigo's late echo (1.5 s after the steer) confirms it.
    await expect.poll(async () => (await userCopies(bot.threadId, "And the tax line"))[0]?.steerUnconfirmed, { timeout: 15_000 }).toBe(false);
    writeFileSync(join(home, "fuigoSilent.gate"), "go");
    await expect.poll(() => busy(bot.id), { timeout: 30_000 }).toBe(false);
    await new Promise((r) => setTimeout(r, 1000));
    expect(prompts("fuigoSilent")).toBe(1);
    expect(await userCopies(bot.threadId, "And the tax line")).toHaveLength(1);
  }, 60_000);
});
