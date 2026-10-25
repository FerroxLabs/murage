// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DELETION-DRAIN-V2 (Grok r4): a direct turn refused at its send over memory, proven unwritten, waits for the revoke walk to settle and is
// then rebuilt (index.ts rebuildRefusedDirectTurn). Through that wait the refused turn keeps the thread ("rebuilding"), so the thread reads
// as working: a conversation delete and a bot delete are refused as for any working turn, a Stop ends it with nothing started, a second send
// queues behind it, and a restart in the wait leaves the thread free. These run the real server with the fixture engine
// (server/testing/fake-late-terminal-driver.ts) over a data dir holding 122 legacy audience jobs that stay pending (their frontier node does
// not parse), so every settle before a rebuild waits its full REDISPATCH_SETTLE_MS: the window each test acts in.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const LEGACY_JOBS = 122;
const FIRST_LEGACY_ID = 710001;
const INSTANCES = ["rbdel", "rbbot", "rbstop", "rbsend", "rbcrash"] as const;
let fixture: VerificationServer, headers: Record<string, string>;
const raw = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
};
const api = async (method: string, path: string, body?: unknown) => {
  const response = await raw(method, path, body);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return response.body;
};
const login = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};
const log = () => existsSync(fixture.info.logPath) ? readFileSync(fixture.info.logPath, "utf8") : "";
const count = (text: string, needle: string) => text.split(needle).length - 1;
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
const isReply = (message: any) => message.role === "bot" && message.kind === "text" && message.text === "Hello from late";
const replies = async (threadId: string) => (await messages(threadId)).filter(isReply).length;
const errorLines = (all: any[]) => all.filter(message => String(message.tool?.name ?? "").startsWith("error:")).map(message => String(message.tool.name));
const taskBusy = async (botId: string, threadId: string) => (await api("GET", `/api/bots/${botId}/tasks/${threadId}`)).task?.busy === true;
const dumpOf = (instance: string) => join(fixture.info.dataDir, `${instance}-dump`);
const dispatches = (instance: string, threadId: string) => existsSync(dumpOf(instance))
  ? readFileSync(dumpOf(instance), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.threadId === threadId).length : 0;
const holdFile = (instance: string, n: number) => join(fixture.info.dataDir, `${instance}-hold-${n}`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The instance's sends, in order: each waits after its prompt was built and before the engine submits it for its hold file. */
const holds = (instance: string) => {
  let n = 0;
  return {
    /** Lets the next send through, after landing a revoke on the bot when asked (the fence then refuses it, proven unwritten). */
    async pass(botId: string, threadId: string, revoke?: string) {
      n++;
      await expect.poll(() => existsSync(`${holdFile(instance, n)}.waiting`), { timeout: 60000 }).toBe(true);
      expect(readFileSync(`${holdFile(instance, n)}.waiting`, "utf8")).toBe(threadId);
      if (revoke) await api("PATCH", `/api/bots/${botId}`, { section: revoke });
      writeFileSync(holdFile(instance, n), "");
    },
    /** True while no further send has reached the engine. */
    idle: () => !existsSync(`${holdFile(instance, n + 1)}.waiting`),
  };
};

const pendingLegacy = () => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return Number((db.prepare(`SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id BETWEEN ? AND ? AND (state='active' OR (state='folded' AND revoke_id IN
    (SELECT f.old_id FROM memory_revoke_fold f JOIN memory_revoke_jobs b ON b.revoke_id=f.bulk_id WHERE b.state IN ('active','seeding'))))`).get(FIRST_LEGACY_ID, FIRST_LEGACY_ID + LEGACY_JOBS - 1) as { n: number }).n); }
  finally { db.close(); }
};
/** What 1.0.2 left for 122 receipt flips (as memory-revoke-storm-api.test.ts leaves them): audience-only jobs no walk can finish. */
const leaveLegacyJobs = async () => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  db.exec("PRAGMA busy_timeout=10000");
  const root = JSON.stringify({ kind: "receipt", bundleId: "legacy-receipt", cause: "receipt-revoked" });
  const job = db.prepare("INSERT OR IGNORE INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'receipt',?,1,1,'mark','','active')");
  const audience = db.prepare("INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)");
  const pending = db.prepare("INSERT OR IGNORE INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',1,?)");
  const frontier = db.prepare("INSERT OR IGNORE INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,1,'{unreadable')");
  db.exec("BEGIN");
  for (let n = 0; n < LEGACY_JOBS; n++) { const id = FIRST_LEGACY_ID + n; job.run(id, root); audience.run(id); pending.run(id); frontier.run(id); }
  db.exec("COMMIT");
  db.close();
  await fixture.restart();
  await login();
};
const ensureLegacyJobs = async () => { if (pendingLegacy() < LEGACY_JOBS) await leaveLegacyJobs(); expect(pendingLegacy()).toBe(LEGACY_JOBS); };

const newBot = async (name: string, instanceId: string) => {
  const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "late-1" } })).bot as { id: string; threadId: string };
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  return bot;
};
/** A second conversation of the bot, and the thread that is NOT the bot's current one (the one a bot-level cancel never named). */
const secondThread = async (botId: string) => {
  await api("POST", `/api/bots/${botId}/tasks`, { title: "Another conversation" });
  const bot = (await api("GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === botId);
  const tasks = (await api("GET", `/api/bots/${botId}/tasks`)).tasks as Array<{ threadId: string }>;
  const other = tasks.map(task => task.threadId).find(threadId => threadId !== bot.threadId);
  expect(other).toBeTruthy();
  return { current: bot.threadId as string, other: other! };
};
/** Lets a send through until its reply lands: a revoke still being walked may refuse it once more, and its rebuild is let through too. */
const passUntilReply = async (hold: ReturnType<typeof holds>, botId: string, threadId: string, want: number) => {
  for (let attempt = 0; attempt < 4 && await replies(threadId) < want; attempt++) {
    if (attempt) console.log(`[drain-v2 test] ${threadId}: send refused again, rebuild ${attempt} let through`);
    await hold.pass(botId, threadId);
    await expect.poll(async () => await replies(threadId) >= want || !hold.idle(), { timeout: 60000 }).toBe(true);
  }
  expect(await replies(threadId)).toBe(want);
};
/** An answered first turn, then the question the fence refuses at its send: resolved once the refused turn waits to be rebuilt. */
const refuseAndWait = async (instance: string, hold: ReturnType<typeof holds>, botId: string, threadId: string) => {
  await api("POST", `/api/bots/${botId}/messages`, { threadId, text: "an earlier question" });
  await passUntilReply(hold, botId, threadId, 1);
  await expect.poll(async () => await taskBusy(botId, threadId), { timeout: 15000 }).toBe(false);
  const warned = count(log(), `context revoked during dispatch on thread ${threadId}; re-preparing (1 of 3)`);
  await api("POST", `/api/bots/${botId}/messages`, { threadId, text: "the question refused at its send" });
  await hold.pass(botId, threadId, `Revoke before the ${instance} submission`);
  await expect.poll(() => count(log(), `context revoked during dispatch on thread ${threadId}; re-preparing (1 of 3)`), { timeout: 30000 }).toBe(warned + 1);
  // the sends that reached the engine so far, the refused one included
  return dispatches(instance, threadId);
};

describe.skipIf(process.platform === "win32")("DELETION-DRAIN-V2: a refused direct turn keeps its thread until it is rebuilt", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      const driver=makeLateTerminalDriver();
      // HOLD_PREFIX: every sendTurn of the instance waits, after its prompt was built and before the engine submits it, for <prefix><n>
      const create=driver.create.bind(driver);
      driver.create=async input=>{
        const instance=await create(input);
        if(!input.environment.HOLD_PREFIX)return instance;
        const send=instance.adapter.sendTurn.bind(instance.adapter); let n=0;
        instance.adapter.sendTurn=async turn=>{
          const base=path.join(process.env.MURAGE_DATA_DIR,input.environment.HOLD_PREFIX+(++n));
          fs.writeFileSync(base+'.waiting',turn.threadId);
          await new Promise(resolve=>{const poll=setInterval(()=>{if(!fs.existsSync(base))return;clearInterval(poll);resolve();},20);});
          return send(turn);
        };
        return instance;
      };
      BUILT_IN_DRIVERS.push(driver);
      const dir=process.env.MURAGE_DATA_DIR;
      const file=path.join(dir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      for(const name of ${JSON.stringify(INSTANCES)})cfg.instances[name]={driver:'fakeLateTerminal',environment:{HOLD_PREFIX:name+'-hold-',FAKE_LATE_PLAIN_SESSION:'1',FAKE_LATE_MEMORY_MCP:'1',FAKE_LATE_DUMP:path.join(dir,name+'-dump')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    await login();
    await ensureLegacyJobs();
  }, 120000);
  afterAll(async () => { await fixture?.close(); });

  // Grok r4 High: the delete was allowed while the refused turn waited, never stopped the rebuild, and its reply landed on the deleted thread.
  it("a conversation delete while the refused turn waits is refused as for a working turn; the rebuilt reply lands, then it deletes", async () => {
    const hold = holds("rbdel");
    const bot = await newBot("Delete in the wait", "rbdel");
    const { other: threadId } = await secondThread(bot.id);
    const sent = await refuseAndWait("rbdel", hold, bot.id, threadId);
    expect(await taskBusy(bot.id, threadId)).toBe(true);
    const refused = await raw("DELETE", `/api/bots/${bot.id}/tasks/${threadId}`);
    expect(refused.status).toBe(409);
    expect(String(refused.body.error)).toMatch(/still working/);
    expect((await api("GET", `/api/bots/${bot.id}/tasks`)).tasks.map((task: any) => task.threadId)).toContain(threadId);
    // the rebuild goes on and answers on the conversation it was asked in
    await hold.pass(bot.id, threadId);
    await expect.poll(async () => await replies(threadId), { timeout: 60000 }).toBe(2);
    await expect.poll(async () => await taskBusy(bot.id, threadId), { timeout: 15000 }).toBe(false);
    expect(errorLines(await messages(threadId))).toEqual([]);
    expect((await raw("DELETE", `/api/bots/${bot.id}/tasks/${threadId}`)).status).toBe(200);
    await sleep(1000);
    expect(hold.idle()).toBe(true);
    expect(dispatches("rbdel", threadId)).toBe(sent + 1);
  }, 180000);

  // Grok r4 Medium: a bot delete reached only the rebuild on the bot's current thread.
  it("a bot delete while a refused turn waits on another of its conversations is refused, and nothing is deleted", async () => {
    const hold = holds("rbbot");
    const bot = await newBot("Bot delete in the wait", "rbbot");
    const { other: threadId } = await secondThread(bot.id);
    await refuseAndWait("rbbot", hold, bot.id, threadId);
    const refused = await raw("DELETE", `/api/bots/${bot.id}`);
    expect(refused.status).toBe(409);
    expect(String(refused.body.error)).toMatch(/Stop this bot's threads before deleting it/);
    expect((await api("GET", "/api/bots?messages=0")).bots.some((candidate: any) => candidate.id === bot.id)).toBe(true);
    await hold.pass(bot.id, threadId);
    await expect.poll(async () => await replies(threadId), { timeout: 60000 }).toBe(2);
    await expect.poll(async () => await taskBusy(bot.id, threadId), { timeout: 15000 }).toBe(false);
    expect((await raw("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
  }, 180000);

  it("a Stop in the wait ends the refused turn: working until the Stop, then idle, nothing started again and no card", async () => {
    const hold = holds("rbstop");
    const bot = await newBot("Stop in the wait", "rbstop");
    const threadId = bot.threadId;
    const sent = await refuseAndWait("rbstop", hold, bot.id, threadId);
    expect(await taskBusy(bot.id, threadId)).toBe(true);
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId });
    await expect.poll(async () => await taskBusy(bot.id, threadId), { timeout: 15000 }).toBe(false);
    // past the settle window: the rebuild never reached the engine
    await sleep(7000);
    expect(hold.idle()).toBe(true);
    expect(dispatches("rbstop", threadId)).toBe(sent);
    const all = await messages(threadId);
    expect(all.filter(isReply)).toHaveLength(1);
    expect(errorLines(all)).toEqual([]);
    // the thread is free: the next send runs
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "after the stop" })).queued).not.toBe(true);
    await passUntilReply(hold, bot.id, threadId, 2);
  }, 180000);

  // Overlap: a second turn could start (and be refused, and wait) beside the first one's rebuild.
  it("a second send in the wait queues behind the refused turn, which is rebuilt first", async () => {
    const hold = holds("rbsend");
    const bot = await newBot("Second send in the wait", "rbsend");
    const threadId = bot.threadId;
    const sent = await refuseAndWait("rbsend", hold, bot.id, threadId);
    const second = await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "a second question" });
    expect(second.queued).toBe(true);
    // nothing reached the engine for the second send while the first waits
    await sleep(1000);
    expect(hold.idle()).toBe(true);
    // the rebuild, then the queued send (each may meet the still-walking revoke once more and be rebuilt)
    await passUntilReply(hold, bot.id, threadId, 2);
    await passUntilReply(hold, bot.id, threadId, 3);
    await expect.poll(async () => await taskBusy(bot.id, threadId), { timeout: 15000 }).toBe(false);
    expect(dispatches("rbsend", threadId)).toBeGreaterThanOrEqual(sent + 2);
    expect(errorLines(await messages(threadId))).toEqual([]);
  }, 180000);

  // Last: it restarts the shared server.
  it("a restart in the wait leaves the thread free: working before, idle and deletable after, nothing started", async () => {
    const hold = holds("rbcrash");
    const bot = await newBot("Restart in the wait", "rbcrash");
    const { other: threadId } = await secondThread(bot.id);
    const sent = await refuseAndWait("rbcrash", hold, bot.id, threadId);
    expect(await taskBusy(bot.id, threadId)).toBe(true);
    await fixture.restart();
    await login();
    expect(await taskBusy(bot.id, threadId)).toBe(false);
    await sleep(7000);
    expect(dispatches("rbcrash", threadId)).toBe(sent);
    expect((await raw("DELETE", `/api/bots/${bot.id}/tasks/${threadId}`)).status).toBe(200);
  }, 180000);
});
