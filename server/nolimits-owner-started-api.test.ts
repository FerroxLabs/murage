// NOLIMITS-MEANS-IT section 2, real starts: a bot at No limits, a fake engine asking for a key rule that is not a gate
// file, over real HTTP. What decides is the start that reached it: the owner's own line runs with no card, and every
// other start keeps the card it has today. Rows that need a live peer, a channel or a project card are the packaged
// rig's (rel1013/rig/nl1013-means-it-rows.mjs); their start conditions are pinned one by one in owner-started.test.ts.
//
// HEADLESS ONLY: the data directory is a throwaway temp HOME and the port is probed from the fixture band.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestHome, removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { assertSafeToWipe } from "./testing/safe-wipe.mjs";
import { freePortBlock } from "./testing/ports.ts";
import { raiseLevel } from "./testing/raise-level.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const IDLE_LOAD_PRELOAD = pathToFileURL(join(SERVER_DIR, "testing", "idle-load-preload.mjs")).href;
const SETUP_HOLD_PRELOAD = pathToFileURL(join(SERVER_DIR, "testing", "turn-setup-hold-preload.mjs")).href;
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const KEY_READ = "cat .env";
const GATE_READ = "cat ~/.ssh/config";
// ruling 3 (11-06): a text naming cmd or PowerShell is a Windows shell call, which keeps today's gate card on any turn
const GATE_READ_WIN = "cmd /c type ~/.ssh/config";
const CHIP = "Approved 1 step (No limits)";

let port: number;
let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let stderr = "";
let stdout = "";

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
const chip = async (threadId: string) => (await threadMessages(threadId)).find((m) => m.tool?.name === CHIP) ?? null;
const cards = async (threadId: string) => (await threadMessages(threadId)).filter((m) => m.kind === "options" && m.card?.requestId);
const decisions = async (threadId: string) => (((await desktopApi("GET", "/api/decisions?limit=500")).body?.decisions ?? []) as any[]).filter((r) => r.threadId === threadId);

async function poll<T>(read: () => Promise<T | null>, ms = 20_000): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}
const waitIdle = (botId: string, threadId: string) => poll(async () => {
  const task = await taskState(botId, threadId);
  return task && !task.busy ? task : null;
});
const deny = async (threadId: string, requestId: string) => {
  expect((await desktopApi("POST", `/api/threads/${threadId}/respond`, { requestId, behavior: "deny" })).status).toBe(200);
};
const send = (botId: string, threadId: string, text: string) => desktopApi("POST", `/api/bots/${botId}/messages`, { threadId, text });
const sendUnproven = (botId: string, threadId: string, text: string) => api("POST", `/api/bots/${botId}/messages`, { threadId, text });

async function makeBot(name: string, instanceId = "keys", level: "task" | "bot" = "task") {
  const created = await desktopApi("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-model" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const raised = level === "bot"
    ? await raiseLevel(desktopApi, bot.id, { noLimits: true, acknowledgeNoLimits: true })
    : await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { noLimits: true, acknowledgeNoLimits: true });
  expect(raised.status).toBe(200);
  return bot;
}

async function startServer() {
  child = spawn(process.execPath, ["--import", IDLE_LOAD_PRELOAD, "--import", SETUP_HOLD_PRELOAD, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
      MURAGE_TEST_SETUP_HOLD: join(home, "setup-hold"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));
  child.stdout!.on("data", (c) => (stdout += c));
  const deadline = Date.now() + 25_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const proof = await api("GET", "/api/desktop-secret");
  expect(proof.status).toBe(200);
  desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
}

describe.skipIf(process.platform === "win32")("NOLIMITS-MEANS-IT real starts", () => {
  beforeAll(async () => {
    port = await freePortBlock([0, 1], 18_999, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    chmodSync(FAKE_CLAUDE, 0o755);
    home = makeTestHome("murage-owner-started-");
    expect(() => assertSafeToWipe(home)).not.toThrow();
    mkdirSync(join(home, ".murage"), { recursive: true });
    // FAKE_ACP_TOOL_KIND think: the fake's scripted tool row is a local one, so the owner's turn is a clean turn (an unknown
    // tool kind marks the turn and its session, M2 / M5b)
    const engine = (driver: string, command: string) => ({ driver, environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_TOOL_KIND: "think", FAKE_ACP_PERMISSION_COMMAND: command }, config: { cli: FAKE_CLI, fullAuto: false } });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      instances: {
        keys: engine("grokAgent", KEY_READ), gate: engine("grokAgent", GATE_READ), queued: engine("customAcp", KEY_READ),
        // S1 queues lines while a turn runs, so it needs an engine with no steer (Grok and Fuigo take them into the running turn)
        // that Murage sees in full (v1 V7: customAcp is not, so every one of its turns is marked and its batch rightly cards)
        queuedSeen: engine("geminiAgent", KEY_READ), queuedCursor: engine("cursorAgent", KEY_READ),
        gateWin: engine("grokAgent", GATE_READ_WIN),
        // no FAKE_ACP_TOOL_KIND: the scripted tool row is a kindless (outside) tool, so the owner's turn is a marked turn (M2)
        gateMarked: { ...engine("grokAgent", GATE_READ), environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: GATE_READ } },
        late: { ...engine("grokAgent", KEY_READ), environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_TOOL_KIND: "think", FAKE_ACP_PERMISSION_COMMAND: KEY_READ, FAKE_ACP_SESSION_NEW_GATE: join(home, "late-gate") } },
        setup: { driver: "claudeAgent", environment: { FAKE_CLAUDE_PERM_TOOL: "Bash", FAKE_CLAUDE_PERM_INPUT: JSON.stringify({ command: KEY_READ }) }, config: { cli: FAKE_CLAUDE } },
      },
    }));
    await startServer();
  }, 45_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("the owner's new line in a direct chat runs with no card, on the engine's own turn id", async () => {
    const bot = await makeBot("Owner");
    expect((await send(bot.id, bot.threadId, "read it")).status).toBe(202);
    expect(await waitIdle(bot.id, bot.threadId), `turn never finished. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    expect(await cards(bot.threadId)).toHaveLength(0);
    expect(await chip(bot.threadId)).not.toBeNull();
    // SABLE-LIVE: the log says Murage answered, never that the owner did.
    const id8 = bot.id.slice(0, 8);
    expect(stdout).toMatch(new RegExp(`approvals: resolved bot=${id8}\\S* request=\\S+ behavior=allow source=auto`));
    expect(stdout).not.toMatch(new RegExp(`approvals: resolved bot=${id8}\\S* request=\\S+ behavior=allow source=user`));
  }, 60_000);

  // design 2.3: on a clean owner turn a gate file runs with no card and is recorded by its row; a marked turn keeps the card
  it("2.3: a gate file on the owner's clean line runs with no card and is logged held=gate:<row>", async () => {
    const bot = await makeBot("Gate", "gate");
    expect((await send(bot.id, bot.threadId, "read it")).status).toBe(202);
    expect(await waitIdle(bot.id, bot.threadId), `turn never finished. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    expect(await cards(bot.threadId)).toHaveLength(0);
    expect(await chip(bot.threadId)).not.toBeNull();
    const held = await poll(async () => (await decisions(bot.threadId)).find((r) => r.decision === "auto-approved") ?? null);
    expect(held, "no auto-approved decision was logged").not.toBeNull();
    expect(held.rule).toMatch(/^held=gate:[\w-]+$/);
  }, 60_000);

  it("2.3: a gate file on a marked owner turn still cards", async () => {
    const bot = await makeBot("Gate marked", "gateMarked");
    // the engine's kindless (outside) tool row marks the turn, so the gate file keeps the key guard's card
    expect((await send(bot.id, bot.threadId, "read it")).status).toBe(202);
    const card = await poll(() => liveCard(bot.threadId));
    expect(card, "a gate file on a marked turn ran with no card").not.toBeNull();
    expect(stdout).toMatch(new RegExp(`approvals: asked bot=${bot.id.slice(0, 8)}\\S* [^\\n]* outside=[a-z-]+`));
    await deny(bot.threadId, card.card.requestId);
    await waitIdle(bot.id, bot.threadId);
  }, 60_000);

  it("ruling 3: a gate file named through cmd keeps its card on the owner's clean line", async () => {
    const bot = await makeBot("Gate cmd", "gateWin");
    expect((await send(bot.id, bot.threadId, "read it")).status).toBe(202);
    const card = await poll(() => liveCard(bot.threadId));
    expect(card, "a Windows shell gate call ran with no card").not.toBeNull();
    await deny(bot.threadId, card.card.requestId);
    await waitIdle(bot.id, bot.threadId);
  }, 60_000);

  it("a send with no proof keeps its card", async () => {
    const bot = await makeBot("Unproven");
    expect((await sendUnproven(bot.id, bot.threadId, "read it")).status).toBe(202);
    const card = await poll(() => liveCard(bot.threadId));
    expect(card, "an unproven send ran with no card").not.toBeNull();
    await deny(bot.threadId, card.card.requestId);
    await waitIdle(bot.id, bot.threadId);
  }, 60_000);

  it("a webhook keeps its card", async () => {
    const bot = await makeBot("Hooked", "keys", "bot");
    const hook = await desktopApi("POST", "/api/webhooks", { name: "Inbound", prompt: "Handle the event", botId: bot.id, runOn: "ember" });
    expect(hook.status).toBe(201);
    const delivered = await fetch(hook.body.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "ping" }) });
    expect(delivered.status).toBe(202);
    const { runId } = await delivered.json() as { runId: string };
    const threadId = await poll(async () => ((await api("GET", "/api/routines")).body.runs ?? []).find((r: { id: string }) => r.id === runId)?.threadId ?? null);
    expect(threadId).toBeTruthy();
    const card = await poll(() => liveCard(threadId!), 30_000);
    expect(card, "a webhook ran with no card").not.toBeNull();
    await deny(threadId!, card.card.requestId);
  }, 60_000);

  it("a routine keeps its card", async () => {
    const bot = await makeBot("Scheduled", "keys", "bot");
    const routine = await desktopApi("POST", "/api/routines", { name: "Nightly", prompt: "Read it", botId: bot.id, runOn: "ember", schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 }, enabled: false });
    expect(routine.status).toBe(201);
    const started = await desktopApi("POST", `/api/routines/${routine.body.routine.id}/run`);
    expect(started.status).toBe(201);
    const threadId = await poll(async () => ((await api("GET", "/api/routines")).body.runs ?? []).find((r: { id: string }) => r.id === started.body.run.id)?.threadId ?? null);
    expect(threadId).toBeTruthy();
    const card = await poll(() => liveCard(threadId!), 30_000);
    expect(card, "a routine ran with no card").not.toBeNull();
    await deny(threadId!, card.card.requestId);
  }, 60_000);

  it("a room turn, even the owner's, keeps its card", async () => {
    const member = await makeBot("Room member", "keys", "bot");
    const room = (await desktopApi("POST", "/api/groups", { name: "Room", memberIds: [member.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: member.id } } })).body.group;
    expect((await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "read it", sendId: `room-${Date.now()}-padding-padding` })).status).toBe(202);
    const card = await poll(() => liveCard(room.threadId), 30_000);
    expect(card, "a room turn ran with no card").not.toBeNull();
    await deny(room.threadId, card.card.requestId);
  }, 60_000);

  /** A not-proven turn holds the thread at its card while `queue` lines wait, then is answered so they drain. */
  async function drained(name: string, queue: (bot: { id: string; threadId: string }) => Promise<void>, instanceId = "queuedSeen") {
    const bot = await makeBot(name, instanceId);
    expect((await sendUnproven(bot.id, bot.threadId, "hold the thread")).status).toBe(202);
    const held = await poll(() => liveCard(bot.threadId));
    expect(held, `the first turn raised no card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    await queue(bot);
    await deny(bot.threadId, held.card.requestId);
    return bot;
  }

  it("S1: a batch of the owner's own lines runs with no card", async () => {
    const bot = await drained("Queued owner", async ({ id, threadId }) => {
      expect((await send(id, threadId, "read it")).status).toBe(202);
      expect((await send(id, threadId, "and this")).status).toBe(202);
    });
    expect(await poll(() => chip(bot.threadId)), `the queued turn raised a card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    await waitIdle(bot.id, bot.threadId);
    expect(await cards(bot.threadId)).toHaveLength(1);
  }, 60_000);

  it("S1 on Cursor: a batch of the owner's own lines runs with no card", async () => {
    const bot = await drained("Queued cursor", async ({ id, threadId }) => {
      expect((await send(id, threadId, "read it")).status).toBe(202);
      expect((await send(id, threadId, "and this")).status).toBe(202);
    }, "queuedCursor");
    expect(await poll(() => chip(bot.threadId)), `the queued turn raised a card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    await waitIdle(bot.id, bot.threadId);
    expect(await cards(bot.threadId)).toHaveLength(1);
  }, 60_000);

  // KNOWN GAP (MurageMain 11-06, fix owed): v1 V7 marks every turn of an engine Murage does not see in full (customAcp), and
  // the owner's batch after it carries that turn (`earlier turn`), so a customAcp owner on No limits gets a card on every line
  // after the first. That is a product bug, not the wanted behaviour: this row states the wanted behaviour and is expected to
  // fail until the fix lands (then drop .fails).
  it.fails("KNOWN GAP: on an engine not seen in full (customAcp) the owner's batch should still run with no card", async () => {
    const bot = await drained("Queued unseen", async ({ id, threadId }) => {
      expect((await send(id, threadId, "read it")).status).toBe(202);
      expect((await send(id, threadId, "and this")).status).toBe(202);
    }, "queued");
    expect(await poll(() => chip(bot.threadId), 15_000), "the owner's batch carded (outside-turn, earlier turn)").not.toBeNull();
  }, 60_000);

  it("S1: one line with no proof keeps the whole batch's card", async () => {
    const bot = await drained("Queued mixed", async ({ id, threadId }) => {
      expect((await send(id, threadId, "read it")).status).toBe(202);
      expect((await sendUnproven(id, threadId, "and this")).status).toBe(202);
    });
    const next = await poll(async () => (await cards(bot.threadId)).find((m) => m.card?.answered === undefined) ?? null);
    expect(next, "a batch with an unproven line ran with no card").not.toBeNull();
    expect(await chip(bot.threadId)).toBeNull();
    await deny(bot.threadId, next.card.requestId);
    await waitIdle(bot.id, bot.threadId);
  }, 60_000);

  it("a redispatch after a late refusal stays the owner's turn: no card", async () => {
    const gate = join(home, "late-gate");
    const bot = await makeBot("Late", "late");
    expect((await send(bot.id, bot.threadId, "read it")).status).toBe(202);
    await poll(async () => (existsSync(`${gate}.waiting`) ? true : null));
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { section: "Revoked while the send waited" })).status).toBe(200);
    writeFileSync(gate, "");
    expect(await poll(async () => (stderr.includes("context revoked at a late submission") ? true : null), 30_000), stderr.slice(-1500)).toBe(true);
    expect(await poll(() => chip(bot.threadId), 60_000)).not.toBeNull();
    expect(await cards(bot.threadId)).toHaveLength(0);
  }, 120_000);

  it("a memory rebuild after a refusal in setup stays the owner's turn: no card", async () => {
    const gate = join(home, "setup-hold");
    const bot = await makeBot("Setup", "setup");
    writeFileSync(`${gate}.arm`, "");
    expect((await send(bot.id, bot.threadId, "read it __fixture_permission_tool__")).status).toBe(202);
    expect(await poll(async () => (existsSync(`${gate}.waiting`) ? true : null)), stderr.slice(-1500)).toBe(true);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { section: "Revoked in setup" })).status).toBe(200);
    writeFileSync(gate, "");
    expect(await poll(async () => (stderr.includes("context revoked during dispatch") ? true : null), 30_000), stderr.slice(-1500)).toBe(true);
    expect(await poll(async () => ((await threadMessages(bot.threadId)).some((m) => /permission: allowed/.test(m.text ?? "")) ? true : null), 60_000), stderr.slice(-1500)).toBe(true);
    expect(await cards(bot.threadId)).toHaveLength(0);
  }, 120_000);

  it("the terms have one door, and an upgrade keeps today's cards until the owner accepts", async () => {
    const bot = await makeBot("Upgraded");
    expect((await desktopApi("GET", "/api/config")).body.noLimitsTerms).toEqual({ accepted: true });
    expect((await desktopApi("PATCH", "/api/config", { noLimitsTermsVersion: 2 })).status).toBe(400);
    // an install from before these terms: same bot, same level, the old version on disk
    await waitForExit(child, { signal: "SIGTERM" });
    const path = join(home, ".murage", "config.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), noLimitsTermsVersion: 1 }));
    await startServer();
    expect((await desktopApi("GET", "/api/config")).body.noLimitsTerms).toEqual({ accepted: false });
    expect((await send(bot.id, bot.threadId, "read it")).status).toBe(202);
    const card = await poll(() => liveCard(bot.threadId));
    expect(card, "a turn ran with no card before the terms were accepted").not.toBeNull();
    await deny(bot.threadId, card.card.requestId);
    await waitIdle(bot.id, bot.threadId);

    expect((await api("POST", "/api/no-limits/terms", { acknowledgeNoLimits: true })).status).toBe(404);
    expect((await desktopApi("POST", "/api/no-limits/terms", {})).status).toBe(400);
    expect((await desktopApi("POST", "/api/no-limits/terms", { acknowledgeNoLimits: true })).body).toEqual({ noLimitsTerms: { accepted: true } });
    expect(JSON.parse(readFileSync(path, "utf8")).noLimitsTermsVersion).toBe(2);
    expect((await send(bot.id, bot.threadId, "read it again")).status).toBe(202);
    expect(await poll(() => chip(bot.threadId)), "the accepted terms did not take").not.toBeNull();
    await waitIdle(bot.id, bot.threadId);
    expect(await cards(bot.threadId)).toHaveLength(1);
  }, 120_000);
});
