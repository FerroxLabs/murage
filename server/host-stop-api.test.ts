// STOP2: a turn the HOST stops — here, the model connection the bot's turn
// is using gets turned off — is not the person's Stop and not an engine
// failure. Drives the real server over HTTP with the isolated fake Claude
// CLI, a real Anthropic-preset model connection (fixture key, catalog served
// by an instrumented fetch — no network) and checks the durable state:
//   - the thread carries one "stopped:" notice naming the reason, no
//     "error:" activity, and memory records the turn as cancelled;
//   - a goal member turn stopped this way yields provider_failed, which the
//     run retries exactly once (a retry costs a turn like any other), and
//     the run ends honestly as failed, never completed.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const CONNECTION_STOPPED = "stopped: the model connection it was using was changed or turned off";
let fixture: VerificationServer;
let headers: Record<string, string> = {};
let connection: { id: string; revision: string };

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
const activities = async (threadId: string, prefix: string) =>
  (await messages(threadId)).filter((m) => m.kind === "activity" && String(m.tool?.name ?? "").startsWith(prefix));
const turnOutcomes = (threadId: string): string[] => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try {
    return db.prepare("SELECT outcome FROM memory_sources WHERE thread_id=? AND kind='turn' ORDER BY rowid").all(threadId).map((row) => String(row.outcome));
  } finally {
    db.close();
  }
};
const isBusy = async (botId: string) =>
  (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId).busy === true;
const promptReachedEngine = async (text: string) => {
  await expect
    .poll(() => existsSync(fixture.fixtureDumpPath) && readFileSync(fixture.fixtureDumpPath, "utf8").includes(text), { timeout: 15_000 })
    .toBe(true);
};
/** The bot's turns run through the fixture connection: the same claudeAgent
 * fake CLI, with the Anthropic route injected (ANTHROPIC_BASE_URL/key). */
const createBot = async (name: string) => {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model: "claude-fixture-5", connectionId: connection.id } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
};
const currentConnection = async () =>
  (await api("GET", "/api/provider-connections")).body.connections.find((row: any) => row.id === connection.id);
/** Turn the connection off (a new revision), which stops every turn routed
 * through it; turn it back on afterwards for the next test. A new revision
 * drops the catalog, so re-enabling refreshes it (fixture fetch, no network). */
const setConnectionEnabled = async (enabled: boolean) => {
  const current = await currentConnection();
  const changed = await api("POST", "/api/provider-connections/mutate", { action: "update", id: connection.id, revision: current.revision, enabled });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  if (enabled) expect((await api("POST", `/api/provider-connections/${connection.id}/refresh`, {})).status).toBe(200);
};

beforeAll(async () => {
  fixture = await launchVerificationServer({ ...process.env, MURAGE_MODEL_PROVIDER_CONNECTIONS: "", MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "" }, undefined, { instrumentationSource: `
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = String(input);
      if (url.startsWith("https://api.anthropic.com/v1/models")) {
        if (init?.headers?.["x-api-key"] !== "sk-ant-FAKE_HOST_STOP_KEY_ONLY") throw new Error("Unexpected fixture key");
        return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "claude-fixture-5", display_name: "Fixture", type: "model" }], has_more: false })));
      }
      if (url.startsWith("https://")) throw new Error("External network blocked in host-stop fixture: " + url);
      return originalFetch(input, init);
    };` });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  const created = await api("POST", "/api/provider-connections/mutate", { action: "create", preset: "anthropic", label: "Host stop fixture", key: "sk-ant-FAKE_HOST_STOP_KEY_ONLY" });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  connection = created.body.connections.find((row: any) => row.label === "Host stop fixture");
  const catalog = await api("POST", `/api/provider-connections/${connection.id}/refresh`, {});
  expect(catalog.status).toBe(200);
  expect(catalog.body.models.filter((row: any) => row.chatEligible).map((row: any) => row.id)).toEqual(["claude-fixture-5"]);
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

it("turning the connection off mid-turn stops a direct turn with a reason notice, never an error card", async () => {
  const bot = await createBot("Connection stop direct");
  const text = "__fixture_hold_authority__ connection stop direct request";
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
  await promptReachedEngine(text);
  // the route really was injected into the engine's environment
  const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
  expect(dump.env?.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
  expect(await isBusy(bot.id)).toBe(true);

  await setConnectionEnabled(false);
  try {
    await expect.poll(() => isBusy(bot.id), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => turnOutcomes(bot.threadId).at(-1), { timeout: 10_000 }).toBe("cancelled");
    expect(turnOutcomes(bot.threadId)).not.toContain("failed");
    expect(await activities(bot.threadId, "error:")).toEqual([]);
    const notices = await activities(bot.threadId, "stopped:");
    expect(notices).toHaveLength(1);
    expect(notices[0].tool).toEqual({ name: CONNECTION_STOPPED, ok: false });
    // a 1:1 thread: no sender label on the notice
    expect(notices[0].from).toBeUndefined();
    // the Markdown export spells the notice the way the transcript does,
    // never the raw "stopped:" prefix
    const exported = await fetch(`${fixture.info.url}/api/threads/${bot.threadId}/export`, { headers });
    expect(exported.status).toBe(200);
    const markdown = await exported.text();
    expect(markdown).toContain("> Stopped — the model connection it was using was changed or turned off");
    expect(markdown).not.toContain("stopped:");
  } finally {
    await setConnectionEnabled(true);
  }
}, 60_000);

it("a goal member turn stopped by the host is provider_failed: retried once, then the run fails honestly", async () => {
  const lead = await createBot("Connection stop lead");
  const room = (await api("POST", "/api/groups", {
    name: "Connection stop team",
    memberIds: [lead.id],
    setup: { bulletin: "Synthetic host-stop fixture", defaultResponder: { kind: "member", botId: lead.id } },
  })).body.group;
  const text = "__fixture_hold_authority__ connection stop goal request";
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await api("POST", `/api/groups/${room.id}/messages`, { text, mode: "goal" })).status).toBe(202);
  await promptReachedEngine(text);
  const roomState = async () => {
    const state = (await api("GET", "/api/bots?messages=40")).body;
    const current = state.groups.find((candidate: any) => candidate.id === room.id);
    return { busyBotId: current?.busyBotId ?? null, card: current?.messages.find((message: any) => message.kind === "goal.run")?.goalRun };
  };
  expect((await roomState()).busyBotId).toBe(lead.id);

  await setConnectionEnabled(false);
  try {
    await expect.poll(async () => (await roomState()).card?.status, { timeout: 20_000 }).toBe("failed");
    const { card, busyBotId } = await roomState();
    expect(busyBotId).toBe(null);
    // exactly one retry: the stopped attempt and the retry both claimed a
    // goal turn; the retry could not dispatch on the disabled connection
    expect(card.turnCount).toBe(2);
    expect(await isBusy(lead.id)).toBe(false);
    await expect.poll(() => turnOutcomes(room.threadId).at(0), { timeout: 10_000 }).toBe("cancelled");
    const notices = await activities(room.threadId, "stopped:");
    expect(notices).toHaveLength(1);
    expect(notices[0].tool).toEqual({ name: CONNECTION_STOPPED, ok: false });
    // a room thread: the notice names the member whose turn it was
    expect(notices[0].from).toMatchObject({ botId: lead.id, name: lead.name });
    // the retry's refusal is the run's only error, and it names the cause
    const errors = await activities(room.threadId, "error:");
    expect(errors).toHaveLength(1);
    expect(errors[0].tool.name).toMatch(/disabled or unavailable/);
  } finally {
    await setConnectionEnabled(true);
  }
}, 60_000);
