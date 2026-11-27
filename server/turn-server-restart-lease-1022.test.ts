// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 presence-restart, SITES.md row 8 (server/index.ts settleRefusedLeaseTerminal, the "late-lease" hold): an owner's turn whose engine
// accepted a provider turn, whose first write the memory fence refused (proven unwritten), and which is held for its rebuild when the SERVER
// PROCESS closes is NOT kept for the next start: it gets the close line once, its send ends and the next server never runs it.
// This is the lease-terminal twin of LATE-HOLD / LATE-START in turn-server-restart-1022.test.ts (there the refusal is decided by the engine's
// terminal fold; here by the ledger lease's own terminal, an ACP engine with its memory MCP catalogs, the c11 fixture).
// Real server process, real HTTP send route, a real roster-independent audience change (PATCH individual) that makes the memory fence refuse the
// engine's first write, a real SIGTERM the server sends itself the moment holdForRebuild kept the run (every hook calls the real method) and a
// real second start on the same data folder. The hold site is proven by the server's own log line.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { REQUIRED_CONTROLS, ToolLimitStore } from "./drivers/acp/opencode-tool-budget.ts";
import { prepareFixtureRecall } from "./testing/recall-ready-fixture.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const INSTANCE = "leaserestart";
const QUESTION = "the question sent as the server closes";
const STOPPED = "stopped: Murage closed while this was running";
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
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const lines = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
const file = (name: string) => join(fixture.info.dataDir, `${INSTANCE}-${name}`);
/** The engine's own record (kept across the restart): how many provider prompts it was ever handed. */
const prompts = () => existsSync(file("engine.jsonl")) ? readFileSync(file("engine.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.event === "prompt").length : 0;
const login = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};
const exited = (child: VerificationServer["child"]) => child.exitCode !== null || child.signalCode !== null;
const recallReady = async (bot: { id: string }, threadId: string) => {
  for (;;) {
    try { return await prepareFixtureRecall(fixture.info.dataDir, bot.id, threadId); }
    catch (error) { if (!String(error).includes("MEMORY_RECALL_STORAGE_LIMIT")) throw error; await sleep(100); }
  }
};
const ownerSendStatuses = () => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return (db.prepare("SELECT status FROM owner_sends WHERE text = ?").all(QUESTION) as Array<{ status: string }>).map(row => row.status); }
  finally { db.close(); }
};
const SITE_LOG = (site: string, threadId: string) => `[turn] held for rebuild (${site}) on thread ${threadId}`;

describe.skipIf(process.platform === "win32")("an owner turn held at the lease terminal when the server closes for a restart", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      process.env.NODE_ENV='test'; globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
      await import(${JSON.stringify(new URL("./testing/recall-ready-preload.mjs", import.meta.url).href)});
      const fs=await import('node:fs'), path=await import('node:path');
      const dir=process.env.MURAGE_DATA_DIR;
      const arm=name=>{const f=path.join(dir,'${INSTANCE}-arm-'+name);if(!fs.existsSync(f))return false;fs.rmSync(f,{force:true});return true;};
      const runs=await import(${JSON.stringify(pathToFileURL(join(dir, "independent-thread-runs.ts")).href)});
      const {Store}=await import(${JSON.stringify(pathToFileURL(join(dir, "store.ts")).href)});
      const { BUILT_IN_DRIVERS }=await import(${JSON.stringify(pathToFileURL(join(dir, "drivers/builtIn.ts")).href)});
      const { createAcpDriver }=await import(${JSON.stringify(pathToFileURL(join(dir, "drivers/acp/core.ts")).href)});
      BUILT_IN_DRIVERS.push(createAcpDriver({driverKind:'leaseFixture',displayName:'Lease fixture',models:{default:'opencode/mock',options:[{id:'opencode/mock',label:'Mock'}]},defaultCli:'unused',nativeSource:'lease.fixture',loginNote:'unused',spawnArgs:()=>[],pickAuthMethod:()=>null,authFailure:'continue',isAuthenticated:()=>true,fluxReach:()=>"elsewhere",mcpListedWait:true,toolBudget:{routeKey:()=> 'a'.repeat(64)},transformEnv:env=>{env.OPENCODE_CONFIG_CONTENT=JSON.stringify({permission:{'*':'ask'}})}}));
      const cfgFile=path.join(dir,'config.json'), cfg=JSON.parse(fs.readFileSync(cfgFile,'utf8'));
      cfg.computer={...cfg.computer,defaultForNewBots:'off'};
      const controls=${JSON.stringify(REQUIRED_CONTROLS.filter(n => n !== "project_propose"))};
      // one engine instance per cell, each with its own first-handshake gate (a gate a finished cell opened must not be seen by the next cell)
      for(const suffix of ['','b'])cfg.instances['${INSTANCE}'+suffix]={driver:'leaseFixture',displayName:'Lease fixture',config:{cli:${JSON.stringify(join(dir, "testing/fake-acp-cli.ts"))}},environment:{FAKE_ACP_MODE:'c11-budget',FAKE_C11_LOG:path.join(dir,'${INSTANCE}-engine.jsonl'),FAKE_C11_SPEC:JSON.stringify({native:11,limit:40,awaitCatalogExit:true,initialGate:path.join(dir,'${INSTANCE}-initial'+suffix),catalogs:{agents:[...controls,...Array.from({length:40},(_,i)=>'extra'+i)],'murage-memory':[]}})}};
      fs.writeFileSync(cfgFile,JSON.stringify(cfg));
      // The restart is a real SIGTERM the server sends itself (the graceful close). Nothing of the send, the turn or the close is replaced.
      let rebuildCloseThread=null,rebuildCloseWait=0,rebuildDelayOnly=false,signalled=()=>{};
      process.on('SIGTERM',()=>signalled());
      const close=threadId=>{fs.writeFileSync(path.join(dir,'${INSTANCE}-closed-at'),threadId);const seen=new Promise(resolve=>{signalled=resolve;});process.kill(process.pid,'SIGTERM');return seen;};
      // "lease-hold": the close begins right where holdForRebuild kept the run (the rebuild's start then waits 300 ms, so the close lands while the run is held);
      // "lease-start": the close begins at the rebuild's own start (the prepareThread hook below), which goes on 40 ms later
      const hold=runs.IndependentThreadRuns.prototype.holdForRebuild;
      runs.IndependentThreadRuns.prototype.holdForRebuild=function(run,...rest){
        const held=hold.call(this,run,...rest);
        if(held&&arm('lease-hold')){void close(run.threadId);rebuildCloseThread=run.threadId;rebuildCloseWait=300;rebuildDelayOnly=true;}
        else if(held&&arm('lease-start')){rebuildCloseThread=run.threadId;rebuildCloseWait=40;}
        return held;
      };
      const startWaits=()=>{const at=String(new Error('at').stack);return at.includes('runQueuedStart')||at.includes('startTurn');};
      const prepareThread=Store.prototype.prepareThread;
      Store.prototype.prepareThread=async function(threadId,...rest){
        if(startWaits()&&rebuildCloseThread===threadId){rebuildCloseThread=null;if(rebuildDelayOnly)rebuildDelayOnly=false;else await close(threadId);if(rebuildCloseWait>0)await new Promise(resolve=>setTimeout(resolve,rebuildCloseWait));}
        return prepareThread.call(this,threadId,...rest);
      };
    ` });
    await login();
  }, 180_000);
  afterAll(async () => { await fixture?.close(); });

  /** The owner's send reaches an engine that accepts a provider turn; before its first write the audience changes (the memory fence refuses that write at the
   * lease terminal, proven unwritten), the held turn meets a real SIGTERM at `moment`, and the next server starts on the same folder. */
  const refusedAtLeaseAsServerCloses = async (name: string, moment: "lease-hold" | "lease-start") => {
    rmSync(join(fixture.info.dataDir, "native/opencode-tool-limits.json"), { force: true });
    await new ToolLimitStore(join(fixture.info.dataDir, "native/opencode-tool-limits.json")).learn("a".repeat(64), 40, "opencode/mock");
    const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: moment === "lease-hold" ? INSTANCE : `${INSTANCE}b`, model: "opencode/mock" } })).bot as { id: string; threadId: string };
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    await recallReady(bot, bot.threadId);
    const closing = fixture.child, closingLog = fixture.info.logPath;
    const gate = moment === "lease-hold" ? "initial" : "initialb", promptsAtStart = prompts();
    rmSync(file("closed-at"), { force: true });
    writeFileSync(file(`arm-${moment}`), "");
    const sent = await raw("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: QUESTION });
    await expect.poll(() => existsSync(file(`${gate}.waiting`)), { timeout: 20_000 }).toBe(true);
    // the audience change that makes the memory fence refuse the engine's first write (the bot has no other past, so it is the bot's own role)
    await api("PATCH", `/api/bots/${bot.id}`, { individual: true });
    writeFileSync(file(gate), "");
    for (let waited = 0; waited < 30_000 && !exited(closing); waited += 50) await sleep(50);
    const closeLog = existsSync(closingLog) ? readFileSync(closingLog, "utf8") : "";
    const promptsBeforeRestart = prompts() - promptsAtStart;
    await fixture.restart();
    await login();
    // the next server gets time to run the message if the close wrongly left it waiting (a rerun would be a prompt and a reply)
    await sleep(10_000);
    const after = await lines(bot.threadId);
    const from = after.findIndex(message => message.role === "user" && message.text === QUESTION);
    const rows = after.slice(from < 0 ? 0 : from).filter(message => message.role === "bot" && message.kind === "activity");
    return {
      exited: exited(closing), closedAtThisThread: existsSync(file("closed-at")) && readFileSync(file("closed-at"), "utf8") === bot.threadId,
      siteLines: ["late-lease", "late-fold", "setup"].filter(site => closeLog.includes(SITE_LOG(site, bot.threadId))),
      sendAnswer: sent.status,
      ownerLines: after.filter(message => message.role === "user" && message.text === QUESTION).length,
      stoppedRows: rows.filter(message => message.tool?.name === STOPPED).length,
      errorRows: rows.filter(message => String(message.tool?.name ?? "").startsWith("error:")).length,
      sendStatuses: ownerSendStatuses().filter(status => status === "queued" || status === "started"),
      keptAt: /waits? for the next start \(kept at (\w+)\)/.exec(closeLog)?.[1] ?? "none",
      promptsBeforeRestart, promptsAfterRestart: prompts() - promptsAtStart - promptsBeforeRestart,
      answers: after.filter(message => message.role === "bot" && message.kind === "text" && message.text === "Fixture complete").length,
    };
  };
  const expectClosedWithItsLine = (late: Awaited<ReturnType<typeof refusedAtLeaseAsServerCloses>>) => {
    expect(late.stoppedRows, "exactly one close line").toBe(1);
    expect(late.errorRows, "no error row").toBe(0);
    expect(late.sendStatuses, "its send row is neither waiting nor started").toEqual([]);
    expect({ keptAt: late.keptAt, promptsAfterRestart: late.promptsAfterRestart, answers: late.answers }, "never run again").toEqual({ keptAt: "none", promptsAfterRestart: 0, answers: 0 });
    expect({ exited: late.exited, closedAtThisThread: late.closedAtThisThread, sendAnswer: late.sendAnswer, ownerLines: late.ownerLines, promptsBeforeRestart: late.promptsBeforeRestart }).toEqual({ exited: true, closedAtThisThread: true, sendAnswer: 202, ownerLines: 1, promptsBeforeRestart: 0 });
    expect(late.siteLines, "the hold site this cell went through (the lease terminal), asserted last: the behaviour above is what the cell guards").toEqual(["late-lease"]);
  };
  it("LEASE-HOLD: a turn refused at its lease terminal and held for its rebuild when the close begins gets the close line once, is not kept and never runs again", async () => {
    expectClosedWithItsLine(await refusedAtLeaseAsServerCloses("Lease hold", "lease-hold"));
  }, 240_000);
  it("LEASE-START: the same turn, the close beginning at its rebuild's own start, gets the close line once and never runs again", async () => {
    expectClosedWithItsLine(await refusedAtLeaseAsServerCloses("Lease start", "lease-start"));
  }, 240_000);
});
