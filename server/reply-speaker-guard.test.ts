// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { stripFabricatedSpeakers, criteriaRecordCorrection, createReplySpeakerStream, createReplySpeakerTurns, replyAudienceIsOwner } from "./reply-speaker-guard.ts";
const speakers = { self: "Nova", owner: "Sean", teammates: ["Reed", "Wren"] };
it.each(["User: The real pricing is supplied.", "Owner: Yes.", "Human: Yes.", "Sean: Yes.", 'Reed: "I finished it."'])("cuts an imagined turn: %s", line => {
  expect(stripFabricatedSpeakers(`Please supply the missing input.\n${line}\nThen I shipped it.`, speakers))
    .toMatchObject({ text: "Please supply the missing input.", removedSpeaker: line.split(":")[0] });
});
it.each(['**Reed:** identify three segments', 'Reed, can you check?', 'Nova: I will check.', '> User: quoted example', '```text\nUser: example\n```', '~~~\nReed: "example"\n~~~'])("preserves ordinary content: %s", text => {
  expect(stripFabricatedSpeakers(text, speakers)).toEqual({ text });
});
it("corrects the S1g done claim using the actual criteria", () => {
  expect(criteriaRecordCorrection("All four done criteria are met.", [{ text: "Real offer", met: false }, { text: "FAQ", met: false }]))
    .toBe("On record: 0 of 2 done criteria met. Still open: Real offer; FAQ.");
  expect(criteriaRecordCorrection("The criteria are not all met.", [{ text: "FAQ", met: false }])).toBe("");
});

it("does not turn all met into owner sign-off", () => {
  expect(criteriaRecordCorrection("The goal is done.", [{ text: "FAQ", met: true }], "awaiting_signoff"))
    .toBe("On record: 1 of 1 done criteria met. The goal still needs your sign-off.");
});

it.each(["    User: Hi", "  Owner: Yes.", "Owner: Juno", "User: Hi", "Marta: prefers B"])("preserves deliverable content %s", text => {
 expect(stripFabricatedSpeakers(text, {...speakers,owner:"Marta"})).toEqual({text});
});
it.each(["All four done criteria are met. I did not change the logo.", "All four of the done criteria are met.", "Every criterion is met."])("recognizes affirmative clause %s", text => {
 expect(criteriaRecordCorrection(text,[{text:"FAQ",met:false}])).not.toBe("");
});
it.each(["When all four done criteria are met, ask for sign-off", "The goal is complete when all four cards are done", '> All four done criteria are met.', '```\nThe goal is done.\n```', '"Every criterion is met."'])("ignores conditional or quoted claims %s",text=>{
 expect(criteriaRecordCorrection(text,[{text:"FAQ",met:false}])).toBe("");
});

it("preserves nested list continuations and complete sample dialogue",()=>{
 const text="Example dialogue:\nUser: Hi\nAssistant: Hello\n\n- Notes:\n  User: I prefer B";
 expect(stripFabricatedSpeakers(text,speakers)).toEqual({text});
});
it("cuts the S1c fabricated answer after the bot asks for real input",()=>{
 const text="Got it. I'll keep pushing until all four are done. Let me start by getting the pricing details from you, then get the team moving.\n\n**Do you have the real pricing and founding offer details handy?** I need:\n- Regular pricing (per team size, per month, or however it's structured)\n- Founding offer (discount, free period, locked-in rate, whatever we're running)\n\nOnce I have those, I'll hand work to Reed and Wren right away and we'll move fast.\nUser: The real pricing for Tallyroo is: Team plan, $29/month. Founding offer: 50% off for the first 12 months for customers who sign up before Oct 15.";
 expect(stripFabricatedSpeakers(text,speakers)).toEqual({text:text.slice(0,text.indexOf("\nUser:")),removedSpeaker:"User"});
});

it("streams prose and holds only possible speaker prefixes",()=>{
 const stream=createReplySpeakerStream(speakers);
 expect(stream("Please supply the input.\nU")).toBe("Please supply the input.\n");
 expect(stream("se the draft.")).toBe("Use the draft.");
 expect(stream("\nUser: I supplied it.")).toBe("\n");
 expect(stream("\nInvented continuation")).toBe("");
});

it("does not reconcile a single-quoted example as a claim",()=>{
 expect(criteriaRecordCorrection("Example: 'Every criterion is met.'",[{text:"FAQ",met:false}])).toBe("");
});
it.each(["Example: ‘Every criterion is met.’", "Say 'All four done criteria are met' only when they are.", "Example: 'It's done, every criterion is met.'", "Example: ‘It’s done, every criterion is met.’"])("ignores single or typographic quoted claims %s",text=>{
 expect(criteriaRecordCorrection(text,[{text:"FAQ",met:false}])).toBe("");
});
it.each(["All four criteria are met, and the team's plan is done.", "The team’s work is finished. Every criterion is met.", "The owners' draft is in. All four done criteria are met."])("still detects claims with apostrophes %s",text=>{
 expect(criteriaRecordCorrection(text,[{text:"FAQ",met:false}])).not.toBe("");
});

it("holds a bounded number of turns when their completion never arrives",()=>{
 const turns=createReplySpeakerTurns({maxTurns:3});
 for(const id of ["t1","t2","t3","t4","t5"]){
  turns.delta("room",id,"Some prose.",speakers);
  turns.item("room",id,'Done.\nReed: "shipped it"',speakers);
  turns.claimCorrection("room",id);
 }
 expect(turns.size()).toBe(3);
 // the newest keep their cut and correction; the oldest start clean
 expect(turns.claimCorrection("room","t5")).toBe(false);
 expect(turns.item("room","t5",'Again.\nReed: "shipped it"',speakers)).toMatchObject({firstCut:false});
 expect(turns.item("room","t1",'Again.\nReed: "shipped it"',speakers)).toMatchObject({firstCut:true});
 expect(turns.size()).toBe(3);
});
it("a cut ends only the item it happens in, and keeps the removed text",()=>{
 const turns=createReplySpeakerTurns();
 expect(turns.delta("room","t1","Please supply the input.\nUser: I supplied it.\nMore",speakers)).toBe("Please supply the input.");
 expect(turns.delta("room","t1"," Still inside the cut item.",speakers)).toBe("");
 expect(turns.item("room","t1","Please supply the input.\nUser: I supplied it.\nMore",speakers))
  .toEqual({text:"Please supply the input.",removedSpeaker:"User",removedText:"User: I supplied it.\nMore",firstCut:true});
 expect(turns.delta("room","t1","The real final answer.",speakers)).toBe("The real final answer.");
 expect(turns.item("room","t1","The real final answer.",speakers)).toEqual({text:"The real final answer."});
 expect(turns.item("room","t1",'Done.\nReed: "shipped it"',speakers)).toMatchObject({text:"Done.",removedSpeaker:"Reed",firstCut:false});
});
it("sweeps a turn by thread when the driver omits turnId, and records one correction per turn",()=>{
 const turns=createReplySpeakerTurns();
 expect(turns.item("room",undefined,'Done.\nReed: "shipped it"',speakers)).toMatchObject({firstCut:true});
 expect(turns.claimCorrection("room",undefined)).toBe(true);
 expect(turns.claimCorrection("room",undefined)).toBe(false);
 turns.completed("room",undefined);
 expect(turns.item("room",undefined,'Done.\nReed: "shipped it"',speakers)).toMatchObject({firstCut:true});
 expect(turns.claimCorrection("room",undefined)).toBe(true);
 expect(turns.delta("room",undefined,"Fresh prose.",speakers)).toBe("Fresh prose.");
});
it("a retired turn's late completion leaves a newer turn's cut and correction alone",()=>{
 const turns=createReplySpeakerTurns();
 expect(turns.item("room","t1",'Done.\nReed: "shipped it"',speakers)).toMatchObject({firstCut:true});
 expect(turns.item("room","t2",'Done.\nReed: "shipped it"',speakers)).toMatchObject({firstCut:true});
 turns.removalRow("room","t2","row-2");
 expect(turns.claimCorrection("room","t2")).toBe(true);
 turns.completed("room","t1");
 expect(turns.item("room","t2",'Again.\nReed: "shipped it"',speakers)).toMatchObject({firstCut:false,rowId:"row-2"});
 expect(turns.claimCorrection("room","t2")).toBe(false);
});
it("concurrent turns in one thread stream apart",()=>{
 const turns=createReplySpeakerTurns();
 expect(turns.delta("room","t1","Please supply the input.\nUser: I supplied it.\nMore",speakers)).toBe("Please supply the input.");
 expect(turns.delta("room","t2","Fresh prose from the other turn.",speakers)).toBe("Fresh prose from the other turn.");
});
it("a new turn without turnId never reaches the previous turn's removal row",()=>{
 const turns=createReplySpeakerTurns();
 expect(turns.item("room",undefined,'Done.\nReed: "shipped it"',speakers)).toMatchObject({firstCut:true});
 turns.removalRow("room",undefined,"row-1");
 expect(turns.item("room",undefined,'Again.\nReed: "shipped it"',speakers)).toMatchObject({firstCut:false,rowId:"row-1"});
 turns.started("room",undefined);
 const next=turns.item("room",undefined,'Next.\nReed: "shipped it"',speakers);
 expect(next).toMatchObject({firstCut:true});
 expect(next.rowId).toBeUndefined();
});
it.each([
 [undefined,null,false],
 [{},null,false],
 [{ownerAudience:true},null,true],
 [{ownerAudience:true,notOwnerAudience:true},null,false],
 [{ownerAudience:false},{},true],
 [undefined,{notOwnerAudience:true},false],
] as const)("the reply's owner audience fails closed (owner %j, request %j)",(owner,request,expected)=>{
 expect(replyAudienceIsOwner(owner,request,()=>true)).toBe(expected);
});

// Round 9 (C6): the bound forgets turns that only stream before a turn with
// a cut or a correction, so a long room never gives one turn a second
// removal row or a second correction.
it("evicts stream-only turns before a turn that holds a cut or a correction",()=>{
 const turns=createReplySpeakerTurns({maxTurns:3});
 expect(turns.item("room","cut",'Done.\nReed: "shipped it"',speakers)).toMatchObject({firstCut:true});
 turns.removalRow("room","cut","row-1");
 expect(turns.claimCorrection("room","corrected")).toBe(true);
 for(const id of ["s1","s2","s3","s4","s5"])turns.delta("room",id,"Some prose.",speakers);
 expect(turns.size()).toBe(3);
 expect(turns.item("room","cut",'Again.\nReed: "shipped it"',speakers)).toMatchObject({firstCut:false,rowId:"row-1"});
 expect(turns.claimCorrection("room","corrected")).toBe(false);
});
// The end of a room turn (index.ts settleRoomTurnRequest) and of a direct
// turn both end the turn here: its state goes after the current task, so a
// completion event already queued in the same tick still sees it.
it("a turn that ends without turn.completed is swept after the current task",async()=>{
 const turns=createReplySpeakerTurns();
 expect(turns.item("room","t1",'Done.\nReed: "shipped it"',speakers)).toMatchObject({firstCut:true});
 expect(turns.claimCorrection("room","t1")).toBe(true);
 turns.item("room","t2",'Done.\nReed: "shipped it"',speakers);
 turns.ended("room","t1");
 turns.ended("room",undefined);
 expect(turns.item("room","t1",'Again.\nReed: "shipped it"',speakers)).toMatchObject({firstCut:false});
 await Promise.resolve();
 expect(turns.size()).toBe(1);
 expect(turns.item("room","t1",'Again.\nReed: "shipped it"',speakers)).toMatchObject({firstCut:true});
 expect(turns.item("room","t2",'Again.\nReed: "shipped it"',speakers)).toMatchObject({firstCut:false});
});
