// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 revoke storm: on 1.0.2, 122 receipt flips made 122 audience-only revoke jobs, and while they were pending every room turn failed
// with MEMORY_CONTEXT_REVOKED. M1: the room fence judges the room's own prefix by content when the turn answers only to the owner (as direct
// chat and routines already did). M2: a refusal during dispatch that the submission boundary proved unwritten ends in the last rebuild
// (fresh session, no memory frame, no working context), as a late refusal always did. These run the real server with the fixture engine
// (server/testing/fake-late-terminal-driver.ts) over a data dir that holds 122 legacy audience jobs, as 1.0.2 left them: each one stays
// pending for the whole file, because its frontier node does not parse (the marker fails closed on it).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const LEGACY_JOBS = 122;
const FIRST_LEGACY_ID = 700001;
let fixture: VerificationServer, headers: Record<string, string>;
let keepDump: string, plainDump: string, unknownDump: string, unknownGate: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok).toBe(true);
  return await response.json() as any;
};
const login = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};
const rowsOf = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const log = () => existsSync(fixture.info.logPath) ? readFileSync(fixture.info.logPath, "utf8") : "";
const count = (text: string, needle: string) => text.split(needle).length - 1;
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
const isReply = (message: any) => message.role === "bot" && message.kind === "text" && message.text === "Hello from late";
const replies = async (threadId: string) => (await messages(threadId)).filter(isReply).length;
const errorLines = (all: any[]) => all.filter(message => String(message.tool?.name ?? "").startsWith("error:")).map(message => String(message.tool.name));
const botIdle = async (botId: string) => (await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === botId)?.busy !== true;
const newBot = async (name: string, instanceId: string) => {
  const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "late-1" } })).bot as { id: string; threadId: string };
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  return bot;
};
const newRoom = async (name: string, botId: string) => (await api("POST", "/api/groups", { name, memberIds: [botId], setup: { bulletin: "", defaultResponder: { kind: "member", botId } } })).group as { id: string; threadId: string };
/** One owner turn, answered: the reply lands and the bot is idle again. */
const turn = async (botId: string, threadId: string, text: string, room?: { id: string }) => {
  const before = await replies(threadId);
  await api("POST", room ? `/api/groups/${room.id}/messages` : `/api/bots/${botId}/messages`, { threadId, text });
  await expect.poll(async () => await replies(threadId), { timeout: 60000 }).toBe(before + 1);
  await expect.poll(async () => await botIdle(botId), { timeout: 15000 }).toBe(true);
};
const dbFile = () => join(fixture.info.dataDir, "messages.db");
const pendingLegacy = () => {
  const db = new DatabaseSync(dbFile(), { readOnly: true });
  try { return Number((db.prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id BETWEEN ? AND ? AND state='active'").get(FIRST_LEGACY_ID, FIRST_LEGACY_ID + LEGACY_JOBS - 1) as { n: number }).n); }
  finally { db.close(); }
};
/** What 1.0.2 left for 122 receipt flips: per receipt one audience-only job (kind receipt, cause receipt-revoked), its window over every thread
 * from a low lsn, and a frontier node the walk can never read. Idempotent. The server is restarted after it, so it reads the jobs afresh. */
const leaveLegacyJobs = async (clear: string[] = []) => {
  const db = new DatabaseSync(dbFile());
  db.exec("PRAGMA busy_timeout=10000");
  for (const threadId of clear) db.prepare("DELETE FROM messages WHERE thread_id=?").run(threadId);
  const root = JSON.stringify({ kind: "receipt", bundleId: "legacy-receipt", cause: "receipt-revoked" });
  const job = db.prepare("INSERT OR IGNORE INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'receipt',?,1,1,'mark','','active')");
  const audience = db.prepare("INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)");
  const pending = db.prepare("INSERT OR IGNORE INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',1,?)");
  const frontier = db.prepare("INSERT OR IGNORE INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,1,'{unreadable')");
  db.exec("BEGIN");
  for (let n = 0; n < LEGACY_JOBS; n++) {
    const id = FIRST_LEGACY_ID + n;
    job.run(id, root); audience.run(id); pending.run(id); frontier.run(id);
  }
  db.exec("COMMIT");
  db.close();
  await fixture.restart();
  await login();
};
const ensureLegacyJobs = async (clear: string[] = []) => { if (pendingLegacy() < LEGACY_JOBS) await leaveLegacyJobs(clear); expect(pendingLegacy()).toBe(LEGACY_JOBS); };

describe.skipIf(process.platform === "win32")("1.0.3 revoke storm", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path'); const sqlite=await import('node:sqlite');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      const driver=makeLateTerminalDriver();
      // HOLD_EACH: every sendTurn of the instance waits, after its prompt was built and before the engine submits it, for hold-<n> (n counts
      // the instance's dispatches; hold-<n>.waiting names the thread), so a test can land a revoke before each attempt's submission
      const create=driver.create.bind(driver);
      driver.create=async input=>{
        const instance=await create(input);
        if(input.environment.BUMP_GENERATION==='1'){
          // BUMP_GENERATION: deny_generation moves between every prompt build and its submission, as the live storm kept moving it, so the
          // send fence cannot take its unchanged fast path and must judge the refs against the pending windows
          const bump=instance.adapter.sendTurn.bind(instance.adapter);
          instance.adapter.sendTurn=async turn=>{
            const db=new sqlite.DatabaseSync(path.join(process.env.MURAGE_DATA_DIR,'messages.db'));
            try{db.exec('PRAGMA busy_timeout=10000');db.exec("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'");}finally{db.close();}
            const sent=await bump(turn);
            // an engine with no session reports none: its write is released a moment after the id is back, as ACP's is, so the harness has
            // accepted the turn when the fence refuses it
            const gate=input.environment.FAKE_LATE_SESSION_GATE; if(gate)setTimeout(()=>fs.writeFileSync(gate,''),100);
            return sent;
          };
          return instance;
        }
        if(input.environment.HOLD_EACH!=='1')return instance;
        const send=instance.adapter.sendTurn.bind(instance.adapter); let n=0;
        instance.adapter.sendTurn=async turn=>{
          const mine=++n, base=path.join(process.env.MURAGE_DATA_DIR,'hold-'+mine);
          fs.writeFileSync(base+'.waiting',turn.threadId);
          await new Promise(resolve=>{const poll=setInterval(()=>{if(!fs.existsSync(base))return;clearInterval(poll);resolve();},20);});
          return send(turn);
        };
        return instance;
      };
      BUILT_IN_DRIVERS.push(driver);
      const dir=process.env.MURAGE_DATA_DIR;
      const file=path.join(dir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.keep={driver:'fakeLateTerminal',environment:{BUMP_GENERATION:'1',FAKE_LATE_HANDBACK:'1',FAKE_LATE_SESSION:'1',FAKE_LATE_DUMP:path.join(dir,'keep-dump')}};
      cfg.instances.nosession={driver:'fakeLateTerminal',environment:{BUMP_GENERATION:'1',FAKE_LATE_HANDBACK:'1',FAKE_LATE_GATE_EACH:'1',FAKE_LATE_SESSION_GATE:path.join(dir,'ns-gate'),FAKE_LATE_DUMP:path.join(dir,'keep-dump')}};
      cfg.instances.plain={driver:'fakeLateTerminal',environment:{HOLD_EACH:'1',FAKE_LATE_DUMP:path.join(dir,'plain-dump')}};
      cfg.instances.unknown={driver:'fakeLateTerminal',environment:{FAKE_LATE_UNKNOWN_ACTION:'1',FAKE_LATE_SESSION_GATE:path.join(dir,'unknown-gate'),FAKE_LATE_DUMP:path.join(dir,'unknown-dump')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    keepDump = join(fixture.info.dataDir, "keep-dump");
    plainDump = join(fixture.info.dataDir, "plain-dump");
    unknownDump = join(fixture.info.dataDir, "unknown-dump");
    unknownGate = join(fixture.info.dataDir, "unknown-gate");
    await login();
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("turns in direct chat, routines and rooms complete while 122 legacy jobs are pending", async () => {
    expect((await api("GET", "/api/memory/status")).mode).toBe("active");
    // The room goes first: its member has no other conversation and nothing of another thread exists yet to be remembered, so the room's
    // prompt shows no line of another thread. What the audience windows can then refuse is only the room's own prefix, which an
    // owner-audience room reads by content (M1). Direct chat and routines are content readers throughout. The room's engine reports no
    // session: a retained session is judged for the audience by the receipt's own acceptance check, a separate path from the fence.
    const roomBot = await newBot("Storm member", "nosession");
    const room = await newRoom("Storm room", roomBot.id);
    // the member's own chat holds only its greeting, which the room would show as working context: a line of another thread, which an
    // audience reader may not read while the windows are pending. It is cleared, so the room's own prefix is all the prompt rests on.
    await ensureLegacyJobs([roomBot.threadId]);
    // deny_generation moves between every prompt build and its submission (the fixture engine bumps it), as the live storm kept moving it:
    // the send fence cannot take its unchanged fast path and judges the refs against the 122 audience windows
    await turn(roomBot.id, room.threadId, "a room question under the storm", room);
    const bot = await newBot("Storm", "keep");
    await turn(bot.id, bot.threadId, "first direct question");
    await turn(bot.id, bot.threadId, "a direct question under the storm");
    const marks = { direct: errorLines(await messages(bot.threadId)).length, room: errorLines(await messages(room.threadId)).length };
    // a routine run: the API runs it now, in its own conversation
    const routine = (await api("POST", "/api/routines", { botId: bot.id, name: "Storm check", prompt: "Please answer briefly.", schedule: { type: "once", at: Date.now() + 3_600_000 } })).routine;
    const started = (await api("POST", `/api/routines/${routine.id}/run`, {})).run as { id: string; threadId?: string };
    let routineThread = started.threadId ?? "";
    await expect.poll(async () => {
      if (!routineThread) routineThread = ((await api("GET", "/api/routines")).runs as any[]).find(run => run.id === started.id)?.threadId ?? "";
      return routineThread ? await replies(routineThread) : 0;
    }, { timeout: 60000 }).toBe(1);
    await expect.poll(async () => await botIdle(bot.id), { timeout: 15000 }).toBe(true);
    for (const threadId of [bot.threadId, room.threadId, routineThread]) expect(errorLines(await messages(threadId)).slice(threadId === bot.threadId ? marks.direct : threadId === room.threadId ? marks.room : 0)).toEqual([]);
    expect(await messages(room.threadId)).not.toContainEqual(expect.objectContaining({ tool: expect.objectContaining({ name: expect.stringMatching(/without remembered context/) }) }));
    // no turn was refused for the pending revokes, in any of the three places
    const text = log();
    for (const threadId of [bot.threadId, room.threadId, routineThread]) {
      expect(count(text, `context revoked during dispatch on thread ${threadId}`)).toBe(0);
      expect(count(text, `context revoked at a late submission on thread ${threadId}`)).toBe(0);
    }
    // every dispatch of the room wrote its prompt: nothing was refused at the late write
    const mine = rowsOf(keepDump).filter(row => row.threadId === room.threadId);
    expect(mine.filter(row => row.prompt)).toHaveLength(mine.filter(row => !row.prompt).length);
    // the storm itself is untouched: all 122 jobs are still pending
    expect(pendingLegacy()).toBe(LEGACY_JOBS);
  }, 300000);

  it("an owner room on an engine that keeps its session completes every turn while 122 legacy jobs are pending", async () => {
    // The same storm as above, with a member whose engine reports a native session (session.started) on every turn: the session it keeps
    // is the room's own, which an owner-audience room reads by content (r2 R4), so no audience window refuses or re-prepares any turn.
    const roomBot = await newBot("Storm keeper", "keep");
    const room = await newRoom("Keeper room", roomBot.id);
    await leaveLegacyJobs([roomBot.threadId]);
    expect(pendingLegacy()).toBe(LEGACY_JOBS);
    const sessionsBefore = count(log(), "context revoked");
    await turn(roomBot.id, room.threadId, "a first room question under the storm", room);
    await turn(roomBot.id, room.threadId, "a second room question under the storm", room);
    await turn(roomBot.id, room.threadId, "a third room question under the storm", room);
    const all = await messages(room.threadId);
    expect(all.filter(isReply)).toHaveLength(3);
    expect(errorLines(all)).toEqual([]);
    expect(all.some(message => /without remembered context/.test(String(message.tool?.name ?? "")))).toBe(false);
    const text = log();
    expect(count(text, `context revoked during dispatch on thread ${room.threadId}`)).toBe(0);
    expect(count(text, `context revoked at a late submission on thread ${room.threadId}`)).toBe(0);
    expect(count(text, `memory continuation reset thread=${room.threadId}`)).toBe(0);
    expect(count(text, "context revoked") - sessionsBefore).toBe(0);
    // every dispatch of the room wrote its prompt, and each one reported its session
    const mine = rowsOf(keepDump).filter(row => row.threadId === room.threadId);
    expect(mine.filter(row => !row.prompt)).toHaveLength(3);
    expect(mine.filter(row => row.prompt)).toHaveLength(3);
    expect(pendingLegacy()).toBe(LEGACY_JOBS);
  }, 300000);

  it("room: the last rebuild runs after dispatch refusals proven unwritten", async () => {
    await ensureLegacyJobs();
    rmSync(plainDump, { force: true });
    const bot = await newBot("Rebuilder", "plain");
    const room = await newRoom("Rebuild room", bot.id);
    const warned = count(log(), "re-preparing");
    await api("POST", `/api/groups/${room.id}/messages`, { threadId: room.threadId, text: "a room question under the storm" });
    // a revoke lands after each attempt's prompt was built and before the engine submits it: the first three are refused (proven unwritten)
    // and re-dispatched, and the fourth, the last rebuild, still passes
    for (let attempt = 1; attempt <= 4; attempt++) {
      await expect.poll(() => existsSync(join(fixture.info.dataDir, `hold-${attempt}.waiting`)), { timeout: 60000 }).toBe(true);
      expect(readFileSync(join(fixture.info.dataDir, `hold-${attempt}.waiting`), "utf8")).toBe(room.threadId);
      await api("PATCH", `/api/bots/${bot.id}`, { section: `Revoke before submission ${attempt}` });
      writeFileSync(join(fixture.info.dataDir, `hold-${attempt}`), "");
    }
    await expect.poll(async () => await replies(room.threadId), { timeout: 60000 }).toBe(1);
    await expect.poll(async () => await botIdle(bot.id), { timeout: 15000 }).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 500));
    const text = log();
    const mine = rowsOf(plainDump).filter(row => row.threadId === room.threadId);
    expect(existsSync(join(fixture.info.dataDir, "hold-5.waiting"))).toBe(false);
    const all = await messages(room.threadId);
    // refused at dispatch, re-prepared three times, then the last rebuild ran: four dispatches, one reply
    expect(count(text, `context revoked during dispatch on thread ${room.threadId}; re-preparing (1 of 3, room member`)).toBe(1);
    expect(count(text, `context revoked during dispatch on thread ${room.threadId}; re-preparing (3 of 3, room member`)).toBe(1);
    expect(count(text, `re-preparing`) - warned).toBe(3);
    expect(mine).toHaveLength(4);
    expect(all.filter(isReply)).toHaveLength(1);
    expect(all.filter(message => message.role === "bot" && message.kind === "activity" && /without remembered context/.test(String(message.tool?.name ?? "")))).toHaveLength(1);
    expect(errorLines(all)).toEqual([]);
    expect(all.some(message => /MEMORY_CONTEXT_REVOKED/.test(String(message.tool?.name ?? "")))).toBe(false);
    expect(pendingLegacy()).toBe(LEGACY_JOBS);
  }, 300000);

  it("room: a dispatch refusal that may have started keeps its line and is not re-dispatched", async () => {
    for (const file of [unknownGate, `${unknownGate}.waiting`, unknownDump]) rmSync(file, { force: true });
    const bot = await newBot("Unknown", "unknown");
    const room = await newRoom("Unknown room", bot.id);
    await api("POST", `/api/groups/${room.id}/messages`, { threadId: room.threadId, text: "hello unknown" });
    // the engine took the turn and has done a real side effect (its dump line); the receipt is revoked before the server accepts it
    await expect.poll(() => existsSync(`${unknownGate}.waiting`), { timeout: 20000 }).toBe(true);
    await api("PATCH", `/api/bots/${bot.id}`, { section: "Revoke while the boundary is unknown" });
    writeFileSync(unknownGate, "");
    const line = "error: Context changed; previous attempt may have started. Review its output before trying again.";
    await expect.poll(async () => (await messages(room.threadId)).some(message => String(message.tool?.name ?? "") === line), { timeout: 30000 }).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const all = await messages(room.threadId);
    expect(all.filter(message => String(message.tool?.name ?? "") === line)).toHaveLength(1);
    expect(all.some(message => /without remembered context/.test(String(message.tool?.name ?? "")))).toBe(false);
    expect(all.filter(isReply)).toHaveLength(0);
    // one dispatch only, and no re-preparation for this thread
    expect(rowsOf(unknownDump).filter(row => row.threadId === room.threadId && !row.prompt)).toHaveLength(1);
    expect(count(log(), `context revoked during dispatch on thread ${room.threadId}`)).toBe(0);
  }, 120000);
});
