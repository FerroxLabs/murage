// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// GH #18 wave 1A: constructed legacy profiles, not a copy of the affected installation.
// Non-audience denial is preserved here. The owner-authorized GH18 fresh-start
// operation is separate: it must never silently clear these protected legacy marks.
// These are preservation/recovery assertions, not promised REDs. The preload only
// instruments the fixture driver and supplies ranked recall candidates; the server's
// readers, hydration, fences and retry bounds run unchanged.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { denyLookup, memoryLookup, sessionLookup } from "./memory/deny-read.ts";
import { sessionKeyOf } from "./memory/session-incarnation.ts";
import type { LineageReader } from "./memory/lineage-types.ts";

let fixture: VerificationServer;
let headers: Record<string, string>;
let evidence: Record<string, unknown>;
type Bot = { id: string; threadId: string };
type Row = Record<string, any>;
const ROOT_REVOKE = 918001;
const READERS: Record<string, LineageReader> = {
  content: { audience: null },
  owner: { audience: { owner: true, scopeIds: [] } },
  member: { audience: { owner: false, scopeIds: [] } },
};
const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(join(process.cwd(), file)).href);
const file = (name: string) => join(fixture.info.dataDir, name);
const rows = (name: string): Row[] => existsSync(file(name)) ? readFileSync(file(name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const log = () => readFileSync(fixture.info.logPath, "utf8");
const dbUse = <T,>(fn: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(file("messages.db"));
  try { db.exec("PRAGMA busy_timeout=10000"); return fn(db); } finally { db.close(); }
};
const api = async (method: string, path: string, body?: unknown): Promise<any> => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  expect(response.ok, `${method} ${path}: ${JSON.stringify(value)}`).toBe(true);
  return value;
};
const login = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};
const messages = async (threadId: string): Promise<Row[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages;
const isReply = (m: Row) => m.role === "bot" && m.kind === "text" && m.text === "Hello from late";
const errors = (all: Row[]) => all.filter(m => String(m.tool?.name ?? "").startsWith("error:"));
const idle = async (bot: Bot) => (await api("GET", "/api/bots?messages=0")).bots.find((b: Bot) => b.id === bot.id)?.busy === false;
const send = (bot: Bot, text: string) => api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
const answered = async (bot: Bot, text: string) => {
  const before = (await messages(bot.threadId)).filter(isReply).length;
  await send(bot, text);
  await expect.poll(async () => (await messages(bot.threadId)).filter(isReply).length, { timeout: 30000 }).toBe(before + 1);
  await expect.poll(() => idle(bot), { timeout: 15000 }).toBe(true);
};
const createBot = async (instanceId = "legacy"): Promise<Bot> => {
  const bot = (await api("POST", "/api/bots", { name: `GH18 ${instanceId}`, modelSelection: { instanceId, model: "late-1" } })).bot;
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  return bot;
};
const session = (bot: Bot) => dbUse(db => db.prepare("SELECT driver_instance, native_session FROM memory_session_lineage WHERE thread_id=? ORDER BY last_lsn DESC LIMIT 1").get(bot.threadId) as { driver_instance: string; native_session: string });
const markSession = (bot: Bot, revoke = ROOT_REVOKE) => {
  const old = session(bot);
  expect(old).toBeDefined();
  dbUse(db => {
    db.prepare("INSERT INTO memory_deny_session(thread_id,driver_instance,native_session,revoke_id) VALUES(?,?,?,?)").run(bot.threadId, old.driver_instance, old.native_session, revoke);
    db.exec("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'");
  });
  return old;
};
const marks = () => dbUse(db => Object.fromEntries(["memory_deny_session", "memory_deny_line", "memory_deny_range", "memory_deny_memory", "memory_deny_pending", "memory_deny_pending_scope", "memory_tombstones", "memory_deny"].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()])));
const retained = (before: ReturnType<typeof marks>) => {
  const after = marks();
  for (const [table, expected] of Object.entries(before)) expect(after[table], table).toEqual(expect.arrayContaining(expected));
};
const seen = (bot: Bot, kind: string) => rows("observations").filter(row => row.threadId === bot.threadId && row.kind === kind);
const waitFile = async (name: string) => expect.poll(() => existsSync(file(name)), { timeout: 30000 }).toBe(true);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Per-test server: a failure cannot leave another case's generation, gate or marks behind.
describe.skipIf(process.platform === "win32")("GH18 legacy non-audience recovery", () => {
  beforeEach(async () => {
    evidence = {};
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${moduleUrl("server/drivers/builtIn.ts")});
      const {makeLateTerminalDriver}=await import(${moduleUrl("server/testing/fake-late-terminal-driver.ts")});
      const {turnSecret}=await import(${moduleUrl("server/turn-credential.ts")});
      const dir=process.env.MURAGE_DATA_DIR;
      // Deterministic retrieval candidates, including the denied record first.
      // No embedding model is needed; searchMemory still authorizes/hydrates them.
      const {MemoryWorkerController}=await import(${moduleUrl("server/memory/worker-controller.ts")});
      const search=MemoryWorkerController.prototype.search;
      MemoryWorkerController.prototype.search=function(input,signal){
        if(!fs.existsSync(path.join(dir,'tool-probes')))return search.call(this,input,signal);
        return Promise.resolve({hits:[{id:'gh18-shared',version:1,score:2,lexical:true},{id:'gh18-allowed',version:1,score:1,lexical:true}],vectorRows:0,coverageComplete:true});
      };
      const put=row=>fs.appendFileSync(path.join(dir,'observations'),JSON.stringify(row)+'\\n');
      const gate=async name=>{
        if(!fs.existsSync(path.join(dir,name)))return;
        fs.writeFileSync(path.join(dir,name+'.waiting'),'');
        await new Promise(resolve=>{const poll=setInterval(()=>{if(!fs.existsSync(path.join(dir,name+'.release')))return;clearInterval(poll);resolve();},20);});
        fs.writeFileSync(path.join(dir,name+'.passed'),'');
      };
      const driver=makeLateTerminalDriver(); const create=driver.create.bind(driver);
      driver.create=async input=>{
        const instance=await create(input); const adapter=instance.adapter;
        if(input.instanceId==='unsafe')adapter.hasSession=()=>fs.existsSync(path.join(dir,'unsafe-retained'));
        else adapter.resetSession=async (threadId,options)=>{put({kind:'reset',threadId,route:options?.route??'cleanup'});if(options?.route)await gate('hold-reset');};
        const on=adapter.onEvent.bind(adapter), recorded=new Set();
        adapter.onEvent=listener=>on(event=>{
          // A provider may reuse a native ID after truly clearing its context.
          const e=event.type==='session.started'?{...event,sessionId:input.instanceId==='reuse'?'reused-native':event.sessionId.startsWith('late-session-')?'gh18-'+process.pid+'-'+event.sessionId:event.sessionId}:event;
          if(!recorded.has(e.eventId)){recorded.add(e.eventId);put({kind:'event',...e});}
          listener(e);
        });
        const send=adapter.sendTurn.bind(adapter);
        adapter.sendTurn=async turn=>{
          const payload={system:turn.system,text:turn.text,memoryContext:turn.memoryContext};
          put({kind:'dispatch',threadId:turn.threadId,resumeCursor:turn.resumeCursor??null,sessionReset:turn.sessionReset===true,payload});
          const submit=turn.beforeSubmit;
          turn.beforeSubmit=()=>{submit?.();put({kind:'submitted',threadId:turn.threadId,payload});};
          await gate('hold-send');
          const probes=path.join(dir,'tool-probes');
          if(fs.existsSync(probes)&&turn.integrations?.memory){
            const env=turn.integrations.memory.env;
            for(const probe of JSON.parse(fs.readFileSync(probes,'utf8'))){
              const response=await fetch(env.MURAGE_HARNESS_URL+'/api/internal/memory/'+probe.path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+turnSecret('MURAGE_MEMORY_TOKEN',env)},body:JSON.stringify(probe.body)});
              put({kind:'tool',threadId:turn.threadId,path:probe.path,status:response.status,body:await response.json()});
            }
          }
          return send(turn);
        };
        return instance;
      };
      BUILT_IN_DRIVERS.push(driver);
      const cfgFile=path.join(dir,'config.json'),cfg=JSON.parse(fs.readFileSync(cfgFile,'utf8'));
      for(const name of ['legacy','reuse','unsafe'])cfg.instances[name]={driver:'fakeLateTerminal',environment:{FAKE_LATE_HANDBACK:'1',FAKE_LATE_SESSION:'1',FAKE_LATE_FENCED_WRITES:'1',FAKE_LATE_MEMORY_MCP:'1',FAKE_LATE_DUMP_CONTEXT:'1',FAKE_LATE_DUMP_FRAME:'1',FAKE_LATE_DUMP:path.join(dir,'driver-dump')}};
      fs.writeFileSync(cfgFile,JSON.stringify(cfg));
    ` });
    await login();
    expect((await api("GET", "/api/memory/status")).mode).toBe("active");
  }, 120000);
  afterEach(async context => {
    if (!fixture) return;
    // Persist actual observations before the isolated profile is removed. Optional,
    // so ordinary repository runs do not leave artifacts in the checkout.
    try {
      if (process.env.GH18_EVIDENCE_DIR) {
        const out = join(process.env.GH18_EVIDENCE_DIR, context.task.name);
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "observations.json"), JSON.stringify({ ...evidence, fixture: fixture.info, observations: rows("observations"), driver: rows("driver-dump"), retained: marks() }, null, 2));
        writeFileSync(join(out, "server.log"), log());
      }
    } finally { await fixture.close(); }
  }, 30000);

  it("legacy_non_audience_five_turns", async () => {
    const outcomes: Row[] = [];
    evidence.outcomes = outcomes;
    for (const shape of ["pruned-root", "inherited-root", "missing-lineage", "reused-native"] as const) {
      const bot = await createBot(shape === "reused-native" ? "reuse" : "legacy");
      await answered(bot, `seed ${shape}`);
      const old = markSession(bot, ROOT_REVOKE + outcomes.length);
      dbUse(db => {
        if (shape === "inherited-root") db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'inherit','{}',1,1,'done','','done')").run(ROOT_REVOKE + outcomes.length);
        if (shape === "missing-lineage") db.prepare("DELETE FROM memory_session_lineage WHERE thread_id=? AND driver_instance=? AND native_session=?").run(bot.threadId, old.driver_instance, old.native_session);
        expect(db.prepare("SELECT 1 FROM memory_revoke_audience WHERE revoke_id=?").get(ROOT_REVOKE + outcomes.length)).toBeUndefined();
        for (const reader of Object.values(READERS)) expect(sessionLookup(db, sessionKeyOf(bot.threadId, old.driver_instance, old.native_session), reader)).toEqual({ state: "withheld", reason: "deny-session" });
      });
      const before = marks(), start = seen(bot, "dispatch").length;
      // Startup repair must not consume these content marks. Restart also exercises
      // lost in-memory lineage caches; the reused-native case starts a new incarnation.
      await fixture.restart(); await login();
      for (let n = 1; n <= 5; n++) await answered(bot, `clean ${shape} turn ${n}`);
      const dispatches = seen(bot, "dispatch").slice(start);
      const all = await messages(bot.threadId);
      outcomes.push({ shape, dispatches, retryCount: dispatches.length - 5, terminal: all, incarnations: dbUse(db => db.prepare("SELECT * FROM memory_session_incarnation WHERE thread_id=?").all(bot.threadId)) });
      expect(dispatches).toHaveLength(5);
      expect(dispatches[0]?.resumeCursor).toBeNull();
      expect(all.filter(isReply)).toHaveLength(6);
      expect(errors(all)).toEqual([]);
      expect(seen(bot, "event").filter(e => e.type === "turn.completed" && e.ok)).toHaveLength(6);
      if (shape === "reused-native") {
        const incarnations = outcomes.at(-1)!.incarnations;
        expect(incarnations.map((row: Row) => Number(row.n))).toEqual([1, 2]);
        expect(dispatches.slice(1).every(row => row.resumeCursor === "reused-native")).toBe(true);
        dbUse(db => expect(sessionLookup(db, sessionKeyOf(bot.threadId, "reuse", "reused-native", 2), READERS.content!)).toEqual({ state: "shown" }));
      } else expect(dispatches.every(row => row.resumeCursor !== old.native_session)).toBe(true);
      retained(before);
    }
  }, 240000);

  it("revoked_bytes_never_dispatched", async () => {
    const bot = await createBot();
    const side = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Legacy shared history" })).task;
    const sourceBot = { id: bot.id, threadId: side.threadId };
    const shapes = ["line", "range", "coalesced", "shared", "pending", "missing"];
    for (const shape of shapes) await answered(sourceBot, `seed ${shape}`);
    await answered(bot, "GH18_ALLOWED_REPLAY_CANARY");
    markSession(bot);
    const secretLines: Row[] = [];
    evidence.lines = secretLines;
    const secrets = shapes.map(shape => `GH18_WITHDRAWN_${shape.toUpperCase()}_918001`);
    secrets.push("GH18_WITHDRAWN_DIRECT_REPLAY_918001");
    let directMessageId = "";
    dbUse(db => {
      const replies = db.prepare("SELECT m.id,m.json,l.lsn,l.turn_lsn FROM messages m JOIN memory_thread_no t ON t.thread_id=m.thread_id JOIN memory_line_lineage l ON l.thread_no=t.no AND l.message_id=m.id WHERE m.thread_id=? AND m.role='bot' AND m.kind='text' AND m.text='Hello from late' ORDER BY l.lsn").all(side.threadId) as Row[];
      expect(replies).toHaveLength(shapes.length);
      for (let n = 0; n < shapes.length; n++) {
        const row = replies[n]!, text = secrets[n]!, shape = shapes[n]!;
        db.prepare("UPDATE messages SET text=?,json=? WHERE thread_id=? AND id=?").run(text, JSON.stringify({ ...JSON.parse(row.json), text }), side.threadId, row.id);
        secretLines.push({ ...row, shape, text, threadId: side.threadId });
        if (shape === "line" || shape === "shared") db.prepare("INSERT INTO memory_deny_line(thread_id,lsn,revoke_id,mark_lsn,reason) VALUES(?,?,?,?, 'inherit')").run(side.threadId, row.lsn, ROOT_REVOKE, row.lsn);
        if (shape === "range" || shape === "coalesced") db.prepare("INSERT INTO memory_deny_range(thread_id,from_lsn,until_turn_lsn,revoke_id,reason) VALUES(?,?,?,?, 'legacy')").run(side.threadId, row.lsn - 1, row.turn_lsn + 1, shape === "coalesced" ? -1 : ROOT_REVOKE + 1);
        if (shape === "pending") {
          // The deletion's downstream hold is still active: its legacy frontier
          // cannot be decoded. Keep the direct deletion fact and tombstone too.
          const root = JSON.stringify({ kind: "thread", threadId: "gh18-deleted-parent", cause: "delete-conversation" });
          db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'thread',?,?,?,'mark','','active')").run(ROOT_REVOKE + 2, root, row.lsn, row.turn_lsn + 1);
          db.prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('thread','gh18-deleted-parent',0,0)").run();
          db.prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES('gh18-deletion','source','gh18-pruned-source',NULL,NULL,0,'delete-conversation',0)").run();
          db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,?,?)").run(side.threadId, row.lsn, ROOT_REVOKE + 2);
          db.prepare("INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,1,'{unreadable')").run(ROOT_REVOKE + 2);
        }
        if (shape === "missing") db.prepare("DELETE FROM memory_line_lineage WHERE thread_no=(SELECT no FROM memory_thread_no WHERE thread_id=?) AND message_id=?").run(side.threadId, row.id);
      }
      // The current conversation's own replay also contains a denied generated line.
      const direct = db.prepare("SELECT m.id,m.json,l.lsn FROM messages m JOIN memory_thread_no t ON t.thread_id=m.thread_id JOIN memory_line_lineage l ON l.thread_no=t.no AND l.message_id=m.id WHERE m.thread_id=? AND m.text='Hello from late' ORDER BY l.lsn DESC LIMIT 1").get(bot.threadId) as Row;
      directMessageId = direct.id;
      const directText = secrets.at(-1)!;
      db.prepare("UPDATE messages SET text=?,json=? WHERE thread_id=? AND id=?").run(directText, JSON.stringify({ ...JSON.parse(direct.json), text: directText }), bot.threadId, direct.id);
      db.prepare("INSERT INTO memory_deny_line(thread_id,lsn,revoke_id,mark_lsn,reason) VALUES(?,?,?,?, 'legacy')").run(bot.threadId, direct.lsn, ROOT_REVOKE, direct.lsn);
      for (const reader of Object.values(READERS)) expect(denyLookup(db, { threadId: bot.threadId, lines: [{ messageId: direct.id, author: "generated" }] }, reader).get(direct.id)).toEqual({ state: "withheld", reason: "deny-line" });
      evidence.directLine = { threadId: bot.threadId, messageId: direct.id, text: directText };
      // A shared descendant with two parent records, but no surviving revoke root.
      // A readable control proves the memory mount can actually release records.
      const scope = db.prepare("SELECT id FROM memory_scopes WHERE kind='conversation' AND owner_key=?").get(bot.threadId)!.id;
      const record = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,valid_to,supersedes_id,created_at) VALUES(?,1,?,'fact',?,'owner-statement','active',1,0,NULL,NULL,0)");
      record.run("gh18-shared", scope, secrets[3]!);
      record.run("gh18-allowed", scope, "GH18_ALLOWED_MEMORY_CANARY");
      for (const parent of ["gh18-parent-a", "gh18-parent-b"]) {
        record.run(parent, scope, "Authorized parent");
        db.prepare("INSERT INTO memory_derivations(parent_id,parent_version,child_id,child_version) VALUES(?,1,'gh18-shared',1)").run(parent);
      }
      db.prepare("INSERT INTO memory_deny_memory(kind,id,version,revoke_id) VALUES('record','gh18-shared',0,?)").run(ROOT_REVOKE);
      db.exec("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'");
      evidence.readerVerdicts = Object.fromEntries(Object.entries(READERS).map(([name, reader]) => {
        const verdicts = denyLookup(db, { threadId: side.threadId, lines: secretLines.map(row => ({ messageId: row.id, author: "generated" as const })) }, reader);
        for (const row of secretLines) {
          const reason = ({ line: "deny-line", range: "deny-range", coalesced: "deny-range", shared: "deny-line", pending: "pending", missing: "no-lineage" } as Record<string, string>)[row.shape];
          if (name === "member" && row.shape === "pending") {
            // A reader without the source scopes may be refused even before the
            // pending hold: both verdicts protect the bytes; lookup errors do not count.
            expect([{ state: "checking", reason: "pending" }, { state: "withheld", reason: "footprint" }]).toContainEqual(verdicts.get(row.id));
          } else expect(verdicts.get(row.id), `${name}/${row.shape}`).toEqual({ state: row.shape === "pending" || row.shape === "missing" ? "checking" : "withheld", reason });
        }
        expect(memoryLookup(db, [{ kind: "record", id: "gh18-shared", version: 1 }], reader).get("record:gh18-shared:1")).toEqual({ state: "withheld", reason: "deny-memory" });
        return [name, Object.fromEntries(verdicts)];
      }));
    });
    const before = marks(), start = rows("observations").length;
    writeFileSync(file("tool-probes"), JSON.stringify([
      { path: "thread-search", body: { query: "GH18" } },
      ...[...secretLines.map(row => row.id), directMessageId].map(message_id => ({ path: "thread-read", body: { message_id, direction: "around" } })),
      { path: "search", body: { query: "GH18", limit: 20 } },
      { path: "get", body: { handles: [{ id: "gh18-shared", version: 1 }] } },
      { path: "get", body: { handles: [{ id: "gh18-allowed", version: 1 }] } },
    ]));
    await answered(bot, "Please answer this clean question using only available history.");
    const after = rows("observations").slice(start);
    const tools = after.filter(row => row.kind === "tool");
    expect(tools).toHaveLength(11);
    for (const row of tools.filter(row => row.path !== "get")) expect(row.status, row.path).toBe(200);
    const [deniedGet, allowedGet] = tools.filter(row => row.path === "get");
    expect(deniedGet!.status).toBeGreaterThanOrEqual(400);
    expect(deniedGet!.body.error).toBe("MEMORY_RECORD_UNAVAILABLE");
    expect(allowedGet!.status).toBe(200);
    expect(JSON.stringify(allowedGet!.body)).toContain("GH18_ALLOWED_MEMORY_CANARY");
    expect(JSON.stringify(tools.find(row => row.path === "thread-search")!.body)).toContain("GH18_ALLOWED_REPLAY_CANARY");
    expect(JSON.stringify(after.filter(row => row.kind === "submitted"))).toContain("GH18_ALLOWED_REPLAY_CANARY");
    expect(JSON.stringify(after.filter(row => row.kind === "submitted"))).toContain("GH18_ALLOWED_MEMORY_CANARY");
    expect(JSON.stringify(tools.find(row => row.path === "search")!.body)).toContain("GH18_ALLOWED_MEMORY_CANARY");
    expect(after.filter(row => row.kind === "submitted")).toHaveLength(1);
    for (const secret of secrets) expect(JSON.stringify(after)).not.toContain(secret);
    expect(errors(await messages(bot.threadId))).toEqual([]);
    retained(before);
    evidence.pendingDeletion = dbUse(db => {
      const job = db.prepare("SELECT * FROM memory_revoke_jobs WHERE revoke_id=?").get(ROOT_REVOKE + 2);
      expect(job).toMatchObject({ state: "active", kind: "thread" });
      expect(JSON.parse(String(job!.root))).toMatchObject({ cause: "delete-conversation" });
      return job;
    });
    evidence.terminal = await messages(bot.threadId);
  }, 180000);

  it("unsafe_reset_settles_visibly", async () => {
    const bot = await createBot("unsafe");
    await answered(bot, "establish retained engine context");
    const old = markSession(bot), before = marks(), start = rows("observations").length;
    writeFileSync(file("unsafe-retained"), "");
    await send(bot, "this engine cannot safely reset");
    await expect.poll(async () => errors(await messages(bot.threadId)).length, { timeout: 30000 }).toBe(1);
    await expect.poll(() => idle(bot), { timeout: 15000 }).toBe(true);
    await pause(1000);
    const all = await messages(bot.threadId), after = rows("observations").slice(start);
    expect(errors(all)).toHaveLength(1);
    expect(errors(all)[0]?.tool.name).toContain("MEMORY_SESSION_RESET_UNAVAILABLE");
    expect(all.filter(isReply)).toHaveLength(1);
    expect(after.filter(row => row.kind === "dispatch" || row.kind === "submitted")).toEqual([]);
    retained(before);
    evidence.outcome = { old, retryCount: 0, terminal: all, after };
  }, 90000);

  it("stop_prevents_redispatch", async () => {
    const bot = await createBot();
    await answered(bot, "establish the session to invalidate during submission");
    const start = rows("observations").length;
    writeFileSync(file("hold-send"), "");
    await send(bot, "stop this reply while it is rebuilding");
    await waitFile("hold-send.waiting");
    const old = markSession(bot), before = marks();
    writeFileSync(file("hold-reset"), "");
    writeFileSync(file("hold-send.release"), "");
    await waitFile("hold-reset.waiting");
    expect(log()).toMatch(/context revoked.*re-preparing/);
    expect(await idle(bot)).toBe(false);
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    writeFileSync(file("hold-reset.release"), "");
    await waitFile("hold-reset.passed");
    await expect.poll(() => idle(bot), { timeout: 15000 }).toBe(true);
    // Beyond the production revoke-settle deadline, so a delayed retry would be seen.
    await pause(6000);
    const after = rows("observations").slice(start), all = await messages(bot.threadId);
    expect(after.filter(row => row.kind === "dispatch")).toHaveLength(1);
    expect(after.filter(row => row.kind === "submitted")).toEqual([]);
    expect(all.filter(isReply)).toHaveLength(1);
    expect(errors(all)).toEqual([]);
    retained(before);
    evidence.outcome = { old, scheduledRebuilds: log().split("\n").filter(line => line.includes(bot.threadId) && line.includes("re-preparing")).length, dispatchesAfterStop: after.filter(row => row.kind === "dispatch").length - 1, terminal: all, after };
    await answered(bot, "a separate clean turn after Stop");
  }, 120000);
});
