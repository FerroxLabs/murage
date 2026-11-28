// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { APP_CHILD_CARD_TEXT } from "./app-trigger-zero.ts";
import { AppTriggerStore } from "./app-trigger-store.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "./testing/power-block-test.ts";
import { prepareFixtureRecall } from "./testing/recall-ready-fixture.ts";

let fixture: VerificationServer;
let desktop: Record<string, string>;
let model: string;
const file = (name: string) => join(fixture.info.dataDir, name);
const poll = { timeout: 25_000, interval: 100 };
const call = async (method: string, path: string, body?: unknown, proof = desktop) => {
  const res = await fetch(fixture.info.url + path, {
    method, headers: { ...proof, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
};
const messages = async (threadId: string) => (await call("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as Array<{
  id: string; text?: string; card?: { requestHandle?: string; answered?: string; tool?: string };
}>;
function database<T>(read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file("messages.db"));
  try { db.exec("PRAGMA busy_timeout=1000"); return read(db); }
  finally { db.close(); }
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { env: { NODE_ENV: "test" }, instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
    const fs = await import('node:fs'), path = await import('node:path');
    const dir = process.env.MURAGE_DATA_DIR;
    const file = name => path.join(dir, name);
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
    process.env.FAKE_CLAUDE_PERM_TOOL = 'Write';
    process.env.FAKE_CLAUDE_PERM_INPUT = JSON.stringify({ file_path: file('permission-fixture.txt'), content: 'fixture' });
    fs.writeFileSync(file('permission-fixture.txt'), 'before');
    const { registerHooks } = await import('node:module');
    registerHooks({load(url, context, next) {
      const loaded = next(url, context);
      if (url.endsWith('/server/owner-first.ts')) {
        const source = String(loaded.source);
        const input = 'this.load = options.load ?? systemLoad;';
        if (!source.includes(input)) throw Error('L5H scheduler load input missing');
        return { ...loaded, source: source.replace(input, 'this.load = options.load ?? { overloaded: () => false };') };
      }
      if (!url.endsWith('/server/index.ts')) return loaded;
      let source = String(loaded.source);
      const fixtureRoute = '    // GET/PUT /api/bots/:id/access lives in server/settings/access-routes.ts';
      const toolReady = "      const executingRequestId = turnRequestByGeneration.get(internalClaim.generation);";
      const interrupt = 'const stopCall = Promise.resolve(registry.get(selected.modelSelection.instanceId)?.adapter.interruptTurn(threadId));';
      const stopReceipt = "    confirmedStopGenerations.add(stoppedGeneration);";
      if (![fixtureRoute, toolReady, interrupt, stopReceipt].every(anchor => source.includes(anchor))) throw Error('L5H verification anchor missing');
      // Fixture inputs and scheduling barriers. Leave dispatch, close receipts, guard, and message writes on their production paths.
      source = source.replace(fixtureRoute, \`
        if (path === "/api/l5h-fixture/move" && method === "POST" && requestSurface(req.headers, url.searchParams) === "desktop") {
          const { botId, threadId } = await readBody(req);
          store.patchTask(botId, threadId, { resultsRoute: "moved-marker" });
          return json(res, 200, { moved: true });
        }
      \` + fixtureRoute);
      source = source.replace(toolReady, toolReady + \`
        if (path === "/api/internal/create-bot" || path === "/api/internal/ask-bot" || path === "/api/internal/delegate-bot") {
          const fs = await import("node:fs"), path = await import("node:path");
          const dir = process.env.MURAGE_DATA_DIR!;
          const name = path.join(dir, internalClaim.threadId);
          fs.writeFileSync(name + ".child-at-guard", "");
          // The turn's own tool call reaches this guard ~10 s before the test has its port; a 10 s hold expired at the same moment the Stop confirmed (race), so hold until the test releases it.
          for (let i = 0; i < 4000 && !fs.existsSync(name + ".child-go"); i++) await new Promise(resolve => setTimeout(resolve, 20));
        }
      \`);
      source = source.replace(interrupt, \`
        const stopCall = (async () => {
          const fs = await import("node:fs"), path = await import("node:path");
          const name = path.join(process.env.MURAGE_DATA_DIR!, threadId);
          if (fs.existsSync(name + ".child-at-guard")) {
            fs.writeFileSync(name + ".stop-waiting", "");
            for (let i = 0; i < 500 && !fs.existsSync(name + ".stop-go"); i++) await new Promise(resolve => setTimeout(resolve, 20));
          }
          return registry.get(selected.modelSelection.instanceId)?.adapter.interruptTurn(threadId);
        })();
      \`);
      source = source.replace(stopReceipt, stopReceipt + \`
        {
          const fs = await import("node:fs"), path = await import("node:path");
          fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR!, threadId + ".stop-confirmed"), "");
        }
      \`);
      return { ...loaded, source };
    }});
    await import(${JSON.stringify(new URL("./testing/recall-ready-preload.mjs", import.meta.url).href)});
  ` });
  const proof = (await call("GET", "/api/desktop-secret", undefined, {})).body;
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  model = (await call("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "verification").models.options[0].id;
}, 140_000);
afterAll(async () => { await fixture?.close(); });

async function makeBot(name: string) {
  const made = await call("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } });
  expect(made.status).toBe(201);
  const bot: { id: string; threadId: string } = made.body.bot;
  expect((await call("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false, autoReview: "off" })).status).toBe(200);
  return bot;
}
const send = (botId: string, threadId: string, text: string) => call("POST", `/api/bots/${botId}/messages`, { threadId, text });
const tag = (threadId: string, event: string) => file(`${threadId}.${event}`);

it("W9 the owner recreates a moved webhook Results chat and the held card goes there once", async () => {
  const bot = await makeBot("Webhook Results");
  const created = await call("POST", "/api/webhooks", { name: "Check reports", prompt: "Summarize the report", botId: bot.id });
  expect(created.status).toBe(201);
  const hook = created.body.webhook.id as string;
  type Route = { thread_id: string; route_epoch: number };
  const route = () => database(db => db.prepare("SELECT thread_id, route_epoch FROM event_result_routes WHERE route_key=?")
    .get(JSON.stringify(["desktop", "owner", "webhook", hook])) as Route | undefined);
  const run = async () => {
    const response = await call("POST", `/api/webhooks/${hook}/test`, { event: "fixture report" });
    expect(response.status).toBe(202);
    return response.body.runId as string;
  };
  const runState = async (id: string) => {
    const row = (await call("GET", "/api/routines")).body.runs.find((entry: any) => entry.id === id);
    return row ? { status: row.status, eventResult: row.eventResult } : null;
  };
  const first = await run();
  await expect.poll(() => runState(first), poll).toMatchObject({ eventResult: { state: "done", reason: "written" } });
  const before = route()!;
  expect((await call("POST", "/api/l5h-fixture/move", { botId: bot.id, threadId: before.thread_id })).status).toBe(200);
  const held = await run();
  await expect.poll(() => runState(held), poll).toMatchObject({ eventResult: { state: "held", reason: "target_moved" } });
  const url = `/api/webhooks/${hook}/results/recreate`;
  expect((await call("POST", url, undefined, {})).status).toBe(404);
  const response = await call("POST", url);
  const after = route()!;
  expect(after.route_epoch).toBe(before.route_epoch + 1);
  expect(after.thread_id).not.toBe(before.thread_id);
  expect(response.status).toBe(200);
  await expect.poll(() => runState(held), poll).toMatchObject({ eventResult: { state: "done", reason: "written" } });
  expect((await messages(before.thread_id)).some(row => row.id === `evres-${held}`)).toBe(false);
  expect((await messages(bot.threadId)).some(row => row.id === `evres-${held}`)).toBe(false);
  expect((await messages(after.thread_id)).filter(row => row.id === `evres-${held}`)).toHaveLength(1);
  expect((await call("POST", url)).status).toBe(409);
}, 100_000);

it.each([
  { route: "ask-bot", confirmed: false },
  { route: "ask-bot", confirmed: true },
  { route: "create-bot", confirmed: false },
  { route: "delegate-bot", confirmed: false },
])("W7 $route on an origin-only chat, Stop confirmed before freeze=$confirmed", async ({ route, confirmed }) => {
  const bot = await makeBot(confirmed ? "Confirmed Stop" : "Held Stop");
  const thread = bot.threadId;
  database(db => {
    const store = new AppTriggerStore(db);
    store.putOrigin({ threadId: thread, kind: "run", triggerId: null, routineId: "past-routine", ownerAccountId: "owner",
      homeId: "desktop", homeEpoch: 1, firstRunId: "retired-run", now: Date.now() });
  });
  await prepareFixtureRecall(fixture.info.dataDir, bot.id, thread);
  expect((await send(bot.id, thread, "Wait for the tool __fixture_hold_authority__")).status).toBe(202);
  let port: { token: string; depth: number } | undefined;
  await expect.poll(() => {
    try {
      const dump = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")));
      const env = dump.mcpConfig.mcpServers.agents.env;
      if (env.MURAGE_BOT_ID === bot.id && env.MURAGE_THREAD_ID === thread) port = { token: env.MURAGE_COMMS_TOKEN, depth: Number(env.MURAGE_TURN_DEPTH ?? 0) };
    } catch { /* the isolated CLI is still writing */ }
    return Boolean(port);
  }, poll).toBe(true);
  const child = call("POST", `/api/internal/${route}`, { fromBotId: bot.id, fromThreadId: thread, depth: port!.depth, name: "Blocked child" },
    { authorization: `Bearer ${port!.token}` });
  const stopThread = () => call("POST", `/api/bots/${bot.id}/interrupt`, { threadId: thread });
  let stop: ReturnType<typeof stopThread> | undefined;
  try {
    await expect.poll(() => existsSync(tag(thread, "child-at-guard")), poll).toBe(true);
    stop = stopThread();
    await expect.poll(() => existsSync(tag(thread, "stop-waiting")), poll).toBe(true);
    if (confirmed) {
      writeFileSync(tag(thread, "stop-go"), "");
      expect((await stop).status).toBe(200);
    }
    expect(existsSync(tag(thread, "stop-confirmed"))).toBe(confirmed);
    writeFileSync(tag(thread, "child-go"), "");
    await child;
    const receipt = database(db => new AppTriggerStore(db).origin(thread)?.childRefusal);
    const card = (await messages(thread)).find(row => row.id === `app-child-refusal:thread:${thread}`);
    if (!confirmed) {
      expect({ receipt: receipt?.code, text: card?.text }, `${route} shows the refusal while Stop is held`).toEqual({ receipt: "app_child_not_allowed", text: APP_CHILD_CARD_TEXT });
    } else {
      expect({ receipt, card }).toEqual({ receipt: null, card: undefined });
    }
  } finally {
    writeFileSync(tag(thread, "child-go"), "");
    writeFileSync(tag(thread, "stop-go"), "");
    await child;
    await (stop ?? stopThread());
  }

}, 110_000);

it("W2b a late answer to A leaves B's next step asking on the same conversation", async () => {
  const bot = await makeBot("Request isolation");
  const thread = bot.threadId;
  const openCard = async () => (await messages(thread)).find(row => row.card?.requestHandle && !row.card.answered);
  const respond = (requestHandle: string, action: "allow" | "deny") =>
    call("POST", `/api/threads/${thread}/respond`, { requestHandle, action });
  const permission = async () => {
    await prepareFixtureRecall(fixture.info.dataDir, bot.id, thread);
    expect((await send(bot.id, thread, "__fixture_permission_tool__")).status).toBe(202);
    await expect.poll(async () => (await openCard())?.card?.tool, poll).toBe("Write");
    return (await openCard())!.card!.requestHandle!;
  };
  const a = await permission();
  expect((await respond(a, "allow")).status).toBe(200);
  await expect.poll(async () => (await messages(thread)).some(row => row.text === "permission: allowed"), poll).toBe(true);
  const b = await permission();
  expect(b).not.toBe(a);
  await respond(a, "allow");
  expect((await openCard())?.card?.requestHandle).toBe(b);
  expect((await respond(b, "deny")).status).toBe(200);
  await expect.poll(async () => (await messages(thread)).some(row => row.text === "permission: denied"), poll).toBe(true);
}, 100_000);
