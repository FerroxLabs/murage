// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 phone tools S18 (H4, F18): the canonical event log withholds a phone thread's reply text and every phone tool row's
// input and result, while live delivery keeps the words.
import { describe, expect, it } from "vitest";
import { EventBus, PHONE_RESULT_WITHHELD, PHONE_TEXT_WITHHELD } from "./bus.ts";
import { makePhoneToolMatcher } from "../phones/withhold.ts";
import { eventLogLimits } from "./event-log.ts";
import { PHONE_TOOL_NAMES } from "../../shared/phone-jobs-contract.ts";
import { ERROR_LOGGED_MESSAGE, REPLY_LOGGED_TEXT } from "../runtime-event-out.ts";

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
  // ql2 sink fold (was "leaves an unmarked thread's text unchanged", the words on disk): every thread's reply is the fixed reply
  // label now; an unmarked thread gets that label, not the phone stand-in
  it("writes an unmarked thread's reply as the reply label, not the phone stand-in", () => {
    const { bus, log } = rig(["t-marked"]);
    bus.publish(text("t-plain", "an ordinary reply"));
    expect(log()).not.toContain("an ordinary reply");
    expect(log()).toContain(REPLY_LOGGED_TEXT);
    expect(log()).not.toContain(PHONE_TEXT_WITHHELD);
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
  // ql2 sink fold (was: the result's "file words" on disk): an unmarked thread's non-phone tool row is the allowlisted row (ids,
  // ok), never the phone stand-in, and its result is not written (Astra r1 H9)
  it("leaves a non-phone tool row unwithheld on an unmarked thread", () => {
    const { bus, log } = rig(["t-marked"]);
    bus.publish({ provider: "fakeAsk", eventId: "s", createdAt: "x", threadId: "t-plain", itemId: "z", type: "item.started", itemType: "tool", origin: "engine", title: "read_file", input: { path: "a.txt" } } as never);
    bus.publish(done("t-plain", "z", { body: "file words" }));
    const rows = log().trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.map((row) => [row.type, row.itemId])).toEqual([["item.started", "z"], ["item.completed", "z"]]);
    expect(rows[1]).toMatchObject({ ok: true });
    expect(log()).not.toContain("file words");
    expect(log()).not.toContain(PHONE_RESULT_WITHHELD);
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
    bus.publish(ask("t-plain", "WebFetch", { summary: "plain ask words" }));
    // ql2 sink fold (was: "plain ask words" on disk): a plain thread's ask is kept, as its tool and fixed label (Astra r1 H8)
    expect(log()).toContain("WebFetch");
    expect(log()).not.toContain("plain ask words");
    // GrokBuild case 18: a shell ask on a plain thread logs the label, never its command
    bus.publish(ask("t-plain", "Bash", { summary: "plain shell words" }));
    expect(log()).not.toContain("plain shell words");
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
    // ql2 sink fold (was: "plain thinking" on disk): a plain thread's reasoning row is kept, its words are not
    expect(log()).toContain("rs-plain");
    expect(log()).not.toContain("plain thinking");
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
    // ql2 sink fold (was: "plain question words" on disk): a plain thread's question keeps its id and shape, not its words
    expect(log()).toContain('"id":"q2"');
    expect(log()).not.toContain("plain question words");
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
    // ql2 sink fold (was: its count and flag kept): an event type no allowlist names keeps its envelope only
    expect(log()).not.toContain("\"count\"");
    expect(log()).not.toContain("\"flag\"");
  });
  it("keeps the allowlisted structural fields on a marked thread (r3)", () => {
    const { bus, log } = rig(["t-marked"]);
    bus.publish({ provider: "fakeAsk", eventId: "keep-1", createdAt: "2026-10-26T00:00:00Z", threadId: "t-marked", turnId: "turn-9", itemId: "item-9", type: "item.started", itemType: "tool", origin: "engine", title: "Bash echo Sam", input: { command: "echo Sam" }, toolKind: "execute", toolIdentity: { namespace: "shell", name: "Bash", kind: "execute" } } as never);
    const line = JSON.parse(log().trim().split("\n").pop() as string);
    // NOLIMITS 1.0.18 (design NOLIMITS-S1S2-H6-ALLOWLIST.md L1/L5, MurageMain order 11-06): a withheld tool row is rebuilt by
    // withheldToolRow and carries NO toolIdentity and NO title. The `toolIdentity` pin that stood here moved to the kept
    // structural fields (envelope keys + `toolKind`), the withheld markers, and the phone-row test below (Set P), which
    // proves which phone tool a row was through its canonical `summary`.
    expect(line).toMatchObject({ eventId: "keep-1", createdAt: "2026-10-26T00:00:00Z", threadId: "t-marked", turnId: "turn-9", itemId: "item-9", type: "item.started", itemType: "tool", origin: "engine", toolKind: "execute", provider: "fakeAsk" });
    expect(line.input).toBe(PHONE_RESULT_WITHHELD);
    expect(line.summary).toBe(PHONE_RESULT_WITHHELD);
    expect(Object.hasOwn(line, "toolIdentity")).toBe(false);
    expect(Object.hasOwn(line, "title")).toBe(false);
    expect(log()).not.toContain("echo Sam");
  });
  it("names a marked thread's phone tool rows by their canonical summary, start and completion paired by itemId (moved from the toolIdentity pin, L5)", () => {
    // NOLIMITS 1.0.18 (design L1/L5, MurageMain order 11-06): replaces the toolIdentity assertion above for phone rows
    const { bus, log } = rig(["t-marked"]);
    bus.publish(started("t-marked", "item-p", "phone_text_compose", { to: ["+15551234567"], body: "running late" }));
    bus.publish(done("t-marked", "item-p", { sent: true, to: "+15551234567" }));
    const rows = log().trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ type: "item.started", itemType: "tool", itemId: "item-p", threadId: "t-marked", summary: "phone_text_compose", input: PHONE_RESULT_WITHHELD });
    expect(rows[1]).toMatchObject({ type: "item.completed", itemType: "tool", itemId: "item-p", threadId: "t-marked", summary: "phone_text_compose", result: PHONE_RESULT_WITHHELD, ok: true });
    for (const row of rows) {
      expect(Object.hasOwn(row, "toolIdentity")).toBe(false);
      expect(Object.hasOwn(row, "title")).toBe(false);
    }
    expect(log()).not.toContain("5551234567");
    expect(log()).not.toContain("running late");
  });
  it("drops the raw engine frame of a marked thread, even its structural-looking keys (r4)", () => {
    const { bus, log, delivered } = rig(["t-marked"]);
    bus.publish(base("t-marked", "invented.future-event", { raw: { id: "Sam +15551234567", status: "text Sam", kind: "Sam" } }));
    expect(log()).not.toContain("Sam");
    expect(log()).not.toContain("\"raw\"");
    expect(delivered.some((e) => e.raw?.id === "Sam +15551234567")).toBe(true);
  });
  // ql2 sink fold (was "... as they are", their words on disk): an unmarked thread's plan, subtask, error and unknown events keep
  // their shape through the sink allowlist (statuses, ids, the error label), never their words and never the phone stand-in
  it("writes an unmarked thread's plan, subtask, error and unknown events by their shape, unwithheld (r3)", () => {
    const { bus, log } = rig(["t-marked"]);
    bus.publish(base("t-plain", "plan.updated", { entries: [{ content: "plain plan words", status: "pending" }] }));
    bus.publish(base("t-plain", "turn.subtask", { subtask: { id: "s", label: "plain subtask words", status: "done", startedAt: 1, toolCount: 0 }, subtasks: [] }));
    bus.publish(base("t-plain", "runtime.error", { message: "plain error words" }));
    bus.publish(base("t-plain", "invented.future-event", { note: "plain note words" }));
    for (const w of ["plain plan words", "plain subtask words", "plain error words", "plain note words"]) expect(log()).not.toContain(w);
    const rows = log().trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
    expect(rows.map((row) => row.type)).toEqual(["plan.updated", "turn.subtask", "runtime.error", "invented.future-event"]);
    expect(rows[0].entries).toEqual([{ status: "pending" }]);
    expect(rows[1].subtask).toMatchObject({ id: "s", status: "done" });
    expect(rows[2].message).toBe(ERROR_LOGGED_MESSAGE);
    expect(log()).not.toContain(PHONE_RESULT_WITHHELD);
    expect(log()).not.toContain(PHONE_TEXT_WITHHELD);
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

// NOLIMITS 1.0.18 logger lane (design NOLIMITS-S1S2-H6-ALLOWLIST.md L5, section 4.4 row 6 (b)-(f), Set P; MurageMain order
// 11-06). Every withheld tool row, start and completion, normal and catch path, is rebuilt by ONE withheldToolRow: envelope
// keys, toolKind, ok, a canonical summary and the withheld marker; never toolIdentity, title, detail or raw.
describe("NOLIMITS L5: a withheld tool row is rebuilt, never spread (Set P)", () => {
  const SECRET = "confidential-plan-text-7f3a";
  const P_KEYS: ReadonlySet<string> = new Set(["type", "itemType", "origin", "eventId", "provider", "providerInstanceId", "threadId", "turnId", "createdAt", "itemId", "toolKind", "ok", "summary", "input", "result"]);
  const SUMMARIES: ReadonlySet<string> = new Set([...PHONE_TOOL_NAMES, "phone tool", PHONE_RESULT_WITHHELD]);
  const rows = (text: string) => text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const setP = (row: Record<string, unknown>, label: string) => {
    for (const key of Object.keys(row)) expect(P_KEYS.has(key), `${label}: unexpected key ${key}`).toBe(true);
    for (const key of ["title", "toolIdentity", "detail", "raw"]) expect(Object.hasOwn(row, key), `${label}: ${key}`).toBe(false);
    expect(SUMMARIES.has(row.summary as string), `${label}: summary ${String(row.summary)}`).toBe(true);
    if (row.type === "item.started") expect(row.input, label).toBe(PHONE_RESULT_WITHHELD);
    if (row.type === "item.completed") expect(row.result, label).toBe(PHONE_RESULT_WITHHELD);
    expect(JSON.stringify(row), label).not.toContain(SECRET);
  };
  const toolStart = (threadId: string, itemId: string, extra: Record<string, unknown>) => ({ provider: "fakeAsk", eventId: `s-${itemId}`, createdAt: "2026-11-06T00:00:00Z", threadId, turnId: "turn-1", itemId, type: "item.started", itemType: "tool", origin: "engine", ...extra }) as never;
  const toolDone = (threadId: string, itemId: string, extra: Record<string, unknown> = {}) => ({ provider: "fakeAsk", eventId: `c-${itemId}`, createdAt: "2026-11-06T00:00:00Z", threadId, turnId: "turn-1", itemId, type: "item.completed", itemType: "tool", ok: true, result: { text: SECRET }, detail: SECRET, ...extra }) as never;

  it("(b) a phone start whose only marker is the live summary is withheld with the canonical name, and so is its completion (recognition on the original)", () => {
    const { bus, log } = rig([]);
    bus.publish(toolStart("t-plain", "pb", { title: "Calling the dentist", summary: "phone_call_dial +15551234567", input: { number: "+15551234567", note: SECRET } }));
    bus.publish(toolDone("t-plain", "pb"));
    const [s, c] = rows(log());
    setP(s!, "(b) start"); setP(c!, "(b) completion");
    expect(s!.summary).toBe("phone_call_dial");
    expect(c!.summary).toBe("phone_call_dial");
    expect(s!.itemId).toBe("pb"); expect(c!.itemId).toBe("pb");
  });
  it("(c) a BoxAgent title 'phoneJobs <text>' gives summary 'phone tool' on start and completion (r2 #4 literal)", () => {
    const { bus, log } = rig([]);
    bus.publish(toolStart("t-plain", "pc", { provider: "boxAgent", title: "phoneJobs confidential-plan-text-7f3a" }));
    bus.publish(toolDone("t-plain", "pc", { provider: "boxAgent" }));
    const [s, c] = rows(log());
    setP(s!, "(c) start"); setP(c!, "(c) completion");
    expect(s!.summary).toBe("phone tool");
    expect(c!.summary).toBe("phone tool");
  });
  for (const marked of [false, true]) {
    it(`(d) a phoneJobs tool under an unknown name logs 'phone tool' and no identity, ${marked ? "marked" : "unmarked"} thread (Astra r1 #3 literal)`, () => {
      const thread = marked ? "t-marked" : "t-plain";
      const { bus, log } = rig(["t-marked"]);
      bus.publish(toolStart(thread, "pd", { title: SECRET, toolIdentity: { namespace: "phoneJobs", name: SECRET }, input: { q: SECRET } }));
      bus.publish(toolDone(thread, "pd", { toolIdentity: { namespace: "phoneJobs", name: SECRET } }));
      const [s, c] = rows(log());
      setP(s!, "(d) start"); setP(c!, "(d) completion");
      expect(s!.summary).toBe("phone tool");
      expect(c!.summary).toBe("phone tool");
    });
  }
  it("(e) a canonical phoneJobs tool logs its canonical name and no identity", () => {
    const { bus, log } = rig([]);
    bus.publish(toolStart("t-plain", "pe", { title: "phone_call_dial", toolIdentity: { namespace: "phoneJobs", name: "phone_call_dial" }, input: { number: "+15551234567" } }));
    bus.publish(toolDone("t-plain", "pe"));
    const [s, c] = rows(log());
    setP(s!, "(e) start"); setP(c!, "(e) completion");
    expect(s!.summary).toBe("phone_call_dial");
    expect(c!.summary).toBe("phone_call_dial");
    expect(log()).not.toContain("5551234567");
  });
  it("(f) catch path: a phoneTool policy that throws writes a Set P row with the withheld summary", () => {
    const writes: string[] = [];
    const bus = new EventBus(((_file: string, data: string) => { writes.push(data); }) as never);
    bus.withholdText({ thread: () => false, phoneTool: () => { throw new Error("policy failed"); } });
    bus.publish(toolStart("t-plain", "pf", { title: SECRET, toolIdentity: { name: SECRET }, input: { q: SECRET } }));
    bus.publish(toolDone("t-plain", "pf", { toolIdentity: { name: SECRET } }));
    const [s, c] = rows(writes.join(""));
    setP(s!, "(f) start"); setP(c!, "(f) completion");
    expect(s!.summary).toBe(PHONE_RESULT_WITHHELD);
    expect(c!.summary).toBe(PHONE_RESULT_WITHHELD);
  });
});
