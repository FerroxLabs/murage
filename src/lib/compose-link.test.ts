// 1.0.9 share and ask S41. A compose link only PREFILLS the composer and focuses it; nothing here can send. The words come from a message the
// page already holds, never from the fragment. The io is a spy, so "never sends" is checked by what the module is able to reach.
import { describe, expect, it, vi } from "vitest";

import { en } from "@/locales";
import { applyComposeLink, askAgainFromLine, askAgainText, canEditLine, isPhoneLine, type ComposeIo } from "./compose-link";
import { parseOpenHash } from "./deep-link";

const bot = {
  id: "b1",
  threadId: "t1",
  tasks: [] as Array<{ threadId: string }>,
  messages: [
    { id: "m1", role: "user", kind: "text", text: "<attached-file path=\"/tmp/a.txt\" />\nwhat is in this file?", via: "share" },
    { id: "m2", role: "user", kind: "text", text: "my own words" },
    { id: "m3", role: "bot", kind: "text", text: "a reply" },
  ],
};
const state = (extra: object = {}) => ({ bots: [bot], groups: [], pendingQueued: {}, ...extra }) as unknown as Parameters<typeof applyComposeLink>[1];
const io = (draft = ""): ComposeIo & { set: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> } => {
  const set = vi.fn();
  const focus = vi.fn();
  return { readDraft: () => draft, setDraft: set, focus, set } as never;
};

describe("which lines come from the phone", () => {
  it("marks a line with via, and only that line", () => {
    expect(isPhoneLine({ via: "share" })).toBe(true);
    expect(isPhoneLine({ via: "ask-intent" })).toBe(true);
    expect(isPhoneLine({})).toBe(false);
    expect(canEditLine({ via: "share" })).toBe(false);
    expect(canEditLine({})).toBe(true);
  });
});

describe("the words Ask again offers", () => {
  it("drops attachment tag lines and keeps the words", () => {
    expect(askAgainText("<attached-file path=\"/tmp/a.txt\" />\nwhat is in this file?")).toBe("what is in this file?");
    expect(askAgainText("plain words")).toBe("plain words");
  });
});

describe("compose links", () => {
  it("opens a bot chat and focuses the composer without touching the draft", () => {
    const spy = io();
    expect(applyComposeLink({ botId: "b1", compose: true }, state(), spy)).toBe(true);
    expect(spy.set).not.toHaveBeenCalled();
    expect(spy.focus).toHaveBeenCalledWith("b1");
  });

  it("prefills the composer from a message the page holds, never sends", () => {
    const spy = io();
    applyComposeLink({ threadId: "t1", compose: true, again: "m1" }, state(), spy);
    expect(spy.set).toHaveBeenCalledWith("bot:b1:t1", "what is in this file?");
    expect(spy.focus).toHaveBeenCalledWith("b1");
    expect(Object.keys(spy).sort()).toEqual(["focus", "readDraft", "set", "setDraft"]);
  });

  it("finds a queued chip's text by queueId", () => {
    const spy = io();
    const queued = state({ pendingQueued: { t1: [{ queueId: "q9", text: "queued words" }] } });
    applyComposeLink({ threadId: "t1", compose: true, again: "q9" }, queued, spy);
    expect(spy.set).toHaveBeenCalledWith("bot:b1:t1", "queued words");
  });

  it("keeps words already in the draft and does not repeat itself", () => {
    const spy = io("half typed");
    applyComposeLink({ threadId: "t1", compose: true, again: "m2" }, state(), spy);
    expect(spy.set).toHaveBeenCalledWith("bot:b1:t1", "half typed\n\nmy own words");
    const twice = io("my own words");
    applyComposeLink({ threadId: "t1", compose: true, again: "m2" }, state(), twice);
    expect(twice.set).not.toHaveBeenCalled();
  });

  it("ignores an id the page does not hold or that is not the owner's text, and never copies the fragment into the draft", () => {
    for (const again of ["nope", "m3", "<script>alert(1)</script>"]) {
      const spy = io();
      applyComposeLink({ threadId: "t1", compose: true, again }, state(), spy);
      expect(spy.set).not.toHaveBeenCalled();
    }
    const target = parseOpenHash("#open=t1&compose=1&again=%3Cscript%3E");
    expect(target).toEqual({ threadId: "t1", compose: true, again: "<script>" });
  });

  it("does nothing for a thread or bot this device cannot see", () => {
    const spy = io();
    expect(applyComposeLink({ botId: "ghost", compose: true }, state(), spy)).toBe(false);
    expect(applyComposeLink({ threadId: "ghost", compose: true, again: "m1" }, state(), spy)).toBe(false);
    expect(spy.set).not.toHaveBeenCalled();
    expect(spy.focus).not.toHaveBeenCalled();
  });
});

describe("Ask again on a phone line", () => {
  it("prefills this chat's draft with the words and focuses it", () => {
    const spy = io();
    askAgainFromLine({ text: bot.messages[0]!.text }, { botId: "b1", threadId: "t1" }, spy);
    expect(spy.set).toHaveBeenCalledWith("bot:b1:t1", "what is in this file?");
    expect(spy.focus).toHaveBeenCalledWith("b1");
  });
});

describe("copy", () => {
  it("passes the banned-word and dash checks", () => {
    for (const key of Object.keys(en).filter((k) => k.startsWith("phone.ask.")) as Array<keyof typeof en>) {
      expect(en[key]).not.toMatch(/[–—]|\bsafe|\bunsafe|\bsafety/i);
    }
  });
});
