import { request } from "node:http";
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { pairDeviceDigest, stepPurpose } from "./cloud-request-auth.ts";
import { DatabaseSync } from "node:sqlite";
import type { CloudScope } from "./cloud-sessions.ts";
import { cloudHomeCopy } from "./cloud-home/copy.ts";
const origin="https://home.example.test",secret="fixture-bootstrap-secret-32-characters"; // secret-scan: fixture
// The fixture control plane's signing key, so this test can sign the CP's pair-hold proof (one added device per completed 72-hour hold).
const cpKey=generateKeyPairSync("ec",{namedCurve:"prime256v1"}),cpKeyPem=cpKey.privateKey.export({type:"pkcs8",format:"pem"}).toString();
function pairHoldProof(holdId:string,overrides:Record<string,unknown>={}) {
 const now=Date.now(),payload=Buffer.from(JSON.stringify({type:"murage-recovery-v1",homeId:"fixture-home",generation:1,holdId,action:"pair",holdStartedAt:now-73*3_600_000,holdCompletedAt:now-60_000,cancelState:"not_canceled",issuedAt:now,expiresAt:now+300_000,...overrides})).toString("base64url");
 return {algorithm:"ES256",payload,signature:sign("sha256",Buffer.from(payload),{key:cpKey.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url")};
}
const holdId=()=>"hold-"+randomUUID();
let fixture:VerificationServer,environmentId:string;
const keys=()=>{const key=generateKeyPairSync("ed25519"),factor=generateKeyPairSync("ed25519");return {key,factor};};
type Device=ReturnType<typeof keys> & {deviceId:string;accessToken:string;cookie?:string};
let owner:Device,phone:Device,browser:Device,chatBrowser:Device;
async function api(method:string,path:string,body?:unknown,device?:Device,extra:Record<string,string>={}) {
 const encoded=body===undefined?undefined:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
 return new Promise<{status:number;body:any;cookie:string|null;connection?:string}>((resolve,reject)=>{
  const req=request(fixture.info.url+path,{method,headers:{host:"home.example.test",origin,"content-type":"application/json",...(encoded===undefined?{}:{"content-length":String(encoded.length)}),...(device?.cookie?{cookie:device.cookie}:device?{authorization:`Bearer ${device.accessToken}`} : {}),...extra}},res=>{
   const chunks:Buffer[]=[];res.on("data",c=>chunks.push(c));res.on("end",()=>{try {resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString()),cookie:res.headers["set-cookie"]?.[0] ?? null,connection:res.headers.connection});}catch(error){reject(error);}});
  });req.on("error",reject);req.end(encoded);
 });
}
async function step(device:Device,method:string,path:string,body:unknown) {
 const purpose=stepPurpose(method,path,body),r=await api("POST","/api/cloud/challenge",{deviceId:device.deviceId,purpose},device),at=Date.now();
 expect(r.status).toBe(200);
 const signature=sign(null,Buffer.from(`murage:${environmentId}:${device.deviceId}:${purpose}:${r.body.challenge}:${at}`),device.factor.privateKey).toString("base64url");
 return Buffer.from(JSON.stringify({challenge:r.body.challenge,at,signature})).toString("base64url");
}
async function pair(scope:CloudScope,approver?:Device):Promise<Device> {
 const pairKeys=keys(),hold=holdId(),device={scope,publicKey:pairKeys.key.publicKey.export({type:"spki",format:"pem"}).toString(),assertionKey:pairKeys.factor.publicKey.export({type:"spki",format:"pem"}).toString()};
 const body={account:"fixture-owner",...device,timestamp:Date.now()/1000,nonce:randomUUID(),...(approver?{pairHoldId:hold,pairHoldProof:pairHoldProof(hold,{deviceKeyDigest:pairDeviceDigest(device)})}:{})};
 const headers:Record<string,string>={"x-murage-signature":createHmac("sha256",secret).update(JSON.stringify(body)).digest("hex")};
 if(approver)headers["x-murage-step-up"]=await step(approver,"POST","/api/cloud/pairing",body);
 const minted=await api("POST","/api/cloud/pairing",body,approver,headers);expect(minted.status).toBe(200);
 const message=Buffer.from(`murage-pair:${environmentId}:${minted.body.code}:fixture-owner`);
 const redeemed=await api("POST","/api/cloud/pair",{code:minted.body.code,account:"fixture-owner",signature:sign(null,message,pairKeys.key.privateKey).toString("base64url"),assertionSignature:sign(null,message,pairKeys.factor.privateKey).toString("base64url")});expect(redeemed.status).toBe(200);
 if(scope==="browser") {expect(redeemed.body.accessToken).toBeUndefined();expect(redeemed.cookie).toContain("Secure; HttpOnly; SameSite=Strict");}
 return {...pairKeys,...redeemed.body,cookie:redeemed.cookie?.split(";")[0]};
}
// A browser is enrolled only by the door now: a CP-signed v2 ticket bound to the browser's session key, and a proof by that key.
// `proof:"email"` is the CP-signed claim that this sign-in carried an emailed code: it is what earns the remembered-owner factor. Without it the door enrols a chat-only browser.
async function enterBrowser(codeProof?:"email"):Promise<Device> {
 const key=generateKeyPairSync("ec",{namedCurve:"prime256v1"}),factor=generateKeyPairSync("ec",{namedCurve:"prime256v1"}),now=Date.now();
 const bind=createHash("sha256").update(key.publicKey.export({type:"spki",format:"der"})).digest("hex");
 const payload=Buffer.from(JSON.stringify({type:"murage-door-v2",homeId:"fixture-home",generation:1,publicOrigin:origin,account:"fixture-owner",nonce:randomBytes(16).toString("base64url"),stepUpAt:now-1000,issuedAt:now-500,expiresAt:now+59_000,bind,kind:"browser",...(codeProof?{proof:codeProof}:{})})).toString("base64url");
 const ticket=`${payload}.${sign("sha256",Buffer.from(payload),{key:cpKey.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url")}`;
 const proof=sign("sha256",Buffer.from(`murage-door-v2:${ticket}`),{key:key.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url");
 const assertionProof=sign("sha256",Buffer.from(`murage-door-v2-assertion:${ticket}`),{key:factor.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url");
 const entered=await api("POST","/api/cloud/enter",{ticket,device:{deviceId:null,publicKey:key.publicKey.export({type:"spki",format:"pem"}).toString(),assertionKey:factor.publicKey.export({type:"spki",format:"pem"}).toString(),proof,assertionProof}});
 expect(entered.status).toBe(200);expect(entered.body.accessToken).toBeUndefined();expect(entered.cookie).toContain("Secure; HttpOnly; SameSite=Strict");
 return {key,factor,...entered.body,cookie:entered.cookie?.split(";")[0]} as unknown as Device;
}
beforeAll(async()=>{const instrumentationSource="const path=await import('node:path'),url=await import('node:url');const controlFixture=await import(url.pathToFileURL(path.join(process.cwd(),'server/cloud-home/control-state-verification.fixture.mjs')).href);controlFixture.installVerificationControl("+JSON.stringify(origin)+","+JSON.stringify(cpKeyPem)+");";fixture=await launchVerificationServer({},undefined,{cloud:{publicOrigin:origin,bootstrapSecret:secret},instrumentationSource,readyTimeoutMs:60_000});environmentId=(await api("GET","/.well-known/murage/environment")).body.environmentId;owner=await pair("owner-desktop");phone=await pair("owner-phone",owner);browser=await enterBrowser("email");chatBrowser=await enterBrowser();},90_000);
afterAll(async()=>{await fixture?.close();});
describe("cloud sign-in at the actual HTTP dispatcher",()=>{
 it.each([["PATCH","/api/bots/fixture",{alwaysAllow:[]}],["POST","/api/bots/fixture/always-allow",{allowKey:"Bash(*)"}],["POST","/api/routines/fixture/always-allow",{allowKey:"Bash(*)"}],["POST","/api/teams/import",{team:{members:[{alwaysAllow:["Bash(*)"]}]}}],["POST","/api/packages/import",{action:"commit",agents:[{alwaysAllow:["Bash(*)"]}]}]] as const)("real dispatcher denies home grant writer %s %s",async(method,path,body)=>{
  expect((await api(method,path,body,owner,{"x-murage-step-up":await step(owner,method,path,body)})).status).toBe(403);
 });
 it("owner desktop reaches real administration and write handlers",async()=>{for(const path of ["/api/decisions","/api/team-map","/api/flux-connection"])expect((await api("GET",path,undefined,owner)).status,path).toBe(200);const created=await api("POST","/api/bots",{name:"Cloud fixture"},owner);expect(created.status).toBe(201);expect((await api("PATCH",`/api/bots/${created.body.bot.id}`,{name:"Cloud renamed"},owner)).status).toBe(200);});
 it("a real files skill import reaches its handler only with a fresh body-bound factor",async()=>{
  const path="/api/skills/import",body={kind:"file",files:[{path:"SKILL.md",content:"---\nname: cloud-auth-fixture\ndescription: Synthetic cloud auth verification\n---\n# Fixture\nWrite a greeting."}]};
  expect((await api("POST",path,body,owner)).status).toBe(403);
  const signed={"x-murage-step-up":await step(owner,"POST",path,body)};
  expect((await api("POST",path,body,owner,signed)).status).toBe(201);
  expect((await api("POST",path,body,owner,signed)).status).toBe(403);
 });
 it("an owner-factor browser gets the owner's conversation, companion, Inbox and Settings reads; a bare door browser gets no Inbox; phone and browser cannot write credentials",async()=>{
  for(const path of ["/api/config","/api/bots","/api/inbox","/api/decisions","/api/about-me","/api/house-rules"])expect((await api("GET",path,undefined,browser)).status,path).toBe(200);
  expect((await api("GET","/api/inbox",undefined,phone)).status).toBe(200);
  // No owner factor: the door browser is chat-level and the Inbox stays unavailable, by status and by body.
  expect(await api("GET","/api/inbox",undefined,chatBrowser)).toMatchObject({status:404,body:{error:"Inbox is unavailable."}});
  for(const d of [phone,browser])expect((await api("POST","/api/provider-connections",{},d)).status).toBe(403);
 });
 it("a phone's unsent image upload is shown to the phone but not to a remembered-owner browser",async()=>{
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==","base64");
  const up=await api("POST","/api/attachments",png,phone,{"content-type":"image/png"});expect(up.status).toBe(201);
  const name=String(up.body.path ?? up.body.url ?? "").split("/").pop()!;expect(name).toMatch(/\.png$/);
  const get=(d:Device)=>new Promise<number>((resolve,reject)=>{request(fixture.info.url+`/api/attachments/${name}`,{method:"GET",headers:{host:"home.example.test",origin,...(d.cookie?{cookie:d.cookie}:{authorization:`Bearer ${d.accessToken}`})}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode!));}).on("error",reject).end();});
  expect(await get(phone)).toBe(200);
  expect([403,404]).toContain(await get(browser));
 });
 it("the actual local computer request needs desktop confirmation and is refused to the phone",async()=>{
  const created=await api("POST","/api/bots",{name:"Host authority fixture"},owner);expect(created.status).toBe(201);
  const path=`/api/bots/${created.body.bot.id}`,body={computer:"local"};
  expect((await api("PATCH",path,body,phone)).status).toBe(403);
  expect((await api("PATCH",path,body,phone,{"x-murage-step-up":await step(phone,"PATCH",path,body)})).status).toBe(403);
  expect((await api("PATCH",path,body,owner)).status).toBe(403);
  expect((await api("PATCH",path,body,owner,{"x-murage-step-up":await step(owner,"PATCH",path,body)})).status).toBe(200);
 });
 it("bare loopback and forged desktop headers have service authority only",async()=>{expect(await api("GET","/api/health")).toMatchObject({status:200,body:{role:"home"}});expect((await api("GET","/api/decisions",undefined,undefined,{host:"127.0.0.1","x-murage-surface":"desktop","x-murage-surface-secret":"fake"})).status).toBe(403);expect((await api("GET","/api/desktop-secret",undefined,owner)).status).toBe(403);});
 it("blocks CSRF, DNS rebinding and TCP forwarding spoofing",async()=>{expect((await api("POST","/api/bots",{},owner,{origin:"https://attacker.example"})).status).toBe(403);expect((await api("POST","/api/bots",{},owner,{origin:""})).status).toBe(403);expect((await api("GET","/api/health",undefined,owner,{host:"attacker.example","x-forwarded-host":"home.example.test"})).status).toBe(403);});
 it("a paired device's step-up never skips the 72-hour hold: missing, forged, expired, uncompleted, mismatched or reused hold proofs are refused (Astra SELFSERVICE1 #2)",async()=>{
  type Keys={scope:string;publicKey:string;assertionKey:string};
  const newDevice=():Keys=>{const k=keys();return {scope:"owner-desktop",publicKey:k.key.publicKey.export({type:"spki",format:"pem"}).toString(),assertionKey:k.factor.publicKey.export({type:"spki",format:"pem"}).toString()};};
  const attempt=async(extra:(device:Keys)=>Record<string,unknown>,device=newDevice())=>{const body={account:"fixture-owner",...device,timestamp:Date.now()/1000,nonce:randomUUID(),...extra(device)};
   return api("POST","/api/cloud/pairing",body,owner,{"x-murage-signature":createHmac("sha256",secret).update(JSON.stringify(body)).digest("hex"),"x-murage-step-up":await step(owner,"POST","/api/cloud/pairing",body)});};
  const forged=pairHoldProof("hold-forged-0000000000");forged.signature=Buffer.alloc(64,7).toString("base64url");
  const a=holdId(),b=holdId(),bound=(id:string,o:Record<string,unknown>={})=>(d:Keys)=>({pairHoldId:id,pairHoldProof:pairHoldProof(id,{deviceKeyDigest:pairDeviceDigest(d),...o})});
  for(const [name,extra] of [["none",()=>({})],["id only",()=>({pairHoldId:a})],["forged",()=>({pairHoldId:"hold-forged-0000000000",pairHoldProof:forged})],
   ["expired",bound(a,{expiresAt:Date.now()-1,issuedAt:Date.now()-400_000})],["uncompleted",bound(a,{holdCompletedAt:Date.now()-60_000,holdStartedAt:Date.now()-3_600_000})],
   ["other hold",(d:Keys)=>({pairHoldId:a,pairHoldProof:pairHoldProof(b,{deviceKeyDigest:pairDeviceDigest(d)})})],["delete",bound(a,{action:"delete"})],["generation",bound(a,{generation:2})],
   // Astra SELFSERVICE2 #2: the hold names the device it was spent on; a proof without one, or for another device, adds nothing.
   ["no device",()=>({pairHoldId:a,pairHoldProof:pairHoldProof(a)})],["other device",()=>({pairHoldId:a,pairHoldProof:pairHoldProof(a,{deviceKeyDigest:pairDeviceDigest(newDevice())})})]] as const) {
   const r=await attempt(extra as (d:Keys)=>Record<string,unknown>);expect([name,r.status,r.body.error]).toEqual([name,403,cloudHomeCopy.pairHoldRequired]);
  }
  const first=newDevice();
  expect((await attempt(bound(a),first)).status).toBe(200);
  expect((await attempt(bound(a))).body.error).toBe(cloudHomeCopy.pairHoldRequired); // one device per hold
  // Astra SELFSERVICE2 #2: the home's own ledger is rolled back (a restore of its database). The hold still adds no other device.
  const db=new DatabaseSync(`${fixture.info.dataDir}/messages.db`);
  try { db.exec("PRAGMA busy_timeout=10000"); expect(db.prepare("DELETE FROM cloud_recovery WHERE id=?").run(`pair-${a}`).changes).toBe(1); } finally { db.close(); }
  const other=newDevice();
  expect((await attempt(()=>({pairHoldId:a,pairHoldProof:pairHoldProof(a,{deviceKeyDigest:pairDeviceDigest(first)})}),other)).body.error).toBe(cloudHomeCopy.pairHoldRequired);
 });
 it("a session alone cannot satisfy step-up or add a device",async()=>{expect((await api("PATCH","/api/config",{},owner)).body.error).toBe("step-up required");const k=keys(),body={account:"fixture-owner",scope:"owner-desktop",publicKey:k.key.publicKey.export({type:"spki",format:"pem"}).toString(),assertionKey:k.factor.publicKey.export({type:"spki",format:"pem"}).toString(),timestamp:Date.now()/1000,nonce:randomUUID()};expect((await api("POST","/api/cloud/pairing",body,owner,{"x-murage-signature":createHmac("sha256",secret).update(JSON.stringify(body)).digest("hex")})).body.error).toBe("step-up required");});
 it("sets the routine time zone from owner desktop or phone, rejects browser and invalid zones without step-up",async()=>{
  expect(await api("PUT","/api/owner/timezone",{timeZone:"Europe/London"},owner)).toMatchObject({status:200,body:{timeZone:"Europe/London"}});
  expect(await api("PUT","/api/owner/timezone",{timeZone:"Asia/Bangkok"},phone)).toMatchObject({status:200,body:{timeZone:"Asia/Bangkok"}});
  expect((await api("PUT","/api/owner/timezone",{timeZone:"UTC"},browser)).status).toBe(403);
  expect((await api("PUT","/api/owner/timezone",{timeZone:"fixture/invalid"},owner)).status).toBe(400);
  expect(JSON.parse(readFileSync(`${fixture.info.dataDir}/owner.json`,"utf8")).owner.timeZone).toBe("Asia/Bangkok");
 });
 it("uses the required paired-device and phone credential refusal copy",async()=>{
  expect((await api("GET","/api/decisions")).body.error).toBe(cloudHomeCopy.pairedDeviceRequired);
  expect((await api("POST","/api/provider-connections",{},phone)).body.error).toBe(cloudHomeCopy.phoneCredential);
 });
 it("applies home origin and scope checks to WebSocket upgrades before refusing unsupported routes",async()=>{
  expect(await api("GET","/api/decisions",undefined,undefined,{connection:"Upgrade",upgrade:"websocket"})).toMatchObject({status:403,connection:"close"});
  expect((await api("GET","/api/health",undefined,owner,{connection:"Upgrade",upgrade:"websocket",host:"attacker.example"})).status).toBe(403);
  expect(await api("GET","/api/health",undefined,owner,{connection:"Upgrade",upgrade:"websocket"})).toMatchObject({status:404,body:{error:cloudHomeCopy.unsupportedUpgrade}});
 });
 it("revocation through HTTP invalidates a live session",async()=>{const path=`/api/cloud/devices/${phone.deviceId}`,body={};expect((await api("DELETE",path,body,owner,{"x-murage-step-up":await step(owner,"DELETE",path,body)})).status).toBe(200);expect((await api("GET","/api/decisions",undefined,phone)).status).toBe(403);});
 it("preserves binary upload streams and existing route body limits",async()=>{
  expect((await api("POST","/api/files?name=cloud-note.txt",Buffer.from("Cloud attachment"),owner,{"content-type":"text/plain"})).status).toBe(201);
  expect(await api("PUT","/api/about-me",{text:"x".repeat(70_000)},owner)).toMatchObject({status:400,body:{error:"The request could not be read. Try saving again."}});
 });
 it("does not log tokens or bootstrap secrets",()=>{const log=readFileSync(fixture.info.logPath,"utf8");for(const credential of [secret,owner.accessToken,phone.accessToken,browser.cookie!])expect(log).not.toContain(credential);});
});
