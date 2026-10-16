// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SOCKET TEST (real server, real HTTP): review round 4, findings 1, 3 and 6. An event run (a routine) that hands work to a bot
// shared from another team: the run's limits follow the work into that bot, a refused shared enqueue starts nothing and costs
// nothing, and a shared answer is remembered with the request it was written for.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { readRoutinesWithRuns } from "./routine-runs-journal.ts";
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
async function until<T>(read: () => T | null | undefined | false, ms = 40_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(150);
  }
}
const withDb = <T>(write: boolean, use: (db: DatabaseSync) => T): T | undefined => {
  const db = new DatabaseSync(dataFile("messages.db"), write ? {} : { readOnly: true });
  try { db.exec("PRAGMA busy_timeout=5000"); return use(db); } catch { return undefined; } finally { db.close(); }
};
const rowFor = (fromBotId: string, toBotId: string) => withDb(false, db => db.prepare("SELECT id, state, target_thread_id FROM room_requests WHERE from_bot_id=? AND to_bot_id=? AND verb='ask' ORDER BY created_at DESC LIMIT 1").get(fromBotId, toBotId) as any);
const handoffAdmissions = (runId: string) => (readRoutinesWithRuns(dataFile("routines.json")).runs.find((item: { id: string }) => item.id === runId)?.eventBudget?.admissions ?? [])
  .filter((item: { kind: string }) => item.kind === "handoff") as Array<{ id: string; receipt?: string }>;

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { portRange: { from: 47_900, span: 90 }, readyTimeoutMs: 90_000, instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');
    const data=process.env.MURAGE_DATA_DIR;const file=path.join(data,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    const holdEnv=(tag)=>({FAKE_CLAUDE_DUMP:path.join(data,'dump'+tag+'.json'),FAKE_CLAUDE_DUMP_EACH_TURN:'1',FAKE_CLAUDE_HOLD_MARKER:'HOLD'+tag,FAKE_CLAUDE_HOLD_GATE:path.join(data,'gate'+tag),FAKE_CLAUDE_HOLD_SEEN:path.join(data,'seen'+tag)});
    for(const tag of ['A','B','C','D','E','F','G','H'])cfg.instances['hold'+tag]={...cfg.instances.verification,displayName:'Hold '+tag,environment:holdEnv(tag)};
    fs.writeFileSync(file,JSON.stringify(cfg));` });
  const proof = (await (await fetch(fixture.info.url + "/api/desktop-secret")).json()) as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 120_000);
afterAll(async () => {
  for (const tag of ["A", "B", "C", "D", "E", "F", "G", "H"]) { try { writeFileSync(dataFile("gate" + tag), "go"); } catch { /* closing */ } }
  await fixture?.close();
});

/** An asker (team Sales, a Chief), a helper in Sales, and a target in Design shared with the whole workspace. */
async function world(askerTag: string, targetTag: string, label: string) {
  const make = async (name: string, instanceId: string | undefined, section: string) => {
    const wanted = instanceId ? (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === instanceId) : undefined;
    const made = await api("POST", "/api/bots", { name, ...(wanted ? { modelSelection: { instanceId, model: wanted.models.options[0].id } } : {}) });
    expect(made.status).toBe(201);
    expect((await api("PATCH", `/api/bots/${made.body.bot.id}`, { section, computer: "off", browser: false, composio: false, approvePeerComms: false })).status).toBe(200);
    return made.body.bot as { id: string; threadId: string; name: string };
  };
  const asker = await make(`Asker ${label}`, "hold" + askerTag, "Sales");
  const helper = await make(`Helper ${label}`, undefined, "Sales");
  const target = await make(`Target ${label}`, "hold" + targetTag, "Design");
  await fixture.stop();
  const file = dataFile("bots.json"), bots = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(bots.find((b: any) => b.id === target.id), { sharedWith: { mode: "all", teams: [] }, partitionedAt: Date.now() });
  Object.assign(bots.find((b: any) => b.id === asker.id), { chiefOfStaff: true });
  writeFileSync(file, JSON.stringify(bots));
  await fixture.restart();
  const proof = (await (await fetch(fixture.info.url + "/api/desktop-secret")).json()) as { secret: string };
  headers["x-murage-surface-secret"] = proof.secret;
  return { asker, helper, target };
}

async function startRun(asker: { id: string }, askerTag: string, label: string) {
  const created = await api("POST", "/api/routines", { name: `Sweep ${label}`, prompt: `HOLD${askerTag} sweep`, botId: asker.id, enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, timeoutMinutes: 20, permissionMode: "ask" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
  expect(started.status).toBe(201);
  const turn = await until(() => dumpToken(`dump${askerTag}.json`));
  const call = (path: string, body: Record<string, unknown>, signal?: AbortSignal) => fetch(fixture.info.url + path, { method: "POST", signal, headers: { authorization: `Bearer ${turn.token}`, "content-type": "application/json" }, body: JSON.stringify({ fromBotId: asker.id, fromThreadId: turn.threadId, depth: 0, ...body }) });
  return { runId: started.body.run.id as string, turn, call };
}

describe("an event run that hands work to a bot shared from another team", () => {
  it("the run's limits follow the work: the shared bot's own hand-off is counted in the run and asks the owner at the limit", async () => {
    const { asker, helper, target } = await world("A", "B", "meter");
    const run = await startRun(asker, "A", "meter");
    // three hand-offs, then the ask of the shared bot is the fourth and last the run may do on its own
    for (let index = 0; index < 3; index++) expect((await run.call("/api/internal/delegate-bot", { toBotId: helper.id, message: `Task ${index}` })).status).toBe(200);
    const abort = new AbortController();
    const asking = run.call("/api/internal/ask-bot", { toBotId: target.id, message: "HOLDB please do the shared thing" }, abort.signal).catch(() => undefined);
    const row = await until(() => { const r = rowFor(asker.id, target.id); return r?.target_thread_id ? r : null; });
    expect(row.target_thread_id).toBeTruthy();
    const targetTurn = await until(() => { const d = dumpToken("dumpB.json"); return d && d.botId === target.id ? d : null; });
    expect(handoffAdmissions(run.runId)).toHaveLength(4);
    // the shared bot hands work on in turn: that is the run's fifth, so the owner is asked (it used to go through unmetered)
    const handing = fetch(fixture.info.url + "/api/internal/delegate-bot", { method: "POST", headers: { authorization: `Bearer ${targetTurn.token}`, "content-type": "application/json" },
      body: JSON.stringify({ fromBotId: target.id, fromThreadId: targetTurn.threadId, toBotId: helper.id, message: "Extra work from the shared bot", depth: 1 }) });
    let limitCard: { card: { requestId: string; tool: string } } | undefined;
    for (let i = 0; i < 200 && !limitCard; i++) {
      const messages = (await api("GET", `/api/threads/${targetTurn.threadId}/messages`)).body?.messages as Array<{ card?: { tool?: string; answered?: string } }> | undefined;
      limitCard = messages?.find(item => item.card?.tool === "more_handoffs" && !item.card.answered) as typeof limitCard;
      if (!limitCard) await sleep(150);
    }
    expect(limitCard, "the shared bot's hand-off should have asked the owner at the run's limit").toBeTruthy();
    expect((await api("POST", `/api/threads/${targetTurn.threadId}/respond`, { requestId: limitCard!.card.requestId, behavior: "deny" })).status).toBe(200);
    const refused = await handing;
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/said not now to more hand-offs/);
    expect(handoffAdmissions(run.runId)).toHaveLength(4);
    abort.abort(); await asking;
    for (const tag of ["A", "B"]) writeFileSync(dataFile("gate" + tag), "go");
  }, 180_000);

  it("a shared enqueue that is refused starts nothing and is not charged", async () => {
    const { asker, target } = await world("C", "D", "queue");
    const run = await startRun(asker, "C", "queue");
    // the first ask finishes at once: it makes the shared bot's work thread and leaves the bot idle
    const first = await run.call("/api/internal/ask-bot", { toBotId: target.id, message: "First shared thing __fixture_finish_turn__" });
    expect(first.status).toBe(200);
    const row = await until(() => { const r = rowFor(asker.id, target.id); return r?.target_thread_id && ["done", "failed"].includes(r.state) ? r : null; });
    expect(handoffAdmissions(run.runId)).toHaveLength(1);
    // the shared bot already has twenty requests waiting from this team, and one running for it so none of them is started meanwhile
    withDb(true, db => {
      const real = db.prepare("SELECT group_id, execution_audience FROM room_requests WHERE id=?").get(row.id) as { group_id: string; execution_audience: string };
      const now = Date.now();
      for (let index = 0; index <= 20; index++) {
        const running = index === 20;
        db.prepare(`INSERT INTO room_requests (id, root_id, group_id, target_thread_id, verb, from_kind, from_bot_id, to_bot_id, payload_text, origin, root_thread_id, audience_fingerprint, not_owner_audience, unattended, execution_audience, admission_key, state, created_at, dispatched_at, deadline_at)
          VALUES (?,?,?,?, 'ask','bot',?,?,?, 'desktop',?, 'owner',0,0, ?, ?, ?, ?, ?, ?)`).run(`filler-${index}`, `filler-${index}`, real.group_id, row.target_thread_id, asker.id, target.id, "waiting", run.turn.threadId,
          real.execution_audience, `filler-key-${index}`, running ? "running" : "queued", now + index, running ? now : null, now + 86_400_000);
      }
    });
    expect(withDb(false, db => (db.prepare("SELECT COUNT(*) AS n FROM room_requests WHERE to_bot_id=? AND target_thread_id=? AND state='queued'").get(target.id, row.target_thread_id) as { n: number }).n)).toBe(20);
    const refused = await run.call("/api/internal/ask-bot", { toBotId: target.id, message: "Second shared thing" });
    const body = await refused.json() as { code?: string; error?: string };
    expect(refused.status, JSON.stringify(body)).toBe(409);
    expect(body.code).toBe("shared_queue_cap");
    // nothing started, so nothing was charged and no attempt was recorded as ended
    const admissions = handoffAdmissions(run.runId);
    expect(admissions).toHaveLength(1);
    expect(admissions.some(item => item.receipt?.startsWith("ended:"))).toBe(false);
    for (const tag of ["C", "D"]) writeFileSync(dataFile("gate" + tag), "go");
  }, 180_000);

  it("a shared answer is remembered with the request it was written for, and asking again returns it without a second request", async () => {
    const { asker, target } = await world("E", "F", "replay");
    const run = await startRun(asker, "E", "replay");
    const first = await run.call("/api/internal/ask-bot", { toBotId: target.id, message: "Do the shared thing __fixture_finish_turn__" });
    const firstBody = await first.json() as { text?: string; botName?: string; error?: string };
    expect(first.status, JSON.stringify(firstBody)).toBe(200);
    const row = rowFor(asker.id, target.id);
    expect(row?.id).toBeTruthy();
    const admissions = handoffAdmissions(run.runId);
    expect(admissions).toHaveLength(1);
    expect(admissions[0].receipt).toMatch(new RegExp(`^answer:${row.target_thread_id}:[^:]+:${row.id}$`));
    const again = await run.call("/api/internal/ask-bot", { toBotId: target.id, message: "Do the shared thing __fixture_finish_turn__" });
    const againBody = await again.json() as { text?: string };
    expect(again.status).toBe(200);
    expect(againBody.text).toBe(`You already asked @${firstBody.botName} this in this run. Their answer: ${firstBody.text}`);
    expect(withDb(false, db => (db.prepare("SELECT COUNT(*) AS n FROM room_requests WHERE from_bot_id=? AND to_bot_id=? AND verb='ask'").get(asker.id, target.id) as { n: number }).n)).toBe(1);
    expect(handoffAdmissions(run.runId)).toHaveLength(1);
    for (const tag of ["E", "F"]) writeFileSync(dataFile("gate" + tag), "go");
  }, 180_000);

  it("a shared ticket answers on the status route while it is open, and another conversation is refused (review round 4 #4)", async () => {
    const { asker, target } = await world("G", "H", "status");
    const run = await startRun(asker, "G", "status");
    const abort = new AbortController();
    const asking = run.call("/api/internal/ask-bot", { toBotId: target.id, message: "HOLDH keep working" }, abort.signal).catch(() => undefined);
    const row = await until(() => { const r = rowFor(asker.id, target.id); return r?.target_thread_id && r.state === "running" ? r : null; });
    const targetTurn = await until(() => { const d = dumpToken("dumpH.json"); return d && d.botId === target.id ? d : null; });
    const status = (token: string, botId: string, threadId: string) => fetch(`${fixture.info.url}/api/internal/delegations/${row.id}?fromBotId=${botId}&fromThreadId=${threadId}&wait_ms=0`, { headers: { authorization: `Bearer ${token}` } });
    const mine = await status(run.turn.token, asker.id, run.turn.threadId);
    const mineBody = await mine.json() as { status?: string; toBotName?: string };
    expect(mine.status, JSON.stringify(mineBody)).toBe(200);
    expect(mineBody.status).toBe("running");
    const foreign = await status(targetTurn.token, target.id, targetTurn.threadId);
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { error: string }).error).toBe("that task belongs to a different conversation");
    // a task nobody knows is still plain not-found
    const unknown = await fetch(`${fixture.info.url}/api/internal/delegations/nothing-here-1?fromBotId=${asker.id}&fromThreadId=${run.turn.threadId}&wait_ms=0`, { headers: { authorization: `Bearer ${run.turn.token}` } });
    expect(unknown.status).toBe(404);
    abort.abort(); await asking;
    for (const tag of ["G", "H"]) writeFileSync(dataFile("gate" + tag), "go");
  }, 180_000);
});
