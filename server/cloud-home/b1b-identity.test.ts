// SPDX-License-Identifier: AGPL-3.0-or-later
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifiedHomeIdentity, verifiedRecoveryHold, type SignedHomeKey } from "./b1b-identity.ts";
describe("CP ES256 home and recovery identity",()=>{
  it("matches the actual CP signed envelope and independently pins home/generation/origin/lifetime",()=>{
    const key=generateKeyPairSync("ec",{namedCurve:"prime256v1"}),origin="https://home.example",publicJwk=key.publicKey.export({format:"jwk"});
    const envelope=(claims:object):SignedHomeKey=>{const payload=Buffer.from(JSON.stringify(claims)).toString("base64url");return {algorithm:"ES256",payload,signature:sign("sha256",Buffer.from(payload),{key:key.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url")};};
    const claims={type:"murage-home-key-v1",homeId:"home",generation:7,publicOrigin:origin,homeKey:"fixture-public-home-key",issuedAt:1000,expiresAt:2000},input=envelope(claims);
    expect(verifiedHomeIdentity(input,publicJwk,"home",7,origin,1000)).toEqual({homeKey:input});
    for(const [home,gen,url,now] of [["other",7,origin,1000],["home",8,origin,1000],["home",7,"https://other.example",1000],["home",7,origin,2000]] as const)expect(()=>verifiedHomeIdentity(input,publicJwk,home,gen,url,now)).toThrow();
    expect(()=>verifiedHomeIdentity(envelope({...claims,extra:true}),publicJwk,"home",7,origin,1000)).toThrow();
    expect(()=>verifiedHomeIdentity(envelope({...claims,expiresAt:3_601_001}),publicJwk,"home",7,origin,1000)).toThrow();
    expect(()=>verifiedHomeIdentity(input,key.privateKey.export({format:"jwk"}),"home",7,origin,1000)).toThrow();
    const proof={type:"murage-recovery-v1",homeId:"home",generation:7,holdId:"fixture-recovery-hold1",action:"pair",holdStartedAt:1000,holdCompletedAt:1000+72*3_600_000,cancelState:"not_canceled",issuedAt:1000+72*3_600_000,expiresAt:1000+72*3_600_000+300_000};
    expect(verifiedRecoveryHold(envelope(proof),publicJwk,"home",7,proof.issuedAt)).toEqual({holdId:proof.holdId});
    for(const changes of [{action:"delete"},{generation:8},{cancelState:"canceled"},{holdCompletedAt:proof.holdCompletedAt-1},{expiresAt:proof.expiresAt+1}])expect(()=>verifiedRecoveryHold(envelope({...proof,...changes}),publicJwk,"home",7,proof.issuedAt)).toThrow();
  });
});
