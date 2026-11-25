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
type Seen = { source: SourceContext; verdict?: string; type: string; raw?: string; displayed?: string; secret: boolean; withheld: boolean; row?: string; shared?: string; error?: string; live: string; reason?: string; complete?: boolean };
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
    return { source, verdict: reply ? (ownerDisplay as any).ownerLatchedVerdict?.(fields.text, maskedValues) : undefined, type: String(fields.type), raw: reply ? String(fields.text) : undefined, displayed, secret, withheld, reason: view?.reason, complete: view?.complete,
      // index.ts item.completed assistant_text: displayedText = ownerReplyText(displayField("text"), text, ownerOnly, audienceUnproven); then replyText = ownerLatchedReplyText(displayedText, displayField("text"), text, !sharedAudience, audienceUnproven, maskedValues)
      row: reply ? latchedReply(ownerReplyText(displayed, fields.text, true, audienceUnproven), displayed, fields.text, true, audienceUnproven, maskedValues) : undefined,
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
    { id: "(b) 300 distinct masked values", reason: "bound", frames: [tool("call-1"), toolDone("call-1", Array.from({ length: 300 }, (_, i) => `SVC${i}_TOKEN=FIXTUREMANY${String(i).padStart(4, "0")}abQZ`).join("\n"))] },
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
