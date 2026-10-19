import { generateKeyPairSync, sign, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CloudSessions, pairingSourceKey, type CloudScope } from "./cloud-sessions.ts";
import { cloudRouteDecision } from "./route-policy.ts";
const databases: DatabaseSync[]=[];
afterEach(()=>databases.splice(0).forEach(db=>db.close()));
function fixture() {
  const db=new DatabaseSync(":memory:");databases.push(db);let time=1_800_000_000_000;
  const sessions=new CloudSessions(db,()=>time);
  const key=generateKeyPairSync("ed25519"),factor=generateKeyPairSync("ed25519");
  const input={account:"owner",scope:"owner-desktop" as CloudScope, publicKey:key.publicKey.export({type:"spki",format:"pem"}).toString(),assertionKey:factor.publicKey.export({type:"spki",format:"pem"}).toString()};
  const signature=(message:string,f=false)=>sign(null,Buffer.from(message),f?factor.privateKey:key.privateKey).toString("base64url");
  const pair=()=>{const code=sessions.mint(input),message=`murage-pair:${sessions.environmentId}:${code}:owner`;return sessions.redeem(code,"owner",signature(message),signature(message,true));};
  return {db,sessions,input,signature,pair,now:()=>time,advance:(n:number)=>{time+=n;}};
}
describe("cloud sessions",()=>{
  it("recovery requires a full persisted hold, awaited cleanup and can be cancelled",async()=>{
    const f=fixture(),old=f.pair(),id="recovery-fixture-0001";f.sessions.startRecovery(id,"owner");
    let cleanups=0;
    await expect(f.sessions.prepareRecovery(id,"owner",async()=>{cleanups++;})).rejects.toThrow("hold");expect(cleanups).toBe(0);
    f.advance(72*60*60*1000);
    await expect(f.sessions.prepareRecovery(id,"owner",async()=>{throw new Error("wipe failed");})).rejects.toThrow("wipe failed");
    expect(()=>f.sessions.mint({...f.input,recovery:true,recoveryId:id})).toThrow("hold");
    await f.sessions.prepareRecovery(id,"owner",async()=>{cleanups++;});
    const code=f.sessions.mint({...f.input,recovery:true,recoveryId:id}),msg=`murage-pair:${f.sessions.environmentId}:${code}:owner`;
    const recovered=f.sessions.redeem(code,"owner",f.signature(msg),f.signature(msg,true));expect(recovered.deviceId).not.toBe(old.deviceId);expect(f.sessions.device(old.deviceId)).toBeUndefined();
    const next="recovery-fixture-0002";f.sessions.startRecovery(next,"owner");f.advance(72*60*60*1000);await f.sessions.prepareRecovery(next,"owner",async()=>{});
    const cancelled=f.sessions.mint({...f.input,recovery:true,recoveryId:next});f.sessions.cancelRecovery(next);
    expect(()=>f.sessions.redeem(cancelled,"owner",f.signature(`murage-pair:${f.sessions.environmentId}:${cancelled}:owner`),f.signature(`murage-pair:${f.sessions.environmentId}:${cancelled}:owner`,true))).toThrow();
  });
  it("resume does not resurrect suspended access tokens or outstanding challenges",()=>{
    const f=fixture(),d=f.pair(),challenge=f.sessions.challenge(d.deviceId);f.sessions.revokeAccount();f.sessions.resumeAccount();expect(f.sessions.resolve(d.accessToken)).toBeUndefined();
    expect(()=>f.sessions.refresh(d.deviceId,challenge,f.now(),f.signature(`murage:${f.sessions.environmentId}:${d.deviceId}:refresh:${challenge}:${f.now()}`))).toThrow();
    expect(f.sessions.device(d.deviceId)).toBeDefined();
  });
  it("persists a stable environment and refuses another account",()=>{const f=fixture();f.pair();expect(new CloudSessions(f.db).environmentId).toBe(f.sessions.environmentId);expect(()=>f.sessions.mint({...f.input,account:"other"})).toThrow("Account refused");});
  it("codes are twelve characters, expire in ten minutes and cannot replay",()=>{const f=fixture(),code=f.sessions.mint(f.input),msg=`murage-pair:${f.sessions.environmentId}:${code}:owner`;expect(code).toHaveLength(12);f.sessions.redeem(code,"owner",f.signature(msg),f.signature(msg,true));expect(()=>f.sessions.redeem(code,"owner",f.signature(msg),f.signature(msg,true))).toThrow();const expired=f.sessions.mint(f.input);f.advance(600_000);expect(()=>f.sessions.redeem(expired,"owner","","")).toThrow();});
  it("fifty junk codes from one source do not block a correct code from another",()=>{
    const f=fixture(),code=f.sessions.mint(f.input),msg=`murage-pair:${f.sessions.environmentId}:${code}:owner`;
    for(let i=0;i<50;i++)expect(()=>f.sessions.redeem(`wrong-${i}`,"owner","","","203.0.113.1")).toThrow();
    expect(f.sessions.redeem(code,"owner",f.signature(msg),f.signature(msg,true),"203.0.113.2").scope).toBe("owner-desktop");
  });
  it("five bad signatures lock that code only across sources",()=>{
    const f=fixture(),locked=f.sessions.mint(f.input),other=f.sessions.mint(f.input);
    for(let i=0;i<5;i++)expect(()=>f.sessions.redeem(locked,"owner","","",`203.0.113.${i+1}`)).toThrow();
    const lockedMsg=`murage-pair:${f.sessions.environmentId}:${locked}:owner`;
    expect(()=>f.sessions.redeem(locked,"owner",f.signature(lockedMsg),f.signature(lockedMsg,true),"203.0.113.20")).toThrow("locked");
    const otherMsg=`murage-pair:${f.sessions.environmentId}:${other}:owner`;
    expect(f.sessions.redeem(other,"owner",f.signature(otherMsg),f.signature(otherMsg,true),"203.0.113.20").deviceId).toBeTruthy();
  });
  it("IPv6 privacy addresses share only their source /64 and its lock expires",()=>{
    const f=fixture(),code=f.sessions.mint(f.input),msg=`murage-pair:${f.sessions.environmentId}:${code}:owner`;
    expect(pairingSourceKey("2001:db8::1")).toBe(pairingSourceKey("2001:db8::ffff"));
    expect(pairingSourceKey("2001:db8::1")).not.toBe(pairingSourceKey("2001:db8:1::1"));
    for(let i=0;i<5;i++)expect(()=>f.sessions.redeem(`junk-${i}`,"owner","","","2001:db8::1")).toThrow();
    expect(()=>f.sessions.redeem("junk-shared","owner","","","2001:db8::ffff")).toThrow("locked");
    expect(()=>f.sessions.redeem("junk-other","owner","","","2001:db8:1::1")).toThrow("refused");
    expect(f.sessions.redeem(code,"owner",f.signature(msg),f.signature(msg,true),"2001:db8::ffff").deviceId).toBeTruthy();
    f.advance(600_001); const next=f.sessions.mint(f.input),nextMsg=`murage-pair:${f.sessions.environmentId}:${next}:owner`;
    expect(f.sessions.redeem(next,"owner",f.signature(nextMsg),f.signature(nextMsg,true),"2001:db8::ffff").deviceId).toBeTruthy();
  });
  const codeFor=(f:ReturnType<typeof fixture>)=>{const code=f.sessions.mint(f.input),msg=`murage-pair:${f.sessions.environmentId}:${code}:owner`;return {code,sig:f.signature(msg),factor:f.signature(msg,true)};};
  const failures=(f:ReturnType<typeof fixture>,source:string)=>(f.db.prepare("SELECT failures FROM cloud_source_limits WHERE source=?").get(pairingSourceKey(source)) as {failures:number}|undefined)?.failures ?? 0;
  it("five bad attempts from one source, then the owner's valid code from that source still pairs",()=>{
    const f=fixture();
    for(let i=0;i<5;i++)expect(()=>f.sessions.redeem(`wrongcode00${i}`,"owner","a","a","203.0.113.9")).toThrow("refused");
    expect(()=>f.sessions.redeem("wrongcode009","owner","a","a","203.0.113.9")).toThrow("locked");
    const c=codeFor(f);
    expect(f.sessions.redeem(c.code,"owner",c.sig,c.factor,"203.0.113.9").scope).toBe("owner-desktop");
  });
  it("bad pairing attempts from a locked source stay locked, all with the same word, and each one counts",()=>{
    const f=fixture(),live=codeFor(f),src="203.0.113.9";
    for(let i=0;i<5;i++)expect(()=>f.sessions.redeem(`junk-${i}`,"owner","","",src)).toThrow();
    const attempts:[string,string,string,string][]=[["junk","owner","",""],["wrongcode000","owner","a","a"],[live.code,"owner",live.factor,live.factor],[live.code,"other",live.sig,live.factor],[live.code,"owner",live.sig,live.sig]];
    for(const a of attempts)expect(()=>f.sessions.redeem(...a,src)).toThrow("Pairing locked. Try again later.");
    expect(failures(f,src)).toBe(5+attempts.length);
    // The live code itself survives (three bad signatures against it, under its own five-failure lock) and still pairs.
    expect(f.sessions.redeem(live.code,"owner",live.sig,live.factor,src).deviceId).toBeTruthy();
  });
  it("a flood from locked sources is held to the home-wide cap on pairing verifications, and the cap reopens",()=>{
    const f=fixture();
    for(const src of ["203.0.113.9","203.0.113.11"])for(let i=0;i<5;i++)expect(()=>f.sessions.redeem(`junk-${i}`,"owner","","",src)).toThrow();
    for(let i=0;i<300;i++)expect(()=>f.sessions.redeem(`flood${String(i).padStart(7,"0")}`,"owner","a","a",i%2?"203.0.113.9":"203.0.113.11")).toThrow("locked");
    const held=codeFor(f);
    expect(()=>f.sessions.redeem(held.code,"owner",held.sig,held.factor,"203.0.113.9")).toThrow("locked");
    const open=codeFor(f);
    expect(f.sessions.redeem(open.code,"owner",open.sig,open.factor,"203.0.113.60").deviceId).toBeTruthy();
    f.advance(61_000);
    const later=codeFor(f);
    expect(f.sessions.redeem(later.code,"owner",later.sig,later.factor,"203.0.113.9").deviceId).toBeTruthy();
  });
  it("requires the enrolled second factor at pairing",()=>{const f=fixture(),code=f.sessions.mint(f.input),msg=`murage-pair:${f.sessions.environmentId}:${code}:owner`;expect(()=>f.sessions.redeem(code,"owner",f.signature(msg),"")).toThrow();});
  it("access expires at fifteen minutes and refresh requires a one-time device signature",()=>{const f=fixture(),session=f.pair(),challenge=f.sessions.challenge(session.deviceId),at=f.now(),msg=`murage:${f.sessions.environmentId}:${session.deviceId}:refresh:${challenge}:${at}`;expect(()=>f.sessions.refresh(session.deviceId,challenge,at,f.signature(msg,true))).toThrow();expect(f.sessions.refresh(session.deviceId,challenge,at,f.signature(msg)).accessToken).toBeTruthy();expect(()=>f.sessions.refresh(session.deviceId,challenge,at,f.signature(msg))).toThrow();f.advance(900_000);expect(f.sessions.resolve(session.accessToken)).toBeUndefined();});
  it.each(["device","account"])("%s revocation immediately kills access and refresh",kind=>{const f=fixture(),s=f.pair(),c=f.sessions.challenge(s.deviceId),at=f.now();if(kind==="device")f.sessions.revoke(s.deviceId);else f.sessions.revokeAccount();f.advance(59_000);expect(f.sessions.resolve(s.accessToken)).toBeUndefined();expect(()=>f.sessions.refresh(s.deviceId,c,at,f.signature(`murage:${f.sessions.environmentId}:${s.deviceId}:refresh:${c}:${at}`))).toThrow();});
  it("step-up uses the separate factor, is bound to the operation and expires after five minutes",()=>{const f=fixture(),s=f.pair(),purpose="step:delete",c=f.sessions.challenge(s.deviceId,purpose),at=f.now(),msg=`murage:${f.sessions.environmentId}:${s.deviceId}:${purpose}:${c}:${at}`;expect(f.sessions.consumeAssertion(s.deviceId,c,purpose,at,f.signature(msg))).toBe(false);expect(f.sessions.consumeAssertion(s.deviceId,c,purpose,at,f.signature(msg,true))).toBe(true);expect(f.sessions.consumeAssertion(s.deviceId,c,purpose,at,f.signature(msg,true))).toBe(false);const c2=f.sessions.challenge(s.deviceId,purpose);f.advance(300_001);expect(f.sessions.consumeAssertion(s.deviceId,c2,purpose,at,f.signature(msg,true))).toBe(false);});
  it("bootstrap refuses bad signatures, stale requests and nonce replay",()=>{const f=fixture(),secret="test-bootstrap-key-not-a-real-key";const raw=Buffer.from(JSON.stringify({...f.input,timestamp:f.now()/1000,nonce:"1234567890123456"})),sig=createHmac("sha256",secret).update(raw).digest("hex");expect(()=>f.sessions.verifyBootstrap(raw,"0".repeat(64),secret)).toThrow();expect(f.sessions.verifyBootstrap(raw,sig,secret).account).toBe("owner");expect(()=>f.sessions.verifyBootstrap(raw,sig,secret)).toThrow();f.advance(301_000);expect(()=>f.sessions.verifyBootstrap(raw,sig,secret)).toThrow();}); // secret-scan: fixture
  it("route policy grants owner network authority and limits phone, browser and service",()=>{for(const path of ["/api/decisions","/api/team-map","/api/setup/status"])expect(cloudRouteDecision("GET",path,"owner-desktop",{})).toBe("allow");for(const scope of ["owner-phone","browser","service"] as const)expect(cloudRouteDecision("POST","/api/provider-connections",scope,{},true)).toBe("deny");expect(cloudRouteDecision("PATCH","/api/bots/a","owner-desktop",{fullAccess:true})).toBe("step-up required");expect(cloudRouteDecision("PATCH","/api/bots/a","owner-phone",{noLimits:true},true)).toBe("deny");expect(cloudRouteDecision("GET","/api/inbox","browser",{})).toBe("allow");expect(cloudRouteDecision("GET","/api/config","browser",{})).toBe("allow");expect(cloudRouteDecision("GET","/api/decisions","service",{})).toBe("deny");});
});
