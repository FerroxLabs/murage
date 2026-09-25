// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Routine approval levels, end to end over real HTTP with the fake ACP agent
// asking to delete outside its folder mid-turn (the stop line):
//
//   - a routine on a No limits bot inherits No limits: its run raises no card
//     (it used to be judged as Auto and wait for nobody);
//   - every run works in the routine's one conversation, with a run marker;
//   - a routine set to Auto stops at the stop line, and its card offers
//     "Always allow for this routine", which covers the next run;
//   - the owner's own message in the routine's conversation is judged at the
//     routine's level, the level the composer shows there;
//   - Full access or No limits for a routine needs the bot's one-time warning.
//
// HEADLESS ONLY: a throwaway temp HOME and a probed port, clear of 8799.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const DELETE_OUTSIDE = "rm -rf ~/Documents/old";

let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const api = (method: string, path: string, body?: unknown) => request(method, path, body);
const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);
const botState = async (botId: string) => (await desktopApi("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId);
const taskState = async (botId: string, threadId: string) => (await botState(botId)).tasks.find((task: any) => task.threadId === threadId);
const threadMessages = async (threadId: string) => ((await desktopApi("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as any[];
const liveCard = async (threadId: string) =>
  (await threadMessages(threadId)).find((m) => m.kind === "options" && m.card?.requestId && m.card?.answered === undefined) ?? null;
const routineState = async (id: string) => (await api("GET", "/api/routines")).body.routines.find((routine: any) => routine.id === id);
const runState = async (id: string) => (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === id);

async function poll<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function makeBot(name: string) {
  const created = await desktopApi("POST", "/api/bots", { name, modelSelection: { instanceId: "deleter", model: "fake-model" } });
  expect(created.status).toBe(201);
  expect((await desktopApi("PATCH", `/api/bots/${created.body.bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return created.body.bot as { id: string; threadId: string; name: string };
}

async function makeRoutine(botId: string, extra: Record<string, unknown> = {}) {
  const created = await desktopApi("POST", "/api/routines", {
    name: "RWA watch", prompt: "Sweep", botId, enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, timeoutMinutes: 20, ...extra,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.routine as { id: string };
}

async function runOnce(routineId: string) {
  const started = await desktopApi("POST", `/api/routines/${routineId}/run`);
  expect(started.status).toBe(201);
  return started.body.run.id as string;
}

const settled = (runId: string) => poll(async () => {
  const run = await runState(runId);
  return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
}, 25_000);

describe.skipIf(process.platform === "win32")("routine approval levels", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 18_799, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-routine-levels-"));
    expect(home.startsWith(tmpdir())).toBe(true);
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      instances: {
        deleter: {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: DELETE_OUTSIDE },
          config: { cli: FAKE_CLI, fullAuto: false },
        },
      },
    }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const proof = await api("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("a routine inherits its bot's No limits, and every run works in one conversation", async () => {
    const bot = await makeBot("Dax");
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
    const routine = await makeRoutine(bot.id);
    const first = await settled(await runOnce(routine.id));
    expect(first, `run never settled. stderr: ${stderr.slice(-1500)}`).toMatchObject({ status: "completed" });
    const second = await settled(await runOnce(routine.id));
    expect(second).toMatchObject({ status: "completed" });
    // one conversation, remembered on the routine, with both runs in it
    expect(second!.threadId).toBe(first!.threadId);
    expect((await routineState(routine.id)).threadId).toBe(first!.threadId);
    const messages = await threadMessages(first!.threadId);
    expect(messages.filter((m) => m.kind === "options" && m.card?.requestId)).toHaveLength(0);
    expect(messages.filter((m) => m.kind === "activity" && m.tool?.name === "Run now: RWA watch")).toHaveLength(2);
    expect(messages.some((m) => m.kind === "activity" && Array.isArray(m.tool?.steps))).toBe(true);
  }, 90_000);

  it("a routine on Auto stops at the stop line, and Always allow for this routine covers its next run", async () => {
    const bot = await makeBot("Rae");
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
    const routine = await makeRoutine(bot.id, { permissionMode: "auto" });
    const runId = await runOnce(routine.id);
    const threadId = await poll(async () => (await runState(runId))?.threadId ?? null, 20_000);
    const card = await poll(() => liveCard(threadId!), 20_000);
    expect(card, `no card on Auto. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    expect(card.card).toMatchObject({ routineId: routine.id });
    expect(card.card.routineAllowKey).toMatch(/^stop:delete:\/.*\/Documents\/old$/);
    // a forged key is refused; the card's own is kept on the routine
    expect((await desktopApi("POST", `/api/routines/${routine.id}/always-allow`, { allowKey: "stop:delete:/", threadId })).status).toBe(409);
    expect((await api("POST", `/api/routines/${routine.id}/always-allow`, { allowKey: card.card.routineAllowKey, threadId })).status).toBe(404);
    expect((await desktopApi("POST", `/api/routines/${routine.id}/always-allow`, { allowKey: card.card.routineAllowKey, threadId })).status).toBe(200);
    expect((await desktopApi("POST", `/api/threads/${threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" })).body).toMatchObject({ ok: true });
    expect(await settled(runId)).toMatchObject({ status: "completed" });
    expect((await routineState(routine.id)).alwaysAllow).toEqual([card.card.routineAllowKey]);

    const next = await settled(await runOnce(routine.id));
    expect(next).toMatchObject({ status: "completed", threadId });
    expect((await threadMessages(threadId!)).some((m) => String(m.tool?.name ?? "").includes("(always allowed for this routine)"))).toBe(true);

    // removed in the editor: the next run asks again
    expect((await desktopApi("POST", `/api/routines/${routine.id}/always-allow/remove`, { key: card.card.routineAllowKey })).status).toBe(200);
    expect((await routineState(routine.id)).alwaysAllow).toBeUndefined();
  }, 120_000);

  it("the owner's message in a routine's conversation runs at the routine's level", async () => {
    const bot = await makeBot("Kit");
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
    const routine = await makeRoutine(bot.id);
    const run = await settled(await runOnce(routine.id));
    const threadId = run!.threadId as string;
    // the conversation's own task copied No limits when it was made
    expect((await taskState(bot.id, threadId)).noLimits).toBe(true);
    expect((await desktopApi("PATCH", `/api/routines/${routine.id}`, { permissionMode: "auto" })).status).toBe(200);
    expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "tidy my documents" })).status).toBe(202);
    const card = await poll(() => liveCard(threadId), 20_000);
    expect(card, "the owner's turn ran at the conversation's copied level, not the routine's").not.toBeNull();
    expect(card.card.held).toContain("outside its folder");
    await desktopApi("POST", `/api/threads/${threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
  }, 90_000);

  it("Full access or No limits for a routine needs the bot's one-time warning", async () => {
    const bot = await makeBot("Unwarned");
    const refused = await desktopApi("POST", "/api/routines", { name: "Bold", prompt: "p", botId: bot.id, enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, permissionMode: "unlimited" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Turn on No limits for Unwarned");
    const routine = await makeRoutine(bot.id);
    expect((await desktopApi("PATCH", `/api/routines/${routine.id}`, { permissionMode: "full" })).status).toBe(409);
    expect((await desktopApi("PATCH", `/api/routines/${routine.id}`, { permissionMode: "auto" })).status).toBe(200);
    // and a routine's level is the desktop app's decision alone
    expect((await api("PATCH", `/api/routines/${routine.id}`, { permissionMode: "ask" })).status).toBe(404);
  }, 30_000);
});
