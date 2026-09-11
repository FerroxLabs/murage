import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireDataDirLease } from "./data-dir-lease.mjs";
import { createServerChildLifecycle } from "./server-child-lifecycle.mjs";
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
