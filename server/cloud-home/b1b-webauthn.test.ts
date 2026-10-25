// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CloudSessions } from "../cloud-sessions.ts";
import { verifyBrowserAssertion, type BrowserFactor } from "./b1b-webauthn.ts";
const origin="https://home.example", factor:BrowserFactor={origin,rpId:"home.example",credentialId:"fixture-credential",counter:0};
const keys=()=>generateKeyPairSync("ec",{namedCurve:"prime256v1"});
const pem=(key:ReturnType<typeof keys>)=>key.publicKey.export({format:"pem",type:"spki"}).toString();
function assertion(key:ReturnType<typeof keys>, message:string, overrides:Record<string,unknown>={}, flags=5, counter=1) {
  const client=Buffer.from(JSON.stringify({type:"webauthn.get",origin,crossOrigin:false,challenge:Buffer.from(message).toString("base64url"),...overrides}));
  const auth=Buffer.alloc(37);createHash("sha256").update("home.example").digest().copy(auth);auth[32]=flags;auth.writeUInt32BE(counter,33);
  return {credentialId:factor.credentialId,clientDataJSON:client.toString("base64url"),authenticatorData:auth.toString("base64url"),signature:sign("sha256",Buffer.concat([auth,createHash("sha256").update(client).digest()]),key.privateKey).toString("base64url")};
}
describe("browser WebAuthn and P256 sessions",()=>{
  it("verifies authenticatorData plus clientData hash and requires presence and verification",()=>{
    const key=keys();expect(verifyBrowserAssertion(pem(key),factor,"operation",assertion(key,"operation"))).toBe(1);
    for(const overrides of [{origin:"https://attacker.example"},{crossOrigin:true},{type:"webauthn.create"},{challenge:"wrong"}])expect(verifyBrowserAssertion(pem(key),factor,"operation",assertion(key,"operation",overrides))).toBeUndefined();
    for(const flags of [0,1,4])expect(verifyBrowserAssertion(pem(key),factor,"operation",assertion(key,"operation",{},flags))).toBeUndefined();
    expect(verifyBrowserAssertion(pem(key),{...factor,counter:1},"operation",assertion(key,"operation"))).toBeUndefined();
  });
  it("with a stored browser factor, refreshes P256 and consumes bound WebAuthn once",()=>{
    const db=new DatabaseSync(":memory:"),now=1_800_000_000_000,sessions=new CloudSessions(db,()=>now,origin),key=keys(),confirm=keys();
    try {
      // mint() no longer enrolls browsers (the door does, with no factor row), so a browser that has a factor is written as an older home stored it.
      sessions.db.prepare("INSERT INTO cloud_meta VALUES ('account','owner')").run();
      sessions.db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES ('dev-1','owner','browser',?,?,0,0,0)").run(pem(key),pem(confirm));
      sessions.db.prepare("INSERT INTO cloud_browser_factors (device,payload) VALUES ('dev-1',?)").run(JSON.stringify({...factor,counter:1}));
      const paired={deviceId:"dev-1"};
      const refresh=sessions.challenge(paired.deviceId),refreshMessage=`murage:${sessions.environmentId}:${paired.deviceId}:refresh:${refresh}:${now}`;
      const sig=sign("sha256",Buffer.from(refreshMessage),{key:key.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url");
      expect(sessions.refresh(paired.deviceId,refresh,now,sig).scope).toBe("browser");expect(()=>sessions.refresh(paired.deviceId,refresh,now,sig)).toThrow();
      const purpose="step:POST:/api/routines/r/run:fixture-bodyhash",challenge=sessions.challenge(paired.deviceId,purpose),message=`murage:${sessions.environmentId}:${paired.deviceId}:${purpose}:${challenge}:${now}`,web=JSON.stringify(assertion(confirm,message,{},5,2));
      expect(sessions.consumeAssertion(paired.deviceId,challenge,purpose+"wrong",now,web)).toBe(false);
      expect(sessions.consumeAssertion(paired.deviceId,challenge,purpose,now,web)).toBe(true);expect(sessions.consumeAssertion(paired.deviceId,challenge,purpose,now,web)).toBe(false);
    } finally {db.close();}
  });
});
