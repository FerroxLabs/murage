// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.22 cause B (deep1022-causeB-design/DESIGN.md section 7, rows marked BUS, and the unit rows of sections 2.1-2.3).
// Owners: lane deep1022-causeB-fable owns these witnesses; the value recorder = harness (harness/masked-values.ts,
// harness/audience-collector.ts, harness/bus.ts); the policy's latch payload = redact-turn.ts; the owner reply rule =
// owner-display.ts; rulings = MAIN.
//
// BUS rows: the frames one driver emits, through the real EventBus, RuntimeAudienceCollector and turn policy; the row text is the
// very expression index.ts stores for item.completed assistant_text (ownerReplyText with the event's masked-value view), and the
// error row is the expression index.ts stores for runtime.error (shownErrorReason). No engine process runs in this file: the rows
// that need one (W1-W3, W5-W7, W10, W11, H1, H2) are in withheld-values-api-1022.test.ts on a booted server. W4 and H3 are here
// because the fake Claude engine cannot emit content.reset (an ACP/pi frame); W9 is here because a re-dispatch only follows a
// refusal the engine never read (index.ts canRetry), so no engine output of a first attempt can be scripted on a booted server.
// H1-H3: the FABLE design review's three Highs (dr-causeB-fable/REVIEW.md), MAIN-RULING 2026-11-24T19:07:24Z.
import { describe, expect, it } from "vitest";
import type { ProviderInstance, RuntimeEvent, SourceContext } from "./contracts.ts";
import { maskedSpanValues } from "./harness/masked-values.ts";
import { EventBus } from "./harness/bus.ts";
import * as ownerDisplay from "./owner-display.ts";
import { ERROR_REASON_WITHHELD, ownerReplyText, REPLY_WITHHELD, shownErrorReason } from "./owner-display.ts";
import { createTurnTextPolicy } from "./redact-turn.ts";
import { scanTurnText } from "./redact.ts";

const THREAD = "owner-thread-fixture";
const NEXT = "Anything else you want me to look into?";
const DONE = "Done, the migration ran.";
const V = "FIXTUREVALUE" + "7731abQZ";          // the value the tool result is masked for
const V2 = "SECONDFIXTURE" + "5520xyKW";        // a value first seen after the latch
const W = "quiet" + "harbor";                    // a second masked value: one class of character, under 12 (only the WHOLE rule finds it)
const TOOL_OUT = `DB_PASSWORD=${V}\nADMIN_PASSWORD=${W}`;
const BASIC_VALUE = "dXNlcjpw" + "YXNz";
let seq = 0;

type Frame = Record<string, unknown>;
type Seen = { source: SourceContext; verdict?: string; why?: string; type: string; raw?: string; displayed?: string; secret: boolean; withheld: boolean; row?: string; shared?: string; masked?: string; error?: string; live: string; reason?: string; complete?: boolean };
// the modules of the fix; on the base they do not exist and every view below is undefined (the 1.0.21 outcome)
const viewOf = (bus: EventBus, event: RuntimeEvent) => (bus as unknown as { audienceMaskedValuesFor?: (e: RuntimeEvent) => { complete: boolean; reason?: string } | undefined }).audienceMaskedValuesFor?.(event); const latchedReply = ((ownerDisplay as any).ownerLatchedReplyText ?? ((stored: string) => stored)) as (...args: any[]) => string;

function harness(policy?: ReturnType<typeof createTurnTextPolicy>, force?: (view: any) => any) {
  let emitFn: ((event: RuntimeEvent, source?: SourceContext) => void) | undefined;
  const instance = { instanceId: "engine-fixture", driverKind: "fake", tracksKeyRejection: true,
    adapter: { onEvent(listener: (event: RuntimeEvent, source?: SourceContext) => void) { emitFn = listener; return () => { emitFn = undefined; }; } } };
  const bus = new EventBus(() => {}, policy as unknown as ConstructorParameters<typeof EventBus>[1]);
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
    // index.ts handle(): const audienceUnproven = () => secret || withheld; const maskedValues = () => bus.audienceMaskedValuesFor(executionEvent)
    const audienceUnproven = () => secret || withheld;
    const maskedValues = () => { const view = viewOf(bus, execution); return force ? force(view) : view; };
    const view = viewOf(bus, execution);
    return { source, verdict: reply ? (ownerDisplay as any).ownerLatchedVerdict?.(fields.text, maskedValues) : undefined, why: reply ? (ownerDisplay as any).ownerLatchedWhy?.(fields.text, maskedValues) : undefined, type: String(fields.type), raw: reply ? String(fields.text) : undefined, displayed, secret, withheld, reason: view?.reason, complete: view?.complete,
      // index.ts item.completed assistant_text: displayedText = ownerReplyText(displayField("text"), text, ownerOnly, audienceUnproven); then replyText = ownerLatchedReplyText(displayedText, displayField("text"), text, !sharedAudience, audienceUnproven, maskedValues)
      row: reply ? latchedReply(ownerReplyText(displayed, fields.text, true, audienceUnproven), displayed, fields.text, true, audienceUnproven, maskedValues) : undefined,
      // index.ts item.completed assistant_text: ownerMasked = ownerMaskedReplyText(displayField("text"), text, () => ownerOnlyDisplayThread(threadId), maskedValues), the owner's own chat reply (masked in place, never held)
      masked: reply ? (ownerDisplay as any).ownerMaskedReplyText?.(displayed, fields.text, () => true, maskedValues) : undefined,
      shared: reply ? latchedReply(ownerReplyText(displayed, fields.text, false, audienceUnproven), displayed, fields.text, false, audienceUnproven, maskedValues) : undefined,
      // index.ts runtime.error: errorOwnerView = () => !audienceUnproven() && ownerOnlyDisplayThread(...); shownErrorReason(displayField("message"), event.message, errorOwnerView)
      error: fields.type === "runtime.error" ? shownErrorReason(typeof own?.message === "string" ? own.message : undefined, fields.message, () => !audienceUnproven() && true) : undefined,
      live: audience.map(e => e.type === "content.delta" ? String(e.delta ?? "") : e.type === "content.reset" ? "<reset>" : "").join("") };
  };
  /** One owner turn: a new admission for the thread (index.ts admitLedgerLease), then its frames. */
  /** `redispatch`: a memory rebuild of the same owner message (index.ts admitLedgerLease). */
  const turn = (frames: readonly Frame[], redispatch = false) => { const source = (bus.admitNewTurn as any)("engine-fixture", THREAD, { redispatch }); return frames.map(frame => send(frame, source)); };
  return { bus, turn };
}
const delta = (text: string, itemId?: string): Frame => ({ type: "content.delta", streamKind: "assistant_text", delta: text, ...(itemId ? { itemId } : {}) });
const done = (text: string, itemId?: string): Frame => ({ type: "item.completed", itemType: "assistant_text", origin: "engine", text, ...(itemId ? { itemId } : {}) });
const reset = (itemId?: string): Frame => ({ type: "content.reset", streamKind: "assistant_text", ...(itemId ? { itemId } : {}) });
const tool = (itemId: string, title = "Bash"): Frame => ({ type: "item.started", itemType: "tool", origin: "engine", itemId, title, input: {} });
const toolDone = (itemId: string, result: unknown): Frame => ({ type: "item.completed", itemType: "tool", itemId, ok: true, result });
/** A tool call whose result holds a credential: the turn's own scan latches here. */
const LATCH: readonly Frame[] = [tool("call-1"), toolDone("call-1", TOOL_OUT)];
const everything = (seen: readonly Seen[]) => seen.map(s => `${s.live}\n${s.displayed ?? ""}\n${s.row ?? ""}\n${s.shared ?? ""}\n${s.error ?? ""}`).join("\n");
const rows = (seen: readonly Seen[]) => seen.filter(s => s.raw !== undefined).map(s => s.row);

describe("1.0.22 cause B, BUS rows: a later reply of a latched turn is held back only when it repeats what the turn masked", () => {
  it("W1-bus the field bug: a tool result holds a credential, the harmless reply after it is the reply", () => {
    const seen = harness().turn([...LATCH, delta(DONE), done(DONE)]);
    expect(seen[1]!.secret).toBe(true);
    expect(seen.at(-1)!.row).toBe(DONE);
    expect(seen.at(-1)!.shared).toBe(REPLY_WITHHELD); // a shared audience keeps the 1.0.21 outcome
    expect(everything(seen)).not.toContain(V);
  });

  // W4: cut 1's failure cases. Each G shape of withheld-retract-1022.test.ts after a tool result latched the turn; the G assertion is
  // unchanged (its value is in no row, frame or projection) and the harmless reply after it is shown.
  const G: ReadonlyArray<{ id: string; value: string; frames: readonly Frame[] }> = [
    { id: "G3 a label taken back and its value sent after the reset", value: V2, frames: [delta("api_key=", "text-1"), reset("text-1"), delta(`${V2}\n`, "text-1"), done(`${V2}\n`, "text-1")] },
    { id: "G4 a credential cut in two by the reset", value: V2, frames: [delta("api_k", "text-1"), reset("text-1"), delta(`ey=${V2}\n`, "text-1"), done(`ey=${V2}\n`, "text-1")] },
    { id: "G7 a label left unfinished at the reset and its value on the next line", value: BASIC_VALUE, frames: [delta("Bearer", "text-1"), reset("text-1"), delta(`${BASIC_VALUE}\n`, "text-1"), done(`${BASIC_VALUE}\n`, "text-1")] },
    { id: "G9 an earlier message ended on a label, a take-back in the next one, then the value", value: BASIC_VALUE, frames: [delta("Bearer", "text-1"), done("Bearer", "text-1"), delta("Sure, ", "text-2"), reset("text-2"), delta(`${BASIC_VALUE}\n`, "text-2"), done(`${BASIC_VALUE}\n`, "text-2")] },
    { id: "G10 a label cut in two by the reset, its second half on one line and the value on the next", value: "hunter22", frames: [delta("pass", "text-1"), reset("text-1"), delta("word=\n", "text-1"), delta("hunter22\n", "text-1"), done("word=\nhunter22\n", "text-1")] },
    { id: "G11 a label cut in two by the reset, completed as its own item, its value in the next item", value: "hunter22", frames: [delta("pass", "text-1"), reset("text-1"), delta("word=\n", "text-1"), done("word=\n", "text-1"), delta("hunter22\n", "text-2"), done("hunter22\n", "text-2")] },
    { id: "G11h the same after a hosted tool row", value: "hunter22", frames: [delta("pass", "text-1"), reset("text-1"), delta("word=\n", "text-1"), done("word=\n", "text-1"), tool("hosted-1", "web_search"), toolDone("hosted-1", "two results"), delta("hunter22\n", "text-2"), done("hunter22\n", "text-2")] },
    { id: "G12 a label split across two take-backs", value: "hunter22", frames: [delta("pa", "text-1"), reset("text-1"), delta("ss", "text-1"), reset("text-1"), delta("word=hunter22\n", "text-1"), done("word=hunter22\n", "text-1")] },
    // FABLE H3: all pieces joined (`Checking configapi_key=<v>`) hides the label; the run `api_key=` alone shows it
    { id: "H3 two take-backs, the label is the second piece (every run of the pieces is read, not only all of them joined)", value: V2, frames: [delta("Checking config", "text-1"), reset("text-1"), delta("api_key=", "text-1"), reset("text-1"), delta(`${V2}\n`, "text-1"), done(`${V2}\n`, "text-1")] },
    { id: "H3n two take-backs, the label completed as its own item, its value in the next item", value: "hunter22", frames: [delta("Checking config", "text-1"), reset("text-1"), delta("pass", "text-1"), reset("text-1"), delta("word=\n", "text-1"), done("word=\n", "text-1"), delta("hunter22\n", "text-2"), done("hunter22\n", "text-2")] },
    // ASTRA 4f1bc47bb3: the policy keeps the runs that ended at EARLIER take-backs (redact-turn.ts retract, s.back) and reads later text after each
    { id: "H3e two take-backs, the label is the FIRST piece (a run that ended at an earlier take-back is read too)", value: V2, frames: [delta("api_key=", "text-1"), reset("text-1"), delta("Checking config", "text-1"), reset("text-1"), delta(`${V2}\n`, "text-1"), done(`${V2}\n`, "text-1")] },
    { id: "H3e3 three take-backs, the label is the middle piece", value: V2, frames: [delta("Looking", "text-1"), reset("text-1"), delta("api_key=", "text-1"), reset("text-1"), delta("Checking config", "text-1"), reset("text-1"), delta(`${V2}\n`, "text-1"), done(`${V2}\n`, "text-1")] },
  ];
  for (const g of G) it(`W4 ${g.id}: after an earlier latch its value is in no row, and the harmless reply after it is shown`, () => {
    const seen = harness().turn([...LATCH, ...g.frames, delta(NEXT, "text-9"), done(NEXT, "text-9")]);
    expect(seen[1]!.secret).toBe(true);
    expect(everything(seen)).not.toContain(g.value);
    expect(everything(seen)).not.toContain(V);
    expect(seen.at(-1)!.row).toBe(NEXT);
  });

  it("W2-bus cut 2 H1: the reply repeats the masked value in prose, spaced, re-cased, quoted, over a line break or in part; each is held, the harmless reply is shown", () => {
    const variants = [`The database password is ${V}.`, `It is ${V.split("").join(" ")} if you need it.`, `Upper case: ${V.toUpperCase()}`, `Quoted: \`${V.slice(0, 9)}\`\`${V.slice(9)}\``,
      `Split: ${V.slice(0, 10)}\n${V.slice(10)}`, `It ends in ${V.slice(-8)}.`, `It starts with ${V.slice(0, 12).toLowerCase()} and more.`, `The admin one, spaced: ${W.split("").join(" ")}`];
    const seen = harness().turn([...LATCH, ...variants.flatMap(text => [delta(text), done(text)]), delta("All set."), done("All set.")]);
    expect(rows(seen).slice(0, -1)).toEqual(variants.map(() => REPLY_WITHHELD));
    expect(seen.at(-1)!.row).toBe("All set.");
    expect(everything(seen)).not.toContain(V);
    expect(everything(seen)).not.toContain(V.slice(-8));
    expect(everything(seen)).not.toContain(W.split("").join(" "));
  });

  // FABLE H1: the scanner's span for a label form is the whole match, label included; the VALUE is recorded
  it("H1-bus a one-class value of 8 letters under a label (`NAME=value`, `name: value`) repeated bare is held; the harmless reply is shown", () => {
    const one = "lanterns", two = "harbours";
    const seen = harness().turn([tool("call-1"), toolDone("call-1", `SMTP_PASSWORD=${one}`), tool("call-2"), toolDone("call-2", `password: ${two}`),
      delta(`The mail password is ${one}.`), done(`The mail password is ${one}.`), delta(`And the other one is ${two}, as before.`), done(`And the other one is ${two}, as before.`), delta(NEXT), done(NEXT)]);
    expect(seen[1]!.secret).toBe(true);
    expect(rows(seen)).toEqual([REPLY_WITHHELD, REPLY_WITHHELD, NEXT]);
    expect(everything(seen)).not.toContain(one);
    expect(everything(seen)).not.toContain(two);
  });

  // FABLE 4f1bc47bb3 H1: a region line with no label was still cut at `=` or `:`, so a value holding one lost its head. Each row: the
  // tool result under a marked label, the replies that repeat part of the value (each held), then the harmless reply (shown).
  const PADDED = "q83Jd0Lx" + "Za71MnPw" + "kT5vYb";   // 22 characters, then `==` as base64 of 16 bytes ends
  const LEFT = "correcthorse" + "battery", RIGHT = "staple" + "xyz";
  const UNLABELLED = [
    { id: "pad a base64 value ending in ==, one line under a marked label", out: `**API key:** ${PADDED}==`, repeats: [`It is ${PADDED} without the padding.`, `It starts with ${PADDED.slice(0, 14)}.`, `Upper case: ${PADDED.toUpperCase()}`], parts: [PADDED, PADDED.slice(0, 14)] },
    { id: "padline the same value on the line after its marked label", out: `**API key:**\n${PADDED}==\n`, repeats: [`It is ${PADDED} without the padding.`, `It starts with ${PADDED.slice(0, 14)}.`], parts: [PADDED, PADDED.slice(0, 14)] },
    { id: "colon a value with a colon inside: the part before the colon is the value too", out: `**Password:** ${LEFT}:${RIGHT}`, repeats: [`The first half is ${LEFT}.`, `Both halves: ${LEFT}:${RIGHT}`, `The second half is ${RIGHT}.`], parts: [LEFT, RIGHT] },
    { id: "equals a value with = inside", out: `**Secret:** ${LEFT}=${RIGHT}`, repeats: [`The first half is ${LEFT}.`], parts: [LEFT] },
  ];
  for (const u of UNLABELLED) it(`H1u-bus ${u.id}: every repeat of a part of it is held, the harmless reply is shown`, () => {
    const seen = harness().turn([tool("call-1"), toolDone("call-1", u.out), ...u.repeats.flatMap(text => [delta(text), done(text)]), delta(NEXT), done(NEXT)]);
    expect(seen[1]!.secret).toBe(true);
    expect(rows(seen), seen.map(s => s.verdict).join()).toEqual([...u.repeats.map(() => REPLY_WITHHELD), NEXT]);
    for (const part of u.parts) expect(everything(seen)).not.toContain(part);
  });
  it("H1u-bus guard: the label of a `NAME=value` line is still not a value (a reply that only names it is shown)", () => {
    const named = "I left AWS_SECRET_ACCESS_KEY and DB_PASSWORD out of this.";
    const seen = harness().turn([tool("call-1"), toolDone("call-1", `AWS_SECRET_ACCESS_KEY=${V}\nDB_PASSWORD=${W}`), delta(named), done(named)]);
    expect(seen[1]!.secret).toBe(true);
    expect(seen.at(-1)!.row).toBe(named);
  });

  // ASTRA e167d43947 class (text let go before it was read): an item still open at the latch whose earlier text was cut to its tail
  it("W-cut an open reply longer than the kept tail, then a latch: the list is not claimed whole, so the later reply keeps the 1.0.21 outcome", () => {
    const line = "the quick brown fox jumps over the lazy dog again and again\n";
    const chunk = line.repeat(500); // 30 000 characters a delta, 6 deltas
    const seen = harness().turn([...Array.from({ length: 6 }, () => delta(chunk, "text-1")), ...LATCH, delta(NEXT, "text-2"), done(NEXT, "text-2")]);
    expect(seen[5]!.secret).toBe(false);   // the long text itself latched nothing
    expect(seen[7]!.secret).toBe(true);
    expect(seen.at(-1)!.row).toBe(REPLY_WITHHELD);
    expect(seen.at(-1)!.reason).toBe("tail-evicted");
    // control: the same turn with a short open reply is shown
    const short = harness().turn([delta(line, "text-1"), ...LATCH, delta(NEXT, "text-2"), done(NEXT, "text-2")]);
    expect(short.at(-1)!.row).toBe(NEXT);
  });
  it("W-big one tool result far longer than the kept tail with a credential at its start and one at its end: both are recorded (it is read whole)", () => {
    const first = "lanterns", last = "harbours";
    const big = `SMTP_PASSWORD=${first}\n${"plain words of a long log line, nothing to see\n".repeat(4000)}ADMIN_PASSWORD=${last}\n`;
    const seen = harness().turn([tool("call-1"), toolDone("call-1", big), delta(`It is ${first}.`), done(`It is ${first}.`), delta(`And ${last}.`), done(`And ${last}.`), delta(NEXT), done(NEXT)]);
    expect(seen[1]!.secret).toBe(true);
    expect(rows(seen).slice(0, 2)).toEqual([REPLY_WITHHELD, REPLY_WITHHELD]);
    expect(everything(seen)).not.toContain(first);
  });

  // FABLE H2: an indented label masks to the end of the text and the scan stops there; the credential further down is recorded too
  it("H2-bus an indented config with two credentials: the second one repeated bare is held; the harmless reply is shown", () => {
    const config = "database:\n  password: sunshine\n  host: db.example.test\n  port: 5432\n  replica_password: moonlight\n";
    const seen = harness().turn([tool("call-1"), toolDone("call-1", config), delta("The replica password is moonlight."), done("The replica password is moonlight."),
      delta("The first one is sunshine."), done("The first one is sunshine."), delta(NEXT), done(NEXT)]);
    expect(seen[1]!.secret).toBe(true);
    expect(rows(seen)).toEqual([REPLY_WITHHELD, REPLY_WITHHELD, NEXT]);
    expect(everything(seen)).not.toContain("moonlight");
    expect(everything(seen)).not.toContain("sunshine");
    // the labels and the other settings of that file are not values: a reply that only names them is shown
    const named = "I left the replica password and the database host out of this.";
    const again = harness().turn([tool("call-1"), toolDone("call-1", config), delta(named), done(named)]);
    expect(again.at(-1)!.row).toBe(named);
  });

  // self-review H2: a marked label whose value line has more words (`**Password**: sunshine (prod)`): the value is recorded by itself
  it("H2w-bus a marked label with words after its value: the value repeated bare is held; the harmless reply is shown", () => {
    const seen = harness().turn([tool("call-1"), toolDone("call-1", "**Password**: sunshine (prod)\nSee the wiki for the rest."), delta("The password is sunshine."), done("The password is sunshine."), delta(NEXT), done(NEXT)]);
    expect(seen[1]!.secret).toBe(true);
    expect(rows(seen)).toEqual([REPLY_WITHHELD, NEXT]);
    expect(everything(seen)).not.toContain("sunshine");
  });

  // self-review H1: a SHORT value that holds a character the normal form drops (`_`, a quote), or written with its characters apart
  it("S1-bus a short value with an underscore or a quote in it, exact or spaced out, is held; the same letters inside a longer word are not", () => {
    const seen = harness().turn([tool("call-1"), toolDone("call-1", "password: blue_sky"), tool("call-2"), toolDone("call-2", "password: o'brien"), tool("call-3"), toolDone("call-3", "password: xk42"),
      // a short value that mixes letters and digits is held wherever it stands (the WHOLE rule; it has no windows and no skeleton of 8)
      delta("The short one is xk42."), done("The short one is xk42."),
      delta("It is blue_sky."), done("It is blue_sky."), delta("Spelled out: b l u e s k y"), done("Spelled out: b l u e s k y"), delta("Ask o'brien about it."), done("Ask o'brien about it."),
      delta("The blueskying team is fine."), done("The blueskying team is fine."), delta(NEXT), done(NEXT)]);
    expect(seen[1]!.secret).toBe(true);
    expect(rows(seen), seen.map(s => s.verdict).join()).toEqual([REPLY_WITHHELD, REPLY_WITHHELD, REPLY_WITHHELD, REPLY_WITHHELD, "The blueskying team is fine.", NEXT]);
    expect(everything(seen)).not.toContain("blue_sky");
  });

  // attack set a31: the label ends one tool result, the value starts the next (two items, the same kind of field)
  it("W15-bus a label at the end of one tool result and its value at the start of the next: the repeat is held; the harmless reply is shown", () => {
    const seen = harness().turn([...LATCH, tool("call-2"), toolDone("call-2", "replica settings follow\nreplica_token:"), tool("call-3"), toolDone("call-3", `${V2}\nend of file`),
      delta(`The replica token is ${V2}.`), done(`The replica token is ${V2}.`), delta(NEXT), done(NEXT)]);
    expect(rows(seen), seen.map(s => s.verdict).join()).toEqual([REPLY_WITHHELD, NEXT]);
    expect(everything(seen)).not.toContain(V2);
  });

  // attack set a47: pieces of the value under 8 characters, one per reply (a mixed window is 6 characters)
  it("W16-bus three replies, six characters of the value inside prose in each: every one is held; the harmless reply is shown", () => {
    const parts = [`First piece ${V.slice(8, 14)}`, `then ${V.slice(10, 16)}`, `and last ${V.slice(14)}`];
    const seen = harness().turn([...LATCH, ...parts.flatMap(part => [delta(part), done(part)]), delta(NEXT), done(NEXT)]);
    expect(rows(seen), seen.map(s => s.verdict).join()).toEqual([REPLY_WITHHELD, REPLY_WITHHELD, REPLY_WITHHELD, NEXT]);
  });

  // self-review M2: the policy joins a field's rewrite to its earlier value (a tool's input and its result share their fields)
  it("W14-bus a credential cut in two by a rewrite of one field, as the latching intake and after the latch, is recorded: its repeat is held, the harmless reply shown", () => {
    const first = harness().turn([tool("call-1", "api_k"), tool("call-1", `ey=${V2}`), delta(`It is ${V2}`), done(`It is ${V2}`), delta(NEXT), done(NEXT)]);
    expect(first[1]!.secret).toBe(true);
    expect(rows(first), first.map(s => s.reason ?? "").join()).toEqual([REPLY_WITHHELD, NEXT]);
    const later = harness().turn([...LATCH, tool("call-2", "api_k"), tool("call-2", `ey=${V2}`), delta(`It is ${V2}`), done(`It is ${V2}`), delta(NEXT), done(NEXT)]);
    expect(rows(later)).toEqual([REPLY_WITHHELD, NEXT]);
    expect(everything(first) + everything(later)).not.toContain(V2);
  });

  it("W3-bus prose that only names the secret is shown", () => {
    const said = "I found your API key in .env and left it out. The database password is set too.";
    const seen = harness().turn([tool("call-1"), toolDone("call-1", `API_KEY=${V}`), delta(said), done(said)]);
    expect(seen[1]!.secret).toBe(true);
    expect(seen.at(-1)!.row).toBe(said);
    // the label word itself is never a value
    const named = "I found the password in .env and left it out.";
    const again = harness().turn([tool("call-1"), toolDone("call-1", `PASSWORD=${V}`), delta(named), done(named)]);
    expect(again[1]!.secret).toBe(true);
    expect(again.at(-1)!.row).toBe(named);
  });

  it("W5-bus cut 2 H2: a Claude resend with no reset (a streamed label completed as its value; a credential cut in two) is held, the harmless reply is shown", () => {
    const seen = harness().turn([...LATCH, delta("api_key="), done(`${V2}\n`), delta("api_k"), done(`ey=${BASIC_VALUE}xY12\n`), delta(NEXT), done(NEXT)]);
    expect(rows(seen), seen.map(s => s.verdict).join()).toEqual([REPLY_WITHHELD, REPLY_WITHHELD, NEXT]);
    expect(everything(seen)).not.toContain(V2);
    expect(everything(seen)).not.toContain(BASIC_VALUE);
  });

  it("W6-bus a value split across two replies (the first ends on its label) is held; the harmless reply after is shown", () => {
    const seen = harness().turn([...LATCH, delta("Here it is. token:"), done("Here it is. token:"), delta(V2), done(V2), delta(NEXT), done(NEXT)]);
    expect(rows(seen).slice(1)).toEqual([REPLY_WITHHELD, NEXT]);
    expect(everything(seen)).not.toContain(V2);
  });

  it("W13-bus a reply that lies inside a region a marked label of the previous reply opened (more than the carry back): its lines are masked text, held; the harmless reply after is shown", () => {
    const opener = `**Password**:\n${Array.from({ length: 6 }, (_, i) => `Filler line ${i + 1}: ${"nothing to see in this sentence at all. ".repeat(3)}`).join("\n")}\n`;
    const seen = harness().turn([...LATCH, delta(opener), done(opener), delta("correct horse"), done("correct horse"), delta(NEXT), done(NEXT)]);
    expect(rows(seen), seen.map(s => s.verdict).join()).toEqual([REPLY_WITHHELD, REPLY_WITHHELD, NEXT]);
    expect(everything(seen)).not.toContain("correct horse");
  });

  it("W7-bus a value a tool prints AFTER the latch is recorded: the reply that repeats it is held, the harmless one shown", () => {
    const seen = harness().turn([...LATCH, tool("call-2"), toolDone("call-2", `PASSWORD=${V2}`), delta(`It is ${V2}`), done(`It is ${V2}`), delta("ok"), done("ok")]);
    expect(rows(seen)).toEqual([REPLY_WITHHELD, "ok"]);
    expect(everything(seen)).not.toContain(V2);
  });

  it("W9-bus a re-dispatch of the owner message (a new admission while the latched one is still open) carries the values: the repeat is held, the harmless reply shown", () => {
    const h = harness();
    const first = h.turn([...LATCH]);
    expect(first[1]!.secret).toBe(true);
    // index.ts admitLedgerLease -> bus.admitNewTurn for the same thread, the first attempt never completed
    const second = h.turn([delta(`The password is ${V}`), done(`The password is ${V}`), delta("ok"), done("ok")], true);
    expect(rows(second)).toEqual([REPLY_WITHHELD, "ok"]);
    expect(everything(second)).not.toContain(V);
  });

  // ASTRA N3: the refusal is the first attempt's terminal (bus.refuseTurn), so its admission is already retired when the rebuild is admitted
  it("W9r-bus the first attempt was refused (its admission retired) before the re-dispatch: the values still carry", () => {
    const h = harness();
    const first = h.turn([...LATCH]);
    expect(first[1]!.secret).toBe(true);
    h.bus.refuseTurn(THREAD, first[0]!.source);
    const second = h.turn([delta(`The password is ${V}`), done(`The password is ${V}`), delta("ok"), done("ok")], true);
    expect(rows(second)).toEqual([REPLY_WITHHELD, "ok"]);
    expect(everything(second)).not.toContain(V);
    // and a NEW turn after that refusal (not a re-dispatch) starts with an empty list, as in 1.0.21
    const g = harness();
    const refused = g.turn([...LATCH]);
    g.bus.refuseTurn(THREAD, refused[0]!.source);
    const fresh = g.turn([delta(NEXT), done(NEXT)]);
    expect(fresh[1]!.secret).toBe(false);
    expect(fresh[1]!.row).toBe(NEXT);
  });

  // MAIN (ASTRA e167d43947 class): the carried list of a refused attempt does not outlive an owner Stop
  it("W9s-bus a refused latched attempt, then the owner's Stop: nothing is carried into a later admission of the thread", () => {
    const h = harness();
    const first = h.turn([...LATCH]);
    expect(first[1]!.secret).toBe(true);
    h.bus.refuseTurn(THREAD, first[0]!.source);
    h.bus.cancelTurn(THREAD);
    const later = h.turn([delta(NEXT), done(NEXT)], true);
    expect(later[1]!.secret).toBe(false);
    expect(later[1]!.row).toBe(NEXT);
  });

  // FABLE design review M1: 1.0.21 already withholds the error row of a latched turn; design 5.3 would have OPENED it. Not taken in
  // this cut: the row is a guard (green on the base and on the fix).
  it("W10-bus guard: an engine's last words on a latched turn are never the error reason, as in 1.0.21", () => {
    const words = (tail: string) => `Claude closed (exit code 1) before it finished its reply: ${tail}`;
    const leak = harness().turn([...LATCH, { type: "runtime.error", message: words(`fatal: could not use ${V}`) }]);
    expect(leak.at(-1)!.error).toBe(ERROR_REASON_WITHHELD);
    expect(everything(leak)).not.toContain(V);
    const harmless = harness().turn([...LATCH, { type: "runtime.error", message: words("fatal: the network went away") }]);
    expect(harmless.at(-1)!.error).toBe(ERROR_REASON_WITHHELD);
  });

  it("W12 controls: the latch does not outlive its turn, and a turn with no latch stores its reply as before", () => {
    const h = harness();
    const first = h.turn([...LATCH, delta(`It is ${V}`), done(`It is ${V}`), { type: "turn.completed", ok: true }]);
    expect(rows(first)).toEqual([REPLY_WITHHELD]);
    // the next turn of the thread starts with an empty list: the same words are judged by the policy alone, as in 1.0.21
    const second = h.turn([delta(NEXT), done(NEXT), { type: "turn.completed", ok: true }]);
    expect(second[1]!.secret).toBe(false);
    expect(second[1]!.row).toBe(NEXT);
    expect(second[1]!.shared).toBe(NEXT);
  });
});

describe("1.0.22 cause B, W8 fail closed: when the list of masked values cannot be proven whole, the harmless reply keeps the 1.0.21 outcome", () => {
  // each row: the frames that make the list unprovable, then a harmless reply. Guard rows (held on the base too); the mutant that
  // ignores `complete` (owner-display.ts ownerLatchedVerdict) turns each RED.
  const throwing = (text: string, options: any) => { if (text.includes("SCANNER-FIXTURE-THROWS")) throw new Error("fixture scanner"); return scanTurnText(text, options); };
  const CASES: ReadonlyArray<{ id: string; reason: string; frames: readonly Frame[]; policy?: () => ReturnType<typeof createTurnTextPolicy> }> = [
    // q1023-heldbound: MAX_VALUES is 1024 now (was 256; 300 values are a whole list, heldbound-1023.test.ts HB-MAX_VALUES), so the
    // overflow row is past the new bound
    { id: "(b) 1068 distinct masked values (MAX_VALUES + 44)", reason: "bound", frames: [tool("call-1"), toolDone("call-1", Array.from({ length: 1068 }, (_, i) => `SVC${i}_TOKEN=FIXTUREMANY${String(i).padStart(5, "0")}abQZ`).join("\n"))] },
    { id: "(c) an unproven latch: more take-backs of one item than the policy reads (redact-turn.ts retract bounds)", reason: "unproven-latch", frames: Array.from({ length: 9 }, () => [delta("word ", "text-1"), reset("text-1")]).flat() },
    { id: "(d) a BLIND chunk (a unit the scanner could not finish), then a latch", reason: "blind", policy: () => createTurnTextPolicy({ separateItemRegions: true, scan: throwing as any }),
      frames: [delta("SCANNER-FIXTURE-THROWS here\n", "text-1"), done("SCANNER-FIXTURE-THROWS here\n", "text-1"), ...LATCH] },
    // a label whose value is not in the same field: the value the recorder will never see labelled cannot be listed
    { id: "(g) an open label in a one-shot field (a tool result that ends on a marked label)", reason: "unmatched-hit", frames: [tool("call-1"), toolDone("call-1", "**Password**:")] },
    // the policy read the reply after context the recorder never saw (createTurnTextPolicy contexts): it cannot reproduce the hit
    { id: "(f) a hit the recorder cannot reproduce (the policy read it after context of its own)", reason: "unmatched-hit", policy: () => createTurnTextPolicy({ separateItemRegions: true, contexts: { assistant: "Bearer" } }),
      frames: [delta(`${BASIC_VALUE}\n`, "text-1"), done(`${BASIC_VALUE}\n`, "text-1")] },
    { id: "(h) more take-backs of one item after the latch than the recorder reads", reason: "bound", frames: [...LATCH, ...Array.from({ length: 9 }, () => [delta("word ", "text-1"), reset("text-1")]).flat(), delta(DONE, "text-1"), done(DONE, "text-1")] },
    { id: "(i) more open streams after the latch than the recorder keeps", reason: "tail-evicted", frames: [...LATCH, ...Array.from({ length: 33 }, (_, i) => delta("still writing", `open-${i}`))] },
  ];
  for (const c of CASES) it(`W8 ${c.id}: the harmless reply is held, reason ${c.reason}`, () => {
    const seen = harness(c.policy?.()).turn([...c.frames, delta(NEXT, "text-9"), done(NEXT, "text-9")]);
    const last = seen.at(-1)!;
    expect(last.secret || last.withheld).toBe(true);
    expect(last.row).toBe(REPLY_WITHHELD);
    if (ownerDisplay && "ownerLatchedVerdict" in ownerDisplay) expect({ complete: last.complete, reason: last.reason }).toEqual({ complete: false, reason: c.reason });
  });

  it("W8 (a) the recorder's own scan throws: the harmless reply is held, reason scan-limit", async () => {
    const recorderModule = await import("./harness/masked-values.ts").catch(() => undefined);
    const collectorModule = await import("./harness/audience-collector.ts") as any;
    // the recorder's scanner seam (masked-values.ts createMaskedValueRecorder options.scan), installed for this collector only
    const restore = collectorModule.setMaskedValueScannerForTest?.((text: string, options: any) => { if (text.includes("call-two-output")) throw new Error("fixture scanner"); return scanTurnText(text, options); });
    try {
      const seen = harness().turn([...LATCH, tool("call-2"), toolDone("call-2", "call-two-output: nothing to see"), delta(NEXT), done(NEXT)]);
      expect(seen.at(-1)!.row).toBe(REPLY_WITHHELD);
      if (recorderModule) expect({ complete: seen.at(-1)!.complete, reason: seen.at(-1)!.reason }).toEqual({ complete: false, reason: "scan-limit" });
    } finally { restore?.(); }
  });

  it("W8 (e) no view for the event (an older harness): held", () => {
    const seen = harness(undefined, () => undefined).turn([...LATCH, delta(NEXT), done(NEXT)]);
    expect(seen.at(-1)!.row).toBe(REPLY_WITHHELD);
  });
});

describe("1.0.22 cause B, unit rows (design 2.1-2.3)", () => {
  it("values, normalisation, grams, short values and the reply boundary", async () => {
    const m = await import("./harness/masked-values.ts");
    const { repeatsMaskedValue } = ownerDisplay as any;
    // 2.1 a precise span is its value (the label is never a value); a wrapped span gives its first lines
    const text = `DB_PASSWORD=${V}`;
    expect(m.maskedSpanValues(text, scanTurnText(text).spans ?? []).values).toEqual([V]);
    const colon = `password: ${V}`;
    expect(m.maskedSpanValues(colon, scanTurnText(colon).spans ?? []).values).toEqual([V]);
    expect(m.maskedSpanValues("**password**:", [{ from: 13, to: 13, wrapped: true }])).toEqual({ values: [], open: true, rest: [] });
    expect(m.maskedSpanValues("x: one\n\ntwo\nthree\nfour words here\nTOKENSHAPED123456", [{ from: 2, to: 53, wrapped: true }]).values).toEqual(["one", "two", "three", "TOKENSHAPED123456"]);
    // 2.2
    expect(m.normValue("H u n\u200Bt e`r` *2*_2_\n")).toBe("hunter22");
    expect(m.normValue("h\u0301u\u0301nte\u0301r22")).toBe("hunter22"); // ASTRA N2: a combining mark after a letter
    // H1: the value of a span that holds its label
    expect(m.spanValues("DB_PASSWORD=lanterns")).toEqual(["lanterns"]);
    expect(m.spanValues("?token=lanterns")).toEqual(["lanterns"]);
    expect(m.spanValues("Bearer lanterns1234")).toEqual(["lanterns1234"]);
    expect(m.spanValues("authorization: Basic dXNlcjpwYXNz")).toEqual(["dXNlcjpwYXNz"]);
    expect(m.spanValues('api_key="abc==def=="')).toEqual(["abc==def=="]);
    // 2.3 through a recorder's view
    const recorder = m.createMaskedValueRecorder();
    recorder.latch([V, "admin", "correct horse battery staple"], "hit", { carriers: [{ path: "preview.0.value", stream: "s:preview.0.value", mode: "whole", text }] }, "item.completed", "s");
    const view = recorder.view();
    expect(view.complete).toBe(true);
    expect(view.values.map(v => v.norm).filter(norm => [V.toLowerCase(), "admin", "correcthorsebatterystaple"].includes(norm))).toEqual([V.toLowerCase(), "admin", "correcthorsebatterystaple"]);
    expect(repeatsMaskedValue(view, `it is ${V}`)).toBe(true);
    expect(repeatsMaskedValue(view, `ends ${V.slice(-8)}`)).toBe(true);                 // PART, mixed
    expect(repeatsMaskedValue(view, "the horse battery is flat")).toBe(true);            // PART, single class (12 chars)
    expect(repeatsMaskedValue(view, "a horse and a battery")).toBe(false);
    expect(repeatsMaskedValue(view, "log in as admin")).toBe(true);                      // SHORT: a word of its own
    expect(repeatsMaskedValue(view, "ask the administrator")).toBe(false);
    expect(repeatsMaskedValue(view, "I found the database password and your API key and left them out")).toBe(false);
    // ASTRA N1/N2: the value in an encoded form, or with other separators between its characters
    expect(repeatsMaskedValue(view, `as base64: ${Buffer.from(V).toString("base64")}`)).toBe(true);
    expect(repeatsMaskedValue(view, `as hex: ${Buffer.from(V).toString("hex")}`)).toBe(true);
    expect(repeatsMaskedValue(view, `backwards: ${[...V].reverse().join("")}`)).toBe(true);
    expect(repeatsMaskedValue(view, `escaped: ${[...V].map(ch => "%" + ch.charCodeAt(0).toString(16)).join("")}`)).toBe(true);
    expect(repeatsMaskedValue(view, `dotted: ${V.match(/.{1,4}/g)!.join(".")}`)).toBe(true);
    expect(repeatsMaskedValue(view, `accented: ${[...V].join("\u0301")}`)).toBe(true);
    // attack set a46: letters of another alphabet that read as the value's own
    expect(repeatsMaskedValue(view, `lookalike: ${V.replace(/T/g, "\u0422").replace(/E/g, "\u0415").replace(/a/g, "\u0430")}`)).toBe(true);
    // self-review M3: a value with separators of its own, repeated with none
    const dashed = m.createMaskedValueRecorder();
    dashed.latch([["abcd", "efgh", "1234"].join("-")], "hit", { carriers: [{ path: "preview.0.value", stream: "s:preview.0.value", mode: "whole", text: ["tok", "en: ", "abcd", "-efgh", "-1234"].join("") }] }, "item.completed", "s");
    expect(repeatsMaskedValue(dashed.view(), "Use ABCDEFGH1234 for it")).toBe(true);
    expect(repeatsMaskedValue(dashed.view(), "Use ABCDEFGH for it")).toBe(false);
    // self-review H2: a value line of several words
    expect(m.maskedSpanValues("**Password**: sunshine (prod)", [{ from: 13, to: 29, wrapped: true }]).values).toEqual(["sunshine (prod)", "sunshine", "sunshine", "prod"]);
    // boundary: a value wholly inside the previous reply's end is not charged to this reply; one that crosses into it is
    const carried = { ...view, carry: `it is ${V}` };
    expect(repeatsMaskedValue(carried, " and nothing else")).toBe(false);
    expect(repeatsMaskedValue({ ...view, carry: V.slice(0, 10) }, `${V.slice(10)} is the rest`)).toBe(true);
    // the view is a snapshot: a later value does not change one already handed out
    recorder.absorb({ carriers: [{ path: "preview.0.value", stream: "t:preview.0.value", mode: "whole", text: `PASSWORD=${V2}` }] }, "item.completed", "t");
    const before = view.values.length;
    expect(recorder.view().values.length).toBeGreaterThan(before);
    expect(view.values.length).toBe(before);
    expect(repeatsMaskedValue(view, V2)).toBe(false);
    expect(repeatsMaskedValue(recorder.view(), V2)).toBe(true);
  });
});

// q1023-heldscan: a masked region (a private-key block cut off before its END line, or any label whose span runs to the end of the
// text) swallowed every later line of the tool result, and the recorder kept each token-shaped line as a masked value, so the
// ordinary ids and hashes the same tool printed after it (a listing) held the owner's own reply. Narrowed: a bare UUID or hex
// digest line past the first three lines of a region is the next item of the listing, not the label's value. Real keys stay held.
const PEM_OPEN = "-----BEGIN " + "PRIVATE KEY-----";
const KEYBODY = ["Zm9vYmFyYmF6cXV4", "eHl6enl4d3Z1dHNy", "cXBvbm1sa2pp"].map((part, i) => part + "QZ" + (7731 + i) + "kT");
const KEYTAIL = "TAILFIXTURE" + "8812pqRSvw";
const LIST_UUID = "3f2b8c1d-9a4e-4b7a-8c3d-5e6f7a8b9c0d", LIST_UUID_2 = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
const LIST_SHA1 = "9fceb02d0ae598e95dc970b74767f19372d61af8", LIST_SHA256 = "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";
const LISTING_OUT = [PEM_OPEN, ...KEYBODY, LIST_UUID, LIST_UUID_2, LIST_SHA1, LIST_SHA256, KEYTAIL].join("\n");
// the same listing after a marked label (a region of prose lines, no key block): digests are ordinary there too
const PW_OUT = ["**Password**:", ...KEYBODY, LIST_UUID, LIST_UUID_2, LIST_SHA1, LIST_SHA256, KEYTAIL].join("\n");
describe("q1023-heldscan, BUS rows: ordinary ids and hashes the turn printed do not hold the owner's own reply; a real key still does", () => {
  const LATCH_LIST: readonly Frame[] = [tool("call-1"), toolDone("call-1", LISTING_OUT)];
  const LATCH_PW: readonly Frame[] = [tool("call-1"), toolDone("call-1", PW_OUT)];
  const REPLIES = { uuid: `I created record ${LIST_UUID_2} for you.`, sha1: `The commit is ${LIST_SHA1}.`, sha256: `The checksum is ${LIST_SHA256}.`, both: `Records ${LIST_UUID} and ${LIST_SHA256} are ready.` };
  // a UUID line from the listing is an ordinary id; a hex digest line never is (it may be the credential itself)
  for (const [name, reply, latch] of [["uuid", REPLIES.uuid, LATCH_PW], ["uuid-after-key-block", REPLIES.uuid, LATCH_LIST]] as const) it(`HS1 ${name}: an id from the listing after a masked region is the reply, not held`, () => {
    const seen = harness().turn([...latch, delta(reply), done(reply)]);
    expect(seen[1]!.secret).toBe(true);
    expect(seen.at(-1)!.verdict).toBe("shown");
    expect(seen.at(-1)!.row).toBe(reply);
    expect(seen.at(-1)!.shared).toBe(REPLY_WITHHELD);
  });
  for (const name of ["sha1", "sha256", "both"] as const) it(`HS1h ${name}: a hex digest from the listing after a label is still held (hex never corroborates hex)`, () => {
    const seen = harness().turn([...LATCH_PW, delta(REPLIES[name]), done(REPLIES[name])]);
    expect(seen.at(-1)!.verdict).toBe("value");
    expect(seen.at(-1)!.row).toBe(REPLY_WITHHELD);
  });
  for (const [name, part] of [["the key body line", KEYBODY[1]!], ["a line of the region past the first three", KEYTAIL], ["the key body in part", KEYBODY[2]!.slice(3, 17)]] as const)
    it(`HS2 ${name}: a real key line repeated is still held, class named, and the id reply after it is shown`, () => {
      const held = `The key is ${part}.`;
      const seen = harness().turn([...LATCH_LIST, delta(held), done(held), delta(REPLIES.uuid), done(REPLIES.uuid)]);
      expect(seen[3]!.verdict).toBe("value");
      expect(seen[3]!.row).toBe(REPLY_WITHHELD);
      expect(seen.at(-1)!.row).toBe(REPLIES.uuid);
    });
  it("HS4 a hex-digest-shaped line inside a key block is still recorded: its repeat is held (key material may be hex-shaped)", () => {
    const reply = `The checksum is ${LIST_SHA256}.`;
    const seen = harness().turn([...LATCH_LIST, delta(reply), done(reply)]);
    expect(seen.at(-1)!.verdict).toBe("value");
    expect(seen.at(-1)!.row).toBe(REPLY_WITHHELD);
  });
  it("HS5 a reply that itself trips a scanner is held as scan, naming the rule that fired (never the text)", () => {
    const reply = `Open https://example.test/map?key=${"Qz7731" + "abKT5520xyWNmP4401hgRS"} please.`;
    const seen = harness().turn([...LATCH_LIST, delta(reply), done(reply)]);
    expect(seen.at(-1)!.verdict).toBe("scan");
    expect(String(seen.at(-1)!.why)).toMatch(/^scan rules=QUERY_KEY masked=[a-z0-9-]+:\d+/);
    expect(String(seen.at(-1)!.why)).not.toContain("Qz7731");
  });
  it("HS6 one hex line after a label (not a listing of ids) may be the credential itself: its verbatim repeat is held", () => {
    const lone = ["**Password**:", ...KEYBODY, LIST_SHA256].join("\n");
    const reply = `The secret is ${LIST_SHA256}.`;
    const seen = harness().turn([tool("call-1"), toolDone("call-1", lone), delta(reply), done(reply)]);
    expect(seen.at(-1)!.verdict).toBe("value");
    expect(seen.at(-1)!.row).toBe(REPLY_WITHHELD);
  });
  it("HS7 a hex credential beside two UUIDs after a label is not a listing of three: its verbatim repeat is held", () => {
    const out = ["**Password**:", ...KEYBODY, LIST_UUID, LIST_UUID_2, LIST_SHA256].join("\n");
    const reply = `The secret is ${LIST_SHA256}.`;
    const seen = harness().turn([tool("call-1"), toolDone("call-1", out), delta(reply), done(reply)]);
    expect(seen.at(-1)!.verdict).toBe("value");
    expect(seen.at(-1)!.row).toBe(REPLY_WITHHELD);
  });
  it("HS9 a hex credential beside three UUIDs after a label is still held: a hash listing has another hash in it", () => {
    const out = ["**Password**:", ...KEYBODY, LIST_UUID, LIST_UUID_2, "5d6e7f80-1a2b-4c3d-8e4f-9a0b1c2d3e4f", LIST_SHA256].join("\n");
    const reply = `The secret is ${LIST_SHA256}.`;
    const seen = harness().turn([tool("call-1"), toolDone("call-1", out), delta(reply), done(reply)]);
    expect(seen.at(-1)!.verdict).toBe("value");
    expect(seen.at(-1)!.row).toBe(REPLY_WITHHELD);
  });
  it("HS10 a hex credential printed twice beside two UUIDs after a label is still held: a repeat does not corroborate itself", () => {
    const out = ["**Password**:", ...KEYBODY, LIST_UUID, LIST_UUID_2, LIST_SHA256, LIST_SHA256].join("\n");
    const reply = `The secret is ${LIST_SHA256}.`;
    const seen = harness().turn([tool("call-1"), toolDone("call-1", out), delta(reply), done(reply)]);
    expect(seen.at(-1)!.verdict).toBe("value");
    expect(seen.at(-1)!.row).toBe(REPLY_WITHHELD);
  });
  it("HS11 a hex credential printed in two letter cases beside two UUIDs after a label is still held", () => {
    const out = ["**Password**:", ...KEYBODY, LIST_UUID, LIST_UUID_2, LIST_SHA256, LIST_SHA256.toUpperCase()].join("\n");
    const reply = `The secret is ${LIST_SHA256}.`;
    const seen = harness().turn([tool("call-1"), toolDone("call-1", out), delta(reply), done(reply)]);
    expect(seen.at(-1)!.verdict).toBe("value");
    expect(seen.at(-1)!.row).toBe(REPLY_WITHHELD);
  });
  it("HS12 two distinct hex credentials beside two UUIDs after a label do not corroborate each other: each verbatim repeat is held", () => {
    const out = ["**Password**:", ...KEYBODY, LIST_UUID, LIST_UUID_2, LIST_SHA1, LIST_SHA256].join("\n");
    for (const hex of [LIST_SHA1, LIST_SHA256]) {
      const reply = `The secret is ${hex}.`;
      const seen = harness().turn([tool("call-1"), toolDone("call-1", out), delta(reply), done(reply)]);
      expect(seen.at(-1)!.verdict).toBe("value");
      expect(seen.at(-1)!.row).toBe(REPLY_WITHHELD);
    }
  });
  const CRED_UUID = "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d";
  // a credential-labelled line keeps its UUID held, on the label's own line or on the line after a label-only line (MAIN-RULING 2026-11-26T17:44Z)
  for (const [name, tail] of [
    ["HS13 bearer, same line", [`Authorization: Bearer ${CRED_UUID}`]], ["HS14 api key, same line", [`api_key=${CRED_UUID}`]],
    ["HS15 token, same line", [`token: ${CRED_UUID}`]], ["HS16 bare bearer, same line", [`Bearer ${CRED_UUID}`]],
    ["HS21 password table row", [`| password | ${CRED_UUID} |`]], ["HS22 secret, no separator", [`secret ${CRED_UUID}`]],
    ["HS31 bearer with a colon", [`Bearer: ${CRED_UUID}`]], ["HS32 bearer table row", [`| Bearer | ${CRED_UUID} |`]],
    ["HS17 bearer, next line", ["Authorization: Bearer", CRED_UUID]], ["HS18 api key, next line", ["api_key:", CRED_UUID]],
    ["HS19 password, next line", ["**Password**:", CRED_UUID]], ["HS20 secret, next line", ["Client secret =", CRED_UUID]],
  ] as const)
    it(`${name}: a UUID on a credential-labelled line after a label is held when repeated (only plain id listings are ordinary)`, () => {
      const out = ["**Password**:", ...KEYBODY, LIST_UUID, LIST_UUID_2, ...tail].join("\n");
      const reply = `I created record ${CRED_UUID} for you.`;
      const seen = harness().turn([tool("call-1"), toolDone("call-1", out), delta(reply), done(reply)]);
      expect(seen.at(-1)!.verdict).toBe("value");
      expect(seen.at(-1)!.row).toBe(REPLY_WITHHELD);
    });
  // ASTRA pass 2 (405b3deeaa): a token-shaped line with a credential word and a separator whose fragments are all short is still recorded whole, as on d68d5db8d8
  for (const [name, line] of [["HS35 auth: with a short value", "auth:Zq7Lm2Xp9Rk"], ["HS36 pwd= with a short value", "pwd=Zq7Lm2Xp9R"]] as const)
    it(`${name}: the whole line repeated is held`, () => {
      const out = ["**Password**:", ...KEYBODY, LIST_UUID, LIST_UUID_2, line].join("\n");
      const reply = `The line was ${line} in that output.`;
      const seen = harness().turn([tool("call-1"), toolDone("call-1", out), delta(reply), done(reply)]);
      expect(seen.at(-1)!.verdict).toBe("value");
      expect(seen.at(-1)!.row).toBe(REPLY_WITHHELD);
    });
  // ASTRA pass 3 (a6ff7006af): a heading that only CONTAINS a credential word ("Bypass", "Keyboard") is not a credential label; its UUID listing stays ordinary
  for (const [name, heading] of [["HS37 Bypass results", "Bypass results:"], ["HS38 Keyboard shortcuts", "Keyboard shortcuts for the monkey"]] as const)
    it(`${name}: a plain UUID listing under a heading that merely contains a credential word is shown`, () => {
      const out = ["**Password**:", ...KEYBODY, heading, LIST_UUID, LIST_UUID_2, "5d6e7f80-1a2b-4c3d-8e4f-9a0b1c2d3e4f"].join("\n");
      const reply = `I created record ${LIST_UUID} for you.`;
      const seen = harness().turn([tool("call-1"), toolDone("call-1", out), delta(reply), done(reply)]);
      expect(seen.at(-1)!.verdict).toBe("shown");
      expect(seen.at(-1)!.row).toBe(reply);
    });
  // MAIN (q1023-rcready-r12 HELD): a JOINED credential label (accesstoken, clientsecret) is one word and was missed by the word match; camelCase, snake and kebab forms too
  for (const [name, label] of [
    ["HS39 accesstoken", "accesstoken"], ["HS40 apikey (regression: held on 07c2257291 e2e; the recorder rows HS52-HS59 carry the RED)", "apikey"], ["HS41 authtoken (regression: held on 07c2257291 e2e; the recorder rows HS52-HS59 carry the RED)", "authtoken"], ["HS42 secretkey", "secretkey"],
    ["HS43 clientsecret", "clientsecret"], ["HS44 refreshtoken", "refreshtoken"], ["HS45 bearertoken", "bearertoken"],
    ["HS46 ACCESSTOKEN upper", "ACCESSTOKEN"], ["HS47 accessToken camel (regression: held on 07c2257291 e2e; the recorder rows HS52-HS59 carry the RED)", "accessToken"], ["HS48 access_token snake (regression: held on 07c2257291 e2e; the recorder rows HS52-HS59 carry the RED)", "access_token"],
    ["HS49 refresh-token kebab (regression: held on 07c2257291 e2e; the recorder rows HS52-HS59 carry the RED)", "refresh-token"], ["HS50 client_secret snake (regression: held on 07c2257291 e2e; the recorder rows HS52-HS59 carry the RED)", "client_secret"],
  ] as const) {
    it(`${name}: a UUID on the labelled line is held when repeated`, () => {
      const out = ["**Password**:", ...KEYBODY, LIST_UUID, LIST_UUID_2, `${label}: ${CRED_UUID}`].join("\n");
      const reply = `I created record ${CRED_UUID} for you.`;
      const seen = harness().turn([tool("call-1"), toolDone("call-1", out), delta(reply), done(reply)]);
      expect(seen.at(-1)!.verdict).toBe("value");
      expect(seen.at(-1)!.row).toBe(REPLY_WITHHELD);
    });
    it(`${name}: a bare UUID on the line after the label is held when repeated`, () => {
      const out = ["**Password**:", ...KEYBODY, LIST_UUID, LIST_UUID_2, `${label}:`, CRED_UUID].join("\n");
      const reply = `I created record ${CRED_UUID} for you.`;
      const seen = harness().turn([tool("call-1"), toolDone("call-1", out), delta(reply), done(reply)]);
      expect(seen.at(-1)!.verdict).toBe("value");
      expect(seen.at(-1)!.row).toBe(REPLY_WITHHELD);
    });
  }
  it("HS8 three plain UUIDs after a label are a listing: a repeat of one is shown", () => {
    const out = ["**Password**:", ...KEYBODY, LIST_UUID, LIST_UUID_2, "5d6e7f80-1a2b-4c3d-8e4f-9a0b1c2d3e4f"].join("\n");
    const reply = `I created record ${LIST_UUID_2} for you.`;
    const seen = harness().turn([tool("call-1"), toolDone("call-1", out), delta(reply), done(reply)]);
    expect(seen.at(-1)!.verdict).toBe("shown");
    expect(seen.at(-1)!.row).toBe(reply);
  });
  it("HS3 the hold names the class of what the turn masked and of the value repeated (class names only), never a value", () => {
    const held = `The key is ${KEYBODY[1]}.`;
    const seen = harness().turn([...LATCH_LIST, delta(held), done(held)]);
    const why = String(seen.at(-1)!.why);
    // the repeated line is a base64-shaped value; the turn masked key lines and their encoded forms, and NO uuid of the listing (a digest line inside a key block is recorded, HS4)
    expect(why).toMatch(/^value class=base64 masked=base64:\d+,encoded:\d+(,[a-z0-9-]+:\d+)*$/);
    expect(why).not.toMatch(/uuid/);
    for (const secret of [...KEYBODY, KEYTAIL, LIST_UUID]) expect(why).not.toContain(secret);
  });
});

describe("q1023-heldscan r5, unit rows: a UUID on or after a credential-labelled line is recorded; a plain id listing is not", () => {
  const U = "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d", A = "3f2b8c1d-9a4e-4b7a-8c3d-5e6f7a8b9c0d", B = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
  const region = (...tail: string[]) => { const t = ["**Password**:", ...KEYBODY, A, B, ...tail].join("\n"); return { t, values: maskedSpanValues(t, [{ from: 0, to: t.length, wrapped: true }]).values }; };
  for (const [name, tail] of [["HS23 bearer on the next line", ["Authorization: Bearer", U]], ["HS24 api key on the next line", ["api_key:", U]], ["HS25 secret on the next line", ["Client secret =", U]]] as const)
    it(`${name}: the bare UUID line is recorded`, () => { expect(region(...tail).values).toContain(U); });
  for (const [name, tail] of [["HS26 table row", [`| password | ${U} |`]], ["HS27 word and value", [`secret ${U}`]], ["HS28 bearer", [`Authorization: Bearer ${U}`]], ["HS29 api key", [`api_key=${U}`]], ["HS33 bearer colon", [`Bearer: ${U}`]], ["HS34 bearer table row", [`| Bearer | ${U} |`]]] as const)
    it(`${name}: the UUID on the labelled line is recorded`, () => { expect(region(...tail).values).toContain(U); });
  for (const [name, label] of [["HS51 accesstoken", "accesstoken"], ["HS52 authtoken", "authtoken"], ["HS53 secretkey", "secretkey"], ["HS54 clientsecret", "clientsecret"], ["HS55 refreshtoken", "refreshtoken"], ["HS56 bearertoken", "bearertoken"], ["HS57 apikey (regression: recorded on 07c2257291)", "apikey"], ["HS58 ApiKey camel (regression: recorded on 07c2257291)", "ApiKey"], ["HS59 api-key kebab (regression: recorded on 07c2257291)", "api-key"], ["HS60 githubToken camel with a free prefix (regression: recorded on 07c2257291)", "githubToken"]] as const) {
    it(`${name}: the UUID on the labelled line is recorded`, () => { expect(region(`${label}: ${U}`).values).toContain(U); });
    it(`${name}: the bare UUID line after the label is recorded`, () => { expect(region(`${label}:`, U).values).toContain(U); });
  }
  it("HS30 three plain UUIDs after a label are a listing: none is recorded", () => {
    const { values } = region(U);
    for (const id of [A, B, U]) expect(values).not.toContain(id);
  });
});

describe("q1023-heldscan r7, fail-closed SUFFIX label: any single word ending in token/key/secret/passwd/password/pwd/credential(s) names a credential", () => {
  const U = "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d", A = "3f2b8c1d-9a4e-4b7a-8c3d-5e6f7a8b9c0d", B = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
  const region = (...tail: string[]) => { const t = ["**Password**:", ...KEYBODY, A, B, ...tail].join("\n"); return { t, values: maskedSpanValues(t, [{ from: 0, to: t.length, wrapped: true }]).values }; };
  const LABELS = ["oauthtoken", "webhooksecret", "encryptionkey", "deploy_key", "GithubToken", "deploykey", "githubtoken", "DEPLOYKEY", "OAuthToken", "dbpassword", "adminpasswd", "rootpwd", "awscredentials", "dbpassWord", "myToKen", "password2", "bearer2", "api key1", "clientsecret2", "oauthtoken2", "Key", "2auth", "2bearer", "2passphrase", "slackbottoken", "stripe-secret", "jwtsecret", "sshkey", "Webhook_Secret"];
  for (const [i, label] of LABELS.entries()) {
    it(`HS${61 + i} ${label}: the UUID on the labelled line is recorded`, () => { expect(region(`${label}: ${U}`).values).toContain(U); });
    it(`HS${61 + i} ${label}: the bare UUID line after the label is recorded`, () => { expect(region(`${label}:`, U).values).toContain(U); });
  }
  for (const label of ["oauthtoken", "webhooksecret", "encryptionkey", "deploy_key", "GithubToken"])
    it(`HS90 ${label} (bus): a UUID on the labelled line is held when repeated`, () => {
      const out = ["**Password**:", ...KEYBODY, LIST_UUID, LIST_UUID_2, `${label}: ${U}`].join("\n");
      const reply = `I created record ${U} for you.`;
      const seen = harness().turn([tool("call-1"), toolDone("call-1", out), delta(reply), done(reply)]);
      expect(seen.at(-1)!.verdict).toBe("value");
      expect(seen.at(-1)!.row).toBe(REPLY_WITHHELD);
    });
  // guards: a word that merely ends in "key" is not a credential label; its listing stays ordinary (GREEN on base and on the fix)
  for (const word of ["Monkey", "Turkey", "Hockey", "Whiskey", "Donkey", "Jockey", "Monkeys", "Turnkey", "Keyboard", "Bypass", "Passenger", "Tokenize"])
    it(`HS91 ${word}: a heading naming it is not a credential label, the id listing under it is not recorded`, () => {
      const { values } = region(`${word} results:`, U);
      expect(values).not.toContain(U);
    });
  for (const label of ["hmackey", "oauthtoken", "Authorization", "password", "Bearer", "client_secret"])
    it(`HS93 ${label}: a bare heading with no colon, the UUID on the next line is recorded`, () => { expect(region(label, U).values).toContain(U); });
  for (const word of ["Monkey", "Hockey", "Keyboard"])
    it(`HS94 ${word}: a bare ordinary heading with no colon, the UUID under it is not recorded`, () => { expect(region(word, U).values).not.toContain(U); });
  it("HS92 a lone `key` word still names a credential (Escape key is two words, fail closed)", () => { expect(region("Escape key:", U).values).toContain(U); });
});

// q1023-heldscan2 (MAIN-RULING 2026-11-27T00:51Z, Astra r18 pass 2): a value on a credential-LABELLED line is always listed, whatever its
// character classes and however deep in the wrapped region it stands; the label wins. A single-class hex credential (letters a-f only,
// or digits only) past the label's first three lines was dropped by tokenShaped's mixed-class test.
describe("q1023-heldscan2: a single-class hex value on a credential-labelled line deep in a wrapped region is listed; the reply route holds it", () => {
  const HEX_LETTERS = "deadbeef" + "cafebabe" + "facefeed" + "deedbade", HEX_DIGITS = "40291578" + "36150429" + "81736402" + "59174063";
  const A = "3f2b8c1d-9a4e-4b7a-8c3d-5e6f7a8b9c0d", B = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
  const out = (...tail: string[]) => ["**Password**:", ...KEYBODY, A, B, ...tail].join("\n");
  const cases = [["token", `token: ${HEX_LETTERS}`, HEX_LETTERS], ["api_key", `api_key=${HEX_DIGITS}`, HEX_DIGITS], ["bearer", `Authorization: Bearer ${HEX_LETTERS}`, HEX_LETTERS], ["table", `| secret | ${HEX_DIGITS} |`, HEX_DIGITS], ["suffix", `deploy_key: ${HEX_LETTERS}`, HEX_LETTERS]] as const;
  for (const [name, line, hex] of cases) {
    it(`HS100 ${name} (recorder): the hex on the labelled line is listed`, () => {
      const t = out(line);
      expect(maskedSpanValues(t, [{ from: 0, to: t.length, wrapped: true }]).values).toContain(hex);
    });
    it(`HS101 ${name} (reply route): owner chat masks it in place (not held)`, () => {
      const reply = `The value is ${hex}.`;
      const seen = harness().turn([tool("call-1"), toolDone("call-1", out(line)), delta(reply), done(reply)]);
      expect(seen.at(-1)!.masked).toBe(`The value is «redacted ${hex.length} chars».`);
    });
    // GUARD (green on base too): a shared room already holds any reply of a secret-latched turn; the fix must keep it so
    it(`HS106 ${name} (reply route, guard): the shared room holds it`, () => {
      const reply = `The value is ${hex}.`;
      const seen = harness().turn([tool("call-1"), toolDone("call-1", out(line)), delta(reply), done(reply)]);
      expect(seen.at(-1)!.shared).toBe(REPLY_WITHHELD);
    });
  }
  it("HS107 bare heading then the hex on the next line (reply route): owner chat masks it, the shared room holds it", () => {
    const reply = `The value is ${HEX_LETTERS}.`;
    const seen = harness().turn([tool("call-1"), toolDone("call-1", out("api_key", HEX_LETTERS)), delta(reply), done(reply)]);
    expect(seen.at(-1)!.masked).toBe(`The value is «redacted ${HEX_LETTERS.length} chars».`);
    expect(seen.at(-1)!.shared).toBe(REPLY_WITHHELD);
  });
  for (const [value, line] of [["sunshinekey", "password: sunshinekey"], ["abc", "secret: abc"], ["f00", "| token | f00 |"], ["appkey", "password: appkey"], ["tokn1", "api key: tokn1"]] as const) it(`HS108 ${value}: a short or label-ending value on a labelled line is listed (label wins)`, () => {
    const t = out(line);
    expect(maskedSpanValues(t, [{ from: 0, to: t.length, wrapped: true }]).values).toContain(value);
  });
  it("HS102 bare heading then the hex on the next line (recorder): listed", () => {
    const t = out("api_key", HEX_LETTERS);
    expect(maskedSpanValues(t, [{ from: 0, to: t.length, wrapped: true }]).values).toContain(HEX_LETTERS);
  });
  // guard (GREEN on base and fix): the same hex with NO label stays an ordinary line of the listing and is shown in owner chat
  for (const hex of [HEX_LETTERS, HEX_DIGITS]) it("HS103 an unlabelled single-class hex line after a masked region stays shown in owner chat", () => {
    const reply = `The checksum is ${hex}.`;
    const seen = harness().turn([tool("call-1"), toolDone("call-1", out(hex)), delta(reply), done(reply)]);
    expect(seen.at(-1)!.verdict).toBe("shown");
    expect(seen.at(-1)!.row).toBe(reply);
  });
  it("HS105 a short (8 to 11 characters) value with a digit on a labelled line past the first lines is listed", () => {
    const t = out("password: sunshine7");
    expect(maskedSpanValues(t, [{ from: 0, to: t.length, wrapped: true }]).values).toContain("sunshine7");
  });
  it("HS104 the label's own words on a labelled line are not values", () => {
    const t = out("Authorization: Bearer " + HEX_LETTERS);
    const values = maskedSpanValues(t, [{ from: 0, to: t.length, wrapped: true }]).values;
    expect(values).not.toContain("Authorization"); expect(values).not.toContain("Bearer");
  });
});

// q1023-labelfloor (MAIN-RULING 2026-11-27T03:17:37Z, labelled-value floor): a value after a credential label is masked in place in the
// owner's own chat only when it is 16 or more characters (or holds a provider/credential shape); a shorter labelled value is shown
// word for word. The shared room is unchanged: it holds the reply either way. Reply route: the same bus turn the other rows use.
describe("q1023-labelfloor: a labelled value under 16 characters is shown in the owner chat; 16 or more is masked in place; shared rooms hold both", () => {
  const LONG24 = "Qz7731" + "abKT5520" + "xyWNmP4401", EDGE15 = "Qz7731" + "abKT5520" + "x", EDGE16 = EDGE15 + "y";
  const turnOf = (tool_out: string, reply: string) => harness().turn([tool("call-1"), toolDone("call-1", tool_out), delta(reply), done(reply)]).at(-1)!;
  // CHANGED ASSERTION, MAIN-RULING ownermask 2026-11-27 (H2; supersedes the 03:17:37Z floor for these labels): password/passphrase/passwd/pwd/pin/secret/private key ALWAYS mask their value in place in the owner's own chat, whatever its length; token and the other labels keep the floor
  // (was: `password: ab12` and `secret: Zk4471` shown word for word)
  for (const [name, line, value, always] of [["token short", "token: D-4821", "D-4821", false], ["password short", "password: ab12", "ab12", true], ["secret short", "secret: Zk4471", "Zk4471", true], ["token 15", `token: ${EDGE15}`, EDGE15, false]] as const) {
    it(`LF1 ${name} (reply route): the owner chat ${always ? "masks the value in place and keeps the words around it" : "shows the reply word for word"}`, () => {
      const reply = `The value is ${value}.`;
      expect(turnOf(line, reply).masked).toBe(always ? `The value is «redacted ${value.length} chars».` : reply);
    });
    it(`LF3 ${name} (reply route, guard): the shared room still holds it`, () => {
      expect(turnOf(line, `The value is ${value}.`).shared).toBe(REPLY_WITHHELD);
    });
  }
  for (const [name, line, value] of [["token 24", `token: ${LONG24}`, LONG24], ["DB_PASSWORD 16", `DB_PASSWORD=${EDGE16}`, EDGE16], ["secret 24", `secret: ${LONG24}`, LONG24]] as const) {
    it(`LF2 ${name} (reply route): the owner chat masks it in place`, () => {
      expect(turnOf(line, `The value is ${value}.`).masked).toBe(`The value is «redacted ${value.length} chars».`);
    });
    it(`LF3 ${name} (reply route, guard): the shared room still holds it`, () => {
      expect(turnOf(line, `The value is ${value}.`).shared).toBe(REPLY_WITHHELD);
    });
  }
  it("LF4 a short labelled value deep in a wrapped region (reply route): shown in the owner chat, held in the shared room", () => {
    const t = ["**Password**:", ...KEYBODY, "3f2b8c1d-9a4e-4b7a-8c3d-5e6f7a8b9c0d", "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d", "token: D-4821"].join("\n"), reply = "The value is D-4821.";
    const seen = turnOf(t, reply);
    expect(seen.masked).toBe(reply);
    expect(seen.shared).toBe(REPLY_WITHHELD);
  });
  // ASTRA/FABLE q1023-heldscan 3f7013d354 High: a labelled value on line 2 or 3 of a wrapped region was listed but not credential grade
  const D32 = "40291578" + "36150429" + "81736402" + "59174063", H32 = "deadbeef" + "cafebabe" + "facefeed" + "deedbade", UU = "3f2b8c1d-9a4e-4b7a-8c3d-5e6f7a8b9c0d";
  for (const [name, lines, value] of [["table row on line 2", ["**Password**:", `| secret | ${D32} |`], D32], ["table row on line 3", ["**Password**:", UU, `| secret | ${D32} |`], D32], ["heading line 2 hex line 3", ["**Password**:", "api_key", H32], H32], ["heading line 3 hex line 4", ["**Password**:", UU, "api_key", H32], H32]] as const) {
    it(`LF5 ${name} (reply route): the owner chat masks it in place`, () => {
      expect(turnOf(lines.join("\n"), `The value is ${value}.`).masked).toBe(`The value is «redacted ${value.length} chars».`);
    });
    it(`LF6 ${name} (reply route, guard): the shared room holds it`, () => {
      expect(turnOf(lines.join("\n"), `The value is ${value}.`).shared).toBe(REPLY_WITHHELD);
    });
  }
});
