import { describe, expect, it } from "vitest";

import { liveActivityLabel } from "./live-activity";
import type { Message } from "@/state/store";

const activity = (name: string, extra: Partial<NonNullable<Message["tool"]>> = {}): Message => ({
  id: "activity",
  at: 1,
  role: "bot",
  kind: "activity",
  tool: { ...extra, name },
});

describe("liveActivityLabel", () => {
  it("shows thinking before a tool starts and after it settles", () => {
    expect(liveActivityLabel()).toBe("Thinking");
    expect(liveActivityLabel(activity("Read", { ok: true }))).toBe("Thinking");
  });

  it("uses the server's narration for the exact live action", () => {
    expect(liveActivityLabel(activity("Edit", { spoken: "editing a file" }))).toBe(
      "Editing a file",
    );
  });

  it("maps common native and MCP tool names when narration is unavailable", () => {
    expect(liveActivityLabel(activity("Bash: pnpm test"))).toBe("Running a command");
    expect(liveActivityLabel(activity("mcp__computer__click"))).toBe("Using the computer");
    expect(liveActivityLabel(activity("web_search"))).toBe("Searching the web");
    expect(liveActivityLabel(activity("delegate_bot"))).toBe("Handing off a task");
    expect(liveActivityLabel(activity("ask_bot"))).toBe("Asking a teammate");
  });

  it("does not present bot-to-bot communication chips as the active action", () => {
    expect(
      liveActivityLabel({
        ...activity("ask_bot"),
        comm: { groupId: "room", withBotId: "bot", withName: "Peer", withColor: "blue" },
      }),
    ).toBe("Thinking");
  });
});

// Live thinking (0.1.56): the row folded to "Thought" when the answer began
// while the status line kept saying "Thinking Ns"; before that both said
// "Thinking". One place says it at a time.
describe("turnStatusLabel", () => {
  it("leaves thinking to the thinking row while it is shown and the model is still thinking", async () => {
    const { turnStatusLabel } = await import("./live-activity");
    expect(turnStatusLabel("Thinking", { answering: false, thinkingRow: true })).toBe("");
    // no row (Tool calls off, or no reasoning yet): the status says it
    expect(turnStatusLabel("Thinking", { answering: false, thinkingRow: false })).toBe("Thinking");
  });

  it("says the bot is answering once answer text streams, row or not", async () => {
    const { turnStatusLabel } = await import("./live-activity");
    expect(turnStatusLabel("Thinking", { answering: true, thinkingRow: true })).toBe("Answering");
    expect(turnStatusLabel("Thinking", { answering: true, thinkingRow: false })).toBe("Answering");
  });

  it("keeps a tool's own verb or a wait above both", async () => {
    const { turnStatusLabel } = await import("./live-activity");
    expect(turnStatusLabel("Reading a file", { answering: false, thinkingRow: true })).toBe("Reading a file");
    expect(turnStatusLabel("Reading a file", { answering: true, thinkingRow: true })).toBe("Reading a file");
  });

  it("counts the model as thinking only while it has neither text nor a tool running", async () => {
    const { modelStillThinking } = await import("./live-activity");
    expect(modelStillThinking("Thinking", false)).toBe(true);
    expect(modelStillThinking("Thinking", true)).toBe(false);
    expect(modelStillThinking("Reading a file", false)).toBe(false);
  });
});
