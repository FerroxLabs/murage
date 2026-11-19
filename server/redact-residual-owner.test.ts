// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owner rule (1.0.20): the owner never sees «redacted» in their own threads
// for anything that is not a real secret, and a payload that is only too BIG
// is shortened with a plain note, never masked.
// Item 2 (hunt A0): one oversized tool input/result or image latched the rest
// of the turn masked, and the marker was stored as the reply. Real EventBus,
// real RuntimeAudienceCollector and turn text policy.
// Item 8 (hunt A1-A4): an origin-less owner row, a model/bot name beside a
// redacted span, a room read, and "error: «redacted»".
// Owners: lane hunt-redact2-1020q-n1 wrote these witnesses (branch
// fix/1020-redact-residual); ported onto the late tip's design by fableclose-b
// (branch fix/1020-redact-residual-fable): the owner read view is the tip's
// request-proven `ownerOnly` (index.ts ownerOnlyTranscript -> wireThread).
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection, ProviderInstance, RuntimeEvent, SourceContext } from "./contracts.ts";
import { EventBus } from "./harness/bus.ts";
import { ERROR_REASON_WITHHELD, ownerOnlyDisplay, ownerOnlyRead, ownerShownText, shownErrorDetails, shownErrorReason } from "./owner-display.ts";
import { recoveredSteerLine } from "./send-store.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { sanitizeBotDisplayMessage, wireThread } from "./transcript-page.ts";

const MARK = "«redacted»";
const ANSWER = "The file is written and the tests pass.";
const FIXTURE_SECRET = "api_key=" + "FIXTURESECRET123456";
let seq = 0;

function fakeInstance(instanceId: string) {
  let emitFn: ((event: RuntimeEvent, source?: SourceContext) => void) | undefined;
  const instance = { instanceId, driverKind: "fake", tracksKeyRejection: true,
    adapter: { onEvent(listener: (event: RuntimeEvent, source?: SourceContext) => void) { emitFn = listener; return () => { emitFn = undefined; }; } } };
  return { instance: instance as unknown as ProviderInstance, emit: (event: RuntimeEvent, source?: SourceContext) => emitFn?.(event, source) };
}

/** One admitted owner turn on a fresh bus, driven through the adapter's own onEvent wiring. */
function turn() {
  const bus = new EventBus(() => {}); bus.omitLog(() => true);
  const delivered: RuntimeEvent[] = [];
  bus.subscribe(event => { delivered.push(event); }, { durable: false });
  const engine = fakeInstance("engine-b");
  bus.attach([engine.instance]);
  const source = bus.admitNewTurn("engine-b", "owner-thread");
  const send = (fields: object): RuntimeEvent => {
    engine.emit({ provider: "fake", threadId: "owner-thread", createdAt: "provider-time", eventId: `provider-event-${++seq}`, ...fields } as RuntimeEvent, source);
    return delivered.at(-1)!;
  };
  const shown = (execution: RuntimeEvent) => bus.audienceFor(execution).map(value => value.event as unknown as Record<string, any>);
  return { bus, send, shown };
}

/** The reply row's stored text as server/index.ts foldRuntimeEvent builds it, for a SHARED audience (no owner relaxation). */
function storedSharedText(bus: EventBus, execution: RuntimeEvent): string {
  const display = bus.audienceFor(execution).map(value => value.event).find(value => value.type === execution.type) as { text?: string } | undefined;
  return ownerShownText(display?.text, (execution as { text?: string }).text, false);
}

/** A long text of ordinary words (whitespace every few characters). */
const words = (chars: number) => "const value = compute(input);\n".repeat(Math.ceil(chars / 30)).slice(0, chars);

describe("item 2: an oversized payload is shortened, never a turn-wide mask", () => {
  it("oversize.tool-input: a 200,000-character file write leaves the reply shown and stored", () => {
    const { bus, send, shown } = turn();
    const started = send({ type: "item.started", itemType: "tool", itemId: "write-1", title: "Write", input: { file_path: "notes/big.ts", content: words(200_000) } });
    send({ type: "item.completed", itemType: "tool", itemId: "write-1", ok: true });
    const reply = send({ type: "item.completed", itemType: "assistant_text", itemId: "answer-1", text: ANSWER });
    expect(bus.audienceMaskedFor(reply)).toBe(false);
    expect(shown(reply).map(e => e.type)).toEqual(["item.completed"]);
    expect(storedSharedText(bus, reply)).toBe(ANSWER);
    // the tool row: shown, with its preview shortened and a plain note
    const row = shown(started).find(e => e.type === "item.started")!;
    expect(row.title).toBe("Write");
    const content = (row.preview as { key: string; value: string }[]).find(p => p.key === "content")!.value;
    expect(content.length).toBeLessThan(4_200);
    expect(content).toMatch(/\[shortened: \d+ more characters not shown\]$/);
    expect(content.startsWith("const value = compute(input);")).toBe(true);
    expect(JSON.stringify(shown(started))).not.toContain(MARK);
  });

  it("oversize.tool-result-base64: a 2 MB screenshot in a tool result shows no fragment of it and keeps the reply", () => {
    const { bus, send, shown } = turn();
    send({ type: "item.started", itemType: "tool", itemId: "shot-1", title: "Screenshot", input: {} });
    const done = send({ type: "item.completed", itemType: "tool", itemId: "shot-1", ok: true, result: { content: [{ type: "image", data: "iVBORw0KGgo".repeat(200_000) }] } });
    const reply = send({ type: "item.completed", itemType: "assistant_text", itemId: "answer-1", text: ANSWER });
    expect(bus.audienceMaskedFor(reply)).toBe(false);
    expect(storedSharedText(bus, reply)).toBe(ANSWER);
    const preview = shown(done).find(e => e.type === "item.completed")!.preview as { key: string; value: string }[];
    const data = preview.find(p => p.key === "content.0.data")!.value;
    // a word-less blob is not cut mid-way: none of it is shown, only the note
    expect(data).toBe("[shortened: 2200000 more characters not shown]");
    expect(JSON.stringify(shown(done))).not.toContain(MARK);
  });

  it("oversize.assistant-image: an image over 1 MiB keeps the rest of the turn shown", () => {
    const { bus, send, shown } = turn();
    const image = send({ type: "item.completed", itemType: "assistant_image", itemId: "image-1", alt: "a chart", data: "A".repeat(1_500_000) });
    const reply = send({ type: "item.completed", itemType: "assistant_text", itemId: "answer-1", text: ANSWER });
    expect(shown(image).find(e => e.type === "item.completed")!.alt).toBe("a chart");
    expect(bus.audienceMaskedFor(reply)).toBe(false);
    expect(storedSharedText(bus, reply)).toBe(ANSWER);
  });

  it("control.secret-in-the-shown-part: a real secret in a big input is still withheld", () => {
    const { send, shown } = turn();
    const started = send({ type: "item.started", itemType: "tool", itemId: "write-1", title: "Write", input: { content: `${FIXTURE_SECRET}\n${words(200_000)}` } });
    expect(JSON.stringify(shown(started))).not.toContain("FIXTURESECRET123456");
  });

  it("execution keeps the original, unshortened event", () => {
    const { send } = turn();
    const content = words(200_000);
    const started = send({ type: "item.started", itemType: "tool", itemId: "write-1", title: "Write", input: { content } });
    expect((started as unknown as { input: { content: string } }).input.content).toBe(content);
  });
});

describe("item 8: the owner's own thread never shows a bare «redacted»", () => {
  const selection = (): ModelSelection => ({ instanceId: "engine-b", model: "model-x" });
  beforeEach(() => { removeTempDirSync(DATA_DIR); });
  // `ownerOnly`: what the route proves per request (index.ts ownerOnlyTranscript) and hands to wireThread
  const rows = (store: Store, threadId: string, ownerOnly = false) => (wireThread(store, threadId, { messages: store.messagesFor(threadId) }, { slim: false, ownerOnly }) as { messages: Array<Record<string, any>> }).messages;

  it("A1 owner-read.unstamped-user-row: a call note or pre-origin line reads as the owner's own line", () => {
    const store = new Store(selection);
    const t = store.createBot().threadId;
    // the call-note writer's shape before this fix (no origin), and an old row from before origins existed
    const note = store.appendMessage(t, { role: "user", kind: "text", text: "Please book the table for eight.", actorKind: "owner" } as never);
    const old = store.appendMessage(t, { role: "user", kind: "text", text: "remind me tomorrow" } as never);
    const wire = rows(store, t, true);
    expect(wire.find(m => m.id === note.id)).toMatchObject({ role: "user", kind: "text", text: "Please book the table for eight." });
    expect(wire.find(m => m.id === old.id)).toMatchObject({ role: "user", kind: "text", text: "remind me tomorrow" });
    expect(JSON.stringify(wire)).not.toContain(MARK);
    // no owner text exemption without a proven origin: a secret in such a row is still redacted inline
    const secret = store.appendMessage(t, { role: "user", kind: "text", text: `my key ${FIXTURE_SECRET}` } as never);
    expect(rows(store, t, true).find(m => m.id === secret.id)!.text).not.toContain("FIXTURESECRET123456");
    // a shared audience keeps the unknown-author mask
    expect(rows(store, t).find(m => m.id === note.id)).toMatchObject({ role: "bot", kind: "activity", text: MARK });
  });

  it("A1 recovered steer keeps the send's origin", () => {
    expect(recoveredSteerLine({ text: "also add a summary", queueId: "q-1", origin: "desktop" } as never, "steer-1")).toMatchObject({ role: "user", origin: "desktop" });
    expect(recoveredSteerLine({ text: "x", queueId: "q-2", origin: null } as never, "steer-2")).not.toHaveProperty("origin");
  });

  // A2 as the lane built it (a FRESH hit masks no sibling for the owner) is NOT on this branch: the late tip's own
  // witness (transcript-page.test.ts "an old marker keeps its field without blanking its owner-only row siblings")
  // requires a fresh hit to mask siblings for the owner too. Kept here: the hit is redacted inline in its own field,
  // and a STORED marker masks no sibling for the owner (A3 below). Open question for MAIN in fableclose-b/rd/DONE.md.
  it("A2 owner-read.fresh-hit: the hit is redacted inline; siblings follow the tip's rule for a fresh hit", () => {
    const row = { id: "r1", at: 1, role: "bot", kind: "text", text: `Set it with ${FIXTURE_SECRET} in the file.`,
      engine: { instanceId: "engine-b", driverKind: "fake", model: "model-x" }, servedModel: "model-x", from: { botId: "bot-1", name: "Sable" } };
    const owner = sanitizeBotDisplayMessage(row, { authorship: "bot", ownerOnly: true }) as Record<string, any>;
    expect(owner.text).toMatch(/^Set it with api_key=«redacted \d+ chars» in the file\.$/);
    expect(owner.engine.model).toBe(MARK);
    // a shared audience still masks the row's siblings
    const shared = sanitizeBotDisplayMessage(row, { authorship: "bot" }) as Record<string, any>;
    expect(shared.engine.model).toBe(MARK);
  });

  it("A3 room-read: a room the owner runs is read with the owner view; its rows are still written on the shared mask", () => {
    const room = { directBotThread: false, room: true, ownerPrincipal: true, notOwnerTurn: false, pairedChannel: false };
    expect(ownerOnlyRead(room)).toBe(true);
    expect(ownerOnlyDisplay(room)).toBe(false);
    expect(ownerOnlyRead({ ...room, pairedChannel: true })).toBe(false);
    expect(ownerOnlyRead({ ...room, ownerPrincipal: false })).toBe(false);
    expect(ownerOnlyRead({ ...room, notOwnerTurn: true })).toBe(false);
    // the read itself: a stored inline span masks nothing else in that room for the owner
    const store = new Store(selection);
    const t = "room-thread";
    const stored = store.appendMessage(t, { role: "bot", kind: "text", text: `token ${MARK} rest`, engine: { instanceId: "engine-b", driverKind: "fake", model: "model-x" }, from: { botId: "bot-1", name: "Sable" } } as never);
    // the write: a reply holding the policy's own inline span is stored with it, not as a bare marker (store.ts redactBotAuthored)
    expect(stored.text).toBe(`token ${MARK} rest`);
    expect(store.messagesFor(t).find(m => m.id === stored.id)!.text).toBe(`token ${MARK} rest`);
    const shown = rows(store, t, ownerOnlyRead(room)).find(m => m.id === stored.id)!;
    expect(shown.text).toBe(`token ${MARK} rest`);
    expect(shown.engine.model).toBe("model-x");
    expect(shown.from.name).toBe("Sable");
    // a shared reader of the same row keeps the conservative sibling mask
    expect(rows(store, t).find(m => m.id === stored.id)!.engine.model).toBe(MARK);
  });

  it("A3 write: a direct-thread reply with an inline redaction is stored and read back with its words", () => {
    const store = new Store(selection);
    const t = store.createBot().threadId;
    const text = `Your config has api_key=«redacted 19 chars» on line 3; move it to the keychain.`;
    const stored = store.appendMessage(t, { role: "bot", kind: "text", text, engine: { instanceId: "engine-b", driverKind: "fake", model: "model-x" } } as never);
    expect(stored.text).toBe(text);
    expect(rows(store, t, true).find(m => m.id === stored.id)).toMatchObject({ text, engine: { model: "model-x" } });
  });

  it("A4 error-reason: a runtime.error with no admitted turn never reads \"error: «redacted»\"", () => {
    const bus = new EventBus(() => {}); bus.omitLog(() => true);
    const delivered: RuntimeEvent[] = [];
    bus.subscribe(event => { delivered.push(event); }, { durable: false });
    const engine = fakeInstance("engine-b");
    bus.attach([engine.instance]);
    // a late engine error, outside any turn's source
    engine.emit({ provider: "fake", threadId: "owner-thread", createdAt: "t", eventId: "err-1", type: "runtime.error", message: "The engine closed its connection.", details: "exit 1" } as RuntimeEvent, undefined);
    const execution = delivered.at(-1)!;
    const display = bus.audienceFor(execution).map(v => v.event).find(v => v.type === "runtime.error") as { message?: string; details?: string } | undefined;
    expect(display?.message).toBe(MARK);
    // shared audience: Murage's own sentence, no details
    expect(shownErrorReason(display?.message, "The engine closed its connection.", false)).toBe(ERROR_REASON_WITHHELD);
    expect(shownErrorDetails(display?.details, "exit 1", false)).toBeUndefined();
    // the owner alone: the engine's own words when they scan clean
    expect(shownErrorReason(display?.message, "The engine closed its connection.", true)).toBe("The engine closed its connection.");
    // a real secret in the reason, for the owner: never the bare marker
    expect(shownErrorReason(display?.message, `bad ${FIXTURE_SECRET}`, true)).toBe(ERROR_REASON_WITHHELD);
    // an inline redaction stays as it was
    expect(shownErrorReason(`bad api_key=${MARK}`, undefined, false)).toBe(`bad api_key=${MARK}`);
  });
});
