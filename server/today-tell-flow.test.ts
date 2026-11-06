// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today's Tell box, end to end through the real server (Today slice 1.0.18, designs/TODAY-SLICE-1104.md section 6,
// test 6). The box is the Chief's own Composer, so a send from it is the composer's one send: POST
// /api/bots/:id/messages with the Chief's CURRENT conversation (`bot.threadId`) and a send id. This proves that
// request lands in the Chief's current chat as an owner message (after the Chief switched to a new task, not the
// old one), that the answer is the acknowledgement "Sent to {chief}." waits for, that a repeat of the same send id
// is not a second message, and that the Chief's turn then runs and finishes. Fuigo first (Flux Router is the
// default), then Claude and Codex.
//
// HEADLESS ONLY: a throwaway temp HOME and a probed port, clear of 8799.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tellChief, todayChiefId } from "../src/lib/today-tell.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");

let base: string;
let desktopHeaders: Record<string, string> = {};
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

const threadMessages = async (threadId: string) => ((await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body?.messages ?? []) as any[];
const liveBot = async (id: string) => ((await request("GET", "/api/bots")).body.bots as any[]).find((bot) => bot.id === id);

/** A bot on `instanceId`, made the workspace Chief, then moved to a fresh task the way the app switches one. */
async function makeChief(name: string, instanceId: string): Promise<{ id: string; name: string; threadId: string; oldThreadId: string }> {
  const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-model" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await request("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const promoted = await request("PATCH", `/api/bots/${bot.id}`, { chiefOfStaff: true, chiefScope: "workspace" });
  expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
  const chief = await liveBot(bot.id);
  expect(chief.chiefOfStaff).toBe(true);
  expect(chief.chiefScope).toBe("workspace");
  // The Chief's task is switched: the Tell box must follow to the new conversation.
  const task = await request("POST", `/api/bots/${bot.id}/tasks`, { title: "Later" });
  expect(task.status, JSON.stringify(task.body)).toBe(201);
  const threadId = task.body.task.threadId as string;
  expect((await request("POST", `/api/bots/${bot.id}/tasks/${threadId}?messages=50`)).status).toBe(200);
  expect((await liveBot(bot.id)).threadId).toBe(threadId);
  expect(threadId).not.toBe(bot.threadId);
  return { id: bot.id, name, threadId, oldThreadId: bot.threadId };
}

/** The composer's one send from the Tell box, then the owner message in the Chief's current chat and a finished turn.
 *  The box's bot is Today's own pick (todayChiefId + tellChief) from the live bot list, as the app holds it. */
async function tell(chief: { id: string; threadId: string; oldThreadId: string }, text: string) {
  const bots = (await request("GET", "/api/bots")).body.bots as any[];
  const box = tellChief(bots, todayChiefId(bots, null), false);
  expect(box?.id).toBe(chief.id);
  expect(box.threadId).toBe(chief.threadId);
  const sendId = randomUUID();
  const sent = await request("POST", `/api/bots/${chief.id}/messages`, { text, threadId: box.threadId, sendId });
  // the acknowledgement "Sent to {chief}." waits for
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  const owner = async () => (await threadMessages(chief.threadId)).filter((message) => message.role === "user" && message.text === text);
  await expect.poll(async () => (await owner()).length, { timeout: 20_000 }).toBe(1).catch((error) => { throw new Error(`${error}\nstderr: ${stderr.slice(-1500)}`); });
  const [message] = await owner();
  expect(message.actorKind ?? "owner").toBe("owner");
  // not in the conversation the Chief left
  expect((await threadMessages(chief.oldThreadId)).some((row) => row.role === "user" && row.text === text)).toBe(false);
  // the same send id again (a retry after a dropped answer) is not a second message
  const again = await request("POST", `/api/bots/${chief.id}/messages`, { text, threadId: chief.threadId, sendId });
  expect(again.status).toBeLessThan(500);
  await expect.poll(async () => (await liveBot(chief.id))?.busy, { timeout: 25_000 }).toBe(false);
  expect((await owner()).length).toBe(1);
  // the Chief answered in the same conversation
  expect((await threadMessages(chief.threadId)).some((row) => row.role === "bot")).toBe(true);
}

describe.skipIf(process.platform === "win32")("the Today Tell box reaches the Chief's current chat", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    for (const cli of [FAKE_ACP, FAKE_CLAUDE, FAKE_CODEX]) chmodSync(cli, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-today-tell-"));
    expect(home.startsWith(tmpdir())).toBe(true);
    mkdirSync(join(home, ".murage"), { recursive: true });
    // a `fuigo login` install: Fuigo's sign-in marker
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      engineDiscovery: "explicit",
      instances: {
        fuigo: { driver: "fuigoAgent", environment: { FAKE_ACP_MODE: "happy", FAKE_ACP_MCP_READY: "1" }, config: { cli: FAKE_ACP } },
        claude: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "happy" }, config: { cli: FAKE_CLAUDE } },
        codex: { driver: "codex", environment: { FAKE_CODEX_MODE: "happy" }, config: { cli: FAKE_CODEX } },
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
    const proof = await request("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("Fuigo: a Tell box send is an owner message in the Chief's current chat", async () => {
    await tell(await makeChief("Fuigo Chief", "fuigo"), "Book the venue for Friday");
  }, 120_000);

  it("Claude: a Tell box send is an owner message in the Chief's current chat", async () => {
    await tell(await makeChief("Claude Chief", "claude"), "Draft the weekly update");
  }, 120_000);

  it("Codex: a Tell box send is an owner message in the Chief's current chat", async () => {
    await tell(await makeChief("Codex Chief", "codex"), "Check the invoices");
  }, 120_000);
});
