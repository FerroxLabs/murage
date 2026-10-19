// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, request } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CloudSessions } from "../cloud-sessions.ts";
import { createCloudRequestAuth } from "../cloud-request-auth.ts";
const origin="https://home.example",secret="fake-bootstrap-secret-for-b1b-tests"; // secret-scan: fixture
describe("real home request auth recovery and lifecycle routes",()=>{
  it("requires HMAC and operation binding, holds recovery for 72h, accepts paired cancel and awaits cleanup",async()=>{
    let now=1_800_000_000_000,cleaned=0,notices=0;const actions:string[]=[];
    const db=new DatabaseSync(":memory:"),sessions=new CloudSessions(db,()=>now,origin);
    const key=generateKeyPairSync("ed25519"),factor=generateKeyPairSync("ed25519"),input={account:"owner",scope:"owner-desktop" as const,publicKey:key.publicKey.export({type:"spki",format:"pem"}).toString(),assertionKey:factor.publicKey.export({type:"spki",format:"pem"}).toString()};
    const oldCode=sessions.mint(input),msg=Buffer.from(`murage-pair:${sessions.environmentId}:${oldCode}:owner`),old=sessions.redeem(oldCode,"owner",sign(null,msg,key.privateKey).toString("base64url"),sign(null,msg,factor.privateKey).toString("base64url"));
    const auth=createCloudRequestAuth({sessions,publicOrigin:origin,bootstrapSecret:()=>secret,lifecycle:async action=>{actions.push(action);},recoveryNotice:async()=>{notices++;},recoveryCleanup:async()=>{cleaned++;},
      // Stands in for the CP-signed proof check (b1b-identity verifiedRecoveryHold); a missing proof is refused.
      recoveryProof:proof=>{const holdId=(proof as {holdId?:unknown}|undefined)?.holdId;if(typeof holdId!=="string")throw new Error("no proof");return {holdId};}});
    const server=createServer(async(req,res)=>{if(await auth(req,res,new URL(req.url!,origin)))return;res.writeHead(200,{"content-type":"application/json"});res.end("{}");});server.listen(0,"127.0.0.1");await once(server,"listening");
    const call=(path:string,body:unknown,token?:string,hmac=true)=>new Promise<{status:number;body:any}>((resolve,reject)=>{
      const raw=Buffer.from(JSON.stringify(body)),req=request({host:"127.0.0.1",port:(server.address() as AddressInfo).port,path,method:"POST",headers:{host:"home.example",origin,"content-length":String(raw.length),...(token?{authorization:`Bearer ${token}`} : {}),...(hmac?{"x-murage-signature":createHmac("sha256",secret).update(raw).digest("hex")} : {})}},res=>{const chunks:Buffer[]=[];res.on("data",c=>chunks.push(c));res.on("end",()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())}));});req.on("error",reject);req.end(raw);
    });
    const signed=(path:string,extra:object={})=>({operation:path,timestamp:now/1000,nonce:randomUUID(),...extra});
    try {
      const pairing="/api/cloud/pairing";
      expect((await call(pairing,signed(pairing,input))).status).toBe(403); // Email/HMAC alone cannot add to an existing home.
      const hold="/api/cloud/recovery/hold",id="recovery-fixture-auth1";
      expect((await call(hold,signed(hold,{recoveryId:id,account:"owner"}),undefined,false)).status).toBe(403);
      expect((await call(hold,signed(hold,{recoveryId:id,account:"owner"}))).status).toBe(200);expect(notices).toBe(1);
      expect((await call(pairing,signed(pairing,{...input,recovery:true,recoveryId:id}))).status).toBe(403);expect(cleaned).toBe(0);
      expect((await call("/api/cloud/recovery/cancel",{recoveryId:id},old.accessToken,false)).status).toBe(200);
      now+=72*60*60*1000;expect((await call(pairing,signed(pairing,{...input,recovery:true,recoveryId:id}))).status).toBe(403);
      const next="recovery-fixture-auth2";expect((await call(hold,signed(hold,{recoveryId:next,account:"owner"}))).status).toBe(200);now+=72*60*60*1000;
      const recovered=await call(pairing,signed(pairing,{...input,recovery:true,recoveryId:next,recoveryProof:{holdId:next}}));expect(recovered.status).toBe(200);expect(cleaned).toBe(1);
      const message=Buffer.from(`murage-pair:${sessions.environmentId}:${recovered.body.code}:owner`);
      expect((await call("/api/cloud/pair",{account:"owner",code:recovered.body.code,signature:sign(null,message,key.privateKey).toString("base64url"),assertionSignature:sign(null,message,factor.privateKey).toString("base64url")},undefined,false)).status).toBe(200);expect(sessions.device(old.deviceId)).toBeUndefined();
      for(const path of ["/api/cloud/stop","/api/cloud/drain","/api/cloud/revoke-sessions","/api/cloud/account/resume"]) {
        expect((await call(path,signed("/different"))).status).toBe(403);
        const body=signed(path);expect((await call(path,body)).status).toBe(200);expect((await call(path,body)).status).toBe(403);
      }
      expect(actions).toEqual(["stop","drain","revoke-sessions","resume"]);
    } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();}
  });
});
