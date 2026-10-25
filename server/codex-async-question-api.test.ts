// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// QW Q3 (173), end to end through the real server: Codex's request_user_input_async posts its questions on an agent
// message (`delivery: "async"`) and keeps working. Before 1.0.4 the questions were only text; now they open the one
// tap-to-answer card (answerAsSend, the asking turn's id) with no adapter ask, and the answer is the owner's next
// message: queued while Codex works (it cannot be steered) and run once when it settles. Stop expires the card; its
// late answer becomes a message. A turn the owner is not attending gets no card.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let output = "";

const request = async (method: string, path: string, body?: unknown, proven = true): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(proven ? desktopHeaders : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const messages = async (threadId: string) => (await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const questionCards = async (threadId: string) => (await messages(threadId)).filter((m) => m.card?.questions?.length);
const userLines = async (threadId: string, words: string) => (await messages(threadId)).filter((m) => m.role === "user" && String(m.text ?? "").includes(words));
const replies = async (threadId: string) => (await messages(threadId)).filter((m) => m.role === "bot" && m.text === "done from fake codex");
const busy = async (botId: string) => (await request("GET", "/api/bots")).body.bots.find((b: any) => b.id === botId)?.busy;

async function makeBot(name: string, instanceId: string) {
  const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId, model: "gpt-fake-default" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await request("PATCH", `/api/bots/${bot.id}`, { computer: "off" })).status).toBe(200);
  return bot;
}
async function openCard(bot: { id: string; threadId: string }, text: string) {
  expect((await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text })).status).toBe(202);
  await expect.poll(async () => (await questionCards(bot.threadId)).length, { timeout: 20000 }).toBe(1);
  return (await questionCards(bot.threadId))[0]!;
}

posixOnly("Codex asks while it keeps working (QW Q3, 173)", () => {
  let gates: string;
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CODEX, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-codex-async-q-"));
    gates = join(home, "gates");
    mkdirSync(join(home, ".murage"), { recursive: true });
    mkdirSync(gates, { recursive: true });
    const codex = (name: string, extra: Record<string, string> = {}) => ({
      driver: "codex",
      environment: { FAKE_CODEX_MODE: "async-question", FAKE_CODEX_ASYNC_QUESTION_ONCE: join(gates, `${name}.asked`), ...extra },
      config: { cli: FAKE_CODEX, fullAuto: true },
    });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      engineDiscovery: "explicit",
      instances: {
        working: codex("working", { FAKE_CODEX_ASYNC_QUESTION_GATE: join(gates, "working.go") }),
        stopped: codex("stopped", { FAKE_CODEX_ASYNC_QUESTION_GATE: join(gates, "stopped.never") }),
        unattended: codex("unattended"),
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
    child.stdout!.on("data", (c) => (output += c));
    child.stderr!.on("data", (c) => (output += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up:\n${output}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const proof = (await fetch(`${base}/api/desktop-secret`).then((r) => r.json())) as { secret: string };
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("opens one card, queues the answer while Codex works, and runs it once when Codex settles", async () => {
    const bot = await makeBot("Codex worker", "working");
    const card = await openCard(bot, "find the right source");
    expect(card.card).toMatchObject({
      title: "Your bot has a question",
      answerAsSend: true,
      questions: [{ id: "q1", question: "Which source should I use?", options: [{ label: "The docs" }, { label: "The code" }] }],
    });
    expect(typeof card.card.turnId).toBe("string");
    expect(await busy(bot.id)).toBe(true);

    const answered = await request("POST", `/api/threads/${bot.threadId}/respond`, {
      requestId: card.card.requestId, behavior: "answer", answers: [{ id: "q1", selected: ["The docs"] }],
    });
    expect(answered.status).toBe(200);
    expect(answered.body.outcome).toBe("answered");
    // Codex cannot be steered: the answer waits as the owner's queued send while the turn runs on
    const pending = (await request("GET", "/api/bots")).body.pendingSends?.[bot.threadId] ?? [];
    expect(pending.map((item: any) => item.sendId)).toContain(`ask-${card.id}`);
    expect(await userLines(bot.threadId, "The docs")).toHaveLength(0);
    expect(await busy(bot.id)).toBe(true);

    writeFileSync(join(gates, "working.go"), "");
    await expect.poll(async () => (await replies(bot.threadId)).length, { timeout: 20000 }).toBe(2);
    await expect.poll(() => busy(bot.id), { timeout: 20000 }).toBe(false);
    await new Promise((r) => setTimeout(r, 1000));
    expect(await userLines(bot.threadId, "The docs")).toHaveLength(1);
    expect(await replies(bot.threadId)).toHaveLength(2);
    expect(await questionCards(bot.threadId)).toHaveLength(1);
    // a second press meets the claimed card
    const again = await request("POST", `/api/threads/${bot.threadId}/respond`, {
      requestId: card.card.requestId, behavior: "answer", answers: [{ id: "q1", selected: ["The code"] }],
    });
    expect(again.status).toBe(409);
  });

  it("Stop expires the card; the late answer becomes the owner's message and runs", async () => {
    const bot = await makeBot("Codex stopped", "stopped");
    const card = await openCard(bot, "find the right source");
    expect((await request("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBeLessThan(300);
    await expect.poll(async () => (await questionCards(bot.threadId))[0]?.card.expired, { timeout: 20000 }).toBe(true);
    await expect.poll(() => busy(bot.id), { timeout: 20000 }).toBe(false);

    const late = await request("POST", `/api/threads/${bot.threadId}/respond`, {
      requestId: card.card.requestId, behavior: "answer", sentAsMessage: true, answers: [{ id: "q1", selected: ["The code"] }],
    });
    expect(late.status).toBe(200);
    expect(late.body.outcome).toBe("sent-as-message");
    await expect.poll(async () => (await userLines(bot.threadId, "The code")).length, { timeout: 20000 }).toBe(1);
    await expect.poll(async () => (await replies(bot.threadId)).length, { timeout: 20000 }).toBe(1);
  });

  it("a turn the owner is not attending gets no card", async () => {
    const bot = await makeBot("Codex unattended", "unattended");
    // no surface proof: an unproven caller's words run unattended and are not the owner's audience
    expect((await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "find the right source" }, false)).status).toBe(202);
    await expect.poll(() => output.includes(`question.async refused thread=${bot.threadId}`), { timeout: 20000 }).toBe(true);
    await expect.poll(() => busy(bot.id), { timeout: 20000 }).toBe(false);
    expect(await questionCards(bot.threadId)).toHaveLength(0);
  });
});
