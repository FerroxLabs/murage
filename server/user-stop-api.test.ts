// STOP1: pressing Stop on a running turn is not an engine failure. Drives the
// real server over HTTP with the isolated fake Claude CLI (claudeAgent driver)
// and checks the durable state the chat and room views render from: no
// "error:" activity (the red "This request hit a problem" card with Retry),
// the thread is idle again, and memory records the turn as cancelled. A Stop
// is also never success anywhere a finished turn is acted on: no outputs/
// file is published (U-02), queued handoffs are dropped, and ask_bot and
// delegation receipts do not report the stopped turn as a reply or "done".
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let headers: Record<string, string> = {};
let model: string;

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
};
const messages = async (threadId: string) =>
  (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const errorActivities = async (threadId: string) =>
  (await messages(threadId)).filter((m) => m.kind === "activity" && String(m.tool?.name ?? "").startsWith("error:"));
const turnOutcomes = (threadId: string): string[] => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try {
    return db
      .prepare("SELECT outcome FROM memory_sources WHERE thread_id=? AND kind='turn' ORDER BY rowid")
      .all(threadId)
      .map((row) => String(row.outcome));
  } finally {
    db.close();
  }
};
const shellOutputReceipts = (threadId: string): Array<{ stage: string; path_token: string; artifact_id: string | null }> => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try {
    return db
      .prepare("SELECT stage, path_token, artifact_id FROM output_publications WHERE producer='shell-output' AND thread_id=? ORDER BY rowid")
      .all(threadId) as Array<{ stage: string; path_token: string; artifact_id: string | null }>;
  } finally {
    db.close();
  }
};
const delegationReceipt = (taskId: string): { status: string; result?: string } | undefined => {
  const file = join(fixture.info.dataDir, "delegation-receipts.json");
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, "utf8")) as Array<{ id: string; status: string; result?: string }>).find((receipt) => receipt.id === taskId);
};
const isBusy = async (botId: string) =>
  (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId).busy === true;
/** Start a held turn on `bot` and return the bearer its mounted agents
 * server carries, plus the fake CLI's pid (its finish-gate name). */
const holdTurnWithAuthority = async (bot: any, text: string) => {
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
  await promptReachedEngine(text);
  const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
  const token = dump.mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN as string;
  expect(token).toMatch(/^[a-f0-9]{48}$/);
  return { pid: dump.pid as number, internal: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
};

/** The fake writes its dump when it reads the user message: the prompt has
 * reached the engine, so Stop exercises the provider's close path. */
const promptReachedEngine = async (text: string) => {
  await expect
    .poll(() => existsSync(fixture.fixtureDumpPath) && readFileSync(fixture.fixtureDumpPath, "utf8").includes(text), { timeout: 15_000 })
    .toBe(true);
};
const createBot = async (name: string) => {
  const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
};

beforeAll(async () => {
  fixture = await launchVerificationServer({});
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  const engines = (await api("GET", "/api/instances")).body.instances;
  model = engines.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

it("Stop on a direct Claude turn leaves the normal stopped state, not an error card", async () => {
  const bot = await createBot("Stop direct fixture");
  // The held turn first writes outputs/partial.html in its managed workspace.
  const text = "__fixture_hold_authority__ __fixture_write_output__:outputs/partial.html direct stop request";
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
  await promptReachedEngine(text);
  const busy = async () =>
    (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === bot.threadId).busy;
  expect(await busy()).toBe(true);

  expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
  await expect.poll(busy, { timeout: 10_000 }).toBe(false);
  await expect.poll(() => turnOutcomes(bot.threadId).at(-1), { timeout: 10_000 }).toBe("cancelled");
  expect(turnOutcomes(bot.threadId)).not.toContain("failed");
  expect(await errorActivities(bot.threadId)).toEqual([]);

  // U-02: the stopped turn's file keeps a verified receipt and nothing else.
  // The receipt is written in the same synchronous sweep that would post the
  // card, so once it is visible the publication decision has been made.
  expect(existsSync(join(fixture.info.dataDir, "workspaces", bot.id, "threads", bot.threadId, "outputs", "partial.html"))).toBe(true);
  await expect.poll(() => shellOutputReceipts(bot.threadId).length, { timeout: 10_000 }).toBe(1);
  expect(shellOutputReceipts(bot.threadId)).toEqual([{ stage: "retained", path_token: "outputs/partial.html", artifact_id: null }]);
  const published = (await messages(bot.threadId)).filter((m) => (m.artifactIds?.length ?? 0) > 0 || /Saved file/.test(String(m.text ?? "")));
  expect(published).toEqual([]);
}, 60_000);

it("a host stop (this computer switched off for the bot) leaves a stopped notice with the reason, not an error card", async () => {
  // STOP2: the host, not the person, ends the turn. The conversation must
  // say why — as a "stopped:" notice the 1:1 transcript shows even with
  // Tool calls off — and the turn settles exactly like a user Stop.
  const bot = await createBot("Host stop fixture");
  const text = "__fixture_hold_authority__ host stop request";
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
  await promptReachedEngine(text);
  expect(await isBusy(bot.id)).toBe(true);
  // The person points the bot at this computer, then switches it off again
  // while the turn is still running: the switch-off is the host stop.
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "local" })).status).toBe(200);
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off" })).status).toBe(200);

  await expect.poll(() => isBusy(bot.id), { timeout: 10_000 }).toBe(false);
  await expect.poll(() => turnOutcomes(bot.threadId).at(-1), { timeout: 10_000 }).toBe("cancelled");
  expect(turnOutcomes(bot.threadId)).not.toContain("failed");
  expect(await errorActivities(bot.threadId)).toEqual([]);
  const notices = (await messages(bot.threadId)).filter((m) => m.kind === "activity" && String(m.tool?.name ?? "").startsWith("stopped:"));
  expect(notices).toHaveLength(1);
  expect(notices[0].tool).toEqual({ name: "stopped: this computer was switched off for the bot", ok: false });
  expect(notices[0].from).toBeUndefined();
}, 60_000);

it("Stop on a source turn drops the delegation it queued instead of running it", async () => {
  const source = await createBot("Stop drop source");
  const target = await createBot("Stop drop target");
  const turn = await holdTurnWithAuthority(source, "__fixture_hold_authority__ drop source request");
  const queued = await fetch(`${fixture.info.url}/api/internal/delegate-bot`, {
    method: "POST", headers: turn.internal,
    body: JSON.stringify({ fromBotId: source.id, fromThreadId: source.threadId, toBotId: target.id, message: "__fixture_finish_turn__ must never run", depth: 0 }),
  });
  expect(queued.status).toBe(200);
  const { taskId } = await queued.json() as { taskId: string };

  expect((await api("POST", `/api/bots/${source.id}/interrupt`, { threadId: source.threadId })).status).toBe(200);
  await expect.poll(() => isBusy(source.id), { timeout: 10_000 }).toBe(false);
  await expect.poll(() => delegationReceipt(taskId)?.status, { timeout: 10_000 }).toBe("dropped");
  expect(await isBusy(target.id)).toBe(false);
  expect((await messages(target.threadId)).filter((m) => /must never run/.test(String(m.text ?? "")))).toEqual([]);
}, 60_000);

it("ask_bot to a peer whose turn is stopped reports the stop, not a reply", async () => {
  const source = await createBot("Stop ask source");
  const target = await createBot("Stop ask target");
  const turn = await holdTurnWithAuthority(source, "__fixture_hold_authority__ ask source request");
  rmSync(fixture.fixtureDumpPath, { force: true });
  const targetText = "__fixture_hold_authority__ ask target request";
  const asked = fetch(`${fixture.info.url}/api/internal/ask-bot`, {
    method: "POST", headers: turn.internal,
    body: JSON.stringify({ fromBotId: source.id, fromThreadId: source.threadId, toBotId: target.id, message: targetText, depth: 0 }),
  });
  await promptReachedEngine(targetText);
  expect(await isBusy(target.id)).toBe(true);

  expect((await api("POST", `/api/bots/${target.id}/interrupt`, { threadId: target.threadId })).status).toBe(200);
  const response = await asked;
  expect(response.status).toBe(200);
  const body = await response.json() as { text: string };
  expect(body.text).toBe("(the bot's turn was stopped before it finished)");
  await api("POST", `/api/bots/${source.id}/interrupt`, { threadId: source.threadId });
}, 60_000);

it("a delegated turn that is stopped leaves a stopped receipt, not done", async () => {
  const source = await createBot("Stop delegation source");
  const target = await createBot("Stop delegation target");
  const turn = await holdTurnWithAuthority(source, "__fixture_hold_authority__ delegation source request");
  const targetText = "__fixture_hold_authority__ delegated target request";
  const queued = await fetch(`${fixture.info.url}/api/internal/delegate-bot`, {
    method: "POST", headers: turn.internal,
    body: JSON.stringify({ fromBotId: source.id, fromThreadId: source.threadId, toBotId: target.id, message: targetText, depth: 0 }),
  });
  expect(queued.status).toBe(200);
  const { taskId } = await queued.json() as { taskId: string };
  // The source finishes naturally: that is what drains its queued handoff.
  rmSync(fixture.fixtureDumpPath, { force: true });
  writeFileSync(join(fixture.fixtureFinishGateDir, String(turn.pid)), "finish");
  await promptReachedEngine(targetText);
  await expect.poll(() => isBusy(target.id), { timeout: 10_000 }).toBe(true);

  expect((await api("POST", `/api/bots/${target.id}/interrupt`, { threadId: target.threadId })).status).toBe(200);
  await expect.poll(() => delegationReceipt(taskId), { timeout: 10_000 }).toMatchObject({
    status: "failed",
    result: "Delegated turn was stopped before it finished",
  });
  const sourceMessages = await messages(source.threadId);
  expect(sourceMessages.some((m) => m.kind === "activity" && m.tool?.name === `Delegation to @${target.name} was stopped before it finished`)).toBe(true);
  expect(sourceMessages.filter((m) => /replied to the delegated task|completed without a text reply/.test(String(m.text ?? m.tool?.name ?? "")))).toEqual([]);
  expect(await errorActivities(target.threadId)).toEqual([]);
}, 60_000);

it("Stop on a Claude turn in a room leaves the room idle with no error chip", async () => {
  const lead = await createBot("Stop room lead");
  const other = await createBot("Stop room member");
  const room = (await api("POST", "/api/groups", {
    name: "Stop room fixture",
    memberIds: [lead.id, other.id],
    setup: { bulletin: "Synthetic stop fixture", defaultResponder: { kind: "member", botId: lead.id } },
  })).body.group;
  const text = "__fixture_hold_authority__ room stop request";
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await api("POST", `/api/groups/${room.id}/messages`, { text })).status).toBe(202);
  await promptReachedEngine(text);
  const roomState = async () => (await api("GET", "/api/bots?messages=0")).body.groups.find((g: any) => g.id === room.id);
  expect((await roomState()).busyBotId).toBe(lead.id);

  expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
  await expect.poll(async () => (await roomState()).busyBotId ?? null, { timeout: 10_000 }).toBe(null);
  await expect.poll(() => turnOutcomes(room.threadId).at(-1), { timeout: 10_000 }).toBe("cancelled");
  expect(turnOutcomes(room.threadId)).not.toContain("failed");
  expect(await errorActivities(room.threadId)).toEqual([]);
}, 60_000);
