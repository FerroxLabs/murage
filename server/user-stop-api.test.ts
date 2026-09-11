// STOP1: pressing Stop on a running turn is not an engine failure. Drives the
// real server over HTTP with the isolated fake Claude CLI (claudeAgent driver)
// and checks the durable state the chat and room views render from: no
// "error:" activity (the red "This request hit a problem" card with Retry),
// the thread is idle again, and memory records the turn as cancelled.
import { existsSync, readFileSync, rmSync } from "node:fs";
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
  const text = "__fixture_hold_authority__ direct stop request";
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
