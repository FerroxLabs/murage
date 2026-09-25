// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Who may answer a card, over real HTTP with the fake ACP agent asking.
//
// A card is the owner's decision. The desktop app proves itself with its
// per-launch secret; the paired phone's companion proves itself with the
// launch credential the desktop (or `murage start`) gave both processes.
// Anything else on loopback (a script, or a bot's own shell under Full
// access) may say no to a card but never yes: not allow, not "Allow for this
// task", and not an answer to a question on the owner's behalf. Otherwise the
// stop line is a card the bot can click itself.
//
// HEADLESS ONLY: the data directory is a throwaway temp HOME and the port is
// probed from the fixture band, clear of the live app's 8799.
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
/** Outside its folder: the stop line holds under Full access. */
const DELETE_OUTSIDE = "rm -rf ~/Documents/old";
/** The launch credential shared by the harness and its companion. */
const COMPANION_TOKEN = "d".repeat(64);
const pairedPhone = { "x-murage-companion": "1", "x-murage-companion-token": COMPANION_TOKEN };

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
const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);
const threadMessages = async (threadId: string) => ((await desktopApi("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as any[];
const cardById = async (threadId: string, requestId: string) => (await threadMessages(threadId)).find((m) => m.card?.requestId === requestId)?.card;
const liveCard = async (threadId: string) =>
  (await threadMessages(threadId)).find((m) => m.card?.requestId && m.card?.answered === undefined && !m.card?.dismissed) ?? null;

async function poll<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function waitIdle(botId: string, threadId: string, ms = 20_000) {
  return poll(async () => {
    const bot = (await desktopApi("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId);
    const task = bot?.tasks?.find((t: any) => t.threadId === threadId);
    return task && !task.busy ? task : null;
  }, ms);
}

/** A Full access bot stopped at the stop line, waiting on its card. */
async function stoppedBot(name: string) {
  const created = await desktopApi("POST", "/api/bots", { name, modelSelection: { instanceId: "deleter", model: "fake-model" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  expect((await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { fullAccess: true, acknowledgeFullAccess: true })).status).toBe(200);
  expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "tidy my documents" })).status).toBe(202);
  const card = await poll(() => liveCard(bot.threadId), 20_000);
  expect(card, `the stop line raised no card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
  expect(card.card.taskAllowKey).toBeTruthy();
  return { bot, requestId: card.card.requestId as string };
}

/** Every way a caller can fail to prove it is the desktop or the paired phone. */
const unproven: Array<[string, () => Record<string, string>]> = [
  ["no headers at all", () => ({})],
  ["the companion marker alone", () => ({ "x-murage-companion": "1" })],
  ["a guessed companion credential", () => ({ "x-murage-companion": "1", "x-murage-companion-token": "e".repeat(64) })],
  ["the desktop marker without its secret", () => ({ "x-murage-surface": "desktop" })],
  ["the desktop secret behind the companion marker", () => ({ ...desktopHeaders, "x-murage-companion": "1" })],
];

describe.skipIf(process.platform === "win32")("answering a card needs the owner's surface", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 18_799, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-respond-authority-"));
    expect(home.startsWith(tmpdir())).toBe(true);
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(
      join(home, ".murage", "config.json"),
      JSON.stringify({
        instances: {
          deleter: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: DELETE_OUTSIDE },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          asker: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "elicitation-form" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
        MURAGE_COMPANION_TOKEN: COMPANION_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
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

  it(
    "a local caller with no desktop proof and no companion credential cannot approve a stop-line card, but may deny it",
    async () => {
      const { bot, requestId } = await stoppedBot("Stopped deleter");
      for (const [label, headers] of unproven) {
        for (const route of [`/api/threads/${bot.threadId}/respond`, `/api/bots/${bot.id}/respond`]) {
          for (const answer of [{ behavior: "allow" }, { behavior: "allow", allowForTask: true }, { behavior: "answer", message: "go ahead" }]) {
            const tried = await request("POST", route, { threadId: bot.threadId, requestId, ...answer }, headers());
            expect(tried.status, `${label} answered ${JSON.stringify(answer)} on ${route}: ${JSON.stringify(tried.body)}`).toBe(403);
          }
        }
      }
      expect((await cardById(bot.threadId, requestId))?.answered).toBeUndefined();
      // saying no is never a grant, so anyone may do it
      const denied = await request("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "deny" });
      expect(denied.body).toMatchObject({ ok: true, outcome: "rejected" });
      expect(await waitIdle(bot.id, bot.threadId)).not.toBeNull();
      expect((await cardById(bot.threadId, requestId))?.answered).toBe("deny");
    },
    90_000,
  );

  it(
    "the paired phone's companion, holding the launch credential, still approves",
    async () => {
      const { bot, requestId } = await stoppedBot("Phone approved deleter");
      const allowed = await request("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "allow", allowForTask: true }, pairedPhone);
      expect(allowed.body).toMatchObject({ ok: true, outcome: "allowed-once" });
      expect(await waitIdle(bot.id, bot.threadId)).not.toBeNull();
    },
    90_000,
  );

  it(
    "only the owner's surfaces answer a question; anyone may skip it",
    async () => {
      const created = await desktopApi("POST", "/api/bots", { name: "Asker", modelSelection: { instanceId: "asker", model: "fake-model" } });
      expect(created.status).toBe(201);
      const bot = created.body.bot as { id: string; threadId: string };
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
      const ask = async () => {
        expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "pick a branch" })).status).toBe(202);
        const card = await poll(() => liveCard(bot.threadId), 20_000);
        expect(card, `no question card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
        return card.card.requestId as string;
      };
      const answers = [{ id: "environment", selected: ["production"] }, { id: "features", selected: ["cache"] }, { id: "confirm", selected: ["No"] }];

      const first = await ask();
      for (const [label, headers] of unproven) {
        const tried = await request("POST", `/api/threads/${bot.threadId}/respond`, { requestId: first, behavior: "answer", answers }, headers());
        expect(tried.status, `${label} answered a question: ${JSON.stringify(tried.body)}`).toBe(403);
      }
      expect((await cardById(bot.threadId, first))?.answered).toBeUndefined();
      const skipped = await request("POST", `/api/threads/${bot.threadId}/respond`, { requestId: first, behavior: "skip" });
      expect(skipped.status, JSON.stringify(skipped.body)).toBe(200);
      expect(await waitIdle(bot.id, bot.threadId)).not.toBeNull();

      const second = await ask();
      const answered = await request("POST", `/api/threads/${bot.threadId}/respond`, { requestId: second, behavior: "answer", answers }, pairedPhone);
      expect(answered.body).toEqual({ ok: true, outcome: "answered" });
      expect(await waitIdle(bot.id, bot.threadId)).not.toBeNull();
    },
    90_000,
  );
});
