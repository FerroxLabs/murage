import { describe, expect, it } from "vitest";
import type { Bot } from "@/state/store";
import { roomAuthor } from "./room-author";

const bot = (id: string, name: string) => ({ id, name, color: "orange" }) as unknown as Bot;

describe("roomAuthor", () => {
  const sable = bot("sable", "Sable");
  const moss = bot("moss", "Moss");
  const bruce = bot("bruce", "Bruce");

  it("finds a member", () => {
    expect(roomAuthor("moss", [sable, moss], [sable, moss, bruce])).toBe(moss);
  });

  it("finds a bot that posted in the room without being a member, such as a delegated teammate", () => {
    expect(roomAuthor("bruce", [sable, moss], [sable, moss, bruce])).toBe(bruce);
  });

  it("prefers the member record when both lists carry the bot", () => {
    const roomCopy = bot("moss", "Moss (room)");
    expect(roomAuthor("moss", [roomCopy], [moss])).toBe(roomCopy);
  });

  it("returns nothing for an unknown or missing id", () => {
    expect(roomAuthor("gone", [sable], [sable, moss])).toBeUndefined();
    expect(roomAuthor(undefined, [sable], [sable])).toBeUndefined();
  });
});
