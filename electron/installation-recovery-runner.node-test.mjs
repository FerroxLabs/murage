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

// 0.1.60 audit A-01: a refusal about one item in the data folder names it, so
// the page can tell the person which file to look at; nothing outside the
// data folder is ever carried.
test("a refusal carries the item inside the data folder it was about, and only such an item", async () => {
  for (const [path, expected] of [["workspaces/mira/report 10:30.md", "workspaces/mira/report 10:30.md"], ["/Users/sam/.ssh/id_rsa", undefined], ["../outside", undefined], ["C:\\Users\\sam", undefined]]) {
    const f = fixture(); f.finish({ ok: false, error: "UNSAFE_SNAPSHOT_ENTRY", path }, 1);
    const error = await f.result.then(() => null, caught => caught);
    assert.equal(error.code, "UNSAFE_SNAPSHOT_ENTRY");
    assert.equal(error.path, expected, path);
  }
});
test("a backup's list of skipped items crosses bounded; malformed entries are dropped, never a failed result", async () => {
  const skipped = { count: 2, items: [{ path: "workspaces/mira/site/node_modules", reason: "rebuildable" }, { path: "workspaces/mira/a.txt", reason: "unreadable" }], bots: { mira: "Mira" } };
  const f = fixture(); f.finish({ ...valid, skipped });
  assert.deepEqual((await f.result).skipped, skipped);
  const g = fixture(); g.finish({ ...valid, skipped: { ...skipped, items: [{ path: "a", reason: "because" }, { path: "\u0007x", reason: "special" }] } });
  assert.deepEqual((await g.result).skipped.items, [{ path: "?x", reason: "special" }]);
  const h = fixture(); h.finish({ ...valid, skipped: { count: 0, items: [] } });
  assert.equal((await h.result).skipped, undefined);
});

// Kimi audit #1: a bad display name in the skipped list must never turn a
// published backup into a reported failure.
test("a malformed skipped list is reduced, never a failed result", async () => {
  const skipped = { count: 2, items: [{ path: "workspaces/b/..\\plug", reason: "special" }, { path: "a\\b", reason: "unreadable" }], bots: { b: "Be\u0007ll" } };
  const f = fixture(); f.finish({ ...valid, skipped });
  const result = await f.result;
  assert.equal(result.skipped.count, 2);
  assert.deepEqual(result.skipped.items.map(item => item.path), ["workspaces/b/..\\plug", "a\\b"]);
  assert.equal(result.skipped.bots.b, "Be?ll");
});
