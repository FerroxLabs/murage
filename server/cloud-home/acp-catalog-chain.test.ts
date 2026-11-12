import { expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { launchVerificationServer } from "../../scripts/control-murage.ts";
import { readMcpCatalog } from "../mcp-listed.ts";
import { REQUIRED_CONTROLS } from "../drivers/acp/opencode-tool-budget.ts";

// T34: no marker, namespace, publication URL or publication env is supplied here.
// The only substituted services are the ACP engine and its loopback upstreams.
const chainTest = async (recover: boolean) => {
  const root = mkdtempSync(join(tmpdir(), "c11-chain-"));
  const log = join(root, "engine.jsonl"), preload = join(root, "hold.mjs");
  const sessionRelease = join(root, "session-release"), finish = join(root, "finish"), loadRelease = join(root, "load-release"), relist = join(root, "relist");
  const serverModule = (path: string) => new URL(`../${path}`, import.meta.url).href;
  const engine = fileURLToPath(new URL("../testing/c11-chain-engine.mjs", import.meta.url));
  writeFileSync(preload, `import {existsSync,writeFileSync,readFileSync} from 'node:fs';import {basename,join} from 'node:path';
    const marker=process.env.MURAGE_MCP_LISTED_FILE,write=process.stdout.write.bind(process.stdout);
    if(marker&&process.argv[2]!=='pipe')process.stdout.write=function(chunk,...args){
      if(String(chunk).includes('"tools":[')){
        const gate=join(${JSON.stringify(root)},basename(marker));writeFileSync(gate+'.held',JSON.stringify({catalog:existsSync(marker)?JSON.parse(readFileSync(marker,'utf8')):null}));
        const timer=setInterval(()=>{if(existsSync(gate+'.release')){clearInterval(timer);write(chunk,...args);}},5);return true;
      }return write(chunk,...args);
    };`);
  const names = REQUIRED_CONTROLS.filter(name => name !== "project_propose");
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.NODE_ENV='test';globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
    const fs=await import('node:fs'),path=await import('node:path');
    const {Server}=await import('node:http');const {WebSocketServer}=await import(${JSON.stringify(import.meta.resolve('ws'))});
    const ws=new WebSocketServer({noServer:true});
    ws.on('connection',socket=>socket.on('message',raw=>{const frame=JSON.parse(String(raw));socket.send(JSON.stringify({jsonrpc:'2.0',id:frame.id,result:frame.method==='initialize'?{capabilities:{tools:{},resources:{}}}:{tools:[{name:'served',inputSchema:{anyOf:[{type:'object',properties:{x:{type:'string'}}}]}}]}}));}));
    const emit=Server.prototype.emit;
    Server.prototype.emit=function(event,...args){
      const [req,res,head]=args;
      // C-1: the first publication a legitimate proxy makes is refused (the stand-in for a 403 at the harness).
      if(${recover}&&event==='request'&&req.method==='POST'&&req.url.startsWith('/api/internal/mcp-catalog/')&&!globalThis.__c11Refused){globalThis.__c11Refused=req.url;fs.writeFileSync(${JSON.stringify(join(root, 'refused.txt'))},req.url);req.resume();res.statusCode=403;res.end();return true;}
      if(event==='upgrade'&&req.url.startsWith('/api/internal/vps-mcp/')){ws.handleUpgrade(req,res,head,socket=>ws.emit('connection',socket,req));return true;}
      if(event==='request'&&req.url.startsWith('/api/internal/mcp-remote/')){
        let raw='';req.on('data',part=>raw+=part);req.on('end',()=>{const frame=JSON.parse(raw);res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:frame.id,result:frame.method==='initialize'?{capabilities:{tools:{}}}:{tools:${JSON.stringify(names.map(name => ({ name, inputSchema: { type: "object" } })))}}}));});return true;
      }
      return emit.call(this,event,...args);
    };
    const {createAcpDriver}=await import(${JSON.stringify(serverModule("drivers/acp/core.ts"))});
    const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(serverModule("drivers/builtIn.ts"))});
    const {SPAWNED_PROXIES}=await import(${JSON.stringify(serverModule("proxy-paths.ts"))});
    const {ToolLimitStore}=await import(${JSON.stringify(serverModule("drivers/acp/opencode-tool-budget.ts"))});
    const {applyOpenCodeTurnPermission,applyToolCatalogDenies}=await import(${JSON.stringify(serverModule("drivers/acp/opencode-go.ts"))});
    const {NATIVE_DIR}=await import(${JSON.stringify(serverModule("config.ts"))});
    await new ToolLimitStore(path.join(NATIVE_DIR,'opencode-tool-limits.json')).learn('a'.repeat(64),100,'mock');
    const driver=createAcpDriver({driverKind:'opencodeGo',displayName:'Offline OpenCode',models:{default:'mock',options:[]},defaultCli:process.execPath,nativeSource:'c11.chain',loginNote:'unused',spawnArgs:()=>[${JSON.stringify(engine)}],pickAuthMethod:()=>null,authFailure:'continue',isAuthenticated:()=>true,mcpListedWait:true,toolBudget:{routeKey:()=> 'a'.repeat(64)},finishTurnEnv:()=>{delete process.env.MURAGE_CLOUD_ROLE;},transformEnv:env=>{
      // The fake engine runs locally; the real driver still builds Cloud descriptors.
      delete env.MURAGE_CLOUD_TURN_ENGINE;
      Object.assign(env,{HOME:process.env.MURAGE_DATA_DIR,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:${JSON.stringify(`--import ${preload}`)},C11_LOG:${JSON.stringify(log)},${recover ? `C11_RELIST:${JSON.stringify(relist)},` : ""}C11_RELEASE_SESSION:${JSON.stringify(sessionRelease)},C11_RELEASE_LOAD:${JSON.stringify(loadRelease)},C11_FINISH:${JSON.stringify(finish)},OPENCODE_CONFIG_CONTENT:'{}'});
      applyOpenCodeTurnPermission(env);applyToolCatalogDenies(env,[['computer_*','deny']]);
    }});
    const create=driver.create;driver.create=async function(input){
      const instance=await create.call(this,input),send=instance.adapter.sendTurn.bind(instance.adapter);
      instance.adapter.onEvent(event=>fs.appendFileSync(${JSON.stringify(join(root, 'events.jsonl'))},JSON.stringify(event)+'\\n'));
      instance.adapter.sendTurn=async turn=>{
        const own=turn.integrations.agents.env;
        const env={MURAGE_HARNESS_URL:own.MURAGE_HARNESS_URL,MURAGE_MCP_TOKEN:own.MURAGE_COMMS_TOKEN};
        const relay={MURAGE_CONTROL_URL:own.MURAGE_HARNESS_URL,MURAGE_CONTROL_TOKEN:own.MURAGE_COMMS_TOKEN};
        const previous=process.env.MURAGE_CLOUD_ROLE;process.env.MURAGE_CLOUD_ROLE='home';
        try{return await send({...turn,cwd:process.env.MURAGE_DATA_DIR,integrations:{agents:{command:process.execPath,args:[SPAWNED_PROXIES.remoteMcp,'--server','fixture'],env},localComputer:{command:process.execPath,args:[SPAWNED_PROXIES.vpsRelayMcp],env:relay}}});}
        catch(error){fs.writeFileSync(${JSON.stringify(join(root, 'error.txt'))},String(error.stack));throw error;}finally{if(previous===undefined)delete process.env.MURAGE_CLOUD_ROLE;else process.env.MURAGE_CLOUD_ROLE=previous;}
      };return instance;
    };
    BUILT_IN_DRIVERS.splice(BUILT_IN_DRIVERS.findIndex(d=>d.driverKind==='opencodeGo'),1,driver);
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.chain={driver:'opencodeGo',displayName:'Offline chain',config:{cli:process.execPath}};fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  console.info("T34 isolated fixture", fixture.info);
  const rows = (): any[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  try {
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    const api = async (method: string, path: string, body: unknown) => {
      const res = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret }, body: JSON.stringify(body) });
      expect(res.ok).toBe(true); return res.json() as Promise<any>;
    };
    const { bot } = await api("POST", "/api/bots", { name: "T34 chain", modelSelection: { instanceId: "chain", model: "mock" } });
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Exercise the offline chain" });
    await expect.poll(() => rows().find(row => row.msg?.method === "session/new"), { timeout: 15000 }).toBeDefined();
    const request = rows().find(row => row.msg?.method === "session/new").msg;
    const descriptors = request.params.mcpServers;
    expect(descriptors.map((d: any) => d.name)).toEqual(["agents", "computer"]);
    await expect.poll(() => rows().filter(row => row.event === "launch").map(row => row.descriptor)).toEqual(descriptors);
    const publications = descriptors.map((descriptor: any) => {
      const env = Object.fromEntries(descriptor.env.map((e: any) => [e.name, e.value]));
      expect(env.MURAGE_MCP_LISTED_URL).toMatch(new RegExp(`^${fixture.info.url}/api/internal/mcp-catalog/`));
      expect(env.MURAGE_MCP_LISTED_FILE).toContain(fixture.info.dataDir);
      return { descriptor, env, marker: env.MURAGE_MCP_LISTED_FILE as string, endpoint: env.MURAGE_MCP_LISTED_URL as string };
    });
    expect(new Set(publications.map((p: any) => p.endpoint)).size).toBe(2);
    for (const { descriptor, env, marker, endpoint } of (recover ? [] : publications)) {
      await expect.poll(() => existsSync(join(root, basename(marker) + ".held")), { timeout: 15000 }).toBe(true);
      await expect.poll(() => readMcpCatalog(marker)?.complete).toBe(false);
      const dirty = readMcpCatalog(marker)!;
      // Capture at the write attempt, so a late dirty publication while held cannot pass.
      const atWrite = JSON.parse(readFileSync(join(root, basename(marker) + ".held"), "utf8")).catalog;
      expect(atWrite).toEqual(dirty);
      expect(atWrite.complete).toBe(false);
      expect(rows().filter(row => row.event === "forward" && row.name === descriptor.name && row.frame.id === 2)).toHaveLength(0);
      const post = (token: string, doc: unknown) => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(doc) });
      expect((await post("wrong-token", { ...dirty, revision: dirty.revision + 1 })).status).toBe(401);
      expect(readMcpCatalog(marker)).toEqual(dirty);
      const token = env.MURAGE_MCP_TOKEN ?? env.MURAGE_CONTROL_TOKEN;
      expect((await post(token, { ...dirty, processGeneration: "wrong-namespace", revision: dirty.revision + 1 })).status).toBe(403);
      expect(readMcpCatalog(marker)).toEqual(dirty);
      expect(rows().filter(row => row.msg?.method === "session/prompt")).toHaveLength(0);
      writeFileSync(join(root, basename(marker) + ".release"), "");
      await expect.poll(() => readMcpCatalog(marker)?.complete).toBe(true);
      await expect.poll(() => rows().filter(row => row.event === "forward" && row.name === descriptor.name && row.frame.id === 2).length).toBe(1);
      const forwarded = rows().find(row => row.event === "forward" && row.name === descriptor.name && row.frame.id === 2).frame;
      expect(readMcpCatalog(marker)?.tools).toEqual(forwarded.result.tools.map((tool: any) => tool.name));
      expect(readMcpCatalog(marker)?.processGeneration).toBe(dirty.processGeneration);
      expect(readMcpCatalog(marker)!.revision).toBeGreaterThan(dirty.revision);
      if (descriptor.name === "computer") expect(forwarded.result.tools[0].inputSchema).toEqual({ type: "object", properties: { x: { type: "string" } } });
    }
    if (recover) {
      // The legitimate publication of exactly one mount was refused: its first list got the error frame, and its catalog is not complete.
      await expect.poll(() => existsSync(join(root, "refused.txt")), { timeout: 15000 }).toBe(true);
      const refusedKey = readFileSync(join(root, "refused.txt"), "utf8").split("/").at(-1)!;
      const failed = publications.find((p: any) => p.endpoint.endsWith(refusedKey))!;
      expect(failed).toBeDefined();
      for (const { marker } of publications) writeFileSync(join(root, basename(marker) + ".release"), "");
      await expect.poll(() => rows().filter(row => row.event === "forward" && row.name === failed.descriptor.name && row.frame.id === 2).length, { timeout: 15000 }).toBe(1);
      expect(rows().find(row => row.event === "forward" && row.name === failed.descriptor.name && row.frame.id === 2).frame).toMatchObject({ error: { code: -32000 } });
      expect(readMcpCatalog(failed.marker)?.complete).not.toBe(true);
      // A later list on every mount recovers it: the refused mount's catalog certifies from its own forwarded tools.
      writeFileSync(relist, "");
      for (const { descriptor, marker } of publications) {
        await expect.poll(() => rows().filter(row => row.event === "forward" && row.name === descriptor.name && row.frame.id === 3 && row.frame.result).length, { timeout: 15000 }).toBe(1);
        const later = rows().find(row => row.event === "forward" && row.name === descriptor.name && row.frame.id === 3).frame;
        await expect.poll(() => readMcpCatalog(marker)?.complete, { timeout: 15000 }).toBe(true);
        expect(readMcpCatalog(marker)?.tools).toEqual(later.result.tools.map((tool: any) => tool.name));
      }
    }
    writeFileSync(sessionRelease, "");
    // A known budget must now read the published required controls before prompting.
    await expect.poll(() => rows().filter(row => row.msg?.method === "session/prompt").length, { timeout: 15000 }).toBe(1);
    const native = readFileSync(join(fixture.info.dataDir, "native", `${bot.threadId}.ndjson`), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const budget = native.find(row => row.msg?.type === "opencode_tool_budget" && row.msg.stage === "pre-prompt")?.msg;
    const agentPublication = publications.find((p: any) => p.descriptor.name === "agents")!;
    const computerPublication = publications.find((p: any) => p.descriptor.name === "computer")!;
    expect(budget).toMatchObject({ outcome: "applied", limit: 100, unknownDropped: 0,
      kept: readMcpCatalog(agentPublication.marker)!.tools!.length,
      hidden: readMcpCatalog(computerPublication.marker)!.tools!.length,
      processGeneration: readMcpCatalog(agentPublication.marker)!.processGeneration });
    if (!recover) expect(rows().filter(row => row.msg?.method === "session/load")).toHaveLength(0);
    for (const { descriptor } of publications) expect(rows().filter(row => row.event === "forward" && row.name === descriptor.name && row.frame.id === 2)).toHaveLength(1);
    const chainProof = { fixture: fixture.info, sessionMethod: request.method,
      catalogs: publications.map((p: any) => ({ name: p.descriptor.name, destination: p.endpoint, marker: p.marker, catalog: readMcpCatalog(p.marker) })), budget };
    writeFileSync(join(root, "proof.json"), JSON.stringify(chainProof, null, 2));
    if (recover) {
      // The resumed turn: this bot holds a computer, so its engine is never pooled and the second turn opens by session/load.
      writeFileSync(finish, "");
      await expect.poll(() => existsSync(join(root, "events.jsonl")) && readFileSync(join(root, "events.jsonl"), "utf8").includes('"turn.completed"'), { timeout: 15000 }).toBe(true);
      const launchesBefore = rows().filter(row => row.event === "launch").length;
      await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Resume the offline chain" });
      await expect.poll(() => rows().find(row => row.msg?.method === "session/load"), { timeout: 15000 }).toBeDefined();
      const load = rows().find(row => row.msg?.method === "session/load").msg;
      expect(load.params.sessionId).toBe("offline-session");
      expect(load.params.mcpServers.map((d: any) => d.name)).toEqual(["agents", "computer"]);
      await expect.poll(() => rows().filter(row => row.event === "launch").length, { timeout: 15000 }).toBe(launchesBefore + 2);
      const loaded = rows().filter(row => row.event === "launch").slice(launchesBefore);
      expect(loaded.map((row: any) => row.descriptor)).toEqual(load.params.mcpServers);
      const resumed = loaded.map((row: any) => {
        const env = Object.fromEntries(row.descriptor.env.map((e: any) => [e.name, e.value]));
        return { name: row.descriptor.name as string, marker: env.MURAGE_MCP_LISTED_FILE as string };
      });
      for (const { marker } of resumed) writeFileSync(join(root, basename(marker) + ".release"), "");
      for (const { name, marker } of resumed) {
        await expect.poll(() => readMcpCatalog(marker)?.complete, { timeout: 15000 }).toBe(true);
        const forwardedLater = rows().filter(row => row.event === "forward" && row.name === name && row.frame.result?.tools).map(row => row.frame.result.tools.map((tool: any) => tool.name));
        expect(forwardedLater.some(names => JSON.stringify(names) === JSON.stringify(readMcpCatalog(marker)?.tools))).toBe(true);
      }
      // The resumed engine answers session/load only after its mounts have listed (as the first turn's does), so the budget reads
      // complete catalogs before the second prompt: no restart, one prompt on the loaded session, budget verified from the resumed mounts.
      writeFileSync(loadRelease, "");
      await expect.poll(() => rows().filter(row => row.msg?.method === "session/prompt").length, { timeout: 15000 }).toBe(2);
      expect(rows().filter(row => row.event === "launch").length).toBe(launchesBefore + 2);
      expect(rows().filter(row => row.msg?.method === "session/load")).toHaveLength(1);
      const budgets = readFileSync(join(fixture.info.dataDir, "native", `${bot.threadId}.ndjson`), "utf8").trim().split("\n").map(line => JSON.parse(line))
        .filter(row => row.msg?.type === "opencode_tool_budget" && row.msg.stage === "pre-prompt").map(row => row.msg);
      const resumedAgents = resumed.find((m: any) => m.name === "agents")!, resumedComputer = resumed.find((m: any) => m.name === "computer")!;
      expect(budgets.at(-1)).toMatchObject({ outcome: "applied", unknownDropped: 0,
        kept: readMcpCatalog(resumedAgents.marker)!.tools!.length, hidden: readMcpCatalog(resumedComputer.marker)!.tools!.length,
        processGeneration: readMcpCatalog(resumedAgents.marker)!.processGeneration });
    }
    await api("POST", `/api/bots/${bot.id}/interrupt`, {});
  } finally {
    writeFileSync(sessionRelease, ""); writeFileSync(finish, "");
    await fixture.close();
  }
};
it("T34 fresh ACP session carries Cloud catalogs through authenticated proxy flush to the owning budget", () => chainTest(false), 60000);
it("C-1 a refused publication from the real proxy: a later list recovers the catalog, and the resumed turn loads the session with fresh descriptors whose catalogs certify", () => chainTest(true), 120000);

