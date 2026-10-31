// 1.0.10 C1: "Context changed; previous attempt may have started" only when
// the engine was really called. A memory refusal thrown in Murage's own prompt
// build, between dispatch and the adapter call (a cold lineage check right
// after a restart, "lineage-warming"), sent nothing: the turn is rebuilt and
// answered, never shown as "Context changed". The opposite case (an invoked
// engine that acted before its first write is never replayed) stays pinned by
// memory-submission-boundary-api.test.ts and memory-revoke-storm-api.test.ts.
//
// The fixture's engine throws that refusal from a property the dispatch reads
// inside the window, and only when the reading frame is that exact line of
// server/index.ts (found here from the source text), so it cannot fire at any
// other read. HEADLESS ONLY: a fake-engine verification server.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const INDEX = join(process.cwd(), "server", "index.ts");
const lineOf = (needle: string, after?: string): number => {
  const lines = readFileSync(INDEX, "utf8").split("\n");
  const from = after === undefined ? 0 : lines.findIndex(line => line.includes(after));
  const at = lines.findIndex((line, index) => index >= from && line.includes(needle));
  if (from < 0 || at < 0) throw new Error(`window line not found: ${needle}`);
  return at + 1;
};
// direct: the system layers are built after the dispatch was claimed and before the adapter is called
const DIRECT_LINE = lineOf("peerTask: peerTaskPrompt(text, instance.adapter.capabilities.agentsMcp !== true)");
// room: the member's working context is keyed after the dispatch was claimed and before the adapter is called
const ROOM_LINE = lineOf("workingContextForTurn(`${threadId}:${bot.id}:${instance.instanceId}`", "marked started when the adapter is called (roomFence.invoked)");

let fixture: VerificationServer;
let headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok, `${method} ${path} ${response.status}`).toBe(true);
  return await response.json() as any;
};
const login = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};
const file = (name: string) => join(fixture.info.dataDir, name);
const rows = (name: string) => existsSync(file(name)) ? readFileSync(file(name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
const isReply = (message: any) => message.role === "bot" && message.kind === "text" && message.text === "Hello from late";
const contextChanged = (all: any[]) => all.filter(message => String(message.tool?.name ?? "").includes("previous attempt may have started"));
const newBot = async (name: string) => {
  const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "window", model: "late-1" } })).bot as { id: string; threadId: string };
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  return bot;
};

describe.skipIf(process.platform === "win32")("C1: a refusal before the engine is called is rebuilt", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      const driver=makeLateTerminalDriver();
      const create=driver.create.bind(driver);
      // WINDOW_ARM: while this file exists, the read on the window's own line throws once (and the file is removed)
      const refusal=()=>Object.assign(new Error('MEMORY_CONTEXT_REVOKED'),{unproven:'lineage-warming'});
      const atLine=(line)=>String(new Error().stack).includes('index.ts:'+line+':');
      const fire=(arm,line)=>{ if(!fs.existsSync(arm)||!atLine(line))return false; fs.rmSync(arm,{force:true}); return true; };
      driver.create=async input=>{
        const instance=await create(input);
        const arm=input.environment.WINDOW_ARM;
        if(!arm)return instance;
        const caps=instance.adapter.capabilities;
        instance.adapter.capabilities=new Proxy(caps,{get(target,key,receiver){ if(key==='agentsMcp'&&fire(arm,${DIRECT_LINE}))throw refusal(); return Reflect.get(target,key,receiver); }});
        const id=instance.instanceId;
        Object.defineProperty(instance,'instanceId',{configurable:true,enumerable:true,get(){ if(fire(arm,${ROOM_LINE}))throw refusal(); return id; }});
        return instance;
      };
      BUILT_IN_DRIVERS.push(driver);
      const dir=process.env.MURAGE_DATA_DIR;
      const cfgFile=path.join(dir,'config.json');const cfg=JSON.parse(fs.readFileSync(cfgFile,'utf8'));
      cfg.instances.window={driver:'fakeLateTerminal',environment:{WINDOW_ARM:path.join(dir,'window-arm'),FAKE_LATE_SESSION_GATE:path.join(dir,'window-gate'),FAKE_LATE_DUMP:path.join(dir,'window-dump')}};
      fs.writeFileSync(cfgFile,JSON.stringify(cfg));
    ` });
    await login();
  }, 60_000);
  afterAll(async () => { await fixture?.close(); });

  for (const room of [false, true]) it(`${room ? "room" : "direct"}: rebuilt and answered once, one dispatch, no "Context changed"`, async () => {
    for (const name of ["window-dump", "window-gate.waiting"]) rmSync(file(name), { force: true });
    writeFileSync(file("window-gate"), "");
    const bot = await newBot(room ? "Window member" : "Window");
    const group = room ? (await api("POST", "/api/groups", { name: "Window room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).group : undefined;
    const threadId = group?.threadId ?? bot.threadId;
    writeFileSync(file("window-arm"), "");
    await api("POST", room ? `/api/groups/${group.id}/messages` : `/api/bots/${bot.id}/messages`, { threadId, text: "one question" });
    await expect.poll(async () => (await messages(threadId)).filter(isReply).length, { timeout: 60_000 }).toBe(1);
    // the refusal fired, in the window, exactly once
    expect(existsSync(file("window-arm"))).toBe(false);
    const all = await messages(threadId);
    expect(contextChanged(all)).toEqual([]);
    const sent = rows("window-dump").filter(row => row.threadId === threadId);
    // the refused build never reached the engine: exactly one dispatch
    expect(sent).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 1_000));
    expect((await messages(threadId)).filter(isReply)).toHaveLength(1);
  }, 120_000);

  it("a restart with a turn held in the engine, then a resend: answered first time, no \"Context changed\"", async () => {
    for (const name of ["window-dump", "window-gate", "window-gate.waiting", "window-arm"]) rmSync(file(name), { force: true });
    const bot = await newBot("Window restart");
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "a long job" });
    await expect.poll(() => existsSync(file("window-gate.waiting")), { timeout: 30_000 }).toBe(true);
    await fixture.restart();
    await login();
    writeFileSync(file("window-gate"), "");
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "a long job, again" });
    await expect.poll(async () => (await messages(bot.threadId)).filter(isReply).length, { timeout: 60_000 }).toBe(1);
    expect(contextChanged(await messages(bot.threadId))).toEqual([]);
  }, 120_000);
});
