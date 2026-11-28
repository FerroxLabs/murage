// 1.0.22 (Sean's Mac, 2026-11-22T02:15Z: a turn sent while the engines restarted got "This bot's AI connection is unavailable"):
// an owner's own turn that arrives while its engine is restarting WAITS for the engine and then runs; it is never failed.
// Through the REAL server routes: a booted server, the fake Claude CLI, PATCH /api/instances/:id (the engine restart) and
// POST /api/bots/:id/messages (the owner's send). The only fixture hook holds the restarting engine's own start
// (ClaudeDriver.create of that one instance) open until the gate file is removed, so the send lands inside the restart.
// Needs a POSIX host (the fake CLI is a shebang script).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { VerificationServer } from "../scripts/control-murage.ts";
import { launchMemoryVerificationServer as launchVerificationServer } from "./testing/memory-verification-fixture.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const RETAINED_PRELOAD_URL = pathToFileURL(join(SERVER_DIR, "testing", "claude-retained-session-preload.mjs")).href;
const STORE_URL = pathToFileURL(join(SERVER_DIR, "store.ts")).href;
const CLAUDE_URL = pathToFileURL(join(SERVER_DIR, "drivers", "claude.ts")).href;
const posixOnly = describe.skipIf(process.platform === "win32");

const instrumentation = `
  await import(${JSON.stringify(RETAINED_PRELOAD_URL)});
  const fs=await import('node:fs');const path=await import('node:path');
  const dir=process.env.MURAGE_DATA_DIR;
  const cfgFile=path.join(dir,'config.json');const cfg=JSON.parse(fs.readFileSync(cfgFile,'utf8'));
  cfg.instances.restarting={...cfg.instances.verification,displayName:'Restarting fixture'};
  fs.writeFileSync(cfgFile,JSON.stringify(cfg));
  // the restarting engine's start stays open while the gate file exists (how long an engine takes to start; nothing of the turn path)
  const {ClaudeDriver}=await import(${JSON.stringify(CLAUDE_URL)});
  const create=ClaudeDriver.create;const gate=path.join(dir,'engine-gate');
  ClaudeDriver.create=async function(input){
    if(input.instanceId==='restarting'){fs.writeFileSync(path.join(dir,'engine-starting'),'');while(fs.existsSync(gate))await new Promise(r=>setTimeout(r,25));}
    return create.call(this,input);
  };
  const {Store}=await import(${JSON.stringify(STORE_URL)});
  let store;
  for(const name of ['taskByThread','bot']){const original=Store.prototype[name];Store.prototype[name]=function(...args){store=this;return original.apply(this,args);};}
  const ctl=path.join(dir,'rw-ctl.json');const out=path.join(dir,'rw-out.json');
  setInterval(()=>{
    let command;try{command=JSON.parse(fs.readFileSync(ctl,'utf8'));}catch{return;}
    fs.rmSync(ctl,{force:true});
    const result={id:command.id};
    try{if(command.nativeWarm)store.patchBot(command.nativeWarm,{draftOnly:true,computer:'off',browser:false});}catch(error){result.error=String(error);}
    fs.writeFileSync(out,JSON.stringify(result));
  },30).unref();
`;

posixOnly("an owner turn sent while its engine restarts waits for the engine (real routes)", () => {
  it("the send is accepted once the engine is back and the bot replies; a switched-off engine still answers unavailable at once", async () => {
    const fixture: VerificationServer = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
    let headers: Record<string, string> = {};
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      return { status: response.status, body: parsed, text };
    };
    const file = (name: string) => join(fixture.info.dataDir, name);
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitUntil = async (check: () => unknown | Promise<unknown>, what: string, ms = 30_000) => {
      const end = Date.now() + ms;
      while (!(await check())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
    };
    const readJson = (path: string) => { try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null; } catch { return null; } };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await call("GET", "/api/desktop-secret")).body.secret };
    const instance = (await call("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === "restarting");
    const modelSelection = { instanceId: "restarting", model: instance.models.options[0].id };
    const created = await call("POST", "/api/bots", { name: "restart-wait", modelSelection, requireAvailableModel: true });
    expect(created.status, created.text).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await call("PATCH", `/api/bots/${bot.id}`, { modelSelection, computer: "off" })).status).toBe(200);
    writeFileSync(file("rw-ctl.json"), JSON.stringify({ nativeWarm: bot.id, id: 1 }));
    await waitUntil(() => readJson(file("rw-out.json"))?.id === 1, "the control response", 10_000);
    const isIdle = async () => (await call("GET", "/api/bots")).body.bots.find((entry: any) => entry.id === bot.id)?.busy === false;
    const botReplies = async () => ((await call("GET", `/api/threads/${bot.threadId}/messages`)).body.messages as any[]).filter((m) => m.role === "bot" && m.kind === "text" && String(m.text ?? "").trim()).length;
    const send = (text: string) => call("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
    // one ordinary turn first: the engine works
    expect((await send("RESTART_WAIT one")).status).toBe(202);
    await waitUntil(async () => (await botReplies()) >= 1 && (await isIdle()), "the first reply");
    const repliesBefore = await botReplies();

    // the engine restarts (switched off, then on again); its start is held open
    expect((await call("PATCH", "/api/instances/restarting", { enabled: false })).status).toBe(200);
    writeFileSync(file("engine-gate"), "");
    rmSync(file("engine-starting"), { force: true });
    const restart = call("PATCH", "/api/instances/restarting", { enabled: true });
    await waitUntil(() => existsSync(file("engine-starting")), "the engine start to begin", 15_000);
    // the owner sends while it is still starting
    let answeredAt = 0;
    const sending = send("RESTART_WAIT two").then((answer) => { answeredAt = Date.now(); return answer; });
    await sleep(1_500);
    const answeredWhileStarting = answeredAt !== 0;
    const engineBackAt = Date.now();
    rmSync(file("engine-gate"));
    expect((await restart).status).toBe(200);
    const sent = await sending;
    if (sent.status === 202) await waitUntil(async () => (await botReplies()) > repliesBefore && (await isIdle()), "the waited turn's reply");
    const replied = (await botReplies()) > repliesBefore;
    // RESTART-WAIT:waits — the send is not answered (failed) while the engine starts; it is accepted after the engine is back and
    // the bot replies (base 08c6017e2c: 409 at once, the message is not sent)
    expect({ answeredWhileStarting, status: sent.status, error: sent.status === 202 ? null : sent.body?.error ?? sent.text, afterEngine: answeredAt >= engineBackAt, replied }).toEqual({ answeredWhileStarting: false, status: 202, error: null, afterEngine: true, replied: true });

    // guard: an engine that is switched off (not restarting) still answers at once with the unavailable line, never a wait
    expect((await call("PATCH", "/api/instances/restarting", { enabled: false })).status).toBe(200);
    const offAt = Date.now();
    const off = await send("RESTART_WAIT three");
    expect({ status: off.status, unavailable: String(off.body?.error ?? off.text).includes("AI connection is unavailable"), prompt: Date.now() - offAt < 5_000 }).toEqual({ status: 409, unavailable: true, prompt: true });
  }, 180_000);
});
