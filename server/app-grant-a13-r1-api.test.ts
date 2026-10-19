// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AMEND-13 build review (Astra a13 r1), items 4 and 5 over real HTTP with the
// fake ACP agent asking to run a command, so every card here is one a live
// engine still holds:
//
//   - item 5 (Rule 81b): "Always allow" outside a routine saves AND answers
//     in one server call. A card settled first (another device said Deny)
//     saves nothing.
//   - item 4 (Rules 81a, 81b, 81d): a routine's remembered choice on a live
//     card passes the same fresh check on the phone, then saves and answers.
//
// HEADLESS ONLY: a throwaway temp HOME and a probed port, clear of 8799.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const LAUNCH_PROOF = randomBytes(32).toString("hex");

let base: string;
let desktopHeaders: Record<string, string> = {};
let child: ChildProcess;
let home: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = desktopHeaders): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
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
const threadMessages = async (threadId: string) => ((await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as any[];
const openCard = async (threadId: string) => (await threadMessages(threadId)).find((m) => m.kind === "options" && m.card?.requestId && !m.card.answered && !m.card.dismissed) ?? null;
const cardById = async (threadId: string, requestId: string) => (await threadMessages(threadId)).find((m) => m.card?.requestId === requestId) ?? null;
const storedBot = (id: string) => (JSON.parse(readFileSync(join(home, ".murage", "bots.json"), "utf8")) as Array<{ id: string; alwaysAllow?: string[] }>).find((bot) => bot.id === id)!;
const runState = async (id: string) => (await request("GET", "/api/routines")).body.runs.find((run: any) => run.id === id);
const routineState = async (id: string) => (await request("GET", "/api/routines")).body.routines.find((routine: any) => routine.id === id);

async function makeBot(name: string) {
  const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId: "asker", model: "fake-model" } });
  expect(created.status).toBe(201);
  expect((await request("PATCH", `/api/bots/${created.body.bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return created.body.bot as { id: string; threadId: string; name: string };
}

describe.skipIf(process.platform === "win32")("Astra a13 r1: grant decisions on live requests", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 19_299, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-a13-r1-"));
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
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_COMPANION_TOKEN: LAUNCH_PROOF,
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
    const proof = await request("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("item 5: Always allow saves and answers in one call, and a card settled first saves nothing", async () => {
    const bot = await makeBot("Ora");
    expect((await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "log the time" })).status).toBe(202);
    const card = await poll(() => openCard(bot.threadId), 20_000);
    expect(card, `no card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    const key = (card.card.exactAllowKey ?? card.card.allowKey) as string;
    expect(key).toBeTruthy();
    const granted = await request("POST", `/api/bots/${bot.id}/always-allow`, { allowKey: key, threadId: bot.threadId, requestId: card.card.requestId, answer: true });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(granted.body.outcome).toBeTruthy();
    expect(storedBot(bot.id).alwaysAllow).toContain(key);
    // the same call answered the card: no second request was needed
    const answered = await poll(async () => {
      const current = await cardById(bot.threadId, card.card.requestId);
      return current?.card?.answered ? current : null;
    }, 10_000);
    expect(answered?.card?.answered).toBe("allow");
    // a retry is refused and changes nothing
    expect((await request("POST", `/api/bots/${bot.id}/always-allow`, { allowKey: key, threadId: bot.threadId, requestId: card.card.requestId, answer: true })).status).toBe(409);

    const other = await makeBot("Pim");
    expect((await request("POST", `/api/bots/${other.id}/messages`, { threadId: other.threadId, text: "log the time" })).status).toBe(202);
    const denied = await poll(() => openCard(other.threadId), 20_000);
    expect(denied).not.toBeNull();
    // another device says Deny first
    expect((await request("POST", `/api/threads/${other.threadId}/respond`, { requestId: denied.card.requestId, behavior: "deny" })).body).toMatchObject({ ok: true });
    const late = await request("POST", `/api/bots/${other.id}/always-allow`, { allowKey: denied.card.exactAllowKey ?? denied.card.allowKey, threadId: other.threadId, requestId: denied.card.requestId, answer: true });
    expect(late.status).toBe(409);
    expect(storedBot(other.id).alwaysAllow ?? []).toEqual([]);
  }, 90_000);

  it("item 4: a routine's remembered choice on a live card takes the phone's fresh check, then saves and answers", async () => {
    const bot = await makeBot("Rue");
    const created = await request("POST", "/api/routines", {
      name: "Log tick", prompt: "Log the time", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, timeoutMinutes: 20, permissionMode: "ask",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const routineId = created.body.routine.id as string;
    const runId = (await request("POST", `/api/routines/${routineId}/run`)).body.run.id as string;
    const threadId = await poll(async () => (await runState(runId))?.threadId ?? null, 20_000);
    const card = await poll(() => openCard(threadId!), 20_000);
    expect(card, `no card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    expect(card.card.routineId).toBe(routineId);
    const route = `/api/routines/${routineId}/always-allow`;
    // the paired phone without its fresh check saves nothing
    const phone = await request("POST", route, { threadId, requestId: card.card.requestId, answer: true }, { "x-murage-companion-token": LAUNCH_PROOF });
    expect(phone.status, JSON.stringify(phone.body)).toBe(403);
    expect((await routineState(routineId)).alwaysAllow ?? []).toEqual([]);
    const saved = await request("POST", route, { threadId, requestId: card.card.requestId, answer: true });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.outcome).toBeTruthy();
    expect((await routineState(routineId)).alwaysAllow).toEqual(saved.body.saved);
    const done = await poll(async () => {
      const run = await runState(runId);
      return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
    }, 20_000);
    expect(done).toMatchObject({ status: "completed" });
  }, 90_000);
});
