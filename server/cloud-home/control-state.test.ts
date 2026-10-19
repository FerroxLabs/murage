// SPDX-License-Identifier: AGPL-3.0-or-later
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CloudSessions } from "../cloud-sessions.ts";
import { HomeExecutionGate } from "./b1b-execution.ts";
import { createHomeControlConsumer, parseControlSnapshot, readConsistentControlSnapshot, type ControlSnapshot, type LinuxClockHealth } from "./control-state.ts";
const bootId="11111111-1111-1111-1111-111111111111";
function fixture() {
  const key=generateKeyPairSync("ec",{namedCurve:"prime256v1"}),binding={homeId:"home",generation:7,publicOrigin:"https://home.example"};
  let clock:LinuxClockHealth={wallMs:1_000_000,bootMs:1000,monoMs:1000,bootId,ntpSynced:true},snapshot:ControlSnapshot|undefined;
  const renew=(changes:Partial<ControlSnapshot>={})=>{
    const payload=Buffer.from(JSON.stringify({type:"murage-home-key-v1",homeId:"home",generation:7,publicOrigin:binding.publicOrigin,homeKey:"public-fixture-key",issuedAt:clock.wallMs,expiresAt:clock.wallMs+3_600_000})).toString("base64url");
    snapshot={version:1,homeId:"home",cpGeneration:7,requestId:"request-"+clock.bootMs,bootId:clock.bootId,requestSend:{wallMs:clock.wallMs,bootMs:clock.bootMs,monoMs:clock.monoMs},conservativeDeadlineBootMs:clock.bootMs+3_480_000,receivedAt:clock.wallMs,
      desired:{wire:1,homeId:"home",generation:7,desiredState:"ready",engineSubscriptionGates:{claudeAgent:false,codex:false,grokAgent:false,kimiAgent:false,opencodeGo:false},lease:{holder:"home",generation:7,expiresAt:clock.wallMs+3_600_000},executionAllowed:true,heartbeatFresh:true,heartbeatEveryMs:60000,homeKey:{algorithm:"ES256",payload,signature:sign("sha256",Buffer.from(payload),{key:key.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url")}},...changes};return snapshot;
  };
  const advance=(ms:number)=>{clock={...clock,wallMs:clock.wallMs+ms,bootMs:clock.bootMs+ms,monoMs:clock.monoMs+ms};};
  return {binding,publicJwk:key.publicKey.export({format:"jwk"}),readSnapshot:()=>{if(!snapshot)throw new Error("missing");return snapshot;},readClock:()=>clock,
    renew,advance,setClock:(changes:Partial<LinuxClockHealth>)=>{clock={...clock,...changes};},clock:()=>clock,snapshot:()=>snapshot!};
}
const settle=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
describe("root-published home authority",()=>{
  it("matches the published shared snapshot and clock contract, including strict nested keys and bounds",async()=>{
    type Shape={required?:string[];additionalProperties?:boolean;properties?:Record<string,Shape>;const?:unknown;minimum?:number;maximum?:number;anyOf?:Shape[]};
    const shared=JSON.parse(readFileSync(new URL("../../shared/cloud-control-shapes.json",import.meta.url),"utf8")) as {$defs:{controlSnapshot:Shape;linuxClockHealth:Shape}};
    const f=fixture(),parsed=parseControlSnapshot(JSON.stringify(f.renew())),root=shared.$defs.controlSnapshot,desired=root.properties!.desired;
    const objects:[object,Shape][]=[[parsed,root],[parsed.requestSend,root.properties!.requestSend],[parsed.desired,desired],
      [parsed.desired.engineSubscriptionGates,desired.properties!.engineSubscriptionGates],
      [parsed.desired.lease!,desired.properties!.lease.anyOf!.find(s=>s.properties)!],
      [parsed.desired.homeKey,desired.properties!.homeKey],[f.clock(),shared.$defs.linuxClockHealth]];
    for(const [value,shape] of objects){
      expect(shape.additionalProperties).toBe(false);
      expect(Object.keys(value).sort()).toEqual([...shape.required!].sort());
      for(const [name,field] of Object.entries(shape.properties!)){
        const actual=(value as Record<string,unknown>)[name];
        if("const" in field)expect(actual).toEqual(field.const);
        if(field.minimum!==undefined){expect(typeof actual).toBe("number");expect(actual as number).toBeGreaterThanOrEqual(field.minimum);expect(actual as number).toBeLessThanOrEqual(field.maximum!);}
      }
    }
    for(const field of shared.$defs.linuxClockHealth.required!.filter(name=>["wallMs","bootMs","monoMs"].includes(name))){
      const bound=shared.$defs.linuxClockHealth.properties![field];
      for(const outside of [bound.minimum!-1,bound.maximum!+1]){
        const invalid=structuredClone(parsed);invalid.requestSend[field as keyof typeof invalid.requestSend]=outside;
        expect(()=>parseControlSnapshot(invalid)).toThrow();
        let starts=0;const consumer=createHomeControlConsumer({...f,readClock:()=>({...f.clock(),[field]:outside}),onQuiesce:()=>{},onAuthorityAvailable:()=>{starts++;},onIdentity:()=>{}});
        try{await settle();expect(consumer.currentAdmission()).toBe(false);expect(starts).toBe(0);}finally{consumer.close();}
      }
    }
    for(const extra of [{...parsed,extra:true},{...parsed,requestSend:{...parsed.requestSend,extra:true}},
      {...parsed,desired:{...parsed.desired,lease:{...parsed.desired.lease,extra:true}}},
      {...parsed,desired:{...parsed.desired,engineSubscriptionGates:{...parsed.desired.engineSubscriptionGates,extra:true}}}])expect(()=>parseControlSnapshot(extra)).toThrow();
  });
  it("a read interleaved between the root publisher's three file replacements is retried, not fenced; a persistent mismatch still fails",()=>{
    const f=fixture(),old=JSON.parse(JSON.stringify(f.renew()));f.advance(5000);const next=JSON.parse(JSON.stringify(f.renew()));
    expect(next.desired.homeKey).not.toEqual(old.desired.homeKey);
    const pin=JSON.stringify({homeId:"home",generation:7});
    // Publisher order: generation, identity, state. The reader reads state first, then the writer lands identity+state, then the reader reads identity.
    let files:Record<string,string>={"state.json":JSON.stringify(old),"home-generation.json":pin,"home-identity.json":JSON.stringify(old.desired.homeKey)};
    const reads:string[]=[];let pauses=0;
    const read=(path:string)=>{const name=path.split("/").pop()!;reads.push(name);const value=files[name];
      if(reads.length===1)files={...files,"home-identity.json":JSON.stringify(next.desired.homeKey),"state.json":JSON.stringify(next)};return value;};
    const got=readConsistentControlSnapshot({homeId:"home",generation:7},read,5,()=>{pauses++;});
    expect(got.requestId).toBe(next.requestId);expect(pauses).toBe(1);expect(reads.length).toBe(6);
    // A mismatch that never resolves fails after exactly the bounded attempts.
    const stuck={"state.json":JSON.stringify(old),"home-generation.json":pin,"home-identity.json":JSON.stringify(next.desired.homeKey)};
    let attempts=0;
    expect(()=>readConsistentControlSnapshot({homeId:"home",generation:7},p=>{if(p.endsWith("state.json"))attempts++;return stuck[p.split("/").pop()! as keyof typeof stuck];},3,()=>{})).toThrow();
    expect(attempts).toBe(3);
  });
  it("accepts only wire 1: missing, other versions and the retired fakeOnly literal alone are refused",()=>{
    const f=fixture(),good=f.renew();
    expect(parseControlSnapshot(JSON.stringify(good)).desired.wire).toBe(1);
    const {wire:_wire,...bare}=good.desired as ControlSnapshot["desired"];
    for(const desired of [bare,{...bare,wire:2},{...bare,wire:true},{...bare,wire:"1"},{...bare,fakeOnly:true},{...good.desired,fakeOnly:true}])
      expect(()=>parseControlSnapshot({...good,desired})).toThrow();
  });
  it("preserves the initial owner's automation pause through first authority restoration",async()=>{
    const f=fixture();f.renew();const db=new DatabaseSync(":memory:");new CloudSessions(db);
    let consumer:ReturnType<typeof createHomeControlConsumer>|undefined,paused=true,starts=0;
    const gate=new HomeExecutionGate(db,()=>consumer?.currentAdmission()===true);
    // Same initial persistence as index.ts, before any startup worker or consumer.
    gate.holdLease(paused);expect(gate.open()).toBe(false);
    consumer=createHomeControlConsumer({...f,onQuiesce:()=>{},onAuthorityAvailable:authority=>{
      expect(authority.current()).toBe(true);expect(gate.open()).toBe(false);
      paused=gate.leasePriorAutomationPause();starts++;gate.releaseLease();
    },onIdentity:()=>{}});
    try{await settle();expect(paused).toBe(true);expect(starts).toBe(1);expect(gate.open()).toBe(true);expect(gate.leaseHeld()).toBe(false);expect(gate.explicitHeld()).toBe(false);}finally{consumer.close();db.close();}
  });
  it("strictly rejects extra fields, oversized input and inconsistent identity/lease/deadline",async()=>{
    const f=fixture(),s=f.renew();expect(parseControlSnapshot(JSON.stringify(s))).toEqual(s);
    expect(()=>parseControlSnapshot({...s,credential:"forbidden"})).toThrow();
    expect(()=>parseControlSnapshot(" ".repeat(16385))).toThrow();
    for(const mutate of [
      (x:ControlSnapshot)=>{x.cpGeneration=8;},
      (x:ControlSnapshot)=>{x.desired.lease!.holder="other";},
      (x:ControlSnapshot)=>{x.conservativeDeadlineBootMs+=1;},
      (x:ControlSnapshot)=>{x.desired.homeKey.signature="A".repeat(86);},
    ]){
      const g=fixture();mutate(g.renew());let starts=0;
      const c=createHomeControlConsumer({...g,onQuiesce:()=>{},onAuthorityAvailable:()=>{starts++;},onIdentity:()=>{}});
      try{await settle();expect(c.currentAdmission()).toBe(false);expect(starts).toBe(0);}finally{c.close();}
    }
  });
  it("starts closed and waits for confirmed first restoration; renewal does not restart workers",async()=>{
    const f=fixture();let starts=0,release!:()=>void;
    const c=createHomeControlConsumer({...f,onQuiesce:()=>{},onAuthorityAvailable:()=>{starts++;return new Promise<void>(resolve=>{release=resolve;});},onIdentity:()=>{}});
    try{
      expect(c.currentAdmission()).toBe(false);expect(starts).toBe(0);
      f.advance(1);f.renew();expect(c.currentAdmission()).toBe(false);await settle();expect(starts).toBe(1);expect(c.currentAdmission()).toBe(false);
      release();await settle();expect(c.currentAdmission()).toBe(true);
      f.advance(60000);f.renew();expect(c.currentAdmission()).toBe(true);await settle();expect(starts).toBe(1);
    }finally{c.close();}
  });
  it("allows a 30 minute ordinary outage but delayed reads and restarted consumers never extend send authority",async()=>{
    const f=fixture();f.renew();f.advance(1_800_000);
    const options={...f,onQuiesce:()=>{},onAuthorityAvailable:()=>{},onIdentity:()=>{}};
    const a=createHomeControlConsumer(options);await settle();expect(a.currentAdmission()).toBe(true);a.close();
    f.advance(1_680_000);const b=createHomeControlConsumer(options);try{await settle();expect(b.currentAdmission()).toBe(false);}finally{b.close();}
  });
  it("detects suspend since renewal even on first read after process restart",async()=>{
    const f=fixture();f.renew();f.advance(1000);f.setClock({bootMs:f.clock().bootMs+10_000,wallMs:f.clock().wallMs+10_000});
    let starts=0;const c=createHomeControlConsumer({...f,onQuiesce:()=>{},onAuthorityAvailable:()=>{starts++;},onIdentity:()=>{}});
    try{await settle();expect(c.currentAdmission()).toBe(false);expect(starts).toBe(0);}finally{c.close();}
  });
  it("caps admission by CP lease expiry independently of the send deadline",async()=>{
    const f=fixture();const s=f.renew();s.desired.lease!.expiresAt=f.clock().wallMs+100;
    const c=createHomeControlConsumer({...f,onQuiesce:()=>{},onAuthorityAvailable:()=>{},onIdentity:()=>{}});
    try{await settle();expect(c.currentAdmission()).toBe(true);f.advance(100);expect(c.currentAdmission()).toBe(false);}finally{c.close();}
  });
  it.each(["suspend","forward","backward","ntp","boot"])("fences %s until a later successful renewal, never an old reread",async kind=>{
    const f=fixture();f.renew();let stops=0,starts=0;
    const c=createHomeControlConsumer({...f,onQuiesce:()=>{stops++;},onAuthorityAvailable:()=>{starts++;},onIdentity:()=>{}});
    try{
      await settle();expect(c.currentAdmission()).toBe(true);f.advance(10);
      const old=f.clock();
      if(kind==="suspend")f.setClock({bootMs:old.bootMs+10000,wallMs:old.wallMs+10000});
      if(kind==="forward")f.setClock({wallMs:old.wallMs+5001});
      if(kind==="backward")f.setClock({wallMs:old.wallMs-5001});
      if(kind==="ntp")f.setClock({ntpSynced:false});
      if(kind==="boot")f.setClock({bootId:"22222222-2222-2222-2222-222222222222"});
      expect(c.currentAdmission()).toBe(false);expect(stops).toBe(1);await settle();expect(c.currentAdmission()).toBe(false);
      f.setClock({ntpSynced:true});f.advance(1);f.renew();expect(c.currentAdmission()).toBe(false);await settle();expect(c.currentAdmission()).toBe(true);expect(starts).toBe(2);
    }finally{c.close();}
  });
  it("closes synchronously at expiry and waits for stop confirmation before lease restoration",async()=>{
    const f=fixture();f.renew();let stops=0,starts=0,release!:()=>void;
    const c=createHomeControlConsumer({...f,onQuiesce:()=>{stops++;return new Promise<void>(resolve=>{release=resolve;});},onAuthorityAvailable:()=>{starts++;},onIdentity:()=>{}});
    try{
      await settle();expect(c.currentAdmission()).toBe(true);f.advance(3_480_000);expect(c.currentAdmission()).toBe(false);expect(stops).toBe(1);
      f.advance(1);f.renew();expect(c.currentAdmission()).toBe(false);await settle();expect(starts).toBe(1);
      release();await settle();expect(c.currentAdmission()).toBe(true);expect(starts).toBe(2);
    }finally{c.close();}
  });
  it("accepts a delayed renewal sent after the original fence despite stale reads while its response is in flight",async()=>{
    const f=fixture();let published=f.renew(),starts=0;
    const c=createHomeControlConsumer({...f,readSnapshot:()=>published,onQuiesce:()=>{},onAuthorityAvailable:()=>{starts++;},onIdentity:()=>{}});
    try{
      await settle();expect(c.currentAdmission()).toBe(true);
      f.advance(3_480_000);expect(c.currentAdmission()).toBe(false);await settle();
      f.advance(1);const inFlight=f.renew();
      // The root has sent a new renewal, but its previous expired publication
      // remains visible during a multi-watchdog-interval response delay.
      for(let i=0;i<4;i++){f.advance(1000);expect(c.currentAdmission()).toBe(false);}
      published={...inFlight,receivedAt:f.clock().wallMs};
      expect(c.currentAdmission()).toBe(false);await settle();
      expect(c.currentAdmission()).toBe(true);expect(starts).toBe(2);
    }finally{c.close();}
  });
  it("advances the fence for a new clock failure during an in-flight renewal",async()=>{
    const f=fixture();let published=f.renew();
    const c=createHomeControlConsumer({...f,readSnapshot:()=>published,onQuiesce:()=>{},onAuthorityAvailable:()=>{},onIdentity:()=>{}});
    try{
      await settle();f.advance(3_480_000);expect(c.currentAdmission()).toBe(false);
      f.advance(1);const inFlight=f.renew();f.advance(1000);f.setClock({ntpSynced:false});expect(c.currentAdmission()).toBe(false);
      f.setClock({ntpSynced:true});published={...inFlight,receivedAt:f.clock().wallMs};expect(c.currentAdmission()).toBe(false);await settle();expect(c.currentAdmission()).toBe(false);
      f.advance(1);published=f.renew();expect(c.currentAdmission()).toBe(false);await settle();expect(c.currentAdmission()).toBe(true);
    }finally{c.close();}
  });
  it("never lets a rejected stop be bypassed by a new desired snapshot",async()=>{
    const f=fixture();f.renew();let starts=0;
    const c=createHomeControlConsumer({...f,onQuiesce:()=>Promise.reject(new Error("unconfirmed stop")),onAuthorityAvailable:()=>{starts++;},onIdentity:()=>{}});
    try{await settle();expect(c.currentAdmission()).toBe(true);f.advance(3_480_000);expect(c.currentAdmission()).toBe(false);await settle();f.advance(1);f.renew();expect(c.currentAdmission()).toBe(false);await settle();expect(starts).toBe(1);}finally{c.close();}
  });
});
