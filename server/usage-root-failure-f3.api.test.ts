// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SOCKET TEST (real server, real HTTP, fake Claude CLI): F3 verify fix M2. A project turn that no request started (the owner writing to a
// bot's project desk) runs under a USAGE root (`usage:<generation>`). The asks that turn made hang off that root. When the root ends failed
// (the turn failed here; a dispatch failure and an abandoned turn take the same path), completing it cancels the asks below it, and the
// completion must go through afterRoomCompletion so that (a) the running turn of an ask under it is interrupted and (b) a queued hand-off
// under it is dropped from the queue, as for any other ending. Completed without it, the rows read `cancelled` but the worker keeps running
// and the hand-off stays queued.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

const TAGS = ["A", "B"];
let fixture: VerificationServer;
let headers: Record<string, string> = {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
};
const dataFile = (name: string) => join(fixture.info.dataDir, name);
type Turn = { token: string; botId: string; threadId: string; depth: number };
/** The turn of `botId` whose prompt carries `marker`, read from the instance's dump history (one line per dumped turn). */
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
async function until<T>(read: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 40_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(150);
  }
}
const withDb = <T>(use: (db: DatabaseSync) => T): T | undefined => {
  const db = new DatabaseSync(dataFile("messages.db"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout=5000"); return use(db); } catch { return undefined; } finally { db.close(); }
};
type Row = { id: string; state: string; parent_id: string | null; verb: string };
const requestTo = (botId: string, verb: string) => withDb((db) => db.prepare("SELECT id,state,parent_id,verb FROM room_requests WHERE verb=? AND to_bot_id=? ORDER BY rowid DESC").get(verb, botId) as Row | undefined);
const requestById = (id: string) => withDb((db) => db.prepare("SELECT id,state,parent_id,verb FROM room_requests WHERE id=?").get(id) as Row | undefined);
const call = (turn: Turn, path: string, body: Record<string, unknown>, signal?: AbortSignal) => fetch(fixture.info.url + path, { method: "POST", signal,
  headers: { authorization: `Bearer ${turn.token}`, "content-type": "application/json" },
  body: JSON.stringify({ fromBotId: turn.botId, fromThreadId: turn.threadId, depth: turn.depth, ...body }) });

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

describe("F3 M2: a failed usage root cancels its asks the whole way", () => {
  it("interrupts the running turn of an ask under it and drops the queued hand-off under it", async () => {
    const bots: Record<string, { id: string; name: string }> = {};
    for (const spec of [{ key: "Lead", tag: "A" }, { key: "Worker", tag: "B" }, { key: "Helper", tag: undefined }]) {
      const wanted = spec.tag ? (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "hold" + spec.tag) : undefined;
      const bot = await api("POST", "/api/bots", { name: `${spec.key} usage`, ...(wanted ? { modelSelection: { instanceId: "hold" + spec.tag, model: wanted.models.options[0].id } } : {}) });
      expect(bot.status).toBe(201);
      expect((await api("PATCH", `/api/bots/${bot.body.bot.id}`, { computer: "off", browser: false, composio: false, approvePeerComms: false })).status).toBe(200);
      bots[spec.key] = bot.body.bot;
    }
    const group = await api("POST", "/api/groups", { name: "f3-usage", memberIds: Object.values(bots).map((b) => b.id), setup: { bulletin: "", defaultResponder: { kind: "everyone" } }, channelProject: { goal: "Prove a failed usage root closes its asks." } });
    expect(group.status, JSON.stringify(group.body)).toBe(201);
    // the lead's project desk (the thread the owner writes to about this project), and the bots that hand work on coordinate
    const deskThreadId = "f3usagedesk";
    await fixture.stop();
    const file = dataFile("bots.json"), all = JSON.parse(readFileSync(file, "utf8"));
    const lead = all.find((b: any) => b.id === bots.Lead.id);
    lead.tasks = [{ threadId: deskThreadId, title: "f3-usage work", channelProjectDesk: { groupId: group.body.group.id }, createdAt: Date.now(), resumeCursors: {},
      autoApprove: false, fullAccess: false, noLimits: false, alwaysAllow: [], unread: false, activity: "idle", busy: false }, ...(lead.tasks ?? [])];
    for (const key of ["Lead", "Worker"]) Object.assign(all.find((b: any) => b.id === bots[key].id), { chiefOfStaff: true });
    writeFileSync(file, JSON.stringify(all));
    await fixture.restart();
    headers["x-murage-surface-secret"] = ((await (await fetch(fixture.info.url + "/api/desktop-secret")).json()) as { secret: string }).secret;

    // the owner writes on the desk: no request started this turn, so it runs under a usage root; it is held, then fails when released
    const sent = await api("POST", `/api/bots/${bots.Lead.id}/messages`, { text: "HOLDA fail the root __fixture_fail_turn__", threadId: deskThreadId });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    const lead1 = await until(() => dumpToken("A", bots.Lead.id, "HOLDA fail the root"));
    const root = await until(() => withDb((db) => db.prepare("SELECT id,state FROM room_requests WHERE admission_key LIKE 'usage:%' AND to_bot_id=? AND state='running'").get(bots.Lead.id) as { id: string; state: string } | undefined));

    // an ask under the root whose turn is running (held), and a hand-off under the root that is queued behind the lead's own turn
    const abort = new AbortController();
    void call(lead1, "/api/internal/ask-bot", { toBotId: bots.Worker.id, message: "HOLDB do the part" }, abort.signal).catch(() => undefined);
    await until(() => dumpToken("B", bots.Worker.id, "HOLDB do the part"));
    const handed = await (await call(lead1, "/api/internal/delegate-bot", { toBotId: bots.Helper.id, message: "a piece for later" })).json().catch(() => null) as any;
    expect(handed?.queued, JSON.stringify(handed)).toBe(true);
    const running = (await until(() => requestTo(bots.Worker.id, "ask")))!;
    const queued = (await until(() => requestTo(bots.Helper.id, "ask")))!;
    expect([running.parent_id, queued.parent_id], JSON.stringify({ root, running, queued })).toEqual([root.id, root.id]);
    expect(running.state).toBe("running");
    expect((await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === bots.Worker.id).busy).toBe(true);

    // the lead's turn fails: the root ends failed
    writeFileSync(dataFile("gateA"), "go");
    await until(() => requestById(root.id)?.state === "failed");
    expect(requestById(running.id)?.state).toBe("cancelled");
    expect(requestById(queued.id)?.state).toBe("cancelled");
    // (a) the running ask's turn was interrupted (it is held at its gate, which is never opened here)
    await until(async () => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === bots.Worker.id).busy === false, 20_000);
    // (b) the queued hand-off was dropped from the queue: the asker's desk says so, once, in the closing line (CANCEL-TREE-104 R6)
    const closing = `Hand-off to @${bots.Helper.name} cancelled because the request that asked ended`;
    const dropped = await until(async () => JSON.stringify((await api("GET", `/api/threads/${deskThreadId}/messages?limit=200`)).body?.messages ?? []).split(closing).length === 2, 20_000);
    expect(dropped).toBe(true);
    abort.abort();
    writeFileSync(dataFile("gateB"), "go");
  }, 180_000);
});
