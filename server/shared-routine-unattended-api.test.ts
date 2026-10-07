// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SOCKET TEST (real server, real HTTP): fix round 4, blocking 1. A routine run
// that asks a team-shared bot hands that bot's work thread an UNATTENDED turn,
// whatever the shared-work path: the row says unattended, and the target's
// own turn is refused the owner-only browser setup route. The control is the
// same ask from an ordinary owner conversation, which stays attended.
//
// Corefix3's H1 test called the delegated-turn helper directly; this drives
// POST /api/internal/ask-bot, the route that reaches enqueueSharedWork.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

let fixture: VerificationServer;
let headers: Record<string, string> = {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
};
const dataFile = (name: string) => join(fixture.info.dataDir, name);
const dumpToken = (name: string): { token: string; botId: string; threadId: string } | null => {
  try {
    const dump = withTurnSecrets(JSON.parse(readFileSync(dataFile(name), "utf8")));
    const env = dump.mcpConfig.mcpServers.agents.env;
    return { token: env.MURAGE_COMMS_TOKEN, botId: env.MURAGE_BOT_ID, threadId: env.MURAGE_THREAD_ID };
  } catch { return null; }
};
async function until<T>(read: () => T | null | undefined | false, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(150);
  }
}
const rowFor = (fromBotId: string, toBotId: string) => {
  const db = new DatabaseSync(dataFile("messages.db"), { readOnly: true });
  try { return db.prepare("SELECT id, state, unattended, target_thread_id FROM room_requests WHERE from_bot_id=? AND to_bot_id=? AND verb='ask' ORDER BY created_at DESC LIMIT 1").get(fromBotId, toBotId) as any; }
  catch { return undefined; } finally { db.close(); }
};

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { portRange: { from: 47600, span: 300 }, readyTimeoutMs: 90_000, instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');
    const data=process.env.MURAGE_DATA_DIR;const file=path.join(data,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    const holdEnv=(tag)=>({FAKE_CLAUDE_DUMP:path.join(data,'dump'+tag+'.json'),FAKE_CLAUDE_DUMP_EACH_TURN:'1',FAKE_CLAUDE_HOLD_MARKER:'HOLD'+tag,FAKE_CLAUDE_HOLD_GATE:path.join(data,'gate'+tag),FAKE_CLAUDE_HOLD_SEEN:path.join(data,'seen'+tag)});
    for(const tag of ['A','B','C','D','E','F'])cfg.instances['hold'+tag]={...cfg.instances.verification,displayName:'Hold '+tag,environment:holdEnv(tag)};
    fs.writeFileSync(file,JSON.stringify(cfg));` });
  const proof = (await (await fetch(fixture.info.url + "/api/desktop-secret")).json()) as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 120_000);
afterAll(async () => {
  for (const tag of ["A", "B", "C", "D", "E", "F"]) { try { writeFileSync(dataFile("gate" + tag), "go"); } catch { /* closing */ } }
  await fixture?.close();
});

/** Asker (team Sales, instance A or C) and a target shared with the whole team. */
async function pair(askerTag: string, targetTag: string, label: string) {
  const make = async (name: string, instanceId: string, section: string) => {
    const instance = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === instanceId);
    const made = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: instance.models.options[0].id } });
    expect(made.status).toBe(201);
    expect((await api("PATCH", `/api/bots/${made.body.bot.id}`, { section, computer: "off", browser: false, composio: false, approvePeerComms: false })).status).toBe(200);
    return made.body.bot as { id: string; threadId: string };
  };
  const asker = await make(`Asker ${label}`, "hold" + askerTag, "Sales");
  const target = await make(`Target ${label}`, "hold" + targetTag, "Design");
  await fixture.stop();
  const file = dataFile("bots.json"), bots = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(bots.find((b: any) => b.id === target.id), { sharedWith: { mode: "all", teams: [] }, partitionedAt: Date.now() });
  Object.assign(bots.find((b: any) => b.id === asker.id), { chiefOfStaff: true });
  writeFileSync(file, JSON.stringify(bots));
  await fixture.restart();
  const proof = (await (await fetch(fixture.info.url + "/api/desktop-secret")).json()) as { secret: string };
  headers["x-murage-surface-secret"] = proof.secret;
  return { asker, target };
}

async function askAcrossRoute(asker: { id: string }, target: { id: string }, askerDump: string, targetTag: string) {
  const turn = await until(() => dumpToken(askerDump));
  const abort = new AbortController();
  const pendings: Array<Promise<unknown>> = [];
  let row: any;
  // the turn registers a moment after its engine starts: ask again until the route admits it
  for (let attempt = 0; attempt < 12 && !row; attempt++) {
    pendings.push(fetch(fixture.info.url + "/api/internal/ask-bot", {
      method: "POST", signal: abort.signal, headers: { authorization: `Bearer ${turn.token}`, "content-type": "application/json" },
      body: JSON.stringify({ fromBotId: asker.id, fromThreadId: turn.threadId, toBotId: target.id, message: `HOLD${targetTag} please do the shared thing`, depth: 0 }),
    }).catch(() => undefined));
    for (let i = 0; i < 20 && !row; i++) { await sleep(150); const r = rowFor(asker.id, target.id); if (r?.target_thread_id) row = r; }
  }
  expect(row, "the ask never reached the shared-work queue").toBeTruthy();
  const targetTurn = await until(() => { const d = dumpToken("dump" + targetTag + ".json"); return d && d.botId === target.id ? d : null; });
  const browserSetup = await fetch(fixture.info.url + "/api/internal/request-browser-connection", {
    method: "POST", headers: { authorization: `Bearer ${targetTurn.token}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "probe" }),
  });
  const setupBody = (await browserSetup.json().catch(() => null)) as any;
  // The card is the only thing the route makes: the bot's own token cannot answer it.
  const answered = setupBody?.messageId ? await fetch(fixture.info.url + `/api/threads/${targetTurn.threadId}/browser-setup/${setupBody.messageId}`, {
    method: "POST", headers: { authorization: `Bearer ${targetTurn.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "accept" }),
  }) : null;
  // the ceiling the request was asked under, read while the request is still open
  let ceiling: any;
  try { ceiling = JSON.parse(readFileSync(dataFile("shared-routine-authority.json"), "utf8"))[row.id]; } catch { /* no file: no ceiling */ }
  abort.abort(); await Promise.all(pendings);
  // let both held turns finish: the next test needs the shared slots this one held
  for (const tag of [askerDump.slice(4, 5), targetTag]) writeFileSync(dataFile("gate" + tag), "go");
  await until(() => !["running", "queued", "dispatched"].includes(String(rowFor(asker.id, target.id)?.state)), 40_000).catch(() => undefined);
  return { row, browserSetupStatus: browserSetup.status, browserSetupBody: setupBody, selfAnswerStatus: answered?.status, ceiling };
}

describe("a routine that asks a team-shared bot (through POST /api/internal/ask-bot)", () => {
  it("control: an ordinary owner conversation's ask keeps the shared bot's turn attended", async () => {
    const { asker, target } = await pair("C", "D", "owner");
    expect((await api("POST", `/api/bots/${asker.id}/messages`, { threadId: asker.threadId, text: "HOLDC owner conversation" })).status).toBe(202);
    const seen = await askAcrossRoute(asker, target, "dumpC.json", "D");
    expect(Number(seen.row.unattended)).toBe(0);
    expect(seen.browserSetupStatus).not.toBe(403);
    // an owner's ask carries no routine ceiling
    expect(seen.ceiling).toBeUndefined();
  }, 120_000);

  it("a bot routine's ask is bounded by its ceiling (not unattended): ceiling recorded, browser setup stays an owner approval", async () => {
    const { asker, target } = await pair("A", "B", "routine");
    const created = await api("POST", "/api/routines", { name: "Sweep", prompt: "HOLDA sweep", botId: asker.id, enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, timeoutMinutes: 20, permissionMode: "ask" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await api("POST", `/api/routines/${created.body.routine.id}/run`)).status).toBe(201);
    const seen = await askAcrossRoute(asker, target, "dumpA.json", "B");
    // s3b: a routine is BOUNDED by its persisted ceiling, not marked unattended
    expect(Number(seen.row.unattended)).toBe(0);
    expect(seen.ceiling, "the routine's ceiling must be recorded for the shared request").toMatchObject({ permissionMode: "ask" });
    // browser setup is an approval card at the ceiling: the route only posts it, and the bot cannot answer it itself
    expect(seen.browserSetupStatus).toBe(201);
    expect(seen.browserSetupBody?.pending).toBe(true);
    expect(seen.selfAnswerStatus).toBe(403);
  }, 120_000);

  it("a project (room-goal) routine's ask is ceiling-bounded too", async () => {
    const { asker, target } = await pair("E", "F", "room");
    const room = (await api("POST", "/api/groups", { name: "Routine room", memberIds: [asker.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: asker.id } } })).body.group;
    const created = await api("POST", "/api/routines", { name: "Room sweep", prompt: "HOLDE room sweep", target: "room-goal", groupId: room.id, botId: asker.id, runOn: "ember", schedule: { type: "once", at: Date.now() + 60_000 }, durationMinutes: 30 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
    expect(started.status).toBe(201);
    // the calendar read is what moves a room-goal run on to its turn
    for (let i = 0; i < 200 && !dumpToken("dumpE.json"); i++) { await api("GET", "/api/routines"); await sleep(150); }
    const seen = await askAcrossRoute(asker, target, "dumpE.json", "F");
    // s3b: a routine is BOUNDED by its persisted ceiling, not marked unattended
    expect(Number(seen.row.unattended)).toBe(0);
    expect(seen.ceiling, "the routine's ceiling must be recorded for the shared request").toMatchObject({ permissionMode: "ask" });
    // browser setup is an approval card at the ceiling: the route only posts it, and the bot cannot answer it itself
    expect(seen.browserSetupStatus).toBe(201);
    expect(seen.browserSetupBody?.pending).toBe(true);
    expect(seen.selfAnswerStatus).toBe(403);
  }, 120_000);
});
