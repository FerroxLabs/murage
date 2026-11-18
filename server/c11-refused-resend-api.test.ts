import { engineLimitLine } from "../shared/web-read-routing.ts";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { REQUIRED_CONTROLS, ToolLimitStore } from "./drivers/acp/opencode-tool-budget.ts";
import { prepareFixtureRecall } from "./testing/recall-ready-fixture.ts";

let fixture: VerificationServer, headers: Record<string, string>, gate: string, log: string;
// D7 (MurageMain ruling): a blocked rebuild after an UNCERTAIN submission is ONE row, the resend line, in place of the old card. A confirmed
// submission keeps its card.
const RESEND_LINE = "The AI may already be working on this message, so Murage did not send it twice. Use Send again to send it now.";
const blockedRow = (m: any) => m.tool?.name?.startsWith("error:") || m.memoryNote === "resend";

const dir = dirname(fileURLToPath(import.meta.url));
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
// Every refusal here needs a turn that holds memory. A turn sent before its recall view is built starts without recall after 300 ms (by design)
// and no roster change can refuse it, so each test waits for the view of the bot it sends to before sending (the fixture rule other suites use).
// The server keeps at most 128 recall views and this file's bots fill them: a new view then waits for the upkeep to reclaim an old one, so the
// wait repeats while the server answers that its view storage is full (a state, not a time limit).
const recallReady = async (bot: { id: string }, threadId: string) => {
  for (;;) {
    try { return await prepareFixtureRecall(fixture.info.dataDir, bot.id, threadId); }
    catch (error) { if (!String(error).includes("MEMORY_RECALL_STORAGE_LIMIT")) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
};
// The one refused-terminal settle (settleRefusedLeaseTerminal) as the server saw it: an arm per ticket it decides, and the decision itself.
const settles = () => { const f = join(fixture.info.dataDir, "refused-settle.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map(line => JSON.parse(line) as { step: "register" | "arm" | "decide"; turnId: string }) : []; };
const rows = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.NODE_ENV='test'; globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
    await import(${JSON.stringify(new URL("./testing/recall-ready-preload.mjs", import.meta.url).href)});
    const fs=await import('node:fs'), path=await import('node:path');
    globalThis[Symbol.for('murage.refusedSettle.trace')]=(step,turnId)=>fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR,'refused-settle.jsonl'),JSON.stringify({step,turnId})+'\\n');
    const { RoomPendingStop }=await import(${JSON.stringify(pathToFileURL(join(dir, "room-turn-timeout.ts")).href)});
    const roomStop=RoomPendingStop.prototype.stop;
    RoomPendingStop.prototype.stop=function(...args){fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR,'room-owner-stop'),'x');return roomStop.apply(this,args);};
    const { TurnSubmissionBoundary }=await import(${JSON.stringify(pathToFileURL(join(dir, "turn-dispatch-guard.ts")).href)});
    const proto=TurnSubmissionBoundary.prototype, before=proto.beforeSubmit, retry=Object.getOwnPropertyDescriptor(proto,'canRetry').get;
    const queued=new WeakSet();
    const arm=path.join(process.env.MURAGE_DATA_DIR,'stale-refusal-arm');
    proto.beforeSubmit=function(validate){
      if(!fs.existsSync(arm))return before.call(this,validate);
      const mode=fs.readFileSync(arm,'utf8');fs.unlinkSync(arm);
      if(mode==='retained'){this.alsoCheck(()=>{throw new Error('retained session changed');});return before.call(this,validate);}
      if(mode==='refuse'){const error=new Error('delegation submitted refusal');this.refuse(error);throw error;}
      // A sealed refusal can no longer release, so the stale release is recorded first: one attempt is released (no write), then the refusal lands.
      before.call(this,()=>{});if(mode==='action')queued.add(this);
      return before.call(this,()=>{throw new Error('MEMORY_CONTEXT_REVOKED');});
    };
    Object.defineProperty(proto,'canRetry',{get(){
      const value=retry.call(this);
      // Inject stale terminal eligibility after a release, to independently exercise the queued action guard.
      if(queued.has(this)){queued.delete(this);return true;}
      return value;
    }});
    // MC63 09:01Z capped room: while this marker exists every recall read answers that the view is not built yet (the view held absent).
    const { RecallReadiness }=await import(${JSON.stringify(pathToFileURL(join(dir, "memory/recall-readiness.ts")).href)});
    const { RecallViewLost }=await import(${JSON.stringify(pathToFileURL(join(dir, "memory/recall-recovery.ts")).href)});
    const noView=path.join(process.env.MURAGE_DATA_DIR,'noview-arm'),access=RecallReadiness.prototype.access;
    RecallReadiness.prototype.access=function(read,...rest){
      if(!fs.existsSync(noView))return access.call(this,read,...rest);
      return access.call(this,()=>{fs.appendFileSync(noView+'.reads',(rest[2]?.rebuild?'r':'x'));throw new RecallViewLost('held absent');},...rest);
    };
    const { SendStore }=await import(${JSON.stringify(pathToFileURL(join(dir, "send-store.ts")).href)});
    const markStopped=SendStore.prototype.markStopped;
    SendStore.prototype.markStopped=function(threadId){
      const result=markStopped.call(this,threadId);
      fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR,'owner-stops'),threadId+'\\n');return result;
    };
    const { BUILT_IN_DRIVERS }=await import(${JSON.stringify(pathToFileURL(join(dir, "drivers/builtIn.ts")).href)});
    const { createAcpDriver }=await import(${JSON.stringify(pathToFileURL(join(dir, "drivers/acp/core.ts")).href)});
    const driver=createAcpDriver({driverKind:'c11Fixture',displayName:'C11 fixture',models:{default:'opencode/mock',options:[{id:'opencode/mock',label:'Mock'}]},defaultCli:'unused',nativeSource:'c11.fixture',loginNote:'unused',spawnArgs:()=>[],pickAuthMethod:()=>null,authFailure:'continue',isAuthenticated:()=>true,fluxReach:()=>"elsewhere",mcpListedWait:true,toolBudget:{routeKey:()=> 'a'.repeat(64)},transformEnv:env=>{env.OPENCODE_CONFIG_CONTENT=JSON.stringify({permission:{'*':'ask'}})}});
    const create=driver.create;
    driver.create=async input=>{
      const instance=await create(input),send=instance.adapter.sendTurn.bind(instance.adapter);
      instance.adapter.onEvent(event=>{if(event.type==='turn.completed'&&event.stopReason==='submission_refused')fs.writeFileSync(input.environment.FAKE_C11_LOG+'.terminal','');});
      const interrupt=instance.adapter.interruptTurn.bind(instance.adapter);
      instance.adapter.interruptTurn=async(...args)=>{fs.appendFileSync(input.environment.FAKE_C11_LOG+'.stop','x');
        // Q2 room: the engine's close (every interrupt of this instance, the lease's and the owner's) is held until the test opens the gate.
        const closeGate=input.environment.FAKE_C11_CLOSE_GATE;
        if(closeGate&&!fs.existsSync(closeGate)){fs.writeFileSync(closeGate+'.waiting','');await new Promise(resolve=>{const poll=setInterval(()=>{if(fs.existsSync(closeGate)){clearInterval(poll);resolve();}},5);});}
        return interrupt(...args);};
      const teardown=instance.adapter.awaitTurnTeardown?.bind(instance.adapter);
      if(input.environment.FAKE_C11_TEARDOWN&&teardown)instance.adapter.awaitTurnTeardown=async(...args)=>{
        const result=await teardown(...args),gate=input.environment.FAKE_C11_TEARDOWN;
        if(fs.existsSync(input.environment.FAKE_C11_LOG+'.terminal')&&!fs.existsSync(gate)){
          fs.writeFileSync(gate+'.waiting','');await new Promise(resolve=>{const poll=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(poll);resolve();}},5);});
        }return result;
      };
      if(input.environment.FAKE_C11_DUPLICATE){const subscribe=instance.adapter.onEvent.bind(instance.adapter);instance.adapter.onEvent=listener=>subscribe((event,source)=>{listener(event,source);if(event.type==='turn.completed'){listener(event,source);setTimeout(()=>{listener(event,source);fs.writeFileSync(input.environment.FAKE_C11_LOG+'.duplicated','');},50);}});}
      instance.adapter.sendTurn=async turn=>{
        const value=await send({...turn,...(input.environment.FAKE_C11_UNCONFIRMED?{onEngineWrite:undefined,attemptWritten:undefined}:{})});
        const gate=input.environment.FAKE_C11_HANDBACK;
        if(gate&&!fs.existsSync(gate)){fs.writeFileSync(gate+'.waiting','');await new Promise(resolve=>{const poll=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(poll);resolve();}},5);});}
        // earlystopnever: the engine's child exits before it hands the turn id back: the close resolves now (no handback, no timer)
        if(gate&&fs.readFileSync(gate,'utf8')==='close'){turn.admissionNotLaunched?.();throw new Error('engine closed before handback');}
        return value;
      };return instance;
    };
    BUILT_IN_DRIVERS.push(driver);
    const data=process.env.MURAGE_DATA_DIR, file=path.join(data,'config.json'), cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    // A setup-time local-to-off switch interrupts the adapter and would pre-write the Stop acknowledgment.
    cfg.computer={...cfg.computer,defaultForNewBots:'off'};
    const controls=${JSON.stringify(REQUIRED_CONTROLS.filter(n => n !== "project_propose"))};
    // ENGINES-C11-1018:15: the provider consumes every catalog page before its session can prompt.
    cfg.instances.c11={driver:'c11Fixture',displayName:'C11 fixture',config:{cli:${JSON.stringify(join(dir, "testing/fake-acp-cli.ts"))}},environment:{FAKE_ACP_MODE:'c11-budget',FAKE_C11_LOG:path.join(data,'c11.jsonl'),FAKE_C11_SPEC:JSON.stringify({native:11,limit:40,awaitCatalogExit:true,recoveryGate:path.join(data,'c11-gate'),catalogs:{agents:[...controls,...Array.from({length:40},(_,i)=>'extra'+i)],'murage-memory':[]}})}};
    for(const variant of ['early','confirmed','uncertain','correction','unwritten','duplicate','stopped','teardowncard','concurrentA','concurrentB','restart','retained','refuse','roomunwritten','roompinned','roomqueue','roomconfirmed','roomuncertain','roomstop','roomclose','earlystop','earlyclose','earlystopfirst','earlystopnever','earlystopheld','roomnoview']){
      const item=structuredClone(cfg.instances.c11);
      item.environment.FAKE_C11_LOG=path.join(data,variant+'.jsonl');
      const spec=JSON.parse(item.environment.FAKE_C11_SPEC);spec.recoveryGate=path.join(data,variant+'-gate');item.environment.FAKE_C11_SPEC=JSON.stringify(spec);
      if(variant==='concurrentB'){spec.limit=48;item.environment.FAKE_C11_SPEC=JSON.stringify(spec);}
      if(variant==='early')item.environment.FAKE_C11_HANDBACK=path.join(data,'early-handback');
      else if((variant==='uncertain'||variant==='roomuncertain'))item.environment.FAKE_C11_UNCONFIRMED='1';
      else if(variant==='correction'||variant==='unwritten'||variant==='roomunwritten'||variant==='roompinned'||variant==='roomqueue'){if(variant==='correction'){spec.native=14;spec.initialGate=path.join(data,variant+'-initial');}else{spec.initialGate=path.join(data,variant+'-initial');delete spec.recoveryGate;}item.environment.FAKE_C11_SPEC=JSON.stringify(spec);}
      else if(variant==='duplicate')item.environment.FAKE_C11_DUPLICATE='1';
      else if(variant==='stopped'||variant==='teardowncard')item.environment.FAKE_C11_TEARDOWN=path.join(data,variant+'-teardown');
      else if(variant==='roomstop'||variant==='roomclose')item.environment.FAKE_C11_CLOSE_GATE=path.join(data,variant+'-close');
      else if(variant==='earlystop'||variant==='earlyclose'||variant==='earlystopfirst'||variant==='earlystopnever'){item.environment.FAKE_C11_HANDBACK=path.join(data,variant+'-handback');item.environment.FAKE_C11_TEARDOWN=path.join(data,variant+'-teardown');}
      if(variant==='earlystopheld'){item.environment.FAKE_C11_HANDBACK=path.join(data,variant+'-handback');item.environment.FAKE_C11_TEARDOWN=path.join(data,variant+'-teardown');item.environment.FAKE_C11_CLOSE_GATE=path.join(data,variant+'-close');}
      cfg.instances[variant]=item;
    }
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  gate = join(fixture.info.dataDir, "c11-gate"); log = join(fixture.info.dataDir, "c11.jsonl");
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 30000);
afterAll(async () => { await fixture?.close(); });

it.each(["c11", "early", "confirmed", "uncertain", "duplicate", "retained", "refuse"])("T37 c11-refused-resend-no-redispatch production ordering %s", async variant => {
  gate = join(fixture.info.dataDir, variant + "-gate"); log = join(fixture.info.dataDir, variant + ".jsonl");
  rmSync(join(fixture.info.dataDir, "native/opencode-tool-limits.json"), { force: true });
  const create = async (name: string) => {
    const response = await api("POST", "/api/bots", { name, modelSelection: { instanceId: variant, model: "opencode/mock" } });
    expect(response.status).toBe(201);
    const bot = response.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    return bot;
  };
  const bot = await create("C11 recovery"), bystander = await create("C11 roster");
  await recallReady(bot, bot.threadId);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Original owner request" })).status).toBe(202);
  await expect.poll(() => existsSync(gate + ".waiting"), { timeout: 20000 }).toBe(true);
  const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  const before = (await messages()).find(m => m.role === "user");
  if (variant !== "early") expect(before.dispatchedIn).toBeTruthy();
  expect(rows().filter(r => r.event === "prompt")).toHaveLength(1);
  const learned = JSON.parse(readFileSync(join(fixture.info.dataDir, "native/opencode-tool-limits.json"), "utf8"));
  expect(learned.routes["a".repeat(64)].limit).toBe(40);
  if (variant === "retained" || variant === "refuse") writeFileSync(join(fixture.info.dataDir, "stale-refusal-arm"), variant);
  else expect((await api("PATCH", `/api/bots/${bystander.id}`, { section: "Moved during recovery" })).status).toBe(200);
  writeFileSync(gate, "release");
  if (variant === "early") {
    await expect.poll(() => existsSync(log + ".terminal"), { timeout: 10000 }).toBe(true);
    writeFileSync(join(fixture.info.dataDir, "early-handback"), "release");
  }
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 20000 }).toBe(false);
  await expect.poll(async () => (await messages()).filter(blockedRow).length, { timeout: 10000 }).toBe(1);
  if (variant === "duplicate") await expect.poll(() => existsSync(log + ".duplicated"), { timeout: 10000 }).toBe(true);
  const after = await messages();
  expect(rows().filter(r => r.event === "spawn")).toHaveLength(2);
  expect(rows().filter(r => r.event === "prompt")).toHaveLength(1);
  if (variant === "early") expect(after.find(m => m.id === before.id).dispatchedIn).toBeTruthy();
  else expect(after.find(m => m.id === before.id).dispatchedIn).toBe(before.dispatchedIn);
  const errors = after.filter(blockedRow);
  expect(errors).toHaveLength(1);
  if (variant === "uncertain") {
    expect(errors[0].memoryNote).toBe("resend"); expect(errors[0].tool.name).toBe(RESEND_LINE); expect(errors[0].tool.ok).toBe(true);
    const askedC = after.filter(m => m.role === "user"); expect(askedC).toHaveLength(1); expect(errors[0].resendOf).toEqual({ messageId: askedC[0].id, threadId: bot.threadId, botId: bot.id });
    expect(JSON.stringify(after)).not.toContain("The earlier submission may have started.");
  } else {
    expect(errors[0].tool.name).toContain("The original message was submitted."); expect(errors[0].tool.ok).toBe(false);
    // Q1: an exact native write is confirmed, so the owner is never told to send what the engine already received.
    expect(errors[0].memoryNote).toBeUndefined(); expect(JSON.stringify(after)).not.toContain(RESEND_LINE);
  }
  expect(JSON.stringify(after)).not.toContain("could not start this reply");
  expect(readFileSync(fixture.info.logPath, "utf8")).not.toContain("re-preparing");
}, 60000);


it("C11 fixture session readiness waits for consumed catalogs", async () => {
  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline");
  const { once } = await import("node:events");
  const config = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).instances.c11;
  const catalogGate = join(fixture.info.dataDir, "catalog-read-gate"), catalogLog = join(fixture.info.dataDir, "catalog-read.jsonl");
  const spec = { ...JSON.parse(config.environment.FAKE_C11_SPEC), catalogReadGate: catalogGate };
  delete spec.recoveryGate;
  const child = spawn(process.execPath, [config.config.cli], { env: { ...process.env, ...config.environment, FAKE_C11_LOG: catalogLog, FAKE_C11_SPEC: JSON.stringify(spec) }, stdio: ["pipe", "pipe", "inherit"] });
  const closed = once(child, "close"), replies = new Map<number, (frame: any) => void>();
  createInterface({ input: child.stdout }).on("line", line => { const frame = JSON.parse(line); replies.get(frame.id)?.(frame); replies.delete(frame.id); });
  let id = 0;
  const request = (method: string, params: object = {}) => new Promise<any>(resolve => {
    replies.set(++id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    await request("initialize");
    let ready = false;
    const opening = request("session/new", { mcpServers: [{ name: "agents", env: [{ name: "MURAGE_MCP_LISTED_FILE", value: join(fixture.info.dataDir, "catalog-read-marker") }] }] }).then(() => { ready = true; });
    await expect.poll(() => existsSync(catalogGate + ".waiting"), { timeout: 10000 }).toBe(true);
    // The fake has processed this later RPC; its earlier session reply cannot still be in transit.
    await request("session/set_mode", { sessionId: "c11-session", modeId: "default" });
    expect(ready).toBe(false);
    writeFileSync(catalogGate, "release"); await opening;
    expect(JSON.parse(readFileSync(catalogLog, "utf8").trim().split("\n").at(-1)!).event).toBe("catalog");
  } finally {
    writeFileSync(catalogGate, "release"); child.kill("SIGTERM"); await closed;
  }
}, 30000);

it("T35 correction and recovery update one durable notice", async () => {
  log = join(fixture.info.dataDir, "correction.jsonl"); gate = join(fixture.info.dataDir, "correction-gate");
  const file = join(fixture.info.dataDir, "native/opencode-tool-limits.json");
  rmSync(file, { force: true }); await new ToolLimitStore(file).learn("a".repeat(64), 48, "opencode/mock");
  const created = await api("POST", "/api/bots", { name: "Correction notice", modelSelection: { instanceId: "correction", model: "opencode/mock" } });
  expect(created.status).toBe(201); const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  await recallReady(bot, bot.threadId);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Correct and recover" })).status).toBe(202);
  // ENGINES-C11-1018:19: distinguish cold startup from the replacement handshake and its one recovery prompt.
  const initial = join(fixture.info.dataDir, "correction-initial");
  await expect.poll(() => existsSync(initial + ".waiting"), { timeout: 10000 }).toBe(true);
  expect(rows().filter(r => r.event === "prompt")).toHaveLength(0);
  writeFileSync(initial, "release");
  await expect.poll(() => existsSync(gate + ".waiting"), { timeout: 10000 }).toBe(true);
  expect(rows().filter(r => r.event === "prompt").map(r => r.count)).toEqual([47]);
  const before = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages.filter((m: any) => m.tool?.name?.startsWith("Some tools were left out"));
  expect(before).toHaveLength(1); expect(before[0].tool.name).toContain("48 tools");
  writeFileSync(gate, "release");
  await expect.poll(() => rows().filter(r => r.event === "prompt").length, { timeout: 10000 }).toBe(2);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 10000 }).toBe(false);
  const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  const notices = messages.filter(m => m.tool?.name?.startsWith("Some tools were left out"));
  expect(notices).toHaveLength(1);
  expect(notices[0].id).toBe(before[0].id);
  expect(notices[0].tool.name).toContain("40 tools");
  expect(rows().filter(r => r.event === "spawn")).toHaveLength(3);
  expect(rows().filter(r => r.event === "prompt").map(r => r.count)).toEqual([47, 39]);
}, 30000);


it("T37 no-release control rebuilds after a notice without losing attribution", async () => {
  log = join(fixture.info.dataDir, "unwritten.jsonl");
  const file = join(fixture.info.dataDir, "native/opencode-tool-limits.json");
  rmSync(file, { force: true }); await new ToolLimitStore(file).learn("a".repeat(64), 40, "opencode/mock");
  const create = async (name: string) => {
    const response = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "unwritten", model: "opencode/mock" } });
    expect(response.status).toBe(201); const bot = response.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    return bot;
  };
  const bot = await create("Unwritten control"), other = await create("Unwritten bystander");
  await recallReady(bot, bot.threadId);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Rebuild once if unwritten" })).status).toBe(202);
  const initial = join(fixture.info.dataDir, "unwritten-initial");
  await expect.poll(() => existsSync(initial + ".waiting"), { timeout: 10000 }).toBe(true);
  expect((await api("PATCH", `/api/bots/${other.id}`, { section: "Moved before first write" })).status).toBe(200);
  writeFileSync(initial, "release");
  await expect.poll(() => rows().filter(r => r.event === "prompt").length, { timeout: 20000 }).toBe(1);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 10000 }).toBe(false);
  const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  expect(messages.filter(m => m.role === "user")).toHaveLength(1);
  expect(messages.find(m => m.role === "user").dispatchedIn).toBeTruthy();
  expect(messages.filter(m => m.tool?.name?.startsWith("error:"))).toHaveLength(0);
  expect(readFileSync(fixture.info.logPath, "utf8")).toContain(`context revoked at a late submission on thread ${bot.threadId}; re-preparing (1 of 2)`);
}, 45000);


it("c11-review-2 capped room rebuilds after notice and refused first fence", async () => {
  log = join(fixture.info.dataDir, "roomunwritten.jsonl");
  const file = join(fixture.info.dataDir, "native/opencode-tool-limits.json");
  rmSync(file, { force: true }); await new ToolLimitStore(file).learn("a".repeat(64), 40, "opencode/mock");
  const create = async (name: string) => {
    const response = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "roomunwritten", model: "opencode/mock" } });
    expect(response.status).toBe(201); const bot = response.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    return bot;
  };
  const bot = await create("Unwritten control"), other = await create("Unwritten bystander");
  const createdRoom = await api("POST", "/api/groups", { name: "Capped room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
  expect(createdRoom.status).toBe(201);
  const room = createdRoom.body.group;
  await recallReady(bot, room.threadId);
  expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Rebuild once if unwritten" })).status).toBe(202);
  const initial = join(fixture.info.dataDir, "roomunwritten-initial");
  await expect.poll(() => existsSync(initial + ".waiting"), { timeout: 10000 }).toBe(true);
  expect((await api("PATCH", `/api/bots/${other.id}`, { section: "Moved before first write" })).status).toBe(200);
  writeFileSync(initial, "release");
  await expect.poll(() => rows().filter(r => r.event === "prompt").length, { timeout: 20000 }).toBe(1);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 10000 }).toBe(false);
  const messages = (await api("GET", `/api/threads/${room.threadId}/messages?limit=100`)).body.messages as any[];
  expect(messages.filter(m => m.role === "user")).toHaveLength(1);
  expect(messages.some(m => m.role === "bot" && m.kind === "text")).toBe(true);
  expect(messages.filter(m => m.tool?.name?.startsWith("error:"))).toHaveLength(0);
  expect(readFileSync(fixture.info.logPath, "utf8")).toContain(`context revoked at a late submission on thread ${room.threadId}; re-preparing (1 of 2, room member`);
}, 45000);


it("T37 Stop after refusal prevents a notice or rebuild after teardown", async () => {
  log = join(fixture.info.dataDir, "stopped.jsonl"); gate = join(fixture.info.dataDir, "stopped-gate");
  rmSync(join(fixture.info.dataDir, "native/opencode-tool-limits.json"), { force: true });
  const create = async (name: string) => {
    const response = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "stopped", model: "opencode/mock" } });
    expect(response.status).toBe(201); const bot = response.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200); return bot;
  };
  const bot = await create("Stop refused resend"), other = await create("Stop bystander");
  await recallReady(bot, bot.threadId);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Stop this refused resend" })).status).toBe(202);
  await expect.poll(() => existsSync(gate + ".waiting"), { timeout: 10000 }).toBe(true);
  expect((await api("PATCH", `/api/bots/${other.id}`, { section: "Moved before resend Stop" })).status).toBe(200);
  writeFileSync(gate, "release");
  const teardown = join(fixture.info.dataDir, "stopped-teardown");
  await expect.poll(() => existsSync(teardown + ".waiting"), { timeout: 10000 }).toBe(true);
  // The refusal lease interrupts the engine itself; that is never the owner's Stop. The owner's Stop joins that one close (LLS S1): the
  // server reports the join, and the engine sees no second interrupt.
  const interrupts = () => existsSync(log + ".stop") ? readFileSync(log + ".stop", "utf8").length : 0, leaseInterrupts = interrupts();
  const joined = () => readFileSync(fixture.info.logPath, "utf8").includes(`[stop] owner Stop joined the refusal close on thread ${bot.threadId}`);
  // Model an HTTP Stop that reaches the server after the fixture poll.
  const stopping = new Promise(resolve => setTimeout(resolve, 100)).then(() => api("POST", `/api/bots/${bot.id}/interrupt`, {}));
  await expect.poll(joined, { timeout: 10000 }).toBe(true);
  expect(interrupts()).toBe(leaseInterrupts);
  writeFileSync(teardown, "release"); expect((await stopping).status).toBe(200);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 10000 }).toBe(false);
  const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  expect(rows().filter(r => r.event === "prompt")).toHaveLength(1);
  expect(messages.filter(m => m.tool?.name?.startsWith("error:"))).toHaveLength(0);
  // Q2: an owner Stop before the engine closed is a normal stopped state, with no refusal sentence of either kind
  expect(messages.filter(blockedRow)).toHaveLength(0);
  expect(JSON.stringify(messages)).not.toContain("The original message was submitted.");
  expect(messages.find(m => m.role === "user").dispatchedIn).toBeTruthy();
}, 45000);

it("Q2 without an owner Stop the refusal card is written once, when the engine has closed", async () => {
  log = join(fixture.info.dataDir, "teardowncard.jsonl"); gate = join(fixture.info.dataDir, "teardowncard-gate");
  rmSync(join(fixture.info.dataDir, "native/opencode-tool-limits.json"), { force: true });
  const create = async (name: string) => {
    const response = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "teardowncard", model: "opencode/mock" } });
    expect(response.status).toBe(201); const bot = response.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200); return bot;
  };
  const bot = await create("Card at close"), other = await create("Card bystander");
  await recallReady(bot, bot.threadId);
  const settledBefore = settles().length;
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Refused, never stopped" })).status).toBe(202);
  await expect.poll(() => existsSync(gate + ".waiting"), { timeout: 10000 }).toBe(true);
  expect((await api("PATCH", `/api/bots/${other.id}`, { section: "Moved before the resend" })).status).toBe(200);
  writeFileSync(gate, "release");
  const teardown = join(fixture.info.dataDir, "teardowncard-teardown");
  await expect.poll(() => existsSync(teardown + ".waiting"), { timeout: 10000 }).toBe(true);
  const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  // The engine has not closed yet. The lease interrupted it (never an owner Stop), and the owner is told nothing until it has closed.
  expect(existsSync(log + ".stop")).toBe(true);
  expect((await messages()).filter(blockedRow)).toHaveLength(0);
  writeFileSync(teardown, "release");
  await expect.poll(async () => (await messages()).filter(blockedRow).length, { timeout: 10000 }).toBe(1);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 10000 }).toBe(false);
  const after = await messages(), cards = after.filter(blockedRow);
  expect(cards).toHaveLength(1);
  expect(cards[0].tool.name).toContain("The original message was submitted."); expect(cards[0].tool.ok).toBe(false);
  expect(rows().filter(r => r.event === "prompt")).toHaveLength(1);
  expect(after.find(m => m.role === "user").dispatchedIn).toBeTruthy();
  // SETTLE-1 (one path): the card came from settleRefusedLeaseTerminal, armed once and decided once for this one ticket
  const mine = settles().slice(settledBefore).filter(s => s.step === "arm" || s.step === "decide");
  expect(mine.map(s => s.step)).toEqual(["arm", "decide"]);
  expect(new Set(mine.map(s => s.turnId)).size).toBe(1);
}, 45000);


it("T13/T37 concurrent threads sharing K keep their own refusal and attribution", async () => {
  const file = join(fixture.info.dataDir, "native/opencode-tool-limits.json");
  rmSync(file, { force: true });
  const bots: any[] = [];
  for (const variant of ["concurrentA", "concurrentB"]) {
    const created = await api("POST", "/api/bots", { name: variant, modelSelection: { instanceId: variant, model: "opencode/mock" } });
    expect(created.status).toBe(201); const bot = created.body.bot; bots.push(bot);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  }
  const messages = async (bot: any) => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  const idle = async (bot: any) => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy === false;
  // both views are ready together: the second pass proves the first bot's view was not reclaimed for the second's
  for (const bot of [...bots, ...bots]) await recallReady(bot, bot.threadId);
  await Promise.all(bots.map(async bot => expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Concurrent original" })).status).toBe(202)));
  for (const variant of ["concurrentA", "concurrentB"]) await expect.poll(() => existsSync(join(fixture.info.dataDir, variant + "-gate.waiting")), { timeout: 20000 }).toBe(true);
  const owners = await Promise.all(bots.map(async bot => (await messages(bot)).find(m => m.role === "user")));
  expect(owners.every(m => !!m.dispatchedIn)).toBe(true);
  writeFileSync(join(fixture.info.dataDir, "concurrentB-gate"), "release");
  await expect.poll(() => idle(bots[1]), { timeout: 20000 }).toBe(true);
  expect((await api("PATCH", `/api/bots/${bots[1].id}`, { section: "Revoke only the still-running turn" })).status).toBe(200);
  writeFileSync(join(fixture.info.dataDir, "concurrentA-gate"), "release");
  await expect.poll(() => idle(bots[0]), { timeout: 20000 }).toBe(true);
  const catalogs: string[][] = [];
  for (const [i, variant] of ["concurrentA", "concurrentB"].entries()) {
    log = join(fixture.info.dataDir, variant + ".jsonl");
    expect(rows().filter(r => r.event === "prompt")).toHaveLength(i === 0 ? 1 : 2);
    const after = await messages(bots[i]);
    expect(after.find(m => m.id === owners[i].id).dispatchedIn).toBe(owners[i].dispatchedIn);
    expect(after.filter(m => m.tool?.name?.startsWith("error:"))).toHaveLength(i === 0 ? 1 : 0);
    catalogs.push(rows().filter(r => r.event === "catalog").map(r => r.marker));
  }
  for (const markers of catalogs) { expect(markers.length).toBeGreaterThan(0); expect(markers.every(marker => typeof marker === "string" && marker.length > 0)).toBe(true); }
  expect(catalogs[0].some(path => catalogs[1].includes(path))).toBe(false);
  expect((await new ToolLimitStore(file).get("a".repeat(64)))?.limit).toBe(40);
}, 60000);

it.each(["terminal", "action"])("T37 stale queued redispatch checks live release at %s", async mode => {
  log = join(fixture.info.dataDir, "c11.jsonl");
  const countBefore = rows().filter(r => r.event === "prompt").length;
  const created = await api("POST", "/api/bots", { name: "Stale " + mode, modelSelection: { instanceId: "c11", model: "opencode/mock" } });
  expect(created.status).toBe(201); const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  writeFileSync(join(fixture.info.dataDir, "stale-refusal-arm"), mode);
  await recallReady(bot, bot.threadId);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Stale queue" })).status).toBe(202);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 20000 }).toBe(false);
  const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  const errors = messages.filter(blockedRow);
  expect(errors).toHaveLength(1);
  expect(errors[0].memoryNote).toBe("resend"); expect(errors[0].tool.name).toBe(RESEND_LINE);
  expect(errors[0].resendOf).toEqual({ messageId: messages.find(m => m.role === "user").id, threadId: bot.threadId, botId: bot.id });
  expect(JSON.stringify(messages)).not.toContain("The earlier submission may have started.");
  expect(messages.find(m => m.role === "user").dispatchedIn).toBeTruthy();
  expect(rows().filter(r => r.event === "prompt")).toHaveLength(countBefore);
}, 45000);

it("T9/T37 crash and registry recreation retain the original stamp without redispatch", async () => {
  log = join(fixture.info.dataDir, "restart.jsonl"); gate = join(fixture.info.dataDir, "restart-gate");
  const file = join(fixture.info.dataDir, "native/opencode-tool-limits.json");
  rmSync(file, { force: true });
  const created = await api("POST", "/api/bots", { name: "Restart recovery", modelSelection: { instanceId: "restart", model: "opencode/mock" } });
  expect(created.status).toBe(201); const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  await recallReady(bot, bot.threadId);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Preserve across crash" })).status).toBe(202);
  await expect.poll(() => existsSync(gate + ".waiting"), { timeout: 20000 }).toBe(true);
  expect((await api("PATCH", `/api/bots/${bot.id}`, { section: "Revoke before crash" })).status).toBe(200);
  writeFileSync(gate, "release");
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 20000 }).toBe(false);
  const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  const owner = (await messages()).find(m => m.role === "user");
  expect(owner.dispatchedIn).toBeTruthy(); expect(rows().filter(r => r.event === "prompt")).toHaveLength(1);
  expect((await messages()).filter(m => m.tool?.name?.startsWith("error:"))).toHaveLength(1);
  process.kill(fixture.info.pid, "SIGKILL");
  await fixture.restart();
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  expect((await messages()).find(m => m.id === owner.id).dispatchedIn).toBe(owner.dispatchedIn);
  expect(rows().filter(r => r.event === "prompt")).toHaveLength(1);
  expect((await new ToolLimitStore(file).get("a".repeat(64)))?.limit).toBe(40);
  await recallReady(bot, bot.threadId);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Explicit authorized new send" })).status).toBe(202);
  await expect.poll(() => rows().filter(r => r.event === "prompt").length, { timeout: 20000 }).toBe(2);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 20000 }).toBe(false);
  const after = await messages();
  expect(after.find(m => m.id === owner.id).dispatchedIn).toBe(owner.dispatchedIn);
  expect(after.filter(m => m.role === "user")).toHaveLength(2);
  expect(after.filter(m => m.tool?.name?.startsWith("error:"))).toHaveLength(1);
  expect(rows().filter(r => r.event === "prompt")[1].count).toBeLessThanOrEqual(40);
}, 60000);


it.each(["roomconfirmed", "roomuncertain"])("c11-review-3 room resend refusal preserves submission classification %s", async variant => {
  log = join(fixture.info.dataDir, variant + ".jsonl"); gate = join(fixture.info.dataDir, variant + "-gate");
  rmSync(join(fixture.info.dataDir, "native/opencode-tool-limits.json"), { force: true });
  const created = await api("POST", "/api/bots", { name: variant, modelSelection: { instanceId: variant, model: "opencode/mock" } });
  expect(created.status).toBe(201); const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const createdRoom = await api("POST", "/api/groups", { name: variant, memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
  expect(createdRoom.status).toBe(201); const room = createdRoom.body.group;
  await recallReady(bot, room.threadId);
  expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Original room request" })).status).toBe(202);
  await expect.poll(() => existsSync(gate + ".waiting"), { timeout: 20000 }).toBe(true);
  expect(rows().filter(r => r.event === "prompt")).toHaveLength(1);
  expect((await api("PATCH", `/api/bots/${bot.id}`, { section: "Moved before room resend" })).status).toBe(200);
  writeFileSync(gate, "release");
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 20000 }).toBe(false);
  const messages = (await api("GET", `/api/threads/${room.threadId}/messages?limit=100`)).body.messages as any[];
  const errors = messages.filter(m => m.tool?.ok === false || m.memoryNote === "resend");
  expect(errors).toHaveLength(2);
  expect(errors[0].tool).toEqual({ name: engineLimitLine("c11Fixture"), ok: false });
  if (variant === "roomuncertain") { expect(errors[1].memoryNote).toBe("resend"); expect(errors[1].tool.name).toBe(RESEND_LINE); expect(errors[1].from?.botId).toBe(bot.id); const asked = messages.filter(m => m.role === "user"); expect(asked).toHaveLength(1); expect(errors[1].resendOf).toEqual({ messageId: asked[0].id, threadId: room.threadId, botId: bot.id }); }
  else expect(errors[1].tool.name).toContain("The original message was submitted.");
  expect(JSON.stringify(messages)).not.toContain("could not start this reply");
  expect(rows().filter(r => r.event === "spawn")).toHaveLength(2);
  expect(rows().filter(r => r.event === "prompt")).toHaveLength(1);
}, 45000);

it("Q3 a stale queued message released before any write is not rebuilt and can be sent again", async () => {
  log = join(fixture.info.dataDir, "c11.jsonl");
  // every test resets the shared learned limit; a limit left by an earlier test changes this turn's spawns
  rmSync(join(fixture.info.dataDir, "native/opencode-tool-limits.json"), { force: true });
  const countBefore = rows().filter(r => r.event === "prompt").length, spawnsBefore = rows().filter(r => r.event === "spawn").length;
  const created = await api("POST", "/api/bots", { name: "Stale resend", modelSelection: { instanceId: "c11", model: "opencode/mock" } });
  expect(created.status).toBe(201); const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  writeFileSync(join(fixture.info.dataDir, "stale-refusal-arm"), "terminal");
  await recallReady(bot, bot.threadId);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Stale queue" })).status).toBe(202);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 20000 }).toBe(false);
  const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  expect(messages.filter(blockedRow)).toHaveLength(1);
  expect(messages.filter(blockedRow)[0].tool.name).toBe(RESEND_LINE);
  expect(rows().filter(r => r.event === "spawn")).toHaveLength(spawnsBefore + 1);
  expect(rows().filter(r => r.event === "prompt")).toHaveLength(countBefore);
  const owner = messages.find(m => m.role === "user");
  expect(owner.text).toBe("Stale queue");
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: owner.text })).status).toBe(202);
  await expect.poll(() => rows().filter(r => r.event === "prompt").length, { timeout: 20000 }).toBe(countBefore + 1);
  const again = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  expect(again.filter(m => m.role === "user").map(m => m.text)).toEqual(["Stale queue", "Stale queue"]);
}, 45000);

// Q2 room (MurageMain 03:29Z): the refusal card waits for the engine's close. An owner Stop pressed before the close is a normal stopped state
// (no refusal sentence); without one the card is written exactly once, after the close. The lease's own interrupt is never an owner Stop.
it.each(["roomstop", "roomclose"])("Q2 room refusal card waits for the engine's close and is not written after an owner Stop %s", async variant => {
  log = join(fixture.info.dataDir, variant + ".jsonl"); gate = join(fixture.info.dataDir, variant + "-gate");
  const close = join(fixture.info.dataDir, variant + "-close");
  rmSync(join(fixture.info.dataDir, "native/opencode-tool-limits.json"), { force: true });
  const created = await api("POST", "/api/bots", { name: variant, modelSelection: { instanceId: variant, model: "opencode/mock" } });
  expect(created.status).toBe(201); const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const createdRoom = await api("POST", "/api/groups", { name: variant, memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
  expect(createdRoom.status).toBe(201); const room = createdRoom.body.group;
  await recallReady(bot, room.threadId);
  expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Refused room request" })).status).toBe(202);
  await expect.poll(() => existsSync(gate + ".waiting"), { timeout: 20000 }).toBe(true);
  expect((await api("PATCH", `/api/bots/${bot.id}`, { section: "Moved before room close" })).status).toBe(200);
  writeFileSync(gate, "release");
  // the lease interrupted the engine; its close is held, so the refusal is decided and nothing may be told yet
  await expect.poll(() => existsSync(close + ".waiting"), { timeout: 20000 }).toBe(true);
  const messages = async () => (await api("GET", `/api/threads/${room.threadId}/messages?limit=100`)).body.messages as any[];
  const cards = (list: any[]) => list.filter(m => m.memoryNote === "resend" || m.tool?.name?.includes("The original message was submitted."));
  expect(cards(await messages())).toHaveLength(0);
  if (variant === "roomstop") {
    const stops = readFileSync(log + ".stop", "utf8").length;
    const ownerStop = join(fixture.info.dataDir, "room-owner-stop");
    const joined = () => existsSync(ownerStop) ? readFileSync(ownerStop, "utf8").length : 0, before = joined();
    const stopping = api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
    // The owner cancelled the operation before close; the train shares the lease's exact interrupt receipt.
    await expect.poll(joined, { timeout: 10000 }).toBe(before + 1);
    // The room shares its in-flight engine interrupt; the owner's cancellation is recorded, not a second provider call.
    const ownerStops = join(fixture.info.dataDir, "owner-stops");
    await expect.poll(() => existsSync(ownerStops) && readFileSync(ownerStops, "utf8").split("\n").includes(room.threadId), { timeout: 10000 }).toBe(true);
    expect(readFileSync(log + ".stop", "utf8").length).toBe(stops);
    writeFileSync(close, "release");
    expect((await stopping).status).toBe(200);
  } else writeFileSync(close, "release");
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 20000 }).toBe(false);
  if (variant === "roomclose") await expect.poll(async () => cards(await messages()).length, { timeout: 10000 }).toBe(1);
  const after = await messages();
  expect(cards(after)).toHaveLength(variant === "roomstop" ? 0 : 1);
  if (variant === "roomstop") { expect(JSON.stringify(after)).not.toContain(RESEND_LINE); expect(readFileSync(log + ".stop", "utf8")).toBe("x"); }
  expect(rows().filter(r => r.event === "prompt")).toHaveLength(1);
  expect(readFileSync(fixture.info.logPath, "utf8")).not.toContain(`thread ${room.threadId}; re-preparing`);
}, 45000);

// Q2 direct, refusal before the engine handed its turn id back (no late-memory ticket: the lease's confirmation is the decision). The row
// waits for the engine's teardown; an owner Stop pressed first leaves no refusal row; without one the row is written exactly once.
it.each(["earlystop", "earlyclose", "earlystopfirst", "earlystopnever", "earlystopheld"])("Q2 direct refusal before handback is told at teardown, and not after an owner Stop %s", async variant => {
  log = join(fixture.info.dataDir, variant + ".jsonl"); gate = join(fixture.info.dataDir, variant + "-gate");
  const handback = join(fixture.info.dataDir, variant + "-handback"), teardown = join(fixture.info.dataDir, variant + "-teardown");
  rmSync(join(fixture.info.dataDir, "native/opencode-tool-limits.json"), { force: true });
  const create = async (name: string) => {
    const response = await api("POST", "/api/bots", { name, modelSelection: { instanceId: variant, model: "opencode/mock" } });
    expect(response.status).toBe(201); const bot = response.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200); return bot;
  };
  const bot = await create(variant), other = await create(variant + " roster");
  await recallReady(bot, bot.threadId);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Refused before handback" })).status).toBe(202);
  await expect.poll(() => existsSync(gate + ".waiting"), { timeout: 20000 }).toBe(true);
  const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  if (variant === "earlystopheld") {
    // JOINT MAIN + MC63 2026-11-17T20:55Z: "If the confirmed Stop receipt exists before the refusal freezes, the turn ends silent and the card shows the Stop."
    // "If the refusal freezes while the Stop is still HELD (unconfirmed), the refusal row is shown."
    const close = join(fixture.info.dataDir, variant + "-close");
    writeFileSync(teardown, "release");
    const stopping = api("POST", `/api/bots/${bot.id}/interrupt`, {});
    await expect.poll(() => existsSync(close + ".waiting"), { timeout: 10000 }).toBe(true);
    expect((await api("PATCH", `/api/bots/${other.id}`, { section: "Moved before handback" })).status).toBe(200);
    writeFileSync(gate, "release");
    await expect.poll(() => existsSync(handback + ".waiting"), { timeout: 10000 }).toBe(true);
    writeFileSync(handback, "close");
    await new Promise(resolve => setTimeout(resolve, 1500));
    const held = await messages();
    expect(held.filter(blockedRow)).toHaveLength(1);
    expect(held.filter(m => m.murage?.kind === "status")).toHaveLength(0);
    writeFileSync(close, "release");
    await stopping;
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 20000 }).toBe(false);
    const after = await messages();
    expect(after.filter(blockedRow)).toHaveLength(1);
    expect(after.filter(m => m.murage?.kind === "status")).toHaveLength(0);
    return;
  }
  expect((await api("PATCH", `/api/bots/${other.id}`, { section: "Moved before handback" })).status).toBe(200);
  writeFileSync(gate, "release");
  await expect.poll(() => existsSync(log + ".terminal"), { timeout: 10000 }).toBe(true);
  if (variant === "earlystopnever") {
    // L2: the owner's Stop lands before the handback and the engine closes without ever handing the turn id back: no refusal row either
    const stopping = api("POST", `/api/bots/${bot.id}/interrupt`, {});
    await expect.poll(() => readFileSync(fixture.info.logPath, "utf8").includes(`owner Stop joined the refusal close on thread ${bot.threadId}`), { timeout: 10000 }).toBe(true);
    writeFileSync(handback, "close"); writeFileSync(teardown, "release");
    await stopping;
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 20000 }).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const after = await messages();
    expect(after.filter(blockedRow)).toHaveLength(0);
    // the teardown fallback's generic refusal row (a murage status line) is not told after the owner's Stop either
    expect(after.filter(m => m.murage?.kind === "status")).toHaveLength(0);
    expect(rows().filter(r => r.event === "prompt")).toHaveLength(1);
    return;
  }
  if (variant === "earlystopfirst") {
    // the owner's Stop lands BEFORE the engine handed its turn id back: it is kept by generation and still suppresses the row at teardown
    const stopping = api("POST", `/api/bots/${bot.id}/interrupt`, {});
    await expect.poll(() => readFileSync(fixture.info.logPath, "utf8").includes(`owner Stop joined the refusal close on thread ${bot.threadId}`), { timeout: 10000 }).toBe(true);
    writeFileSync(handback, "release");
    await expect.poll(() => existsSync(teardown + ".waiting"), { timeout: 10000 }).toBe(true);
    expect((await messages()).filter(blockedRow)).toHaveLength(0);
    writeFileSync(teardown, "release"); expect((await stopping).status).toBe(200);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 20000 }).toBe(false);
    // the row would be written after close: give the deferred teller its turn before asserting silence
    await new Promise(resolve => setTimeout(resolve, 1500));
    const after = await messages();
    expect(after.filter(blockedRow)).toHaveLength(0);
    expect(JSON.stringify(after)).not.toContain("The original message was submitted.");
    expect(rows().filter(r => r.event === "prompt")).toHaveLength(1);
    return;
  }
  writeFileSync(handback, "release");
  await expect.poll(() => existsSync(teardown + ".waiting"), { timeout: 10000 }).toBe(true);
  // the id is handed back and the engine has not closed: nothing is told yet
  expect((await messages()).filter(blockedRow)).toHaveLength(0);
  if (variant === "earlystop") {
    const interrupts = () => existsSync(log + ".stop") ? readFileSync(log + ".stop", "utf8").length : 0, leaseInterrupts = interrupts();
    const stopping = api("POST", `/api/bots/${bot.id}/interrupt`, {});
    // nc-shared LLS S1: the owner's Stop joins the refusal's one close (no second engine interrupt) and is still the owner's Stop
    await expect.poll(() => readFileSync(fixture.info.logPath, "utf8").includes(`owner Stop joined the refusal close on thread ${bot.threadId}`), { timeout: 10000 }).toBe(true);
    expect(interrupts()).toBe(leaseInterrupts);
    writeFileSync(teardown, "release"); expect((await stopping).status).toBe(200);
  } else writeFileSync(teardown, "release");
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 20000 }).toBe(false);
  if (variant === "earlyclose") await expect.poll(async () => (await messages()).filter(blockedRow).length, { timeout: 10000 }).toBe(1);
  const after = await messages();
  expect(after.filter(blockedRow)).toHaveLength(variant === "earlystop" ? 0 : 1);
  if (variant === "earlyclose") expect(after.filter(blockedRow)[0].tool.name).toContain("The original message was submitted.");
  else expect(JSON.stringify(after)).not.toContain("The original message was submitted.");
  expect(rows().filter(r => r.event === "prompt")).toHaveLength(1);
}, 45000);

// MC63 RULING 09:01Z: a room turn whose recall view stays absent never hangs. It waits the bounded view wait, takes the expiry fallback as
// direct does, and the owner sees the turn proceed (or a card if the fallback forbids it), never silence. The view is held absent for the
// whole turn (every recall read answers "not built yet"); the turn must reach the engine and end within the bound.
it("MC63 capped room: a room turn whose recall view stays absent takes the bounded fallback and is answered", async () => {
  log = join(fixture.info.dataDir, "roomnoview.jsonl");
  const limits = join(fixture.info.dataDir, "native/opencode-tool-limits.json");
  rmSync(limits, { force: true }); await new ToolLimitStore(limits).learn("a".repeat(64), 40, "opencode/mock");
  const created = await api("POST", "/api/bots", { name: "No view member", modelSelection: { instanceId: "roomnoview", model: "opencode/mock" } });
  expect(created.status).toBe(201); const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const createdRoom = await api("POST", "/api/groups", { name: "No view room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
  expect(createdRoom.status).toBe(201); const room = createdRoom.body.group;
  const arm = join(fixture.info.dataDir, "noview-arm");
  writeFileSync(arm, "");
  try {
    const sent = Date.now();
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Answer without a view" })).status).toBe(202);
    // the bound: the 300 ms probe schedule plus one held redispatch; 5 s leaves room for the fixture engine, not for a second wait
    await expect.poll(() => rows().filter(r => r.event === "prompt").length, { timeout: 5000 }).toBe(1);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 5000 }).toBe(false);
    expect(Date.now() - sent).toBeLessThan(10000);
    expect(readFileSync(arm + ".reads", "utf8").length).toBeGreaterThan(0);
    const messages = (await api("GET", `/api/threads/${room.threadId}/messages?limit=100`)).body.messages as any[];
    expect(messages.filter(m => m.role === "user")).toHaveLength(1);
    expect(messages.some(m => m.role === "bot" && m.kind === "text")).toBe(true);
    expect(messages.filter(m => m.tool?.name?.startsWith("error:"))).toHaveLength(0);
    expect(existsSync(join(fixture.info.dataDir, "roomnoview-gate.waiting"))).toBe(false);
  } finally { rmSync(arm, { force: true }); }
}, 45000);

it("SETTLE-1 every refused ticket of this file was settled by exactly one path, once", () => {
  const count = (step: string) => { const m = new Map<string, number>(); for (const s of settles()) if (s.step === step) m.set(s.turnId, (m.get(s.turnId) ?? 0) + 1); return m; };
  const registered = count("register"), arms = count("arm"), decides = count("decide");
  expect(registered.size).toBeGreaterThan(0);
  // Every registered identity must occur once in both trace sets, including the terminal fold's tickets.
  expect([...registered].filter(([turnId, n]) => n !== 1 || arms.get(turnId) !== 1 || decides.get(turnId) !== 1)).toEqual([]);
  expect([...arms.keys(), ...decides.keys()].filter(turnId => !registered.has(turnId))).toEqual([]);
});

it("c11-review-3 pinned capped room rebuilds after queueing, notice and refused first fence", async () => {
  expect((await api("PATCH", "/api/config", { features: { roomsQueue: false } })).status).toBe(200);
  log = join(fixture.info.dataDir, "roompinned.jsonl");
  const file = join(fixture.info.dataDir, "native/opencode-tool-limits.json");
  rmSync(file, { force: true }); await new ToolLimitStore(file).learn("a".repeat(64), 40, "opencode/mock");
  const create = async (name: string, instanceId = "roompinned") => {
    const response = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "opencode/mock" } });
    expect(response.status).toBe(201); const bot = response.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    return bot;
  };
  const bot = await create("Unwritten control"), other = await create("Unwritten bystander"), holder = await create("Queue control", "roomqueue");
  const createdRoom = await api("POST", "/api/groups", { name: "Capped room", memberIds: [holder.id, bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: holder.id } } });
  expect(createdRoom.status).toBe(201);
  const room = createdRoom.body.group;
  expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Hold the room queue" })).status).toBe(202);
  const queueGate = join(fixture.info.dataDir, "roomqueue-initial");
  await expect.poll(() => existsSync(queueGate + ".waiting"), { timeout: 10000 }).toBe(true);
  const queued = await api("POST", `/api/groups/${room.id}/messages`, { text: "Rebuild once if unwritten", sendId: "capped_pinned_123456", responderId: bot.id });
  expect(queued.status).toBe(202); expect(queued.body.queued).toBe(true);
  writeFileSync(queueGate, "release");
  const initial = join(fixture.info.dataDir, "roompinned-initial");
  await expect.poll(() => existsSync(initial + ".waiting"), { timeout: 10000 }).toBe(true);
  const { DatabaseSync } = await import("node:sqlite");
  const receipt = () => {
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try { return db.prepare("SELECT phase, terminal_outcome, binding_epoch FROM send_attempts WHERE thread_id=? AND send_id=?").get(room.threadId, "capped_pinned_123456") as { phase: string; terminal_outcome: string | null; binding_epoch: number }; }
    finally { db.close(); }
  };
  const before = receipt();
  expect(before.phase).not.toBe("terminal"); expect(before.binding_epoch).toBeGreaterThanOrEqual(2);
  expect((await api("PATCH", `/api/bots/${other.id}`, { section: "Moved before first write" })).status).toBe(200);
  writeFileSync(initial, "release");
  await expect.poll(() => rows().filter(r => r.event === "prompt").length, { timeout: 20000 }).toBe(1);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 10000 }).toBe(false);
  const messages = (await api("GET", `/api/threads/${room.threadId}/messages?limit=100`)).body.messages as any[];
  expect(messages.filter(m => m.role === "user")).toHaveLength(2);
  expect(messages.filter(m => m.role === "user" && m.sendId === "capped_pinned_123456")).toHaveLength(1);
  expect(messages.some(m => m.role === "bot" && m.kind === "text")).toBe(true);
  expect(messages.some(m => m.role === "bot" && m.kind === "text" && m.from?.botId === bot.id)).toBe(true);
  expect(messages.find(m => m.sendId === "capped_pinned_123456")).toMatchObject({ sendId: "capped_pinned_123456", responderBotId: bot.id });
  expect(messages.filter(m => m.tool?.name?.startsWith("error:"))).toHaveLength(0);
  expect(receipt()).toMatchObject({ phase: "terminal", terminal_outcome: "completed" });
  expect(receipt().binding_epoch).toBeGreaterThan(before.binding_epoch);
  expect(readFileSync(fixture.info.logPath, "utf8")).toContain(`context revoked at a late submission on thread ${room.threadId}; re-preparing (1 of 2, room member`);
}, 45000);
