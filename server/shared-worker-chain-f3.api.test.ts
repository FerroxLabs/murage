// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SOCKET TEST (real server, real HTTP): F3 finding 02-3 (designs/F3.md section 1 "Shared worker chain", section 3 row "Shared worker cannot
// delegate", section 4 test 3). A bot shared from another team, working on a request, could not hand anything on: its turn began with no
// coordination trace, so every delegate_bot / ask_bot it made was refused COORDINATION_ALLOWANCE_UNAVAILABLE. The trace is now derived from
// the request tree (`req:<room turn>` root, the path of asks under it) or, for a parentless ask from a direct chat, from the asker's own
// advanced trace; the budget's own checks then bound the chain (depth, cycle).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

const TAGS = ["A", "B", "C", "D", "E", "F", "G", "H"];
let fixture: VerificationServer;
let headers: Record<string, string> = {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
};
const dataFile = (name: string) => join(fixture.info.dataDir, name);
type Turn = { token: string; botId: string; threadId: string; depth: number };
/** The turn of `botId` whose prompt carries `marker`, read from the instance's dump history (one line per dumped turn), never the single
 * latest-turn file: another turn of the same instance (a second thread of the same bot) may replace that file before or after the one wanted. */
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
async function until<T>(read: () => T | null | undefined | false, ms = 40_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(150);
  }
}
const withDb = <T>(use: (db: DatabaseSync) => T): T | undefined => {
  const db = new DatabaseSync(dataFile("messages.db"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout=5000"); return use(db); } catch { return undefined; } finally { db.close(); }
};
const roots = (): Array<{ id: string; owner: string; paths: string[][] }> => { try { return JSON.parse(readFileSync(dataFile("coordination-roots.json"), "utf8")).roots; } catch { return []; } };
const call = (turn: Turn, path: string, body: Record<string, unknown>, signal?: AbortSignal) => fetch(fixture.info.url + path, { method: "POST", signal,
  headers: { authorization: `Bearer ${turn.token}`, "content-type": "application/json" },
  body: JSON.stringify({ fromBotId: turn.botId, fromThreadId: turn.threadId, depth: turn.depth, ...body }) });
const answer = async (response: Response) => ({ status: response.status, body: await response.json().catch(() => null) as any });
const refusedForAllowance = (body: any) => /can't hand work on from here|start a new owner task|ALLOWANCE_UNAVAILABLE/i.test(JSON.stringify(body ?? {}));

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { portRange: { from: 48_200, span: 90 }, readyTimeoutMs: 90_000, instrumentationSource: `
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

/** Bots in their sections; `shared` ones are shared with every team (so work for another team reaches them as shared work). */
async function world(label: string, specs: Array<{ key: string; tag?: string; section: string; shared?: boolean }>) {
  const made: Record<string, { id: string; threadId: string; name: string }> = {};
  for (const spec of specs) {
    const wanted = spec.tag ? (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "hold" + spec.tag) : undefined;
    const bot = await api("POST", "/api/bots", { name: `${spec.key} ${label}`, ...(wanted ? { modelSelection: { instanceId: "hold" + spec.tag, model: wanted.models.options[0].id } } : {}) });
    expect(bot.status).toBe(201);
    expect((await api("PATCH", `/api/bots/${bot.body.bot.id}`, { section: spec.section, computer: "off", browser: false, composio: false, approvePeerComms: false })).status).toBe(200);
    made[spec.key] = bot.body.bot;
  }
  await fixture.stop();
  const file = dataFile("bots.json"), bots = JSON.parse(readFileSync(file, "utf8"));
  for (const spec of specs) if (spec.shared) Object.assign(bots.find((b: any) => b.id === made[spec.key].id), { sharedWith: { mode: "all", teams: [] }, partitionedAt: Date.now() });
  // every bot that hands work on coordinates (a Chief may reach any teammate, as in the shared hand-off socket test)
  for (const spec of specs) if (spec.tag) Object.assign(bots.find((b: any) => b.id === made[spec.key].id), { chiefOfStaff: true });
  writeFileSync(file, JSON.stringify(bots));
  await fixture.restart();
  const proof = (await (await fetch(fixture.info.url + "/api/desktop-secret")).json()) as { secret: string };
  headers["x-murage-surface-secret"] = proof.secret;
  return made;
}

describe("F3 02-3: a shared worker's chain is derived from its request tree", () => {
  it("room turn -> shared worker: the worker can delegate and ask (test 3); room turn -> shared -> shared keeps req:<room turn>, the third hop is refused", async () => {
    const w = await world("room", [
      { key: "Lead", tag: "A", section: "Sales" }, { key: "Helper", section: "Sales" },
      { key: "Worker", tag: "B", section: "Design", shared: true }, { key: "Second", tag: "C", section: "Ops", shared: true },
    ]);
    const room = await api("POST", "/api/groups", { name: "f3-room", memberIds: [w.Lead.id], setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
    expect(room.status, JSON.stringify(room.body)).toBe(201);
    expect((await api("POST", `/api/groups/${room.body.group.id}/messages`, { text: "HOLDA plan the work" })).status).toBe(202);
    const lead = await until(() => dumpToken("A", w.Lead.id, "HOLDA plan the work"));
    const memberTurn = await until(() => withDb((db) => db.prepare("SELECT id FROM room_requests WHERE verb='room_turn' AND to_bot_id=? AND state='running'").get(w.Lead.id) as { id: string } | undefined));
    const aborts: AbortController[] = [];
    const hold = (turn: Turn, path: string, body: Record<string, unknown>) => { const abort = new AbortController(); aborts.push(abort); return call(turn, path, body, abort.signal).catch(() => undefined); };
    void hold(lead, "/api/internal/ask-bot", { toBotId: w.Worker.id, message: "HOLDB do the shared part" });
    const worker = await until(() => dumpToken("B", w.Worker.id, "HOLDB do the shared part"));
    // the worker hands on: allowed (it used to be refused for want of a trace)
    const delegated = await answer(await call(worker, "/api/internal/delegate-bot", { toBotId: w.Helper.id, message: "a piece for you" }));
    expect(refusedForAllowance(delegated.body), JSON.stringify(delegated.body)).toBe(false);
    expect(delegated.status, JSON.stringify(delegated.body)).toBe(200);
    expect(delegated.body.queued, JSON.stringify(delegated.body)).toBe(true);
    // the chain's root is the room turn's request, and its paths are the tree's
    const root = roots().find((item) => item.id === `req:${memberTurn.id}`);
    expect(root?.owner).toBe(w.Lead.id);
    expect(root?.paths).toEqual(expect.arrayContaining([[w.Lead.id, w.Worker.id], [w.Lead.id, w.Worker.id, w.Helper.id]]));
    // the worker asks a second shared bot; that one is the end of the chain
    void hold(worker, "/api/internal/ask-bot", { toBotId: w.Second.id, message: "HOLDC the last part" });
    const second = await until(() => dumpToken("C", w.Second.id, "HOLDC the last part"));
    expect(second.depth).toBe(2);
    const third = await answer(await call(second, "/api/internal/delegate-bot", { toBotId: w.Helper.id, message: "one more hop" }));
    expect(third.body?.queued, JSON.stringify(third)).toBeUndefined();
    // refused by the chain's own cap (the budget's path of three), before anything is queued
    expect(JSON.stringify(third.body), JSON.stringify(third)).toMatch(/as long as it can get|handoff depth is exhausted/);
    // and an ask from the end of the chain is refused at the route (depth_exhausted)
    const thirdAsk = await answer(await call(second, "/api/internal/ask-bot", { toBotId: w.Helper.id, message: "one more question" }));
    expect(JSON.stringify(thirdAsk.body), JSON.stringify(thirdAsk)).toMatch(/handoff depth is exhausted/);
    for (const abort of aborts) abort.abort();
    for (const tag of ["A", "B", "C"]) writeFileSync(dataFile("gate" + tag), "go");
  }, 180_000);

  it("direct-chat asker -> shared worker (sync ask): one more hop under the asker's generation root, a cycle back to the asker refused", async () => {
    const w = await world("direct", [
      { key: "Asker", tag: "D", section: "Sales" }, { key: "Helper", section: "Sales" }, { key: "Worker", tag: "E", section: "Design", shared: true },
    ]);
    const created = await api("POST", "/api/routines", { name: "F3 direct", prompt: "HOLDD sweep", botId: w.Asker.id, enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, timeoutMinutes: 20, permissionMode: "ask" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await api("POST", `/api/routines/${created.body.routine.id}/run`)).status).toBe(201);
    const asker = await until(() => dumpToken("D", w.Asker.id, "HOLDD sweep"));
    const abort = new AbortController();
    const asking = call(asker, "/api/internal/ask-bot", { toBotId: w.Worker.id, message: "HOLDE please help" }, abort.signal).catch(() => undefined);
    const worker = await until(() => dumpToken("E", w.Worker.id, "HOLDE please help"));
    const onward = await answer(await call(worker, "/api/internal/delegate-bot", { toBotId: w.Helper.id, message: "onward" }));
    expect(refusedForAllowance(onward.body), JSON.stringify(onward.body)).toBe(false);
    expect(onward.body.queued, JSON.stringify(onward.body)).toBe(true);
    const back = await answer(await call(worker, "/api/internal/delegate-bot", { toBotId: w.Asker.id, message: "back to you" }));
    expect(back.body.queued).toBeUndefined();
    expect(JSON.stringify(back.body)).toMatch(/already part of this chain/);
    abort.abort(); await asking;
    for (const tag of ["D", "E"]) writeFileSync(dataFile("gate" + tag), "go");
  }, 180_000);

  it("a shared hand-off (delegate_bot) from a direct chat: the worker carries the row's trace and can hand on", async () => {
    const w = await world("handoff", [
      { key: "Asker", tag: "F", section: "Sales" }, { key: "Helper", section: "Sales" }, { key: "Worker", tag: "G", section: "Design", shared: true },
    ]);
    const created = await api("POST", "/api/routines", { name: "F3 handoff", prompt: "HOLDF sweep", botId: w.Asker.id, enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, timeoutMinutes: 20, permissionMode: "ask" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await api("POST", `/api/routines/${created.body.routine.id}/run`)).status).toBe(201);
    const asker = await until(() => dumpToken("F", w.Asker.id, "HOLDF sweep"));
    const handed = await answer(await call(asker, "/api/internal/delegate-bot", { toBotId: w.Worker.id, message: "HOLDG take this on" }));
    expect(handed.body.queued, JSON.stringify(handed.body)).toBe(true);
    // a direct hand-off runs once its asker's turn settles
    writeFileSync(dataFile("gateF"), "go");
    const worker = await until(() => dumpToken("G", w.Worker.id, "HOLDG take this on"), 60_000);
    const onward = await answer(await call(worker, "/api/internal/ask-bot", { toBotId: w.Helper.id, message: "a quick question __fixture_finish_turn__" }));
    expect(refusedForAllowance(onward.body), JSON.stringify(onward.body)).toBe(false);
    expect(onward.status, JSON.stringify(onward.body)).toBe(200);
    for (const tag of ["F", "G"]) writeFileSync(dataFile("gate" + tag), "go");
  }, 180_000);
});
