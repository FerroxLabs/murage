// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CHIEF-TRANSFER-1023 over the real server (designs/CHIEF-TRANSFER-1023.md r3), Telegram through testing/telegram-fetch-preload.mjs:
//   W2  PATCH {hidden:true} and DELETE on the workspace Chief answer 409 chief-transfer-required; bots.json bytes unchanged; Telegram stays admitted
//   W3  {chiefOfStaff:false} and {chiefScope:"section"} on the Chief, and a direct election on another bot, all answer 409
//   W8  commit with move:[telegram]: connection file, channel-state file and cfg all say B, the LIVE poll picks up an inbound update on B, one
//       receiver, the owner's human link still linked, the chief-transfer event reaches the owner stream
//   W9  a normal restart finds Telegram resumed and admitted on B
//   W19 team import in replace mode leaves the workspace Chief visible and its chat app admitted
import { once } from "node:events";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";
import { accessRoleBinding } from "./bot-access-role.ts";
import type { BotRecord } from "./store.ts";

let fixture: VerificationServer;
let headers: Record<string, string>;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T> | T, ok: (value: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (ok(value)) return value; if (Date.now() > end) return value; await sleep(250); }
}
async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(path, fixture.info.url), { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as any };
}
async function api(method: string, path: string, body?: unknown) {
  const result = await call(method, path, body);
  expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(300);
  return result.body;
}
const dataFile = (...parts: string[]) => join(fixture.info.dataDir, ...parts);
const fixtureDir = () => dataFile("telegram-fixture");
const rows: unknown[] = [];
function inbound(id: number, text: string) {
  rows.push({ update_id: id, message: { message_id: id, date: 1_700_000_000 + id, text, from: { id: 777, is_bot: false }, chat: { id: 777, type: "private" } } });
  writeFileSync(join(fixtureDir(), "updates.tmp"), JSON.stringify(rows));
  renameSync(join(fixtureDir(), "updates.tmp"), join(fixtureDir(), "updates.json"));
}
const polls = () => (existsSync(join(fixtureDir(), "polls.jsonl")) ? readFileSync(join(fixtureDir(), "polls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { at: number }) : []);
const json = (file: string) => JSON.parse(readFileSync(dataFile(...file.split("/")), "utf8"));
const bots = async () => (await api("GET", "/api/bots?messages=0")).bots as Array<{ id: string; name: string; hidden?: boolean; chiefOfStaff?: boolean; chiefScope?: string }>;

let chief: { id: string }, other: { id: string };
let ownerStream: SseRecorder, guestStream: SseRecorder;
async function readDesktopProof() {
  const proof = await (await fetch(new URL("/api/desktop-secret", fixture.info.url))).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: String.raw`
      import fs from 'node:fs';
      // The preload runs only in the fixture's server process.
      import { join } from 'node:path';
      process.env.FAKE_TELEGRAM_DIR = join(process.env.MURAGE_DATA_DIR, 'telegram-fixture');
      const data = process.env.MURAGE_DATA_DIR;
      fs.mkdirSync(process.env.FAKE_TELEGRAM_DIR, { recursive: true });
      process.env.FAKE_CLAUDE_MODE = 'slow';
      process.env.FAKE_CLAUDE_HOLD_MARKER = 'fixture-old-turn';
      process.env.FAKE_CLAUDE_HOLD_GATE = join(data, 'release-old-turn');
      process.env.FAKE_CLAUDE_HOLD_SEEN = join(data, 'held-old-turn');
      process.env.MURAGE_SLACK_APP_TOKEN = 'fixture-app';
      process.env.MURAGE_SLACK_BOT_TOKEN = 'fixture-bot';
      await import(${JSON.stringify(new URL("./testing/slack-sdk-preload.mjs", import.meta.url).href)});
      await import(${JSON.stringify(new URL("./testing/telegram-fetch-preload.mjs", import.meta.url).href)});
      const journal = join(data, 'chief-transfer.json');
      const hold = join(data, 'hold-slack-stop');
      const { SocketModeClient } = await import(${JSON.stringify(new URL("./testing/slack-sdk-fixture.mjs", import.meta.url).href)});
      const disconnect = SocketModeClient.prototype.disconnect;
      SocketModeClient.prototype.disconnect = async function () {
        if (this.active && fs.existsSync(hold)) {
          fs.writeFileSync(join(data, 'slack-stop-entered'), '');
          while (fs.existsSync(hold)) await new Promise(resolve => setTimeout(resolve, 20));
        }
        await disconnect.call(this);
      };
      const crashAt = join(data, 'transfer-crash');
      const telegram = join(data, 'telegram', 'connection.json');
      const writes = join(data, 'transfer-writes.jsonl');
      const rosterWriteFault = join(data, 'roster-write-fault');
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (to === join(data, 'bots.json') && fs.existsSync(rosterWriteFault)) {
          const wanted = fs.readFileSync(rosterWriteFault, 'utf8');
          const next = JSON.parse(fs.readFileSync(from));
          if (next.some(bot => bot.id === wanted && bot.chiefScope === 'workspace')) {
            fs.unlinkSync(rosterWriteFault);
            throw new Error('fixture pre-commit roster fault');
          }
        }
        rename(from, to);
        if (to === telegram) fs.appendFileSync(writes, JSON.stringify({ target: JSON.parse(fs.readFileSync(to)).targetBotId }) + '\n');
        if (!fs.existsSync(crashAt)) return;
        const { phase, target } = JSON.parse(fs.readFileSync(crashAt, 'utf8'));
        if (to === join(data, 'bots.json') && !fs.existsSync(journal) && phase !== 'telegram-saved'
          && JSON.parse(fs.readFileSync(to)).some(bot => bot.chiefScope === 'workspace' && bot.id === target)) {
          process.kill(process.pid, 'SIGKILL');
        }
        if (to === journal && JSON.parse(fs.readFileSync(journal)).state === phase) {
          process.kill(process.pid, 'SIGKILL');
        }
        if (to === join(data, 'config.json') && phase === 'telegram-saved' && fs.existsSync(journal)) {
          const entry = JSON.parse(fs.readFileSync(journal));
          if (entry.state === 'role-saved' && JSON.parse(fs.readFileSync(to)).telegram?.targetBotId === entry.to) {
            process.kill(process.pid, 'SIGKILL');
          }
        }
      };
      await import(${JSON.stringify(new URL("./testing/chief-transfer-faults.mjs", import.meta.url).href)});
    ` });
  await readDesktopProof();
  const model = (await api("GET", "/api/instances")).instances.find((entry: any) => entry.instanceId === "verification").models.options[0].id;
  const make = async (name: string) => (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).bot as { id: string };
  chief = await make("Alpha"); other = await make("Bravo");
  await api("PATCH", `/api/bots/${chief.id}`, { computer: "off", browser: false, composio: false, chiefOfStaff: true, chiefScope: "workspace" });
  await api("PATCH", "/api/config", { telegram: { botToken: "123:abcdefghijklmnopqrstuvwxyz123456" } });
  const pair = await api("POST", "/api/telegram/pair", { targetBotId: chief.id });
  inbound(1, `/pair ${pair.code}`);
  expect(await until(async () => (await api("GET", "/api/telegram/status")).paired, paired => paired === true, 30_000)).toBe(true);
  const binding = (await api("POST", "/api/memory/action", { action: "humans" })).bindings[0];
  await api("POST", "/api/memory/action", { action: "human-link", bindingId: binding.id, expectedRevision: binding.revision, as: "owner" });
}, 120_000);
afterAll(async () => { ownerStream?.close(); guestStream?.close(); await fixture?.close(); });

describe("the guards (W2 W3)", () => {
  it("W2 hide and delete on the workspace Chief answer 409 chief-transfer-required, write nothing, and leave Telegram admitted", async () => {
    const before = readFileSync(dataFile("bots.json"), "utf8");
    const hidden = await call("PATCH", `/api/bots/${chief.id}`, { hidden: true });
    expect(hidden.status).toBe(409);
    expect(hidden.body.code).toBe("chief-transfer-required");
    const removed = await call("DELETE", `/api/bots/${chief.id}`);
    expect(removed.status).toBe(409);
    expect(removed.body.code).toBe("chief-transfer-required");
    expect(readFileSync(dataFile("bots.json"), "utf8")).toBe(before);
    expect((await api("GET", "/api/telegram/status"))).toMatchObject({ paired: true, enabled: true, resumeState: "active" });
  });

  it("W3 demoting the Chief, changing its tier, or electing another bot directly while a Chief exists all answer 409", async () => {
    const before = readFileSync(dataFile("bots.json"), "utf8");
    for (const [id, body] of [[chief.id, { chiefOfStaff: false }], [chief.id, { chiefScope: "section" }], [other.id, { chiefOfStaff: true, chiefScope: "workspace" }]] as const) {
      const result = await call("PATCH", `/api/bots/${id}`, body);
      expect(result.status, JSON.stringify(body)).toBe(409);
      expect(result.body.code).toBe("chief-transfer-required");
    }
    expect(readFileSync(dataFile("bots.json"), "utf8")).toBe(before);
    expect((await bots()).find(bot => bot.id === chief.id)).toMatchObject({ chiefOfStaff: true, chiefScope: "workspace" });
  });
});

describe("W19 team import", () => {
  it("replace mode leaves the workspace Chief visible and its chat app admitted, and says so", async () => {
    const exported = await api("POST", "/api/teams/export", { name: "Field Team" });
    const replaced = await call("POST", "/api/teams/import?mode=replace", exported);
    expect(replaced.status).toBe(201);
    expect(replaced.body.archived.map((bot: { id: string }) => bot.id)).not.toContain(chief.id);
    expect(replaced.body.chiefStays).toMatchObject({ id: chief.id, note: "Alpha stays as Chief of Staff." });
    const now = await bots();
    expect(now.find(bot => bot.id === chief.id)).toMatchObject({ chiefOfStaff: true, chiefScope: "workspace" });
    expect(now.find(bot => bot.id === chief.id)!.hidden).not.toBe(true);
    expect((await api("GET", "/api/telegram/status")).resumeState).toBe("active");
    // put the harness back: the imported copies go, the archived non-Chief bots are restored
    for (const bot of replaced.body.bots) await call("DELETE", `/api/bots/${bot.id}`);
    for (const bot of replaced.body.archived) await call("PATCH", `/api/bots/${bot.id}`, { hidden: false });
  });
});

describe("W8 W9 the Telegram move over the real path", () => {
  it("W8 commit with move:[telegram] moves all three target records, the live poll serves B, one receiver, the owner stays linked, the owner stream hears it", async () => {
    const eventUrl = new URL("/api/events", fixture.info.url).href;
    ownerStream = await openSse(eventUrl, headers);
    guestStream = await openSse(eventUrl);
    await ownerStream.until(frame => frame.kind === "hello");
    await guestStream.until(frame => frame.kind === "hello");

    const move = await currentMove();
    const result = await transfer(move, ["telegram"]);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    await api("PATCH", `/api/bots/${other.id}`, { name: "Bravo after transfer" });
    await ownerStream.until(frame => frame.kind === "bot" && frame.bot?.id === other.id && frame.bot?.name === "Bravo after transfer");
    await guestStream.until(frame => frame.kind === "bot" && frame.bot?.id === other.id && frame.bot?.name === "Bravo after transfer");
    expect.soft(ownerStream.frames.filter(frame => frame.kind === "chief-transfer")).toHaveLength(1);
    expect(guestStream.frames.filter(frame => frame.kind === "chief-transfer")).toEqual([]);
    const connection = json("telegram/connection.json");
    expect(connection).toMatchObject({ targetBotId: other.id });
    expect(connection.paused).toBeUndefined();
    expect(json("telegram/123.json").targetBotId).toBe(other.id);
    expect(move.preview.body.pairings).toEqual([expect.objectContaining({ channel: "telegram", live: true, checked: true })]);
    expect(result.body.outcome.channels).toEqual([{ channel: "telegram", result: "moved" }]);
    expect((await bots()).find(bot => bot.id === other.id)).toMatchObject({ chiefOfStaff: true, chiefScope: "workspace" });
    // the LIVE poll (the fixture's getUpdates) picks up a message and enqueues it on B's thread
    inbound(2, "hello after the move");
    const served = await until(async () => ((await api("GET", "/api/routines")).runs as any[]).some(run => run.triggerSource === "channel" && run.botId === other.id), seen => seen === true, 30_000);
    expect(served).toBe(true);
    await expect.poll(() => telegramReplies().some(text => text.includes("hello after the move")), { timeout: 25_000 }).toBe(true);
    expect(((await api("GET", "/api/routines")).runs as any[]).some(run => run.triggerSource === "channel" && run.botId === chief.id)).toBe(false);
    // exactly one receiver: a single poller makes at most one getUpdates per ~1.5 s (two would double it)
    const from = Date.now(); const base = polls().length;
    await sleep(6000);
    expect(polls().length - base).toBeLessThanOrEqual(Math.ceil((Date.now() - from) / 1000 / 1.0));
    expect((await api("GET", "/api/telegram/status"))).toMatchObject({ paired: true, resumeState: "active" });
    // the owner's Telegram account is still linked (today's revokeRuns would have made it inactive)
    const humans = (await api("POST", "/api/memory/action", { action: "humans" })).bindings as Array<{ origin: { platform: string }; state: string }>;
    expect(humans.filter(binding => binding.origin.platform === "telegram").map(binding => binding.state)).toEqual(["linked"]);
    expect(ownerStream.frames.filter(frame => frame.kind === "chief-transfer").map(frame => frame.outcome.id)).toEqual([result.body.outcome.id]);
    ownerStream.close();
    guestStream.close();
    // the sheet showed the outcome from the commit response, so the journal has it as shown: a reload does not show it a second time
    // (an outcome finished by boot recovery is shown once: server/chief-transfer.test.ts W12)
    expect((await api("GET", "/api/chief-transfer/outcome")).outcome).toBeNull();
  }, 90_000);

  it("W9 a normal restart finds Telegram resumed and admitted on B", async () => {
    const current = (await bots()).find(bot => bot.chiefScope === "workspace")?.id;
    if (current === chief.id) expect((await transfer(await currentMove(), ["telegram"])).status).toBe(200);
    await fixture.restart();
    await readDesktopProof();
    expect(await until(async () => (await api("GET", "/api/telegram/status")).resumeState, state => state === "active", 30_000)).toBe("active");
    expect(await api("GET", "/api/telegram/status")).toMatchObject({ paired: true, targetBotId: other.id });
    expect(json("config.json").telegram.targetBotId).toBe(other.id);
    expect(json("telegram/connection.json").paused).toBeUndefined();
  }, 90_000);
});


async function currentMove() {
  const from = (await bots()).find(bot => bot.chiefScope === "workspace")!.id;
  const to = from === chief.id ? other.id : chief.id;
  const preview = await call("GET", `/api/chief-transfer/preview?from=${from}&to=${to}`);
  return { from, to, preview };
}

async function transfer(move: Awaited<ReturnType<typeof currentMove>>, channels: string[]) {
  if (move.preview.status === 404) {
    // Exercise the actual previous release's hand-over so downstream base checks observe its persisted behavior.
    return call("PATCH", `/api/bots/${move.to}`, { chiefOfStaff: true, chiefScope: "workspace" });
  }
  return call("POST", "/api/chief-transfer", { fence: move.preview.body.fence, move: channels });
}

function telegramReplies(): string[] {
  const path = join(fixtureDir(), "sent.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).text) : [];
}

it("W17 cancels the old Chief's held Telegram run and cannot deliver its reply after the move", async () => {
  const move = await currentMove();
  const heldFile = dataFile("held-old-turn");
  inbound(3, "fixture-old-turn");
  await expect.poll(() => existsSync(heldFile), { timeout: 35_000 }).toBe(true);
  type Run = { id: string; status: string; botId: string; triggerSource?: string };
  const runs = async () => (await api("GET", "/api/routines")).runs as Run[];
  const held = (await runs()).find(run => run.botId === move.from && run.triggerSource === "channel" && run.status === "running");
  expect(held?.status).toBe("running");
  const sentBefore = telegramReplies().length;

  const result = await transfer(move, ["telegram"]);
  expect((await runs()).find(run => run.id === held!.id)?.status).toBe("cancelled");
  const humans = async () => (await api("POST", "/api/memory/action", { action: "humans" })).bindings as Array<{ origin: { platform: string }; state: string }>;
  const telegramLinks = async () => (await humans()).filter(binding => binding.origin.platform === "telegram").map(binding => binding.state);
  expect(await telegramLinks()).toEqual(["linked"]);
  expect(result.body.outcome?.stoppedRuns).toBe(1);
  writeFileSync(dataFile("release-old-turn"), "");
  inbound(4, "fixture-new-turn");
  const responses = () => telegramReplies().slice(sentBefore);
  await expect.poll(() => responses().filter(text => text.includes("fixture-new-turn")), { timeout: 35_000 }).toHaveLength(1);
  expect(responses().filter(text => text.includes("fixture-old-turn"))).toEqual([]);
  expect(await telegramLinks()).toEqual(["linked"]);
}, 100_000);

async function pairSlack(targetBotId: string) {
  await api("PATCH", "/api/config?secretStorage=external", {
    slack: { appToken: "fixture-app", botToken: "fixture-bot", teamId: "TEAM", appId: "APP", ownerUserId: "UOWNER" },
  });
  const pair = await api("POST", "/api/slack/pair", { targetBotId });
  fixture.child.send({ kind: "slack-fixture-event", body: {
    type: "event_callback", team_id: "TEAM", api_app_id: "APP", event_id: "EvChiefTransfer", event_time: Math.floor(Date.now() / 1000),
    authorizations: [{ team_id: "TEAM", user_id: "UBOT", is_bot: true }],
    event: { type: "message", channel_type: "im", channel: "DOWNER", user: "UOWNER", text: "/pair " + pair.code },
  } });
  await expect.poll(async () => (await api("GET", "/api/slack/status")).paired).toBe(true);
}

it.each([
  { witness: "W12", phase: "role-saved", slack: false },
  { witness: "W13", phase: "telegram-saved", slack: true },
])("$witness recovers a real child killed at $phase and shows the same outcome once", async ({ phase, slack }) => {
  const move = await currentMove();
  if (slack) await pairSlack(move.from);
  const refreshed = slack ? await currentMove() : move;
  const channels = slack ? ["telegram", "slack"] : ["telegram"];
  const marker = dataFile("transfer-crash");
  const journal = dataFile("chief-transfer.json");
  const writes = dataFile("transfer-writes.jsonl");
  const child = fixture.child;
  const exited = once(child, "exit");
  writeFileSync(marker, JSON.stringify({ phase, target: move.to }));
  try {
    const request = (slack ? crashAfterTelegramMoved(refreshed, channels) : transfer(refreshed, channels)).catch(error => error);
    const exit = await Promise.race([exited, request.then(async response => {
      if (response instanceof Error) return exited;
      return null;
    })]);
    const pending = existsSync(journal) ? json("chief-transfer.json") : null;
    expect(hardExit(exit)).toBe(true);
    const roster = json("bots.json") as Array<{ id: string; chiefScope?: string; chiefEpoch: number }>;
    const savedChief = roster.find(bot => bot.chiefScope === "workspace");
    expect(savedChief?.id).toBe(move.to);
    if (pending) {
      expect(pending).toMatchObject({ state: "role-saved", from: move.from, to: move.to, move: channels });
      expect(savedChief?.chiefEpoch).toBe(pending.epochAfter);
      expect(json("telegram/connection.json").targetBotId).toBe(slack ? move.to : move.from);
      if (slack) expect(json("channels/slack/connection.json").binding.chiefBotId).toBe(move.from);
    }
    const writesBefore = readFileSync(writes, "utf8");

    unlinkSync(marker);
    await fixture.restart();
    await readDesktopProof();
    const resumed = await until(() => api("GET", "/api/telegram/status"), status => status.resumeState === "active" || status.resumeState === "blocked", 15_000);
    if (!slack) expect(resumed).toMatchObject({ paired: true, resumeState: "active", targetBotId: move.to });
    const outcome = (await call("GET", "/api/chief-transfer/outcome")).body.outcome;
    const expected = { id: pending?.id, status: "done", channels: channels.map(channel => ({ channel, result: "moved" })) };
    if (!slack) expect(outcome).toMatchObject(expected);
    if (!slack) await expectShownOnce(pending.id, outcome);
    if (slack) expect(await recoveredPairings(resumed, outcome, writes)).toMatchObject(expectedPairings(move.to, expected, writesBefore));
    if (slack) {
      expect(json("channels/slack/connection.json").binding.chiefBotId).toBe(move.to);
      await expect.poll(async () => await api("GET", "/api/slack/status"), { timeout: 20_000 }).toMatchObject({ state: "connected", paired: true });
    }
  } finally {
    if (existsSync(marker)) unlinkSync(marker);
  }
}, 100_000);


it("W22a a pre-commit roster write fault restores the old Chief and the live Telegram poll", async () => {
  const move = await currentMove();
  const before = json("bots.json") as Array<BotRecord & { chiefEpoch?: number }>;
  const marker = dataFile("roster-write-fault");
  writeFileSync(marker, move.to);
  try {
    const result = await transfer(move, ["telegram"]);
    expect(result.status).toBe(500);
    expect(result.body.error).toContain("Nothing changed.");
    expect((await bots()).find(bot => bot.chiefScope === "workspace")?.id).toBe(move.from);
    await api("PATCH", `/api/bots/${move.from}`, { name: "Old Chief survives" });
    const saved = json("bots.json") as Array<BotRecord & { chiefEpoch?: number }>;
    expect(saved.find(bot => bot.chiefScope === "workspace")).toMatchObject({
      id: move.from, chiefEpoch: before.find(bot => bot.id === move.from)!.chiefEpoch,
    });
    expect(json("chief-transfer.json")).toMatchObject({ state: "done", outcome: { status: "nothing-changed" } });
    expect(await api("GET", "/api/telegram/status")).toMatchObject({ paired: true, resumeState: "active", targetBotId: move.from });
    const runs = async () => ((await api("GET", "/api/routines")).runs as Array<{ id: string; botId: string; triggerSource: string; status: string }>)
      .filter(run => run.triggerSource === "channel" && run.botId === move.from);
    const seen = new Set((await runs()).map(run => run.id));
    inbound(nextUpdate(), "a message after the roster write failed");
    await expect.poll(async () => (await runs()).find(run => !seen.has(run.id))?.status, { timeout: 25_000 }).toBe("completed");
  } finally {
    if (existsSync(marker)) unlinkSync(marker);
  }
}, 70_000);

it("W11 preview names both connected-app grant resets and commit leaves approval levels in place", async () => {
  const move = await currentMove();
  const from = await api("PATCH", `/api/bots/${move.from}`, { composio: true, autoApprove: true, computer: "off", settingsScope: "defaults" });
  const to = await api("PATCH", `/api/bots/${move.to}`, { composio: true, autoApprove: false, computer: "off", settingsScope: "defaults" });
  await api("POST", "/api/routines", {
    botId: move.from, name: "Morning review", prompt: "Read new email.", enabled: false, runOn: "ember",
    schedule: { type: "daily", time: "10:00", weekdays: [1] },
  });

  await fixture.stop();
  const roster = json("bots.json") as BotRecord[];
  for (const bot of roster) {
    if (bot.id !== move.from && bot.id !== move.to) continue;
    const gmail = bot.id === move.from;
    bot.connectedAppAccess = {
      revision: 1, roleBinding: accessRoleBinding(bot), mode: "restricted", allowWrites: false, requests: [],
      grants: [{ toolkit: gmail ? "gmail" : "googlecalendar", accountId: "fixture-account", tools: [gmail ? "GMAIL_FETCH_EMAILS" : "GOOGLECALENDAR_LIST_EVENTS"] }],
    };
  }
  writeFileSync(dataFile("bots.json"), JSON.stringify(roster));
  await fixture.restart();
  await readDesktopProof();
  for (const id of [move.from, move.to]) expect((await api("GET", `/api/bots/${id}/access`)).policy.grants).toHaveLength(1);

  const plan = await currentMove();
  const approved = (plan.preview.body.fence?.pairings as Array<{ channel: string; live: boolean }> | undefined)?.filter(pair => pair.live).map(pair => pair.channel) ?? [];
  const saved = await transfer(plan, approved);
  expect(saved.status).toBe(200);
  expect(plan.preview.body.appAccessResets?.map((reset: { id: string; apps: string[] }) => ({ id: reset.id, apps: reset.apps }))).toEqual([
    { id: move.from, apps: ["gmail"] }, { id: move.to, apps: ["googlecalendar"] },
  ]);
  expect(plan.preview.body.routines).toContainEqual(expect.objectContaining({ name: "Morning review" }));
  const after = json("bots.json") as BotRecord[];
  for (const id of [move.from, move.to]) {
    expect(after.find(bot => bot.id === id)?.connectedAppAccess).toMatchObject({ mode: "restricted", grants: [], revision: 2 });
    expect((await api("GET", `/api/bots/${id}/access`)).policy).toMatchObject({ mode: "restricted", grants: [], revision: 2 });
  }
  expect((await bots()).find(bot => bot.id === move.from)).toMatchObject({ autoApprove: from.bot.autoApprove });
  expect((await bots()).find(bot => bot.id === move.to)).toMatchObject({ autoApprove: to.bot.autoApprove });
}, 100_000);

it("W10b holds the live Telegram move behind a real Slack transport stop and persists a pause if it stalls", async () => {
  const move = await currentMove();
  if (!(await api("GET", "/api/slack/status")).paired) await pairSlack(move.from);
  const plan = await currentMove();
  const marker = dataFile("hold-slack-stop");
  const entered = dataFile("slack-stop-entered");
  const writes = dataFile("transfer-writes.jsonl");
  const before = readFileSync(writes, "utf8");
  writeFileSync(marker, "");
  const request = transfer(plan, ["slack", "telegram"]);
  try {
    await expect.poll(() => existsSync(entered)).toBe(true);
    const pollsBefore = polls().length;
    await sleep(2600);
    expect(readFileSync(writes, "utf8")).toBe(before);
    expect(polls().length).toBe(pollsBefore);
    expect(json("telegram/connection.json").targetBotId).toBe(move.from);

    let deadline: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([request, new Promise<null>(resolve => { deadline = setTimeout(() => resolve(null), 27_000); })])
      .finally(() => clearTimeout(deadline));
    expect(result?.body.outcome?.channels).toEqual([
      { channel: "slack", result: "paused:save-failed" }, { channel: "telegram", result: "moved" },
    ]);
    expect(json("channels/slack/connection.json").paused).toBe(true);
    expect(json("chief-transfer.json").state).toBe("done");
    expect(await api("GET", "/api/telegram/status")).toMatchObject({ paired: true, resumeState: "active", targetBotId: move.to });
    const next = await currentMove();
    expect((await transfer(next, ["telegram"])).status).toBe(200);
  } finally {
    unlinkSync(marker);
    await request;
  }
}, 55_000);

async function planFor(from: string, to: string) {
  return { from, to, preview: await call("GET", `/api/chief-transfer/preview?from=${from}&to=${to}`) };
}

async function candidate(name: string) {
  const model = (await api("GET", "/api/instances")).instances.find((entry: { instanceId: string }) => entry.instanceId === "verification").models.options[0].id;
  return (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).bot as { id: string };
}

it("W6 rejects an owner confirmation made stale by a bot approval edit", async () => {
  const plan = await currentMove();
  const prior = plan.preview.body.to?.level;
  await api("PATCH", `/api/bots/${plan.to}`, { autoApprove: prior !== "Auto", computer: "off", settingsScope: "defaults" });
  const response = await transfer(plan, ["telegram"]);
  expect(response.status).toBe(409);
  expect(response.body.code).toBe("chief-transfer-stale");
  expect((await bots()).find(bot => bot.chiefScope === "workspace")?.id).toBe(plan.from);
  expect(json("telegram/connection.json").targetBotId).toBe(plan.from);
});

it("W7 rejects the original HTTP preview after handovers away and back", async () => {
  const stale = await currentMove();
  const third = await candidate("Charlie");
  expect((await transfer(await planFor(stale.from, third.id), ["telegram"])).status).toBe(200);
  expect((await transfer(await planFor(third.id, stale.from), ["telegram"])).status).toBe(200);
  expect((await bots()).find(bot => bot.chiefScope === "workspace")?.id).toBe(stale.from);
  const response = await transfer(stale, ["telegram"]);
  expect(response.status).toBe(409);
  expect(response.body.code).toBe("chief-transfer-stale");
  expect((await bots()).find(bot => bot.chiefScope === "workspace")?.id).toBe(stale.from);
});

it("W20 the HTTP handover refuses an archived candidate without seating it", async () => {
  const { from } = await currentMove();
  const hidden = await candidate("Delta");
  await api("PATCH", `/api/bots/${hidden.id}`, { hidden: true });
  const plan = await planFor(from, hidden.id);
  const refusal = await transfer(plan, []);
  expect(refusal.status).toBe(409);
  expect(refusal.body.code).toBe("chief-transfer-ineligible");
  expect(plan.preview.body.to).toMatchObject({ eligible: false, reason: "This bot is archived." });
  expect((await bots()).find(bot => bot.chiefScope === "workspace")?.id).toBe(from);
});

async function crashTransfer(plan: Awaited<ReturnType<typeof currentMove>>, phase: "intent" | "role-saved") {
  const marker = dataFile("transfer-crash");
  const exited = once(fixture.child, "exit");
  const channels = (plan.preview.body.fence?.pairings as Array<{ channel: string; live: boolean }> | undefined)
    ?.filter(pair => pair.live).map(pair => pair.channel) ?? [];
  writeFileSync(marker, JSON.stringify({ phase, target: plan.to }));
  try {
    const request = transfer(plan, channels).catch(error => error);
    const exit = await Promise.race([exited, request.then(result => result instanceof Error ? exited : null)]);
    expect(hardExit(exit)).toBe(true);
    await request;
  } finally {
    unlinkSync(marker);
  }
}

it("W23 rejects a second confirmation while the first is waiting on an active transport", async () => {
  const move = await currentMove();
  const status = await api("GET", "/api/slack/status");
  if (status.state !== "connected") {
    if (status.paired || status.requiresRevoke) await api("POST", "/api/slack/revoke");
    await pairSlack(move.from);
  }
  const plan = await currentMove();
  const marker = dataFile("hold-slack-stop");
  const entered = dataFile("slack-stop-entered");
  if (existsSync(entered)) unlinkSync(entered);
  writeFileSync(marker, "");
  const first = transfer(plan, ["slack", "telegram"]);
  let transferId;
  try {
    await expect.poll(() => existsSync(entered)).toBe(true);
    const path = dataFile("chief-transfer.json");
    const second = await transfer(await currentMove(), []);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("chief-transfer-busy");
    const pending = existsSync(path) ? json("chief-transfer.json") : null;
    expect(pending).toMatchObject({ state: "role-saved", from: move.from, to: move.to });
    transferId = pending.id;
  } finally {
    unlinkSync(marker);
    await first;
  }
  expect((await first).body.outcome).toMatchObject({ id: transferId, status: "done" });
  expect(json("chief-transfer.json")).toMatchObject({ id: transferId, state: "done" });
}, 45_000);

it("W15 crashes after intent and reboots without an election or a channel move", async () => {
  const move = await currentMove();
  await crashTransfer(move, "intent");
  await fixture.restart();
  await readDesktopProof();
  expect((await bots()).find(bot => bot.chiefScope === "workspace")?.id).toBe(move.from);
  expect(json("telegram/connection.json").targetBotId).toBe(move.from);
  const outcome = (await call("GET", "/api/chief-transfer/outcome")).body.outcome;
  expect(outcome).toMatchObject({ status: "nothing-changed", from: move.from, to: move.to, channels: [] });
});

it("W18 durably advances the Chief epoch and omits it from team exports", async () => {
  const move = await currentMove();
  const before = json("bots.json") as Array<{ chiefEpoch?: number }>;
  const prior = Math.max(0, ...before.map(bot => bot.chiefEpoch ?? 0));
  const channels = (move.preview.body.fence?.pairings as Array<{ channel: string; live: boolean }> | undefined)
    ?.filter(pair => pair.live).map(pair => pair.channel) ?? [];
  expect((await transfer(move, channels)).status).toBe(200);
  const after = json("bots.json") as Array<{ chiefEpoch?: number }>;
  expect(after.map(bot => bot.chiefEpoch)).toEqual(after.map(() => prior + 1));
  await fixture.restart();
  await readDesktopProof();
  expect((await currentMove()).preview.body.fence.epoch).toBe(prior + 1);
  const exported = await api("POST", "/api/teams/export", { name: "Chief epoch fixture" });
  expect(JSON.stringify(exported)).not.toContain("chiefEpoch");
}, 55_000);

it("W14 boot with a later roster epoch leaves the pending Telegram pairing on its original target", async () => {
  const move = await currentMove();
  await crashTransfer(move, "role-saved");
  const roster = json("bots.json") as Array<BotRecord & { chiefEpoch?: number }>;
  // Another installation saved this roster while the original process was stopped.
  const advanced = Math.max(0, ...roster.map(bot => bot.chiefEpoch ?? 0)) + 1;
  writeFileSync(dataFile("bots.json"), JSON.stringify(roster.map(bot => ({ ...bot, chiefEpoch: advanced }))));
  await fixture.restart();
  await readDesktopProof();

  const outcome = (await call("GET", "/api/chief-transfer/outcome")).body.outcome;
  expect(outcome).toMatchObject({ status: "done", channels: expect.arrayContaining([{ channel: "telegram", result: "paused:chief-changed" }]) });
  expect(json("telegram/connection.json")).toMatchObject({ targetBotId: move.from, paused: true });
  expect(json("config.json").telegram.targetBotId).toBe(move.from);
  expect((await currentMove()).preview.body.fence.epoch).toBe(advanced);
}, 55_000);

it("W14a a later election back to the original Chief cannot reopen the crashed Telegram pairing", async () => {
  const move = await currentMove();
  if (!(await api("GET", "/api/telegram/status")).paired) {
    await api("POST", "/api/telegram/revoke");
    const pair = await api("POST", "/api/telegram/pair", { targetBotId: move.from });
    inbound(nextUpdate(), `/pair ${pair.code}`);
    await expect.poll(async () => (await api("GET", "/api/telegram/status")).paired, { timeout: 15_000 }).toBe(true);
    const binding = (await api("POST", "/api/memory/action", { action: "humans" })).bindings.find((row: { origin: { platform: string } }) => row.origin.platform === "telegram");
    await api("POST", "/api/memory/action", { action: "human-link", bindingId: binding.id, expectedRevision: binding.revision, as: "owner" });
  }
  const before = json("bots.json") as Array<BotRecord & { chiefEpoch?: number }>;
  await crashTransfer(await currentMove(), "role-saved");
  const after = json("bots.json") as Array<BotRecord & { chiefEpoch?: number }>;
  const epoch = Math.max(...after.map(bot => bot.chiefEpoch ?? 0)) + 1;
  // A later roster generation seats the original Chief before this install next opens its pending journal.
  const returned = after.map(bot => {
    const prior = before.find(record => record.id === bot.id)!;
    return { ...bot, chiefOfStaff: prior.chiefOfStaff, chiefScope: prior.chiefScope, chiefEpoch: epoch };
  });
  writeFileSync(dataFile("bots.json"), JSON.stringify(returned));
  await fixture.restart();
  await readDesktopProof();

  expect((await bots()).find(bot => bot.chiefScope === "workspace")?.id).toBe(move.from);
  const resumed = await until(() => api("GET", "/api/telegram/status"), status => status.resumeState === "active" || status.resumeState === "blocked", 15_000);
  expect(resumed).toMatchObject({ paired: false, resumeState: "blocked" });
  expect(json("telegram/connection.json")).toMatchObject({ targetBotId: move.from, paused: true });
  const binding = (await api("POST", "/api/memory/action", { action: "humans" })).bindings.find((row: { origin: { platform: string } }) => row.origin.platform === "telegram");
  expect(binding?.state).toBe("inactive");
  const outcome = (await call("GET", "/api/chief-transfer/outcome")).body.outcome;
  expect(outcome).toMatchObject({ channels: expect.arrayContaining([{ channel: "telegram", result: "paused:chief-changed" }]) });
}, 55_000);


function hardExit(exit: unknown[] | null): boolean {
  return process.platform === "win32"
    ? typeof exit?.[0] === "number" && exit[0] !== 0
    : exit?.[1] === "SIGKILL";
}

it("W22b a post-commit roster fault still publishes both role changes and a successful outcome", async () => {
  const move = await currentMove();
  const sentinel = await candidate("Event marker");
  const events = await openSse(new URL("/api/events", fixture.info.url).href, headers);
  const marker = dataFile("roster-post-commit-fault");
  try {
    await events.until(frame => frame.kind === "hello");
    writeFileSync(marker, move.to);
    const answer = await transfer(move, []);
    expect((json("bots.json") as BotRecord[]).find(bot => bot.chiefScope === "workspace")?.id).toBe(move.to);
    expect(answer.status).toBe(200);
    await api("PATCH", `/api/bots/${sentinel.id}`, { name: "Role event barrier" });
    await events.until(frame => frame.kind === "bot" && frame.bot?.id === sentinel.id && frame.bot?.name === "Role event barrier");
    const announcements = events.frames.filter(frame => frame.kind === "bot").map(frame => frame.bot.id);
    expect(announcements).toEqual(expect.arrayContaining([move.from, move.to]));
    expect(answer.body.outcome).toMatchObject({ from: move.from, to: move.to, status: "done" });
  } finally {
    events.close();
    if (existsSync(marker)) unlinkSync(marker);
  }
});

it("journal failure after the role save still moves the channel and allows another handover", async () => {
  const from = (await bots()).find(bot => bot.chiefScope === "workspace")!.id;
  if (!(await api("GET", "/api/telegram/status")).paired) {
    await api("POST", "/api/telegram/revoke");
    const pair = await api("POST", "/api/telegram/pair", { targetBotId: from });
    inbound(nextUpdate(), `/pair ${pair.code}`);
    await expect.poll(async () => (await api("GET", "/api/telegram/status")).paired, { timeout: 15_000 }).toBe(true);
  }
  const move = await currentMove();
  const marker = dataFile("transfer-journal-fault");
  writeFileSync(marker, "");
  try {
    const first = await transfer(move, ["telegram"]);
    expect(first.status).toBe(200);
    expect(json("telegram/connection.json").targetBotId).toBe(move.to);
    expect(first.body.outcome).toMatchObject({ status: "done", channels: [{ channel: "telegram", result: "moved" }] });
    expect(json("chief-transfer.json").state).toBe("intent");
  } finally {
    unlinkSync(marker);
  }
  const next = await currentMove();
  expect((await transfer(next, ["telegram"])).status).toBe(200);
  expect(json("chief-transfer.json")).toMatchObject({ state: "done", from: move.to, to: move.from });
}, 45_000);

it("W16 a selected Slack save failure pauses that connection while Telegram moves", async () => {
  const move = await currentMove();
  const slack = await api("GET", "/api/slack/status");
  if (slack.state !== "connected") {
    if (slack.paired || slack.requiresRevoke) await api("POST", "/api/slack/revoke");
    await pairSlack(move.from);
  }
  const plan = await currentMove();
  const marker = dataFile("slack-transfer-write-fault");
  writeFileSync(marker, move.to);
  try {
    const answer = await transfer(plan, ["slack", "telegram"]);
    expect(answer.status).toBe(200);
    expect(json("telegram/connection.json").targetBotId).toBe(move.to);
    expect(json("channels/slack/connection.json")).toMatchObject({ chosen: { chiefBotId: move.from }, paused: true });
    expect(answer.body.outcome).toMatchObject({
      status: "done", channels: [{ channel: "slack", result: "paused:save-failed" }, { channel: "telegram", result: "moved" }],
    });
    expect((await bots()).find(bot => bot.chiefScope === "workspace")?.id).toBe(move.to);
  } finally {
    if (existsSync(marker)) unlinkSync(marker);
  }
});

it("W22c a real read-only boot refuses handover before writing the roster or journal", async () => {
  await fixture.stop();
  const marker = dataFile("transfer-read-only-start");
  writeFileSync(marker, "");
  try {
    await fixture.restart();
    await readDesktopProof();
    const move = await currentMove();
    const roster = readFileSync(dataFile("bots.json"), "utf8");
    const path = dataFile("chief-transfer.json");
    const journal = existsSync(path) ? readFileSync(path, "utf8") : null;
    const refused = await transfer(move, []);
    expect(refused.body.code).toBe("chief-transfer-read-only");
    expect(refused.status).toBe(409);
    expect(readFileSync(dataFile("bots.json"), "utf8")).toBe(roster);
    expect(existsSync(path) ? readFileSync(path, "utf8") : null).toBe(journal);
  } finally {
    unlinkSync(marker);
  }
}, 65_000);


async function expectShownOnce(id: string, outcome: unknown) {
  expect((await api("GET", "/api/chief-transfer/outcome")).outcome).toBeNull();
  expect(json("chief-transfer.json")).toMatchObject({ id, state: "done", outcome });
}

async function recoveredPairings(telegram: unknown, outcome: unknown, writes: string) {
  const response = await call("GET", "/api/chief-transfer/outcome");
  return {
    telegram, outcome, writes: readFileSync(writes, "utf8"),
    repeated: response.body.outcome,
    journal: existsSync(dataFile("chief-transfer.json")) ? json("chief-transfer.json") : null,
    slackTarget: json("channels/slack/connection.json").binding.chiefBotId,
  };
}

function expectedPairings(to: string, outcome: { id?: string; status: string; channels: unknown[] }, writes: string) {
  return {
    telegram: { paired: true, resumeState: "active", targetBotId: to },
    outcome, writes, repeated: null, journal: { id: outcome.id, state: "done", outcome }, slackTarget: to,
  };
}

const nextUpdate = () => Math.max(0, ...(rows as Array<{ update_id: number }>).map(row => row.update_id)) + 1;
/** Telegram paired with `target`, receiving, and its owner linked: left alone when it already is, otherwise paired the way the owner does it. */
async function pairTelegramTo(target: string) {
  const status = await api("GET", "/api/telegram/status");
  if (!(status.paired && status.resumeState === "active" && status.targetBotId === target)) {
    await call("POST", "/api/telegram/revoke");
    const pair = await api("POST", "/api/telegram/pair", { targetBotId: target });
    inbound(nextUpdate(), `/pair ${pair.code}`);
    await expect.poll(async () => (await api("GET", "/api/telegram/status")).paired, { timeout: 30_000 }).toBe(true);
  }
  const binding = (await api("POST", "/api/memory/action", { action: "humans" })).bindings
    .find((row: { origin: { platform: string }; state: string }) => row.origin.platform === "telegram" && row.state !== "inactive");
  if (binding && binding.state !== "linked") await api("POST", "/api/memory/action", { action: "human-link", bindingId: binding.id, expectedRevision: binding.revision, as: "owner" });
}

/** W13's stop point. With the hand-over, the fixture hook kills the child right after Telegram's new target is saved (journal at
 * role-saved, Slack still pending). The previous release has no hand-over that moves a chat app, so its run reaches the same on-disk
 * state by the only route it has: the owner elects the new Chief, pairs Telegram with it, and the process is killed. Either way the
 * restart starts with Telegram already saved on the new Chief and Slack still on the old one. */
async function crashAfterTelegramMoved(plan: Awaited<ReturnType<typeof currentMove>>, channels: string[]) {
  if (plan.preview.status !== 404) return transfer(plan, channels);
  const exited = once(fixture.child, "exit");
  expect((await transfer(plan, channels)).status).toBe(200);
  await pairTelegramTo(plan.to);
  await expect.poll(() => json("config.json").telegram?.targetBotId, { timeout: 15_000 }).toBe(plan.to);
  fixture.child.kill("SIGKILL");
  await exited;
  throw new Error("the previous release was stopped after Telegram was saved on the new Chief");
}

// W8 as the design row states it: other chat apps are paired with the old Chief and left unchecked while Telegram alone moves.
// Slack is paired here for real (its SDK fixture), next to the live Telegram poll. Signal cannot join this server-level witness: it is
// switched off in this release (channels/signal/runtime-pin.json has no live qualification, so a booted server builds no Signal
// service), and its custody checks hold any link that its own phone-linking flow did not create. Its unchecked pause is witnessed
// where Signal can run: the real service in channels/signal/service.test.ts (W8e) and the hand-over's choice of the durable pause
// for Signal in chief-transfer.test.ts ("one outcome, unchecked pairings").
it("W8 with Slack paired and left unchecked, only Telegram moves: Slack is paused on the old Chief and the outcome lists both", async () => {
  await fixture.restart();
  await readDesktopProof();
  const { from } = await currentMove();
  await pairTelegramTo(from);
  const slack = await api("GET", "/api/slack/status");
  if (slack.state !== "connected") {
    if (slack.paired || slack.requiresRevoke) await api("POST", "/api/slack/revoke");
    await pairSlack(from);
  }
  await expect.poll(async () => (await api("GET", "/api/telegram/status")).resumeState, { timeout: 30_000 }).toBe("active");
  await expect.poll(async () => (await api("GET", "/api/slack/status")).state, { timeout: 30_000 }).toBe("connected");

  const move = await currentMove();
  const result = await transfer(move, ["telegram"]);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  // Telegram, the one checked app: all three target records say the new Chief and nothing is paused
  expect(json("telegram/123.json").targetBotId).toBe(move.to);
  const telegram = json("telegram/connection.json");
  expect(telegram).toMatchObject({ targetBotId: move.to, enabled: true });
  expect(telegram.paused).toBeUndefined();
  expect(json("config.json").telegram.targetBotId).toBe(move.to);
  // Slack was paired and left unchecked: it stays on the old Chief, paused on disk, before the answer comes back
  expect(json("channels/slack/connection.json")).toMatchObject({ chosen: { chiefBotId: move.from }, paused: true });
  expect(result.body.outcome.channels).toEqual([{ channel: "slack", result: "paused:left-paused" }, { channel: "telegram", result: "moved" }]);
  // and the live Slack connection is closed with it, not only marked on disk
  expect((await api("GET", "/api/slack/status")).state).not.toBe("connected");
  expect(move.preview.body.pairings.map((pair: { channel: string; live: boolean; checked: boolean; target: string }) => ({ channel: pair.channel, live: pair.live, checked: pair.checked, target: pair.target }))).toEqual(
    ["telegram", "slack"].map(channel => ({ channel, live: true, checked: true, target: move.from })));
  expect((await bots()).find(bot => bot.chiefScope === "workspace")?.id).toBe(move.to);
  // the live poll serves the new Chief, and only the new Chief
  const runs = async () => ((await api("GET", "/api/routines")).runs as Array<{ id: string; botId: string; status: string; triggerSource?: string }>).filter(run => run.triggerSource === "channel");
  const seen = new Set((await runs()).map(run => run.id));
  inbound(nextUpdate(), "hello with Slack left behind");
  await expect.poll(async () => (await runs()).filter(run => !seen.has(run.id)).map(run => run.botId), { timeout: 30_000 }).toEqual([move.to]);
  await expect.poll(async () => (await runs()).filter(run => !seen.has(run.id)).map(run => run.status), { timeout: 30_000 }).toEqual(["completed"]);
  // a restart keeps all of it: Telegram receiving on the new Chief, Slack still paused on the old one
  await fixture.restart();
  await readDesktopProof();
  await expect.poll(async () => (await api("GET", "/api/telegram/status")).resumeState, { timeout: 30_000 }).toBe("active");
  expect(await api("GET", "/api/telegram/status")).toMatchObject({ paired: true, targetBotId: move.to });
  expect(json("channels/slack/connection.json")).toMatchObject({ chosen: { chiefBotId: move.from }, paused: true });
  expect((await api("GET", "/api/slack/status")).state).not.toBe("connected");
}, 240_000);
