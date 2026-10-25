import { describe, expect, it } from "vitest";

import { replyAuthor, replySnippet } from "./replies";
import type { Message } from "@/state/store";

const base: Message = { id: "m1", at: 1, role: "bot", kind: "text", text: "hello" };

describe("reply display", () => {
  it("uses human labels and member attribution", () => {
    expect(replyAuthor({ ...base, role: "user" })).toBe("You");
    expect(replyAuthor({ ...base, from: { botId: "b", name: "Scout", color: "green" } })).toBe("Scout");
    expect(replyAuthor(base, "Mochi")).toBe("Mochi");
  });

  it("turns saved images into a readable bounded snippet", () => {
    expect(replySnippet('<attached-image path="/tmp/a.png" /> hi\nthere')).toBe("[image] hi there");
    expect(replySnippet("123456", 5)).toBe("1234…");
  });
});

import { escapeCancelsReply, replyExcerpt } from "./replies";
describe("escapeCancelsReply", () => {
  it("cancels on Escape while replying", () => {
    expect(escapeCancelsReply({ key: "Escape" }, { replying: true, recording: false })).toBe(true);
  });
  it("leaves Escape alone while composing text, recording, or with no reply", () => {
    expect(escapeCancelsReply({ key: "Escape", isComposing: true }, { replying: true, recording: false })).toBe(false);
    expect(escapeCancelsReply({ key: "Escape" }, { replying: true, recording: true })).toBe(false);
    expect(escapeCancelsReply({ key: "Escape" }, { replying: false, recording: false })).toBe(false);
    expect(escapeCancelsReply({ key: "a" }, { replying: true, recording: false })).toBe(false);
  });
});
describe("replyExcerpt", () => {
  it("strips links, emphasis, code and headings", () => {
    expect(replyExcerpt("## Plan\nSee [the doc](https://x.test) for **bold** and `code`")).toBe("Plan See the doc for bold and code");
  });
});
