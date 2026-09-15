import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
const root=dirname(dirname(fileURLToPath(import.meta.url)));
/** Actual index.ts → SlackSocketTransport → SlackService sender check → routines → task → native fixture.
 * SDK network and model are scripted; no live service, credentials or normal profile is used. */
it("admits two human principals through authenticated-origin routing without owner transcript/native memory reuse",async()=>{
  const home=mkdtempSync(join(tmpdir(),"murage-human-principals-api-")),data=join(home,"data"),staticDir=join(home,"static"),dump=join(home,"turn.json");
  mkdirSync(data);mkdirSync(join(staticDir,"assets"),{recursive:true});
  writeFileSync(join(staticDir,"index.html"),"<!doctype html><title>People fixture</title>");writeFileSync(join(staticDir,"assets/test.css"),"body{}");
  writeFileSync(join(data,"config.json"),JSON.stringify({engineDiscovery:"explicit",instances:{fixtureClaude:{driver:"claudeAgent",config:{cli:join(root,"server/testing/fake-claude-cli.ts")}}}}));
  const port=await freePortBlock([0,1]),secret="abcdef0123456789".repeat(4),headers={"content-type":"application/json","x-murage-surface":"desktop","x-murage-surface-secret":secret};
  let child:ChildProcess|undefined,stderr="";const traces:Array<{op:string;text?:string;eventId?:string}>=[];
  const request=async(method:string,path:string,body?:unknown,owner=true)=>{
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:owner?headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json() as any};
  };
  const api=async(method:string,path:string,body?:unknown)=>{const result=await request(method,path,body);expect(result.status,JSON.stringify(result.body)).toBeLessThan(300);return result.body;};
  const event=(id:string,text:string,user="UOTHER")=>child!.send({kind:"slack-fixture-event",body:{type:"event_callback",team_id:"TEAM",api_app_id:"APP",event_id:id,event_time:Math.floor(Date.now()/1000),authorizations:[{team_id:"TEAM",user_id:"UBOT",is_bot:true}],event:{type:"message",channel_type:"im",channel:"DOTHER",user,text}}});
  const snapshot=()=>{const db=new DatabaseSync(join(data,"messages.db"),{readOnly:true});try{return {threads:db.prepare("SELECT subject_id,intent FROM memory_scope_bindings WHERE subject_type='human-thread'").all(),sources:db.prepare("SELECT thread_id,speaker FROM memory_sources WHERE kind='text'").all()};}finally{db.close();}};
  try{
    const env:NodeJS.ProcessEnv={HOME:home,USERPROFILE:home,MURAGE_DATA_DIR:data,MURAGE_STATIC_DIR:staticDir,MURAGE_PORT:String(port),MURAGE_WEBHOOK_PORT:String(port+1),MURAGE_DEV_DESKTOP_SECRET:secret,PATH:process.env.PATH,FAKE_CLAUDE_DUMP:dump,FAKE_CLAUDE_DUMP_EACH_TURN:"1"};
    if(process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;
    child=spawn(process.execPath,["--import",join(root,"server/testing/slack-sdk-preload.mjs"),join(root,"server/index.ts")],{cwd:root,env,stdio:["ignore","ignore","pipe","ipc"]});
    child.stderr!.on("data",chunk=>{stderr+=chunk;});child.on("message",value=>{if((value as any)?.kind==="slack-fixture")traces.push(value as any);});
    await expect.poll(async()=>{if(child!.exitCode!==null)throw new Error(stderr);try{return(await request("GET","/api/health")).status;}catch{return 0;}},{timeout:20000}).toBe(200);
    const bot=(await api("GET","/api/bots")).bots[0];
    await api("PATCH",`/api/bots/${bot.id}`,{name:"Synthetic People Chief",chiefOfStaff:true,chiefScope:"workspace",computer:"off",browser:false,composio:false,modelSelection:{instanceId:"fixtureClaude",model:"claude-sonnet-5"}});
    await api("POST","/api/memory/action",{action:"identity-write",botId:bot.id,kind:"continuity-brief",key:"core",expectedVersion:0,text:"OWNER_ONLY_CONTINUITY_CANARY",basis:"fiction",audience:"owner-private"});
    await api("POST",`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:"OWNER_ONLY_TRANSCRIPT_CANARY"});
    await expect.poll(()=>existsSync(dump),{timeout:15000}).toBe(true);
    await expect.poll(async()=>!(await api("GET","/api/bots?messages=0")).bots.find((item:any)=>item.id===bot.id).busy,{timeout:15000}).toBe(true);
    expect(JSON.stringify(JSON.parse(readFileSync(dump,"utf8")))).toContain("OWNER_ONLY_CONTINUITY_CANARY");
    await api("PATCH","/api/config?secretStorage=external",{slack:{appToken:"xapp-fixture-not-real",botToken:"xoxb-fixture-not-real",teamId:"TEAM",appId:"APP",ownerUserId:"UOTHER"}});
    const pairing=await api("POST","/api/slack/pair",{targetBotId:bot.id});
    event("EvBADPAIR","/pair "+pairing.code,"UFORGED");await expect.poll(()=>traces.some(trace=>trace.eventId==="EvBADPAIR")).toBe(true);
    expect((await api("GET","/api/slack/status")).paired).toBe(false);
    event("EvPAIR","/pair "+pairing.code);await expect.poll(async()=>(await api("GET","/api/slack/status")).paired).toBe(true);
    const before=readFileSync(dump,"utf8");event("EvUNLINKED","SECOND_PERSON_UNLINKED");
    await expect.poll(()=>traces.some(trace=>trace.eventId==="EvUNLINKED")).toBe(true);
    expect((await api("GET","/api/slack/status")).humanBindingState).toBe("link-required");
    expect(readFileSync(dump,"utf8")).toBe(before);expect(snapshot().threads).toHaveLength(0);
    const binding=(await api("POST","/api/memory/action",{action:"humans"})).bindings[0];
    expect((await request("POST","/api/memory/action",{action:"human-link",bindingId:binding.id,expectedRevision:binding.revision,as:"owner"},false)).status).toBe(404);
    const linked=await api("POST","/api/memory/action",{action:"human-link",bindingId:binding.id,expectedRevision:binding.revision,as:"person"});
    event("EvPERSON","SECOND_PERSON_AUTHENTICATED");
    await expect.poll(()=>existsSync(dump)&&readFileSync(dump,"utf8").includes("SECOND_PERSON_AUTHENTICATED"),{timeout:20000}).toBe(true);
    await expect.poll(async()=>!(await api("GET","/api/bots?messages=0")).bots.find((item:any)=>item.id===bot.id).busy,{timeout:15000}).toBe(true);
    const payload=JSON.parse(readFileSync(dump,"utf8")),serialized=JSON.stringify({prompt:payload.prompt,systemPrompt:payload.systemPrompt});
    expect(serialized).not.toContain("OWNER_ONLY_TRANSCRIPT_CANARY");expect(serialized).not.toContain("OWNER_ONLY_CONTINUITY_CANARY");
    expect(payload.argv).not.toContain("--resume");
    const state=snapshot(),personThread=state.threads.find(row=>JSON.parse(String(row.intent)).personId===linked.personId);
    expect(personThread).toBeTruthy();expect(personThread!.subject_id).not.toBe(bot.threadId);
    expect(state.sources.some(row=>row.thread_id===personThread!.subject_id&&row.speaker==="person:"+linked.personId)).toBe(true);
    const refreshed=(await api("POST","/api/memory/action",{action:"humans"})).bindings[0];
    await api("POST","/api/memory/action",{action:"human-link",bindingId:refreshed.id,expectedRevision:refreshed.revision,as:"person"});
    event("EvRELINKED","THIRD_PERSON_FRESH");await expect.poll(()=>readFileSync(dump,"utf8").includes("THIRD_PERSON_FRESH"),{timeout:20000}).toBe(true);
    const replacement=JSON.parse(readFileSync(dump,"utf8"));expect(replacement.argv).not.toContain("--resume");expect(JSON.stringify(replacement.prompt)).not.toContain("SECOND_PERSON_AUTHENTICATED");
    expect(snapshot().threads.filter(row=>row.subject_id!==personThread!.subject_id)).toHaveLength(1);
  }finally{await waitForExit(child,{signal:"SIGTERM"});await removeTempDir(home);}
},90000);
