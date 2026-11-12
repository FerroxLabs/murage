import { fixturePlatformEnv, stopFixtureServer } from "./testing/platform-fixtures.ts";
// NOLIMITS-MEANS-IT section 2, real starts: a bot at No limits, a fake engine asking for a key rule that is not a gate
// file, over real HTTP. Proven owner work, including a routine, runs with no card. Unproven starts and rooms
// keep their cards (RULING-R3 R3). Rows that need a live peer, a channel or a project card are the packaged
// rig's (rel1013/rig/nl1013-means-it-rows.mjs); their start conditions are pinned one by one in owner-started.test.ts.
//
// HEADLESS ONLY: the data directory is a throwaway temp HOME and the port is probed from the fixture band.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestHome, removeTempDir } from "./testing/cleanup.ts";
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
// Binding design rev 8 §3.9: the held Windows gate row reaches the No limits finalizer.
const GATE_READ_WIN = "cmd /c type ~/.ssh/config";
const CHIP = "Approved 1 step (No limits)";

let port: number;
let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let stderr = "";
let stdout = "";
let queueGate="";

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

async function makeBot(name: string, instanceId = "keys", level: "task" | "bot" | "ask" = "task") {
  const created = await desktopApi("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-model" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  if(level === "ask"){
    expect((await desktopApi("PATCH",`/api/bots/${bot.id}`,{settingsScope:"defaults",autoApprove:false,fullAccess:false,noLimits:false})).status).toBe(200);
    expect(await botState(bot.id)).toMatchObject({autoApprove:false,fullAccess:false,noLimits:false,permissionExplicit:true});
    return bot;
  }
  const raised = level === "bot"
    ? await raiseLevel(desktopApi, bot.id, { noLimits: true, acknowledgeNoLimits: true })
    : await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { noLimits: true, acknowledgeNoLimits: true });
  expect(raised.status).toBe(200);
  return bot;
}

async function startServer() {
  child = spawn(process.execPath, ["--import", IDLE_LOAD_PRELOAD, "--import", SETUP_HOLD_PRELOAD, "--import", "data:text/javascript,globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;", join(SERVER_DIR, "index.ts")], {
    windowsHide: true,
    cwd: join(SERVER_DIR, ".."),
    // S4 power: the fake ACP child uses the existing test-process seam.
    env: { ...fixturePlatformEnv(),
      NODE_ENV: "test",
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
      MURAGE_TEST_SETUP_HOLD: join(home, "setup-hold"),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
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

describe("NOLIMITS-MEANS-IT real starts", () => {
  beforeAll(async () => {
    port = await freePortBlock([0, 1], 18_999, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    chmodSync(FAKE_CLAUDE, 0o755);
    home = makeTestHome("murage-owner-started-");
    queueGate=join(home,"queue-session-gate");
    expect(() => assertSafeToWipe(home)).not.toThrow();
    mkdirSync(join(home, ".murage"), { recursive: true });
    // FAKE_ACP_TOOL_KIND think: the fake's scripted tool row is a local one, so the owner's turn is a clean turn (an unknown
    // tool kind marks the turn and its session, M2 / M5b)
    const engine = (driver: string, command: string) => ({ driver, environment: { FAKE_ACP_MODE: "permission",FAKE_ACP_PERMISSION_SESSION:"1", FAKE_ACP_MCP_READY:"1",FAKE_ACP_MCP_READY_METHOD:driver === "grokAgent" ? "_x.ai/mcp_initialized" : "_fuigo/mcp_initialized", FAKE_ACP_TOOL_KIND: "think", FAKE_ACP_PERMISSION_COMMAND: command, ...(driver === "customAcp" ? { FAKE_ACP_MODELS: "fake-model" } : {}) }, config: { cli: FAKE_CLI, fullAuto: false } });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      instances: {
        keys: engine("grokAgent", KEY_READ), gate: engine("grokAgent", GATE_READ), queued: { ...engine("customAcp",KEY_READ),environment:{...engine("customAcp",KEY_READ).environment,FAKE_ACP_SESSION_NEW_GATE:queueGate}},
        // S1 queues lines while a turn runs, so it needs an engine with no steer (Grok and Fuigo take them into the running turn)
        // that Murage sees in full (v1 V7: customAcp is not, so every one of its turns is marked and its batch rightly cards)
        queuedSeen:{...engine("geminiAgent",KEY_READ),environment:{...engine("geminiAgent",KEY_READ).environment,FAKE_ACP_SESSION_NEW_GATE:queueGate}}, queuedCursor:{...engine("cursorAgent",KEY_READ),environment:{...engine("cursorAgent",KEY_READ).environment,FAKE_ACP_SESSION_NEW_GATE:queueGate}},
        gateWin: engine("grokAgent", GATE_READ_WIN),
        // no FAKE_ACP_TOOL_KIND: the scripted tool row is a kindless (outside) tool, so the owner's turn is a marked turn (M2)
        gateMarked: { ...engine("grokAgent", GATE_READ), environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: GATE_READ } },
        late: { ...engine("grokAgent", KEY_READ), environment: { FAKE_ACP_MODE: "permission",FAKE_ACP_PERMISSION_SESSION:"1", FAKE_ACP_MCP_READY:"1",FAKE_ACP_MCP_READY_METHOD:"_x.ai/mcp_initialized", FAKE_ACP_TOOL_KIND: "think", FAKE_ACP_PERMISSION_COMMAND: KEY_READ, FAKE_ACP_SESSION_NEW_GATE: join(home, "late-gate") } },
        setup: { driver: "claudeAgent", environment: { FAKE_CLAUDE_PERM_TOOL: "Bash", FAKE_CLAUDE_PERM_INPUT: JSON.stringify({ command: KEY_READ }) }, config: { cli: FAKE_CLAUDE } },
      },
    }));
    await startServer();
  }, 45_000);

  afterAll(async () => {
    await stopFixtureServer(child);
    await removeTempDir(home);
  });

  it("the owner's new line in a direct chat runs with no card, on the engine's own turn id", async () => {
    const bot = await makeBot("Owner");
    expect((await send(bot.id, bot.threadId, "read it")).status).toBe(202);
    expect(await waitIdle(bot.id, bot.threadId), `turn never finished. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    expect(await cards(bot.threadId)).toHaveLength(0);
    expect(await chip(bot.threadId), JSON.stringify({ stderr, stdout, messages: await threadMessages(bot.threadId) })).not.toBeNull();
    // SABLE-LIVE: the log says Murage answered, never that the owner did.
    const id8 = bot.id.slice(0, 8);
    expect(stdout).toMatch(new RegExp(`approvals: resolved bot=${id8}\\S* request=\\S+ behavior=allow source=auto`));
    expect(stdout).not.toMatch(new RegExp(`approvals: resolved bot=${id8}\\S* request=\\S+ behavior=allow source=user`));
  }, 60_000);

  // Binding design rev 8 §3.9: clean gate calls run directly; marked calls retain the gate row through the finalizer.
  it("R5 a gate file on the owner's clean line runs with source no-limits", async () => {
    const bot = await makeBot("Gate", "gate");
    expect((await send(bot.id, bot.threadId, "read it")).status).toBe(202);
    expect(await waitIdle(bot.id, bot.threadId), `turn never finished. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    expect(await cards(bot.threadId)).toHaveLength(0);
    expect(await chip(bot.threadId)).not.toBeNull();
    const held = await poll(async () => (await decisions(bot.threadId)).find((r) => r.decision === "auto-approved") ?? null);
    expect(held, "no auto-approved decision was logged").not.toBeNull();
    expect(held).toMatchObject({source:"no-limits"});expect(held.rule).toBeUndefined();
  }, 60_000);

  async function expectFinalizedGate(bot: { id: string; threadId: string }) {
    expect(await waitIdle(bot.id, bot.threadId), `turn never finished. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    expect(await cards(bot.threadId)).toHaveLength(0);
    expect(await chip(bot.threadId)).not.toBeNull();
    const held = await poll(async () => (await decisions(bot.threadId)).find(r => r.decision === "auto-approved") ?? null);
    // Persisted decisions retain the fixed rule family; the value-free approval line retains its reason and row.
    expect(held).toMatchObject({source:"no-limits"});expect(held.rule).toBeUndefined();
    expect((await decisions(bot.threadId)).filter(row=>row.decision==="card-shown")).toHaveLength(0);
  }

  it("3.9: a gate file on a marked owner turn runs through the gate finalizer", async () => {
    const bot = await makeBot("Gate marked", "gateMarked");
    // The kindless tool marks this turn; the finalizer must still record the original gate row.
    expect((await send(bot.id, bot.threadId, "read it")).status).toBe(202);
    await expectFinalizedGate(bot);
  }, 60_000);

  it("3.9: a gate file named through cmd runs through the owner's gate finalizer", async () => {
    const bot = await makeBot("Gate cmd", "gateWin");
    expect((await send(bot.id, bot.threadId, "read it")).status).toBe(202);
    await expectFinalizedGate(bot);
  }, 60_000);

  it("C7 an unproven send on a persisted owner-only thread still runs wipe-only",async()=>{
    const bot=await makeBot("Unproven owner");
    expect((await sendUnproven(bot.id,bot.threadId,"read it")).status).toBe(202);
    expect(await waitIdle(bot.id,bot.threadId),stderr.slice(-1500)).not.toBeNull();
    expect(await cards(bot.threadId)).toHaveLength(0);expect(await chip(bot.threadId)).not.toBeNull();
  },60000);

  it.each(["unlimited","ask"] as const)("R1 a webhook at %s follows the bot level", async level => {
    const bot = await makeBot("Hooked "+level, "keys", level==="ask"?"ask":"bot");
    const hook = await desktopApi("POST", "/api/webhooks", { name: "Inbound", prompt: "Handle the event", botId: bot.id, runOn: "ember" });
    expect(hook.status).toBe(201);
    const delivered = await fetch(hook.body.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "ping" }) });
    expect(delivered.status).toBe(202);
    const { runId } = await delivered.json() as { runId: string };
    const threadId = await poll(async () => ((await api("GET", "/api/routines")).body.runs ?? []).find((r: { id: string }) => r.id === runId)?.threadId ?? null);
    expect(threadId).toBeTruthy();
    if(level==='ask'){
      const card=await poll(()=>liveCard(threadId!),30000);expect(card,JSON.stringify({bot:await botState(bot.id),messages:await threadMessages(threadId!)})).not.toBeNull();await deny(threadId!,card.card.requestId);
    }else{
      expect(await poll(()=>chip(threadId!)),stderr.slice(-1500)).not.toBeNull();expect(await cards(threadId!)).toHaveLength(0);
    }
  }, 60_000);

  it("an owner-started routine runs with the No limits chip", async () => {
    const bot = await makeBot("Scheduled", "keys", "bot");
    const routine = await desktopApi("POST", "/api/routines", { name: "Nightly", prompt: "Read it", botId: bot.id, runOn: "ember", schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 }, enabled: false });
    expect(routine.status).toBe(201);
    const started = await desktopApi("POST", `/api/routines/${routine.body.routine.id}/run`);
    expect(started.status).toBe(201);
    const threadId = await poll(async () => ((await api("GET", "/api/routines")).body.runs ?? []).find((r: { id: string }) => r.id === started.body.run.id)?.threadId ?? null);
    expect(threadId).toBeTruthy();
    // RULING-R3 R3 and no-limits-do-everything-1019.test.ts:128–136:
    // a proven owner's routine runs at No limits; rooms still keep their cards.
    expect(await poll(() => chip(threadId!)), "routine did not record its approval").not.toBeNull();
    const completed = await poll(async () => ((await api("GET", "/api/routines")).body.runs ?? [])
      .find((run: { id: string; status: string }) => run.id === started.body.run.id && run.status === "completed") ?? null);
    expect(completed, "routine did not finish its approved step").not.toBeNull();
    expect(await cards(threadId!)).toHaveLength(0);
    expect((await decisions(threadId!)).some(row => row.source === "no-limits")).toBe(true);
  }, 60_000);

  it("R1 an owner room turn on an explicitly No limits bot runs without a card", async () => {
    const member = await makeBot("Room member", "keys", "bot");
    const room = (await desktopApi("POST", "/api/groups", { name: "Room", memberIds: [member.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: member.id } } })).body.group;
    expect((await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "read it", sendId: `room-${Date.now()}-padding-padding` })).status).toBe(202);
    expect(await poll(()=>chip(room.threadId),30000),stderr.slice(-1500)).not.toBeNull();
    expect(await cards(room.threadId)).toHaveLength(0);
  }, 60_000);

  /** A not-proven turn holds the thread at its card while `queue` lines wait, then is answered so they drain. */
  async function drained(name: string, queue: (bot: { id: string; threadId: string }) => Promise<void>, instanceId = "queuedSeen") {
    const bot = await makeBot(name, instanceId);
    try{unlinkSync(queueGate);}catch{}
    try{unlinkSync(queueGate+'.waiting');}catch{}
    expect((await send(bot.id,bot.threadId,"hold the fake session")).status).toBe(202);
    expect(await poll(async()=>existsSync(queueGate+'.waiting')?true:null),stderr.slice(-1500)).toBe(true);
    await queue(bot);
    writeFileSync(queueGate,'release the fake session');
    return bot;
  }

  it("S1: a batch of the owner's own lines runs with no card", async () => {
    const bot = await drained("Queued owner", async ({ id, threadId }) => {
      expect((await send(id, threadId, "read it")).status).toBe(202);
      expect((await send(id, threadId, "and this")).status).toBe(202);
    });
    expect(await poll(() => chip(bot.threadId)), `the queued turn raised a card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    await waitIdle(bot.id, bot.threadId);
    expect(await cards(bot.threadId)).toHaveLength(0);
  }, 60_000);

  it("S1 on Cursor: a batch of the owner's own lines runs with no card", async () => {
    const bot = await drained("Queued cursor", async ({ id, threadId }) => {
      expect((await send(id, threadId, "read it")).status).toBe(202);
      expect((await send(id, threadId, "and this")).status).toBe(202);
    }, "queuedCursor");
    expect(await poll(() => chip(bot.threadId)), `the queued turn raised a card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    await waitIdle(bot.id, bot.threadId);
    expect(await cards(bot.threadId)).toHaveLength(0);
  }, 60_000);

  // FORMER GAP (closed by the merge): v1 V7 marks every turn of an engine Murage does not see in full (customAcp), and
  // the owner's batch after it carries that turn (`earlier turn`), so a customAcp owner on No limits gets a card on every line
  // after the first. That is a product bug, not the wanted behaviour: this row states the wanted behaviour and is expected to
  // pass now that the fix has landed.
  it("KNOWN GAP: on an engine not seen in full (customAcp) the owner's batch should still run with no card", async () => {
    const bot = await drained("Queued unseen", async ({ id, threadId }) => {
      expect((await send(id, threadId, "read it")).status).toBe(202);
      expect((await send(id, threadId, "and this")).status).toBe(202);
    }, "queued");
    expect(await poll(() => chip(bot.threadId), 15_000), "the owner's batch carded (outside-turn, earlier turn)").not.toBeNull();
  }, 60_000);

  it("C7 S1 a persisted owner-only batch does not re-card an unproven queued line", async () => {
    const bot = await drained("Queued mixed", async ({ id, threadId }) => {
      expect((await send(id, threadId, "read it")).status).toBe(202);
      expect((await sendUnproven(id, threadId, "and this")).status).toBe(202);
    });
    expect(await waitIdle(bot.id,bot.threadId),stderr.slice(-1500)).not.toBeNull();
    expect(await cards(bot.threadId)).toHaveLength(0);expect(await chip(bot.threadId)).not.toBeNull();
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

  it("R5 C13 a restart with old terms keeps No limits wipe-only, with one desktop terms door", async () => {
    const bot = await makeBot("Upgraded");
    expect((await desktopApi("GET", "/api/config")).body.noLimitsTerms).toEqual({ accepted: true });
    expect((await desktopApi("PATCH", "/api/config", { noLimitsTermsVersion: 2 })).status).toBe(400);
    // an install from before these terms: same bot, same level, the old version on disk
    await stopFixtureServer(child);
    const path = join(home, ".murage", "config.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), noLimitsTermsVersion: 1 }));
    await startServer();
    expect((await desktopApi("GET", "/api/config")).body.noLimitsTerms).toEqual({ accepted: false });
    expect((await send(bot.id, bot.threadId, "read it")).status).toBe(202);
    expect(await waitIdle(bot.id,bot.threadId),stderr.slice(-1500)).not.toBeNull();
    expect(await cards(bot.threadId)).toHaveLength(0);expect(await chip(bot.threadId)).not.toBeNull();

    expect((await api("POST", "/api/no-limits/terms", { acknowledgeNoLimits: true })).status).toBe(404);
    expect((await desktopApi("POST", "/api/no-limits/terms", {})).status).toBe(400);
    expect((await desktopApi("POST", "/api/no-limits/terms", { acknowledgeNoLimits: true })).body).toEqual({ noLimitsTerms: { accepted: true } });
    expect(JSON.parse(readFileSync(path, "utf8")).noLimitsTermsVersion).toBe(2);
    expect((await send(bot.id, bot.threadId, "read it again")).status).toBe(202);
    expect(await poll(() => chip(bot.threadId)), "the accepted terms did not take").not.toBeNull();
    await waitIdle(bot.id, bot.threadId);
    expect(await cards(bot.threadId)).toHaveLength(0);
  }, 120_000);
});
