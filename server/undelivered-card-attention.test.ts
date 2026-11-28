// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1021 undelivered card: an owner Allow the engine can no longer take (the provider turn that asked has moved on, so no
// adapter holds the ask and the decision layer's interrupt reaches nothing, while the server's turn is still running) makes
// the card terminal. The card's attention must settle
// with it: the bot is no longer "Waiting for you", no attention hold or request wait is left, the route answers with the
// terminal code (not the retry code), and the server logs one value-free line naming why the delivery failed.
//
// The engine is the fake Claude CLI: the permission fixture asks about one command and waits for its answer. The test
// preload's MURAGE_TEST_DELIVERY_LOST file makes the server resolve no adapter for the ask's turn (index.ts
// decisionTargetAdapter): the receipt and the no-op interrupt of an engine side that is gone. Everything else is real.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { fakeEngineImportArgs, powerBlockTestEnv } from "./testing/power-block-test.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const MARKER = "undelivered-card-fixture";

interface MessageView { id: string; text?: string; card?: { requestId?: string; requestHandle?: string; answered?: string; dismissed?: boolean } }
interface BotView { id: string; threadId: string; busy: boolean; activity?: string }
interface AttentionCounts { scopes: number; cards: number; requests: number; waits: number; holds: number }

describe("an owner answer the engine can no longer take", () => {
  let child: ChildProcess | undefined;
  let home: string;
  let base: string;
  let lostFile: string;
  let statsFile: string;
  let output = "";
  let desktopHeaders: Record<string, string> = {};

  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() as any };
  };
  const api = (method: string, path: string, body?: unknown) => request(method, path, body);
  const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);
  const botView = async (id: string): Promise<BotView | undefined> =>
    (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: BotView) => bot.id === id);
  const messagesOf = async (threadId: string): Promise<MessageView[]> =>
    (await api("GET", `/api/threads/${threadId}/messages?limit=50`)).body.messages as MessageView[];
  /** The server's retained attention counts, from a sample it wrote after this call began. */
  const attentionCounts = async (): Promise<AttentionCounts> => {
    const from = Date.now();
    let sample: (AttentionCounts & { at: number }) | undefined;
    await expect.poll(() => {
      try { sample = JSON.parse(readFileSync(statsFile, "utf8")); } catch { return false; }
      return sample!.at > from;
    }, { timeout: 5_000, interval: 20 }).toBe(true);
    const { scopes, cards, requests, waits, holds } = sample!;
    return { scopes, cards, requests, waits, holds };
  };

  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-undelivered-card-"));
    lostFile = join(home, "delivery-lost");
    statsFile = join(home, "attention-stats.json");
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      instances: {
        claude: {
          driver: "claudeAgent",
          environment: {
            FAKE_CLAUDE_MODE: "happy",
            FAKE_CLAUDE_PERM_INPUT: JSON.stringify({ command: `touch ./${MARKER}` }),
          },
          config: { cli: FAKE_CLAUDE },
        },
      },
    }));
    child = spawn(process.execPath, [...fakeEngineImportArgs(), "--import", pathToFileURL(join(SERVER_DIR, "testing", "attention-stats-preload.mjs")).href, join(SERVER_DIR, "index.ts")], {
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
        MURAGE_TEST_ATTENTION_STATS: statsFile,
        MURAGE_TEST_DELIVERY_LOST: lostFile,
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
    const proof = await api("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 40_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("settles the card's attention, says so with the terminal code, and logs one value-free line", async () => {
    const modelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
    const created = await api("POST", "/api/bots", { name: "Undelivered", modelSelection, requireAvailableModel: true });
    expect(created.status).toBe(201);
    const bot = created.body.bot as BotView;
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { modelSelection, computer: "off", autoApprove: false, autoReview: "off" })).status).toBe(200);

    expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: `__fixture_permission_tool__ ${MARKER}` })).status).toBe(202);
    let card: MessageView | undefined;
    await expect.poll(async () => {
      card = (await messagesOf(bot.threadId)).find(message => message.card?.requestHandle && !message.card.answered);
      return Boolean(card);
    }, { timeout: 30_000 }).toBe(true);
    // The card is waiting on the owner: the bot says so and the card holds attention.
    await expect.poll(async () => (await botView(bot.id))?.activity, { timeout: 10_000 }).toBe("waiting-on-you");
    await expect.poll(async () => (await attentionCounts()).holds, { timeout: 10_000 }).toBe(1);

    // The engine side of the ask is lost; the server's turn is still running.
    writeFileSync(lostFile, "lost");
    expect((await botView(bot.id))?.busy, "the turn ended, which would retire its attention on its own").toBe(true);
    expect((await botView(bot.id))?.activity, "the card stopped waiting before the owner answered").toBe("waiting-on-you");
    const linesBefore = output.split("\n").length;

    const answered = await desktopApi("POST", `/api/bots/${bot.id}/respond`, { requestHandle: card!.card!.requestHandle, action: "allow" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(503);
    expect(answered.body).toMatchObject({ ok: false, code: "delivery_failed_terminal", error: "The tool permission could not be delivered. Nothing was confirmed." });
    // The card itself is terminal.
    await expect.poll(async () => (await messagesOf(bot.threadId)).find(message => message.id === card!.id)?.card?.answered, { timeout: 10_000 })
      .toBe("The tool permission could not be delivered. Nothing was confirmed.");

    // Its attention settled with it, while the turn is still working: no longer waiting on the owner, no hold, no wait.
    await expect.poll(async () => (await botView(bot.id))?.activity, { timeout: 10_000 }).not.toBe("waiting-on-you");
    const after = await attentionCounts();
    expect([after.holds, after.waits], "the undelivered card still holds attention").toEqual([0, 0]);
    expect((await botView(bot.id))?.busy).toBe(true);

    // One line names why, and carries no value: no command, request id, thread or bot id.
    const lines = output.split("\n").slice(linesBefore - 1).filter(line => line.includes("[decision] delivery not taken"));
    expect(lines).toEqual([expect.stringMatching(/^\[decision\] delivery not taken class=engine reason=[a-z-]+ state=failed$/)]);
    for (const value of [MARKER, card!.card!.requestId!, bot.threadId, bot.id]) expect(lines[0]).not.toContain(value);

    // Send again is owner-only (RETRY-DESIGN-r3 step 2), like an Allow on the answer route: a loopback caller with no owner
    // proof (a script, or a bot's own shell) is refused before the stored Allow is read or re-sent, and the owner's desktop
    // reaches the retry handler, which reports the ended card. On a desktop home the route policy (unlisted = desktop class) refuses
    // it first; the handler's own mayApprove is the second layer, for a caller the policy admits (a Cloud home decides by
    // cloudRouteDecision, not routeAdmits), so it is pinned in the source below.
    const retryPath = `/api/threads/${bot.threadId}/requests/${encodeURIComponent(card!.card!.requestId!)}/retry-delivery`;
    const linesBeforeRetry = output.split("\n").length;
    const outsider = await api("POST", retryPath);
    expect([403, 404], JSON.stringify(outsider.body)).toContain(outsider.status);
    expect(outsider.body.code, "a non-owner reached the retry").toBeUndefined();
    const owned = await desktopApi("POST", retryPath);
    // The handler itself answers the owner (it carries a code; the route layer's refusal has none): the ended card no longer
    // holds a registration, so there is nothing to send again.
    expect(owned.status, JSON.stringify(owned.body)).toBe(404);
    expect(owned.body).toMatchObject({ code: "not_found" });
    expect(output.split("\n").slice(linesBeforeRetry - 1).filter(line => line.includes("[decision] delivery not taken")), "a retry re-sent the answer").toEqual([]);
    const source = readFileSync(join(SERVER_DIR, "index.ts"), "utf8");
    expect(source, "the retry route reads the card before the owner gate").toMatch(
      /retry-delivery\$\/\);\s*if \(m && method === "POST"\) \{(?:\s*\/\/[^\n]*)*\s*if \(!mayApprove\(req, url\)\) return json\(res, 403, \{ error: APPROVAL_NEEDS_OWNER \}\);/);

  }, 120_000);
});
