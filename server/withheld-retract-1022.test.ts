// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.22 withheld (field gate). Owners: lane fix1022-withheld-fable owns this witness and the take-back rule it pins
// (redact-turn.ts retract, reset, complete); the harness owns the collector (harness/audience-collector.ts) and its secret latch;
// redact2-1020 owns the stored row's owner view (owner-display.ts ownerReplyText).
//
// Field shape, 1.0.21: ordinary replies read "Murage held back this message because it may repeat something that must stay
// hidden." on Claude (after a login expired and the message was sent again) and on an ACP engine (a turn whose context was
// compacted and whose tools ran again; every tool name read «redacted»). In both, the engine took back text it had streamed and
// sent other text in its place. The taken-back text was still unreleased (an unfinished last line), the turn policy treated the
// take-back as its own secret finding, and the collector then withheld every later message and row of the turn.
//
// Each row below feeds the frames one driver emits for that shape (the emitting lines are named per row) through the real
// EventBus, collector and turn policy; the row text is the expression index.ts stores for item.completed assistant_text.
// Not driven here: the drivers' own parsing of the engine's frames (no engine process runs in this file).
import { describe, expect, it } from "vitest";
import type { ProviderInstance, RuntimeEvent, SourceContext } from "./contracts.ts";
import { EventBus } from "./harness/bus.ts";
import { ownerReplyText, REPLY_WITHHELD } from "./owner-display.ts";

const MARK = "«redacted»";
const THREAD = "owner-thread-fixture";
const NEXT = "Anything else you want me to look into?";
const ANSWER = "Here is the answer you asked for.";
const FIXTURE_VALUE = "FIXTURESECRET" + "123456";
const FIXTURE_SECRET = "api_key=" + FIXTURE_VALUE;
// the value of redact-turn-stream.test.ts R5a ("Bearer" on one line, this on the next)
const BASIC_VALUE = "dXNlcjpw" + "YXNz";
let seq = 0;

type Frame = Record<string, unknown>;
type Seen = { type: string; raw?: string; displayed?: string; title?: string; masked: boolean; secret: boolean; withheld: boolean; row?: string; shared?: string; live: string };

function harness() {
  let emitFn: ((event: RuntimeEvent, source?: SourceContext) => void) | undefined;
  const instance = { instanceId: "engine-fixture", driverKind: "fake", tracksKeyRejection: true,
    adapter: { onEvent(listener: (event: RuntimeEvent, source?: SourceContext) => void) { emitFn = listener; return () => { emitFn = undefined; }; } } };
  const bus = new EventBus(() => {});
  bus.attach([instance as unknown as ProviderInstance]);
  const send = (fields: Frame, source: SourceContext): Seen => {
    const event = { eventId: `e-${++seq}`, provider: "fake", threadId: THREAD, turnId: "turn-fixture", createdAt: new Date().toISOString(), ...fields } as unknown as RuntimeEvent;
    let seen: RuntimeEvent | undefined;
    const off = bus.subscribe(e => { if (e.eventId === event.eventId) seen = e; });
    emitFn!(event, source);
    off?.();
    const execution = seen ?? event;
    const audience = bus.audienceFor(execution).map(e => e.event) as unknown as Array<Record<string, unknown>>;
    const own = audience.find(e => e.type === fields.type);
    const secret = bus.audienceSecretMaskedFor(execution), withheld = bus.audienceWithheldFor(execution);
    const reply = fields.type === "item.completed" && fields.itemType === "assistant_text";
    const displayed = typeof own?.text === "string" ? own.text : undefined;
    return { type: String(fields.type), raw: reply ? String(fields.text) : undefined, displayed, title: typeof own?.title === "string" ? own.title : undefined,
      masked: bus.audienceMaskedFor(execution), secret, withheld,
      // index.ts item.completed assistant_text: ownerReplyText(displayField("text"), text, ownerOnly, audienceUnproven)
      row: reply ? ownerReplyText(displayed, fields.text, true, secret || withheld) : undefined,
      shared: reply ? ownerReplyText(displayed, fields.text, false, secret || withheld) : undefined,
      // every word the live stream was handed for this frame (deltas and resets in order)
      live: audience.map(e => e.type === "content.delta" ? String(e.delta ?? "") : e.type === "content.reset" ? "<reset>" : "").join("") };
  };
  /** One owner turn: a new admission for the thread (index.ts admitLedgerLease), then its frames. */
  const turn = (frames: readonly Frame[]) => { const source = bus.admitNewTurn("engine-fixture", THREAD); return frames.map(frame => send(frame, source)); };
  return { bus, turn };
}

// Claude adapter frames (drivers/claude.ts stream_event text_delta, assistant message): no item id.
const delta = (text: string, itemId?: string): Frame => ({ type: "content.delta", streamKind: "assistant_text", delta: text, ...(itemId ? { itemId } : {}) });
const thought = (text: string): Frame => ({ type: "content.delta", streamKind: "reasoning_text", delta: text });
const done = (text: string, itemId?: string): Frame => ({ type: "item.completed", itemType: "assistant_text", origin: "engine", text, ...(itemId ? { itemId } : {}) });
// ACP adapter frames (drivers/acp/core.ts): text carries its item id; a retry or discard resets the item and the reasoning stream.
const reset = (itemId?: string): Frame => ({ type: "content.reset", streamKind: "assistant_text", ...(itemId ? { itemId } : {}) });
const resetThought = (): Frame => ({ type: "content.reset", streamKind: "reasoning_text" });
const tool = (itemId: string, title: string): Frame => ({ type: "item.started", itemType: "tool", origin: "engine", itemId, title, input: {} });
const toolDone = (itemId: string, result: unknown): Frame => ({ type: "item.completed", itemType: "tool", itemId, ok: true, result });
const SUMMARY = "<summary>\n1. Primary request: list the open tabs and read the screen size.\n2. Next step: call both tools again and answer in one line.\n</summary>";
const TABS = { data: { tabs: [{ id: "tab-1", title: "about:blank", url: "about:blank" }] } };

/** One row per site of SITES.md: the frames of one owner turn, and the replies it must store whole. */
const ROWS: ReadonlyArray<{ id: string; site: string; frames: readonly Frame[]; titles?: readonly string[] }> = [
  { id: "C1 Claude: a stream cut mid-line, then the message resent whole", site: "redact-turn.ts complete (snapshot is not what streamed, unfinished line pending); frames drivers/claude.ts:6188,6227",
    frames: [delta("I will look at that no"), delta(ANSWER), done(ANSWER), delta(NEXT), done(NEXT)] },
  { id: "C2 Claude: a released first line, then the message resent whole", site: "redact-turn.ts complete; frames drivers/claude.ts:6188,6227",
    frames: [delta("I will look at that now.\n"), delta(ANSWER), done(ANSWER), delta(NEXT), done(NEXT)] },
  { id: "C3 Claude: the login expires mid-stream (error row, no completed message), the turn sends again", site: "redact-turn.ts complete; frames drivers/claude.ts:6188 (delta), :6203 (sign-in error, no item.completed), :6227",
    frames: [delta("Partial ans"), { type: "runtime.error", message: "Claude needs you to sign in. Open engine setup to continue.", setup: true, authRequired: true }, delta(ANSWER), done(ANSWER), delta(NEXT), done(NEXT)] },
  { id: "A1 ACP: a retry voids the reply mid-line (resetForRetry)", site: "redact-turn.ts reset (unfinished line pending); frames drivers/acp/core.ts:5357",
    frames: [delta("Checking the tabs", "text-1"), reset("text-1"), delta(ANSWER, "text-1"), done(ANSWER, "text-1"), delta(NEXT, "text-2"), done(NEXT, "text-2")] },
  { id: "A2 ACP: a discard voids the reasoning mid-line (discardForRetry)", site: "redact-turn.ts reset (reasoning chain); frames drivers/acp/core.ts:5401",
    frames: [thought("Okay, let me think about"), resetThought(), thought("The owner wants two calls.\n"), delta(ANSWER, "text-1"), done(ANSWER, "text-1"), delta(NEXT, "text-2"), done(NEXT, "text-2")] },
  { id: "A3 ACP: a discard takes back the last attempt and sends the kept text again (discardForRetry)", site: "redact-turn.ts reset; frames drivers/acp/core.ts:5396-5397",
    frames: [delta("First part.\nSecond par", "text-1"), reset("text-1"), delta("First part.\n", "text-1"), delta("Other second part.", "text-1"), done("First part.\nOther second part.", "text-1"), delta(NEXT, "text-2"), done(NEXT, "text-2")] },
  { id: "A4 ACP: a compaction summary streams, is discarded, and the turn runs its tools again", site: "redact-turn.ts reset (text and reasoning); frames drivers/acp/core.ts:5396,5401 and the tool rows of the second attempt",
    frames: [thought("Okay, two tool calls in order"), tool("call-a1", "agent_browser_tab_list"), toolDone("call-a1", TABS), tool("call-a2", "get_screen_size"), toolDone("call-a2", "Main display: 1440x900 points @ 1x"),
      thought("The context is full, so I will summarise"), delta(SUMMARY, "text-1"), resetThought(), reset("text-1"),
      thought("Okay, the summary says to call both tools again"), tool("call-b1", "agent_browser_tab_list"), toolDone("call-b1", TABS), tool("call-b2", "get_screen_size"), toolDone("call-b2", "Main display: 1440x900 points @ 1x"),
      // the driver keeps the item id across a retry reset (core.ts resetForRetry/discardForRetry)
      delta("1 tab open, screen size: 1440x900 points @ 1x", "text-1"), done("1 tab open, screen size: 1440x900 points @ 1x", "text-1")],
    titles: ["agent_browser_tab_list", "get_screen_size", "agent_browser_tab_list", "get_screen_size"] },
  { id: "A5 ACP: a hosted tool row cuts the reply, the part after it is voided by a discard and sent again", site: "redact-turn.ts retract (an item behind the head of its chain); frames drivers/acp/core.ts:5738 (the next item starts before the first is committed), :5396, flushAssistantText parts",
    frames: [delta("Looking that up.", "text-1"), tool("hosted-1", "web_search"), toolDone("hosted-1", "two results"), delta("Found two re", "text-2"), reset("text-2"), delta(ANSWER, "text-2"),
      { ...done("Looking that up.", "text-1"), beforeItemId: "hosted-1" }, done(ANSWER, "text-2"), delta(NEXT, "text-3"), done(NEXT, "text-3")] },
  { id: "P1 pi: a retried attempt resets both streams mid-line", site: "redact-turn.ts reset (anonymous streams); frames drivers/pi.ts:1396",
    frames: [thought("Thinking about the fir"), delta("The first thing to"), reset(), resetThought(), delta(ANSWER), done(ANSWER), delta(NEXT), done(NEXT)] },
];

describe("1.0.22 withheld: text an engine takes back is not a secret finding", () => {
  for (const row of ROWS) it(`${row.id} [${row.site}]`, () => {
    const seen = harness().turn(row.frames);
    const replies = seen.filter(s => s.raw !== undefined);
    expect(replies.length).toBeGreaterThan(0);
    // no frame of the turn is recorded as the turn's own secret finding, and the turn is never masked
    expect(seen.filter(s => s.secret || s.masked).map(s => s.type)).toEqual([]);
    // the owner's stored rows are the engine's completed messages, word for word; a shared audience reads the same
    expect(replies.map(s => s.row)).toEqual(replies.map(s => s.raw));
    expect(replies.map(s => s.shared)).toEqual(replies.map(s => s.raw));
    expect(replies.map(s => s.row)).not.toContain(REPLY_WITHHELD);
    // tool rows keep their names
    if (row.titles) expect(seen.filter(s => s.type === "item.started").map(s => s.title)).toEqual(row.titles);
  });

  it("the taken-back unfinished line never reaches the live stream or a row", () => {
    const seen = harness().turn([delta("Checking the tabs", "text-1"), reset("text-1"), delta(ANSWER, "text-1"), done(ANSWER, "text-1")]);
    expect(seen.map(s => s.live).join("")).not.toContain("Checking");
    const replay = harness().turn([delta("I will look at that no"), delta(ANSWER), done(ANSWER)]);
    expect(replay.map(s => s.live).join("")).not.toContain("look at that");
    expect(replay.at(-1)!.row).toBe(ANSWER);
    // a discard that sends the kept text again (A3): the taken-back half line is not glued onto it
    const kept = harness().turn([delta("First part.\nSecond par", "text-1"), reset("text-1"), delta("First part.\n", "text-1"), delta("Other second part.", "text-1"), done("First part.\nOther second part.", "text-1")]);
    expect(kept.map(s => s.live).join("")).not.toContain("Second par");
    expect(kept.at(-1)!.row).toBe("First part.\nOther second part.");
  });

  it("a latch does not outlive its turn: after a turn that really held a secret, the thread's next turn shows whole", () => {
    const { turn } = harness();
    const held = turn([delta(`The deploy key is ${FIXTURE_SECRET}\n`), done(`The deploy key is ${FIXTURE_SECRET}\n`), delta(NEXT), done(NEXT)]);
    expect(held.at(-1)!.secret).toBe(true);
    expect(held.at(-1)!.row).toBe(REPLY_WITHHELD);
    const later = turn([delta(ANSWER), done(ANSWER), delta(NEXT), done(NEXT)]);
    expect(later.filter(s => s.secret || s.masked)).toEqual([]);
    expect(later.filter(s => s.raw !== undefined).map(s => s.row)).toEqual([ANSWER, NEXT]);
  });
});

// The privacy promise: a take-back never opens a way to show private text. Each guard is the mutant target of one check in retract.
describe("1.0.22 withheld guards: private text is never shown through a take-back", () => {
  const everything = (seen: readonly Seen[]) => seen.map(s => `${s.live}\n${s.displayed ?? ""}\n${s.row ?? ""}\n${s.shared ?? ""}`).join("\n");

  it("G1 a secret in the taken-back text (ACP reset) still latches the turn", () => {
    const seen = harness().turn([delta(`export ${FIXTURE_SECRET}`, "text-1"), reset("text-1"), delta(ANSWER, "text-1"), done(ANSWER, "text-1")]);
    // the finding is recorded at the take-back itself, not only when later text arrives
    expect(seen[1]!.type).toBe("content.reset");
    expect(seen[1]!.secret).toBe(true);
    expect(seen.at(-1)!.secret).toBe(true);
    expect(seen.at(-1)!.row).toBe(REPLY_WITHHELD);
    expect(everything(seen)).not.toContain(FIXTURE_VALUE);
  });

  it("G2 a secret in the streamed line a resent message replaces (Claude) still latches the turn", () => {
    const seen = harness().turn([delta(`export ${FIXTURE_SECRET}`), delta(ANSWER), done(ANSWER), delta(NEXT), done(NEXT)]);
    expect(seen.at(-1)!.secret).toBe(true);
    expect(seen.filter(s => s.raw !== undefined).map(s => s.row)).toEqual([REPLY_WITHHELD, REPLY_WITHHELD]);
    expect(everything(seen)).not.toContain(FIXTURE_VALUE);
  });

  it("G3 a label taken back and its value sent after the reset (ACP) is caught across the take-back", () => {
    const seen = harness().turn([delta("api_key=", "text-1"), reset("text-1"), delta(`${FIXTURE_VALUE}\n`, "text-1"), done(`${FIXTURE_VALUE}\n`, "text-1")]);
    expect(seen.at(-1)!.secret).toBe(true);
    expect(everything(seen)).not.toContain(FIXTURE_VALUE);
  });

  it("G4 a credential cut in two by the reset (ACP) is caught on the raw join", () => {
    const seen = harness().turn([delta("api_k", "text-1"), reset("text-1"), delta(`ey=${FIXTURE_VALUE}\n`, "text-1"), done(`ey=${FIXTURE_VALUE}\n`, "text-1")]);
    expect(seen.at(-1)!.secret).toBe(true);
    expect(everything(seen)).not.toContain(FIXTURE_VALUE);
  });

  it("G5 a label streamed and then replaced by a resent message that holds only its value (Claude) is caught", () => {
    const seen = harness().turn([delta("api_key="), done(`${FIXTURE_VALUE}\n`), delta(NEXT), done(NEXT)]);
    expect(seen.at(-1)!.secret).toBe(true);
    expect(everything(seen)).not.toContain(FIXTURE_VALUE);
  });

  it("G7 a label left unfinished at the reset (ACP) and its value on the next line is caught: the taken-back text stays the previous-item context", () => {
    const seen = harness().turn([delta("Bearer", "text-1"), reset("text-1"), delta(`${BASIC_VALUE}\n`, "text-1"), done(`${BASIC_VALUE}\n`, "text-1")]);
    expect(seen.at(-1)!.secret).toBe(true);
    expect(everything(seen)).not.toContain(BASIC_VALUE);
  });

  it("G8 a credential cut in two by a resent message (Claude) is caught on the raw join", () => {
    const seen = harness().turn([delta("api_k"), done(`ey=${FIXTURE_VALUE}`), delta(NEXT), done(NEXT)]);
    expect(seen.at(-1)!.secret).toBe(true);
    expect(everything(seen)).not.toContain(FIXTURE_VALUE);
  });

  it("G9 an earlier message that ended on a label, a take-back in the next one, then the value: what was shown before and after the take-back is still read side by side", () => {
    const seen = harness().turn([delta("Bearer", "text-1"), done("Bearer", "text-1"), delta("Sure, ", "text-2"), reset("text-2"), delta(`${BASIC_VALUE}\n`, "text-2"), done(`${BASIC_VALUE}\n`, "text-2")]);
    expect(seen.at(-1)!.secret).toBe(true);
    expect(everything(seen)).not.toContain(BASIC_VALUE);
  });

  it("G10 a label cut in two by the reset, its second half on one line and the value on the next: the half line is held, then caught", () => {
    const seen = harness().turn([delta("pass", "text-1"), reset("text-1"), delta("word=\n", "text-1"), delta("hunter22\n", "text-1"), done("word=\nhunter22\n", "text-1")]);
    expect(seen.at(-1)!.secret).toBe(true);
    expect(everything(seen)).not.toContain("hunter22");
  });

  // ASTRA 0b17e1b5a1 (redact-turn.ts:241): the completion of the item after a take-back read the raw join only for a hit, so the
  // label it opens (`pass` taken back + `word=` completed) was not kept for the next item, and that item's value was released.
  for (const hosted of [false, true]) it(`G11 a label cut in two by the reset, completed as its own item, its value in the next item${hosted ? " after a hosted tool row" : ""}`, () => {
    const seen = harness().turn([delta("pass", "text-1"), reset("text-1"), delta("word=\n", "text-1"), done("word=\n", "text-1"),
      ...(hosted ? [tool("hosted-1", "web_search"), toolDone("hosted-1", "two results")] : []), delta("hunter22\n", "text-2"), done("hunter22\n", "text-2")]);
    expect(everything(seen)).not.toContain("hunter22");
    expect(seen.at(-1)!.secret).toBe(true);
  });

  // ASTRA 4ee6745319: two take-backs split the label (`pa`, `ss`), its rest and value arrive after the second reset
  it("G12 a label split across two take-backs (ACP resets) is caught on the joined pieces", () => {
    const seen = harness().turn([delta("pa", "text-1"), reset("text-1"), delta("ss", "text-1"), reset("text-1"), delta("word=hunter22\n", "text-1"), done("word=hunter22\n", "text-1")]);
    expect(everything(seen)).not.toContain("hunter22");
    expect(seen.at(-1)!.secret).toBe(true);
  });

  // ASTRA (stand-in) 28cd6b9151 (redact-turn.ts:181): while streaming, the raw join of a taken-back piece and the next unit was read
  // without the shown chain context in front, so an earlier item that ended on an open label, a value cut by the reset, and its rest
  // shown after it released the rest. The same words with no reset latch (control first, so the row is not vacuous).
  for (const row of [{ label: "my password:", gone: "hunter", rest: "22abcd" }, { label: "Bearer", gone: "FIXTURE", rest: "TOKEN1" }]) it(`G13 an earlier item ending on an open label (${row.label}), its value cut by the reset (ACP): the rest is read after the shown context and the taken-back piece`, () => {
    const plain = harness().turn([delta(row.label, "text-1"), done(row.label, "text-1"), delta(`${row.gone}${row.rest}\n`, "text-2"), done(`${row.gone}${row.rest}\n`, "text-2")]);
    expect(plain.at(-1)!.secret).toBe(true);
    const seen = harness().turn([delta(row.label, "text-1"), done(row.label, "text-1"), delta(row.gone, "text-2"), reset("text-2"), delta(`${row.rest}\n`, "text-2"), done(`${row.rest}\n`, "text-2")]);
    expect(everything(seen)).not.toContain(row.rest);
    expect(seen.at(-1)!.secret).toBe(true);
  });

  // G2, G6 and R3 (the API file) guard behaviour the base already had (the completed text's own scan); they are not pinned to one fix line.
  it("G6 a resent message that holds a secret itself is never shown", () => {
    const seen = harness().turn([delta("I will look at that no"), delta(`Use ${FIXTURE_SECRET}`), done(`Use ${FIXTURE_SECRET}`)]);
    expect(seen.at(-1)!.secret).toBe(true);
    expect(seen.at(-1)!.row).not.toContain(FIXTURE_VALUE);
    expect(seen.at(-1)!.row!.replaceAll(MARK, "").trim()).not.toBe("");
    expect(everything(seen)).not.toContain(FIXTURE_VALUE);
  });
});
