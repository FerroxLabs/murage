import { engineLimitLine } from "../shared/web-read-routing.ts";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { REQUIRED_CONTROLS, ToolLimitStore } from "./drivers/acp/opencode-tool-budget.ts";

let fixture: VerificationServer, headers: Record<string, string>, gate: string, log: string;
const dir = dirname(fileURLToPath(import.meta.url));
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const rows = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.NODE_ENV='test'; globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
    const fs=await import('node:fs'), path=await import('node:path');
    const { TurnSubmissionBoundary }=await import(${JSON.stringify(pathToFileURL(join(dir, "turn-dispatch-guard.ts")).href)});
    const proto=TurnSubmissionBoundary.prototype, before=proto.beforeSubmit, retry=Object.getOwnPropertyDescriptor(proto,'canRetry').get;
    const queued=new WeakSet();
    const arm=path.join(process.env.MURAGE_DATA_DIR,'stale-refusal-arm');
    proto.beforeSubmit=function(validate){
      if(!fs.existsSync(arm))return before.call(this,validate);
      const mode=fs.readFileSync(arm,'utf8');fs.unlinkSync(arm);
      if(mode==='retained'){this.alsoCheck(()=>{throw new Error('retained session changed');});return before.call(this,validate);}
      if(mode==='refuse'){const error=new Error('delegation submitted refusal');this.refuse(error);throw error;}
      try{return before.call(this,()=>{throw new Error('MEMORY_CONTEXT_REVOKED');});}
      catch(error){before.call(this,()=>{});if(mode==='action')queued.add(this);throw error;}
    };
    Object.defineProperty(proto,'canRetry',{get(){
      const value=retry.call(this);
      // Inject stale terminal eligibility after a release, to independently exercise the queued action guard.
      if(queued.has(this)){queued.delete(this);return true;}
      return value;
    }});
    const { BUILT_IN_DRIVERS }=await import(${JSON.stringify(pathToFileURL(join(dir, "drivers/builtIn.ts")).href)});
    const { createAcpDriver }=await import(${JSON.stringify(pathToFileURL(join(dir, "drivers/acp/core.ts")).href)});
    const driver=createAcpDriver({driverKind:'c11Fixture',displayName:'C11 fixture',models:{default:'opencode/mock',options:[{id:'opencode/mock',label:'Mock'}]},defaultCli:'unused',nativeSource:'c11.fixture',loginNote:'unused',spawnArgs:()=>[],pickAuthMethod:()=>null,authFailure:'continue',isAuthenticated:()=>true,mcpListedWait:true,toolBudget:{routeKey:()=> 'a'.repeat(64)},transformEnv:env=>{env.OPENCODE_CONFIG_CONTENT=JSON.stringify({permission:{'*':'ask'}})}});
    const create=driver.create;
    driver.create=async input=>{
      const instance=await create(input),send=instance.adapter.sendTurn.bind(instance.adapter);
      instance.adapter.onEvent(event=>{if(event.type==='turn.completed'&&event.stopReason==='submission_refused')fs.writeFileSync(input.environment.FAKE_C11_LOG+'.terminal','');});
      const interrupt=instance.adapter.interruptTurn.bind(instance.adapter);
      instance.adapter.interruptTurn=async(...args)=>{fs.writeFileSync(input.environment.FAKE_C11_LOG+'.stop','');return interrupt(...args);};
      const teardown=instance.adapter.awaitTurnTeardown?.bind(instance.adapter);
      if(input.environment.FAKE_C11_TEARDOWN&&teardown)instance.adapter.awaitTurnTeardown=async(...args)=>{
        const result=await teardown(...args),gate=input.environment.FAKE_C11_TEARDOWN;
        if(fs.existsSync(input.environment.FAKE_C11_LOG+'.terminal')&&!fs.existsSync(gate)){
          fs.writeFileSync(gate+'.waiting','');await new Promise(resolve=>{const poll=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(poll);resolve();}},5);});
        }return result;
      };
      if(input.environment.FAKE_C11_DUPLICATE){const subscribe=instance.adapter.onEvent.bind(instance.adapter);instance.adapter.onEvent=listener=>subscribe(event=>{listener(event);if(event.type==='turn.completed'){listener(event);setTimeout(()=>{listener(event);fs.writeFileSync(input.environment.FAKE_C11_LOG+'.duplicated','');},50);}});}
      instance.adapter.sendTurn=async turn=>{
        const value=await send({...turn,...(input.environment.FAKE_C11_UNCONFIRMED?{onEngineWrite:undefined}:{})});
        const gate=input.environment.FAKE_C11_HANDBACK;
        if(gate&&!fs.existsSync(gate)){fs.writeFileSync(gate+'.waiting','');await new Promise(resolve=>{const poll=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(poll);resolve();}},5);});}
        return value;
      };return instance;
    };
    BUILT_IN_DRIVERS.push(driver);
    const data=process.env.MURAGE_DATA_DIR, file=path.join(data,'config.json'), cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    // A setup-time local-to-off switch interrupts the adapter and would pre-write the Stop acknowledgment.
    cfg.computer={...cfg.computer,defaultForNewBots:'off'};
    const controls=${JSON.stringify(REQUIRED_CONTROLS.filter(n => n !== "project_propose"))};
    cfg.instances.c11={driver:'c11Fixture',displayName:'C11 fixture',config:{cli:${JSON.stringify(join(dir, "testing/fake-acp-cli.ts"))}},environment:{FAKE_ACP_MODE:'c11-budget',FAKE_C11_LOG:path.join(data,'c11.jsonl'),FAKE_C11_SPEC:JSON.stringify({native:11,limit:40,recoveryGate:path.join(data,'c11-gate'),catalogs:{agents:[...controls,...Array.from({length:40},(_,i)=>'extra'+i)],'murage-memory':[]}})}};
    for(const variant of ['early','uncertain','correction','unwritten','duplicate','stopped','concurrentA','concurrentB','restart','retained','refuse','roomunwritten','roomconfirmed','roomuncertain']){
      const item=structuredClone(cfg.instances.c11);
      item.environment.FAKE_C11_LOG=path.join(data,variant+'.jsonl');
      const spec=JSON.parse(item.environment.FAKE_C11_SPEC);spec.recoveryGate=path.join(data,variant+'-gate');item.environment.FAKE_C11_SPEC=JSON.stringify(spec);
      if(variant==='concurrentB'){spec.limit=48;item.environment.FAKE_C11_SPEC=JSON.stringify(spec);}
      if(variant==='early')item.environment.FAKE_C11_HANDBACK=path.join(data,'early-handback');
      else if((variant==='uncertain'||variant==='roomuncertain'))item.environment.FAKE_C11_UNCONFIRMED='1';
      else if(variant==='correction'||variant==='unwritten'||variant==='roomunwritten'){if(variant==='correction')spec.native=14;else spec.initialGate=path.join(data,variant+'-initial');delete spec.recoveryGate;item.environment.FAKE_C11_SPEC=JSON.stringify(spec);}
      else if(variant==='duplicate')item.environment.FAKE_C11_DUPLICATE='1';
      else if(variant==='stopped')item.environment.FAKE_C11_TEARDOWN=path.join(data,'stopped-teardown');
      cfg.instances[variant]=item;
    }
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  gate = join(fixture.info.dataDir, "c11-gate"); log = join(fixture.info.dataDir, "c11.jsonl");
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 30000);
afterAll(async () => { await fixture?.close(); });

it.each(["c11", "early", "uncertain", "duplicate", "retained", "refuse"])("T37 c11-refused-resend-no-redispatch production ordering %s", async variant => {
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
  await expect.poll(async () => (await messages()).filter(m => m.tool?.name?.startsWith("error:")).length, { timeout: 10000 }).toBe(1);
  if (variant === "duplicate") await expect.poll(() => existsSync(log + ".duplicated"), { timeout: 10000 }).toBe(true);
  const after = await messages();
  expect(rows().filter(r => r.event === "spawn")).toHaveLength(2);
  expect(rows().filter(r => r.event === "prompt")).toHaveLength(1);
  if (variant === "early") expect(after.find(m => m.id === before.id).dispatchedIn).toBeTruthy();
  else expect(after.find(m => m.id === before.id).dispatchedIn).toBe(before.dispatchedIn);
  const errors = after.filter(m => m.tool?.name?.startsWith("error:"));
  expect(errors).toHaveLength(1);
  expect(errors[0].tool.name).toContain(variant === "uncertain" ? "The earlier submission may have started." : "The original message was submitted.");
  expect(errors[0].tool.ok).toBe(false);
  expect(JSON.stringify(after)).not.toContain("could not start this reply");
  expect(readFileSync(fixture.info.logPath, "utf8")).not.toContain("re-preparing");
}, 60000);


it("T35 correction and recovery update one durable notice", async () => {
  log = join(fixture.info.dataDir, "correction.jsonl");
  const file = join(fixture.info.dataDir, "native/opencode-tool-limits.json");
  rmSync(file, { force: true }); await new ToolLimitStore(file).learn("a".repeat(64), 48, "opencode/mock");
  const created = await api("POST", "/api/bots", { name: "Correction notice", modelSelection: { instanceId: "correction", model: "opencode/mock" } });
  expect(created.status).toBe(201); const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Correct and recover" })).status).toBe(202);
  await expect.poll(() => rows().filter(r => r.event === "prompt").length, { timeout: 10000 }).toBe(2);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 10000 }).toBe(false);
  const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  const notices = messages.filter(m => m.tool?.name?.startsWith("Some tools were left out"));
  expect(notices).toHaveLength(1);
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
  expect(readFileSync(fixture.info.logPath, "utf8")).toContain(`context revoked at a late submission on thread ${bot.threadId}; re-preparing (1 of 3)`);
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
  expect(readFileSync(fixture.info.logPath, "utf8")).toContain(`context revoked at a late submission on thread ${room.threadId}; re-preparing (1 of 3, room member`);
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
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Stop this refused resend" })).status).toBe(202);
  await expect.poll(() => existsSync(gate + ".waiting"), { timeout: 10000 }).toBe(true);
  expect((await api("PATCH", `/api/bots/${other.id}`, { section: "Moved before resend Stop" })).status).toBe(200);
  writeFileSync(gate, "release");
  const teardown = join(fixture.info.dataDir, "stopped-teardown");
  await expect.poll(() => existsSync(teardown + ".waiting"), { timeout: 10000 }).toBe(true);
  expect(existsSync(log + ".stop")).toBe(false);
  // Model an HTTP Stop that reaches the server after the fixture poll.
  const stopping = new Promise(resolve => setTimeout(resolve, 100)).then(() => api("POST", `/api/bots/${bot.id}/interrupt`, {}));
  await expect.poll(() => existsSync(log + ".stop"), { timeout: 10000 }).toBe(true);
  writeFileSync(teardown, "release"); expect((await stopping).status).toBe(200);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 10000 }).toBe(false);
  const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  expect(rows().filter(r => r.event === "prompt")).toHaveLength(1);
  expect(messages.filter(m => m.tool?.name?.startsWith("error:"))).toHaveLength(0);
  expect(messages.find(m => m.role === "user").dispatchedIn).toBeTruthy();
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
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Stale queue" })).status).toBe(202);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 20000 }).toBe(false);
  const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  const errors = messages.filter(m => m.tool?.name?.startsWith("error:"));
  expect(errors).toHaveLength(1);
  expect(errors[0].tool.name).toContain("The earlier submission may have started.");
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
  expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Original room request" })).status).toBe(202);
  await expect.poll(() => existsSync(gate + ".waiting"), { timeout: 20000 }).toBe(true);
  expect(rows().filter(r => r.event === "prompt")).toHaveLength(1);
  expect((await api("PATCH", `/api/bots/${bot.id}`, { section: "Moved before room resend" })).status).toBe(200);
  writeFileSync(gate, "release");
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 20000 }).toBe(false);
  const messages = (await api("GET", `/api/threads/${room.threadId}/messages?limit=100`)).body.messages as any[];
  const errors = messages.filter(m => m.tool?.ok === false);
  // 9e6f55e198 adds the declared engine limitation before the one resend refusal.
  expect(errors).toHaveLength(2);
  expect(errors[0].tool).toEqual({ name: engineLimitLine("c11Fixture"), ok: false });
  expect(errors[1].tool.name).toContain(variant === "roomuncertain" ? "The earlier submission may have started." : "The original message was submitted.");
  expect(JSON.stringify(messages)).not.toContain("could not start this reply");
  expect(rows().filter(r => r.event === "spawn")).toHaveLength(2);
  expect(rows().filter(r => r.event === "prompt")).toHaveLength(1);
}, 45000);
