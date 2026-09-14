import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {prepareBackedUpInstall,resumeBackedUpInstall} from "./preupgrade-continuation.mjs";
const candidate={version:"0.1.54",candidateId:"fixture-candidate"};
test("ordinary legacy preparation runs once without inventing a candidate",async()=>{
  let prepared=0;assert.deepEqual(await prepareBackedUpInstall(null,{backup:{requestUpgrade:async value=>{assert.equal(value,null);return{status:"continue"};}},prepareNormal:async()=>{prepared++;}}),{status:"continue"});assert.equal(prepared,1);
});
test("deferred or rejected backup never reaches ordinary update cleanup",async()=>{
  let prepared=0;const prepareNormal=async()=>{prepared++;};
  assert.equal((await prepareBackedUpInstall(candidate,{backup:{requestUpgrade:async()=>({status:"deferred"})},prepareNormal})).status,"deferred");
  for(const value of [undefined,false,{status:"unknown"}])await assert.rejects(prepareBackedUpInstall(candidate,{backup:{requestUpgrade:async()=>value},prepareNormal}));assert.equal(prepared,0);
});
test("verified return persists install request before cleanup and invocation",async()=>{
  const calls=[];const backup={pendingUpgrade:()=>({candidate,phase:"return-pending"}),verifyUpgrade:async value=>{assert.equal(value,candidate);calls.push("verify");},markUpgradeInstallRequested:async value=>{assert.equal(value,candidate);calls.push("cas");}};
  const updater={resumeInstall:async(value,{beforeInstall})=>{assert.equal(value,candidate);calls.push("resume");assert.deepEqual(await beforeInstall(value),{status:"continue"});calls.push("invoke");return{status:"install-requested"};}};
  assert.deepEqual(await resumeBackedUpInstall({backup,updater,currentVersion:"0.1.53",cleanup:async()=>{calls.push("cleanup");}}),{status:"install-requested"});assert.deepEqual(calls,["verify","resume","cas","cleanup","invoke"]);
});
test("CAS or cleanup failure cannot invoke updater",async()=>{
  for(const failure of ["cas","cleanup"]){let invoked=0;const backup={pendingUpgrade:()=>({candidate,phase:"return-pending"}),verifyUpgrade:async()=>{},markUpgradeInstallRequested:async()=>{if(failure==="cas")throw Error("refused");}};
    await assert.rejects(resumeBackedUpInstall({backup,currentVersion:"0.1.53",cleanup:async()=>{if(failure==="cleanup")throw Error("unconfirmed");},updater:{resumeInstall:async(value,{beforeInstall})=>{await beforeInstall(value);invoked++;return{status:"install-requested"};}}}));assert.equal(invoked,0);
  }
});
test("requested install completes only observed target version and never replays",async()=>{
  let completed=0,resumed=0;const backup={pendingUpgrade:()=>({candidate,phase:"install-requested"}),completeUpgrade:async version=>{assert.equal(version,candidate.version);completed++;}};
  const options={backup,updater:{resumeInstall:async()=>{resumed++;}},cleanup:async()=>{throw Error("unexpected cleanup");}};
  await assert.rejects(resumeBackedUpInstall({...options,currentVersion:"0.1.53"}));assert.equal(completed,0);
  assert.deepEqual(await resumeBackedUpInstall({...options,currentVersion:"0.1.54"}),{status:"completed"});assert.equal(completed,1);assert.equal(resumed,0);
});
test("unknown backup phases cannot resume and startup dispatch precedes normal writers",async()=>{
  for(const phase of ["capturing","needs-review","handoff-prepared"])await assert.rejects(resumeBackedUpInstall({backup:{pendingUpgrade:()=>({candidate,phase})},updater:{resumeInstall:()=>{throw Error("must not call");}}}));
  const main=readFileSync(new URL("./main.mjs",import.meta.url),"utf8");const start=main.slice(main.indexOf("const desktopStartup ="));assert.ok(start.indexOf("const upgrade=backupScheduleHost?.pendingUpgrade()")<start.indexOf("migrateLegacyDataDirectory"));assert.ok(start.includes("void desktopStartup.then(()=>resumeBackedUpInstall"));assert.ok(main.includes("await backupScheduleHost.returnUpgradeToWorkspace()"));
});
