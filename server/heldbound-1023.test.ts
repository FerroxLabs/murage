// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// q1023-heldbound (MAIN-RULING 2026-11-26T18:44:07Z (A), BGDIAG b50b7c3cdc). Owners: lane q1023-heldbound owns these witnesses; the
// value recorder = harness (harness/masked-values.ts, audience-collector.ts, bus.ts); the owner reply rule = owner-display.ts;
// rulings = MAIN.
//
// The field report: after a tool printed one private key (a service-account JSON, its PEM on one line) or a JWT, EVERY later reply
// of the owner's own turn was "held back", because one masked value longer than 512 characters marked the turn's list of masked
// values incomplete (masked-values.ts add, reason bound). BUS rows, one per bound site of add (SITES.md): the frames one driver emits,
// through the real EventBus, RuntimeAudienceCollector and turn policy; the row is the expression index.ts stores for item.completed
// assistant_text (ownerReplyText, then ownerLatchedReplyText with the event's masked-value view), as in masked-values-1022.test.ts.
// The booted-server rows are in heldbound-api-1023.test.ts. Fixture key material is generated here, never written out.
import { describe, expect, it } from "vitest";
import type { ProviderInstance, RuntimeEvent, SourceContext } from "./contracts.ts";
import { EventBus } from "./harness/bus.ts";
import { MASKED_VALUE_BOUNDS, type MaskedValueView } from "./harness/masked-values.ts";
import { ownerLatchedReplyText, ownerLatchedVerdict, ownerReplyText, REPLY_WITHHELD } from "./owner-display.ts";
import { B64, fixtureChars, JWT, JWT_QUOTE, PEM_LINES, PEM_QUOTE, SA_JSON } from "./testing/heldbound-fixtures-1023.ts";

const THREAD = "owner-thread-fixture";
const NEXT = "Anything else you want me to look into?";
let seq = 0;

type Frame = Record<string, unknown>;
type Seen = { verdict?: string; row?: string; shared?: string; secret: boolean; live: string; displayed?: string; reason?: string; complete?: boolean };
function harness() {
  let emitFn: ((event: RuntimeEvent, source?: SourceContext) => void) | undefined;
  const instance = { instanceId: "engine-fixture", driverKind: "fake", tracksKeyRejection: true,
    adapter: { onEvent(listener: (event: RuntimeEvent, source?: SourceContext) => void) { emitFn = listener; return () => { emitFn = undefined; }; } } };
  const bus = new EventBus(() => {});
  bus.attach([instance as unknown as ProviderInstance]);
  const send = (fields: Frame, source: SourceContext): Seen => {
    const event = { eventId: `hb-${++seq}`, provider: "fake", threadId: THREAD, turnId: "turn-fixture", createdAt: new Date().toISOString(), ...fields } as unknown as RuntimeEvent;
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
    // index.ts handle(): audienceUnproven = () => secret || withheld; maskedValues = () => bus.audienceMaskedValuesFor(executionEvent)
    const audienceUnproven = () => secret || withheld;
    const maskedValues = () => bus.audienceMaskedValuesFor(execution) as MaskedValueView | undefined;
    const view = maskedValues();
    return { secret, displayed, reason: view?.reason, complete: view?.complete,
      verdict: reply ? ownerLatchedVerdict(fields.text, maskedValues) : undefined,
      // index.ts item.completed assistant_text: ownerReplyText, then ownerLatchedReplyText(displayedText, displayField("text"), text, !sharedAudience, audienceUnproven, maskedValues)
      row: reply ? ownerLatchedReplyText(ownerReplyText(displayed, fields.text, true, audienceUnproven), displayed, fields.text, true, audienceUnproven, maskedValues) : undefined,
      // the same row for a shared audience (sharedAudience = true): the 1.0.21 outcome, the masked-value list is never consulted
      shared: reply ? ownerLatchedReplyText(ownerReplyText(displayed, fields.text, false, audienceUnproven), displayed, fields.text, false, audienceUnproven, maskedValues) : undefined,
      live: audience.map(e => e.type === "content.delta" ? String(e.delta ?? "") : "").join("") };
  };
  const turn = (frames: readonly Frame[]) => { const source = (bus.admitNewTurn as any)("engine-fixture", THREAD, { redispatch: false }); return frames.map(frame => send(frame, source)); };
  return { turn };
}
const delta = (text: string): Frame => ({ type: "content.delta", streamKind: "assistant_text", delta: text });
const done = (text: string): Frame => ({ type: "item.completed", itemType: "assistant_text", origin: "engine", text });
const tool = (itemId: string): Frame => ({ type: "item.started", itemType: "tool", origin: "engine", itemId, title: "Bash", input: {} });
const toolDone = (itemId: string, result: unknown): Frame => ({ type: "item.completed", itemType: "tool", itemId, ok: true, result });
const say = (text: string) => [delta(text), done(text)];

const COOKIE_VALUE = fixtureChars(3600, 4242, B64.slice(0, 62));
const LONG = (i: number, n: number) => fixtureChars(n, 50_000 + i, B64.slice(0, 62));

const { MAX_VALUES, VALUE_MAX, VALUES_TOTAL } = MASKED_VALUE_BOUNDS;
// one row per bound site of masked-values.ts add (SITES.md), each through the bus: the tool result, a reply that quotes the value
// past its first 512 characters (or one of the values the base dropped), then a harmless reply
type Row = { site: string; id: string; out: string; quote: string };
const ROWS: readonly Row[] = [
  { site: "VALUE_MAX", id: "a 3 KB service-account JSON, its PEM on one line", out: SA_JSON, quote: `The key line has ${PEM_QUOTE} in it.` },
  { site: "VALUE_MAX", id: "a 2 KB JWT in an authorization header", out: `HTTP/1.1 200 OK\nAuthorization: Bearer ${JWT}\n`, quote: `The token has ${JWT_QUOTE} in it.` },
  { site: "VALUE_MAX", id: "a 3.6 KB session token in an env listing", out: `SESSION_TOKEN=${COOKIE_VALUE}`, quote: `The token has ${COOKIE_VALUE.slice(2000, 2040)} in it.` },
  // 140 masked values of 500 characters each: 70 KB, more than the base's 64 KiB total, none over 512
  { site: "VALUES_TOTAL", id: "140 masked values of 500 characters (70 KB together)", out: Array.from({ length: 140 }, (_, i) => `SVC${i}_SECRET=${LONG(i, 500)}`).join("\n"), quote: `The last one ends ${LONG(139, 500).slice(-40)}.` },
  // 300 distinct masked values: more than the base's 256
  { site: "MAX_VALUES", id: "300 distinct masked values", out: Array.from({ length: 300 }, (_, i) => `SVC${i}_TOKEN=FIXTUREMANY${String(i).padStart(4, "0")}abQZ`).join("\n"), quote: "The last one is FIXTUREMANY0299abQZ." },
];

describe("q1023-heldbound, BUS rows: a long masked value is recorded whole, so the harmless reply after it is shown; any repeat of it is held", () => {
  for (const r of ROWS) it(`HB-${r.site} ${r.id}: the harmless reply is shown; a quote of the value is held`, () => {
    const seen = harness().turn([tool("call-1"), toolDone("call-1", r.out), ...say(r.quote), ...say(NEXT)]);
    expect(seen[1]!.secret).toBe(true);
    // base: incomplete:bound, every later reply held
    expect({ verdict: seen.at(-1)!.verdict, row: seen.at(-1)!.row }).toEqual({ verdict: "shown", row: NEXT });
    // fail closed stays: the reply that repeats part of the value is held, as a repeat of a masked value
    expect({ verdict: seen[3]!.verdict, row: seen[3]!.row }).toEqual({ verdict: "value", row: REPLY_WITHHELD });
    expect(seen.map(s => `${s.live}\n${s.displayed ?? ""}\n${s.row ?? ""}`).join("\n")).not.toContain(r.quote.slice(-30, -1));
  });

  // MAIN-RULING 2026-11-26T19:04:19Z: shared audiences keep the strict rules. The longer list changes nothing there: after each long
  // value every later reply of a shared audience is still the held-back sentence (the list is read only in the owner's own chat)
  it("HB-SHARED after each long value, a shared audience still gets the held-back sentence for the harmless reply (strict rules kept)", () => {
    const shared = ROWS.map(r => harness().turn([tool("call-1"), toolDone("call-1", r.out), ...say(NEXT)]).at(-1)!);
    expect(shared.map(s => s.verdict)).toEqual(ROWS.map(() => "shown"));
    expect(shared.map(s => s.shared)).toEqual(ROWS.map(() => REPLY_WITHHELD));
  });

  it("HB-PEM-PARTS the one-line PEM repeated whole, re-spaced, upper-cased, quoted or by 12 characters of any line is held; the harmless reply is shown", () => {
    const line = PEM_LINES[33]!;
    const variants = [`Here: ${PEM_LINES.join("")}`, `Spaced: ${line.slice(0, 24).split("").join(" ")}`, `Upper: ${line.slice(5, 45).toUpperCase()}`,
      `Quoted: \`${line.slice(0, 20)}\`\`${line.slice(20, 40)}\``, `Twelve: ${PEM_LINES[45]!.slice(40, 52)}`];
    const seen = harness().turn([tool("call-1"), toolDone("call-1", SA_JSON), ...variants.flatMap(say), ...say(NEXT)]);
    const replies = seen.filter(s => s.verdict !== undefined);
    expect(replies.slice(0, -1).map(s => s.row)).toEqual(variants.map(() => REPLY_WITHHELD));
    expect(replies.at(-1)!.row).toBe(NEXT);
  });

  // fail closed past each bound (guards: held on the base too); the mutant that drops the bound turns each RED
  const OVER: ReadonlyArray<{ site: string; id: string; out: string }> = [
    { site: "VALUE_MAX", id: `one masked value longer than VALUE_MAX`, out: `API_SECRET=${LONG(1, VALUE_MAX + 100)}` },
    { site: "VALUES_TOTAL", id: `masked values longer than VALUES_TOTAL together`, out: Array.from({ length: Math.ceil(VALUES_TOTAL / 15_000) + 1 }, (_, i) => `SVC${i}_SECRET=${LONG(1000 + i, 15_000)}`).join("\n") },
    { site: "MAX_VALUES", id: `MAX_VALUES + 44 distinct masked values`, out: Array.from({ length: MAX_VALUES + 44 }, (_, i) => `SVC${i}_TOKEN=FIXTUREMANY${String(i).padStart(5, "0")}abQZ`).join("\n") },
  ];
  for (const o of OVER) it(`HB-OVER-${o.site} ${o.id}: the list is not whole, so the harmless reply is held (incomplete:bound)`, () => {
    const seen = harness().turn([tool("call-1"), toolDone("call-1", o.out), ...say(NEXT)]);
    expect(seen[1]!.secret).toBe(true);
    expect({ verdict: seen.at(-1)!.verdict, row: seen.at(-1)!.row, complete: seen.at(-1)!.complete, reason: seen.at(-1)!.reason }).toEqual({ verdict: "incomplete:bound", row: REPLY_WITHHELD, complete: false, reason: "bound" });
  });
});
