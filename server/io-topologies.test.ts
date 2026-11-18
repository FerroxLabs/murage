// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it,beforeAll,afterAll} from "vitest";
import {spawn,execFileSync} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {makeInstall,cleanupFixtures} from "./sentinel/scan-fixtures.ts";
import {ownedChildIoBytes} from "./sentinel/io-child-receipts.ts";
let root:string;
beforeAll(()=>{root=mkdtempSync(join(tmpdir(),"io-topologies-"));execFileSync("cc",["-std=c11","-D_GNU_SOURCE","-O2","-Wall","-Werror","-fPIC","-shared","-DNAPI_VERSION=9","-I",resolve(dirname(process.execPath),"../include/node"),"native/engine-exclusion/exclusion.c","native/engine-exclusion/meter.c","-o",join(root,"engine-exclusion.node")]);});
afterAll(()=>{cleanupFixtures();if(root)rmSync(root,{recursive:true,force:true});});
it("T11 desktop detached watcher forwards real scanner receipts to the server budget and seals on stop",async()=>{
 const hostPath="../electron/sentinel-host.mjs";
 const {defaultSpawnWatcher}=await import(/* @vite-ignore */ hostPath);
 const path="./io-desktop-receipts.ts";
 const {desktopIoReceiver}=await import(/* @vite-ignore */ path).catch(()=>({desktopIoReceiver:()=>({accept:()=>{}})}));
 const fixture=makeInstall(),events:any[]=[];let control:any;
 const acks:any[]=[];
 const receiver=desktopIoReceiver((m:any)=>{acks.push(m);control?.accept(m);});
 const launch=defaultSpawnWatcher({executable:process.execPath,platform:"linux",env:{MURAGE_RESOURCES_PATH:root},onIoEvent:(m:any)=>{events.push(m);receiver.accept(m);},onChild:(c:any)=>{control=c;}} as any);
 const before=ownedChildIoBytes();let pid:number|null=null;
 try{
  pid=launch(fixture.descriptorPath,resolve("server/sentinel/cli.ts"));
  expect(pid).toBeGreaterThan(0);
  await expect.poll(()=>ownedChildIoBytes(),{timeout:15_000}).toBeGreaterThan(before+4096);
  expect(events.some(e=>e.type==="sample"&&e.message.ioBytes>4096),"scanner bytes must cross the desktop boundary").toBe(true);
  process.kill(pid!,"SIGTERM");
  await expect.poll(()=>events.some(e=>e.type==="exit"),{timeout:10_000}).toBe(true);pid=null;
  const final=events.findLast(e=>e.type==="sample").message;
  expect(final.final,"watcher must seal after its scanner stops").toBe(true);
  expect(acks.at(-1)?.message).toEqual({type:"io-final-ack",generation:final.generation,sequence:final.sequence});
 }finally{if(pid)try{process.kill(pid,"SIGKILL");}catch{/* gone */}}
});
it("T12 Claude launched owned MCP proxy keeps stdio clean and returns final bytes through a foreign launcher",async()=>{
 const path="./io-proxy-receipts.ts";
 const {meterProxyServers,closeProxyIoForTest,proxyIoSnapshot}=await import(/* @vite-ignore */ path).catch(()=>({meterProxyServers:async(s:any)=>s,closeProxyIoForTest:async()=>{},proxyIoSnapshot:()=>({finals:0,exits:0})}));
 const {registerOwnedChildForTest}=await import("./io-child-meter.ts");registerOwnedChildForTest("testing/io-proxy.fixture");
 // The fake CLI uses exactly the rendered command/args/env with no IPC, like Claude.
 const servers=await meterProxyServers({fixture:{command:process.execPath,args:[resolve("server/testing/io-proxy.fixture.ts"),root],env:{MURAGE_ENGINE_EXCLUSION_PATH:join(root,"engine-exclusion.node")}},foreign:{command:"fixture-engine",args:[]}});
 expect(servers.foreign).toEqual({command:"fixture-engine",args:[]});
 const stanza=servers.fixture;const before=ownedChildIoBytes(),stats=proxyIoSnapshot();
 const child=spawn(stanza.command,stanza.args,{env:{...process.env,...stanza.env},stdio:["pipe","pipe","pipe"]});let stdout="",stderr="";
 child.stdout.on("data",c=>stdout+=c);child.stderr.on("data",c=>stderr+=c);child.stdin.end("fixture request\n");
 try{
  const code=await new Promise(r=>child.once("exit",r));expect(stderr).not.toMatch(/Error:/);expect(code).toBe(0);
  expect(stdout,"receipt frames must never corrupt MCP stdout").toBe("fixture response\n");
  await expect.poll(()=>ownedChildIoBytes()).toBeGreaterThanOrEqual(before+8192);
  expect(proxyIoSnapshot().finals,"the owned proxy must seal and complete its final acknowledgement").toBe(stats.finals+1);
  expect(proxyIoSnapshot().exits).toBe(stats.exits+1);
 }finally{child.kill();await closeProxyIoForTest();}
});
it("T12 the census classifies the owned avatar encoder rather than excluding its writes",async()=>{
 const {CHILD_IO_SITES,CHILD_IO_CALLS}=await import("./io-child-census.ts");
 const {classifyChildIo}=await import("./io-child-meter.ts");
 expect(CHILD_IO_SITES["server/browser-extension-panel-avatar.ts"]).toEqual(["OWNED_NODE"]);
 expect(CHILD_IO_CALLS["server/browser-extension-panel-avatar.ts#fork:1"]).toEqual(["OWNED_NODE"]);
 expect(classifyChildIo(process.execPath,[resolve("server/browser-extension-panel-avatar-encoder.ts")])).toBe("OWNED_NODE");
});
it("T12 an owned launch stays UNKNOWN until its first valid receipt",()=>{
 const code=`import {EventEmitter} from 'node:events';
 const io=await import(${JSON.stringify(new URL('./sentinel/io-child-receipts.ts',import.meta.url).href)});
 const child=Object.assign(new EventEmitter(),{send:()=>{}});
 io.observeChildIo(child,'fixture-generation');const before=io.ownedChildIoKnown();
 child.emit('message',{type:'io',ioProtocol:1,generation:'fixture-generation',sequence:1,fsWriteBlocks:0,ioBytes:0,known:true,final:true});
 const after=io.ownedChildIoKnown();child.emit('exit',0,null);console.log(JSON.stringify({before,after}));`;
 const output=execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],{encoding:"utf8"});
 expect(JSON.parse(output.trim())).toEqual({before:false,after:true});
});
it("T11 desktop coverage cannot qualify a scheduled or disconnected watcher",async()=>{
 const {desktopIoReceiver,desktopIoCovered}=await import("./io-desktop-receipts.ts");
 const {sentinelAttachedIoCovered}=await import("./sentinel-io-coverage.ts");
 const receive=desktopIoReceiver(()=>{});receive.accept({type:"uncovered"});expect(desktopIoCovered()).toBe(false);
 // MAIN RULING 1114-SCPERF-RECEIPT: a disconnected channel is also unknown.
 expect(sentinelAttachedIoCovered()).toBe(false);
 receive.accept({type:"launch",generation:"fixture-desktop"});expect(desktopIoCovered()).toBe(false);
 receive.accept({type:"sample",generation:"fixture-desktop",message:{type:"io",ioProtocol:1,generation:"fixture-desktop",sequence:1,fsWriteBlocks:0,ioBytes:0,known:true,final:true}});
 // MAIN RULING 1114-SCPERF-RECEIPT: the legacy export also requires complete durable coverage.
 expect(desktopIoCovered()).toBe(false);
 expect((await import("./sentinel-io-coverage.ts")).sentinelAttachedIoCovered()).toBe(true);
 receive.accept({type:"exit",generation:"fixture-desktop",code:0,signal:null});expect(desktopIoCovered()).toBe(false);
 // MAIN RULING 1114-SCPERF-RECEIPT: exit retires the diagnostic generation.
 expect(sentinelAttachedIoCovered()).toBe(false);
});

// Consumer assertions run in fresh processes with the launcher's real environment builder.
// P2 owns the topology fixtures and both sides of the Sentinel coverage contract.
import {mkdirSync} from "node:fs";
function coverageProcess(kind:string,envPatch:NodeJS.ProcessEnv={}):unknown {
 const temp=mkdtempSync(join(root,"coverage-")),home=join(temp,"home"),data=join(home,"data"),state=join(temp,"scanner-state");
 mkdirSync(home);mkdirSync(data);
 const env:NodeJS.ProcessEnv={...process.env,HOME:home,USERPROFILE:home,MURAGE_DATA_DIR:data,MURAGE_SENTINEL_STATE_DIR:state,MURAGE_RESOURCES_PATH:root};
 for(const key of Object.keys(env))if(key.startsWith("MURAGE_")&&!['MURAGE_DATA_DIR','MURAGE_SENTINEL_STATE_DIR','MURAGE_RESOURCES_PATH'].includes(key))delete env[key];
 delete env.XDG_STATE_HOME;
 const code=`
 let kind=${JSON.stringify(kind)};
 if(kind==='cloud'){
  const {homeServerEnvironment}=await import('./server/cloud-home/boot.ts');
  const launch=homeServerEnvironment({machineId:'fixture',adminUrl:'https://admin.invalid',publicOrigin:'https://home.invalid',bootstrapSecret:'fixture'.repeat(8)},'UTC');
  Object.assign(process.env,launch,{HOME:process.env.HOME,MURAGE_DATA_DIR:process.env.MURAGE_DATA_DIR,MURAGE_SENTINEL_STATE_DIR:process.env.MURAGE_SENTINEL_STATE_DIR,MURAGE_RESOURCES_PATH:process.env.MURAGE_RESOURCES_PATH});
 }
 if(kind==='installer'){
  const {sentinelWatchSpec}=await import('./installer/lib/sentinel.mjs');
  const spec=sentinelWatchSpec({entry:'/fixture/cli.js',descriptorPath:'/fixture/descriptor.json',env:process.env});
  Object.assign(process.env,spec.env);
 }
 const {coverageFixture}=await import('./server/testing/sentinel-coverage-fixture.mjs');
 console.log(JSON.stringify(await coverageFixture(kind)));`;
 try{return JSON.parse(execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],{env:{...env,...envPatch},encoding:"utf8"}).trim());}
 finally{rmSync(temp,{recursive:true,force:true});}
}
it("T-COV-1 cold Cloud consumer refuses unattached scanner coverage and a known Windows verdict",()=>{
 expect(coverageProcess("cloud")).toEqual({covered:false,osKnown:false});
});
it("T-COV-2 headless installer consumer refuses unattached scanner coverage",()=>{
 expect(coverageProcess("installer")).toBe(false);
});
it("T-COV-3 a descriptor appearing after boot latches UNKNOWN even after deletion",()=>{
 // MAIN RULING 1114-SCPERF-RECEIPT: durable quiescence is required for absence.
 expect(coverageProcess("later")).toEqual([false,false,false]);
 // MAIN RULING 1114-SCPERF-RECEIPT: qualify boot with a real sealed receipt, then invalidate its descriptor.
 expect(coverageProcess("later-sealed")).toEqual([true,false,false,true]);
});
it("T-COV-4 unresolved, non-directory, symlinked and unreadable roots fail closed",()=>{
 const results=["root-unresolved","root-file","root-link","root-data-unresolved"].map(kind=>coverageProcess(kind));
 // The prescribed container runs as an ordinary uid, so mode 000 must be exercised there.
 if(process.platform!=="win32"&&process.getuid?.()!==0)results.push(coverageProcess("root-denied"));
 expect(results).toEqual(results.map(()=>false));
});
it("T-COV-5 no desktop environment value qualifies an unattached scanner",()=>{
 expect([undefined,"","0","1"].map(value=>coverageProcess("spoof",{MURAGE_DESKTOP_PARENT:value}))).toEqual([false,false,false,false]);
});
it("T-COV-6 desktop receipt control qualifies only the live generation and latches LOST",()=>{
 // MAIN RULING 1114-SCPERF-RECEIPT: partial IPC cannot qualify a complete writer set.
 expect(coverageProcess("attach",{MURAGE_DESKTOP_PARENT:"1"})).toEqual([false,false,false,false]);
 expect(coverageProcess("attach-diagnostic")).toEqual([false,true,false,false]);
});
it("T-COV-7 every product Sentinel launch has a descriptor-first census entry",()=>{
 const code=`const {sentinelLauncherAudit}=await import('./server/testing/sentinel-launcher-audit.ts');
 const census=await import('./server/io-sentinel-launchers.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND'&&error.url?.endsWith('/server/io-sentinel-launchers.ts'))return null;throw error;});
 console.log(JSON.stringify(sentinelLauncherAudit(census?.SENTINEL_LAUNCHERS??[])));`;
 const result=JSON.parse(execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],{encoding:"utf8"}).trim());
 expect(result.unmapped,"all launcher sites, including the installer library, must be mapped").toEqual([]);
 expect(result.stale).toEqual([]);expect(result.descriptorErrors).toEqual([]);
 expect(result.families).toEqual(["cloud","installer","scheduler","watcher"]);
});
it("T-COV-8 scheduled Desktop UNKNOWN is asserted at the server consumer",()=>{
 expect(coverageProcess("scheduled",{MURAGE_DESKTOP_PARENT:"1"})).toBe(false);
});
it("Sentinel consumer latches invalid frames until a fresh launch",()=>{
 for(const kind of ["invalid-frame","invalid-generation","invalid-inner-generation","invalid-sequence","invalid-protocol","invalid-unknown"])
  {
   // MAIN RULING 1114-SCPERF-RECEIPT: preserve the positive/negative channel control independently of complete coverage.
   expect(coverageProcess(kind,{MURAGE_DESKTOP_PARENT:"1"}),kind).toEqual([false,false,false,false]);
   expect(coverageProcess(kind+"-diagnostic"),kind).toEqual([false,true,false,false]);
  }
});
it("attached transport diagnostics retain valid generation and invalid-frame controls independently of complete file coverage",()=>{
 expect(coverageProcess("attach-diagnostic")).toEqual([false,true,false,false]);
 for(const kind of ["invalid-frame","invalid-generation","invalid-inner-generation","invalid-sequence","invalid-protocol","invalid-unknown"])
  expect(coverageProcess(kind+"-diagnostic"),kind).toEqual([false,true,false,false]);
});
