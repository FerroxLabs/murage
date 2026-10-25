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
  // a legacy job is pending while it is active, or folded into a fold bulk that has not finished (1.0.3 REVOKE-FOLD-DESIGN: the backlog is one walk)
  try { return Number((db.prepare(`SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id BETWEEN ? AND ? AND (state='active' OR (state='folded' AND revoke_id IN
    (SELECT f.old_id FROM memory_revoke_fold f JOIN memory_revoke_jobs b ON b.revoke_id=f.bulk_id WHERE b.state IN ('active','seeding'))))`).get(FIRST_LEGACY_ID, FIRST_LEGACY_ID + LEGACY_JOBS - 1) as { n: number }).n); }
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
          const mine=++n, base=path.join(process.env.MURAGE_DATA_DIR,(input.environment.HOLD_PREFIX||'hold-')+mine);
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
      // a long chat on an engine that keeps its session (Claude's shape: the id comes back with the submission), holds named keephold-<n>
      cfg.instances.plainkeep={driver:'fakeLateTerminal',environment:{HOLD_EACH:'1',HOLD_PREFIX:'keephold-',FAKE_LATE_PLAIN_SESSION:'1',FAKE_LATE_MEMORY_MCP:'1',FAKE_LATE_DUMP_CONTEXT:'1',FAKE_LATE_DUMP:path.join(dir,'plainkeep-dump')}};
      // 1.0.4 EDIT-REBUILD-LOOP: the same long-chat engine for an edited message (edithold-<n>), a restart mid-rebuild (editrest-<n>), and a
      // room member (roomhold-<n>)
      cfg.instances.editkeep={driver:'fakeLateTerminal',environment:{HOLD_EACH:'1',HOLD_PREFIX:'edithold-',FAKE_LATE_PLAIN_SESSION:'1',FAKE_LATE_MEMORY_MCP:'1',FAKE_LATE_DUMP_CONTEXT:'1',FAKE_LATE_DUMP:path.join(dir,'editkeep-dump')}};
      cfg.instances.editrest={driver:'fakeLateTerminal',environment:{HOLD_EACH:'1',HOLD_PREFIX:'editrest-',FAKE_LATE_PLAIN_SESSION:'1',FAKE_LATE_MEMORY_MCP:'1',FAKE_LATE_DUMP_CONTEXT:'1',FAKE_LATE_DUMP:path.join(dir,'editrest-dump')}};
      cfg.instances.roomedit={driver:'fakeLateTerminal',environment:{HOLD_EACH:'1',HOLD_PREFIX:'roomhold-',FAKE_LATE_DUMP_CONTEXT:'1',FAKE_LATE_DUMP:path.join(dir,'roomedit-dump')}};
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

  it("a room member that keeps its own direct chat: every room turn is answered while 122 legacy jobs are pending (re-prepares recorded)", async () => {
    // The preflight case (1.0.3 revoke drain findings, "The 39 re-prepares"): the member also has a direct chat, which the room shows as working
    // context. That is a line of another thread, read for the room's audience, so the pending audience windows may refuse it ("checking");
    // M1 adds no exemption. The turns must still be answered; how many re-prepares they cost is recorded, with the fence's counts-only line.
    const roomBot = await newBot("Storm talker", "nosession");
    await ensureLegacyJobs();
    await turn(roomBot.id, roomBot.threadId, "a direct question that stays in the member's own chat");
    const room = await newRoom("Talker room", roomBot.id);
    const before = log();
    const turns = 3;
    for (let n = 1; n <= turns; n++) await turn(roomBot.id, room.threadId, `room question ${n} under the storm`, room);
    const all = await messages(room.threadId);
    expect(all.filter(isReply)).toHaveLength(turns);
    expect(errorLines(all)).toEqual([]);
    expect(all.some(message => /MEMORY_CONTEXT_REVOKED/.test(String(message.tool?.name ?? "")))).toBe(false);
    const text = log().slice(before.length);
    const reprepares = count(text, `context revoked during dispatch on thread ${room.threadId}; re-preparing`);
    const lastRebuilds = all.filter(message => /without remembered context/.test(String(message.tool?.name ?? ""))).length;
    const fenceLines = text.split("\n").filter(line => line.includes("[memory] send fence refused"));
    // counts only: the refused parts by kind and verdict, never a thread, an id or any text
    for (const line of fenceLines) expect(line).toMatch(/send fence refused \([a-z]+:[a-z-]+, (content|audience) reader\): \d+ of \d+ parts; refused refs: [a-z0-9 ,-]+; verdicts: [a-z0-9 ,:-]+/);
    for (const line of fenceLines) expect(line).not.toContain(room.threadId);
    for (const line of fenceLines) expect(line).not.toContain(roomBot.threadId);
    const refusedKinds = fenceLines.map(line => /refused refs: ([^;]*);/.exec(line)?.[1] ?? "?");
    console.log(`REPREPARE ${JSON.stringify({ turns, reprepares, lastRebuilds, fenceRefusals: fenceLines.length, refusedKinds })}`);
    // at most the bounded rebuilds per turn: every turn completes
    expect(reprepares).toBeLessThanOrEqual(turns * 3);
    expect(fenceLines.length).toBeGreaterThanOrEqual(reprepares);
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

  // 1.0.4 SETUP-LAST-RESORT (Sean, 1.0.3): a long existing chat whose turn is refused at its send, before anything was written, at every
  // attempt (a revoke walk still pending, a revoke before each submission) ended with "could not start this reply. Send it again.": the
  // direct setup path rebuilt three times with memory and never ran the last resort the late path and rooms run. Now the third rebuild is
  // the last resort: a fresh session (no resume, sessionReset), no memory frame, no memory or thread tools, and the reply runs.
  it("direct: a long chat refused at setup at every attempt ends with a reply from the last resort, a fresh session with no memory", async () => {
    await ensureLegacyJobs();
    const dump = join(fixture.info.dataDir, "plainkeep-dump");
    rmSync(dump, { force: true });
    const hold = (n: number) => join(fixture.info.dataDir, `keephold-${n}`);
    const bot = await newBot("Long chat", "plainkeep");
    let held = 0;
    const release = async (revoke?: string) => {
      held++;
      await expect.poll(() => existsSync(`${hold(held)}.waiting`), { timeout: 60000 }).toBe(true);
      expect(readFileSync(`${hold(held)}.waiting`, "utf8")).toBe(bot.threadId);
      if (revoke) await api("PATCH", `/api/bots/${bot.id}`, { section: revoke });
      writeFileSync(hold(held), "");
    };
    // the long chat: earlier turns, each resuming the session the engine keeps
    for (let n = 1; n <= 3; n++) {
      const before = await replies(bot.threadId);
      await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `an earlier question ${n}` });
      await release();
      await expect.poll(async () => await replies(bot.threadId), { timeout: 60000 }).toBe(before + 1);
      await expect.poll(async () => await botIdle(bot.id), { timeout: 15000 }).toBe(true);
    }
    const warned = count(log(), "re-preparing");
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "the question that kept being refused" });
    // a revoke lands after each attempt's prompt was built and before the engine submits it: the first and two rebuilds are refused (proven
    // unwritten), and the third rebuild, the last resort, still passes
    for (let attempt = 1; attempt <= 4; attempt++) await release(`Revoke before direct submission ${attempt}`);
    await expect.poll(async () => await replies(bot.threadId), { timeout: 60000 }).toBe(4);
    await expect.poll(async () => await botIdle(bot.id), { timeout: 15000 }).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 500));
    const text = log();
    const all = await messages(bot.threadId);
    const rows = rowsOf(dump).filter(row => row.threadId === bot.threadId);
    // three earlier dispatches and four for the refused turn; no fifth
    expect(rows).toHaveLength(7);
    expect(existsSync(`${hold(held + 1)}.waiting`)).toBe(false);
    // it was a long chat: the earlier turns after the first resumed the kept session, memory on
    expect(rows[1]).toMatchObject({ resumed: true, sessionReset: false });
    expect(rows[2]).toMatchObject({ resumed: true, sessionReset: false });
    const refused = rows.slice(3);
    expect(refused[0]).toMatchObject({ memory: true });
    expect(refused[1]).toMatchObject({ memory: true });
    expect(refused[2]).toMatchObject({ memory: true });
    // the last resort carries no revoked memory: no memory frame, no memory or thread tools, and no retained session to carry it
    expect(refused[3]).toMatchObject({ memoryContext: false, memory: false, sessionReset: true, resumed: false });
    expect(count(text, `context revoked during dispatch on thread ${bot.threadId}; re-preparing (1 of 3)`)).toBe(1);
    expect(count(text, `context revoked during dispatch on thread ${bot.threadId}; re-preparing (3 of 3)`)).toBe(1);
    expect(count(text, `re-preparing`) - warned).toBe(3);
    expect(count(text, `context revoked during dispatch on thread ${bot.threadId} after`)).toBe(0);
    // one reply for the refused turn, one plain line saying it ran without remembered context, never the card or the raw code
    expect(all.filter(isReply)).toHaveLength(4);
    expect(all.filter(message => message.role === "bot" && message.kind === "activity" && /without remembered context/.test(String(message.tool?.name ?? "")))).toHaveLength(1);
    expect(errorLines(all)).toEqual([]);
    expect(all.some(message => /could not start this reply|MEMORY_CONTEXT_REVOKED/.test(String(message.tool?.name ?? "")))).toBe(false);
    expect(pendingLegacy()).toBe(LEGACY_JOBS);
  }, 300000);

  // 1.0.4 EDIT-REBUILD-LOOP (Sean, 10-21 01:02, 10-21 12:45, 10-23 09:56): an edited message refused at the send check was rebuilt with
  // `editedMessageId` still set, so every rebuild forked a new copy of the edit, that branch change revoked the thread again, and the turn
  // refused itself until the card: "could not start this reply", up to four copies of the edit, a reset bot. A rebuild now reuses the fork.
  const editForks = (threadId: string, text: string) => {
    const db = new DatabaseSync(dbFile(), { readOnly: true });
    try { return Number((db.prepare("SELECT count(*) AS n FROM messages WHERE thread_id=? AND role='user' AND text=?").get(threadId, text) as { n: number }).n); }
    finally { db.close(); }
  };
  const BRANCH_CHANGE = "memory receipts revoked scope=thread cause=branch-change";
  const holdOf = (prefix: string) => (n: number) => join(fixture.info.dataDir, `${prefix}${n}`);
  const releaseHold = async (hold: (n: number) => string, n: number, threadId: string, botId: string, revoke?: string) => {
    await expect.poll(() => existsSync(`${hold(n)}.waiting`), { timeout: 60000 }).toBe(true);
    expect(readFileSync(`${hold(n)}.waiting`, "utf8")).toBe(threadId);
    if (revoke) await api("PATCH", `/api/bots/${botId}`, { section: revoke });
    writeFileSync(hold(n), "");
  };
  const userMessageId = async (threadId: string, text: string) => (await messages(threadId)).find(message => message.role === "user" && message.text === text)?.id as string;
  const editSendId = (tag: string) => `edit-${tag}-${Date.now()}-0000000000`.slice(0, 64);

  it("direct: an edit refused at the send check forks once, revokes once for the branch change, and the last resort replies on rebuild 3", async () => {
    await ensureLegacyJobs();
    const dump = join(fixture.info.dataDir, "editkeep-dump");
    rmSync(dump, { force: true });
    const hold = holdOf("edithold-");
    const bot = await newBot("Editor", "editkeep");
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "the question before the edit" });
    await releaseHold(hold, 1, bot.threadId, bot.id);
    await expect.poll(async () => await replies(bot.threadId), { timeout: 60000 }).toBe(1);
    await expect.poll(async () => await botIdle(bot.id), { timeout: 15000 }).toBe(true);
    const source = await userMessageId(bot.threadId, "the question before the edit");
    expect(source).toBeTruthy();
    const before = log();
    const edited = "the edited question that kept being refused";
    const editing = api("POST", `/api/bots/${bot.id}/messages/${source}/edit`, { threadId: bot.threadId, text: edited, sendId: editSendId("once") });
    // a revoke lands after each attempt's prompt was built and before the engine submits it: the edit's first send and two rebuilds are
    // refused (proven unwritten), and the third rebuild, the last resort, still passes
    for (let attempt = 1; attempt <= 4; attempt++) await releaseHold(hold, attempt + 1, bot.threadId, bot.id, `Revoke before edited submission ${attempt}`);
    await editing;
    const answeredAfterEdit = async () => { const all = await messages(bot.threadId); const at = all.findIndex(message => message.role === "user" && message.text === edited); return at >= 0 && all.slice(at + 1).some(isReply); };
    await expect.poll(answeredAfterEdit, { timeout: 60000 }).toBe(true);
    await expect.poll(async () => await botIdle(bot.id), { timeout: 15000 }).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 500));
    const text = log().slice(before.length);
    const rows = rowsOf(dump).filter(row => row.threadId === bot.threadId);
    // one earlier dispatch and four for the edit; no fifth
    expect(rows).toHaveLength(5);
    expect(existsSync(`${hold(6)}.waiting`)).toBe(false);
    // ONE copy of the edit, and ONE branch-change revoke: the edit's own fork, never one per rebuild
    expect(editForks(bot.threadId, edited)).toBe(1);
    expect(editForks(bot.threadId, "the question before the edit")).toBe(1);
    expect(count(text, BRANCH_CHANGE)).toBe(1);
    expect(count(text, `context revoked during dispatch on thread ${bot.threadId}; re-preparing (1 of 3)`)).toBe(1);
    expect(count(text, `context revoked during dispatch on thread ${bot.threadId}; re-preparing (3 of 3)`)).toBe(1);
    expect(count(text, `context revoked during dispatch on thread ${bot.threadId} after`)).toBe(0);
    const refused = rows.slice(1);
    expect(refused[0]).toMatchObject({ memory: true });
    // the rebuilds keep the rewind the edit's first send had (no resumed session of the abandoned branch)
    expect(refused.every(row => row.resumed === false)).toBe(true);
    expect(refused[3]).toMatchObject({ memoryContext: false, memory: false, sessionReset: true, resumed: false });
    // the visible branch: the edit and its one reply, one plain line for the last resort, never the card
    const all = await messages(bot.threadId);
    const afterEdit = all.slice(all.findIndex(message => message.role === "user" && message.text === edited) + 1);
    expect(all.filter(message => message.role === "user").at(-1)?.text).toBe(edited);
    expect(afterEdit.filter(isReply)).toHaveLength(1);
    expect(afterEdit.filter(message => message.role === "bot" && message.kind === "activity" && /without remembered context/.test(String(message.tool?.name ?? "")))).toHaveLength(1);
    expect(errorLines(all)).toEqual([]);
    expect(all.some(message => /could not start this reply|MEMORY_CONTEXT_REVOKED/.test(String(message.tool?.name ?? "")))).toBe(false);
    expect(pendingLegacy()).toBe(LEGACY_JOBS);
  }, 300000);

  it("room: a member turn refused at every send check rebuilds on its one prompt row: no copy, no branch-change revoke, the last resort replies", async () => {
    // rooms have no edit-and-rerun (the edit route is direct chat only): a member rebuild re-runs runGroupMemberTurn on the room's own
    // prompt row, and must stay that way, the same as a direct edit's rebuild now is
    await ensureLegacyJobs();
    const dump = join(fixture.info.dataDir, "roomedit-dump");
    rmSync(dump, { force: true });
    const hold = holdOf("roomhold-");
    const bot = await newBot("Room editor", "roomedit");
    const room = await newRoom("Edit room", bot.id);
    const before = log();
    const asked = "a room question refused at every send check";
    await api("POST", `/api/groups/${room.id}/messages`, { threadId: room.threadId, text: asked });
    for (let attempt = 1; attempt <= 4; attempt++) await releaseHold(hold, attempt, room.threadId, bot.id, `Revoke before room submission ${attempt}`);
    await expect.poll(async () => await replies(room.threadId), { timeout: 60000 }).toBe(1);
    await expect.poll(async () => await botIdle(bot.id), { timeout: 15000 }).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 500));
    const text = log().slice(before.length);
    expect(rowsOf(dump).filter(row => row.threadId === room.threadId)).toHaveLength(4);
    expect(existsSync(`${hold(5)}.waiting`)).toBe(false);
    expect(editForks(room.threadId, asked)).toBe(1);
    expect(count(text, BRANCH_CHANGE)).toBe(0);
    expect(count(text, `context revoked during dispatch on thread ${room.threadId}; re-preparing (3 of 3, room member`)).toBe(1);
    const all = await messages(room.threadId);
    expect(all.filter(isReply)).toHaveLength(1);
    expect(all.filter(message => message.role === "bot" && message.kind === "activity" && /without remembered context/.test(String(message.tool?.name ?? "")))).toHaveLength(1);
    expect(errorLines(all)).toEqual([]);
    expect(pendingLegacy()).toBe(LEGACY_JOBS);
  }, 300000);

  it("direct: a restart while an edit is being rebuilt leaves one copy of the edit, and the edit's retry answers with that copy", async () => {
    await ensureLegacyJobs();
    const hold = holdOf("editrest-");
    const bot = await newBot("Restart editor", "editrest");
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "the question before the restart" });
    await releaseHold(hold, 1, bot.threadId, bot.id);
    await expect.poll(async () => await replies(bot.threadId), { timeout: 60000 }).toBe(1);
    await expect.poll(async () => await botIdle(bot.id), { timeout: 15000 }).toBe(true);
    const source = await userMessageId(bot.threadId, "the question before the restart");
    const before = log();
    const edited = "the edited question cut short by a restart";
    const sendId = editSendId("restart");
    const editing = api("POST", `/api/bots/${bot.id}/messages/${source}/edit`, { threadId: bot.threadId, text: edited, sendId }).catch(() => undefined);
    // the edit's first send is refused; its first rebuild is built and held at its submission when the server restarts
    await releaseHold(hold, 2, bot.threadId, bot.id, "Revoke before the edit, then restart");
    await expect.poll(() => existsSync(`${hold(3)}.waiting`), { timeout: 60000 }).toBe(true);
    expect(editForks(bot.threadId, edited)).toBe(1);
    const firstLog = log().slice(before.length);
    await fixture.restart();
    await login();
    await editing;
    // the restarted process counts its holds from 1 again
    for (let n = 1; n <= 8; n++) for (const file of [hold(n), `${hold(n)}.waiting`]) rmSync(file, { force: true });
    // the client repeats the edit with its sendId: the server answers with the fork it made, and forks nothing
    const retried = await api("POST", `/api/bots/${bot.id}/messages/${source}/edit`, { threadId: bot.threadId, text: edited, sendId });
    expect(retried.message?.text).toBe(edited);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const text = firstLog + log();
    expect(editForks(bot.threadId, edited)).toBe(1);
    expect(count(text, BRANCH_CHANGE)).toBe(1);
    expect((await messages(bot.threadId)).filter(message => message.role === "user").at(-1)?.text).toBe(edited);
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
