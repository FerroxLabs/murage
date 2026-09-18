// Full access as a bot default, and its two per-bot extras, over real HTTP:
//
//   - Bot Settings can make Full access the bot's default (desktop only,
//     the same one-time warning), and new conversations inherit it while an
//     existing conversation keeps its own level;
//   - the owner's own messages from Telegram (the channel fixture) keep
//     asking under Full access unless "Also skip approvals for my messages
//     from Telegram, Slack and Discord" is on; a message from anyone else
//     never runs under Full access, and a webhook turn still asks;
//   - setup requests (a routine proposal, a learned skill, a folder's own
//     instructions) keep asking unless "Also approve setup requests" is on,
//     and never from a webhook turn;
//   - both options are off when a bot record does not carry them, and only
//     the desktop app can turn them on.
//
// HEADLESS ONLY: the data directory is a throwaway temp HOME, the port comes
// from the fixture band clear of the live app's 8799, Telegram is the fetch
// fixture in testing/telegram-fetch-preload.mjs and every engine is a fake.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const TELEGRAM_PRELOAD = pathToFileURL(join(SERVER_DIR, "testing", "telegram-fetch-preload.mjs")).href;
/** A shell profile read: Auto stops at it, Full access does not. */
const PROTECTED_READ = "cat ~/.zshrc";
const TELEGRAM_OWNER = 777;
const TELEGRAM_TOKEN = "123:abcdefghijklmnopqrstuvwxyz123456";

let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let holderDump: string;
let acpDump: string;
let telegramDir: string;
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
const storedBot = (botId: string) => (JSON.parse(readFileSync(join(home, ".murage", "bots.json"), "utf8")) as any[]).find((bot) => bot.id === botId);
const threadMessages = async (threadId: string) => ((await desktopApi("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as any[];
const liveCard = async (threadId: string) =>
  (await threadMessages(threadId)).find((m) => m.kind === "options" && m.card?.requestId && m.card?.answered === undefined) ?? null;
const fullAccessChip = async (threadId: string) =>
  (await threadMessages(threadId)).find((m) => m.kind === "activity" && String(m.tool?.name ?? "").includes("(full access)")) ?? null;
const decisions = (): any[] => {
  const path = join(home, ".murage", "decisions.ndjson");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};

async function poll<T>(read: () => Promise<T | null | undefined>, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function makeBot(name: string, instanceId: string) {
  const created = await desktopApi("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-model" } });
  expect(created.status).toBe(201);
  // no computer: keeps the Auto-on-this-computer warning out of these tests
  expect((await desktopApi("PATCH", `/api/bots/${created.body.bot.id}`, { computer: "off", browser: false, composio: false, autoReview: "off" })).status).toBe(200);
  return created.body.bot as { id: string; threadId: string };
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

async function deny(threadId: string, requestId: string) {
  expect((await desktopApi("POST", `/api/threads/${threadId}/respond`, { requestId, behavior: "deny" })).status).toBe(200);
}

/** Start a held turn on the fake Claude and return its agents-tool token. */
async function heldTurn(bot: { id: string }, threadId: string): Promise<Record<string, string>> {
  rmSync(holderDump, { force: true });
  expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "set things up" })).status).toBe(202);
  const dump = await poll(async () => {
    try {
      return JSON.parse(readFileSync(holderDump, "utf8"));
    } catch {
      return null;
    }
  }, 20_000);
  expect(dump, `the held turn never started. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
  return { authorization: `Bearer ${dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN}` };
}

async function stopTurn(botId: string, threadId: string) {
  await desktopApi("POST", `/api/bots/${botId}/interrupt`, { threadId });
  await waitIdle(botId, threadId);
}

const proposeRoutine = (bot: { id: string }, threadId: string, auth: Record<string, string>, name: string) =>
  request("POST", "/api/internal/routine-requests", {
    fromBotId: bot.id,
    fromThreadId: threadId,
    action: "create",
    routine: { name, instructions: "Summarize the day.", schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] } },
  }, auth);

const stageSkill = (bot: { id: string }, threadId: string, auth: Record<string, string>, name: string) =>
  request("POST", "/api/internal/skills/stage", {
    fromBotId: bot.id,
    fromThreadId: threadId,
    action: "create",
    source: "conversation",
    gist: `Use ${name} safely.`,
    skill_md: `---\nname: ${name}\ndescription: Use ${name} safely.\n---\n\n# ${name}\n\nDo the reviewed thing.\n`,
  }, auth);

const cardFor = async (threadId: string, key: "routineRequest" | "skillRequest", name: string) =>
  (await threadMessages(threadId)).find((m) => m.card?.[key] && JSON.stringify(m.card[key]).includes(name))?.card ?? null;

describe.skipIf(process.platform === "win32")("Full access default and its options", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 18_799, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-full-access-options-"));
    expect(home.startsWith(tmpdir())).toBe(true);
    holderDump = join(home, "fake-claude-dump.json");
    acpDump = join(home, "fake-acp-dump.json");
    telegramDir = join(home, "telegram-fixture");
    mkdirSync(telegramDir);
    mkdirSync(join(home, ".murage"), { recursive: true });
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
    writeFileSync(
      join(home, ".murage", "config.json"),
      JSON.stringify({
        engineDiscovery: "explicit",
        features: { skillRecorder: true },
        instances: {
          // asks the client to approve reading a shell profile
          protected: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: PROTECTED_READ },
            config: { cli: FAKE_ACP, fullAuto: false },
          },
          // holds every turn open so the test can call the bot's own tools
          holder: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: holderDump },
            config: { cli: FAKE_CLAUDE },
          },
          // Fuigo's folder-trust gate
          fuigo: {
            driver: "fuigoAgent",
            environment: { FAKE_ACP_MODE: "folder-trust", FAKE_ACP_DUMP: acpDump },
            config: { cli: FAKE_ACP, fullAuto: false },
          },
        },
      }),
    );
    child = spawn(process.execPath, ["--import", TELEGRAM_PRELOAD, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
        MURAGE_MODEL_PROVIDER_CONNECTIONS: "",
        MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "",
        FAKE_TELEGRAM_DIR: telegramDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 30_000;
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
  }, 45_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("Bot Settings can make Full access the default: desktop only, warned once, inherited by new conversations only", async () => {
    const bot = await makeBot("Default setter", "protected");
    const first = bot.threadId;
    expect((await desktopApi("POST", `/api/bots/${bot.id}/tasks`, { title: "second" })).status).toBe(201);
    const defaults = { settingsScope: "defaults", autoApprove: true, fullAccess: true };

    // with two conversations a bare level change is ambiguous, as before
    const ambiguous = await desktopApi("PATCH", `/api/bots/${bot.id}`, { fullAccess: true, acknowledgeFullAccess: true });
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error).toBe("Choose a thread or edit bot defaults explicitly");
    // the default is the desktop's to set
    expect((await api("PATCH", `/api/bots/${bot.id}`, { ...defaults, acknowledgeFullAccess: true })).status).toBe(404);
    expect((await request("PATCH", `/api/bots/${bot.id}`, { ...defaults, acknowledgeFullAccess: true }, { ...desktopHeaders, "x-murage-companion": "1" })).status).toBe(404);
    // the same one-time warning as the composer
    const unwarned = await desktopApi("PATCH", `/api/bots/${bot.id}`, defaults);
    expect(unwarned.status).toBe(400);
    expect(unwarned.body.error).toContain("acknowledgeFullAccess");
    expect((await botState(bot.id)).fullAccess).not.toBe(true);

    const set = await desktopApi("PATCH", `/api/bots/${bot.id}`, { ...defaults, acknowledgeFullAccess: true });
    expect(set.status).toBe(200);
    const profile = await botState(bot.id);
    expect(profile).toMatchObject({ autoApprove: true, fullAccess: true });
    expect(typeof profile.fullAccessAcknowledgedAt).toBe("number");
    // existing conversations keep their own level
    for (const task of profile.tasks) expect(task.fullAccess).not.toBe(true);

    // a new conversation inherits the default...
    const created = await desktopApi("POST", `/api/bots/${bot.id}/tasks`, { title: "third" });
    expect(created.status).toBe(201);
    expect(created.body.task).toMatchObject({ autoApprove: true, fullAccess: true });
    // ...and the composer still overrides just that one
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${created.body.task.threadId}`, { fullAccess: false })).body.task).toMatchObject({ autoApprove: true, fullAccess: false });
    expect((await botState(bot.id)).fullAccess).toBe(true);
    expect((await taskState(bot.id, first)).fullAccess).not.toBe(true);

    // back to Auto as the default: new conversations start on Auto again
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", autoApprove: true })).status).toBe(200);
    expect(await botState(bot.id)).toMatchObject({ autoApprove: true, fullAccess: false });
    expect((await desktopApi("POST", `/api/bots/${bot.id}/tasks`, { title: "fourth" })).body.task).toMatchObject({ autoApprove: true, fullAccess: false });
  });

  it("both options are off on a bot record that lacks them, and only the desktop turns them on", async () => {
    const bot = await makeBot("Options", "protected");
    const stored = storedBot(bot.id);
    expect(stored).not.toHaveProperty("fullAccessChannelMessages");
    expect(stored).not.toHaveProperty("fullAccessSetupRequests");
    const both = { fullAccessChannelMessages: true, fullAccessSetupRequests: true };
    expect((await api("PATCH", `/api/bots/${bot.id}`, both)).status).toBe(404);
    expect((await request("PATCH", `/api/bots/${bot.id}`, both, { ...desktopHeaders, "x-murage-companion": "1" })).status).toBe(404);
    expect(storedBot(bot.id)).not.toHaveProperty("fullAccessChannelMessages");
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { fullAccessSetupRequests: "yes" })).status).toBe(400);

    const on = await desktopApi("PATCH", `/api/bots/${bot.id}`, both);
    expect(on.status).toBe(200);
    expect(on.body.bot).toMatchObject(both);
    expect(storedBot(bot.id)).toMatchObject(both);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { fullAccessChannelMessages: false })).status).toBe(404);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { fullAccessChannelMessages: false })).status).toBe(200);
    expect(storedBot(bot.id)).toMatchObject({ fullAccessChannelMessages: false, fullAccessSetupRequests: true });
  });

  it(
    "setup requests keep asking under Full access unless the option is on, and never from a webhook turn",
    async () => {
      const bot = await makeBot("Setup", "holder");
      // one conversation: the level lands on it and on the default
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { fullAccess: true, acknowledgeFullAccess: true })).status).toBe(200);
      expect(storedBot(bot.id)).not.toHaveProperty("fullAccessSetupRequests");

      // default: both cards wait for the owner
      let auth = await heldTurn(bot, bot.threadId);
      const asked = await proposeRoutine(bot, bot.threadId, auth, "Default brief");
      expect(asked.status).toBe(201);
      expect(asked.body.autoApproved).not.toBe(true);
      expect((await cardFor(bot.threadId, "routineRequest", "Default brief"))?.answered).toBeUndefined();
      const askedSkill = await stageSkill(bot, bot.threadId, auth, "default-skill");
      expect(askedSkill.status).toBe(201);
      expect((await cardFor(bot.threadId, "skillRequest", "default-skill"))?.answered).toBeUndefined();
      await stopTurn(bot.id, bot.threadId);
      expect((await api("GET", "/api/routines")).body.routines.some((r: any) => r.name === "Default brief")).toBe(false);

      // the option on: the owner's own Full access turn approves them
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { fullAccessSetupRequests: true })).status).toBe(200);
      auth = await heldTurn(bot, bot.threadId);
      const approved = await proposeRoutine(bot, bot.threadId, auth, "Approved brief");
      expect(approved.status, JSON.stringify(approved.body)).toBe(201);
      expect(approved.body.autoApproved).toBe(true);
      expect((await cardFor(bot.threadId, "routineRequest", "Approved brief"))?.answered).toBe("allow");
      expect((await api("GET", "/api/routines")).body.routines.some((r: any) => r.name === "Approved brief")).toBe(true);
      await expect.poll(() => decisions().some((row) => row.requestId === approved.body.requestId && row.decision === "auto-approved" && row.source === "full-access"), { timeout: 5_000 }).toBe(true);
      const skill = await stageSkill(bot, bot.threadId, auth, "approved-skill");
      expect(skill.status, JSON.stringify(skill.body)).toBe(201);
      expect(skill.body.autoApproved).toBe(true);
      expect((await cardFor(bot.threadId, "skillRequest", "approved-skill"))?.answered).toBe("allow");
      expect((await desktopApi("GET", `/api/bots/${bot.id}/skills`)).body.skills.some((s: any) => s.name === "approved-skill")).toBe(true);
      await stopTurn(bot.id, bot.threadId);

      // the option does nothing once this conversation is back on Auto
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { fullAccess: false })).status).toBe(200);
      auth = await heldTurn(bot, bot.threadId);
      const onAuto = await proposeRoutine(bot, bot.threadId, auth, "Auto brief");
      expect(onAuto.status).toBe(201);
      expect(onAuto.body.autoApproved).not.toBe(true);
      expect((await cardFor(bot.threadId, "routineRequest", "Auto brief"))?.answered).toBeUndefined();
      await stopTurn(bot.id, bot.threadId);

      // so does a routine's own turn (run by hand here), with nobody watching
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { fullAccess: true })).status).toBe(200);
      const routine = (await api("GET", "/api/routines")).body.routines.find((r: any) => r.name === "Approved brief");
      rmSync(holderDump, { force: true });
      const started = await desktopApi("POST", `/api/routines/${routine.id}/run`);
      expect(started.status).toBe(201);
      const routineThread = await runThread(started.body.run.id);
      expect(routineThread, "the routine never started a task").toBeTruthy();
      expect((await taskState(bot.id, routineThread!)).fullAccess).toBe(true);
      const routineDump = await poll(async () => {
        try {
          return JSON.parse(readFileSync(holderDump, "utf8"));
        } catch {
          return null;
        }
      }, 20_000);
      expect(routineDump).not.toBeNull();
      const fromRoutine = await proposeRoutine(bot, routineThread!, { authorization: `Bearer ${routineDump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN}` }, "Routine brief");
      expect(fromRoutine.status, JSON.stringify(fromRoutine.body)).toBe(201);
      expect(fromRoutine.body.autoApproved).not.toBe(true);
      expect((await cardFor(routineThread!, "routineRequest", "Routine brief"))?.answered).toBeUndefined();
      await stopTurn(bot.id, routineThread!);

      // a webhook turn keeps asking whatever the options say
      const hooked = await makeBot("Hooked setup", "holder");
      expect((await desktopApi("PATCH", `/api/bots/${hooked.id}`, { fullAccess: true, acknowledgeFullAccess: true, fullAccessSetupRequests: true, fullAccessChannelMessages: true })).status).toBe(200);
      const hook = await desktopApi("POST", "/api/webhooks", { name: "Inbound setup", prompt: "Handle the event", botId: hooked.id, runOn: "ember" });
      expect(hook.status).toBe(201);
      rmSync(holderDump, { force: true });
      const delivered = await fetch(hook.body.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "ping" }) });
      expect(delivered.status).toBe(202);
      const threadId = await runThread(((await delivered.json()) as { runId: string }).runId);
      expect(threadId, "the webhook never started a task").toBeTruthy();
      expect((await taskState(hooked.id, threadId!)).fullAccess).toBe(true);
      const dump = await poll(async () => {
        try {
          return JSON.parse(readFileSync(holderDump, "utf8"));
        } catch {
          return null;
        }
      }, 20_000);
      expect(dump).not.toBeNull();
      const hookAuth = { authorization: `Bearer ${dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN}` };
      const fromHook = await proposeRoutine(hooked, threadId!, hookAuth, "Hook brief");
      expect(fromHook.status, JSON.stringify(fromHook.body)).toBe(201);
      expect(fromHook.body.autoApproved).not.toBe(true);
      expect((await cardFor(threadId!, "routineRequest", "Hook brief"))?.answered).toBeUndefined();
      await stopTurn(hooked.id, threadId!);
    },
    120_000,
  );

  it(
    "a folder's own instructions keep asking under Full access unless setup requests are allowed",
    async () => {
      const bot = await makeBot("Folder", "fuigo");
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { fullAccess: true, acknowledgeFullAccess: true })).status).toBe(200);
      const plant = (threadId: string) => {
        const workspace = join(home, ".murage", "workspaces", bot.id, "threads", threadId);
        mkdirSync(workspace, { recursive: true });
        writeFileSync(join(workspace, "AGENTS.md"), "# planted\ncanary-folder-wren\n");
      };
      plant(bot.threadId);
      rmSync(acpDump, { force: true });
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "go" })).status).toBe(202);
      const card = await poll(async () => (await threadMessages(bot.threadId)).find((m) => m.card?.folderTrust && !m.card.answered), 20_000);
      expect(card, "Full access answered a folder-trust card on its own").not.toBeNull();
      await stopTurn(bot.id, bot.threadId);

      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { fullAccessSetupRequests: true })).status).toBe(200);
      const next = await desktopApi("POST", `/api/bots/${bot.id}/tasks`, { title: "trusted" });
      const threadId = next.body.task.threadId as string;
      expect(next.body.task.fullAccess).toBe(true);
      plant(threadId);
      rmSync(acpDump, { force: true });
      expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "go" })).status).toBe(202);
      expect(await waitIdle(bot.id, threadId, 30_000)).not.toBeNull();
      expect((await threadMessages(threadId)).some((m) => m.card?.folderTrust)).toBe(false);
      expect(JSON.parse(readFileSync(acpDump, "utf8")).argv).toContain("--trust");
      expect((await threadMessages(threadId)).some((m) => m.role === "bot" && String(m.text ?? "").includes("canary-folder-wren"))).toBe(true);
      await expect.poll(() => decisions().some((row) => row.threadId === threadId && row.decision === "folder-trusted" && row.source === "full-access"), { timeout: 5_000 }).toBe(true);
    },
    90_000,
  );

  it(
    "the owner's Telegram messages keep asking under Full access unless allowed; nobody else's ever run under it",
    async () => {
      const chief = await makeBot("Chief", "protected");
      expect((await desktopApi("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, chiefScope: "workspace" })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${chief.id}`, { fullAccess: true, acknowledgeFullAccess: true })).status).toBe(200);
      const updates: unknown[] = [];
      const arrives = (id: number, text: string) => {
        updates.push({ update_id: id, message: { message_id: id, date: 1_700_000_000 + id, text, from: { id: TELEGRAM_OWNER, is_bot: false }, chat: { id: TELEGRAM_OWNER, type: "private" } } });
        const staged = join(telegramDir, "updates.json.tmp");
        writeFileSync(staged, JSON.stringify(updates));
        renameSync(staged, join(telegramDir, "updates.json"));
      };
      const channelRuns = async () => ((await api("GET", "/api/routines")).body.runs as any[]).filter((run) => run.triggerSource === "channel" && run.botId === chief.id);
      const settledRun = (id: string) => poll(async () => (await channelRuns()).find((run) => run.id === id && !["queued", "running", "waiting"].includes(run.status)), 30_000);

      expect((await desktopApi("PATCH", "/api/config", { telegram: { botToken: TELEGRAM_TOKEN } })).status).toBe(200);
      const pair = await desktopApi("POST", "/api/telegram/pair", { targetBotId: chief.id });
      expect(pair.status).toBe(200);
      arrives(1, `/pair ${pair.body.code}`);
      await expect.poll(async () => (await desktopApi("GET", "/api/telegram/status")).body.paired, { timeout: 15_000, interval: 100 }).toBe(true);
      const bindings = (await desktopApi("POST", "/api/memory/action", { action: "humans" })).body.bindings as Array<{ id: string; revision: number }>;
      expect(bindings).toHaveLength(1);
      expect((await desktopApi("POST", "/api/memory/action", { action: "human-link", bindingId: bindings[0]!.id, expectedRevision: bindings[0]!.revision, as: "owner" })).status).toBe(200);

      // default: the owner's message still asks
      arrives(2, "read my profile");
      const firstRun = await poll(async () => (await channelRuns()).find((run) => run.threadId), 20_000);
      expect(firstRun, `no channel run. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
      const ownerThread = firstRun!.threadId as string;
      expect(ownerThread).not.toBe(chief.threadId);
      expect((await taskState(chief.id, ownerThread)).fullAccess).toBe(true);
      const card = await poll(() => liveCard(ownerThread), 20_000);
      expect(card, "the owner's Telegram message skipped its card by default").not.toBeNull();
      expect(await fullAccessChip(ownerThread)).toBeNull();
      await deny(ownerThread, card.card.requestId);
      expect(await settledRun(firstRun!.id)).not.toBeNull();

      // the option on: the owner's next message runs under Full access
      expect((await desktopApi("PATCH", `/api/bots/${chief.id}`, { fullAccessChannelMessages: true })).status).toBe(200);
      arrives(3, "read it again");
      const secondRun = await poll(async () => (await channelRuns()).find((run) => run.id !== firstRun!.id), 20_000);
      expect(secondRun).not.toBeNull();
      expect(await settledRun(secondRun!.id)).not.toBeNull();
      expect((await channelRuns()).find((run) => run.id === secondRun!.id)?.threadId).toBe(ownerThread);
      expect(await fullAccessChip(ownerThread), `no full-access chip. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
      expect(await liveCard(ownerThread)).toBeNull();

      // the same account relinked to someone else: never Full access
      const relink = (await desktopApi("POST", "/api/memory/action", { action: "humans" })).body.bindings as Array<{ id: string; revision: number }>;
      expect((await desktopApi("POST", "/api/memory/action", { action: "human-link", bindingId: relink[0]!.id, expectedRevision: relink[0]!.revision, as: "person" })).status).toBe(200);
      arrives(4, "read my profile too");
      const thirdRun = await poll(async () => (await channelRuns()).find((run) => ![firstRun!.id, secondRun!.id].includes(run.id) && run.threadId), 20_000);
      expect(thirdRun, `no channel run for the other person. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
      expect(thirdRun!.threadId).not.toBe(ownerThread);
      const otherCard = await poll(() => liveCard(thirdRun!.threadId), 20_000);
      expect(otherCard, "someone else's message ran under the owner's Full access").not.toBeNull();
      expect(await fullAccessChip(thirdRun!.threadId)).toBeNull();
      await desktopApi("POST", `/api/routine-runs/${thirdRun!.id}/cancel`);
    },
    120_000,
  );

  it(
    "a webhook turn still asks with both options on",
    async () => {
      const bot = await makeBot("Hooked channel", "protected");
      expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { fullAccess: true, acknowledgeFullAccess: true, fullAccessChannelMessages: true, fullAccessSetupRequests: true })).status).toBe(200);
      const hook = await desktopApi("POST", "/api/webhooks", { name: "Inbound", prompt: "Handle the event", botId: bot.id, runOn: "ember" });
      expect(hook.status).toBe(201);
      const delivered = await fetch(hook.body.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "ping" }) });
      expect(delivered.status).toBe(202);
      const threadId = await runThread(((await delivered.json()) as { runId: string }).runId);
      expect(threadId).toBeTruthy();
      expect((await taskState(bot.id, threadId!)).fullAccess).toBe(true);
      const card = await poll(() => liveCard(threadId!), 30_000);
      expect(card, "a webhook turn skipped its card with the options on").not.toBeNull();
      await deny(threadId!, card.card.requestId);
    },
    60_000,
  );
});
