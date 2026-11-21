// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1021 Retry, live witness of the handler's own owner gate (MAIN ruling option B). On a shipped desktop home the route
// policy already refuses every non-owner caller before the retry handler (retry-delivery is desktop class), so the handler's
// mayApprove gate is a second layer no live caller reaches. This server child loads
// testing/retry-route-conversation-preload.mjs, which reclassifies that one route to "conversation" in the child only: the
// browser door (x-murage-door-token, the companion's forward proof, which claims no owner authority) then passes the route
// layer and the handler's gate is the only thing between it and a re-send.
//
// The card is a real live undelivered card offering Send again: the fake Claude CLI asks about one command and waits; while
// the preload's MURAGE_TEST_DELIVERY_REFUSED file exists the asking turn's adapter stays live but does not take the owner's
// Allow and its stop resolves stop-failed (index.ts decisionTargetAdapter, test-only seam), so the decision layer keeps the
// ask retryable (deliveryRetry "offered"). The file is then removed, and a retry reaches the real adapter and the waiting CLI.
// The page wire shows a card by its handle and drops its request id and deliveryRetry, so the test reads both from the card's
// durable row in messages.db (read-only, as testing/display-fixture.ts does), the same row the retry route resolves.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { fakeEngineImportArgs, powerBlockTestEnv } from "./testing/power-block-test.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const MARKER = "undelivered-retry-fixture";
const DOOR_TOKEN = "d".repeat(64);
const APPROVAL_NEEDS_OWNER = "Approving or answering happens in the Murage app or on your paired phone. From here you can only decline.";

interface MessageView { id: string; text?: string; card?: { requestHandle?: string; answered?: string } }
interface BotView { id: string; threadId: string; busy: boolean }

describe("Send again on a live undelivered card is the owner's alone", () => {
  let child: ChildProcess | undefined;
  let home: string;
  let base: string;
  let refusedFile: string;
  let output = "";
  let desktopHeaders: Record<string, string> = {};
  const doorHeaders = { "x-murage-door-token": DOOR_TOKEN };

  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() as any };
  };
  const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);
  const botView = async (id: string): Promise<BotView | undefined> =>
    (await desktopApi("GET", "/api/bots?messages=0")).body.bots.find((bot: BotView) => bot.id === id);
  const messagesOf = async (threadId: string): Promise<MessageView[]> =>
    (await desktopApi("GET", `/api/threads/${threadId}/messages?limit=50`)).body.messages as MessageView[];
  /** The CLI's own line after its waiting ask received an answer: one per ask the engine resolved (a second delivery to an
   *  already-resolved ask would not add a line, so this pins "taken once by the waiting ask", not a count of wire sends). */
  const enginesTook = async (threadId: string) => (await messagesOf(threadId)).filter(message => message.text === "permission: allowed").length;

  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-undelivered-retry-"));
    refusedFile = join(home, "delivery-refused");
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      instances: {
        claude: {
          driver: "claudeAgent",
          environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_PERM_INPUT: JSON.stringify({ command: `touch ./${MARKER}` }) },
          config: { cli: FAKE_CLAUDE },
        },
      },
    }));
    child = spawn(process.execPath, [...fakeEngineImportArgs(),
      "--import", pathToFileURL(join(SERVER_DIR, "testing", "attention-stats-preload.mjs")).href,
      "--import", pathToFileURL(join(SERVER_DIR, "testing", "retry-route-conversation-preload.mjs")).href,
      join(SERVER_DIR, "index.ts")], {
      windowsHide: true,
      cwd: join(SERVER_DIR, ".."),
      env: { ...powerBlockTestEnv(),
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        NODE_ENV: "test",
        MURAGE_ENGINE_EXCLUSION_PATH: process.env.MURAGE_ENGINE_EXCLUSION_PATH,
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
        MURAGE_COMPANION_TOKEN: DOOR_TOKEN,
        MURAGE_TEST_DELIVERY_REFUSED: refusedFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => (output += chunk));
    child.stderr!.on("data", chunk => (output += chunk));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. output:\n${output}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. output:\n${output}`);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const proof = await request("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 40_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("refuses the door with APPROVAL_NEEDS_OWNER and re-sends nothing; the owner's Send again on the same card is taken once", async () => {
    const modelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
    const created = await desktopApi("POST", "/api/bots", { name: "Retry", modelSelection, requireAvailableModel: true });
    expect(created.status).toBe(201);
    const bot = created.body.bot as BotView;
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { modelSelection, computer: "off", autoApprove: false, autoReview: "off" })).status).toBe(200);
    expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: `__fixture_permission_tool__ ${MARKER}` })).status).toBe(202);
    let card: MessageView | undefined;
    await expect.poll(async () => {
      card = (await messagesOf(bot.threadId)).find(message => message.card?.requestHandle && !message.card.answered);
      return Boolean(card);
    }, { timeout: 30_000 }).toBe(true);
    /** The card's durable row: the retry route resolves it by its stored request id, and Send again lives on it. */
    const cardNow = (): { requestId?: string; answered?: string; deliveryRetry?: string } => {
      const db = new DatabaseSync(join(home, ".murage", "messages.db"), { readOnly: true });
      try { return JSON.parse(String(db.prepare("SELECT json FROM messages WHERE id=?").get(card!.id)!.json)).card; } finally { db.close(); }
    };

    // The engine does not take the owner's Allow and the stop does not land: the card stays live and offers Send again.
    writeFileSync(refusedFile, "refused");
    const answered = await desktopApi("POST", `/api/bots/${bot.id}/respond`, { requestHandle: card!.card!.requestHandle, action: "allow" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(503);
    expect(answered.body).toMatchObject({ ok: false, code: "delivery_retry" });
    await expect.poll(() => cardNow().deliveryRetry, { timeout: 10_000 }).toBe("offered");
    expect((await botView(bot.id))?.busy, "the asking turn ended").toBe(true);
    expect(await enginesTook(bot.threadId)).toBe(0);
    rmSync(refusedFile);

    const retryPath = `/api/threads/${bot.threadId}/requests/${encodeURIComponent(cardNow().requestId!)}/retry-delivery`;
    // The door passes this process's (reclassified) route layer, so the handler's own owner gate answers it.
    const door = await request("POST", retryPath, undefined, doorHeaders);
    expect(door.status, JSON.stringify(door.body)).toBe(403);
    expect(door.body).toEqual({ error: APPROVAL_NEEDS_OWNER });
    // Nothing was re-sent: the CLI is still waiting, the card still offers Send again, no answer reached the engine.
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(await enginesTook(bot.threadId), "the door's retry re-sent the stored Allow").toBe(0);
    expect(cardNow().deliveryRetry, "the door's retry touched the card").toBe("offered");

    // The owner presses Send again on the same live card: the waiting ask takes the stored Allow, once.
    const owned = await desktopApi("POST", retryPath);
    expect(owned.status, JSON.stringify(owned.body)).toBe(200);
    expect(owned.body).toEqual({ ok: true, outcome: "accepted" });
    await expect.poll(async () => enginesTook(bot.threadId), { timeout: 10_000 }).toBe(1);
    await expect.poll(() => cardNow().deliveryRetry, { timeout: 10_000 }).toBeUndefined();
    expect(cardNow().answered).toBe("Allowed");
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(await enginesTook(bot.threadId), "the waiting ask resolved more than once").toBe(1);
  }, 120_000);
});
