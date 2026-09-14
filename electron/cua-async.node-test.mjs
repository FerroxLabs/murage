import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Protocol: fake execFile owns a handle until close(error, stdout) is called;
// kill only records a signal and never implies exit. SDK start/stop settlement
// is explicitly released by each test. No real executable/native SDK is loaded.
let fixture;
globalThis.__cuaFixture = () => fixture;
const sources = {
  electron: `export const app={isPackaged:false,getPath:()=>globalThis.__cuaFixture().home}; export const ipcMain={handle:(name,fn)=>globalThis.__cuaFixture().handlers.set(name,fn)};`,
  "node:child_process": `export const execFile=(...args)=>globalThis.__cuaFixture().exec(...args);`,
  "node:fs": `export default {existsSync:()=>true};`,
  "node:net": `export default {createConnection:()=>globalThis.__cuaFixture().socket()};`,
  "@trycua/cua-driver/embedded": `export class EmbeddedCuaDriverHost { constructor(...args){return globalThis.__cuaFixture().host(...args);} }`,
  "@trycua/cua-driver/electron": `export const requestMacOSPermissions=()=>{globalThis.__cuaFixture().permissionRequests++;return {};}; export const hasRequiredMacOSPermissions=()=>globalThis.__cuaFixture().permissions;`,
};
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes("/cua.mjs") && specifier in sources) {
      return { url: `cua-fixture:${specifier}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("cua-fixture:")) return { format: "module", source: sources[url.slice(12)], shortCircuit: true };
    return next(url, context);
  },
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let i=0;i<50 && !predicate();i++) await tick();
  assert.ok(predicate(), "fixture reached expected protocol boundary");
}
let sequence = 0;
async function setup(t) {
  fixture = {
    home: mkdtempSync(path.join(tmpdir(), "murage-cua-async-")), handlers: new Map(),
    children: [], hosts: [], sockets: [], permissions: false, permissionRequests: 0,
    socketReady: false, holdSocket: false,
    exec(command,args,options,callback) {
      const child={ command,args,options, stdout:new EventEmitter(), stderr:new EventEmitter(), signals:[],
        kill(signal){this.signals.push(signal);return true;},
        close(error=null,stdout=""){callback(error,stdout,"");} };
      this.children.push(child); return child;
    },
    socket() {
      const socket=Object.assign(new EventEmitter(),{destroyed:false,destroy(){this.destroyed=true;}});
      this.sockets.push(socket);
      if (!this.holdSocket) queueMicrotask(()=>socket.emit(this.socketReady?"connect":"error"));
      return socket;
    },
    host(binary,bundleId) {
      const start=deferred(),stop=deferred();
      const host={binary,bundleId,startGate:start,stopGate:stop,stops:0,destroys:0,
        start({signal}){this.signal=signal;return start.promise;},
        stop(){this.stops++;return stop.promise;},uniffiDestroy(){this.destroys++;}};
      this.hosts.push(host);return host;
    },
  };
  const prior=process.env.MURAGE_CUA_EMBEDDED;
  process.env.MURAGE_CUA_EMBEDDED="1";
  t.after(()=>{ if(prior===undefined)delete process.env.MURAGE_CUA_EMBEDDED;else process.env.MURAGE_CUA_EMBEDDED=prior;rmSync(fixture.home,{recursive:true,force:true}); });
  return import(`./cua.mjs?fixture=${++sequence}`);
}

test("async launch/status preserve outputs and exact command bounds", async(t)=>{
  const cua=await setup(t); const started=cua.startCua();
  await until(()=>fixture.children.length===1);
  let responsive=false; await tick(); responsive=true; assert.ok(responsive);
  const launch=fixture.children[0];
  assert.equal(launch.command,"/usr/bin/open"); assert.deepEqual(launch.args,["-a","CuaDriver"]);
  assert.deepEqual(launch.options,{timeout:8000,maxBuffer:8192,killSignal:"SIGKILL"});
  fixture.socketReady=true; launch.close(new Error("launcher exit may precede socket readiness"));
  assert.equal((await started).mode,"standalone");
  const status=cua.cuaPermissionsStatus();await until(()=>fixture.children.length===2);
  const child=fixture.children[1];assert.deepEqual(child.args,["permissions","status","--json"]);
  assert.equal(child.options.timeout,5000);assert.equal(child.options.maxBuffer,65536);
  assert.equal(child.options.killSignal,"SIGKILL");assert.equal(child.options.env.CUA_DRIVER_RS_TELEMETRY_ENABLED,"0");
  child.close(null,'{"accessibility":true}');assert.deepEqual(await status,{available:true,accessibility:true});
  const raw=cua.cuaPermissionsStatus();await until(()=>fixture.children.length===3);
  fixture.children[2].close(new Error("overflow")," partial ");assert.deepEqual(await raw,{available:true,raw:"partial"});
  await cua.stopCua();
});

test("stop cancels exact pending launcher and waits for close",async(t)=>{
  const cua=await setup(t);const result=cua.startCua().catch(e=>e);
  await until(()=>fixture.children.length===1);let stopped=false;
  const stop=cua.stopCua().then(()=>{stopped=true;});await tick();
  assert.deepEqual(fixture.children[0].signals,["SIGKILL"]);assert.equal(stopped,false);
  fixture.children[0].close(new Error("killed"));await stop;
  assert.equal((await result).name,"AbortError");assert.equal(fixture.children.length,1);
});

test("existing standalone socket avoids launcher",async(t)=>{
  const cua=await setup(t);fixture.socketReady=true;
  assert.equal((await cua.startCua()).mode,"standalone");assert.equal(fixture.children.length,0);
  await cua.stopCua();
});

test("stop drains status helper; canceled socket is destroyed",async(t)=>{
  const cua=await setup(t);const status=cua.cuaPermissionsStatus();await until(()=>fixture.children.length===1);
  let done=false;const stop=cua.stopCua().then(()=>{done=true;});await tick();assert.equal(done,false);
  assert.deepEqual(fixture.children[0].signals,["SIGKILL"]);fixture.children[0].close(new Error("timeout"));await status;await stop;
  fixture.holdSocket=true;const starting=cua.startCua().catch(e=>e);await until(()=>fixture.sockets.length===1);
  await cua.stopCua();assert.equal((await starting).name,"AbortError");assert.equal(fixture.sockets[0].destroyed,true);
});

test("SDK late startup and cleanup bar replacement; concurrent starts share host",async(t)=>{
  const cua=await setup(t);fixture.permissions=true;
  const first=cua.startCua().catch(e=>e);const duplicate=cua.startCua().catch(e=>e);
  await until(()=>fixture.hosts.length===1);const host=fixture.hosts[0];
  assert.equal(host.bundleId,"com.murage.app");assert.equal(fixture.permissionRequests,1);
  const stopped=cua.stopCua();const replacement=cua.startCua();await tick();assert.equal(host.signal.aborted,true);
  host.startGate.resolve({socketPath:"/fixture/old"});await until(()=>host.stops===1);
  assert.equal(fixture.hosts.length,1);host.stopGate.resolve();await stopped;
  assert.equal((await first).name,"AbortError");assert.equal((await duplicate).name,"AbortError");
  await until(()=>fixture.hosts.length===2);const fresh=fixture.hosts[1];fresh.startGate.resolve({socketPath:"/fixture/new"});
  assert.equal((await replacement).socketPath,"/fixture/new");assert.equal(host.destroys,1);
  fresh.stopGate.resolve();await cua.stopCua();assert.equal(fresh.stops,1);
});

test("cleanup failure blocks fallback and replacement",async(t)=>{
  const cua=await setup(t);fixture.permissions=true;const first=cua.startCua();const failed=assert.rejects(first,/cleanup failed/);
  await until(()=>fixture.hosts.length===1);const host=fixture.hosts[0];host.startGate.reject(new Error("start failed"));
  await until(()=>host.stops===1);host.stopGate.reject(new Error("cleanup failed"));await failed;
  await assert.rejects(cua.startCua(),/cleanup failed/);await assert.rejects(cua.stopCua(),/cleanup failed/);
  assert.equal(fixture.children.length,0);assert.equal(fixture.hosts.length,1);assert.equal(host.destroys,0);
});

test("retries share cleanup and explicit stop prevents replacement",async(t)=>{
  const cua=await setup(t);fixture.permissions=true;const first=cua.startCua();await until(()=>fixture.hosts.length===1);
  const host=fixture.hosts[0];host.startGate.resolve({socketPath:"/fixture/initial"});await first;
  cua.registerCuaIpc();const retry=fixture.handlers.get("cua:linux-retry");
  const a=retry(),b=retry();await until(()=>host.stops===1);
  const stop=cua.stopCua();host.stopGate.resolve();await stop;
  const results=await Promise.all([a,b]);assert.deepEqual(results[0],results[1]);
  assert.equal(results[0].status,"error");assert.match(results[0].message,/cancelled/);
  assert.equal(fixture.hosts.length,1);assert.equal(host.destroys,1);
});
