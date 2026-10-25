// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SOCKET TEST (real server, real HTTP): the 1.0.4 rig's failing shape. On Maya's profile every hand-off from Ember (the Chief, the project's
// lead) to Canvas ("Image Maker", a Social Week teammate, a project member) failed 4 of 4: "delegation to @Canvas could not start: it did not
// say why". Canvas was partitioned (an earlier project's pair channel marked it at a restart), and a partitioned bot's turn is re-checked at its
// start (assertWorkResume). A plain hand-off's request is bound to its destination thread, never to the turn's generation, so the check found
// no request, read the turn as nobody's work and refused it "This bot cannot be reached from here.". The check now finds the hand-off the
// thread is running, so the start is judged by that request's own rule (the lead's project hand-off to a member), and it starts. The Activity
// tab shows the hand-off.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

const TAGS = ["A", "C"];
let fixture: VerificationServer;
let headers: Record<string, string> = {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
};
const dataFile = (name: string) => join(fixture.info.dataDir, name);
type Turn = { token: string; botId: string; threadId: string; depth: number };
const dumpToken = (tag: string, botId: string, marker: string): Turn | null => {
  let lines: string[];
  try { lines = readFileSync(dataFile(`dumps${tag}.jsonl`), "utf8").split("\n").filter(Boolean); } catch { return null; }
  for (const line of lines) {
    try {
      const dump = withTurnSecrets(JSON.parse(line));
      const env = dump.mcpConfig.mcpServers.agents.env;
      if (env.MURAGE_BOT_ID !== botId || !JSON.stringify(dump.prompt ?? "").includes(marker)) continue;
      return { token: env.MURAGE_COMMS_TOKEN, botId: env.MURAGE_BOT_ID, threadId: env.MURAGE_THREAD_ID, depth: Number(env.MURAGE_TURN_DEPTH ?? 0) };
    } catch { /* a line being written */ }
  }
  return null;
};
async function until<T>(read: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(200);
  }
}
const call = (turn: Turn, path: string, body: Record<string, unknown>) => fetch(fixture.info.url + path, { method: "POST",
  headers: { authorization: `Bearer ${turn.token}`, "content-type": "application/json" },
  body: JSON.stringify({ fromBotId: turn.botId, fromThreadId: turn.threadId, depth: turn.depth, ...body }) });
const messages = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body?.messages ?? []) as any[];

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { portRange: { from: 48_400, span: 90 }, readyTimeoutMs: 90_000, instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');
    const data=process.env.MURAGE_DATA_DIR;const file=path.join(data,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    const holdEnv=(tag)=>({FAKE_CLAUDE_DUMP:path.join(data,'dump'+tag+'.json'),FAKE_CLAUDE_DUMP_EACH_TURN:'1',FAKE_CLAUDE_DUMP_HISTORY:path.join(data,'dumps'+tag+'.jsonl'),FAKE_CLAUDE_HOLD_MARKER:'HOLD'+tag,FAKE_CLAUDE_HOLD_GATE:path.join(data,'gate'+tag),FAKE_CLAUDE_HOLD_SEEN:path.join(data,'seen'+tag)});
    for(const tag of ${JSON.stringify(TAGS)})cfg.instances['hold'+tag]={...cfg.instances.verification,displayName:'Hold '+tag,environment:holdEnv(tag)};
    fs.writeFileSync(file,JSON.stringify(cfg));` });
  const proof = (await (await fetch(fixture.info.url + "/api/desktop-secret")).json()) as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 120_000);
afterAll(async () => {
  for (const tag of TAGS) { try { writeFileSync(dataFile("gate" + tag), "go"); } catch { /* closing */ } }
  await fixture?.close();
});

describe.skipIf(process.platform === "win32")("a hand-off to a partitioned teammate in a project starts (the 1.0.3 rig's Canvas)", () => {
  it("Ember (Chief, lead) hands work to Canvas (\"Image Maker\", Social Week, partitioned): Canvas's turn starts, no could-not-start chip, and Activity shows the hand-off", async () => {
    const make = async (name: string, tag: string | undefined, patch: Record<string, unknown>) => {
      const wanted = tag ? (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "hold" + tag) : undefined;
      const bot = await api("POST", "/api/bots", { name, ...(wanted ? { modelSelection: { instanceId: "hold" + tag, model: wanted.models.options[0].id } } : {}) });
      expect(bot.status, JSON.stringify(bot.body)).toBe(201);
      expect((await api("PATCH", `/api/bots/${bot.body.bot.id}`, { computer: "off", browser: false, composio: false, ...patch })).status).toBe(200);
      return bot.body.bot as { id: string; threadId: string; name: string };
    };
    const ember = await make("Ember", "A", { approvePeerComms: false });
    const canvas = await make("Canvas", "C", { section: "Social Week" });
    const byline = await make("Byline", undefined, { section: "Social Week" });
    const created = await api("POST", "/api/groups", { name: "Magnolia Bakehouse", memberIds: [canvas.id, byline.id, ember.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: ember.id } } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const room = created.body.group as { id: string; threadId: string };
    expect((await api("PATCH", `/api/groups/${room.id}`, { channelProject: { goal: "November campaign" } })).status).toBe(200);

    // the rig's roster: Ember is the Chief; Canvas shows its title, not its handle, and was partitioned by an earlier project's pair channel
    await fixture.stop();
    const file = dataFile("bots.json"), bots = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(bots.find((b: any) => b.id === ember.id), { chiefOfStaff: true });
    Object.assign(bots.find((b: any) => b.id === canvas.id), { title: "Image Maker", partitionedAt: Date.now() });
    writeFileSync(file, JSON.stringify(bots));
    await fixture.restart();
    const proof = (await (await fetch(fixture.info.url + "/api/desktop-secret")).json()) as { secret: string };
    headers["x-murage-surface-secret"] = proof.secret;

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "HOLDA plan the November posts" })).status).toBe(202);
    const lead = await until(() => dumpToken("A", ember.id, "HOLDA plan the November posts"));
    const handed = await call(lead, "/api/internal/delegate-bot", { toBotId: canvas.id, message: "HOLDC make three pictures" });
    const body = await handed.json().catch(() => null) as any;
    expect(handed.status, JSON.stringify(body)).toBe(200);
    expect(body?.queued, JSON.stringify(body)).toBe(true);
    writeFileSync(dataFile("gateA"), "go");

    const couldNotStart = (rows: any[]) => rows.find((m) => /could not start/.test(String(m.tool?.name ?? "")));
    // either Canvas's engine is handed the turn, or the room shows the could-not-start chip (base): whichever comes first
    const outcome = await until(async () => dumpToken("C", canvas.id, "HOLDC make three pictures") ? "started" : couldNotStart(await messages(room.threadId)) ? "refused" : null, 90_000);
    const roomRows = await messages(room.threadId);
    expect(couldNotStart(roomRows)?.tool?.name, JSON.stringify(roomRows.map((m) => m.tool?.name ?? m.text).slice(-12))).toBeUndefined();
    expect(outcome).toBe("started");
    writeFileSync(dataFile("gateC"), "go");

    const activity = await api("GET", `/api/groups/${room.id}/activity`);
    expect(activity.status, JSON.stringify(activity.body)).toBe(200);
    expect(activity.body.items, JSON.stringify(activity.body.items)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "handoff", actor: ember.id, detail: expect.objectContaining({ toBotId: canvas.id }) })]));
  }, 240_000);
});
