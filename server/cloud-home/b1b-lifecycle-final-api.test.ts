// SPDX-License-Identifier: AGPL-3.0-or-later
import { request } from "node:http";
import { createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-murage.ts";
const origin="https://home.example.test",secret="fixture-b1b-final-bootstrap-secret"; // secret-scan: fixture
const PNG="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
async function fixture(race=false,advanced?: "avatar-denial"|"avatar-body"|"channels") {
  const instrumentationSource=[
    "const fs=await import('node:fs'),path=await import('node:path'),url=await import('node:url');const root=process.env.MURAGE_DATA_DIR;",
    "const controlFixture=await import(url.pathToFileURL(path.join(process.cwd(),'server/cloud-home/control-state-verification.fixture.mjs')).href);controlFixture.installVerificationControl("+JSON.stringify(origin)+");",
    "const secrets=await import(url.pathToFileURL(path.join(process.cwd(),'server/cloud-home/server-secrets.ts')).href);secrets.updateServerCredentials({openaiImageApiKey:'sk-proj-FAKE_FINAL_IMAGE_KEY',fluxApiKey:'sk-flux-FAKE_FINAL_FLUX_KEY',telegramBotToken:'FAKE_FINAL_TELEGRAM_TOKEN'});",
    "const file=path.join(root,'config.json'),config=JSON.parse(fs.readFileSync(file,'utf8'));config.automationsPaused=true;"+(race?"config.telegram={targetBotId:'fixture-target',botToken:''};":"")+"fs.writeFileSync(file,JSON.stringify(config));",
    race?"const {TelegramService}=await import(url.pathToFileURL(path.join(process.cwd(),'server/telegram-service.ts')).href);TelegramService.prototype.resume=async function(){if(!fs.existsSync(path.join(root,'hold-resume')))return false;fs.writeFileSync(path.join(root,'resume-entered'),'1');while(!fs.existsSync(path.join(root,'release-resume')))await new Promise(resolve=>setTimeout(resolve,5));return true;};const http=await import('node:http'),emit=http.Server.prototype.emit;http.Server.prototype.emit=function(event,...args){if(event==='request'&&args[0]?.url==='/api/cloud/stop'&&fs.existsSync(path.join(root,'hold-resume')))fs.writeFileSync(path.join(root,'later-stop-received'),'1');return emit.call(this,event,...args);};":"",
    advanced==="channels" ? [
      "secrets.updateServerCredentials({telegramBotToken:'123:FAKE_SYNTHETIC_TELEGRAM_TOKEN',slackAppToken:'FAKE_SLACK_APP',slackBotToken:'FAKE_SLACK_BOT'});const {Store}=await import(url.pathToFileURL(path.join(process.cwd(),'server/store.ts')).href);const store=new Store();const chief=store.createBot({name:'Channel Chief',modelSelection:{instanceId:'verification',model:'claude-sonnet-4-6'}});store.patchBot(chief.id,{chiefOfStaff:true,chiefScope:'workspace'});",
      "const configFile=path.join(root,'config.json'),c=JSON.parse(fs.readFileSync(configFile,'utf8'));c.telegram={targetBotId:chief.id,botToken:''};c.slack={teamId:'TEAM',appId:'APP',ownerUserId:'UOWNER',targetBotId:chief.id,appToken:'',botToken:''};fs.writeFileSync(configFile,JSON.stringify(c));",
      "fs.mkdirSync(path.join(root,'telegram'),{recursive:true});fs.writeFileSync(path.join(root,'telegram','connection.json'),JSON.stringify({version:1,botIdentityId:'123',targetBotId:chief.id,enabled:true,paused:false}));fs.writeFileSync(path.join(root,'telegram','123.json'),JSON.stringify({version:1,botIdentityId:'123',targetBotId:chief.id,enabled:true,offset:0,binding:{senderId:'456',chatId:'456'},pairing:null,records:[]}));",
      "fs.mkdirSync(path.join(root,'channels','slack'),{recursive:true});fs.writeFileSync(path.join(root,'channels','slack','connection.json'),JSON.stringify({version:1,chosen:{teamId:'TEAM',appId:'APP',ownerUserId:'UOWNER',chiefBotId:chief.id},identity:{teamId:'TEAM',userId:'UBOT',botId:'BOT'},enabled:true,paused:false,binding:{connectionId:'fixture-connection',teamId:'TEAM',appId:'APP',ownerUserId:'UOWNER',chiefBotId:chief.id,botUserId:'UBOT',botId:'BOT',dmId:'DOWNER'},pairing:null}));",
      "const {database}=await import(url.pathToFileURL(path.join(process.cwd(),'server/database.ts')).href),{CloudSessions}=await import(url.pathToFileURL(path.join(process.cwd(),'server/cloud-sessions.ts')).href);new CloudSessions(database());database().prepare(\"INSERT OR REPLACE INTO cloud_meta VALUES ('execution-hold','stop')\").run();database().prepare(\"INSERT OR REPLACE INTO cloud_meta VALUES ('execution-previous-pause','1')\").run();const bootstrap=CloudSessions.prototype.verifyBootstrap;CloudSessions.prototype.verifyBootstrap=function(...args){const value=bootstrap.apply(this,args);if(value.operation==='/api/cloud/account/resume')fs.appendFileSync(path.join(root,'accepted-resumes'),'1\\n');return value;};",
      "const {TelegramTransport}=await import(url.pathToFileURL(path.join(process.cwd(),'server/telegram-transport.ts')).href);TelegramTransport.prototype.getMe=async function(){fs.appendFileSync(path.join(root,'telegram-starts'),'1\\n');while(!fs.existsSync(path.join(root,'release-telegram')))await new Promise(resolve=>setTimeout(resolve,5));fs.writeFileSync(path.join(root,'telegram-returned'),'1');return{id:'123',username:'fixture_bot'};};TelegramTransport.prototype.getUpdates=async()=>[];",
      "const {SlackSocketTransport}=await import(url.pathToFileURL(path.join(process.cwd(),'server/channels/slack/transport.ts')).href);SlackSocketTransport.prototype.verifyBot=async function(){fs.appendFileSync(path.join(root,'slack-starts'),'1\\n');while(!fs.existsSync(path.join(root,'release-slack')))await new Promise(resolve=>setTimeout(resolve,5));return{teamId:'TEAM',userId:'UBOT',botId:'BOT'};};SlackSocketTransport.prototype.start=async function(_cb,health){health('connected');};SlackSocketTransport.prototype.stop=async()=>{};",
    ].join("\n") : "",
    "const original=globalThis.fetch;globalThis.fetch=async(input,init)=>{const target=String(input);",
    advanced?.startsWith("avatar") ? "if(init?.method==='POST'&&target.includes('/images/')){const flux=target.startsWith('https://api.fluxrouter.ai/');fs.appendFileSync(path.join(root,'avatar-attempts'),flux?'flux\\n':'openai\\n');if(flux){if(fs.existsSync(path.join(root,'hold-avatar'))&&"+JSON.stringify(advanced)+"==='avatar-denial'){fs.writeFileSync(path.join(root,'avatar-held'),'1');while(!fs.existsSync(path.join(root,'release-avatar')))await new Promise(resolve=>setTimeout(resolve,5));}return new Response(JSON.stringify({error:{message:'fixture capability denial'}}),{status:402});}const text=JSON.stringify({data:[{b64_json:"+JSON.stringify(PNG)+"}]});if(fs.existsSync(path.join(root,'hold-avatar'))&&"+JSON.stringify(advanced)+"==='avatar-body'){return new Response(new ReadableStream({start(controller){fs.writeFileSync(path.join(root,'avatar-held'),'1');void(async()=>{while(!fs.existsSync(path.join(root,'release-avatar')))await new Promise(resolve=>setTimeout(resolve,5));controller.enqueue(new TextEncoder().encode(text));controller.close();})();}}));}return new Response(text);}" : "",
    "if(target.startsWith('https://api.openai.com/')||target.startsWith('https://api.fluxrouter.ai/')){if(init?.method==='POST'&&target.includes('/images/')){fs.appendFileSync(path.join(root,'paid-dispatches'),'avatar\\n');return new Response(JSON.stringify({data:[{b64_json:"+JSON.stringify(PNG)+"}]}));}if(init?.method==='POST'&&target.endsWith('/audio/transcriptions')){fs.appendFileSync(path.join(root,'paid-dispatches'),'transcribe\\n');return new Response(JSON.stringify({task:'transcribe',language:'en',duration:1,text:'fixture words',segments:[]}));}return new Response(JSON.stringify({data:[]}),{status:404});}",
    "if(target.startsWith('http://127.0.0.1:')||target.startsWith('http://localhost:'))return original(input,init);throw new Error('Fixture refused external network');};",
  ].join("\n");
  const server=await launchVerificationServer({},undefined,{cloud:{publicOrigin:origin,bootstrapSecret:secret},instrumentationSource,readyTimeoutMs:60_000});
  const api=(method:string,path:string,body?:unknown,token?:string,extra:Record<string,string>={})=>new Promise<{status:number;body:any}>((resolve,reject)=>{
    const raw=body===undefined?undefined:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));const req=request(server.info.url+path,{method,headers:{host:"home.example.test",origin,"content-type":"application/json",...(raw?{"content-length":String(raw.length)}:{}),...(token?{authorization:"Bearer "+token}:{}),...extra}},res=>{const chunks:Buffer[]=[];res.on("data",c=>chunks.push(c));res.on("end",()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())}));});req.on("error",reject);req.end(raw);
  });
  const control=(path:string,extra:object={})=>{const body={operation:path,timestamp:Date.now()/1000,nonce:randomUUID(),...extra};return api("POST",path,body,undefined,{"x-murage-signature":createHmac("sha256",secret).update(JSON.stringify(body)).digest("hex")});};
  try {
    const identity=await api("GET","/.well-known/murage/environment"),key=generateKeyPairSync("ed25519"),factor=generateKeyPairSync("ed25519"),mint=await control("/api/cloud/pairing",{account:"owner",scope:"owner-desktop",publicKey:key.publicKey.export({type:"spki",format:"pem"}).toString(),assertionKey:factor.publicKey.export({type:"spki",format:"pem"}).toString()});expect(mint.status).toBe(200);
    const msg=Buffer.from("murage-pair:"+identity.body.environmentId+":"+mint.body.code+":owner"),pair=await api("POST","/api/cloud/pair",{account:"owner",code:mint.body.code,signature:sign(null,msg,key.privateKey).toString("base64url"),assertionSignature:sign(null,msg,factor.privateKey).toString("base64url")});expect(pair.status).toBe(200);
    return {server,api,control,token:pair.body.accessToken as string,dispatches:()=>{const p=join(server.info.dataDir,"paid-dispatches");return existsSync(p)?readFileSync(p,"utf8").trim().split("\n").length:0;}};
  } catch(error) {await server.close();throw error;}
}
it("B1b repeated signed resume preserves the owner's prior automation pause",async()=>{
  const f=await fixture();try {
    expect((await f.api("GET","/api/automation-admission",undefined,f.token)).body.paused).toBe(true);
    const initial=new DatabaseSync(join(f.server.info.dataDir,"messages.db"),{readOnly:true});try{
      expect(initial.prepare("SELECT value FROM cloud_meta WHERE key='lease-hold'").get()).toBeUndefined();
      expect(initial.prepare("SELECT value FROM cloud_meta WHERE key='execution-hold'").get()).toBeUndefined();
    }finally{initial.close();}
    expect((await f.control("/api/cloud/stop")).status).toBe(200);
    expect((await f.control("/api/cloud/account/resume")).status).toBe(200);
    expect((await f.api("GET","/api/automation-admission",undefined,f.token)).body.paused).toBe(true);
    expect((await f.control("/api/cloud/account/resume")).status).toBe(200);
    expect((await f.api("GET","/api/automation-admission",undefined,f.token)).body.paused).toBe(true);
  } finally {await f.server.close();}
},90_000);
it.each([false,true])("B3 lease restoration preserves the owner's explicit stop: %s",async ownerStops=>{
  const f=await fixture(),file=(name:string)=>join(f.server.info.dataDir,name);
  const metadata=()=>{const db=new DatabaseSync(join(f.server.info.dataDir,"messages.db"),{readOnly:true});try{return {lease:db.prepare("SELECT value FROM cloud_meta WHERE key='lease-hold'").get(),explicit:db.prepare("SELECT value FROM cloud_meta WHERE key='execution-hold'").get(),prior:db.prepare("SELECT value FROM cloud_meta WHERE key='execution-previous-pause'").get()};}finally{db.close();}};
  try{
    writeFileSync(file("control-clock-offset"),"3480000");
    await f.api("GET","/api/bots",undefined,f.token);
    await expect.poll(()=>Boolean(metadata().lease),{timeout:15_000}).toBe(true);
    expect(metadata().explicit).toBeUndefined();
    expect((await f.control("/api/cloud/account/resume")).status).toBe(403);
    if(ownerStops){expect((await f.control("/api/cloud/stop")).status).toBe(200);expect(metadata().prior).toMatchObject({value:"1"});}
    writeFileSync(file("control-renew"),"renewed");
    await expect.poll(async()=>{await f.api("GET","/api/bots",undefined,f.token);return Boolean(metadata().lease);},{timeout:15_000}).toBe(false);
    expect((await f.api("GET","/api/automation-admission",undefined,f.token)).body.paused).toBe(true);
    if(ownerStops){expect(metadata().explicit).toMatchObject({value:"stop"});expect((await f.control("/api/cloud/account/resume")).status).toBe(200);}
    else expect(metadata().explicit).toBeUndefined();
  }finally{await f.server.close();}
},90_000);
it.each(["stop","stop-resume","late-body"])("B1b HIGH avatar %s refuses fallback or output after lifecycle cancellation",async mode=>{
  const f=await fixture(false,mode==="late-body"?"avatar-body":"avatar-denial");
  const file=(name:string)=>join(f.server.info.dataDir,name);
  try {
    const created=await f.api("POST","/api/bots",{name:"Avatar attempt fixture"},f.token),path="/api/bots/"+created.body.bot.id+"/avatar/generate";
    const positive=await f.api("POST",path,{prompt:"positive fallback"},f.token);expect(positive.status).toBe(201);
    expect(readFileSync(file("avatar-attempts"),"utf8").trim().split("\n")).toEqual(["flux","openai"]);
    const before=positive.body.avatarUrl;writeFileSync(file("hold-avatar"),"1");
    const pending=f.api("POST",path,{prompt:"held request"},f.token);
    await expect.poll(()=>existsSync(file("avatar-held")),{timeout:15_000}).toBe(true);
    expect((await f.control("/api/cloud/stop")).status).toBe(200);
    if(mode==="stop-resume")expect((await f.control("/api/cloud/account/resume")).status).toBe(200);
    writeFileSync(file("release-avatar"),"1");expect((await pending).status).toBe(403);
    if(mode!=="late-body")expect(readFileSync(file("avatar-attempts"),"utf8").trim().split("\n").filter(item=>item==="openai")).toHaveLength(1);
    const current=await f.api("GET","/api/bots",undefined,f.token);
    expect(current.status).toBe(200);
    expect(Array.isArray(current.body.bots)).toBe(true);
    const currentBot=current.body.bots.find((bot:{id:string;avatarUrl?:string|null})=>bot.id===created.body.bot.id);
    expect(currentBot).toBeDefined();
    expect(currentBot.avatarUrl).toBe(before);
  } finally {writeFileSync(file("release-avatar"),"1");await f.server.close();}
},90_000);
it.each(["overlap","stop-interleave"])("B1b HIGH real channel restoration survives %s",async mode=>{
  const f=await fixture(false,"channels"),file=(name:string)=>join(f.server.info.dataDir,name);
  const count=(name:string)=>existsSync(file(name))?readFileSync(file(name),"utf8").trim().split("\n").length:0;
  const status=()=>f.api("GET","/api/telegram/status",undefined,f.token);
  const settlements:Promise<unknown>[]=[];
  const track=(p:ReturnType<typeof f.control>)=>{const observed=p.catch(error=>({status:0,body:{transportError:String(error)}}));settlements.push(observed);return observed;};
  try {
    const a=track(f.control("/api/cloud/account/resume"));await expect.poll(()=>count("telegram-starts"),{timeout:15_000}).toBe(1);
    if(mode==="stop-interleave")expect((await f.control("/api/cloud/stop")).status).toBe(200);
    const b=track(f.control("/api/cloud/account/resume"));await expect.poll(()=>count("accepted-resumes"),{timeout:15_000}).toBe(2);
    await status();const beforeRelease=count("telegram-starts");
    writeFileSync(file("release-telegram"),"1");await expect.poll(()=>existsSync(file("telegram-returned")),{timeout:15_000}).toBe(true);
    await status(); // Loopback fence; never wait for Slack entry before release.
    writeFileSync(file("release-slack"),"1");
    const results=await Promise.all([a,b]);expect(results[1].status).toBe(200);
    expect(await status()).toMatchObject({status:200,body:{resumeState:"active",enabled:true,paired:true}});
    expect(await f.api("GET","/api/slack/status",undefined,f.token)).toMatchObject({status:200,body:{state:"connected",enabled:true,paired:true}});
    if(mode==="overlap")expect(results[0].status).toBe(200);else expect(beforeRelease).toBe(1);
    const db=new DatabaseSync(join(f.server.info.dataDir,"messages.db"),{readOnly:true});try {expect(db.prepare("SELECT value FROM cloud_meta WHERE key='execution-hold'").get()).toBeUndefined();}finally {db.close();}
    expect((await f.control("/api/cloud/stop")).status).toBe(200);expect((await status()).body.enabled).toBe(false);expect((await f.api("GET","/api/slack/status",undefined,f.token)).body.enabled).toBe(false);
  } finally {writeFileSync(file("release-telegram"),"1");writeFileSync(file("release-slack"),"1");await Promise.allSettled(settlements);await f.server.close();}
},90_000);
it.each(["avatar","transcribe"])("B1b stopped home rejects new paid %s calls",async kind=>{
  const f=await fixture();try {
    const bot=await f.api("POST","/api/bots",{name:"Paid path fixture"},f.token);expect(bot.status).toBe(201);
    const path=kind==="avatar"?"/api/bots/"+bot.body.bot.id+"/avatar/generate":"/api/voice/transcribe";
    const body=kind==="avatar"?{prompt:"fixture avatar"}:Buffer.concat([Buffer.from([0x4f,0x67,0x67,0x53,0x00,0x02,0x00,0x00]),Buffer.alloc(2048)]);
    const headers:Record<string,string>=kind==="avatar"?{}:{"content-type":"audio/ogg"};
    const positive=await f.api("POST",path,body,f.token,headers);expect(positive.status).toBe(kind === "avatar" ? 201 : 200);expect(f.dispatches()).toBe(1);
    expect((await f.control("/api/cloud/stop")).status).toBe(200);
    expect((await f.api("POST",path,body,f.token,headers)).status).toBe(403);expect(f.dispatches()).toBe(1);
  } finally {await f.server.close();}
},90_000);
it("B1b a later stop cannot be undone by an earlier asynchronous resume",async()=>{
  const f=await fixture(true);try {
    expect((await f.control("/api/cloud/stop")).status).toBe(200);
    writeFileSync(join(f.server.info.dataDir,"hold-resume"),"1");
    const resume=f.control("/api/cloud/account/resume");await expect.poll(()=>existsSync(join(f.server.info.dataDir,"resume-entered")),{timeout:15_000}).toBe(true);
    const stop=f.control("/api/cloud/stop");await expect.poll(()=>existsSync(join(f.server.info.dataDir,"later-stop-received")),{timeout:15_000}).toBe(true);
    writeFileSync(join(f.server.info.dataDir,"release-resume"),"1");
    const results=await Promise.all([resume,stop]);expect(results[1].status).toBe(200);
    const db=new DatabaseSync(join(f.server.info.dataDir,"messages.db"),{readOnly:true});try {expect(db.prepare("SELECT value FROM cloud_meta WHERE key='execution-hold'").get()).toMatchObject({value:"stop"});}finally {db.close();}
  } finally {writeFileSync(join(f.server.info.dataDir,"release-resume"),"1");await f.server.close();}
},90_000);
