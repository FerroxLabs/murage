// A person in a room who says "Moss, can you…" is talking to Moss. Only a
// leading or trailing vocative counts; a name used inside a sentence ("ask
// Moss later") is a reference, not an address, and keeps the room's default.
import { describe, expect, it } from "vitest";
import { addressedMembers, roomResponders } from "./store.ts";

const members = [
  { id: "sable", name: "Sable" },
  { id: "moss", name: "Moss" },
  { id: "pixel", name: "Pixel Designer" },
  { id: "ghost", name: "Ghost", hidden: true },
];
const lead = { kind: "member" as const, botId: "sable" };
const ids = (text: string) => addressedMembers(text, members).map((member) => member.id);

describe("addressedMembers", () => {
  it.each([
    ["Moss, can you check the sensor?", ["moss"]],
    ["moss: status please", ["moss"]],
    ["Moss — what changed?", ["moss"]],
    ["Moss - what changed?", ["moss"]],
    ["Moss can you check the sensor?", ["moss"]],
    ["Moss please look at this", ["moss"]],
    ["Hey Moss, quick one", ["moss"]],
    ["ok moss, go ahead", ["moss"]],
    ["Moss?", ["moss"]],
    ["Moss!", ["moss"]],
    ["Can you check the sensor, Moss?", ["moss"]],
    ["Thanks, Moss.", ["moss"]],
    ["Moss and Sable, can you both look?", ["moss", "sable"]],
    ["Moss, Sable: compare notes", ["moss", "sable"]],
    ["Pixel, draw the logo", ["pixel"]],
    ["Pixel Designer, draw the logo", ["pixel"]],
  ])("addresses %j", (text, expected) => {
    expect(ids(text)).toEqual(expected);
  });

  it.each([
    "ask Moss later about it",
    "I think Moss said the sensor was fine.",
    "Moss grows on the north side of trees",
    "Mossy stones, anyone?",
    "Tell Moss, and then Sable, that we are done",
    "Moss's report was good",
    "Ghost, are you there?",
    "Sensor readings for Moss and friends",
    "",
  ])("does not address anyone in %j", (text) => {
    expect(ids(text)).toEqual([]);
  });

  it("ignores a shared first word that would be ambiguous as a short name", () => {
    const twins = [{ id: "a", name: "Pixel One" }, { id: "b", name: "Pixel Two" }];
    expect(addressedMembers("Pixel, which of you is free?", twins)).toEqual([]);
    expect(addressedMembers("Pixel Two, you take it", twins).map((member) => member.id)).toEqual(["b"]);
  });
});

describe("roomResponders with plain-name addressing", () => {
  it("routes a vocative name to that member instead of the lead", () => {
    expect(roomResponders("Moss, can you check?", members, lead, undefined, { byName: true }).map((m) => m.id)).toEqual(["moss"]);
  });
  it("keeps the lead for a name used mid-sentence", () => {
    expect(roomResponders("ask Moss later", members, lead, undefined, { byName: true }).map((m) => m.id)).toEqual(["sable"]);
  });
  it("merges explicit mentions and vocatives; everyone still selects all", () => {
    expect(roomResponders("Moss, loop in @Sable", members, lead, undefined, { byName: true }).map((m) => m.id)).toEqual(["moss", "sable"]);
    expect(roomResponders("Moss, @everyone look", members, lead, undefined, { byName: true }).map((m) => m.id)).toEqual(["sable", "moss", "pixel"]);
  });
  it("prefers the named member over the replied-to member", () => {
    expect(roomResponders("Moss, what do you think?", members, lead, "pixel", { byName: true }).map((m) => m.id)).toEqual(["moss"]);
  });
  it("leaves bot-to-bot mention chaining unchanged: a bot's plain-name reference summons nobody", () => {
    expect(roomResponders("Moss, good point.", members, { kind: "mentions" })).toEqual([]);
  });
});

// 0.1.60 low (Windows FINAL L5): "Ember: …" then "Pebble: …" in one message
// to an Everyone-responds channel got a reply from Ember only; Pebble's part
// was never answered and nothing said why.
describe("a message with a part for each bot", () => {
  it("addresses every bot that opens a line with its name", () => {
    expect(ids("Moss: check the sensor.\nSable: write a 300-word history of maps")).toEqual(["moss", "sable"]);
    expect(ids("Moss, check the sensor\n\nPixel, draw the logo")).toEqual(["moss", "pixel"]);
    expect(ids("Quick ones today.\nSable: summary please")).toEqual(["sable"]);
  });

  it("addresses a later sentence that opens with a name and a colon", () => {
    expect(ids("Moss: check the sensor. Sable: write the history.")).toEqual(["moss", "sable"]);
  });

  it("still treats a name inside a sentence as a reference", () => {
    expect(ids("Moss: check the sensor. Sable wrote the history.")).toEqual(["moss"]);
    expect(ids("Moss: check the sensor\nand ask Sable later")).toEqual(["moss"]);
  });

  it("ignores names inside pasted code or a quote (audit)", () => {
    expect(ids("Sable, summarize this log:\n```\nMoss: restart the service\n```")).toEqual(["sable"]);
    expect(ids("Sable, what do you make of this?\n> Moss: restart the service")).toEqual(["sable"]);
  });

  it("routes an Everyone-responds room to both", () => {
    expect(roomResponders("Moss: check the sensor.\nSable: write it up", members, { kind: "everyone" }, undefined, { byName: true }).map((m) => m.id)).toEqual(["moss", "sable"]);
  });
});

// PF: the simulation's later vocatives must reach the named teammates.
describe("PF project vocatives", () => {
  const team = ["Nova", "Reed", "Cole", "Wren", "Ivy", "Juno", "Pax", "Tess", "Quinn"].map(name => ({ id: name, name }));
  it.each([
    ["Marta liked the second headline option best. Juno, write the About page intro (80 to 120 words) in that tone.", ["Juno"]],
    ["Tess, please write a short agenda into AGENDA.md. Quinn, don't redo it, just review it after Tess is done.", ["Tess", "Quinn"]],
    ["Nova, lead this launch. Get Reed on the segments, Cole on the offer and Wren on the copy.", ["Nova"]],
    ["A note. Juno can you check it? Pax please review it.", ["Juno", "Pax"]],
    ["A note. Juno wrote it. Ask Juno later. Juno's report is ready.", []],
    ["Juno, Pax and I met yesterday.", []],
    ["A note. Juno, Pax and I met yesterday.", []],
    ["Pax, my co-founder, wrote it.", []],
    ["Juno, who wrote it, is out today.", []],
    ["Pax, my friend, can you check it?", ["Pax"]],
    ["Pax, the build is failing, fix it", ["Pax"]],
    ["Pax, my tests are red, look at them", ["Pax"]],
    ["Pax, the release notes, check them please.", ["Pax"]],
    ["Pax, our lead designer, runs the review.", []],
    // round 8: a question, or an auxiliary before a pronoun, is a request;
    // an imperative that happens to end in -ed or -s is one too
    ["Pax, the build, is it green?", ["Pax"]],
    ["Pax, my tests, are they passing?", ["Pax"]],
    ["Pax, the deploy, did it work?", ["Pax"]],
    ["Pax, the deploy, did it work", ["Pax"]],
    ["Pax, the release, was that you?", ["Pax"]],
    ["Pax, the code, embed it", ["Pax"]],
    ["Pax, my tests, focus on the flaky one", ["Pax"]],
    ["Pax, the logs, shred them.", ["Pax"]],
    ["Pax, my co-founder, used it.", []],
    ["Pax, my co-founder, is out today.", []],
    ["Juno, who wrote it, was it fine?", ["Juno"]],
    // Round 9: about the member, not to them (a question after a relative
    // clause or about he/she, and a reflexive or complement after it/this)
    ["Juno, who wrote it, is she around?", []],
    ["Pax, our designer, is he free tomorrow?", []],
    ["Pax, my co-founder, did it all himself.", []],
    ["Pax, the designer, has this covered.", []],
    // Round 10 (R4): after a relative clause a question about something
    // other than the member is a request, and so is "is it sorted"
    ["Juno, who ran the deploy, did the migration finish?", ["Juno"]],
    ["Juno, who wrote it, is the build green?", ["Juno"]],
    ["Pax, the designer, is it sorted", ["Pax"]],
    ["Juno, who wrote it, are they around?", []],
  ])("routes %s", (text, expected) => {
    expect(addressedMembers(text, team).map(m => m.id)).toEqual(expected);
  });

  // Coordinator (round 8): 20 common verbs after an apposition, each as a
  // request of the member and as a statement about them, so a change to the
  // heuristic that flips any of them shows here.
  const pairs: Array<[request: string, statement: string]> = [
    ["check it", "checked it"], ["fix it", "fixed it"], ["review it", "reviewed it"], ["update it", "updates it weekly"],
    ["send it", "sent it"], ["add it", "added it"], ["test it", "tests it"], ["run it", "runs it"],
    ["push it", "pushed it"], ["merge it", "merged it"], ["deploy it", "deploys it on Fridays"], ["write it", "wrote it"],
    ["draft it", "drafted it"], ["finish it", "finished it"], ["ship it", "ships it"], ["rename it", "renamed it"],
    ["delete it", "deleted it"], ["format them", "formats them"], ["publish it", "published it"], ["book it", "booked it"],
  ];
  it.each(pairs)("reads \"%s\" as a request and \"%s\" as a statement", (request, statement) => {
    expect(addressedMembers(`Pax, the report, ${request}.`, team).map(m => m.id)).toEqual(["Pax"]);
    expect(addressedMembers(`Pax, our designer, ${statement}.`, team).map(m => m.id)).toEqual([]);
  });
});

it("puts an addressed project lead first while preserving teammate order", () => {
  expect(roomResponders("Moss, check. Sable, coordinate. Pixel, draw.", members, lead, undefined,
    { byName: true, leadFirstBotId: "sable" }).map(m => m.id)).toEqual(["sable", "moss", "pixel"]);
});

it.each([
  ["> quoted text\nMoss, check this", ["moss"]],
  ["```\nexample\n```\nMoss, check this", ["moss"]],
  ["A note. Moss, the designer, wrote the intro.", []],
  ["A note. Moss, a designer, wrote the intro.", []],
])("review addressing: %s", (text, expected) => expect(ids(text as string)).toEqual(expected));
it("merges project mentions and later names in address order", () => {
 expect(roomResponders("@Sable plan this. Moss, write the intro.", members, lead, undefined, {byName:true,leadFirstBotId:"sable"}).map(m=>m.id)).toEqual(["sable","moss"]);
});

it("orders addresses rather than earlier references to the same member",()=>{
 expect(roomResponders("Moss wrote the draft. @Pixel Designer review it. Moss, revise it.",members,lead,undefined,{byName:true}).map(m=>m.id)).toEqual(["pixel","moss"]);
});
