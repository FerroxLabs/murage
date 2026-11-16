// Producer owner: sc-safety (fixture transport); consumer owner: new3-g2 (comms scenarios).
import {expect,it} from "vitest";
import {CommsWireFixture} from "./comms-wire-fixture.ts";
it("CROSS-SC-TRANSPORT follows the observed opaque handle through the real responder protocol",()=>{
  const f=new CommsWireFixture();
  const wire={bots:[{messages:[{card:{requestHandle:"p.fixture-card",tool:"ask_bot",options:["Allow","Deny"]}}]}]};
  const observed=f.observe(wire);
  // MAIN RULING INT-CONFLICT-DEFAULT de1ff54d75 a62419d6d5: the fixture preserves the opaque public wire without synthesizing a native-ID alias.
  expect(observed).toBe(wire);
  expect(observed.bots[0].messages[0].card).toMatchObject({requestHandle:"p.fixture-card",tool:"ask_bot"});
  expect(observed.bots[0].messages[0].card).not.toHaveProperty("requestId");
  expect(wire.bots[0].messages[0].card).not.toHaveProperty("requestId");
  expect(f.request({requestHandle:"p.fixture-card",action:"allow"})).toEqual({requestHandle:"p.fixture-card",action:"allow"});
  expect(f.request({requestHandle:"p.fixture-card",action:"deny"})).toEqual({requestHandle:"p.fixture-card",action:"deny"});
});
it("CROSS-SC-TRANSPORT cannot manufacture a missing handle or substitute a different card",()=>{
  const f=new CommsWireFixture();
  expect(f.observe({card:{tool:"ask_bot"}}).card).not.toHaveProperty("requestId");
  f.observe({card:{requestHandle:"p.old-card"}});f.observe({card:{requestHandle:"p.new-card"}});
  // MAIN RULING INT-CONFLICT-DEFAULT de1ff54d75 a62419d6d5: a legacy or forged packet must also reach the product unchanged.
  expect(f.request({requestId:"p.old-card",behavior:"deny"})).toEqual({requestId:"p.old-card",behavior:"deny"});
  expect(f.request({requestId:"p.unknown-card",behavior:"allow"})).toEqual({requestId:"p.unknown-card",behavior:"allow"});
  expect(f.request({requestId:"p.old-card",behavior:"other"})).toEqual({requestId:"p.old-card",behavior:"other"});
});
