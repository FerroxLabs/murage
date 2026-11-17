// Crash witness owner: win-sac-sign; real Windows broker/VM/upload/extraction crash witness owner: MAIN.
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
const roots=[];
afterEach(()=>{for(const root of roots.splice(0))removeTempDirSync(root);});
it.each(["after-sign","before-embed","during-commit","disk-full","verify-sync"])("checks owned-process receipt persistence at %s",async phase=>{
  const child=spawn(process.execPath,["scripts/fixtures/windows-signing-receipt-crash.mjs",phase],{
    shell:false,env:{PATH:"",NODE_OPTIONS:"",PSModulePath:"",TMPDIR:os.tmpdir()},stdio:["ignore","pipe","pipe","ipc"]});
  let diagnostics="";
  child.stdout.on("data",data=>{diagnostics+=data;});child.stderr.on("data",data=>{diagnostics+=data;});
  const exited=new Promise(resolve=>child.once("exit",(code,signal)=>resolve({code,signal})));
  try{
    const message=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error("fixture phase timeout: "+diagnostics)),10_000);
      child.once("message",value=>{clearTimeout(timer);resolve(value);});
      child.once("error",error=>{clearTimeout(timer);reject(error);});
      child.once("exit",code=>{clearTimeout(timer);reject(Error("fixture exited before phase: "+code+" "+diagnostics));});
    });
    roots.push(message.root);expect(message.phase).toBe(phase);
    expect(fs.existsSync(message.file)).toBe(phase==="verify-sync");
    if(phase==="verify-sync"){
      expect(message.synced).toBe(true);expect((await exited).code).toBe(0);
    }else if(phase==="disk-full"){
      expect(message.code).toBe("ENOSPC");expect(message.partial).toBe(false);expect((await exited).code).toBe(0);
    }else{
      child.kill("SIGKILL");expect((await exited).signal).toBe("SIGKILL");
      expect(fs.existsSync(message.file)).toBe(false);
      if(phase==="during-commit")expect(fs.existsSync(`${message.file}.partial`)).toBe(true);
    }
  }finally{
    if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");
    await exited;
  }
},15_000);
