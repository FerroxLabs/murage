import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createServerChildLifecycle } from "./server-child-lifecycle.mjs";

const source=readFileSync(new URL("./companion.mjs",import.meta.url),"utf8");
const text=source.slice(source.indexOf("async function stop() {"),source.indexOf("/** Publish or withdraw"));
const startText=source.slice(source.indexOf("async function start({"),source.indexOf("/** The three door variables"));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(timeoutMs=20) {
  const child=new EventEmitter();child.pid=234;child.kill=()=>true;
  const lifecycle=createServerChildLifecycle(child,{timeoutMs});
  return {child,...new Function("child","lifecycle",`
    let proc=child,procLifecycle=lifecycle,lastError=null,advertisedHostedUrl="host",remoteAccessOrigin="https://fixture",originTarget={};
    const expectedStops=new WeakSet();
    child.once("exit",()=>{proc=null;procLifecycle=null;});
    const companionState=async()=>({enabled:Boolean(proc),error:lastError});
    ${text}
    ${startText}
    return {stop,state:companionState,start};
  `)(child,lifecycle)};
}

test("actual companion stop does not declare a live child off",async()=>{
  const f=fixture();let returned=false;
  const stopped=f.stop().then(()=>{returned=true;},()=>{});
  await pause(5);
  const before=await f.state();
  f.child.emit("exit",0);
  await stopped;
  assert.equal(before.enabled,true,"live child must remain owned until exit");
  assert.equal((await f.state()).enabled,false);
  assert.equal(returned,true);
});

test("actual companion timeout rejects and retains ownership for retry",async()=>{
  const f=fixture();
  // Legacy stop resolves at five seconds: keep this test bounded while still
  // letting the assertion fail on the actual pre-fix state, not a mock error.
  const result=await Promise.race([f.stop().then(()=>"resolved",()=>"rejected"),pause(40).then(()=>"pending")]);
  const state=await f.state();
  f.child.emit("exit",0);
  assert.equal(state.enabled,true);
  assert.equal(result,"rejected");
  assert.match(state.error,/exit|stop|retry/i);
  await f.stop();
});

test("actual companion start refuses to replace a timed-out live child",async()=>{
  const f=fixture();
  await assert.rejects(f.stop());
  // Any fork/config/probe here would be an unbound dependency: the live
  // ownership guard must return the actionable retained state first.
  const state=await f.start({});
  assert.equal(state.enabled,true);assert.match(state.error,/retry Stop/);
  f.child.emit("exit",0);
});
