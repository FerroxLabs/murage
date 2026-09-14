import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createServerChildLifecycle } from "./server-child-lifecycle.mjs";
import { runInstallationRecoveryWorker } from "./installation-recovery-runner.mjs";
const valid = { ok: true, operation: "backup", path: "/selected/日本語.zip", sha256: "a".repeat(64), snapshotId: "12345678-1234-1234-1234-123456789abc" };
function fixture(timeoutMs = 500, options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  const result = runInstallationRecoveryWorker({ fork: () => child, entry: "owned-worker", args: ["backup"], env: {}, track: createServerChildLifecycle, timeoutMs, ...options });
  return { child, result, finish(value, code = 0) { child.stdout.end(typeof value === "string" ? value : JSON.stringify(value)); child.emit("exit", code); } };
}
test("worker collection waits for output and preserves split Unicode", async () => {
  const f = fixture();
  const bytes = Buffer.from(JSON.stringify(valid));
  for (const byte of bytes) f.child.stdout.write(Buffer.from([byte]));
  f.child.emit("exit", 0);
  let done = false; void f.result.then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  f.child.stdout.end();
  assert.equal((await f.result).path, valid.path);
});
test("wrong operation, incomplete success, malformed output and nonzero exit cannot report success", async () => {
  for (const [value, status] of [[{ ...valid, operation: "inspect", activationAvailable: false }, 0], [{ ok: true, operation: "backup" }, 0], ["not-json", 0], [valid, 1]]) {
    const f = fixture(); f.finish(value, status);
    await assert.rejects(f.result);
  }
});
test("timeout requests stop but remains behind actual child exit", async () => {
  const f = fixture(10); let killed = false, settled = false;
  f.child.kill = () => { killed = true; };
  const observed = f.result.catch(error => { settled = true; return error; });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(killed, true); assert.equal(settled, false);
  f.finish(valid);
  assert.equal((await observed).code, "RECOVERY_WORKER_TIMEOUT");
});
test("private utility result is acknowledged but success still waits for exact exit without stdout end", async () => {
  const f = fixture(); let ack, settled = false;
  f.child.postMessage = message => { ack = message; };
  f.child.emit("message", { type: "murage:recovery-result", nonce: "12345678-1234-1234-1234-123456789abc", result: valid });
  void f.result.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(ack, { type: "murage:recovery-result-ack", nonce: "12345678-1234-1234-1234-123456789abc" });
  f.child.emit("exit", 0);
  assert.equal((await f.result).path, valid.path);
  f.child.stdout.destroy(); f.child.stderr.destroy();
});
test("encrypted worker receives one bounded private input only after its ready nonce",async()=>{
  let reads=0;const sent=[];
  const f=fixture(500,{args:["inspect-encrypted"],readIdentity:async()=>{reads++;return "PRIVATE-INPUT-CANARY";}});f.child.postMessage=value=>sent.push(value);
  const nonce="12345678-1234-1234-1234-123456789abc";
  assert.equal(reads,0);f.child.emit("message",{type:"murage:recovery-input-ready",nonce});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,1);assert.ok(sent[0].identity==="PRIVATE-INPUT-CANARY");assert.equal(sent[0].nonce,nonce);
  f.finish({...valid,operation:"inspect-encrypted",activationAvailable:false,coverage:{scope:"application-data",fullInstallation:false,includedCount:1,excludedCount:1}});
  assert.equal((await f.result).operation,"inspect-encrypted");
});
test("duplicate or malformed input requests cannot read a second identity",async()=>{
  for(const duplicate of [false,true]){
    let reads=0;const f=fixture(500,{args:["inspect-encrypted"],readIdentity:async()=>{reads++;return "private";}});f.child.postMessage=()=>{};
    const nonce="12345678-1234-1234-1234-123456789abc";
    if(duplicate){f.child.emit("message",{type:"murage:recovery-input-ready",nonce});await new Promise(resolve=>setImmediate(resolve));}
    f.child.emit("message",{type:"murage:recovery-input-ready",nonce:duplicate?nonce:"bad"});
    f.finish(valid);await assert.rejects(f.result,/INVALID_RECOVERY_RESULT/);assert.equal(reads,duplicate?1:0);
  }
});
test("Windows worker errors retain bounded private paths without changing POSIX retention rules",async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(process,"platform");
  try{
    Object.defineProperty(process,"platform",{...descriptor,value:"win32"});
    for(const code of ["AGE_PROCESS_FAILED","SNAPSHOT_CANCELLED","AGE_PROCESS_CLOSE_UNCONFIRMED"]){
      const f=fixture(500,{args:["inspect-encrypted"]});f.finish({ok:false,error:code,retainedDirectory:"C:\\fixture\\private-stage"},1);
      await assert.rejects(f.result,error=>error.code===code&&error.retainedDirectory==="C:\\fixture\\private-stage");
    }
    const invalid=fixture();invalid.finish({ok:false,error:"AGE_PROCESS_FAILED",retainedDirectory:"x".repeat(8193)},1);
    await assert.rejects(invalid.result,error=>error.code==="AGE_PROCESS_FAILED"&&error.retainedDirectory===undefined);
    Object.defineProperty(process,"platform",{...descriptor,value:"darwin"});
    const posix=fixture();posix.finish({ok:false,error:"AGE_PROCESS_FAILED",retainedDirectory:"/private/fixture"},1);
    await assert.rejects(posix.result,error=>error.retainedDirectory===undefined);
  }finally{Object.defineProperty(process,"platform",descriptor);}
});
