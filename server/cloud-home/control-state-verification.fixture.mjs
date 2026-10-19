// SPDX-License-Identifier: AGPL-3.0-or-later
// Imported only by an isolated verification preload; no production authority switch.
import { registerHooks } from "node:module";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
/** signingKeyPem: the control plane's P-256 signing key for this fixture, when a test must sign CP proofs itself (a pair-hold proof). */
export function installVerificationControl(publicOrigin, signingKeyPem) {
  const root=process.env.MURAGE_DATA_DIR,start=Date.now(),bootId="11111111-1111-1111-1111-111111111111";
  const key=signingKeyPem?(()=>{const privateKey=createPrivateKey(signingKeyPem);return {privateKey,publicKey:createPublicKey(privateKey)};})():generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  const offset=()=>existsSync(join(root,"control-clock-offset"))?Number(readFileSync(join(root,"control-clock-offset"),"utf8")):0;
  const clock=()=>{const delta=Date.now()-start+offset();return {wallMs:start+delta,bootMs:1000+delta,monoMs:1000+delta,bootId,ntpSynced:true};};
  let renewal="",snapshot;
  const readSnapshot=()=>{
    if(existsSync(join(root,"control-no-authority")))throw new Error("Fixture has no authority");
    const next=existsSync(join(root,"control-renew"))?readFileSync(join(root,"control-renew"),"utf8"):"initial";
    if(next!==renewal){
      renewal=next;const now=clock(),payload=Buffer.from(JSON.stringify({type:"murage-home-key-v1",homeId:"fixture-home",generation:1,homeKey:"fixture-public-home-key",publicOrigin,issuedAt:Math.floor(now.wallMs),expiresAt:Math.floor(now.wallMs)+3600000})).toString("base64url");
      snapshot={version:1,homeId:"fixture-home",cpGeneration:1,requestId:"fixture-"+next,bootId,requestSend:{wallMs:now.wallMs,bootMs:now.bootMs,monoMs:now.monoMs},conservativeDeadlineBootMs:now.bootMs+3480000,receivedAt:now.wallMs,desired:{wire:1,homeId:"fixture-home",generation:1,desiredState:"ready",engineSubscriptionGates:{claudeAgent:false,codex:false,grokAgent:false,kimiAgent:false,opencodeGo:false},lease:{holder:"fixture-home",generation:1,expiresAt:Math.floor(now.wallMs)+3600000},executionAllowed:true,heartbeatFresh:true,heartbeatEveryMs:60000,homeKey:{algorithm:"ES256",payload,signature:sign("sha256",Buffer.from(payload),{key:key.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url")}}};
    }
    return snapshot;
  };
  globalThis.__murageVerificationControlInputs={binding:{homeId:"fixture-home",generation:1,publicOrigin},publicJwk:key.publicKey.export({format:"jwk"}),readSnapshot,readClock:clock};
  registerHooks({load(url,context,nextLoad){
    const loaded=nextLoad(url,context);
    if(!url.endsWith("/server/index.ts"))return loaded;
    const source=typeof loaded.source==="string"?loaded.source:Buffer.from(loaded.source).toString("utf8"),needle="...readHomeControlInputs(),";
    // The control consumer and the CP-proof verifier (controlPlaneBinding) both read the home's control inputs here.
    if(source.split(needle).length!==3)throw new Error("Verification consumer construction seam changed");
    return {...loaded,source:source.replaceAll(needle,"...globalThis.__murageVerificationControlInputs,")};
  }});
}
