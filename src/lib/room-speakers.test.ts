// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { replyingToName, roomReplyTargets, startsBotTurn } from "./room-speakers";

let clock = 0;
const user = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text, at: ++clock, ...extra });
const said = (id: string, botId: string, text: string, extra: Partial<Message> = {}): Message => ({
  id, role: "bot", kind: "text", text, at: ++clock, from: { botId, name: botId[0].toUpperCase() + botId.slice(1), color: "orange" }, ...extra,
});
const tool = (id: string, botId: string | undefined, name: string, extra: Partial<Message> = {}): Message => ({
  id, role: "bot", kind: "activity", tool: { name, ok: true }, at: ++clock,
  ...(botId ? { from: { botId, name: botId[0].toUpperCase() + botId.slice(1), color: "orange" as const } } : {}), ...extra,
});

describe("startsBotTurn", () => {
  it("names a bot's reply after a user message", () => {
    expect(startsBotTurn(user("u", "hi"), said("a", "dax", "hello"))).toBe(true);
  });

  it("names every consecutive reply, including the same bot answering twice in a row", () => {
    expect(startsBotTurn(said("a", "dax", "one"), said("b", "dax", "two"))).toBe(true);
    expect(startsBotTurn(said("a", "finch", "one"), said("b", "dax", "two"))).toBe(true);
  });

  it("names a tool-only row that opens a turn", () => {
    expect(startsBotTurn(user("u", "go"), tool("t", "dax", "read_file"))).toBe(true);
    expect(startsBotTurn(said("a", "finch", "done"), tool("t", "dax", "read_file"))).toBe(true);
  });

  it("a tool row right after the same bot's words is that turn (the engine said it, then did it)", () => {
    expect(startsBotTurn(said("a", "dax", "Let me check"), tool("t", "dax", "Bash"))).toBe(false);
  });

  it("does not repeat the name inside one turn: tools, then the reply", () => {
    expect(startsBotTurn(tool("t", "dax", "read_file"), said("a", "dax", "done"))).toBe(false);
    expect(startsBotTurn(tool("t", "dax", "read_file"), tool("t2", "dax", "grep"))).toBe(false);
  });

  it("uses provider turn ids when both rows carry one", () => {
    expect(startsBotTurn(tool("t", "dax", "read_file", { turnId: "1" }), said("a", "dax", "x", { turnId: "2" }))).toBe(true);
    expect(startsBotTurn(said("n", "dax", "narration", { turnId: "1" }), said("a", "dax", "x", { turnId: "1" }))).toBe(false);
  });

  it("has nothing to name on a row with no sender", () => {
    expect(startsBotTurn(user("u", "hi"), tool("t", undefined, "Delegated to @Dax"))).toBe(false);
    expect(startsBotTurn(said("a", "dax", "x"), user("u", "hi"))).toBe(false);
  });
});

describe("roomReplyTargets", () => {
  it("a reply answers the owner message that started its round", () => {
    const messages = [user("u1", "What is up?"), said("f1", "finch", "Not much")];
    expect(roomReplyTargets(messages).get("f1")?.id).toBe("u1");
  });

  it("with everyone answering, the second bot answers the owner, not the first bot", () => {
    const messages = [user("u1", "Status please"), said("f1", "finch", "Fine"), said("d1", "dax", "Also fine")];
    expect(roomReplyTargets(messages).get("d1")?.id).toBe("u1");
  });

  it("a chained @mention answers the bot that mentioned it", () => {
    const messages = [user("u1", "Plan it"), said("f1", "finch", "@Dax can you draft the copy?"), said("d1", "dax", "Drafted")];
    expect(roomReplyTargets(messages).get("d1")?.id).toBe("f1");
  });

  it("an @everyone in a bot reply counts as a mention", () => {
    const messages = [user("u1", "Plan it"), said("f1", "finch", "@everyone sound off"), said("d1", "dax", "Here")];
    expect(roomReplyTargets(messages).get("d1")?.id).toBe("f1");
  });

  it("every row of a turn shares its target: tools first, then the reply", () => {
    const messages = [user("u1", "Check the logs"), tool("t1", "dax", "read_file"), said("d1", "dax", "Logs are clean")];
    const targets = roomReplyTargets(messages);
    expect(targets.get("t1")?.id).toBe("u1");
    expect(targets.get("d1")?.id).toBe("u1");
  });

  it("a queued owner line does not count until it is sent", () => {
    const messages = [user("u1", "First"), user("u2", "Second", { queued: true }), said("f1", "finch", "About the first")];
    expect(roomReplyTargets(messages).get("f1")?.id).toBe("u1");
  });

  it("a steer sent into the turn is not what the turn answers", () => {
    const messages = [user("u1", "First"), tool("t1", "finch", "grep"), user("s1", "also this", { steered: true }), said("f1", "finch", "Done")];
    expect(roomReplyTargets(messages).get("f1")?.id).toBe("u1");
  });

  it("a delegation result answers the bot that delegated", () => {
    const messages = [
      user("u1", "Ship the page"),
      tool("c1", undefined, "Delegated to @Dax: build the page"),
      said("f1", "finch", "I have asked Dax to build it"),
      said("r1", "dax", "@Dax replied to the delegated task:\n\nBuilt"),
    ];
    expect(roomReplyTargets(messages).get("r1")?.id).toBe("f1");
  });

  it("a delegation result with only the chip left points at the chip's bot turn", () => {
    const messages = [
      user("u1", "Ship the page"),
      said("f0", "finch", "On it"),
      tool("c1", "finch", "Delegated to @Dax"),
      said("r1", "dax", "@Dax replied to the delegated task:\n\nBuilt"),
    ];
    expect(roomReplyTargets(messages).get("r1")?.id).toBe("f0");
  });

  it("a stored replyToId wins over any guess", () => {
    const messages = [user("u1", "One"), user("u2", "Two"), said("f1", "finch", "About one", { replyToId: "u1" })];
    expect(roomReplyTargets(messages).get("f1")?.id).toBe("u1");
  });

  it("a stored replyToId on the owner's line is left to the owner's own quote", () => {
    const messages = [said("f1", "finch", "Hi"), user("u1", "Hi back", { replyToId: "f1" })];
    expect(roomReplyTargets(messages).has("u1")).toBe(false);
  });

  it("the same bot speaking again with nothing new in between has no target", () => {
    const messages = [said("f1", "finch", "Hello"), said("f2", "finch", "Still here")];
    expect(roomReplyTargets(messages).has("f2")).toBe(false);
  });
});

describe("roomReplyTargets, audit round 1", () => {
  it("a chained reply's own @mention summons nobody (one hop, as the server routes)", () => {
    const messages = [
      user("u1", "@everyone ideas?"),
      said("f1", "finch", "@Dax your take?"),
      said("d1", "dax", "Ask @Moss"),
      said("m1", "moss", "Here is mine"),
    ];
    const targets = roomReplyTargets(messages);
    expect(targets.get("d1")?.id).toBe("f1");
    expect(targets.get("m1")?.id).toBe("u1");
  });

  it("a mention resolves against the whole roster: @Dax Research is not @Dax", () => {
    const messages = [
      user("u1", "Go"),
      said("f1", "finch", "@Dax Research please dig in"),
      said("d1", "dax", "Me?"),
    ];
    const roster = [{ name: "Dax" }, { name: "Dax Research" }, { name: "Finch" }];
    expect(roomReplyTargets(messages, roster).get("d1")?.id).toBe("u1");
  });

  it("a late delegation result never points at the delegator's answer to a newer request", () => {
    const messages = [
      user("u1", "Ship the page"),
      tool("c1", "finch", "Delegated to @Dax"),
      user("u2", "Also, the date?"),
      said("f2", "finch", "Friday"),
      said("r1", "dax", "@Dax replied to the delegated task:\n\nBuilt"),
    ];
    expect(roomReplyTargets(messages).get("r1")?.id).not.toBe("f2");
  });

  it("a chip for @Daxter is not a delegation to Dax", () => {
    const messages = [
      user("u1", "Go"),
      said("f0", "finch", "Asking"),
      tool("c1", "finch", "Delegated to @Daxter"),
      said("r1", "dax", "@Dax replied to the delegated task:\n\nDone"),
    ];
    expect(roomReplyTargets(messages).has("r1")).toBe(false);
  });

  it("never points at a delegation chip, which tool calls off would hide", () => {
    const messages = [
      user("u1", "Ship the page"),
      tool("c1", undefined, "Delegated to @Dax"),
      said("r1", "dax", "@Dax replied to the delegated task:\n\nBuilt"),
    ];
    expect(roomReplyTargets(messages).get("r1")?.id).not.toBe("c1");
  });

  it("a stored replyToId outside the held page is still authoritative: no guess", () => {
    const messages = [user("u2", "Two"), said("f1", "finch", "About one", { replyToId: "u1" }), tool("t1", "finch", "grep")];
    const targets = roomReplyTargets(messages);
    expect(targets.has("f1")).toBe(false);
    expect(targets.has("t1")).toBe(false);
  });
});

describe("replyingToName", () => {
  it("names the owner as you and a bot by name", () => {
    expect(replyingToName(user("u", "x"))).toBe("you");
    expect(replyingToName(said("d", "dax", "x"))).toBe("Dax");
  });
});
