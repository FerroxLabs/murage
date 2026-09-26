// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An unanswered approval in a routine run, end to end over real HTTP with the
// fake ACP agent asking to run a command (0.1.60 Mac pass, defect 1):
//
//   - a routine run's card is never auto-denied by the engine's deny deadline
//     (shrunk here with MURAGE_PERMISSION_DENY_MS): the run stays waiting on
//     the owner and answering the card later carries the same run on;
//   - an ordinary chat card that does time out is not reported as an engine
//     failure: no error row, so no "choose another configured model in
//     Provider settings" card.
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
const DENY_MS = 1_500;

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
  return { status: res.status, body: await res.json().catch(() => null) };
};
const threadMessages = async (threadId: string) => ((await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as any[];
const cardFor = async (threadId: string) =>
  (await threadMessages(threadId)).find((m) => m.kind === "options" && m.card?.requestId) ?? null;
const runState = async (id: string) => (await request("GET", "/api/routines")).body.runs.find((run: any) => run.id === id);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}

async function makeBot(name: string) {
  const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId: "asker", model: "fake-model" } });
  expect(created.status).toBe(201);
  expect((await request("PATCH", `/api/bots/${created.body.bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return created.body.bot as { id: string; threadId: string; name: string };
}

let serverPort = 0;
async function startServer() {
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: home,
      USERPROFILE: home,
      MURAGE_PORT: String(serverPort),
      MURAGE_WEBHOOK_PORT: String(serverPort + 1),
      MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
      MURAGE_PERMISSION_DENY_MS: String(DENY_MS),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    await sleep(150);
  }
  desktopHeaders = {};
  const proof = await request("GET", "/api/desktop-secret");
  expect(proof.status).toBe(200);
  desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
}

const errorRows = (messages: any[]) => messages.filter((m) => m.kind === "activity" && String(m.tool?.name ?? "").startsWith("error:"));

describe.skipIf(process.platform === "win32")("an unanswered approval in a routine run", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 18_899, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-routine-hold-"));
    expect(home.startsWith(tmpdir())).toBe(true);
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      instances: {
        asker: {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: "printf 'tick 13:25' >> notes/log.md" },
          config: { cli: FAKE_CLI, fullAuto: false },
        },
      },
    }));
    serverPort = port;
    await startServer();
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("keeps a routine run's card open past the deny deadline, and answering it finishes the run", async () => {
    const bot = await makeBot("Ember");
    const created = await request("POST", "/api/routines", {
      name: "Log tick", prompt: "Log the time", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, timeoutMinutes: 20, permissionMode: "ask",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const started = await request("POST", `/api/routines/${created.body.routine.id}/run`);
    expect(started.status).toBe(201);
    const runId = started.body.run.id as string;
    const threadId = await poll(async () => (await runState(runId))?.threadId ?? null, 20_000);
    const card = await poll(() => cardFor(threadId!), 20_000);
    expect(card, `no card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    await sleep(DENY_MS * 3);
    const still = await cardFor(threadId!);
    expect(still.card.answered).toBeUndefined();
    expect(await runState(runId)).toMatchObject({ status: "waiting" });
    expect(errorRows(await threadMessages(threadId!))).toEqual([]);
    expect((await request("POST", `/api/threads/${threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" })).body).toMatchObject({ ok: true });
    const done = await poll(async () => {
      const run = await runState(runId);
      return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
    }, 20_000);
    expect(done).toMatchObject({ status: "completed" });
  }, 90_000);

  it("an ordinary card that times out is not shown as an engine failure", async () => {
    const bot = await makeBot("Rae");
    expect((await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "log the time" })).status).toBe(202);
    const card = await poll(() => cardFor(bot.threadId), 20_000);
    expect(card, `no card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    const resolved = await poll(async () => {
      const current = await cardFor(bot.threadId);
      return current?.card?.answered !== undefined ? current : null;
    }, 20_000);
    expect(resolved, "the card never timed out").not.toBeNull();
    await sleep(1_000);
    const errors = errorRows(await threadMessages(bot.threadId));
    expect(errors.filter((m) => /answered|permission request/i.test(String(m.tool?.name)))).toEqual([]);
  }, 60_000);

  // Answering after the run ended (here: Murage restarted under it) used to
  // hit "Couldn't deliver that answer — the request is no longer open", a
  // dead end with an em dash. A routine's card now says the run ended and
  // offers Run again, and an "Always allow for this routine" answer is kept.
  it("a card answered after its run ended says so and offers Run again", async () => {
    const bot = await makeBot("Late");
    const created = await request("POST", "/api/routines", {
      name: "Late tick", prompt: "Log the time", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, timeoutMinutes: 20, permissionMode: "ask",
    });
    const routineId = created.body.routine.id as string;
    const runId = (await request("POST", `/api/routines/${routineId}/run`)).body.run.id as string;
    const threadId = await poll(async () => (await runState(runId))?.threadId ?? null, 20_000);
    const card = await poll(() => cardFor(threadId!), 20_000);
    expect(card?.card?.routineAllowKey).toBeTruthy();
    // a crash, not a clean stop: a clean stop closes its open cards itself
    await waitForExit(child, { signal: "SIGKILL" });
    await startServer();
    expect(await runState(runId)).toMatchObject({ status: "failed" });
    // the owner picks "Always allow for this routine" on the old card
    expect((await request("POST", `/api/routines/${routineId}/always-allow`, { allowKey: card.card.routineAllowKey, threadId })).status).toBe(200);
    await request("POST", `/api/threads/${threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" });
    const note = await poll(async () => (await threadMessages(threadId!)).find((m) => m.routineRunAgain) ?? null, 10_000);
    expect(note).toMatchObject({
      kind: "activity",
      routineRunAgain: { routineId },
      tool: { name: "This run of Late tick ended before you answered, so nothing was run. Always allow for this routine is saved, so the next run will not ask about it." },
    });
    expect(JSON.stringify(await threadMessages(threadId!))).not.toContain("\u2014");
    // Run again starts the routine now, and the saved answer covers it
    const again = await request("POST", `/api/routines/${routineId}/run`);
    expect(again.status).toBe(201);
    const done = await poll(async () => {
      const run = await runState(again.body.run.id);
      return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
    }, 20_000);
    expect(done).toMatchObject({ status: "completed" });
  }, 120_000);

  it("an ordinary late answer says so without an em dash", async () => {
    const bot = await makeBot("Plain");
    expect((await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "log the time" })).status).toBe(202);
    const card = await poll(() => cardFor(bot.threadId), 20_000);
    // a crash, not a clean stop: a clean stop closes its open cards itself
    await waitForExit(child, { signal: "SIGKILL" });
    await startServer();
    await request("POST", `/api/threads/${bot.threadId}/respond`, { requestId: card!.card.requestId, behavior: "allow" });
    const note = await poll(async () => (await threadMessages(bot.threadId)).find((m) => /no longer open/.test(String(m.tool?.name))) ?? null, 10_000);
    expect(note?.tool?.name).toBe("Couldn't deliver that answer. The request is no longer open, so the action was not run.");
    expect(note?.routineRunAgain).toBeUndefined();
  }, 90_000);
});
