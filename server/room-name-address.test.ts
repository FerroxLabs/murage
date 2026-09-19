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
  it("lets explicit @mentions and @everyone win over a vocative name", () => {
    expect(roomResponders("Moss, loop in @Sable", members, lead, undefined, { byName: true }).map((m) => m.id)).toEqual(["sable"]);
    expect(roomResponders("Moss, @everyone look", members, lead, undefined, { byName: true }).map((m) => m.id)).toEqual(["sable", "moss", "pixel"]);
  });
  it("prefers the named member over the replied-to member", () => {
    expect(roomResponders("Moss, what do you think?", members, lead, "pixel", { byName: true }).map((m) => m.id)).toEqual(["moss"]);
  });
  it("leaves bot-to-bot mention chaining unchanged: a bot's plain-name reference summons nobody", () => {
    expect(roomResponders("Moss, good point.", members, { kind: "mentions" })).toEqual([]);
  });
});
