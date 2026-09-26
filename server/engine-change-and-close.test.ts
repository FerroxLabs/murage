// A run waiting for the person, end to end against the real harness, when
// something else happens around it (0.1.60 Mac re-test, D3, D6, D7):
//
//  D3 Turning off an engine nobody is using ("I don't use Droid" in the Inbox)
//     rebuilt the whole provider fleet and killed a routine on another engine
//     that was waiting for an approval, with "turn interrupted because
//     provider settings changed" and the red card's "choose another configured
//     model in Provider settings". Only the engine that changed is rebuilt now,
//     and a run on THAT engine ends with a plain "Stopped:" sentence.
//  D7 The approval of a run that ended stayed in the Inbox ("Waiting 1 hour",
//     Allow once, Deny). A run's end retires its approvals, and so does the
//     next start for any left open by a previous process.
//  D6 A run killed because Murage closed showed "fuigoAgent exited 143 before
//     the prompt result …" under Provider settings advice. It now says Murage
//     closed while it was running.
//
// Both engines are the fake Claude CLI. "claude" asks for permission on
// `__fixture_permission_tool__`; "other" is the engine that gets turned off.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const DESKTOP_SECRET = "0123456789abcdef".repeat(4);
const DESKTOP_HEADERS = { "x-murage-surface": "desktop", "x-murage-surface-secret": DESKTOP_SECRET } as const;

interface MessageView { id: string; role: string; kind: string; text?: string; tool?: { name: string; ok?: boolean }; card?: { requestId?: string; tool?: string; answered?: string; dismissed?: boolean } }
interface BotView { id: string; threadId: string; busy: boolean; activity?: string }

describe("an engine change or an app close around a run waiting for the person", () => {
  let child: ChildProcess | undefined;
  let home: string;
  let base: string;
  let port: number;
  let stderr = "";

  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() as any };
  };
  const api = (method: string, path: string, body?: unknown) => request(method, path, body);
  const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, DESKTOP_HEADERS);
  const botView = async (id: string): Promise<BotView | undefined> =>
    (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: BotView) => bot.id === id);
  const messagesOf = async (threadId: string): Promise<MessageView[]> =>
    (await api("GET", `/api/threads/${threadId}/messages?limit=50`)).body.messages;
  const pendingApprovals = async () => (await desktopApi("GET", "/api/inbox?view=approvals")).body.approvals as number;

  const start = async () => {
    stderr = "";
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_DEV_DESKTOP_SECRET: DESKTOP_SECRET,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };

  const makeBot = async (name: string) => {
    const modelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
    const created = await api("POST", "/api/bots", { name, modelSelection, requireAvailableModel: true });
    expect(created.status).toBe(201);
    const bot = created.body.bot as BotView;
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { modelSelection, computer: "off" })).status).toBe(200);
    return bot;
  };

  /** Send the permission fixture and wait for its approval card. */
  const waitingForApproval = async (bot: BotView) => {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "__fixture_permission_tool__" })).status).toBe(202);
    let card: MessageView | undefined;
    await expect.poll(async () => {
      card = (await messagesOf(bot.threadId)).find((message) => message.card?.requestId && message.card.tool && !message.card.answered);
      return Boolean(card);
    }, { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await botView(bot.id))?.activity, { timeout: 10_000 }).toBe("waiting-on-you");
    expect(await pendingApprovals()).toBeGreaterThanOrEqual(1);
    return card!;
  };

  const errorChips = (messages: MessageView[]) => messages.filter((message) => message.tool?.name.startsWith("error:")).map((message) => message.tool!.name);

  beforeAll(async () => {
    port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-engine-change-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      instances: {
        claude: {
          driver: "claudeAgent",
          environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_PERM_INPUT: JSON.stringify({ command: "touch ./engine-change-fixture" }) },
          config: { cli: FAKE_CLAUDE },
        },
        other: {
          driver: "claudeAgent",
          displayName: "Other engine",
          environment: { FAKE_CLAUDE_MODE: "happy" },
          config: { cli: FAKE_CLAUDE },
        },
      },
    }));
    await start();
  }, 40_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("D3: turning off an engine nobody uses leaves a run on another engine waiting, and it carries on when answered", async () => {
    const bot = await makeBot("Unrelated engine off");
    try {
      const card = await waitingForApproval(bot);
      const off = await desktopApi("PATCH", "/api/instances/other", { enabled: false });
      expect(off.status).toBe(200);
      expect(off.body.instances.find((instance: { instanceId: string }) => instance.instanceId === "other")?.enabled).toBe(false);

      // Still waiting, card still open, nothing written about provider settings.
      expect((await botView(bot.id))?.activity).toBe("waiting-on-you");
      const during = await messagesOf(bot.threadId);
      expect(errorChips(during)).toEqual([]);
      expect(during.some((message) => message.tool?.name.startsWith("stopped:"))).toBe(false);
      expect(during.find((message) => message.id === card.id)?.card?.answered).toBeUndefined();

      // And the answer still reaches the engine that asked.
      expect((await desktopApi("POST", `/api/bots/${bot.id}/respond`, { requestId: card.card!.requestId, behavior: "allow" })).status).toBe(200);
      await expect.poll(async () => (await messagesOf(bot.threadId)).some((message) => message.text === "permission: allowed"), { timeout: 15_000 }).toBe(true);
      await expect.poll(async () => (await botView(bot.id))?.busy, { timeout: 10_000 }).toBe(false);
      expect(errorChips(await messagesOf(bot.threadId))).toEqual([]);
    } finally {
      await desktopApi("PATCH", "/api/instances/other", { enabled: true });
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  }, 90_000);

  it("D3 + D7: turning off the run's own engine ends it with a plain sentence and takes its approval out of the Inbox", async () => {
    const bot = await makeBot("Own engine off");
    try {
      const card = await waitingForApproval(bot);
      expect((await desktopApi("PATCH", "/api/instances/claude", { enabled: false })).status).toBe(200);

      await expect.poll(async () => (await botView(bot.id))?.busy, { timeout: 15_000 }).toBe(false);
      const after = await messagesOf(bot.threadId);
      expect(errorChips(after)).toEqual([]);
      expect(after.map((message) => message.tool?.name)).toContain("stopped: the engine it was using was turned off or changed in Settings");
      expect(JSON.stringify(after)).not.toMatch(/provider settings/i);
      expect(after.find((message) => message.id === card.id)?.card).toMatchObject({ answered: "unavailable", dismissed: true });
      expect(await pendingApprovals()).toBe(0);
    } finally {
      await desktopApi("PATCH", "/api/instances/claude", { enabled: true });
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  }, 90_000);

  it("D6 + D7: Murage closing mid-wait says so, and the next start retires the approval it left open", async () => {
    const bot = await makeBot("Closed mid wait");
    const card = await waitingForApproval(bot);
    await waitForExit(child!, { signal: "SIGTERM" });
    await start();

    const after = await messagesOf(bot.threadId);
    expect(errorChips(after)).toEqual([]);
    expect(after.map((message) => message.tool?.name)).toContain("stopped: Murage closed while this was running");
    expect(JSON.stringify(after)).not.toMatch(/exited 143|provider settings/i);
    expect(after.find((message) => message.id === card.id)?.card?.dismissed).toBe(true);
    expect(await pendingApprovals()).toBe(0);
    await desktopApi("DELETE", `/api/bots/${bot.id}`);
  }, 90_000);
});
