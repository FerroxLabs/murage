// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.21 withheld. Owners: the withheld-1021e builder owns this witness and the completion rule it pins (redact-turn.ts complete, an
// item whose released history was let go); the harness owns the collector (harness/audience-collector.ts) and its secret latch;
// redact2-1020 owns the stored row's owner view (owner-display.ts ownerReplyText).
//
// Live shape (owner report, 1.0.20, owner-only chat): a long morning brief streamed in, then the next assistant message of the same
// turn showed only "Murage held back this message because it may repeat something that must stay hidden." The brief was longer than
// the policy keeps as released history (CONTEXT_LIMIT, 65,536), so that history was let go, and its last line had no newline, so it
// was still pending when the item completed. complete() could not compare the snapshot with the let-go history and latched as if the
// words held a secret; the collector recorded the turn as its own secret hit, and ownerReplyText then withheld every later message.
// Real EventBus, collector and turn policy; the row text is computed by the same expression index.ts stores.
import { describe, expect, it } from "vitest";
import type { ProviderInstance, RuntimeEvent, SourceContext } from "./contracts.ts";
import { EventBus } from "./harness/bus.ts";
import { ownerReplyText, REPLY_WITHHELD } from "./owner-display.ts";
import { CONTEXT_LIMIT } from "./redact-stream-release.ts";

const MARK = "«redacted»";
const THREAD = "owner-thread-fixture";
const NEXT = "Anything else you want me to look into this morning?";
const FIXTURE_SECRET = "api_key=" + "FIXTURESECRET123456";
let seq = 0;

function harness() {
  let emitFn: ((event: RuntimeEvent, source?: SourceContext) => void) | undefined;
  const instance = { instanceId: "claude-fixture", driverKind: "fake", tracksKeyRejection: true,
    adapter: { onEvent(listener: (event: RuntimeEvent, source?: SourceContext) => void) { emitFn = listener; return () => { emitFn = undefined; }; } } };
  const bus = new EventBus(() => {});
  bus.attach([instance as unknown as ProviderInstance]);
  const send = (fields: Record<string, unknown>, source: SourceContext) => {
    const event = { eventId: `e-${++seq}`, provider: "fake", threadId: THREAD, turnId: "brief-turn", createdAt: new Date().toISOString(), ...fields } as unknown as RuntimeEvent;
    let seen: RuntimeEvent | undefined;
    const off = bus.subscribe(e => { if (e.eventId === event.eventId) seen = e; });
    emitFn!(event, source);
    off?.();
    const execution = seen ?? event;
    const displayed = bus.audienceFor(execution).map(e => e.event).find(e => e.type === "item.completed") as { text?: string } | undefined;
    return { displayed: displayed?.text, masked: bus.audienceMaskedFor(execution), secret: bus.audienceSecretMaskedFor(execution) };
  };
  /** One assistant item streamed the way the Claude adapter sends it: deltas, then the completed snapshot. */
  const stream = (itemId: string, text: string, source: SourceContext, completed = text) => {
    for (let at = 0; at < text.length; at += 4000) send({ type: "content.delta", streamKind: "assistant_text", itemId, delta: text.slice(at, at + 4000) }, source);
    return send({ type: "item.completed", itemType: "assistant_text", itemId, text: completed }, source);
  };
  return { bus, send, stream };
}

/** A clean brief longer than the policy's released history, whose last line has no newline. */
function longBrief(lastLine: string) {
  let text = "# Morning brief\n\n";
  for (let i = 0; text.length <= CONTEXT_LIMIT + 4096; i++)
    text += `- Item ${i}: review at ${i % 12}:30 with the platform group, then notes on shipping and travel plans for later this week.\n`;
  return text + lastLine;
}

type Sent = ReturnType<ReturnType<typeof harness>["send"]>;
/** What index.ts stores as the row (item.completed assistant_text). */
const rowText = (r: Sent, raw: string, ownerOnly = true) => ownerReplyText(r.displayed, raw, ownerOnly, r.secret);

describe("1.0.21 withheld: a long clean brief never withholds the owner's next message", () => {
  it("RED on 1.0.20: the message after a long brief whose last line has no newline is shown, and the brief keeps its last line", () => {
    const { bus, stream } = harness();
    const source = bus.admitNewTurn("claude-fixture", THREAD);
    const brief = longBrief("Have a good day.");
    expect(brief.length).toBeGreaterThan(CONTEXT_LIMIT);
    const first = stream("brief", brief, source);
    // the brief's words are clean: no secret finding, and its last line is shown
    expect(first.secret).toBe(false);
    expect(rowText(first, brief)).toBe(brief);
    const next = stream("next", NEXT, source);
    expect(next.secret).toBe(false);
    expect(next.masked).toBe(false);
    expect(rowText(next, NEXT)).toBe(NEXT);
    expect(rowText(next, NEXT)).not.toBe(REPLY_WITHHELD);
    // a shared audience sees the same clean words, not the marker
    expect(rowText(next, NEXT, false)).toBe(NEXT);
  });

  // End to end: the completed snapshot's own scan (consume, mode snapshot) latches on these words before complete() runs, so this pins
  // the turn's outcome, not the new pending-line check alone (that check re-scans the same line with the same context).
  it("guard: a secret in the long brief's unfinished last line still latches the turn and never reaches the owner raw", () => {
    const { bus, stream } = harness();
    const source = bus.admitNewTurn("claude-fixture", THREAD);
    const brief = longBrief(`The deploy key is ${FIXTURE_SECRET}`);
    const first = stream("brief", brief, source);
    expect(first.masked).toBe(true);
    expect(first.secret).toBe(true);
    expect(rowText(first, brief)).not.toContain("FIXTURESECRET");
    const next = stream("next", NEXT, source);
    expect(next.secret).toBe(true);
    const stored = rowText(next, NEXT);
    expect(stored).not.toBe(NEXT);
    expect(stored.replaceAll(MARK, "").trim()).not.toBe("");
  });

  it("guard: a completed snapshot that does not end with the streamed unfinished line still fails closed", () => {
    const { bus, stream } = harness();
    const source = bus.admitNewTurn("claude-fixture", THREAD);
    const streamed = longBrief("Have a good day.");
    // the engine's final text for the item disagrees with the streamed tail, and the let-go history cannot be compared
    const first = stream("brief", streamed, source, `${streamed.slice(0, -16)}Something else entirely.`);
    expect(first.masked).toBe(true);
    expect(first.secret).toBe(true);
  });
});
