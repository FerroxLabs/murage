// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.20 redact2. Owners: redact2-1020 builder owns the stored assistant row's owner view (owner-display.ts ownerReplyText and its one
// index.ts call, item.completed assistant_text); the harness owns the collector (harness/audience-collector.ts) and its fence mask.
//
// Live shape (owner report, routine thread, Run now): Murage left stored context out of the turn, the memory fence refused and the turn
// was re-prepared (a new admission on the same thread), and the bot's progress messages still in flight from the replaced source, or
// relayed with no source, reached the collector as an invalid source. It projects those as the bare marker, and index.ts stored
// `displayField("text") ?? "«redacted»"` as the row: the owner's chat showed «redacted» bubbles for his bot's own words.
// Real EventBus and collector; the row text is computed by the same expression index.ts stores.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProviderInstance, RuntimeEvent, SourceContext } from "./contracts.ts";
import { EventBus } from "./harness/bus.ts";
import { ownerReplyText, REPLY_WITHHELD } from "./owner-display.ts";
import { sanitizeBotDisplayMessage } from "./transcript-page.ts";

const MARK = "«redacted»";
const THREAD = "routine-thread-fixture";
const PROGRESS = "Still sweeping the operators table; two sources checked so far.";
const FIXTURE_SECRET = "api_key=" + "FIXTURESECRET123456";
let seq = 0;

function harness() {
  let emitFn: ((event: RuntimeEvent, source?: SourceContext) => void) | undefined;
  const instance = { instanceId: "claude-fixture", driverKind: "fake", tracksKeyRejection: true,
    adapter: { onEvent(listener: (event: RuntimeEvent, source?: SourceContext) => void) { emitFn = listener; return () => { emitFn = undefined; }; } } };
  const bus = new EventBus(() => {});
  bus.attach([instance as unknown as ProviderInstance]);
  const emit = (text: string, source?: SourceContext) => {
    const event = { type: "item.completed", itemType: "assistant_text", itemId: `item-${++seq}`, eventId: `e-${seq}`, provider: "fake",
      threadId: THREAD, turnId: "routine-turn", createdAt: new Date().toISOString(), text } as unknown as RuntimeEvent;
    let seen: RuntimeEvent | undefined;
    const off = bus.subscribe(e => { if (e.eventId === event.eventId) seen = e; });
    emitFn!(event, source);
    off?.();
    const execution = seen ?? event;
    const displayed = bus.audienceFor(execution).map(e => e.event).find(e => e.type === "item.completed") as { text?: string } | undefined;
    return { execution, displayed: displayed?.text, masked: bus.audienceMaskedFor(execution), secret: bus.audienceSecretMaskedFor(execution) };
  };
  return { bus, emit };
}

/** What index.ts stores as the row (item.completed assistant_text) for the owner's own direct thread or a shared audience. */
const rowText = (r: ReturnType<ReturnType<typeof harness>["emit"]>, raw: string, ownerOnly: boolean) =>
  ownerReplyText(r.displayed, raw, ownerOnly, r.secret);

describe("1.0.20 redact2: an owner's bot's own words are never stored as a «redacted» bubble", () => {
  it("re-prepare after a fence refusal: an in-flight progress message of the replaced source is stored as the bot's words", () => {
    const { bus, emit } = harness();
    const first = bus.admitNewTurn("claude-fixture", THREAD);
    expect(rowText(emit("Approved 18 steps; starting the sweep now.", first), "Approved 18 steps; starting the sweep now.", true)).toBe("Approved 18 steps; starting the sweep now.");
    // context revoked during dispatch; re-preparing (1 of 2): a new admission on the same thread replaces the first
    bus.admitNewTurn("claude-fixture", THREAD);
    const late = emit(PROGRESS, first);
    // the collector withholds the stale source (a fence, not a finding about the words)
    expect(late.masked).toBe(true);
    expect(late.secret).toBe(false);
    expect(late.displayed ?? MARK).toBe(MARK);
    const stored = rowText(late, PROGRESS, true);
    expect(stored).toBe(PROGRESS);
    expect(stored).not.toContain(MARK);
  });

  it("a progress message relayed with no source (unowned) is stored as the bot's words in the owner's thread", () => {
    const { emit } = harness();
    const r = emit(PROGRESS);
    expect(r.masked).toBe(true);
    expect(rowText(r, PROGRESS, true)).toBe(PROGRESS);
  });

  it("a masked message whose own words do not scan clean is a plain one-line notice, never the bare marker", () => {
    const { emit } = harness();
    const words = `Found the config: ${FIXTURE_SECRET}`;
    const r = emit(words);
    const stored = rowText(r, words, true);
    expect(stored).toBe(REPLY_WITHHELD);
    expect(stored).not.toContain(MARK);
    expect(stored).not.toContain("FIXTURESECRET");
  });

  it("a turn its own secret scan latched never shows raw words to the owner, and never a bare marker either", () => {
    const { bus, emit } = harness();
    const source = bus.admitNewTurn("claude-fixture", THREAD);
    const hit = emit(`Here it is: ${FIXTURE_SECRET}`, source);
    expect(hit.secret).toBe(true);
    const later = emit(PROGRESS, source);
    const stored = rowText(later, PROGRESS, true);
    expect(stored).not.toBe(PROGRESS);
    expect(stored.replaceAll(MARK, "").trim()).not.toBe("");
    expect(rowText(hit, `Here it is: ${FIXTURE_SECRET}`, true)).not.toContain("FIXTURESECRET");
  });

  it("a shared audience keeps the marker (rooms, channel people, guests)", () => {
    const { emit } = harness();
    expect(rowText(emit(PROGRESS), PROGRESS, false)).toBe(MARK);
  });

  it("index.ts stores the assistant row through ownerReplyText, never a bare marker fallback", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).not.toContain('displayField("text") ?? "«redacted»"');
    expect(source).toMatch(/const displayedText = ownerReplyText\(displayField\("text"\), text, \(\) => ownerOnlyDisplayThread\(event\.threadId\), \(\) => bus\.audienceSecretMaskedFor\(executionEvent\)\);/);
  });

  it("a row already stored as the bare marker (the routine thread's two bubbles) reads as a plain line for the owner alone", () => {
    const row = { id: "row-1", role: "bot", kind: "text", text: MARK, turnId: "routine-turn" };
    expect(sanitizeBotDisplayMessage(row, { authorship: "bot", ownerOnly: true }).text).toBe(REPLY_WITHHELD);
    expect(sanitizeBotDisplayMessage(row, { authorship: "bot", ownerOnly: false }).text).toBe(MARK);
    // an inline redaction inside real words keeps the words
    const inline = { id: "row-2", role: "bot", kind: "text", text: `Checked the table. ${MARK} Two left.`, turnId: "routine-turn" };
    expect(sanitizeBotDisplayMessage(inline, { authorship: "bot", ownerOnly: true }).text).toContain("Two left.");
  });
});
