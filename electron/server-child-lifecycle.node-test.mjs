import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireDataDirLease } from "./data-dir-lease.mjs";
import { createServerChildLifecycle, GRACEFUL_CLOSE_MESSAGE } from "./server-child-lifecycle.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

test("synchronous exit is observed before kill returns; repeated stop is harmless",async()=>{
  const child=new EventEmitter();let kills=0;
  child.kill=()=>{kills++;child.emit("exit",0);};
  const lifecycle=createServerChildLifecycle(child,{timeoutMs:20});
  await lifecycle.stop();await lifecycle.stop();
  assert.equal(kills,1);assert.equal(lifecycle.exited,true);
});

test("error/kill failure without exit refuses cleanup and allows a later retry",async()=>{
  const child=new EventEmitter();child.kill=()=>{throw new Error("sensitive provider detail");};
  const lifecycle=createServerChildLifecycle(child,{timeoutMs:15});
  child.emit("error",new Error("private value"));
  assert.equal(lifecycle.failed,true);
  await assert.rejects(lifecycle.stop(),error=>/has not exited/.test(error.message)&&!error.message.includes("private"));
  assert.equal(lifecycle.exited,false);
  child.emit("exit",1);
  await lifecycle.stop();
});

// G12: on Windows kill() is TerminateProcess, so the harness only writes
// "Stopped: Murage closed while this was running" when it is asked first.
test("graceful stop asks the harness to close and never kills a child that exits in time",async()=>{
  const child=new EventEmitter();const events=[];
  child.postMessage=message=>{events.push(["message",message]);setTimeout(()=>child.emit("exit",0),5);};
  child.kill=()=>{events.push(["kill"]);};
  const lifecycle=createServerChildLifecycle(child,{timeoutMs:200,gracefulClose:true,graceMs:1000});
  await lifecycle.stop();
  assert.deepEqual(events,[["message",GRACEFUL_CLOSE_MESSAGE]]);
  assert.equal(GRACEFUL_CLOSE_MESSAGE.type,"murage:close");
  assert.equal(lifecycle.exited,true);
});

test("graceful stop kills a harness that does not close within the grace period",async()=>{
  const child=new EventEmitter();const events=[];
  child.postMessage=()=>{events.push("message");};
  child.kill=()=>{events.push("kill");child.emit("exit",null);};
  const lifecycle=createServerChildLifecycle(child,{timeoutMs:200,gracefulClose:true,graceMs:20});
  const started=Date.now();
  await lifecycle.stop();
  assert.deepEqual(events,["message","kill"]);
  assert.ok(Date.now()-started>=15);
});

test("a harness that cannot be asked is killed at once; an explicit hard stop skips the ask",async()=>{
  const closed=new EventEmitter();const events=[];
  closed.postMessage=()=>{throw new Error("port closed");};
  closed.kill=()=>{events.push("kill");closed.emit("exit",1);};
  await createServerChildLifecycle(closed,{timeoutMs:200,gracefulClose:true,graceMs:60_000}).stop();
  assert.deepEqual(events,["kill"]);
  const booting=new EventEmitter();const booted=[];
  booting.postMessage=()=>{booted.push("message");};
  booting.kill=()=>{booted.push("kill");booting.emit("exit",1);};
  await createServerChildLifecycle(booting,{timeoutMs:200,gracefulClose:true,graceMs:60_000}).stop({graceful:false});
  assert.deepEqual(booted,["kill"]);
});

test("without gracefulClose nothing is posted: recovery workers are stopped as before",async()=>{
  const child=new EventEmitter();const events=[];
  child.postMessage=()=>{events.push("message");};
  child.kill=()=>{events.push("kill");child.emit("exit",0);};
  await createServerChildLifecycle(child,{timeoutMs:200}).stop();
  assert.deepEqual(events,["kill"]);
});

test("real delegated writer holds primary lease until exact child exits",{timeout:10000},async(t)=>{
  const root=mkdtempSync(join(tmpdir(),"murage-owned-child-"));
  const data=join(root,"installation");
  const lease=acquireDataDirLease(data);
  const children=[];
  t.after(async()=>{
    for(const child of children) {
      if(child.exitCode===null&&child.signalCode===null) {
        const done=new Promise(resolve=>child.once("exit",resolve));
        child.kill("SIGKILL");await done;
      }
    }
    try{lease.release();}catch{}
    safeWipeSync(root);
  });
  const module=new URL("./data-dir-lease.mjs",import.meta.url).href;
  const child=spawn(process.execPath,["--input-type=module","-e",`
    import {acquireDataDirLeaseForProcess} from ${JSON.stringify(module)};
    const lease=acquireDataDirLeaseForProcess(process.env.OWNED_TEST_ROOT);
    process.on('message',message=>{
      if(message==='stop') {process.send({event:'stopping'});return;}
      if(message==='finish') {lease.release();process.exit(0);}
    });
    process.send({event:'ready',consumed:process.env.MURAGE_INTERNAL_DATA_DIR_LEASE===undefined});
  `],{env:{...process.env,OWNED_TEST_ROOT:data,...lease.utilityServerLeaseEnvironment()},stdio:["ignore","ignore","ignore","ipc"]});
  children.push(child);
  // Windows terminates on SIGTERM without running a JS signal handler.
  // Use a cooperative fixture stop to exercise the interval before actual
  // exit on every platform; explicit cleanup signals still kill the process.
  const kill=child.kill.bind(child);
  child.kill=signal=>signal?kill(signal):child.send("stop");
  const lifecycle=createServerChildLifecycle(child,{timeoutMs:1500});
  const ready=await new Promise((resolve,reject)=>{child.once("message",resolve);child.once("error",reject);});
  assert.equal(ready.consumed,true);
  const stopping=new Promise(resolve=>child.once("message",resolve));
  let returned=false;
  const stopped=lifecycle.stop().then(()=>{returned=true;});
  await stopping;
  assert.equal(returned,false);
  assert.throws(()=>lease.release(),error=>error.code==="LEASE_CHILD_BUSY");
  child.send("finish");
  await stopped;
  assert.equal(lifecycle.exited,true);
  assert.equal(lease.release(),true);
  const successor=acquireDataDirLease(data);
  assert.equal(successor.release(),true);
});

// A graceful stop may take the grace period and then the kill wait, so the
// quit path's own deadline for the owned harness must cover both; a shorter
// one always reported "has not exited" for a harness that was still closing.
test("the quit path waits for the owned harness as long as a graceful stop can take", async()=>{
  const { readFileSync } = await import("node:fs");
  const { SERVER_CHILD_STOP_TIMEOUT_MS, GRACEFUL_CLOSE_TIMEOUT_MS, OWNED_WORK_TIMEOUT_MS } = await import("./server-child-lifecycle.mjs");
  assert.ok(SERVER_CHILD_STOP_TIMEOUT_MS >= GRACEFUL_CLOSE_TIMEOUT_MS + OWNED_WORK_TIMEOUT_MS);
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /child\.stop\(\)\)\), "The owned harness has not exited", SERVER_CHILD_STOP_TIMEOUT_MS\)/);
});

test("stopRequested is false for an outside kill and true once the app asked to stop",async()=>{
  const outside=new EventEmitter();outside.kill=()=>{};
  const a=createServerChildLifecycle(outside,{timeoutMs:20});
  outside.emit("exit",0);
  assert.equal(a.exited,true);assert.equal(a.stopRequested,false);
  const asked=new EventEmitter();asked.kill=()=>{asked.emit("exit",0);};
  const b=createServerChildLifecycle(asked,{timeoutMs:20});
  assert.equal(b.stopRequested,false);
  await b.stop();
  assert.equal(b.stopRequested,true);
});
