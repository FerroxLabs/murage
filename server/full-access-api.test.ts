// Full access, end to end: the approval level above Auto.
//
// The unit tests in full-access.test.ts pin the RULES; these pin the WIRING
// over real HTTP with the fake ACP agent asking for permission mid-turn:
//
//   - only the desktop app can switch Full access on, and only after its
//     one-time warning for that bot;
//   - an attended turn that cleans its own build folder raises no card under
//     Full access, and does again once back on Auto; reading a shell profile
//     still stops (the key guard);
//   - the stop line: deleting outside its folder stops even under Full
//     access, says what and why, and "Allow for this task" covers the same
//     place for the rest of the task;
//   - a webhook turn and a routine turn still ask, as they would under Auto.
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
/** A shell profile (an Auto "sensitive" stop) and a personal folder. */
const PROTECTED_READ = "cat ~/.zshrc ~/Documents/notes.txt";
/** Auto's destructive guard stops this; inside its own folder, Full access
 * does not. */
const CLEAN_BUILD = "rm -rf build";
/** Outside its folder: the stop line holds under every level. */
const DELETE_OUTSIDE = "rm -rf ~/Documents/old";

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
const api = (method: string, path: string, body?: unknown) => request(method, path, body);
const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);
const botState = async (botId: string) => (await desktopApi("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId);
const taskState = async (botId: string, threadId: string) => (await botState(botId)).tasks.find((task: any) => task.threadId === threadId);
const threadMessages = async (threadId: string) => ((await desktopApi("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as any[];
const liveCard = async (threadId: string) =>
  (await threadMessages(threadId)).find((m) => m.kind === "options" && m.card?.requestId && m.card?.answered === undefined) ?? null;

async function makeBot(name: string, instanceId = "protected") {
  const created = await desktopApi("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-model" } });
  expect(created.status).toBe(201);
  // no computer: keeps the Auto-on-this-computer warning out of these tests
  expect((await desktopApi("PATCH", `/api/bots/${created.body.bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return created.body.bot as { id: string; threadId: string };
}

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
    const task = await taskState(botId, threadId);
    return task && !task.busy ? task : null;
  }, ms);
}

async function runThread(runId: string) {
  return poll(async () => {
    const { body } = await api("GET", "/api/routines");
    const run = (body.runs ?? []).find((r: { id: string }) => r.id === runId);
    return (run?.threadId as string | undefined) ?? null;
  }, 20_000);
}

/** Answer (deny) and settle a card so the bot is free for the next step. */
async function deny(botId: string, threadId: string, requestId: string) {
  await desktopApi("POST", `/api/threads/${threadId}/respond`, { requestId, behavior: "deny" });
  await waitIdle(botId, threadId);
}

describe.skipIf(process.platform === "win32")("Full access", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 18_799, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-full-access-"));
    expect(home.startsWith(tmpdir())).toBe(true);
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(
      join(home, ".murage", "config.json"),
      JSON.stringify({
        instances: {
          // asks the client to approve reading a shell profile and a personal
          // folder — Auto stops at the first; Full access must not
          protected: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: PROTECTED_READ },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
          cleaner: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: CLEAN_BUILD },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
          // fullAuto on the engine: under Full access it must still ask
          deleter: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: DELETE_OUTSIDE },
            config: { cli: FAKE_CLI, fullAuto: true },
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
    const proof = await api("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("refuses to switch Full access on from anything but the desktop app", async () => {
    const bot = await makeBot("Phone target");
    const thread = `/api/bots/${bot.id}/tasks/${bot.threadId}`;
    const ask = { fullAccess: true, acknowledgeFullAccess: true };
    // a script or a bot calling the loopback API: no desktop proof
    expect((await api("PATCH", thread, ask)).status).toBe(404);
    expect((await api("PATCH", `/api/bots/${bot.id}`, ask)).status).toBe(404);
    // the marker without this launch's secret
    expect((await request("PATCH", thread, ask, { "x-murage-surface": "desktop" })).status).toBe(404);
    // the paired phone, even holding the desktop secret
    expect((await request("PATCH", thread, ask, { ...desktopHeaders, "x-murage-companion": "1" })).status).toBe(404);
    expect((await request("PATCH", `/api/bots/${bot.id}`, ask, { ...desktopHeaders, "x-murage-companion": "1" })).status).toBe(404);
    // a web page in a browser
    expect((await request("PATCH", thread, ask, { ...desktopHeaders, origin: "https://example.com" })).status).toBe(403);
    const task = await taskState(bot.id, bot.threadId);
    expect(task.fullAccess).not.toBe(true);
    expect(task.autoApprove).toBe(false);
    expect((await botState(bot.id)).fullAccessAcknowledgedAt).toBeUndefined();
  });

  it("requires the warning the first time for each bot, and only the first time", async () => {
    const bot = await makeBot("Warned once");
    const other = await makeBot("Another bot");
    const thread = (b: { id: string; threadId: string }) => `/api/bots/${b.id}/tasks/${b.threadId}`;

    const unconfirmed = await desktopApi("PATCH", thread(bot), { fullAccess: true });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error).toContain("acknowledgeFullAccess");
    expect((await taskState(bot.id, bot.threadId)).fullAccess).not.toBe(true);

    const confirmed = await desktopApi("PATCH", thread(bot), { fullAccess: true, acknowledgeFullAccess: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.task).toMatchObject({ autoApprove: true, fullAccess: true });
    expect(typeof (await botState(bot.id)).fullAccessAcknowledgedAt).toBe("number");

    // back to Auto, then Full access again: no second warning for this bot
    expect((await desktopApi("PATCH", thread(bot), { fullAccess: false })).body.task).toMatchObject({ autoApprove: true, fullAccess: false });
    expect((await desktopApi("PATCH", thread(bot), { fullAccess: true })).status).toBe(200);
    expect((await taskState(bot.id, bot.threadId)).fullAccess).toBe(true);

    // ...but a different bot has not seen it
    expect((await desktopApi("PATCH", thread(other), { fullAccess: true })).status).toBe(400);
    // and Ask ends it
    expect((await desktopApi("PATCH", thread(bot), { autoApprove: false })).body.task).toMatchObject({ autoApprove: false, fullAccess: false });
  });

  it(
    "raises no card for cleaning its own folder in Full access, and Auto's stop returns on switching back",
    async () => {
      const bot = await makeBot("Full cleaner", "cleaner");
      const thread = `/api/bots/${bot.id}/tasks/${bot.threadId}`;
      expect((await desktopApi("PATCH", thread, { fullAccess: true, acknowledgeFullAccess: true })).status).toBe(200);

      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "clean the build" })).status).toBe(202);
      // answered at once: the turn finishes with no card ever raised, and the
      // approval shows as one quiet line that lists the step
      expect(await waitIdle(bot.id, bot.threadId), `turn never finished. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
      expect((await threadMessages(bot.threadId)).filter((m) => m.kind === "options" && m.card?.requestId)).toHaveLength(0);
      const line = (await threadMessages(bot.threadId)).find((m) => m.kind === "activity" && Array.isArray(m.tool?.steps));
      expect(line?.tool).toMatchObject({ name: "Approved 1 step (Full access)", stepCount: 1 });
      expect(line.tool.steps[0]).toContain(CLEAN_BUILD);
      expect((await threadMessages(bot.threadId)).some((m) => /^auto-approved .*\(full access\)/.test(String(m.tool?.name ?? "")))).toBe(false);

      // switching back to Auto restores Auto's stop for the same command
      expect((await desktopApi("PATCH", thread, { fullAccess: false })).status).toBe(200);
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "clean it again" })).status).toBe(202);
      const card = await poll(() => liveCard(bot.threadId), 20_000);
      expect(card, "Auto did not stop at rm -rf after leaving Full access").not.toBeNull();
      expect(card.card.held).toContain("destructive");
      await deny(bot.id, bot.threadId, card.card.requestId);
    },
    60_000,
  );

  it(
    "still stops before a key under Full access",
    async () => {
      const bot = await makeBot("Full reader");
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { fullAccess: true, acknowledgeFullAccess: true })).status).toBe(200);
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "read my profile" })).status).toBe(202);
      const card = await poll(() => liveCard(bot.threadId), 20_000);
      expect(card, "Full access read a shell profile without asking").not.toBeNull();
      expect(card.card.held).toContain("sensitive");
      await deny(bot.id, bot.threadId, card.card.requestId);
    },
    60_000,
  );

  it(
    "stops before deleting outside its folder under Full access, even on a fullAuto engine, and Allow for this task covers the same place",
    async () => {
      const bot = await makeBot("Full deleter", "deleter");
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { fullAccess: true, acknowledgeFullAccess: true })).status).toBe(200);
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "tidy my documents" })).status).toBe(202);
      const card = await poll(() => liveCard(bot.threadId), 20_000);
      expect(card, `a delete outside its folder ran unasked under Full access. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
      expect(card.card.held).toBe("Delete 1 item outside its folder: ~/Documents/old");
      expect(card.card.taskAllowKey).toMatch(/^stop:delete:\/.*\/Documents\/old$/);
      // Always allow is scoped the same way, never the bare tool
      expect(card.card.allowKey).toBe(card.card.taskAllowKey);

      // a forged key cannot ride along: the server records the card's own
      const allowed = await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow", allowForTask: true, taskAllowKey: "stop:delete:/" });
      expect(allowed.body).toMatchObject({ ok: true, outcome: "allowed-once" });
      expect(await waitIdle(bot.id, bot.threadId)).not.toBeNull();

      // the same delete again in this task: covered, no card
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "and again" })).status).toBe(202);
      const chip = await poll(async () =>
        (await threadMessages(bot.threadId)).find((m) => m.kind === "activity" && String(m.tool?.name ?? "").includes("(allowed for this task)")) ?? null, 20_000);
      expect(chip, "the task allowance did not cover the same place").not.toBeNull();
      expect(await waitIdle(bot.id, bot.threadId)).not.toBeNull();

      // a different task of the same bot is a different task
      const other = await desktopApi("POST", `/api/bots/${bot.id}/tasks`, { title: "Another task" });
      expect(other.status).toBe(201);
      const otherThread = other.body.task.threadId as string;
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${otherThread}`, { fullAccess: true })).status).toBe(200);
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: otherThread, text: "tidy" })).status).toBe(202);
      const again = await poll(() => liveCard(otherThread), 20_000);
      expect(again, "a task allowance leaked into another task").not.toBeNull();
      await deny(bot.id, otherThread, again.card.requestId);
    },
    90_000,
  );

  it(
    "still asks when a webhook starts the turn",
    async () => {
      const bot = await makeBot("Hooked");
      // profile level, so the webhook's own task inherits Full access
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { fullAccess: true, acknowledgeFullAccess: true })).status).toBe(200);
      expect((await botState(bot.id)).fullAccess).toBe(true);
      const hook = await desktopApi("POST", "/api/webhooks", { name: "Inbound", prompt: "Handle the event", botId: bot.id, runOn: "ember" });
      expect(hook.status).toBe(201);
      const delivered = await fetch(hook.body.credential.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "ping" }),
      });
      expect(delivered.status).toBe(202);
      const threadId = await runThread(((await delivered.json()) as { runId: string }).runId);
      expect(threadId, "the webhook never started a task").toBeTruthy();
      expect((await taskState(bot.id, threadId!)).fullAccess).toBe(true);
      const card = await poll(() => liveCard(threadId!), 30_000);
      expect(card, "a webhook turn skipped its card under Full access").not.toBeNull();
      await deny(bot.id, threadId!, card.card.requestId);
    },
    60_000,
  );

  it(
    "still asks, as Auto would, when a routine starts the turn",
    async () => {
      const bot = await makeBot("Scheduled");
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { fullAccess: true, acknowledgeFullAccess: true })).status).toBe(200);
      const routine = await desktopApi("POST", "/api/routines", {
        name: "Nightly read",
        prompt: "Read the profile",
        botId: bot.id,
        runOn: "ember",
        schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
        enabled: false,
      });
      expect(routine.status).toBe(201);
      const started = await desktopApi("POST", `/api/routines/${routine.body.routine.id}/run`);
      expect(started.status).toBe(201);
      const threadId = await runThread(started.body.run.id);
      expect(threadId, "the routine never started a task").toBeTruthy();
      expect((await taskState(bot.id, threadId!)).fullAccess).toBe(true);
      const card = await poll(() => liveCard(threadId!), 30_000);
      expect(card, "a routine turn skipped Auto's stop under Full access").not.toBeNull();
      expect(card.card.held).toContain("sensitive");
      await deny(bot.id, threadId!, card.card.requestId);
    },
    60_000,
  );
});
