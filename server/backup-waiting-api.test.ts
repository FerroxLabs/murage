// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A backup held up by a routine run waiting on the owner, over real HTTP
// with the fake ACP agent asking to run a command (0.1.60 Linux re-test 2,
// D6). A backup restart refused while the card waits names the bot; the
// Inbox says so beside the card for a scheduled backup; answering the card
// clears it and the backup restart is admitted.
//
// HEADLESS ONLY: a throwaway temp HOME and a probed port, clear of 8799.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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


describe.skipIf(process.platform === "win32")("a backup held up by a card waiting on the owner", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 18_999, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-backup-waiting-"));
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

  it("names the waiting bot, shows it in the Inbox for a daily backup, and admits the backup once the card is answered", async () => {
    const bot = await makeBot("Ember");
    const created = await request("POST", "/api/routines", {
      name: "Log tick", prompt: "Log the time", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, timeoutMinutes: 20, permissionMode: "ask",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const runId = (await request("POST", `/api/routines/${created.body.routine.id}/run`)).body.run.id as string;
    const threadId = await poll(async () => (await runState(runId))?.threadId ?? null, 20_000);
    const card = await poll(() => cardFor(threadId!), 20_000);
    expect(card, `no card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    await sleep(DENY_MS * 2);

    // Back up now: refused, naming who; nothing listed in the Inbox for it.
    const manual = await request("POST", "/api/backup-restart", { action: "prepare", token: randomUUID(), occasion: "manual" });
    expect(manual.status).toBe(409);
    expect(manual.body).toEqual({ error: "BACKUP_WORK_ACTIVE", waitingOnYou: [{ botId: bot.id, name: "Ember", threadId, messageId: card.id }] });
    expect((await request("GET", "/api/inbox?view=decisions")).body.backupWaiting).toBeUndefined();

    // A due daily backup: refused the same way, and the Inbox says why,
    // beside the card itself. The card is counted once, as before.
    const daily = await request("POST", "/api/backup-restart", { action: "prepare", token: randomUUID(), occasion: "daily" });
    expect(daily.status).toBe(409);
    const inbox = (await request("GET", "/api/inbox?view=decisions")).body;
    expect(inbox.backupWaiting).toMatchObject({ bots: [{ botId: bot.id, name: "Ember", threadId, messageId: card.id }] });
    expect(inbox.approvals).toBe(1);
    // A companion's Inbox never carries it.
    const plain = await fetch(`${base}/api/inbox?view=decisions`);
    expect(plain.status === 200 ? ((await plain.json()) as { backupWaiting?: unknown }).backupWaiting : undefined).toBeUndefined();

    // Answered: the Inbox line goes at once, and once the run has finished
    // the backup restart is admitted (then released again here).
    expect((await request("POST", `/api/threads/${threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" })).body).toMatchObject({ ok: true });
    expect((await request("GET", "/api/inbox?view=decisions")).body.backupWaiting).toBeUndefined();
    await poll(async () => {
      const run = await runState(runId);
      return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
    }, 20_000);
    const token = randomUUID();
    const admitted = await poll(async () => {
      const attempt = await request("POST", "/api/backup-restart", { action: "prepare", token, occasion: "daily" });
      return attempt.status === 200 ? attempt : null;
    }, 20_000);
    expect(admitted?.body).toEqual({ prepared: true, token });
    expect((await request("POST", "/api/backup-restart", { action: "cancel", token })).body).toEqual({ released: true });
  }, 90_000);
});
