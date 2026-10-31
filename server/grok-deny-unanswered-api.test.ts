// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GROK-812MIN-STOPPED (10-29), end to end over real HTTP with the fake ACP CLI playing Grok Build: a chat card that
// went unanswered was denied by its deadline, grok ended the prompt, and the transcript blamed the owner twice
// ("Denied" on the card, "Stopped by you" under it). Now:
//   - a direct-chat card has no deadline (Sean 10-29): it waits for the owner, like a routine's;
//   - the owner's late Deny reaches grok with the follow-up note, so the turn carries on; no "Stopped by you";
//   - an engine that still ends the prompt after a deny gets a line saying why, never "Stopped by you";
//   - a card closed by anything but the owner (Stop here) reads "Not answered", never "Denied" (LONGWORK H2);
//   - the server log names who answered (approvals: resolved ... source=user).
//
// HEADLESS ONLY: a throwaway temp HOME and a probed port, clear of 8799.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
/** Longer than the old fixture deadline, which no longer exists. */
const WAIT_MS = 2_500;

let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let stderr = "";
let stdout = "";

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

async function makeBot(name: string, instanceId: string) {
  const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-model" } });
  expect(created.status).toBe(201);
  expect((await request("PATCH", `/api/bots/${created.body.bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return created.body.bot as { id: string; threadId: string; name: string };
}

let serverPort = 0;
async function startServer() {
  child = spawn(process.execPath, ["--import", pathToFileURL(join(home, "fake-engine-setup.mjs")).href, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: home,
      USERPROFILE: home,
      NODE_ENV: "test",
      MURAGE_PORT: String(serverPort),
      MURAGE_WEBHOOK_PORT: String(serverPort + 1),
      MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));
  child.stdout!.on("data", (c) => (stdout += c));
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

const STOPPED_BY_YOU = "Stopped by you";

/** A direct-chat card left alone: it is still open after the wait, then the caller answers it. */
async function waitingCard(name: string, instanceId: string) {
  const bot = await makeBot(name, instanceId);
  expect((await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "edit the picture" })).status).toBe(202);
  const card = await poll(() => cardFor(bot.threadId), 20_000);
  expect(card, `no card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
  await sleep(WAIT_MS);
  const still = await cardFor(bot.threadId);
  expect(still?.card?.answered, "the card closed without an answer").toBeUndefined();
  return { bot, card: still! };
}
const deny = async (threadId: string, requestId: string) =>
  expect((await request("POST", `/api/threads/${threadId}/respond`, { requestId, behavior: "deny" })).body).toMatchObject({ ok: true });

describe.skipIf(process.platform === "win32")("a Grok card nobody answered", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 18_959, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-grok-deny-api-"));
    expect(home.startsWith(tmpdir())).toBe(true);
    writeFileSync(join(home, "fake-engine-setup.mjs"), "globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;\n");
    mkdirSync(join(home, ".murage"), { recursive: true });
    const grok = (rule: string) => ({
      driver: "grokAgent",
      environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: "printf 'tick 13:25' >> notes/log.md", FAKE_ACP_BARE_REJECT_CANCELS: rule },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances: { "grok-follow": grok("1"), "grok-ignores": grok("always") } }));
    serverPort = port;
    await startServer();
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("waits for the owner, then a late Deny carries the turn on with grok's follow-up, never Stopped by you", async () => {
    const { bot, card } = await waitingCard("Sable", "grok-follow");
    await deny(bot.threadId, card.card.requestId);
    const reply = await poll(async () => (await threadMessages(bot.threadId)).find((m) => m.role === "bot" && m.kind === "text" && /FOLLOWUP: The user denied/.test(String(m.text))) ?? null, 20_000);
    expect(reply, `no follow-up reply. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    await sleep(500);
    const rows = await threadMessages(bot.threadId);
    expect(rows.find((m) => m.id === card.id)?.card?.answered).toBe("deny");
    expect(rows.filter((m) => m.tool?.name === STOPPED_BY_YOU)).toEqual([]);
    expect(rows.filter((m) => String(m.tool?.name ?? "").startsWith("error:"))).toEqual([]);
    expect(stdout).toMatch(new RegExp(`approvals: resolved bot=${bot.id.slice(0, 8)}\\S* request=${card.card.requestId} behavior=deny source=user`));
  }, 60_000);

  it("an engine that still ends the prompt after a deny leaves a line saying why, never Stopped by you", async () => {
    const { bot, card } = await waitingCard("Chip", "grok-ignores");
    await deny(bot.threadId, card.card.requestId);
    const line = await poll(async () => (await threadMessages(bot.threadId)).find((m) => m.kind === "activity" && /^stopped: the engine ended the turn after the request was declined\. Send a message to carry on\.$/.test(String(m.tool?.name))) ?? null, 20_000);
    expect(line, `no stop line. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    await sleep(500);
    const rows = await threadMessages(bot.threadId);
    expect(rows.filter((m) => m.tool?.name === STOPPED_BY_YOU)).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain("\u2014");
  }, 60_000);

  it("Stop with a card open: the card reads Not answered, never Denied", async () => {
    const { bot, card } = await waitingCard("Ember", "grok-follow");
    expect((await request("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBeLessThan(300);
    const closed = await poll(async () => {
      const row = (await threadMessages(bot.threadId)).find((m) => m.id === card.id);
      return row?.card?.answered !== undefined ? row : null;
    }, 20_000);
    expect(closed?.card).toMatchObject({ answered: "unavailable", dismissed: true });
  }, 60_000);
});
