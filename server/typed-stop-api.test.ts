// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Typed stop through the real server (designs/TYPED-STOP-107.md section 6): the owner's plain "stop" while a bot works on the
// conversation stops it like the Stop button, on an engine that steers (Fuigo) and on one that queues (custom ACP), and is never
// steered, queued or run as a turn, and leaves no line. Longer text, a reply, an unproven device and an idle bot keep today's behaviour.
// Same server-spawn pattern as fuigo-steer-api.test.ts. T1 and T2 fail on the base (the stop is steered or queued there).
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
/** The fake engine holds a prompt whose last line carries this open until it is cancelled (fake-acp-cli.ts). */
const HOLD = "\n__fixture_cancel_ack__";

let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown, proven = true): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(proven ? desktopHeaders : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const messages = async (threadId: string) => (await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const userTexts = async (threadId: string) => (await messages(threadId)).filter((m) => m.role === "user" && m.kind === "text").map((m) => m.text);
const busy = async (botId: string) => (await request("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId)?.busy;
/** Every request the instance's engine processes received, across respawns (FAKE_ACP_RPC_LOG, one JSON line each). */
const rpc = (instance: string) => {
  const log = join(home, `${instance}-rpc.log`);
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { method: string }).method) : [];
};
const count = (instance: string, method: string) => rpc(instance).filter((m) => m === method).length;
const settle = () => new Promise((r) => setTimeout(r, 1500));

const INSTANCES = { fuigoStop: "fuigoAgent", acpStop: "customAcp", acpReply: "customAcp", acpUnproven: "customAcp", fuigoIdle: "fuigoAgent", acpRetry: "customAcp" } as const;
type InstanceId = keyof typeof INSTANCES;

async function bootServer(homeDir: string, port: number): Promise<{ child: ChildProcess; desktop: Record<string, string> }> {
  const url = `http://127.0.0.1:${port}`;
  mkdirSync(join(homeDir, ".murage"), { recursive: true });
  mkdirSync(join(homeDir, ".fuigo"), { recursive: true });
  writeFileSync(join(homeDir, ".fuigo", "auth.json"), "{}");
  const instances = Object.fromEntries(Object.entries(INSTANCES).map(([name, driver]) => [name, {
    driver,
    environment: { FAKE_ACP_RPC_LOG: join(homeDir, `${name}-rpc.log`), FAKE_ACP_INTERJECT: "fallback" },
    config: { cli: FAKE_ACP, fullAuto: false },
  }]));
  writeFileSync(join(homeDir, ".murage", "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances }));
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

async function newBot(name: string, instanceId: InstanceId): Promise<{ id: string; threadId: string }> {
  const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-acp-model" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await request("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
}
/** A bot whose first turn is running, held open by the engine until it is cancelled. */
async function busyBot(name: string, instanceId: InstanceId): Promise<{ id: string; threadId: string }> {
  const bot = await newBot(name, instanceId);
  const first = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `Count the invoices${HOLD}` });
  expect(first.status, JSON.stringify(first.body)).toBe(202);
  await expect.poll(() => count(instanceId, "session/prompt"), { timeout: 30_000 }).toBe(1);
  expect(await busy(bot.id)).toBe(true);
  return bot;
}
const send = (bot: { id: string; threadId: string }, text: string, extra: Record<string, unknown> = {}, proven = true) =>
  request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, ...extra }, proven);

posixOnly("typed stop (fake ACP CLI through the server)", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-typed-stop-"));
    ({ child, desktop: desktopHeaders } = await bootServer(home, port));
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("T1/T3: on an engine that steers, 'stop using tabs' is steered and a plain 'Stop!' stops the turn without reaching the engine", async () => {
    const bot = await busyBot("Typed stop steer", "fuigoStop");
    const longer = await send(bot, "stop using tabs");
    expect(longer.status, JSON.stringify(longer.body)).toBe(202);
    expect(longer.body).toMatchObject({ steered: true });
    expect(await busy(bot.id)).toBe(true);
    const interjects = count("fuigoStop", "_fuigo/interject");

    const stop = await send(bot, "Stop!");
    expect(stop.status, JSON.stringify(stop.body)).toBe(202);
    expect(stop.body).toMatchObject({ stopped: true });
    expect(stop.body.cancelled).toBeUndefined(); // an acknowledgement: the composer keeps no draft of the words
    expect(stop.body.steered).toBeUndefined();
    expect(stop.body.queued).toBeUndefined();
    await expect.poll(() => busy(bot.id), { timeout: 15_000 }).toBe(false);
    await settle();
    expect(count("fuigoStop", "_fuigo/interject")).toBe(interjects); // the stop was never steered
    expect(count("fuigoStop", "session/prompt")).toBe(1);             // nor run as a turn
    // the words leave no line (nothing to quote, recall or replay); the stopped turn shows as a button Stop does
    expect(await userTexts(bot.threadId)).toEqual([`Count the invoices${HOLD}`, "stop using tabs"]);
  }, 60_000);

  it("T2/T10: on an engine that queues, 'stop' stops the turn instead of waiting in the queue; the next message runs as usual", async () => {
    const bot = await busyBot("Typed stop queue", "acpStop");
    const stop = await send(bot, "stop");
    expect(stop.status, JSON.stringify(stop.body)).toBe(202);
    expect(stop.body).toMatchObject({ stopped: true });
    expect(stop.body.cancelled).toBeUndefined(); // an acknowledgement: the composer keeps no draft of the words
    expect(stop.body.queued).toBeUndefined();
    await expect.poll(() => busy(bot.id), { timeout: 15_000 }).toBe(false);
    await settle();
    expect(count("acpStop", "session/prompt")).toBe(1);
    expect(await userTexts(bot.threadId)).toEqual([`Count the invoices${HOLD}`]);
    const next = await send(bot, "Now list the totals");
    expect(next.status, JSON.stringify(next.body)).toBe(202);
    await expect.poll(() => count("acpStop", "session/prompt"), { timeout: 30_000 }).toBe(2);
  }, 60_000);

  it("T4: a 'stop' written as a reply to a line is an ordinary message", async () => {
    const bot = await busyBot("Typed stop reply", "acpReply");
    const [first] = (await messages(bot.threadId)).filter((m) => m.role === "user");
    const reply = await send(bot, "stop", { replyToId: first.id });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(reply.body).toMatchObject({ queued: true });
    expect(await busy(bot.id)).toBe(true);
    await request("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  }, 60_000);

  it("T5: a 'stop' from an unproven device never stops the owner's turn", async () => {
    const bot = await busyBot("Typed stop unproven", "acpUnproven");
    const unproven = await send(bot, "stop", {}, false);
    expect(unproven.status, JSON.stringify(unproven.body)).toBe(202);
    expect(unproven.body.cancelled).toBeUndefined();
    await settle();
    expect(await busy(bot.id)).toBe(true);
    await request("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  }, 60_000);

  it("T8: with nothing running, 'stop' is an ordinary message and runs as a turn", async () => {
    const bot = await newBot("Typed stop idle", "fuigoIdle");
    const idle = await send(bot, "stop");
    expect(idle.status, JSON.stringify(idle.body)).toBe(202);
    expect(idle.body.cancelled).toBeUndefined();
    await expect.poll(() => count("fuigoIdle", "session/prompt"), { timeout: 30_000 }).toBe(1);
  }, 60_000);

  it("T9: a retried typed stop (same send id) gets the same answer and never runs", async () => {
    const bot = await busyBot("Typed stop retry", "acpRetry");
    const first = await send(bot, "stop", { sendId: "typed-stop-retry-1" });
    const again = await send(bot, "stop", { sendId: "typed-stop-retry-1" });
    expect([first.status, again.status]).toEqual([202, 202]);
    expect([first.body.stopped, again.body.stopped, first.body.cancelled, again.body.cancelled]).toEqual([true, true, undefined, undefined]);
    expect((await request("GET", `/api/sends/${bot.threadId}/typed-stop-retry-1`)).body).toEqual({ status: "stopped" });
    await expect.poll(() => busy(bot.id), { timeout: 15_000 }).toBe(false);
    await settle();
    expect((await userTexts(bot.threadId)).filter((text) => text === "stop")).toHaveLength(0);
    expect(count("acpRetry", "session/prompt")).toBe(1);
  }, 60_000);
});
