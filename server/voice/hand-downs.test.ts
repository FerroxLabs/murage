import { describe, expect, it } from "vitest";

import { handDownResult, handDownStatus, parseHandDowns, sameRequest, type HandDown } from "./hand-downs.ts";
import { historyMessages, runVoiceHostTurn, type VoiceHostEvent } from "./voice-host.ts";
import type { Message } from "../store.ts";

const T = 1_790_000_000_000;
let n = 0;
const msg = (m: Partial<Message>): Message => ({ id: `m${(n += 1)}`, at: T, role: "bot", kind: "text", ...m }) as Message;
const hd = (over: Partial<HandDown> = {}): HandDown => ({ id: "h1", request: "AI news from the last 72 hours", at: T, state: "accepted", ...over });

describe("what became of a hand-down", () => {
  const asked = msg({ role: "user", text: "AI news from the last 72 hours", at: T + 100 });

  it("refused and cancelled come from the call screen", () => {
    expect(handDownStatus(hd({ state: "refused", reason: "No model connected." }), [], false)).toEqual({ kind: "failed", reason: "No model connected." });
    expect(handDownStatus(hd({ state: "cancelled" }), [asked], true)).toEqual({ kind: "cancelled" });
  });

  it("not in the thread yet is starting; with the bot busy on it, running with its steps", () => {
    expect(handDownStatus(hd({ state: "sending" }), [], false)).toEqual({ kind: "starting" });
    const path = [asked, msg({ kind: "activity", tool: { name: "WebSearch", spoken: "searching the web" } as any, at: T + 200 })];
    expect(handDownStatus(hd(), path, true)).toEqual({ kind: "running", steps: ["searching the web"] });
  });

  it("an error step ends it as failed; a reply ends it as done, in full", () => {
    const failed = [asked, msg({ kind: "activity", at: T + 200, tool: { name: "error: API error (status 429)", ok: false, errorDetails: "Free usage exhausted." } as any })];
    expect(handDownStatus(hd(), failed, false)).toEqual({ kind: "failed", reason: "Free usage exhausted." });
    const long = "Item. ".repeat(500);
    expect(handDownStatus(hd(), [asked, msg({ text: long, at: T + 300 })], false)).toEqual({ kind: "done", answer: long.trim() });
  });

  it("an older message with the same words is not this hand-down", () => {
    const old = msg({ role: "user", text: "AI news from the last 72 hours", at: T - 3_600_000 });
    expect(handDownStatus(hd(), [old, msg({ text: "Old news." })], false)).toEqual({ kind: "starting" });
  });

  it("a running result tells the model not to hand it down again (Pipecat's wording)", () => {
    expect(handDownResult({ kind: "running", steps: [] })).toContain("Do not hand it down again and do not invent a result");
  });

  it("parses only well-formed entries", () => {
    expect(parseHandDowns([{ id: "ok-1", request: "x", at: 1, state: "accepted" }, { id: "bad id!", request: "x" }, "junk"])).toHaveLength(1);
  });

  it("recognises the same work in different words", () => {
    expect(sameRequest("I'd like the latest AI news from the last 72 hours", "latest AI news last 72 hours")).toBe(true);
    expect(sameRequest("Book a table for two at eight", "latest AI news last 72 hours")).toBe(false);
  });
});

describe("hand-downs in the host's context", () => {
  it("become a tool call answered by the work's status", () => {
    const messages = historyMessages(
      [
        { role: "owner", text: "AI news please" },
        { role: "host", text: "Let me look into that.", handDown: { id: "h1", request: "AI news" } },
      ],
      { h1: "This failed and nothing is running for it: No model connected." },
    );
    expect(messages[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "h1", function: { name: "hand_down" } }] });
    expect(messages[2]).toEqual({ role: "tool", tool_call_id: "h1", content: "This failed and nothing is running for it: No model connected." });
  });

  it("the same work still running is refused in code, not handed down twice", async () => {
    const fetchImpl = (async () => {
      const frames = [{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "hand_down", arguments: '{"request":"latest AI news last 72 hours"}' } }] } }] }];
      return new Response(`${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200 });
    }) as typeof fetch;
    const events: VoiceHostEvent[] = [];
    for await (const e of runVoiceHostTurn({
      state: { botName: "Sable", now: T, task: { title: "", busy: true, activity: [] }, recent: [], otherTasks: [], needsYou: [] },
      history: [],
      said: "are you doing it?",
      host: { via: "xai", label: "xAI", baseUrl: "http://x.invalid/v1", key: "k", model: "m" },
      running: ["I'd like the latest AI news from the last 72 hours"],
      fetchImpl,
    }))
      events.push(e);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "hand_down" }));
    expect(events).toContainEqual({ type: "sentence", text: "That's already under way." });
  });
});
