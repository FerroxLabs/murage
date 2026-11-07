import {spawn} from "node:child_process";
import {mkdtempSync,writeFileSync,readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";
const [executable,evidence]=process.argv.slice(2);
if(!path.isAbsolute(executable??"")||!path.isAbsolute(evidence??""))throw Error("absolute Electron executable and lane evidence directory required");
for(const first of ["old","candidate"]){
 const directory=mkdtempSync(path.join(evidence,"lock-"));writeFileSync(path.join(directory,"fixture-marker"),"macwd-lock-fixture\n");
 const launch=role=>spawn(executable,[fileURLToPath(new URL("./competing-launch.mjs",import.meta.url))],{env:{...process.env,MURAGE_MACWD_LOCK_FIXTURE:directory,MURAGE_MACWD_ROLE:role},stdio:"pipe"});
 const winner=launch(first);let loser;
 try{
  const start=Date.now();while(true){let text="";try{text=readFileSync(path.join(directory,"events.jsonl"),"utf8");}catch{}if(text.includes("winner-ready"))break;if(Date.now()-start>8000)throw Error("lock fixture did not start");await new Promise(resolve=>setTimeout(resolve,50));}
  loser=launch(first==="old"?"candidate":"old");const code=await new Promise(resolve=>loser.once("exit",resolve));assert.equal(code,0);
  const events=readFileSync(path.join(directory,"events.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.filter(e=>e.pid===loser.pid).map(e=>e.event),["loser-exit"]);
  assert.deepEqual(events.filter(e=>e.pid===winner.pid).map(e=>e.event),["acquireDesktopDataOwner","pendingUpgrade","settleRequestedInstall","winner-ready"]);
 }finally{winner.kill("SIGTERM");if(loser?.exitCode===null)loser.kill("SIGTERM");}
}
