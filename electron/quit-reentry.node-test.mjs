import {createReturnAuthority,revokeReturn,joinExplicitQuit} from "./backup-offline-return.mjs";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const source=readFileSync(new URL("./main.mjs",import.meta.url),"utf8");
const handler=source.slice(source.indexOf('app.on("before-quit", (e) => {'));
function fixture(cleanup,overrides={}){
  let trigger;const events=[],queue=[],causes=[],reasons=[];
  const scope={internalBackupQuit:false,backupScheduleHost:null,noteShutdownCause:()=>{},shutdownCause:"owner",startupFailureExit:false,recordStartupRefusal:()=>{},startupDecisionPending:false,updateRecoveryDescriptor:null,updateRequester:false,returnAuthority:createReturnAuthority(),revokeReturn,joinExplicitQuit:options=>joinExplicitQuit({...options,scheduleExit:callback=>queue.push(callback),setTimer:()=>{}}),finishUpdateWait:()=>{},takeBackupProgress:()=>null,cleanupFailed:()=>events.push("incomplete"),app:{on:(_event,callback)=>{trigger=callback;},quit:()=>events.push("quit")},backgroundLifecycle:null,cuaCleanedUp:false,desktopCleanup:null,cleanupDesktopForExit:cleanup,setImmediate:callback=>queue.push(callback),slog:()=>{},desktopCleanupStage:"owned harness",dialog:{showErrorBox:()=>events.push("incomplete")}};
  Object.assign(scope,{noteShutdownCause:cause=>causes.push(cause),quitAfterBackup:()=>events.push("internal quit"),
    cleanupDesktopForExit:(reason,token)=>{reasons.push(reason);return cleanup(reason,token);}},overrides);
  new Function(...Object.keys(scope),handler)(...Object.values(scope));
  return {events,queue,causes,reasons,scope,trigger:()=>trigger({preventDefault:()=>events.push("prevented")})};
}
test("successful cleanup queues quit after the prevented native invocation unwinds",async()=>{
  const f=fixture(()=>Promise.resolve());f.trigger();await Promise.resolve();await Promise.resolve();
  assert.deepEqual(f.events,["prevented"]);assert.equal(f.queue.length,1);
  f.queue[0]();assert.deepEqual(f.events,["prevented","quit"]);
});
test("failed cleanup does not schedule or force a quit",async()=>{
  const f=fixture(()=>Promise.reject(Error("writer still active")));f.trigger();await Promise.resolve();await Promise.resolve();
  assert.equal(f.queue.length,0);assert.deepEqual(f.events,["prevented","incomplete"]);
});

test("merged user quit notes Stop once, cleans up as user-stop, and records owner shutdown cause",async()=>{
  let stops=0;
  const f=fixture(async()=>{},{backupScheduleHost:{noteStop:()=>{stops++;}}});
  f.trigger();await Promise.resolve();await Promise.resolve();
  assert.equal(stops,1);
  assert.deepEqual(f.reasons,["user-stop"]);
  assert.deepEqual(f.causes,["owner"]);
  assert.equal(f.scope.app.murageShutdownCause,"owner");
  assert.equal(f.scope.returnAuthority.userQuitRequested,true);
  assert.equal(f.queue.length,1);
  f.queue.shift()();
  assert.equal(stops,1);
  assert.deepEqual(f.events,["prevented","quit"]);
});

for(const flag of ["internalBackupQuit","authority.internalQuit"])test(`merged internal backup quit via ${flag} skips Stop, cleans up as internal, and records automatic shutdown cause`,async()=>{
  let stops=0;
  const authority=createReturnAuthority();
  if(flag==="authority.internalQuit")authority.internalQuit=true;
  const f=fixture(async()=>{},{shutdownCause:null,internalBackupQuit:flag==="internalBackupQuit",
    returnAuthority:authority,backupScheduleHost:{noteStop:()=>{stops++;}}});
  f.trigger();await Promise.resolve();await Promise.resolve();
  assert.equal(stops,0);
  assert.deepEqual(f.reasons,["internal"]);
  assert.deepEqual(f.causes,["automatic"]);
  assert.equal(f.scope.app.murageShutdownCause,"automatic");
  assert.equal(authority.userQuitRequested,false);
  assert.equal(f.queue.length,1);
  f.queue.shift()();
  assert.deepEqual(f.events,["prevented","internal quit"]);
});
