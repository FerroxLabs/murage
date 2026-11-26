// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { existsSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { withTurnSecrets } from "../testing/fixture-dump.ts";
import { raiseLevel } from "../testing/raise-level.ts";
import { defaultSettings } from "./settings.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";

let vendor: Awaited<ReturnType<typeof startFakeVapi>>;
let app: VerificationServer;
let desktop: Record<string, string>;
let bot: { id: string; threadId: string };
const args = { to: "+12025550142", goal: "Check opening hours" };

async function api(method: string, path: string, body?: unknown, headers = desktop): Promise<{ status: number; body: any }> {
  const response = await fetch(app.info.url + path, {
    method, headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: response.headers.get("content-type")?.includes("application/json") ? await response.json() : await response.text() };
}

beforeAll(async () => {
  vendor = await startFakeVapi();
  app = await launchVerificationServer(process.env, undefined, { dumpLog: true, instrumentationSource: `
    await import(${JSON.stringify(new URL("../testing/idle-load-preload.mjs", import.meta.url).href)});
    process.env.MURAGE_PHONE_CALL_SECRETS = JSON.stringify({ key: "fixture", origin: "https://api.vapi.ai" });
    process.env.FAKE_CLAUDE_MODE = "hang";
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    const fetchOriginal = globalThis.fetch;
    const vendorOrigin = ${JSON.stringify(vendor.origin)};
    globalThis.fetch = (input, init) => typeof input === "string" && input.startsWith("https://api.vapi.ai/")
      ? fetchOriginal(vendorOrigin + new URL(input).pathname + new URL(input).search, init)
      : fetchOriginal(input, init);
    const { registerHooks } = await import("node:module");
    const { appendFileSync, writeFileSync, existsSync } = await import("node:fs");
    const { setTimeout: pause } = await import("node:timers/promises");
    const dataDir = process.env.MURAGE_DATA_DIR;
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dataDir + "/phone-calls.db");
    db.exec("CREATE TABLE phone_calls (id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL, revision INTEGER NOT NULL, assistant_id TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, row_json TEXT NOT NULL); CREATE INDEX phone_calls_live ON phone_calls(status) WHERE status IN ('uncertain', 'scheduled', 'ringing', 'in_progress'); CREATE TABLE phone_call_settings (id INTEGER PRIMARY KEY, state_json TEXT NOT NULL)");
    const put = db.prepare("INSERT INTO phone_calls VALUES (?, '', 1, 'assistant-1', 0, 'ended', ?)");
    const settings = ${JSON.stringify(defaultSettings("number-1", "Fixture"))};
    db.exec("BEGIN");
    for (let i = 1; i <= 10000; i++) put.run("past-" + i, JSON.stringify({ id: "past-" + i, vendorId: "", status: "ended" }));
    const revisions = Array.from({length: 10000}, (_, i) => ({
      number: i + 1, settings, assistantId: "assistant-1", state: i === 9999 ? "active" : "superseded",
    }));
    db.prepare("INSERT INTO phone_call_settings VALUES (1, ?)").run(JSON.stringify({ next: 10001, active: 10000, revisions }));
    db.exec("COMMIT");
    db.close();
    globalThis.waitForPhoneStore = async () => {
      while (!existsSync(dataDir + "/release-phone-start")) await pause(10);
    };
    globalThis.recordPhoneStoreOpen = () => appendFileSync(dataDir + "/phone-store-open", "open\\n");
    const { DatabaseSync: LivePhoneDatabase } = await import(${JSON.stringify(new URL("../sqlite-open.ts", import.meta.url).href)});
    globalThis.PhoneFixtureDatabase = class extends LivePhoneDatabase {
      constructor(...args) { globalThis.recordPhoneStoreOpen(); super(...args); }
    };
    const { SqliteCallStore } = await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
    const loadRevisions = SqliteCallStore.prototype.loadRevisions;
    SqliteCallStore.prototype.loadRevisions = function() {
      appendFileSync(dataDir + "/phone-revisions-loaded", "load\\n");
      return loadRevisions.call(this);
    };
    const { phoneAskLine } = await import(${JSON.stringify(new URL("../drivers/phone-tool-schemas.ts", import.meta.url).href)});
    const { phoneTurns } = await import(${JSON.stringify(new URL("./phone-turns.ts", import.meta.url).href)});
    globalThis.observePhoneRoom = (dataDir, generation) => {
      writeFileSync(dataDir + "/room-phone-record", JSON.stringify(phoneTurns.has(generation)));
    };
    globalThis.observePhoneTurn = (dataDir, marker, verdict, generation, botId, threadId, token, noLimits) => {
      const record = phoneTurns.get(generation);
      const card = marker === "fixture-cold" ? phoneAskLine("phone_call_place", { to: "+12025550142", goal: "Test" }, { botId, threadId, dispatchGeneration: generation }) : undefined;
      appendFileSync(dataDir + "/phone-observed.jsonl", JSON.stringify({ marker, verdict, record, noLimits, card }) + "\\n");
      writeFileSync(dataDir + "/" + marker + "-agents", token, { mode: 0o600 });
    };
    registerHooks({ load(url, context, next) {
      const loaded = next(url, context);
      if (!url.endsWith("/server/index.ts")) return loaded;
      let source = String(loaded.source);
      const witness = "  // ALL.eld250 B5:";
      const dispatch = "      // @mentions in the user's message";
      const room = "    integrations.agents = agentsIntegration(bot.id, threadId, hop";
      if (![witness, dispatch, room].every(anchor => source.includes(anchor))) throw Error("Phone fixture anchors moved");
      const newOpen = "    const phoneDb = new PhoneCallsDatabase(";
      if (source.includes(newOpen)) source = source.replace(newOpen, "    await (globalThis as any).waitForPhoneStore();\\n" + newOpen);
      if (!source.includes("new PhoneCallsDatabase(")) throw Error("Phone database constructor anchor moved");
      source = source.replaceAll("new PhoneCallsDatabase(", "new (globalThis as any).PhoneFixtureDatabase(");
      source = source.replace(witness, \`
        if (text.startsWith("fixture-other")) opts = { ...opts, notOwnerAudience: true,
          ...(text.startsWith("fixture-other-chain") ? { chainNotOwner: true, chainRootThreadId: opts?.threadId } : {}) };
      \` + witness);
      source = source.replace(dispatch, \`
        const phoneFixture = text.match(/fixture-(?:routine|other-chain|other|owner|project|cold)[-a-z]*/)?.[0];
        if (phoneFixture) (globalThis as any).observePhoneTurn(DATA_DIR, phoneFixture, phoneVerdict.mounted, dispatchClaimId, bot.id, threadId,
          internalToken(bot.id, threadId, dispatchClaimId, "agents"), serviceNoLimits(dispatchClaimId, threadId, bot.id));
      \` + dispatch);
      const roomEnd = source.indexOf(";", source.indexOf(room));
      source = source.slice(0, roomEnd + 1) + "\\n    (globalThis as any).observePhoneRoom(DATA_DIR, internalGeneration);" + source.slice(roomEnd + 1);
      return { ...loaded, source };
    }});
  ` });
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret", undefined, {})).body.secret };
}, 120_000);

beforeEach(async ({ task }) => {
  if (!task.name.startsWith("P8e keeps")) {
    writeFileSync(join(app.info.dataDir, "release-phone-start"), "");
    expect((await api("GET", "/api/phone-calls/status")).status).toBe(200);
  }
  const { instances } = (await api("GET", "/api/instances")).body;
  const model = instances.find((instance: { instanceId: string }) => instance.instanceId === "verification").models.options[0].id;
  const created = await api("POST", "/api/bots", { name: "Phone Fixture", modelSelection: { instanceId: "verification", model } });
  expect(created.status).toBe(201);
  bot = created.body.bot;
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false, autoReview: "off" });
}, 30_000);

afterAll(async () => {
  await app?.close();
  await vendor?.close();
});

async function permission(noLimits: boolean) {
  if (noLimits) expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
}

async function dumpFor(marker: string) {
  let dump: any;
  await expect.poll(() => {
    if (!existsSync(app.fixtureDumpLogPath)) return false;
    const line = readFileSync(app.fixtureDumpLogPath, "utf8").split("\n").find(row => row.includes(marker));
    if (!line) return false;
    dump = withTurnSecrets(JSON.parse(line));
    return Boolean(dump.pid);
  }, { timeout: 45_000 }).toBe(true);
  return dump;
}

function finish(dump: { pid: number }) {
  writeFileSync(join(app.fixtureFinishGateDir, String(dump.pid)), "");
}

async function direct(marker: string, positive = false) {
  const seen = join(app.info.dataDir, marker + "-agents");
  await expect.poll(() => existsSync(seen), { timeout: 45_000 }).toBe(true);
  const observed = readFileSync(join(app.info.dataDir, "phone-observed.jsonl"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line)).filter(row => row.marker === marker).at(-1);
  const token = readFileSync(seen, "utf8");
  const dump = await dumpFor(marker);
  try {
    const before = vendor.requests.length;
    const answer = await api("POST", "/api/internal/phone/phone_call_place", args, { authorization: "Bearer " + token });
    const listed = dump.mcpConfig?.mcpServers?.agents?.env?.MURAGE_PHONE_CALLS;
    if (marker === "fixture-cold") {
      expect(observed.card).toBeNull();
      expect(existsSync(join(app.info.dataDir, "phone-store-open"))).toBe(false);
      expect(existsSync(join(app.info.dataDir, "phone-revisions-loaded"))).toBe(false);
      expect(vendor.requests).toHaveLength(0);
    }
    expect(observed.verdict, JSON.stringify({ marker, noLimits: observed.noLimits })).toBe(positive);
    expect(answer.status, typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body)).toBe(200);
    if (positive) {
      expect(observed.noLimits).toBe(true);
      expect(observed.record).toMatchObject({ botId: bot.id, intent: expect.any(String) });
      expect(listed).toBe("1");
      expect(dump.mcpConfig.mcpServers.agents.env.MURAGE_NO_LIMITS).toBe("1");
      expect(answer.body).toMatchObject({ call: expect.any(String) });
      expect(vendor.requests.slice(before)).toHaveLength(1);
    } else {
      expect(observed.record).toBeUndefined();
      expect(listed).toBeUndefined();
      expect(answer.body).toMatchObject({ error: "not_set_up" });
      expect(vendor.requests).toHaveLength(before);
    }
    return observed;
  } finally { finish(dump); }
}

it("P8e keeps turns closed during startup and opens history once after listen", async () => {
  const marker = "fixture-cold";
  try {
    await permission(true);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: marker + " __fixture_hold_authority__" })).status).toBe(202);
    await direct(marker);
  } finally {
    writeFileSync(join(app.info.dataDir, "release-phone-start"), "");
  }
  expect((await api("GET", "/api/phone-calls/status")).body.active.revision).toBe(10000);
  expect(readFileSync(join(app.info.dataDir, "phone-store-open"), "utf8").trim()).toBe("open");
  expect(readFileSync(join(app.info.dataDir, "phone-revisions-loaded"), "utf8").trim()).toBe("load");
}, 75_000);

it("P1 No limits automation cannot place a call", async () => {
  await permission(true);
  const marker = "fixture-routine";
  const created = await api("POST", "/api/routines", {
    botId: bot.id, name: marker, prompt: marker + " __fixture_hold_authority__", enabled: false,
    permissionMode: "unlimited", schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() },
  });
  expect(created.status).toBe(201);
  expect((await api("POST", `/api/routines/${created.body.routine.id}/run`, {})).status).toBe(201);
  expect((await direct(marker)).noLimits).toBe(true);
}, 70_000);

it.each([false, true])("P2 refuses non-owner audience and its chain (No limits %s)", async noLimits => {
  await permission(noLimits);
  for (const marker of ["fixture-other-" + noLimits, "fixture-other-chain-" + noLimits]) {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: marker + " __fixture_hold_authority__" })).status).toBe(202);
    await direct(marker);
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  }
}, 110_000);

it("P3 No limits stays off for the phone on an owner project card", async () => {
  await permission(true);
  const marker = "fixture-project";
  const { group } = (await api("POST", "/api/groups", { name: "Fixture project", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).body;
  expect((await api("PATCH", `/api/groups/${group.id}`, { channelProject: { goal: "Fixture project task" } })).status).toBe(200);
  const { card } = (await api("POST", `/api/groups/${group.id}/board/cards`, {
    clientId: marker, title: marker + " __fixture_hold_authority__", assigneeBotId: bot.id, writes: false,
  })).body;
  expect((await api("PATCH", `/api/groups/${group.id}/board/cards/${card.id}`, { expectedRevision: card.revision, action: "start" })).status).toBe(200);
  try { expect((await direct(marker)).noLimits).toBe(true); }
  finally { await api("POST", `/api/groups/${group.id}/project/control/stop`, {}); }
}, 75_000);

it.each([false, true])("P2c an owner room turn cannot call (No limits %s)", async noLimits => {
  await permission(noLimits);
  const marker = "fixture-room-" + noLimits;
  const { group } = (await api("POST", "/api/groups", {
    name: marker, memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
  })).body;
  expect((await api("POST", `/api/groups/${group.id}/messages`, { text: marker + " __fixture_hold_authority__" })).status).toBeLessThan(300);
  const dump = await dumpFor(marker);
  try {
    const env = dump.mcpConfig.mcpServers.agents.env;
    const before = vendor.requests.length;
    const answer = await api("POST", "/api/internal/phone/phone_call_place", args, { authorization: "Bearer " + env.MURAGE_COMMS_TOKEN });
    expect(env.MURAGE_PHONE_CALLS).toBeUndefined();
    expect(readFileSync(join(app.info.dataDir, "room-phone-record"), "utf8")).toBe("false");
    expect(answer.status, typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toMatchObject({ error: "not_set_up" });
    expect(vendor.requests).toHaveLength(before);
  } finally { finish(dump); }
}, 75_000);

it("P3b an ordinary No limits owner turn places exactly once without Ask", async () => {
  await permission(true);
  const marker = "fixture-owner";
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: marker + " __fixture_hold_authority__" })).status).toBe(202);
  await direct(marker, true);
}, 75_000);

it("an unreadable phone store gives the owner a fixed error and retries after a new key save", async () => {
  const broken = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.MURAGE_PHONE_CALL_SECRETS = JSON.stringify({ key: "fixture", origin: "https://api.vapi.ai" });
    const fs = await import("node:fs");
    const dataDir = process.env.MURAGE_DATA_DIR;
    fs.mkdirSync(dataDir + "/phone-calls.db");
    process.parentPort = {
      on: (name, listener) => process.on(name, data => listener({data})),
      postMessage: message => {
        if (message.type === "murage:desktop-secret") fs.writeFileSync(dataDir + "/phone-fixture-surface", message.secret, { mode: 0o600 });
      },
    };
  ` });
  try {
    const secret = readFileSync(join(broken.info.dataDir, "phone-fixture-surface"), "utf8");
    const status = () => fetch(broken.info.url + "/api/phone-calls/status", {
      headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret },
    });
    const response = await status();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "store_unavailable" });
    rmdirSync(join(broken.info.dataDir, "phone-calls.db"));
    expect((await status()).status).toBe(503);
    broken.child.send({ type: "murage:phone-key", doc: { key: "fixture", origin: "https://api.vapi.ai" } });
    await expect.poll(async () => (await status()).status, { timeout: 15_000 }).toBe(200);
  } finally { await broken.close(); }
}, 75_000);

it("the desktop starts its local phone history with no vendor key", async () => {
  const keyless = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.MURAGE_PHONE_CALL_SECRETS = "{}";
  ` });
  try {
    const db = join(keyless.info.dataDir, "phone-calls.db");
    await expect.poll(() => existsSync(db), { timeout: 15_000 }).toBe(true);
    const secret = await (await fetch(keyless.info.url + "/api/desktop-secret")).json() as { secret: string };
    const response = await fetch(keyless.info.url + "/api/phone-calls/status", {
      headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret.secret },
    });
    expect(await response.json()).toMatchObject({ supported: true, keyPresent: false, active: null });
  } finally { await keyless.close(); }
}, 75_000);
