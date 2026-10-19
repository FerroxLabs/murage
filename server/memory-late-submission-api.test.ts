// An adapter can hand its turn id back before it writes the prompt (ACP,
// Codex). The submission fence runs again right before that later write, and
// a revoke in between is refused there: nothing is written, the turn settles
// failed, and the server re-runs it on fresh context (round 3, item 1), up to
// three times; past that the turn ends with a card, never silently (1.0.3
// engine-switch). Also here: the revoke walk marks only the sessions that held
// the revoked line, and a bot frame reads no message row per task.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { INLINE_REVOCATION } from "./memory/memory-revocation.ts";
import { addTurnParents, closeTurnLineage, memberTurnId, openTurnLineage, runningTurnFor, supersedeMemberTurns, writeLineage, writeSessionLineage } from "./memory/lineage-write.ts";
import type { TurnLineage } from "./memory/lineage-types.ts";
import { activateBulkRevoke, commitRevoke, openBulkRevoke } from "./memory/revoke-commit.ts";
import { markerSlice } from "./memory/revoke-marker.ts";
import { denyGeneration, fenceVerdict, refsLookup, sessionLookup } from "./memory/deny-read.ts";
import { buildPrompt, promptPart } from "./memory/prompt-parts.ts";
import { CONTENT, WritetimeFixture } from "./memory/testing/writetime-fixture.ts";

let fixture: VerificationServer, gate: string, dump: string, eachGate: string, eachDump: string, newestReads: string, headers: Record<string,string>;
const api = async (method:string,path:string,body?:unknown) => {
  const response=await fetch(`${fixture.info.url}${path}`,{method,headers:{"content-type":"application/json",...headers},body:body===undefined?undefined:JSON.stringify(body)});
  expect(response.ok).toBe(true);
  return await response.json() as any;
};
const rowsOf=(file:string)=>existsSync(file)?readFileSync(file,"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)):[];
const rows=()=>rowsOf(dump);
describe.skipIf(process.platform==="win32")("memory refusal at a late submission",()=>{
  beforeAll(async()=>{
    fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
      const fs=await import('node:fs'); const path=await import('node:path'); const sqlite=await import('node:sqlite');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(),"server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(),"server/testing/fake-late-terminal-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.handback={driver:'fakeLateTerminal',environment:{FAKE_LATE_HANDBACK:'1',FAKE_LATE_SESSION_GATE:path.join(process.env.MURAGE_DATA_DIR,'handback-gate'),FAKE_LATE_DUMP:path.join(process.env.MURAGE_DATA_DIR,'handback-dump')}};
      cfg.instances.handbackeach={driver:'fakeLateTerminal',environment:{FAKE_LATE_HANDBACK:'1',FAKE_LATE_GATE_EACH:'1',FAKE_LATE_SESSION_GATE:path.join(process.env.MURAGE_DATA_DIR,'each-gate'),FAKE_LATE_DUMP:path.join(process.env.MURAGE_DATA_DIR,'each-dump')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
      // every read of a thread's newest message row (message-db.ts newestMessageAt), counted for the bot-frame case
      const reads=path.join(process.env.MURAGE_DATA_DIR,'newest-reads'); const prepare=sqlite.DatabaseSync.prototype.prepare;
      sqlite.DatabaseSync.prototype.prepare=function(sql){ if(typeof sql==='string'&&sql.startsWith('SELECT at FROM messages WHERE thread_id = ? ORDER BY rowid DESC'))fs.appendFileSync(reads,'x'); return prepare.call(this,sql); };
    `});
    gate=join(fixture.info.dataDir,"handback-gate");dump=join(fixture.info.dataDir,"handback-dump");
    eachGate=join(fixture.info.dataDir,"each-gate");eachDump=join(fixture.info.dataDir,"each-dump");newestReads=join(fixture.info.dataDir,"newest-reads");
    const proof=await(await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as {secret:string};
    headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.secret};
  },30000);
  afterAll(async()=>{await fixture?.close();});
  for(const room of [false,true])it(`${room?"room":"direct"}: nothing is written, and the turn runs once more`,async()=>{
    for(const file of [gate,`${gate}.waiting`,dump])rmSync(file,{force:true});
    const bot=(await api("POST","/api/bots",{name:`Handback ${room?"room":"direct"}`,modelSelection:{instanceId:"handback",model:"late-1"}})).bot;
    await api("PATCH",`/api/bots/${bot.id}`,{computer:"off",browser:false,composio:false});
    const group=room?(await api("POST","/api/groups",{name:"Handback room",memberIds:[bot.id],setup:{bulletin:"",defaultResponder:{kind:"member",botId:bot.id}}})).group:undefined;
    const threadId=group?.threadId??bot.threadId;
    expect((await api("GET","/api/memory/status")).mode).toBe("active");
    await api("POST",room?`/api/groups/${group.id}/messages`:`/api/bots/${bot.id}/messages`,{threadId,text:"hello there"});
    // the id is back and the prompt not yet written: the revoke lands now
    await expect.poll(()=>existsSync(`${gate}.waiting`),{timeout:15000}).toBe(true);
    await api("PATCH",`/api/bots/${bot.id}`,{section:"Revoke after handback"});
    writeFileSync(gate,"");
    const replies=async()=>((await api("GET",`/api/threads/${threadId}/messages?limit=100`)).messages as any[]);
    await expect.poll(async()=>(await replies()).some(message=>message.role==="bot"&&message.kind==="text"&&message.text==="Hello from late"),{timeout:20000}).toBe(true);
    const mine=rows().filter(row=>row.threadId===threadId);
    // two dispatches, and only the second one wrote its prompt
    expect(mine.filter(row=>!row.prompt)).toHaveLength(2);
    expect(mine.filter(row=>row.prompt)).toHaveLength(1);
    expect(mine.find(row=>row.prompt)?.turnId).toBe(mine.filter(row=>!row.prompt)[1]?.turnId);
    expect((await replies()).filter(message=>String(message.tool?.name??"").startsWith("error:")).map(message=>message.tool.name)).toEqual([]);
  },60000);
  // 1.0.3 engine-switch, then 1.0.2 Keep all P0 (F3): a revoke lands before every late write, the first dispatch and each rebuild. The
  // first three are refused and rebuilt after the walk settles; the third rebuild is the last one, a fresh session with no memory frame
  // whose prompt rests only on lines judged shown as it was built, so it passes the fence and the reply runs, with one plain line saying it
  // ran without remembered context. Before: the second refusal returned early and the fold posted nothing, then a "Try again" card forever.
  for(const room of [false,true])it(`${room?"room":"direct"}: a refusal at every late write ends with a reply from the last rebuild, which says it ran without memory`,async()=>{
    for(const file of [eachGate,`${eachGate}.waiting`,eachDump])rmSync(file,{force:true});
    const bot=(await api("POST","/api/bots",{name:`Each ${room?"room":"direct"}`,modelSelection:{instanceId:"handbackeach",model:"late-1"}})).bot;
    await api("PATCH",`/api/bots/${bot.id}`,{computer:"off",browser:false,composio:false});
    const group=room?(await api("POST","/api/groups",{name:"Each room",memberIds:[bot.id],setup:{bulletin:"",defaultResponder:{kind:"member",botId:bot.id}}})).group:undefined;
    const threadId=group?.threadId??bot.threadId;
    await api("POST",room?`/api/groups/${group.id}/messages`:`/api/bots/${bot.id}/messages`,{threadId,text:"hello every time"});
    const seen=new Set<string>();
    for(let attempt=1;attempt<=4;attempt++){
      // this attempt's id is back and its prompt not yet written: a revoke lands before every write
      await expect.poll(()=>{ try { const id=readFileSync(`${eachGate}.waiting`,"utf8"); return id&&!seen.has(id)?id:""; } catch { return ""; } },{timeout:20000}).not.toBe("");
      seen.add(readFileSync(`${eachGate}.waiting`,"utf8"));
      await api("PATCH",`/api/bots/${bot.id}`,{section:`Revoke before write ${attempt}`});
      writeFileSync(eachGate,"");
    }
    const messages=async()=>((await api("GET",`/api/threads/${threadId}/messages?limit=100`)).messages as any[]);
    const reply=(message:any)=>message.role==="bot"&&message.kind==="text"&&message.text==="Hello from late";
    const without=(message:any)=>message.role==="bot"&&message.kind==="activity"&&/^Memory changed while .+ was starting, so this reply ran without remembered context\.$/.test(String(message.tool?.name??""));
    await expect.poll(async()=>(await messages()).some(reply),{timeout:30000}).toBe(true);
    await expect.poll(async()=>(await messages()).some(without),{timeout:10000}).toBe(true);
    await new Promise(resolve=>setTimeout(resolve,300));
    const all=await messages();
    expect(all.filter(reply)).toHaveLength(1);
    expect(all.filter(without)).toHaveLength(1);
    // no error card, and the raw code never reaches the person
    expect(all.filter(message=>String(message.tool?.name??"").startsWith("error:"))).toEqual([]);
    expect(all.some(message=>/MEMORY_CONTEXT_REVOKED|submission_refused/.test(String(message.tool?.name??"")))).toBe(false);
    // four dispatches (the first and three rebuilds), and only the last wrote its prompt; no fifth
    const mine=rowsOf(eachDump).filter(row=>row.threadId===threadId);
    expect(mine.filter(row=>!row.prompt)).toHaveLength(4);
    expect(mine.filter(row=>row.prompt)).toHaveLength(1);
    expect(mine.find(row=>row.prompt)?.turnId).toBe(mine.filter(row=>!row.prompt)[3]?.turnId);
  },90000);
  it("a bot frame reads no message row per task (index.ts withLastActivity)",async()=>{
    const bot=(await api("POST","/api/bots",{name:"Many tasks",modelSelection:{instanceId:"handback",model:"late-1"}})).bot;
    for(let i=0;i<6;i++)await api("POST",`/api/bots/${bot.id}/tasks`,{title:`Task ${i}`});
    await api("PATCH",`/api/bots/${bot.id}`,{name:"Many tasks warm"});
    const reads=()=>existsSync(newestReads)?readFileSync(newestReads,"utf8").length:0;
    const before=reads();
    for(let i=0;i<3;i++)await api("PATCH",`/api/bots/${bot.id}`,{name:`Many tasks ${i}`});
    expect(reads()-before).toBe(0);
  },30000);
});

// 1.0.3 engine-switch, the walk: a line revoke (message-db.ts appendMessage's branch revoke, or a forget) marks a session deny_session only
// when it held the line: begun before the revoke's cap and run past the line. The engine a person switched to while the walk ran began
// after the commit, under the revoke's window, and resumes; before the fix every session used after the line was marked, so each resume
// reset.
describe("revoke walk: sessions that held the line", () => {
  it("an engine switched in after the commit is not marked; the sessions that held the line are", () => {
    const fx = new WritetimeFixture();
    const inline = { ...INLINE_REVOCATION };
    try {
      const T = "engine-switch";
      // claude ran the thread from its start; codex was switched in at the second question (replayed the transcript, the revoked line in it)
      fx.owner(T, "u1", 1).reply(T, "r1", 2, { turnLsn: 1 }).owner(T, "u2", 3).reply(T, "r2", 4, { turnLsn: 3 }).owner(T, "u3", 5).reply(T, "r3", 6, { turnLsn: 5 });
      fx.sessionLineage(T, "claude", "c-1", 1, 6).sessionLineage(T, "codex", "x-1", 3, 6);
      // before the revoke's line: the walk never reaches it
      fx.sessionLineage(T, "pi", "p-1", 0, 1);
      // the commit, with nothing walked inline: the walk is long, and runs while the person carries on
      INLINE_REVOCATION.rows = 1; INLINE_REVOCATION.ms = 0;
      fx.db.exec("BEGIN IMMEDIATE");
      const R = commitRevoke(fx.db, { kind: "line", threadId: T, messageIds: ["r1"], cause: "forget" }, { inline: false });
      fx.db.exec("COMMIT");
      expect(R).toBeGreaterThan(0);
      // while it runs: the owner asks again and the bot, switched to grok, starts a session on a prompt built after the commit
      fx.owner(T, "u4", 7).reply(T, "r4", 8, { turnLsn: 7 });
      fx.sessionLineage(T, "grok", "g-1", 7, 8);
      for (let slices = 0; ; slices++) {
        expect(slices).toBeLessThan(10_000);
        fx.db.exec("BEGIN IMMEDIATE");
        const moved = markerSlice(fx.db, 256, 8);
        fx.db.exec("COMMIT");
        if (!moved) break;
      }
      const marked = (fx.db.prepare("SELECT driver_instance AS d,native_session AS s FROM memory_deny_session WHERE thread_id=? ORDER BY 1,2").all(T) as Array<{ d: string; s: string }>).map(row => `${row.d}/${row.s}`);
      expect(marked).not.toContain("grok/g-1");
      expect(marked).toContain("claude/c-1");
      expect(marked).toContain("codex/x-1");
      expect(marked).not.toContain("pi/p-1");
    } finally {
      Object.assign(INLINE_REVOCATION, inline);
      fx.close();
    }
  });
  it("an edit's bounded range: the session the new branch began is not marked", () => {
    const fx = new WritetimeFixture();
    try {
      const T = "edit-branch";
      fx.owner(T, "u1", 1).reply(T, "r1", 2, { turnLsn: 1 }).owner(T, "u2", 3).reply(T, "r2", 4, { turnLsn: 3 });
      // the engine switched in at u2 produced r2, the branch the person then left
      fx.sessionLineage(T, "codex", "x-1", 3, 5);
      // the edit's rerun opened its turn at 4 (the head) and began a fresh session there; the abandoned head r2 is revoked up to that turn
      fx.owner(T, "u2b", 5).reply(T, "r2b", 6, { turnLsn: 4 });
      fx.sessionLineage(T, "codex", "x-2", 4, 6);
      fx.db.exec("BEGIN IMMEDIATE");
      commitRevoke(fx.db, { kind: "line", threadId: T, messageIds: ["r2"], cause: "branch-switch" }, { until: 4, inline: false });
      fx.db.exec("COMMIT");
      for (let slices = 0; ; slices++) {
        expect(slices).toBeLessThan(10_000);
        fx.db.exec("BEGIN IMMEDIATE");
        const moved = markerSlice(fx.db, 256, 8);
        fx.db.exec("COMMIT");
        if (!moved) break;
      }
      const marked = (fx.db.prepare("SELECT native_session AS s FROM memory_deny_session WHERE thread_id=?").all(T) as Array<{ s: string }>).map(row => row.s);
      expect(marked).not.toContain("x-2");
      expect(marked).toContain("x-1");
    } finally { fx.close(); }
  });
});

// 1.0.3 engine-switch, the walk's boundaries with the real writers (lineage-write.ts openTurnLineage / writeSessionLineage stamp the head):
// a commit takes its own lsn, so a turn opened after it with no new line in the thread is not one that held the line; a session begun on the
// line itself held it; and a session row written after the walk passed its thread is marked at its write.
describe("revoke walk: the cap and the line, with the real writers", () => {
  const drain = (fx: WritetimeFixture) => {
    for (let slices = 0; ; slices++) {
      expect(slices).toBeLessThan(10_000);
      fx.db.exec("BEGIN IMMEDIATE");
      const moved = markerSlice(fx.db, 256, 8);
      fx.db.exec("COMMIT");
      if (!moved) break;
    }
  };
  const marked = (fx: WritetimeFixture, T: string) => (fx.db.prepare("SELECT driver_instance AS d,native_session AS s FROM memory_deny_session WHERE thread_id=? ORDER BY 1,2").all(T) as Array<{ d: string; s: string }>).map(row => `${row.d}/${row.s}`);
  const session = (fx: WritetimeFixture, T: string, d: string, n: string, turn: TurnLineage) => {
    fx.db.exec("BEGIN IMMEDIATE");
    writeSessionLineage(fx.db, { threadId: T, driverInstance: d, nativeSession: n }, turn);
    fx.db.exec("COMMIT");
    return fx.db.prepare("SELECT first_lsn AS f,last_lsn AS l FROM memory_session_lineage WHERE thread_id=? AND driver_instance=? AND native_session=?").get(T, d, n) as { f: number; l: number } | undefined;
  };
  const forget = (fx: WritetimeFixture, T: string, id: string, cause: "forget" | "edit" = "forget") => {
    fx.db.exec("BEGIN IMMEDIATE");
    const R = commitRevoke(fx.db, { kind: "line", threadId: T, messageIds: [id], cause }, { inline: false });
    fx.db.exec("COMMIT");
    expect(R).toBeGreaterThan(0);
  };
  for (const shape of ["routine", "room member", "late redispatch"] as const) it(`${shape}: a session begun after the commit with no new line is not marked`, () => {
    const fx = new WritetimeFixture();
    const T = `no-new-line-${shape}`;
    const opened: TurnLineage[] = [];
    try {
      fx.owner(T, "u1", 1).reply(T, "r1", 2, { turnLsn: 1 }).owner(T, "u2", 3).reply(T, "r2", 4, { turnLsn: 3 }).owner(T, "u3", 5).reply(T, "r3", 6, { turnLsn: 5 });
      fx.sessionLineage(T, "claude", "c-1", 1, 6);
      // a late redispatch: the first dispatch opened its turn on head 6 before the revoke and was refused before it wrote a session
      if (shape === "late redispatch") opened.push(openTurnLineage(fx.db, { threadId: T, turnId: memberTurnId("bot-g") }));
      forget(fx, T, "r1");
      // the prompt is built after the commit, and nothing new is in the thread: a routine wake, a room member's turn, the rebuilt dispatch
      const turn = openTurnLineage(fx.db, { threadId: T, turnId: shape === "routine" ? "routine-wake" : memberTurnId("bot-g") });
      opened.push(turn);
      if (shape === "late redispatch") supersedeMemberTurns(turn);
      const row = session(fx, T, "grok", "g-1", turn);
      expect(row).toBeDefined();
      drain(fx);
      expect(marked(fx, T)).not.toContain("grok/g-1");
      expect(marked(fx, T)).toContain("claude/c-1");
    } finally {
      for (const turn of opened) closeTurnLineage(turn);
      fx.close();
    }
  });
  it("a session begun on a line the owner then edits in place is marked", () => {
    const fx = new WritetimeFixture();
    const T = "edit-in-place";
    let turn: TurnLineage | undefined;
    try {
      fx.owner(T, "u1", 1).reply(T, "r1", 2, { turnLsn: 1 }).owner(T, "u2", 3);
      // the session starts on head u2 (index.ts session.started): [3,3]
      turn = openTurnLineage(fx.db, { threadId: T, turnId: "t-u2" });
      expect(session(fx, T, "codex", "x-1", turn)).toEqual({ f: 3, l: 3 });
      closeTurnLineage(turn); turn = undefined;
      // the owner changes u2's words (message-db.ts updateMessage): the session still holds the old ones
      forget(fx, T, "u2", "edit");
      drain(fx);
      expect(marked(fx, T)).toContain("codex/x-1");
    } finally {
      if (turn) closeTurnLineage(turn);
      fx.close();
    }
  });
  it("a session row written after the walk passed its thread is marked at its write", () => {
    const fx = new WritetimeFixture();
    const T = "late-session-row";
    let turn: TurnLineage | undefined;
    try {
      fx.owner(T, "u1", 1).reply(T, "r1", 2, { turnLsn: 1 }).owner(T, "u2", 3).reply(T, "r2", 4, { turnLsn: 3 }).owner(T, "u3", 5);
      // the prompt is built and delivered on head 5; a late-handback engine writes its session row only at session.started
      turn = openTurnLineage(fx.db, { threadId: T, turnId: "t-late" });
      forget(fx, T, "r1");
      drain(fx);
      expect(marked(fx, T)).not.toContain("handback/h-1");
      // session.started lands after the walk's session stage for T
      expect(session(fx, T, "handback", "h-1", turn)?.f).toBe(5);
      expect(marked(fx, T)).toContain("handback/h-1");
      // a later turn of the same session is not marked twice, and a session of a turn opened after the commit is not marked at all
      closeTurnLineage(turn);
      turn = openTurnLineage(fx.db, { threadId: T, turnId: "t-fresh" });
      session(fx, T, "handback", "h-2", turn);
      expect(marked(fx, T)).not.toContain("handback/h-2");
      expect(marked(fx, T).filter(key => key === "handback/h-1")).toHaveLength(1);
    } finally {
      if (turn) closeTurnLineage(turn);
      fx.close();
    }
  });
  // the real reply writer (message-db.ts recordLineage -> writeLineage with the member's running turn), in its own transaction
  const reply = (fx: WritetimeFixture, T: string, id: string, turn: TurnLineage) => {
    fx.message(T, id, "bot");
    fx.db.exec("BEGIN IMMEDIATE");
    const token = writeLineage(fx.db, { threadId: T, messageId: id, author: "generated" }, { turn });
    fx.db.exec("COMMIT");
    expect(token.lsn).toBeGreaterThan(0);
    return token.lsn;
  };
  // a session that wrote a line holds it: the line's write advances that turn's session to it, so a revoke of the line (a forget of the reply
  // as a source, an unbounded line revoke) marks the engine that generated it. Before, the session row (written at session.started or the
  // resume, before the reply) ended below the reply, the walk's session stage missed it, and the engine resumed holding the revoked words.
  for (const shape of ["direct", "room", "late handback"] as const) it(`${shape}: the session that generated a line is marked when that line is revoked`, () => {
    const fx = new WritetimeFixture();
    const T = `own-reply-${shape.replace(" ", "-")}`;
    const opened: TurnLineage[] = [];
    try {
      fx.cert(true);
      fx.owner(T, "u1", 1);
      const room = shape === "room";
      opened.push(openTurnLineage(fx.db, { threadId: T, turnId: room ? memberTurnId("bot-a") : "t-1" }));
      if (room) opened.push(openTurnLineage(fx.db, { threadId: T, turnId: memberTurnId("bot-b") }));
      const turnOf = (bot: string) => (room ? runningTurnFor(T, bot) : opened[0])!;
      // late handback: the turn id came back first and the prompt was written later; a line landed in between and session.started follows
      if (shape === "late handback") fx.owner(T, "u2", 2);
      const own = session(fx, T, "grok", "g-1", turnOf("bot-a"));
      expect(own?.f).toBe(1);
      if (room) session(fx, T, "codex", "x-b", turnOf("bot-b"));
      const at = reply(fx, T, "r-own", turnOf("bot-a"));
      expect(at).toBeGreaterThan(Number(own?.l));
      const row = fx.db.prepare("SELECT last_lsn AS l FROM memory_session_lineage WHERE thread_id=? AND native_session='g-1'").get(T) as { l: number };
      for (const turn of opened.splice(0)) closeTurnLineage(turn);
      forget(fx, T, "r-own");
      drain(fx);
      expect(marked(fx, T)).toContain("grok/g-1");
      expect(sessionLookup(fx.db, { threadId: T, driverInstance: "grok", nativeSession: "g-1" }, CONTENT).state).toBe("withheld");
      expect(Number(row.l), "the reply's write advanced its session to the reply").toBe(at);
      // another member's session never held the reply: not marked
      if (room) expect(marked(fx, T)).not.toContain("codex/x-b");
    } finally {
      for (const turn of opened) closeTurnLineage(turn);
      fx.close();
    }
  });
  // a fresh inherit job's cap is a slot of its own taken after the child: a room member's prompt built after the child was written (the
  // child withheld) has a head at or above the cap and is not taken for one that held it. Before, the cap was currentLsn, the child's lsn
  // plus one, and a prompt built on head = the child stamped [h, h] below it.
  it("inherit: a prompt built after an inheriting child is not marked", () => {
    const fx = new WritetimeFixture();
    const T = "inherit-same-head", P = "inherit-parent";
    const opened: TurnLineage[] = [];
    try {
      fx.owner(T, "u1", 1).owner(P, "p1", 2);
      fx.denyLine(P, 2, 77); // p1 denied by a revoke whose job is gone: the child opens an inherit job
      const turn = openTurnLineage(fx.db, { threadId: T, turnId: memberTurnId("bot-a") });
      opened.push(turn);
      addTurnParents(turn, [{ kind: "line", threadId: P, messageId: "p1" }]);
      const h = reply(fx, T, "r-child", turn);
      const job = fx.db.prepare("SELECT started_lsn AS s FROM memory_revoke_jobs WHERE revoke_id=77 AND kind='inherit'").get() as { s: number } | undefined;
      expect(job, "the denied parent opened an inherit job").toBeDefined();
      expect(Number(job!.s)).toBeGreaterThan(h);
      // a room member's prompt built after the child, nothing new in the thread
      const member = openTurnLineage(fx.db, { threadId: T, turnId: memberTurnId("bot-b") });
      opened.push(member);
      const row = session(fx, T, "codex", "x-b", member);
      drain(fx);
      expect(fx.db.prepare("SELECT 1 AS x FROM memory_deny_range WHERE thread_id=? AND revoke_id=77").get(T), "the walk reached the child's turn").toBeTruthy();
      expect(marked(fx, T)).not.toContain("codex/x-b");
      expect(Number(row?.f)).toBeGreaterThanOrEqual(Number(job!.s));
    } finally {
      for (const turn of opened) closeTurnLineage(turn);
      fx.close();
    }
  });
  // a root added to an open bulk revoke takes its own slot as its cap: a session begun on the root's line after the bulk opened held it.
  // Before, the walk capped the root's range at the bulk's open slot and the session was left unmarked.
  it("bulk: a root added after the bulk opened caps its range at its own slot", () => {
    const fx = new WritetimeFixture();
    const T = "late-bulk-root";
    let turn: TurnLineage | undefined;
    try {
      fx.owner(T, "u1", 1);
      fx.db.exec("BEGIN IMMEDIATE");
      const R = openBulkRevoke(fx.db, "test", false);
      fx.db.exec("COMMIT");
      expect(R).toBeGreaterThan(0);
      const opened = Number((fx.db.prepare("SELECT started_lsn AS s FROM memory_revoke_jobs WHERE revoke_id=?").get(R) as { s: number }).s);
      fx.owner(T, "u2", opened + 1);
      turn = openTurnLineage(fx.db, { threadId: T, turnId: "t-u2" });
      expect(session(fx, T, "codex", "x-1", turn)).toEqual({ f: opened + 1, l: opened + 1 });
      closeTurnLineage(turn); turn = undefined;
      fx.db.exec("BEGIN IMMEDIATE");
      commitRevoke(fx.db, { kind: "line", threadId: T, messageIds: ["u2"], cause: "forget" }, { into: R, inline: false });
      activateBulkRevoke(fx.db, R);
      fx.db.exec("COMMIT");
      drain(fx);
      const range = fx.db.prepare("SELECT until_turn_lsn AS u FROM memory_deny_range WHERE thread_id=? AND from_lsn=? AND revoke_id=?").get(T, opened + 1, R) as { u: number } | undefined;
      expect(marked(fx, T)).toContain("codex/x-1");
      expect(Number(range?.u)).toBeGreaterThan(opened + 1);
    } finally {
      if (turn) closeTurnLineage(turn);
      fx.close();
    }
  });
});

// 1.0.2 Keep all P0 (F2): a late-handback engine writes its session row at session.started, after the prompt was built and before the
// prompt is written. Its inheritance (a carried line of another thread under a revoke) used to hold the session at the prompt's own head and
// bump deny_generation, so the send fence refused the turn's own prompt, every rebuild the same way. The hold now takes a slot of its own,
// above every prompt already built, and the turn's own bumps are not taken for a revoke committed since.
describe("a turn's own session write never refuses its own prompt", () => {
  const CONTENT_READER = { audience: null } as const;
  const MEMBER_READER = { audience: { owner: false, scopeIds: [] as string[] } } as const;
  const drain = (fx: WritetimeFixture) => {
    for (let slices = 0; ; slices++) {
      expect(slices).toBeLessThan(10_000);
      fx.db.exec("BEGIN IMMEDIATE");
      const moved = markerSlice(fx.db, 256, 8);
      fx.db.exec("COMMIT");
      if (!moved) break;
    }
  };
  it("session child under a reopened job: the turn's own prompt reads shown; a prompt built after the write reads checking", () => {
    const fx = new WritetimeFixture();
    const T = "own-session", U = "team-result";
    const opened: TurnLineage[] = [];
    try {
      fx.owner(U, "u1", 1).reply(U, "r1", 2, { turnLsn: 1 });
      fx.owner(T, "t1", 3).reply(T, "t2", 4, { turnLsn: 3 }).owner(T, "t3", 5);
      // r1 is forgotten and the walk finishes: its job is done, its line marked
      fx.db.exec("BEGIN IMMEDIATE");
      const R = commitRevoke(fx.db, { kind: "line", threadId: U, messageIds: ["r1"], cause: "forget" }, { inline: false });
      fx.db.exec("COMMIT");
      drain(fx);
      expect(fx.db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(R)?.state).toBe("done");
      // the owner's turn reads the other thread wholesale (a team result), and its prompt is built
      const turn = openTurnLineage(fx.db, { threadId: T, turnId: "own" });
      opened.push(turn);
      const refs = [{ kind: "prefix" as const, threadId: T, headLsn: turn.turnLsn }, { kind: "prefix" as const, threadId: U }];
      const built = buildPrompt(turn, [promptPart("prompt", refs)]);
      const before = denyGeneration(fx.db);
      // session.started: the session row carries U, whose revoke is reopened (job active again) and holds the session
      fx.db.exec("BEGIN IMMEDIATE");
      writeSessionLineage(fx.db, { threadId: T, driverInstance: "fuigo", nativeSession: "s-1" }, turn);
      fx.db.exec("COMMIT");
      expect(fx.db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(R)?.state).toBe("active");
      expect(denyGeneration(fx.db)).toBeGreaterThan(before);
      const hold = fx.db.prepare("SELECT min(since_lsn) AS s FROM memory_deny_pending WHERE thread_id=? AND revoke_id=?").get(T, R)?.s;
      expect(Number(hold)).toBeGreaterThan(turn.turnLsn);
      // the turn's own prompt passes the fence, for the owner's content reader and for an audience reader
      expect(fenceVerdict(fx.db, built, CONTENT_READER)).toEqual({ state: "shown" });
      expect(fenceVerdict(fx.db, built, MEMBER_READER)).toEqual({ state: "shown" });
      // and with the generation check skipped (every part looked up again): the hold sits above its head
      expect(refsLookup(fx.db, refs, MEMBER_READER)).toEqual({ state: "shown" });
      // a prompt built after the write is held until the walk finishes
      const later = openTurnLineage(fx.db, { threadId: T, turnId: "later" });
      opened.push(later);
      expect(refsLookup(fx.db, [{ kind: "prefix", threadId: T, headLsn: later.turnLsn }], MEMBER_READER)).toEqual({ state: "checking", reason: "pending" });
      // a revoke someone else commits after the build still moves the generation past the turn's own bumps: every part is asked again
      fx.db.exec("BEGIN IMMEDIATE");
      commitRevoke(fx.db, { kind: "line", threadId: T, messageIds: ["t2"], cause: "forget" }, { inline: false });
      fx.db.exec("COMMIT");
      expect(fenceVerdict(fx.db, built, MEMBER_READER).state).not.toBe("shown");
      // the walk finishes: the session it held is marked, as the carried revoke requires
      drain(fx);
      expect(fx.db.prepare("SELECT count(*) AS n FROM memory_deny_session WHERE thread_id=? AND native_session='s-1'").get(T)?.n).toBeGreaterThan(0);
    } finally {
      for (const turn of opened) closeTurnLineage(turn);
      fx.close();
    }
  });
});
