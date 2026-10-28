// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 phone tools S18 (H4, F18): the canonical event log withholds a phone thread's reply text and every phone tool row's
// input and result, while live delivery keeps the words.
import { describe, expect, it } from "vitest";
import { EventBus, PHONE_RESULT_WITHHELD, PHONE_TEXT_WITHHELD } from "./bus.ts";
import { makePhoneToolMatcher } from "../phones/withhold.ts";
import { eventLogLimits } from "./event-log.ts";

const text = (threadId: string, words: string) => ({ kind: "runtime", provider: "fakeAsk", eventId: `e-${words.length}`, createdAt: "2026-10-26T00:00:00Z", threadId, type: "item.completed", itemType: "assistant_text", origin: "engine", text: words }) as never;
const started = (threadId: string, itemId: string, name: string, input: unknown) => ({ provider: "fakeAsk", eventId: `s-${itemId}`, createdAt: "2026-10-26T00:00:00Z", threadId, itemId, type: "item.started", itemType: "tool", origin: "engine", title: name, input, toolIdentity: { namespace: "phoneJobs", name } }) as never;
const done = (threadId: string, itemId: string, result: unknown) => ({ provider: "fakeAsk", eventId: `c-${itemId}`, createdAt: "2026-10-26T00:00:00Z", threadId, itemId, type: "item.completed", itemType: "tool", ok: true, result, detail: "Dr Lee at 9" }) as never;

const rig = (marked: string[]) => {
  const writes: string[] = [];
  const bus = new EventBus(((_file: string, data: string) => { writes.push(data); }) as never);
  bus.withholdText({ thread: (id) => marked.includes(id), phoneTool: makePhoneToolMatcher() });
  const delivered: any[] = [];
  bus.subscribe((event: any) => { delivered.push(event); }, { durable: false });
  return { bus, writes, delivered, log: () => writes.join("") };
};

describe("the event log and a phone thread (S18)", () => {
  it("withholds a marked thread's assistant text on disk and delivers it intact", () => {
    const { bus, log, delivered } = rig(["t-marked"]);
    bus.publish(text("t-marked", "Dr Lee at nine"));
    expect(log()).toContain(PHONE_TEXT_WITHHELD);
    expect(log()).not.toContain("Dr Lee");
    expect(delivered.some((e) => e.text === "Dr Lee at nine")).toBe(true);
  });
  it("leaves an unmarked thread's text unchanged", () => {
    const { bus, log } = rig(["t-marked"]);
    bus.publish(text("t-plain", "an ordinary reply"));
    expect(log()).toContain("an ordinary reply");
  });
  it("withholds a phone tool's input and result with the summary row only, on any thread", () => {
    const { bus, log, delivered } = rig([]);
    bus.publish(started("t-plain", "i1", "phone_calendar_read", { start: "2026-10-26", notes: "secret" }));
    bus.publish(done("t-plain", "i1", { events: [{ title: "Dr Lee" }] }));
    expect(log()).toContain(PHONE_RESULT_WITHHELD);
    expect(log()).toContain("phone_calendar_read");
    expect(log()).not.toContain("Dr Lee");
    expect(log()).not.toContain("secret");
    expect(delivered.some((e) => JSON.stringify(e).includes("Dr Lee"))).toBe(true);
  });
  it("leaves a non-phone tool row alone on an unmarked thread", () => {
    const { bus, log } = rig(["t-marked"]);
    bus.publish({ provider: "fakeAsk", eventId: "s", createdAt: "x", threadId: "t-plain", itemId: "z", type: "item.started", itemType: "tool", origin: "engine", title: "read_file", input: { path: "a.txt" } } as never);
    bus.publish(done("t-plain", "z", { body: "file words" }));
    expect(log()).toContain("file words");
  });
  it("never writes content.delta for either thread", () => {
    const { bus, log } = rig(["t-marked"]);
    for (const id of ["t-marked", "t-plain"]) bus.publish({ provider: "fakeAsk", eventId: `d-${id}`, createdAt: "x", threadId: id, type: "content.delta", streamKind: "assistant_text", delta: "streamed words" } as never);
    expect(log()).not.toContain("streamed words");
  });
  it("withholds a record over the size limit too (withhold runs before boundedRecord)", () => {
    const { bus, log } = rig(["t-marked"]);
    bus.publish(text("t-marked", "Dr Lee ".repeat(Math.ceil(eventLogLimits.recordBytes / 6))));
    expect(log()).toContain(PHONE_TEXT_WITHHELD);
    expect(log()).not.toContain("Dr Lee");
  });

  it("withholds every tool row of a marked thread, not only phone tools (H1 gap 2)", () => {
    const { bus, log, delivered } = rig(["t-marked"]);
    bus.publish({ provider: "fakeAsk", eventId: "s", createdAt: "x", threadId: "t-marked", itemId: "w", type: "item.started", itemType: "tool", origin: "engine", title: "WebSearch Dr Lee clinic 3pm", summary: "search Dr Lee", input: { query: "Dr Lee clinic 3pm" } } as never);
    bus.publish({ ...(done("t-marked", "w", { hits: ["Lee Clinic"] }) as object), detail: "Lee Clinic hit", summary: "Lee summary" } as never);
    expect(log()).toContain(PHONE_RESULT_WITHHELD);
    expect(log()).not.toContain("Lee");
    expect(log()).not.toContain("3pm");
    expect(delivered.some((e) => JSON.stringify(e).includes("Lee Clinic"))).toBe(true);
  });
  it("keeps a second call built from the first call's result out of the log (marked thread)", () => {
    const { bus, log } = rig(["t-marked"]);
    bus.publish(started("t-marked", "a", "phone_contacts_search", { query: "Sam" }));
    bus.publish(done("t-marked", "a", { contacts: [{ phones: ["+15551234567"] }] }));
    bus.publish(started("t-marked", "b", "phone_text_compose", { to: ["+15551234567"], body: "running late" }));
    bus.publish({ provider: "fakeAsk", eventId: "s2", createdAt: "x", threadId: "t-marked", itemId: "c", type: "item.started", itemType: "tool", origin: "engine", title: "Bash", input: { command: "echo +15551234567" } } as never);
    expect(log()).not.toContain("5551234567");
    expect(log()).not.toContain("running late");
  });
  const ask = (threadId: string, tool: string, extra: object = {}) => ({ provider: "fakeAsk", eventId: `r-${tool}-${threadId}`, createdAt: "x", threadId, type: "request.opened", requestType: "permission", tool, summary: "text +15551234567 running late", toolInput: "{\"to\":[\"+15551234567\"]}", toolCall: { name: tool, input: { to: ["+15551234567"] } }, choices: ["Allow +15551234567"], ...extra }) as never;
  it("withholds a phone tool's permission ask on any thread (H1 gap 1)", () => {
    const { bus, log, delivered } = rig([]);
    bus.publish(ask("t-plain", "mcp__phoneJobs__phone_text_compose"));
    expect(log()).toContain("mcp__phoneJobs__phone_text_compose");
    expect(log()).not.toContain("5551234567");
    expect(log()).not.toContain("running late");
    expect(delivered.some((e) => JSON.stringify(e).includes("5551234567"))).toBe(true);
  });
  it("withholds every permission ask on a marked thread and keeps other asks on a plain thread", () => {
    const { bus, log } = rig(["t-marked"]);
    bus.publish(ask("t-marked", "Bash"));
    expect(log()).not.toContain("5551234567");
    expect(log()).toContain("Bash");
    bus.publish(ask("t-plain", "Bash", { summary: "plain ask words" }));
    expect(log()).toContain("plain ask words");
  });
  it("withholds a completed phone-tool row whose start was never seen (H1 gap 3)", () => {
    const { bus, log } = rig(["t-marked"]);
    bus.publish(done("t-marked", "orphan", { events: [{ title: "Dr Lee" }] }));
    expect(log()).not.toContain("Dr Lee");
    expect(log()).toContain(PHONE_RESULT_WITHHELD);
  });
  it("withholds a marked thread's reasoning row, title, summary and input (N2)", () => {
    const { bus, log, delivered } = rig(["t-marked", ]);
    const reasoning = (threadId: string) => ({ provider: "fakeAsk", eventId: `rs-${threadId}`, createdAt: "x", threadId, itemId: "r1", type: "item.started", itemType: "reasoning", title: "Thinking about Sam", summary: "Sam is +15551234567", input: { thought: "text Sam +15551234567" }, raw: { note: "Sam +15551234567" } }) as never;
    bus.publish(reasoning("t-marked"));
    expect(log()).toContain(PHONE_RESULT_WITHHELD);
    expect(log()).not.toContain("5551234567");
    expect(log()).not.toContain("Sam");
    expect(delivered.some((e) => JSON.stringify(e).includes("5551234567"))).toBe(true);
    bus.publish({ ...(reasoning("t-plain") as object), eventId: "rs-plain", summary: "plain thinking" } as never);
    expect(log()).toContain("plain thinking");
  });
  it("withholds a marked thread's async question text and keeps its shape (N2)", () => {
    const { bus, log, delivered } = rig(["t-marked"]);
    const q = (threadId: string) => ({ provider: "fakeAsk", eventId: `q-${threadId}`, createdAt: "x", threadId, type: "question.async", questions: [{ id: "q1", question: "Text Sam at +15551234567?", header: "Sam", options: [{ label: "Yes Sam" }], multiSelect: false, allowOther: true }] }) as never;
    bus.publish(q("t-marked"));
    expect(log()).toContain("question.async");
    expect(log()).toMatch(/"id":"q-[0-9a-f]{16}"/);
    expect(log()).not.toContain('"id":"q1"');
    expect(log()).not.toContain("5551234567");
    expect(log()).not.toContain("Sam");
    expect(delivered.some((e) => JSON.stringify(e).includes("5551234567"))).toBe(true);
    bus.publish({ ...(q("t-plain") as object), eventId: "q-plain", questions: [{ id: "q2", question: "plain question words", options: [], multiSelect: false, allowOther: false }] } as never);
    expect(log()).toContain("plain question words");
  });

  const base = (threadId: string, type: string, extra: object) => ({ provider: "fakeAsk", eventId: `x-${type}-${threadId}`, createdAt: "2026-10-26T00:00:00Z", threadId, turnId: "turn-1", type, ...extra }) as never;
  it("withholds a marked thread's plan, subtask and runtime error text and keeps their shape (r3)", () => {
    const { bus, log, delivered } = rig(["t-marked"]);
    bus.publish(base("t-marked", "plan.updated", { entries: [{ content: "Text Sam at +15551234567 about Friday", status: "pending", priority: "high" }] }));
    const sub = { id: "sub-1", label: "Find Sam's number in contacts", status: "running", startedAt: 1, toolCount: 2 };
    bus.publish(base("t-marked", "turn.subtask", { subtask: sub, subtasks: [sub] }));
    bus.publish(base("t-marked", "runtime.error", { message: "phone_contacts_search failed for Sam", details: { stderr: "Sam +15551234567" } }));
    expect(log()).not.toContain("Sam");
    expect(log()).not.toContain("5551234567");
    expect(log()).not.toContain("Friday");
    expect(log()).toContain("plan.updated");
    expect(log()).toContain("turn.subtask");
    expect(log()).toContain("runtime.error");
    expect(log()).toContain("sub-1");
    expect(log()).toContain("pending");
    expect(delivered.some((e) => JSON.stringify(e).includes("Find Sam"))).toBe(true);
  });
  it("withholds every string of an event type nobody listed, on a marked thread (r3 deny by default)", () => {
    const { bus, log } = rig(["t-marked"]);
    bus.publish(base("t-marked", "invented.future-event", { note: "Sam is at +15551234567", nested: { deep: [{ words: "text Sam" }] }, count: 7, flag: true }));
    expect(log()).toContain("invented.future-event");
    expect(log()).not.toContain("Sam");
    expect(log()).not.toContain("5551234567");
    expect(log()).toContain("\"count\":7");
    expect(log()).toContain("\"flag\":true");
  });
  it("keeps the allowlisted structural fields on a marked thread (r3)", () => {
    const { bus, log } = rig(["t-marked"]);
    bus.publish({ provider: "fakeAsk", eventId: "keep-1", createdAt: "2026-10-26T00:00:00Z", threadId: "t-marked", turnId: "turn-9", itemId: "item-9", type: "item.started", itemType: "tool", origin: "engine", title: "Bash echo Sam", input: { command: "echo Sam" }, toolKind: "execute", toolIdentity: { namespace: "shell", name: "Bash", kind: "execute" } } as never);
    const line = JSON.parse(log().trim().split("\n").pop() as string);
    expect(line).toMatchObject({ eventId: "keep-1", createdAt: "2026-10-26T00:00:00Z", threadId: "t-marked", turnId: "turn-9", itemId: "item-9", type: "item.started", itemType: "tool", origin: "engine", toolKind: "execute", toolIdentity: { namespace: "shell", name: "Bash", kind: "execute" } });
    expect(log()).not.toContain("echo Sam");
  });
  it("drops the raw engine frame of a marked thread, even its structural-looking keys (r4)", () => {
    const { bus, log, delivered } = rig(["t-marked"]);
    bus.publish(base("t-marked", "invented.future-event", { raw: { id: "Sam +15551234567", status: "text Sam", kind: "Sam" } }));
    expect(log()).not.toContain("Sam");
    expect(log()).not.toContain("\"raw\"");
    expect(delivered.some((e) => e.raw?.id === "Sam +15551234567")).toBe(true);
  });
  it("leaves an unmarked thread's plan, subtask, error and unknown events as they are (r3)", () => {
    const { bus, log } = rig(["t-marked"]);
    bus.publish(base("t-plain", "plan.updated", { entries: [{ content: "plain plan words", status: "pending" }] }));
    bus.publish(base("t-plain", "turn.subtask", { subtask: { id: "s", label: "plain subtask words", status: "done", startedAt: 1, toolCount: 0 }, subtasks: [] }));
    bus.publish(base("t-plain", "runtime.error", { message: "plain error words" }));
    bus.publish(base("t-plain", "invented.future-event", { note: "plain note words" }));
    for (const w of ["plain plan words", "plain subtask words", "plain error words", "plain note words"]) expect(log()).toContain(w);
  });
  it("replaces a marked thread's question ids with a stable stand-in on disk and delivers the real id live (L-r4)", () => {
    const { bus, log, delivered } = rig(["t-marked"]);
    const ask = (threadId: string, eventId: string) => ({ provider: "fakeAsk", eventId, createdAt: "2026-10-26T00:00:00Z", threadId, type: "question.async", origin: "engine",
      questions: [{ id: "confirm_text_to_sam", question: "Text Sam?", options: [], multiSelect: false, allowOther: false }] }) as never;
    bus.publish(ask("t-marked", "q1"));
    bus.publish(ask("t-marked", "q2"));
    expect(log()).not.toContain("confirm_text_to_sam");
    const ids = log().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r: any) => r.type === "question.async").map((r: any) => r.questions[0].id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^q-[0-9a-f]{16}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(delivered.find((e) => e.type === "question.async").questions[0].id).toBe("confirm_text_to_sam");
  });
  it("leaves an unmarked thread's question ids alone (L-r4)", () => {
    const { bus, log } = rig(["t-marked"]);
    bus.publish({ provider: "fakeAsk", eventId: "q3", createdAt: "x", threadId: "t-plain", type: "question.async", origin: "engine", questions: [{ id: "plain_id", question: "ok?", options: [], multiSelect: false, allowOther: false }] } as never);
    expect(log()).toContain("plain_id");
  });
});
