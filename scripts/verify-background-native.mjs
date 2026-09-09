import { createRequire } from "node:module";
import { mkdtempSync,mkdirSync,rmSync,readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { startStartupUiFixture } from "./testing/startup-ui-fixture.mjs";

if(process.platform!=="darwin")throw Error("This native confirmation is scoped to macOS; other platforms remain unverified.");
const require=createRequire(import.meta.url),scratch=mkdtempSync(join(tmpdir(),"murage-background-native-"));
const output=resolve(".planning/background-tray-confirm");mkdirSync(output,{recursive:true});
let fixture;
try{
  fixture=await startStartupUiFixture(join(scratch,"vite-cache"));
  const runId=randomUUID();
  const env={...process.env,MURAGE_BACKGROUND_RUN_ID:runId,MURAGE_BACKGROUND_USER_DATA:scratch,MURAGE_BACKGROUND_URL:fixture.url,MURAGE_BACKGROUND_OUTPUT:join(output,"native.json"),MURAGE_BACKGROUND_SCREENSHOT:join(output,"native-startup.png"),MURAGE_BACKGROUND_DIAGNOSTICS:join(output,"tray-diagnostics.json")};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(require("electron"),[fileURLToPath(new URL("./testing/background-native-fixture.mjs",import.meta.url))],{env,stdio:"inherit",detached:true});
  const timer=setTimeout(()=>{try{process.kill(-child.pid,"SIGTERM");}catch{}},45000);
  let code;try{code=await new Promise((done,fail)=>{child.once("error",fail);child.once("exit",done);});}finally{clearTimeout(timer);}
  if(code!==0)throw Error(`Owned Electron fixture exited ${code}`);
  if(JSON.parse(readFileSync(env.MURAGE_BACKGROUND_OUTPUT,"utf8")).runId!==runId)throw Error("Native fixture did not produce a fresh completion receipt.");
  console.log(`Native background evidence: ${join(output,"native.json")}`);
}finally{await fixture?.close();rmSync(scratch,{recursive:true,force:true});}
