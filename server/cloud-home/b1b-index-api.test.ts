// SPDX-License-Identifier: AGPL-3.0-or-later
import { request } from "node:http";
import { createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { describe, expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-murage.ts";
import { HomeExecutionGate } from "./b1b-execution.ts";
import { stepPurpose } from "../cloud-request-auth.ts";
const origin="https://home.example.test",secret="fixture-b1b-index-bootstrap-secret"; // secret-scan: fixture
describe("B1b actual server lifecycle admission",()=>{
  it("keeps an unconfigured home identity and all execution admission closed",async()=>{
    const fixture=await launchVerificationServer({},undefined,{cloud:{publicOrigin:origin,bootstrapSecret:secret},readyTimeoutMs:60_000});
    try{
      const identity=await fetch(fixture.info.url+"/.well-known/murage/environment",{headers:{host:"home.example.test",origin}});
      expect(identity.status).toBe(503);expect((await identity.json() as {homeKey?:unknown}).homeKey).toBeUndefined();
      const db=new DatabaseSync(join(fixture.info.dataDir,"messages.db"),{readOnly:true});try{const gate=new HomeExecutionGate(db);expect(gate.open()).toBe(false);expect(gate.leaseHeld()).toBe(true);expect(gate.explicitHeld()).toBe(false);}finally{db.close();}
    }finally{await fixture.close();}
  },90_000);
  it("keeps local mode inert without constructing home security or persisted admission tables",async()=>{
    const fixture=await launchVerificationServer({},undefined,{readyTimeoutMs:60_000});
    try {
      const health=await fetch(fixture.info.url+"/api/health");expect(health.status).toBe(200);expect((await health.json() as {role?:string}).role).toBeUndefined();
      const db=new DatabaseSync(join(fixture.info.dataDir,"messages.db"),{readOnly:true});try {expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cloud_meta'").get()).toBeUndefined();}finally {db.close();}
    } finally {await fixture.close();}
  },90_000);
  it("stops real admission, persists the hold, resumes timers and refuses unavailable CP recovery",async()=>{
    const instrumentationSource="const path=await import('node:path'),url=await import('node:url');const fixture=await import(url.pathToFileURL(path.join(process.cwd(),'server/cloud-home/control-state-verification.fixture.mjs')).href);fixture.installVerificationControl("+JSON.stringify(origin)+");";
    const fixture=await launchVerificationServer({},undefined,{cloud:{publicOrigin:origin,bootstrapSecret:secret},instrumentationSource,readyTimeoutMs:60_000});
    const api=(method:string,path:string,body?:unknown,token?:string,headers:Record<string,string>={})=>new Promise<{status:number;body:any}>((resolve,reject)=>{
      const raw=body===undefined?undefined:Buffer.from(JSON.stringify(body)),req=request(fixture.info.url+path,{method,headers:{host:"home.example.test",origin,"content-type":"application/json",...(raw?{"content-length":String(raw.length)}:{}),...(token?{authorization:`Bearer ${token}`} : {}),...headers}},res=>{const chunks:Buffer[]=[];res.on("data",chunk=>chunks.push(chunk));res.on("end",()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())}));});req.on("error",reject);req.end(raw);
    });
    const control=(path:string,extra:object={})=>{const body={operation:path,timestamp:Date.now()/1000,nonce:randomUUID(),...extra};return api("POST",path,body,undefined,{"x-murage-signature":createHmac("sha256",secret).update(JSON.stringify(body)).digest("hex")});};
    try {
      const identity=await api("GET","/.well-known/murage/environment");expect(identity.status).toBe(200);expect(identity.body.homeKey.algorithm).toBe("ES256");
      const key=generateKeyPairSync("ed25519"),factor=generateKeyPairSync("ed25519"),minted=await control("/api/cloud/pairing",{account:"owner",scope:"owner-desktop",publicKey:key.publicKey.export({type:"spki",format:"pem"}).toString(),assertionKey:factor.publicKey.export({type:"spki",format:"pem"}).toString()});expect(minted.status).toBe(200);
      const msg=Buffer.from(`murage-pair:${identity.body.environmentId}:${minted.body.code}:owner`),paired=await api("POST","/api/cloud/pair",{account:"owner",code:minted.body.code,signature:sign(null,msg,key.privateKey).toString("base64url"),assertionSignature:sign(null,msg,factor.privateKey).toString("base64url")});expect(paired.status).toBe(200);
      const token=paired.body.accessToken,bot=await api("POST","/api/bots",{name:"Stop fixture"},token);expect(bot.status).toBe(201);
      // Existing ZIP intake protocol: a bounded uncompressed manifest.json
      // first, no payloads, and a valid package definition plus the grant.
      const manifest={format:"murage.package.bundle",version:1,definition:{format:"murage.package",version:1,package:{id:"sample",release:"1.0.0",name:"Sample",tagline:"Sample team",summary:"Definition only",category:"Community",author:{name:"Example"},license:"MIT",outcomes:["Research"],setupMinutes:2,requirements:{apps:[],capabilities:[]},agents:[{key:"scout",name:"Scout",appearance:{color:"green"},alwaysAllow:["Bash(*)"]}]}},skills:[],instructions:[],entries:[]};
      const archivePath=join(fixture.info.dataDir,"grant-fixture.zip"),zip=new ZipFile(),written=pipeline(zip.outputStream as Readable,createWriteStream(archivePath));zip.addBuffer(Buffer.from(JSON.stringify(manifest)),"manifest.json",{compress:false,mode:0o100600});zip.end();await written;
      const importPath="/api/packages/import",importBody={action:"options",archivePath},purpose=stepPurpose("POST",importPath,importBody),challenge=await api("POST","/api/cloud/challenge",{deviceId:paired.body.deviceId,purpose},token),at=Date.now();
      const assertion=Buffer.from(JSON.stringify({challenge:challenge.body.challenge,at,signature:sign(null,Buffer.from(`murage:${identity.body.environmentId}:${paired.body.deviceId}:${purpose}:${challenge.body.challenge}:${at}`),factor.privateKey).toString("base64url")})).toString("base64url");
      expect((await api("POST",importPath,importBody,token,{"x-murage-step-up":assertion})).status).toBe(403);
      expect((await api("POST","/api/cloud/stop",{})).status).toBe(403);
      expect((await control("/api/cloud/stop")).status).toBe(200);
      const db=new DatabaseSync(join(fixture.info.dataDir,"messages.db"),{readOnly:true});try {expect(new HomeExecutionGate(db).open()).toBe(false);}finally {db.close();}
      expect((await api("GET","/api/automation-admission",undefined,token)).body.paused).toBe(true);
      expect((await api("POST",`/api/bots/${bot.body.bot.id}/messages`,{text:"This must not start an engine"},token)).status).toBe(403);
      expect((await api("POST","/api/internal/agents",{})).status).toBe(403);
      expect((await api("GET","/api/health")).status).toBe(200);
      expect((await control("/api/cloud/account/resume")).status).toBe(200);
      expect((await api("GET","/api/automation-admission",undefined,token)).body.paused).toBe(false);
      expect((await control("/api/cloud/recovery/hold",{account:"owner",recoveryId:"fixture-recovery-index1"})).status).toBe(503);
      expect((await control("/api/cloud/drain")).status).toBe(200);
      expect((await control("/api/cloud/revoke-sessions")).status).toBe(200);
      expect((await api("GET","/api/bots",undefined,token)).status).toBe(403);
    } finally {await fixture.close();}
  },90_000);
});
