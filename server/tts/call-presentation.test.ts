import { describe, expect, it } from "vitest";
import { mintCallPresentation, readCallPresentation, presentationPrefix, type PresentationFields, type ProtectedPresentation } from "./call-presentation.ts";
import { REST_ON_SCREEN } from "./speech-source.ts";
const identity = { bootId: "boot", callId: "call", threadId: "thread", botId: "bot", generationId: "generation" };
function fields(): PresentationFields {
  return {
    state: { botName: "Bot", now: 1, task: { title: "Task", busy: false, activity: [] }, recent: [], otherTasks: [], needsYou: [] },
    said: "Hello", history: [], results: {}, running: [],
  };
}
describe("D24 protected host presentation snapshot", () => {
  it("red-at-aa73cb96d: presentation prefix checks its final reparse", () => {
    expect(presentationPrefix("Hello. `&co**py**;`", 400)).toBe(REST_ON_SCREEN);
  });
  it("control: presentation prefix only drops a benign tail", () => {
    // Dropping a tail cannot join two retained characters that were separated.
    expect(presentationPrefix("Hello. Good day.", 6)).toBe("Hello.");
  });
  it("M-FR33-1 projects every source-bearing field before any prefix cap", () => {
    const raw = fields();
    const secret = (field: string) => `Safe ${field}. password: ${field}-hunter2`;
    raw.state = {
      botName: secret("name"), description: secret("description"), persona: secret("persona"), houseRules: secret("rules"), now: 1,
      task: { title: secret("task"), busy: true, activity: [secret("spoken"), secret("summary"), secret("tool-name")] },
      recent: [{ who: "bot", text: secret("recent"), at: 1 }, { who: "member", text: secret("other-reply"), name: secret("member-name"), at: 2 }],
      otherTasks: [{ title: secret("other-task"), at: 1 }], needsYou: [{ title: secret("needs-title"), summary: secret("needs-summary"), at: 1 }], approval: secret("approval"),
      room: { name: secret("room"), members: [{ name: secret("member"), description: secret("member-description") }], working: secret("working"), heard: [{ member: secret("heard-member"), owner: secret("heard-owner"), reply: secret("heard-reply") }] },
    };
    raw.history = [{ role: "host", text: "password: " + "padding ".repeat(400) + "tail-hunter2", handDown: { id: "result", request: secret("history-request") } }];
    raw.results = { result: secret("result") }; raw.running = [secret("running")]; raw.answer = secret("answer"); raw.said = secret("said");
    const snapshot = mintCallPresentation(identity, raw, new AbortController().signal, () => true);
    const projected = readCallPresentation(snapshot);
    expect(JSON.stringify(projected)).not.toMatch(/password|hunter2/);
    expect(projected.state.task.activity).toHaveLength(3);
    expect(projected.state.room?.heard).toHaveLength(1);
    expect(presentationPrefix(projected.history[0].text, 500)).not.toContain("padding");
    expect(raw.answer).toContain("hunter2");
  });
  it("refuses forged, cancelled and stale snapshots", () => {
    expect(() => readCallPresentation({ identity, signal: new AbortController().signal } as ProtectedPresentation)).toThrow();
    let live = true; const abort = new AbortController();
    const snapshot = mintCallPresentation(identity, fields(), abort.signal, () => live);
    live = false; expect(() => readCallPresentation(snapshot)).toThrow();
    live = true; abort.abort(); expect(() => readCallPresentation(snapshot)).toThrow();
  });
  it("keeps an immutable closed inventory and distinct ownership", () => {
    const raw = fields(); Object.assign(raw.state, { surprise: "password: hunter2" });
    const a = mintCallPresentation(identity, raw, new AbortController().signal, () => true);
    const b = mintCallPresentation({ ...identity, callId: "other" }, raw, new AbortController().signal, () => true);
    expect(readCallPresentation(a).state).not.toHaveProperty("surprise");
    expect(() => { readCallPresentation(a).state.botName = "changed"; }).toThrow();
    expect(a.identity.callId).not.toBe(b.identity.callId);
    expect(readCallPresentation(b).state.botName).toBe("Bot");
  });
  it("bounds aggregate source and preserves complete Unicode at protected prefix caps", () => {
    const raw = fields(); raw.history = Array.from({ length: 12 }, () => ({ role: "host" as const, text: "x".repeat(100_000) }));
    expect(() => mintCallPresentation(identity, raw, new AbortController().signal, () => true)).toThrow("limit");
    expect(presentationPrefix("a😀z", 2)).toBe("a");
  });
});
