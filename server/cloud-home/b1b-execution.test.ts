// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CloudSessions } from "../cloud-sessions.ts";
import { HomeExecutionGate } from "./b1b-execution.ts";
describe("home execution admission",()=>{
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
