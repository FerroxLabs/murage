// SPDX-License-Identifier: AGPL-3.0-or-later
import { request } from "node:http";
import { createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-murage.ts";
const origin="https://home.example.test",secret="fixture-b1b-probe-bootstrap-secret"; // secret-scan: fixture
const PNG="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
async function fixture(gated=false) {
  const instrumentationSource=[
    "const fs=await import('node:fs'),path=await import('node:path'),url=await import('node:url');const root=process.env.MURAGE_DATA_DIR;",
    "const controlFixture=await import(url.pathToFileURL(path.join(process.cwd(),'server/cloud-home/control-state-verification.fixture.mjs')).href);controlFixture.installVerificationControl("+JSON.stringify(origin)+");",
    "const secrets=await import(url.pathToFileURL(path.join(process.cwd(),'server/cloud-home/server-secrets.ts')).href);",
    "secrets.updateServerCredentials("+JSON.stringify(gated?{openaiCompatKey:"sk-or-v1-FAKE_ONLY_PROBE_CREDENTIAL"}:{openaiImageApiKey:"sk-proj-FAKE_ONLY_PROBE_CREDENTIAL"})+");", // secret-scan: fixture
    gated?"const file=path.join(root,'config.json'),body=JSON.parse(fs.readFileSync(file,'utf8'));body.openaiCompat={url:'https://openrouter.ai/api/v1',key:''};fs.writeFileSync(file,JSON.stringify(body));":"",
    "const original=globalThis.fetch;globalThis.fetch=async(input,init)=>{const target=String(input);",
    "if(target==='https://openrouter.ai/api/v1/images/models'){fs.writeFileSync(path.join(root,'probe-preparing'),'1');while(!fs.existsSync(path.join(root,'release-probe')))await new Promise(resolve=>setTimeout(resolve,5));return new Response(JSON.stringify({data:[{id:'openai/gpt-image-2',name:'GPT Image 2',architecture:{output_modalities:['image']},supported_parameters:{output_format:{type:'enum',values:['png','webp']},quality:{type:'enum',values:['low','medium','high']},size:{type:'enum',values:['1024x1024']}}}]}));}",
    "if((target==='https://api.openai.com/v1/images/generations'||(target==='https://openrouter.ai/api/v1/images/generations'||target==='https://openrouter.ai/api/v1/images'))&&init?.method==='POST'){fs.appendFileSync(path.join(root,'probe-dispatches'),'render\\n');return new Response(JSON.stringify({model:'reported-image-model',data:[{b64_json:"+JSON.stringify(PNG)+"}],usage:{cost:0.04}}));}",
    "if(target.startsWith('https://openrouter.ai/')&&target.endsWith('/endpoints'))return new Response(JSON.stringify({endpoints:[{provider_tag:'openai',supported_parameters:{output_format:{type:'enum',values:['png','webp']},quality:{type:'enum',values:['low','medium','high']},size:{type:'enum',values:['1024x1024']}}}]}));",
    "if(target.startsWith('https://api.openai.com/')||target.startsWith('https://openrouter.ai/'))return new Response(JSON.stringify({data:[]}));",
    "if(target.startsWith('http://127.0.0.1:')||target.startsWith('http://localhost:'))return original(input,init);throw new Error('Fixture refused external network');};",
  ].join("\n");
  const server=await launchVerificationServer({},undefined,{cloud:{publicOrigin:origin,bootstrapSecret:secret},instrumentationSource,readyTimeoutMs:60_000});
  const api=(method:string,path:string,body?:unknown,token?:string,extra:Record<string,string>={})=>new Promise<{status:number;body:any}>((resolve,reject)=>{
    const raw=body===undefined?undefined:Buffer.from(JSON.stringify(body));const req=request(server.info.url+path,{method,headers:{host:"home.example.test",origin,"content-type":"application/json",...(raw?{"content-length":String(raw.length)}:{}),...(token?{authorization:"Bearer "+token}:{}),...extra}},res=>{const chunks:Buffer[]=[];res.on("data",c=>chunks.push(c));res.on("end",()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())}));});req.on("error",reject);req.end(raw);
  });
  const control=(path:string,extra:object={})=>{const body={operation:path,timestamp:Date.now()/1000,nonce:randomUUID(),...extra};return api("POST",path,body,undefined,{"x-murage-signature":createHmac("sha256",secret).update(JSON.stringify(body)).digest("hex")});};
  try {
    const identity=await api("GET","/.well-known/murage/environment"),key=generateKeyPairSync("ed25519"),factor=generateKeyPairSync("ed25519"),mint=await control("/api/cloud/pairing",{account:"owner",scope:"owner-desktop",publicKey:key.publicKey.export({type:"spki",format:"pem"}).toString(),assertionKey:factor.publicKey.export({type:"spki",format:"pem"}).toString()});expect(mint.status).toBe(200);
    const msg=Buffer.from("murage-pair:"+identity.body.environmentId+":"+mint.body.code+":owner"),pair=await api("POST","/api/cloud/pair",{account:"owner",code:mint.body.code,signature:sign(null,msg,key.privateKey).toString("base64url"),assertionSignature:sign(null,msg,factor.privateKey).toString("base64url")});expect(pair.status).toBe(200);
    return {server,api,control,token:pair.body.accessToken as string,dispatches:()=>{const p=join(server.info.dataDir,"probe-dispatches");return existsSync(p)?readFileSync(p,"utf8").trim().split("\n").length:0;}};
  } catch(error) {await server.close();throw error;}
}
it.each(["stop","drain"])("B1b actual home dispatcher %s refuses a configured paid image probe",async action=>{
  const f=await fixture();try {
    const body={connectionId:"openai",model:"gpt-image-2"};
    const positive=await f.api("POST","/api/images/probe",body,f.token);expect(positive.status).toBe(200);expect(positive.body.probe.ok).toBe(true);expect(f.dispatches()).toBe(1);
    expect((await f.control("/api/cloud/"+action)).status).toBe(200);
    const stopped=await f.api("POST","/api/images/probe",body,f.token);expect(stopped.status).toBe(403);expect(f.dispatches()).toBe(1);
  } finally {await f.server.close();}
},90_000);
it("B1b actual home drain cancels a probe held in async preparation before paid dispatch or record",async()=>{
  const f=await fixture(true);try {
    const probe=f.api("POST","/api/images/probe",{connectionId:"openrouter",model:"openai/gpt-image-2"},f.token);
    await expect.poll(()=>existsSync(join(f.server.info.dataDir,"probe-preparing")),{timeout:15_000}).toBe(true);
    expect((await f.control("/api/cloud/drain")).status).toBe(200);
    writeFileSync(join(f.server.info.dataDir,"release-probe"),"1");
    expect((await probe).status).toBe(403);expect(f.dispatches()).toBe(0);
    const db=new DatabaseSync(join(f.server.info.dataDir,"messages.db"),{readOnly:true});try {const table=db.prepare("SELECT name FROM sqlite_master WHERE name='image_model_probes'").get();expect(table ? db.prepare("SELECT COUNT(*) AS count FROM image_model_probes").get() : {count:0}).toMatchObject({count:0});}finally {db.close();}
  } finally {writeFileSync(join(f.server.info.dataDir,"release-probe"),"1");await f.server.close();}
},90_000);
