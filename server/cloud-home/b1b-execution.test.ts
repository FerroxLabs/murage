// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CloudSessions } from "../cloud-sessions.ts";
import { HomeExecutionGate } from "./b1b-execution.ts";
describe("home execution admission",()=>{
  it("T-CLOUD holds Signal across restart and releases it independently (kills omitted holdChannels entry)", () => {
    const db = new DatabaseSync(":memory:");
    try {
      new CloudSessions(db);
      const gate = new HomeExecutionGate(db, () => true);
      expect(gate.channelsOpen("signal")).toBe(true);
      gate.holdChannels();
      expect(gate.channelHeld("signal")).toBe(true);
      const restarted = new HomeExecutionGate(db, () => true);
      expect(restarted.channelsOpen("signal")).toBe(false);
      restarted.releaseChannel("telegram");
      expect(restarted.channelsOpen("signal")).toBe(false);
      restarted.releaseChannel("signal");
      expect(restarted.channelsOpen("signal")).toBe(true);
      expect(restarted.channelsOpen("slack")).toBe(false);
      expect(restarted.channelsOpen("discord")).toBe(false);
    } finally { db.close(); }
  });

  it("T-CLOUD Signal respects authority, safe mode, execution and lease holds", () => {
    const db = new DatabaseSync(":memory:");
    try {
      new CloudSessions(db);
      const gate = new HomeExecutionGate(db, () => true);
      expect(gate.channelsOpen("signal")).toBe(true);
      expect(new HomeExecutionGate(db).channelsOpen("signal")).toBe(false);
      const safe = new HomeExecutionGate(db, () => true, true);
      safe.releaseChannel("signal");
      expect(safe.channelsOpen("signal")).toBe(false);
      gate.hold("stop");
      expect(gate.channelsOpen("signal")).toBe(false);
      gate.resume();
      expect(gate.channelsOpen("signal")).toBe(true);
      gate.holdLease(false);
      expect(gate.channelsOpen("signal")).toBe(false);
      gate.releaseLease();
      expect(gate.channelsOpen("signal")).toBe(true);
    } finally { db.close(); }
  });

  it("persists stop across a new gate and requires explicit resume",()=>{
    const db=new DatabaseSync(":memory:");try {new CloudSessions(db);const gate=new HomeExecutionGate(db,()=>true);expect(gate.open()).toBe(true);gate.hold("drain");expect(()=>new HomeExecutionGate(db,()=>true).requireOpen()).toThrow("paused");gate.resume();expect(gate.open()).toBe(true);}finally {db.close();}
  });
  it("retains an owner's existing automation pause through repeated lifecycle holds",()=>{
    const db=new DatabaseSync(":memory:");try {new CloudSessions(db);const gate=new HomeExecutionGate(db,()=>true);gate.hold("stop",true);gate.hold("drain",false);expect(gate.priorAutomationPause()).toBe(true);gate.resume();expect(gate.open()).toBe(true);}finally {db.close();}
  });
  it("keeps each recovery channel paused across execution resume until separately reconnected",()=>{
    const db=new DatabaseSync(":memory:");try {new CloudSessions(db);const gate=new HomeExecutionGate(db,()=>true);gate.hold("recovery");gate.holdChannels();gate.resume();expect(gate.open()).toBe(true);expect(gate.channelsOpen("telegram")).toBe(false);gate.releaseChannel("telegram");expect(gate.channelsOpen("telegram")).toBe(true);expect(new HomeExecutionGate(db,()=>true).channelsOpen("slack")).toBe(false);expect(gate.channelsOpen("discord")).toBe(false);}finally {db.close();}
  });
  it("defaults closed and keeps lease pause separate from owner and recovery holds",()=>{
    const db=new DatabaseSync(":memory:");try {
      new CloudSessions(db);expect(new HomeExecutionGate(db).open()).toBe(false);
      let authority=true;const gate=new HomeExecutionGate(db,()=>authority);
      gate.holdLease(false);gate.hold("stop",true);expect(gate.priorAutomationPause()).toBe(false);
      gate.holdChannels();gate.releaseLease();expect(gate.open()).toBe(false);
      gate.resume();expect(gate.open()).toBe(true);expect(gate.channelsOpen("telegram")).toBe(false);
      authority=false;gate.holdLease(true);gate.resume();expect(gate.leaseHeld()).toBe(true);expect(gate.open()).toBe(false);
      expect(new HomeExecutionGate(db,()=>true).leasePriorAutomationPause()).toBe(true);
    }finally{db.close();}
  });
});
describe("the owner's pause choice during a lifecycle hold",()=>{
  const ownerChoice=(db:DatabaseSync)=>(db.prepare("SELECT value FROM cloud_meta WHERE key='owner-pause-during-hold'").get() as {value:string}|undefined)?.value;
  const anyHold=(db:DatabaseSync)=>Boolean(db.prepare("SELECT 1 FROM cloud_meta WHERE key IN ('lease-hold','execution-hold')").get());
  /** A database whose next write after `crashAfter` writes throws, as if the process died between two commits. */
  const crashingDatabase=(db:DatabaseSync)=>{
    const state={writes:0,crashAfter:Number.POSITIVE_INFINITY};
    const wrapped=new Proxy(db,{get(target,prop){
      if(prop==="prepare")return (sql:string)=>{const statement=target.prepare(sql);return new Proxy(statement,{get(inner,key){
        if(key==="run")return (...args:unknown[])=>{if(state.writes>=state.crashAfter)throw new Error("simulated crash between commits");state.writes++;return (inner.run as (...values:unknown[])=>unknown).apply(inner,args);};
        const value=Reflect.get(inner,key);return typeof value==="function"?value.bind(inner):value;}});};
      const value=Reflect.get(target,prop);return typeof value==="function"?value.bind(target):value;}});
    return {gate:new HomeExecutionGate(wrapped,()=>true),state};
  };
  it.each(["lease","explicit"] as const)("a crash while the last %s hold ends never leaves the choice behind with no hold",release=>{
    const db=new DatabaseSync(":memory:");try {
      new CloudSessions(db);const {gate,state}=crashingDatabase(db);
      if(release==="lease")gate.holdLease(false);else gate.hold("stop",false);
      gate.recordOwnerPause(true);expect(ownerChoice(db)).toBe("1");
      state.crashAfter=state.writes+1;
      let crashed=false;try {if(release==="lease")gate.releaseLease();else gate.resume();} catch(error) {crashed=true;expect(String(error)).toContain("simulated crash");}
      expect({crashed,hold:anyHold(db),choice:ownerChoice(db)}).toEqual({crashed:false,hold:false,choice:undefined});
    }finally{db.close();}
  });
  it("a choice found with no hold does not carry into the next lease or explicit hold",()=>{
    for(const start of ["lease","explicit"] as const){
      const db=new DatabaseSync(":memory:");try {
        new CloudSessions(db);db.prepare("INSERT OR REPLACE INTO cloud_meta VALUES ('owner-pause-during-hold','1')").run();
        const gate=new HomeExecutionGate(db,()=>true);
        if(start==="lease"){gate.holdLease(false);expect(gate.pauseToRestore(gate.leasePriorAutomationPause())).toBe(false);}
        else {gate.hold("stop",false);expect(gate.pauseToRestore(gate.priorAutomationPause())).toBe(false);}
      }finally{db.close();}
    }
  });
  it("a choice during a lease-only hold wins on release, then the next hold starts from its own snapshot",()=>{
    const db=new DatabaseSync(":memory:");try {
      new CloudSessions(db);const gate=new HomeExecutionGate(db,()=>true);
      gate.holdLease(false);gate.recordOwnerPause(true);expect(gate.pauseToRestore(gate.leasePriorAutomationPause())).toBe(true);
      gate.releaseLease();expect(ownerChoice(db)).toBeUndefined();
      gate.holdLease(false);expect(gate.pauseToRestore(gate.leasePriorAutomationPause())).toBe(false);
      gate.releaseLease();gate.hold("stop",true);expect(gate.pauseToRestore(gate.priorAutomationPause())).toBe(true);
    }finally{db.close();}
  });
  it.each(["lease-first","explicit-first"] as const)("with a lease and an explicit hold (%s), the choice outlives the first release and goes with the last",order=>{
    const db=new DatabaseSync(":memory:");try {
      new CloudSessions(db);const gate=new HomeExecutionGate(db,()=>true);
      gate.holdLease(false);gate.hold("stop",false);gate.recordOwnerPause(true);
      if(order==="lease-first")gate.releaseLease();else gate.resume();
      expect(ownerChoice(db)).toBe("1");expect(gate.pauseToRestore(false)).toBe(true);
      if(order==="lease-first")gate.resume();else gate.releaseLease();
      expect(anyHold(db)).toBe(false);expect(ownerChoice(db)).toBeUndefined();expect(gate.pauseToRestore(false)).toBe(false);
    }finally{db.close();}
  });
  it("records nothing while no hold is active",()=>{
    const db=new DatabaseSync(":memory:");try {
      new CloudSessions(db);const gate=new HomeExecutionGate(db,()=>true);
      gate.recordOwnerPause(true);expect(ownerChoice(db)).toBeUndefined();expect(gate.pauseToRestore(false)).toBe(false);
    }finally{db.close();}
  });
});
