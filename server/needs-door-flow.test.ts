// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Needs you door, end to end through the real server (UX L2B): an
// approval and a question raised by a bot on Fuigo (ACP), Claude and Codex
// each become one owed row in the Needs you list; opening the row reads the
// live card the way the door does (one message around the row's link); the
// answer goes back through the same POST /api/threads/:id/respond the open
// row's card uses; the row then leaves the owed list and the turn carries on.
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

type Bot = { id: string; threadId: string };
const owedRows = async (threadId: string): Promise<any[]> =>
  ((await request("GET", "/api/inbox?view=decisions")).body.items as any[]).filter(
    (item) => item.kind === "request" && item.status === "pending" && item.link?.threadId === threadId,
  );

async function makeBot(name: string, instanceId: string) {
  const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-model" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as Bot;
  expect((await request("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
}

/** Send, wait for the one owed row, open it the way the door does, answer it from the card, and see it leave. */
async function answerFromDoor(bot: Bot, text: string, answer: (card: any) => Record<string, unknown>) {
  expect((await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text })).status).toBe(202);
  await expect.poll(async () => (await owedRows(bot.threadId)).length, { timeout: 25_000 }).toBe(1).catch((error) => { throw new Error(`${error}\nstderr: ${stderr.slice(-1500)}`); });
  const [row] = await owedRows(bot.threadId);
  // The door's read of an opened row: the one message the row links to.
  const around = await request("GET", `/api/threads/${row.link.threadId}/messages?around=${row.link.messageId}&limit=1`);
  const card = (around.body.messages as any[]).find((message) => message.id === row.link.messageId)?.card;
  expect(card?.requestId, JSON.stringify(around.body)).toBeTruthy();
  // The open row's card answers through the thread's respond route.
  const answered = await request("POST", `/api/threads/${row.link.threadId}/respond`, { requestId: card.requestId, ...answer(card) });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  expect(answered.body.ok).toBe(true);
  await expect.poll(async () => (await owedRows(bot.threadId)).length, { timeout: 15_000 }).toBe(0);
  await expect.poll(async () => (await request("GET", "/api/bots")).body.bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 25_000 }).toBe(false);
  return card;
}

const allow = () => ({ behavior: "allow" });
/** Pick the first offered option for every question, or type an answer where none is offered. */
const firstOption = (card: any) => ({
  behavior: "answer",
  answers: (card.questions as any[]).map((question) => {
    const option = question.options?.[0];
    const label = typeof option === "string" ? option : option?.label;
    return label ? { id: question.id, selected: [label] } : { id: question.id, selected: [], other: "Yes" };
  }),
});

describe.skipIf(process.platform === "win32")("the Needs you door answers from an opened row", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    for (const cli of [FAKE_ACP, FAKE_CLAUDE, FAKE_CODEX]) chmodSync(cli, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-needs-door-"));
    expect(home.startsWith(tmpdir())).toBe(true);
    mkdirSync(join(home, ".murage"), { recursive: true });
    // a `fuigo login` install: Fuigo's sign-in marker
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      engineDiscovery: "explicit",
      instances: {
        fuigoApprove: { driver: "fuigoAgent", environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_MCP_READY: "1", FAKE_ACP_PERMISSION_COMMAND: "printf 'door' >> notes/log.md" }, config: { cli: FAKE_ACP, fullAuto: false } },
        fuigoAsk: { driver: "fuigoAgent", environment: { FAKE_ACP_MODE: "fuigo-question", FAKE_ACP_MCP_READY: "1" }, config: { cli: FAKE_ACP, fullAuto: false } },
        claude: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_PERM_INPUT: JSON.stringify({ command: "touch ./needs-door-fixture" }) }, config: { cli: FAKE_CLAUDE } },
        codexApprove: { driver: "codex", environment: { FAKE_CODEX_MODE: "approval" }, config: { cli: FAKE_CODEX, fullAuto: false } },
        codexAsk: { driver: "codex", environment: { FAKE_CODEX_MODE: "user-input" }, config: { cli: FAKE_CODEX, fullAuto: true } },
      },
    }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      windowsHide: true,
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

  it("Fuigo: an approval and a question, each answered from its opened row", async () => {
    const approval = await answerFromDoor(await makeBot("Fuigo approver", "fuigoApprove"), "go", allow);
    expect(approval.questions?.length ?? 0).toBe(0);
    const question = await answerFromDoor(await makeBot("Fuigo asker", "fuigoAsk"), "go", firstOption);
    expect(question.questions.length).toBeGreaterThan(0);
  }, 120_000);

  it("Claude: an approval and a question, each answered from its opened row", async () => {
    const approval = await answerFromDoor(await makeBot("Claude approver", "claude"), "__fixture_permission_tool__", allow);
    expect(approval.questions?.length ?? 0).toBe(0);
    const question = await answerFromDoor(await makeBot("Claude asker", "claude"), "__fixture_ask_user_question__", firstOption);
    expect(question.questions.length).toBeGreaterThan(0);
  }, 120_000);

  it("Codex: an approval and a question, each answered from its opened row", async () => {
    const approval = await answerFromDoor(await makeBot("Codex approver", "codexApprove"), "go", allow);
    expect(approval.questions?.length ?? 0).toBe(0);
    const question = await answerFromDoor(await makeBot("Codex asker", "codexAsk"), "go", firstOption);
    expect(question.questions.length).toBeGreaterThan(0);
  }, 120_000);
});
