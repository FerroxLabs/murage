// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-L4B-FULL panel client (designs/UX-L4B-FULL-1018.md sections 7 to 9): Chief-only target, the exact outgoing words,
// answer identity by sendId and dispatchedIn, every state from fixtures, Remove from line 404 states, targeted Stop.
import { createSessionWatch } from "@/lib/session-check";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import HelpAsk, { forgetKeptAsk, startAskFollow, startAskNudge } from "./HelpAsk";
import * as storeModule from "@/state/store";
import type { Bot, Message } from "@/state/store";
import { feedbackEnvelopeForScreen, resolveHelpScreen } from "@/lib/screen-envelope";
import { AskBody, askState, askText, askView, attempts, bounded, cancelOutcome, chiefOf, deliveryRefused, followChange, reopened, startFollow, stopTurn, type AskRecord, type AskView } from "./HelpAsk";
import { HelpPanel, type HelpPanelProps } from "./HelpPanel";
import { createAskLifetime, reconcileDelivery, settleStop } from "./help-ask-lifetime";
import { hx } from "./help-copy";

/** Copy as React's static markup writes it (apostrophes escaped). */
const say = (key: string, params?: Record<string, string>) => hx(key, params).replace(/'/g, "&#x27;");
const src = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const msg = (over: Partial<Message>): Message => ({ id: Math.random().toString(36).slice(2), role: "bot", kind: "text", at: 1, ...over }) as Message;
const chief = (over: Partial<Bot> = {}): Bot => ({ id: "c1", name: "Nova", chiefOfStaff: true, chiefScope: "workspace", threadId: "t1", messages: [], unread: false, ...over }) as unknown as Bot;
const record = (over: Partial<AskRecord> = {}): AskRecord => ({ gen: 1, sendId: "s1", botId: "c1", threadId: "t1", question: "How do routines run?", text: "How do routines run?", phase: "accepted", ...over });
const own = (over: Partial<Message> = {}) => msg({ role: "user", sendId: "s1", text: "How do routines run?", ...over });

describe("who answers and what is sent", () => {
  it("asks the visible Chief only, never the first bot", () => {
    const helper = { id: "h1", name: "Ada", threadId: "t9", messages: [] } as unknown as Bot;
    expect(chiefOf([helper])).toBeUndefined();
    expect(chiefOf([helper, chief({ hidden: true } as Partial<Bot>)])).toBeUndefined();
    expect(chiefOf([helper, chief()])?.id).toBe("c1");
  });
  it("sends the question and the fixed screen title, never a name (H3)", () => {
    const title = feedbackEnvelopeForScreen(resolveHelpScreen({ activeView: "chat", bot: { id: "b1", name: "sk-live-Dana Private" }, connected: true })).title;
    const text = askText("  Why is this greyed out?  ", title);
    expect(text.startsWith("Why is this greyed out?\n\n")).toBe(true);
    expect(text).toContain(title);
    expect(text).not.toMatch(/Dana|sk-live|\{name\}/);
    const routines = feedbackEnvelopeForScreen(resolveHelpScreen({ activeView: "routines", connected: true })).title;
    expect(askText("Q", routines)).toBe(`Q\n\n${hx("ux.l4b.sentFrom", { screen: routines })}`);
  });
  it("posts noSteer through the outbox and never selects the chat on Ask", () => {
    const store = src("../../state/store.tsx");
    expect(store).toMatch(/\.\.\.\(entry\.noSteer \? \{ noSteer: true \} : \{\}\)/);
    expect(store).toMatch(/\.\.\.\(action\.noSteer \? \{ noSteer: true as const \} : \{\}\)/);
    const ask = src("./HelpAsk.tsx");
    expect(ask).toMatch(/noSteer: true/);
    expect(ask).toMatch(/type: "loadFirstPage"/);
    expect(ask).not.toMatch(/type: "select"/);
    // The panel is its own chunk, loaded by the help panel, never at first paint.
    expect(src("./HelpPanel.tsx")).toMatch(/import\("\.\/HelpAsk"\)/);
    expect(src("./HelpHost.tsx")).not.toMatch(/HelpAsk/);
  });
});

describe("answer identity and states", () => {
  const turn = "turn-9";
  const loaded = (messages: Message[], over: Partial<Bot> = {}) => chief({ messages, busy: true, ...over } as Partial<Bot>);
  const expectState = (view: AskView, s: AskView["s"]) => expect(view.s).toBe(s);

  it("sending, refused, queued, removing, removed, missing, retry", () => {
    expectState(askView(record({ phase: "sending" }), chief()), "sending");
    expectState(askView(record({ phase: "refused" }), chief()), "refused");
    expect(askView(record({ queueId: "q1" }), loaded([]))).toEqual({ s: "queued", removing: false });
    expect(askView(record({ queueId: "q1", cancel: "removing" }), loaded([]))).toEqual({ s: "queued", removing: true });
    expectState(askView(record({ queueId: "q1", cancel: "removed" }), loaded([])), "removed");
    expectState(askView(record({ queueId: "q1", cancel: "missing" }), loaded([])), "missing");
    expectState(askView(record({ queueId: "q1", cancel: "retry" }), loaded([])), "removeRetry");
  });
  it("a 404 that says started follows the turn and is never Done on its own", () => {
    expectState(askView(record({ queueId: "q1", cancel: "started" }), loaded([])), "starting");
    expectState(askView(record({ queueId: "q1", cancel: "started" }), loaded([own({ dispatchedIn: turn })])), "running");
  });
  it("rows not in the store: Open in chat until the first page lands (H2)", () => {
    expectState(askView(record(), chief({ messagesUnloaded: true } as Partial<Bot>)), "inChat");
    expectState(askView(record(), chief({ firstPageEvents: [] } as Partial<Bot>)), "inChat");
    expectState(askView(record(), chief({ threadId: "t2" })), "inChat");
    expectState(askView(record(), undefined), "inChat");
    expectState(askView(record({ lost: true }), loaded([])), "inChat");
  });
  it("running, approval and done read only our turn's rows", () => {
    const answer = msg({ turnId: turn, text: "Routines run on the bot's own engine.\n\nThey start at the time you set." });
    const running = askView(record(), loaded([own({ dispatchedIn: turn }), answer]));
    expect(running).toMatchObject({ s: "running", turnId: turn, answer: [answer] });
    const card = (over: Partial<Message["card"]> = {}, turnId = turn) => msg({ kind: "options", turnId, card: { title: "Run it?", subtitle: "", options: ["Allow"], ...over } as Message["card"] });
    expectState(askView(record(), loaded([own({ dispatchedIn: turn }), card()])), "approval");
    // Our own terminal row is a hint only (a rebuild may restamp us): Done waits for the server.
    expectState(askView(record(), loaded([own({ dispatchedIn: turn }), { ...answer, turnTerminal: true }])), "running");
    expectState(askView(record({ endedTurn: turn }), loaded([own({ dispatchedIn: turn })])), "done");
    // The server ended an older turn our row was once released to (a rebuild restamped it): ours is still running.
    expectState(askView(record({ endedTurn: "turn-old" }), loaded([own({ dispatchedIn: turn })])), "running");
  });
  it("never shows an earlier reply, a later turn's reply or another question's turn as ours", () => {
    const earlier = msg({ turnId: "turn-1", text: "An older answer", turnTerminal: true });
    const later = msg({ turnId: "turn-10", text: "The next turn", turnTerminal: true });
    const other = msg({ role: "user", sendId: "s2", dispatchedIn: "turn-10", text: "Something else" });
    const ours = msg({ turnId: turn, text: "Ours" });
    // On purpose (TURNSTATE-1019): a later turn's rows after ours no longer end ours. Only the server's send-keyed
    // "ended" does (rows and frames are hints to ask it); the answer is still ours alone.
    const view = askView(record(), loaded([earlier, own({ dispatchedIn: turn }), ours, other, later]));
    expect(view).toMatchObject({ s: "running", answer: [ours] });
    // Before our row is released to a turn, nothing is an answer, terminal rows of other turns included.
    expectState(askView(record(), loaded([earlier, own(), later])), "starting");
  });
});

describe("the panel renders the answer", () => {
  const screen = resolveHelpScreen({ activeView: "routines", connected: true });
  const handlers = { onStop: vi.fn(), onRemove: vi.fn(), onRetry: vi.fn(), onOpenChat: vi.fn(), onDone: vi.fn() };
  const body = (view: AskView, rec: Partial<AskRecord> = {}) => createElement(AskBody, { name: "Nova", view, record: record(rec), ...handlers });
  const panel = (askSlot: ReturnType<typeof body>) => renderToStaticMarkup(createElement(HelpPanel, {
    entry: screen.entry, params: { ...screen.params, mod: "Ctrl" }, title: "Routines", envelope: feedbackEnvelopeForScreen(screen),
    surface: "desktop", noEngine: false, onClose: () => {}, onOpenEngines: () => {}, onAskBot: () => {}, askSlot,
  } as HelpPanelProps));

  it("a two-paragraph reply renders fully inside the help panel", () => {
    const text = "First paragraph about routines.\n\nSecond paragraph with the next step.";
    const html = panel(body({ s: "done", turnId: "t", answer: [msg({ turnId: "t", text, turnTerminal: true })] }));
    expect(html).toContain("data-help-panel");
    expect(html).toContain("First paragraph about routines.");
    expect(html).toContain("Second paragraph with the next step.");
    expect(html).toContain(say("ux.l4b.saved", { name: "Nova" }));
    expect(html).toContain(say("ux.l4b.openInChat"));
  });
  it("each state draws its line and its next step", () => {
    const html = (view: AskView, rec?: Partial<AskRecord>) => renderToStaticMarkup(body(view, rec));
    expect(html({ s: "queued", removing: false })).toContain(say("ux.l4b.removeFromLine"));
    expect(html({ s: "running", turnId: "t", answer: [] })).toContain(`>${hx("ux.l4b.stop")}<`);
    expect(html({ s: "running", turnId: "t", answer: [] }, { stop: "stopping" })).toContain(say("ux.l4b.stopping"));
    const unconfirmed = html({ s: "running", turnId: "t", answer: [] }, { stop: "unconfirmed", stopLine: "The engine has not confirmed that it stopped." });
    expect(unconfirmed).toContain("The engine has not confirmed that it stopped.");
    expect(unconfirmed).toContain(say("ux.l4b.tryAgain"));
    expect(html({ s: "approval", turnId: "t", answer: [] })).toContain(say("ux.l4b.approval", { name: "Nova" }));
    expect(html({ s: "inChat" })).toContain(say("ux.l4b.inChat", { name: "Nova" }));
    expect(html({ s: "removed" })).toContain(say("ux.l4b.removed"));
    expect(html({ s: "missing" })).toContain(say("ux.l4b.missing"));
    expect(html({ s: "removeRetry" })).toContain(say("ux.l4b.removeFailed"));
    expect(html({ s: "refused" })).toContain(say("ux.l4b.refused"));
    // Done is disabled while the turn runs or waits in line.
    expect(html({ s: "running", turnId: "t", answer: [] })).toMatch(/disabled="">Done</);
    expect(html({ s: "queued", removing: false })).toMatch(/disabled="">Done</);
    expect(html({ s: "done", turnId: "t", answer: [] })).not.toMatch(/disabled="">Done</);
  });
});

describe("Remove from line and Stop", () => {
  const fail = (body: unknown) => Object.assign(new Error("x"), { status: 404, body });
  it("reads the 404 state, never the status code alone", () => {
    expect(cancelOutcome(fail({ state: "started", messageId: "m1" }))).toEqual({ cancel: "started" });
    expect(cancelOutcome(fail({ state: "cancelled" }))).toEqual({ cancel: "removed" });
    expect(cancelOutcome(fail({ state: "missing" }))).toEqual({ cancel: "missing" });
    expect(cancelOutcome(fail({ state: "sending" }))).toBe("again");
    expect(cancelOutcome(fail({ state: "failed", messageId: "m1" }))).toEqual({ cancel: "started" });
    expect(cancelOutcome(fail({ state: "failed" }))).toEqual({ phase: "refused" });
    expect(cancelOutcome(fail({ error: "not queued" }))).toEqual({ cancel: "retry" });
    expect(cancelOutcome(new Error("offline"))).toEqual({ cancel: "retry" });
  });
  it("Stop posts our turn id; stopped:false is never Done by itself (the server is asked)", async () => {
    const post = vi.fn(async () => ({ ok: true, stopped: false }));
    expect(await stopTurn("c1", "t1", "turn-9", post as never)).toEqual({ stop: "missed" });
    expect(post).toHaveBeenCalledWith("/api/bots/c1/interrupt", expect.objectContaining({ method: "POST", body: JSON.stringify({ threadId: "t1", turnId: "turn-9" }) }));
    expect(await stopTurn("c1", "t1", "turn-9", (async () => ({ ok: true, stopped: true })) as never)).toEqual({ stop: undefined });
  });
  it("Stop that the engine did not confirm shows the chat's line with Try again", async () => {
    const unconfirmed = async () => { throw Object.assign(new Error("The engine has not confirmed that it stopped."), { status: 409, body: { code: "provider_stop_unconfirmed" } }); };
    expect(await stopTurn("c1", "t1", "x", unconfirmed as never)).toEqual({ stop: "unconfirmed", stopLine: "The engine has not confirmed that it stopped." });
    expect(await stopTurn("c1", "t1", "x", (async () => { throw new Error("offline"); }) as never)).toEqual({ stop: "failed" });
  });
  it("the cancel action hands the parsed body to the caller", () => {
    const store = src("../../state/store.tsx");
    expect(store).toMatch(/type: "cancelQueued"; botId: string; queueId: string; signal\?: AbortSignal; onDone\?: \(\) => void; onError\?:/);
    expect(store).toMatch(/\.catch\(\(error\) => \{ if \(action\.onError\?\.\(error\) !== true\) showError\(error\); \}\);/);
  });
});

describe("fix round 1 (Astra r1)", () => {
  const turn = "turn-9";
  const loaded = (messages: Message[], over: Partial<Bot> = {}) => chief({ messages, busy: true, ...over } as Partial<Bot>);
  const card = (over: Partial<Message["card"]> = {}, turnId = turn) => msg({ kind: "options", turnId, card: { title: "Run it?", subtitle: "", options: ["Allow"], ...over } as Message["card"] });
  const expectState = (view: AskView, s: AskView["s"]) => expect(view.s).toBe(s);

  it("Stop that never answers fails within its deadline and aborts the request (H1)", async () => {
    let signal: AbortSignal | undefined;
    const hung = vi.fn((_path: string, init?: RequestInit) => { signal = init?.signal ?? undefined; return new Promise(() => {}); });
    expect(await stopTurn("c1", "t1", turn, hung as never, 20)).toEqual({ stop: "failed" });
    expect(signal?.aborted).toBe(true);
  });
  it("Remove from line has a deadline, and Open in chat shows while Stopping or Removing (H1)", () => {
    const ask = src("./HelpAsk.tsx");
    expect(ask).toMatch(/later\(g, \(\) => \{ if \(mine\(\)\) \{ attempt\.retire\(\); patch\(g, \{ cancel: "retry" \}, \(r\) => r\.cancel === "removing"\); \} \}, ASK_REQUEST_MS\)/);
    const handlers = { onStop: vi.fn(), onRemove: vi.fn(), onRetry: vi.fn(), onOpenChat: vi.fn(), onDone: vi.fn() };
    const html = (view: AskView, rec: Partial<AskRecord> = {}) => renderToStaticMarkup(createElement(AskBody, { name: "Nova", view, record: record(rec), ...handlers }));
    expect(html({ s: "queued", removing: true })).toContain(say("ux.l4b.openInChat"));
    expect(html({ s: "running", turnId: turn, answer: [] }, { stop: "stopping" })).toContain(say("ux.l4b.openInChat"));
  });
  it("only a refusal the server meant is refused; anything else is uncertain and never resent as new (H2)", () => {
    expect(deliveryRefused(Object.assign(new Error("x"), { status: 403 }))).toBe(true);
    expect(deliveryRefused(Object.assign(new Error("x"), { status: 409 }))).toBe(true);
    expect(deliveryRefused(Object.assign(new Error("full"), { status: 507 }))).toBe(true);
    expect(deliveryRefused(Object.assign(new Error("gave up"), { status: 408 }))).toBe(false);
    expect(deliveryRefused(Object.assign(new Error("busy"), { status: 503 }))).toBe(false);
    expect(deliveryRefused(new Error("offline"))).toBe(false);
    // Uncertain: the panel follows the row by the SAME sendId; with no row it hands over to the chat, with no Try again.
    expectState(askView(record({ phase: "uncertain" }), loaded([])), "inChat");
    expectState(askView(record({ phase: "uncertain" }), loaded([own({ dispatchedIn: turn })])), "running");
    const body = renderToStaticMarkup(createElement(AskBody, { name: "Nova", view: { s: "inChat" }, record: record(), onStop: vi.fn(), onRemove: vi.fn(), onRetry: vi.fn(), onOpenChat: vi.fn(), onDone: vi.fn() }));
    expect(body).not.toContain(say("ux.l4b.tryAgain"));
    // Try again resends the same words under the same sendId, as the chat's Send again does.
    const ask = src("./HelpAsk.tsx");
    expect(ask).toMatch(/onRetry=\{\(\) => send\(record\.botId, record\.threadId, record\.question, record\.text, record\.sendId\)\}/);
    expect(ask).toMatch(/const sendId = again \?\? newSendId\(\);/);
    expect(ask).toMatch(/onError: \(error\) => \{ patch\(g, \{ phase: deliveryRefused\(error\) \? "refused" : "uncertain" \}\); return true; \}/);
  });
  it("done and approval follow OUR turn, never the thread's busy or activity (H3)", () => {
    const ours = own({ dispatchedIn: turn });
    // The thread is busy with another turn and waiting on the owner: not our approval, not our run.
    expectState(askView(record(), loaded([ours], { activity: "waiting-on-you" } as Partial<Bot>), { turnId: "turn-10", ended: false }), "running");
    expectState(askView(record(), loaded([ours, card({}, "turn-10")])), "running");
    expectState(askView(record(), loaded([ours, card({ answered: "Allow" })])), "running");
    expectState(askView(record(), loaded([ours, card({ expired: true })])), "running");
    expectState(askView(record(), loaded([ours, card()])), "approval");
    // A live completion is only a hint to ask the server (an unnamed turn.completed takes the current id): not Done by itself.
    expectState(askView(record(), loaded([ours]), { turnId: turn, ended: true }), "running");
    // A row of a later turn after ours does not end ours (an earlier turn's late rows look the same): still running.
    const mine = msg({ turnId: turn, text: "Part one" });
    expectState(askView(record(), loaded([ours, mine, msg({ turnId: "turn-10", text: "Next" })])), "running");
    // An earlier turn's late row before our first row is not a later turn.
    expectState(askView(record(), loaded([ours, msg({ turnId: "turn-1", text: "Late" }), mine])), "running");
    // A terminal activity row of our turn is a hint, not Done, until the server says ended.
    expectState(askView(record(), loaded([ours, msg({ kind: "activity", turnId: turn, turnTerminal: true })])), "running");
    expectState(askView(record({ endedTurn: turn }), loaded([ours, msg({ kind: "activity", turnId: turn, turnTerminal: true })])), "done");
    const ask = src("./HelpAsk.tsx");
    expect(ask).not.toMatch(/bot\.activity === "waiting-on-you"/);
  });
  it("transcript reload retries after a failed page, and closing help clears timers (M4, M5)", () => {
    const ask = src("./HelpAsk.tsx");
    expect(ask).not.toMatch(/loadTried/);
    expect(ask).toMatch(/if \(tries > ASK_LOAD_TRIES\) return cleanup;/);
    expect(ask).toContain("current.close();");
  });
  it("the live answer shows only while the thread's live turn is ours (M6)", () => {
    const ours = own({ dispatchedIn: turn });
    expect(askView(record(), loaded([ours]), { turnId: turn, ended: false }, "Routines run")).toMatchObject({ s: "running", streaming: "Routines run" });
    expect(askView(record(), loaded([ours]), { turnId: "turn-10", ended: false }, "Other words")).not.toHaveProperty("streaming");
    expect(askView(record(), loaded([ours]), { ended: false }, "Unknown turn")).not.toHaveProperty("streaming");
    const html = renderToStaticMarkup(createElement(AskBody, { name: "Nova", view: { s: "running", turnId: turn, answer: [], streaming: "Routines run" }, record: record(), onStop: vi.fn(), onRemove: vi.fn(), onRetry: vi.fn(), onOpenChat: vi.fn(), onDone: vi.fn() }));
    expect(html).toContain("data-help-streaming");
    expect(html).toContain("Routines run");
    expect(html).not.toContain(say("ux.l4b.working", { name: "Nova" }));
  });
});

describe("H3 redesign: the server says where our question is (TURNSTATE-1019)", () => {
  const turn = "turn-9";
  const loaded = (messages: Message[]) => chief({ messages, busy: false } as Partial<Bot>);
  it("asks ask-state by our sendId, bounded", async () => {
    const get = vi.fn(async () => ({ state: "queued" }));
    expect(await askState("c1", "t1", "s 1", turn, new AbortController().signal, get as never)).toEqual({ state: "queued" });
    expect(get).toHaveBeenCalledWith("/api/bots/c1/turn-state?threadId=t1&sendId=s+1&turnId=turn-9", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it("only the server's ended names Done, for the turn it names; waiting, running, unsure change nothing", () => {
    expect(followChange({ state: "ended", endedAt: 5 }, turn)).toEqual({ endedSend: true, endedTurn: turn });
    expect(followChange({ state: "ended" }, undefined)).toEqual({ endedSend: true });
    for (const state of ["queued", "running", "unknown"] as const) expect(followChange({ state }, turn)).toBeUndefined();
    expect(followChange(undefined, turn)).toBeUndefined();
    // Nothing in the transcript ends our turn before the server does: not busy off, not an unknown live turn.
    expect(askView(record(), loaded([own({ dispatchedIn: turn })]), { ended: false }).s).toBe("running");
    expect(askView(record(), loaded([own({ dispatchedIn: turn })]), { turnId: "turn-10", ended: false }).s).toBe("running");
    // In line or not yet released: never Saved early.
    expect(askView(record({ queueId: "q1" }), loaded([])).s).toBe("queued");
    expect(askView(record(), loaded([own()])).s).toBe("starting");
    // The follow limit hands over to the chat from any following state.
    expect(askView(record({ lost: true }), loaded([own({ dispatchedIn: turn })])).s).toBe("inChat");
  });
  it("closing help ends a request in flight, Stop included", async () => {
    const closing = new AbortController();
    let signal: AbortSignal | undefined;
    const hung = vi.fn((_path: string, init?: RequestInit) => { signal = init?.signal ?? undefined; return new Promise(() => {}); });
    const pending = stopTurn("c1", "t1", turn, hung as never, 60_000, closing.signal);
    closing.abort();
    expect(await pending).toEqual({ stop: "failed" });
    expect(signal?.aborted).toBe(true);
    await expect(bounded(() => new Promise(() => {}), 60_000, closing.signal)).rejects.toThrow("closed");
  });
  const word = (w: object) => w as never;
  const flush = () => vi.advanceTimersByTimeAsync(0);
  it("a turn that ran and ended unseen (missed completion, another turn now running) is Done once the server says so", async () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const read = vi.fn().mockResolvedValueOnce(word({ state: "running" })).mockResolvedValue(word({ state: "ended" }));
    const follow = startFollow({ read, turnId: turn, apply, until: Date.now() + 60_000, everyMs: 1_000 });
    await flush();
    expect(apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(apply).toHaveBeenCalledWith({ endedSend: true, endedTurn: turn });
    follow.stop();
    vi.useRealTimers();
  });
  it("waiting, unsure and failing reads never end it; the absolute limit hands over to the chat", async () => {
    vi.useFakeTimers();
    for (const read of [vi.fn(async () => word({ state: "queued" })), vi.fn(async () => word({ state: "unknown" })), vi.fn(async () => { throw new Error("offline"); })]) {
      const apply = vi.fn();
      startFollow({ read, turnId: turn, apply, until: Date.now() + 10_000, everyMs: 1_000 });
      await vi.advanceTimersByTimeAsync(9_900);
      expect(apply).not.toHaveBeenCalled();
      expect(read.mock.calls.length).toBeGreaterThan(5);
      await vi.advanceTimersByTimeAsync(200);
      expect(apply).toHaveBeenCalledWith({ lost: true });
      const calls = read.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(read.mock.calls.length).toBe(calls);
    }
    // A limit already past (leaving approval after it, a restamp late in the Ask) hands over at once.
    const apply = vi.fn();
    startFollow({ read: vi.fn(async () => word({ state: "running" })), apply, until: Date.now() - 1 });
    await flush();
    expect(apply).toHaveBeenCalledWith({ lost: true });
    vi.useRealTimers();
  });
  it("one read in flight; stop and closing help abort it", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const read = vi.fn((signal: AbortSignal) => { signals.push(signal); return new Promise<never>(() => {}); });
    const follow = startFollow({ read, apply: vi.fn(), until: Date.now() + 60_000 });
    follow.nudge(); follow.nudge();
    expect(read).toHaveBeenCalledTimes(1);
    follow.stop();
    expect(signals[0].aborted).toBe(true);
    const closing = new AbortController();
    startFollow({ read, apply: vi.fn(), until: Date.now() + 60_000, outer: closing.signal });
    closing.abort();
    expect(signals[1].aborted).toBe(true);
    vi.useRealTimers();
  });
  it("uncertain delivery with our row found is followed as running; a restamped turn is not Done", () => {
    expect(askView(record({ phase: "uncertain", endedTurn: "turn-old" }), loaded([own({ dispatchedIn: turn })])).s).toBe("running");
  });
  it("a late answer to a timed-out Remove never speaks over the newer attempt", () => {
    const removes = attempts();
    const a = removes.begin();
    a.retire();
    const b = removes.begin();
    expect(a.live()).toBe(false);
    expect(b.live()).toBe(true);
    a.retire();
    expect(b.live()).toBe(true);
    const ask = src("./HelpAsk.tsx");
    expect(ask).toMatch(/onDone: \(\) => \{ if \(mine\(\)\) patch\(g, \{ cancel: "removed" \}\); \}/);
    expect(ask).toMatch(/onError: \(error\) => \{\n\s+if \(!mine\(\)\) return true;/);
    expect(ask).not.toMatch(/movedOn|seenLive|seenBusy|ASK_ENDED_GRACE_MS/);
  });
});

describe("slice 1 turn-state is keyed on the send (37abf2204)", () => {
  const turn = "turn-9";
  const loaded = (messages: Message[]) => chief({ messages, busy: false } as Partial<Bot>);
  const word = (w: object) => w as never;
  it("send-keyed ended before our turn id reached the store is Done, and stays Done once the row arrives", () => {
    const change = followChange({ state: "ended", endedAt: 7 }, undefined)!;
    expect(change).not.toHaveProperty("lost");
    // Still in line or not yet released in the store: the server's word for the send wins.
    expect(askView(record({ queueId: "q1", ...change }), loaded([])).s).toBe("done");
    expect(askView(record(change), loaded([own()])).s).toBe("done");
    // The row lands with its turn: Done with the answer, and no longer followed.
    const answer = msg({ role: "bot", kind: "text", text: "Here it is", turnId: turn });
    expect(askView(record(change), loaded([own({ dispatchedIn: turn }), answer]))).toMatchObject({ s: "done", answer: [answer] });
  });
  it("a 403 (a paired phone) or any failed read is never Done; the 10 min limit hands over to the chat", async () => {
    vi.useFakeTimers();
    for (const turnId of [undefined, turn]) {
      const apply = vi.fn();
      const read = vi.fn(async () => { throw Object.assign(new Error("Turn state is read in the Murage app or on your paired phone."), { status: 403 }); });
      startFollow({ read, turnId, apply, until: Date.now() + 10 * 60_000, everyMs: 5_000 });
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 100);
      expect(read.mock.calls.length).toBeGreaterThan(100);
      expect(apply).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenCalledWith({ lost: true });
    }
    vi.useRealTimers();
    expect(askView(record({ lost: true }), loaded([own()])).s).toBe("inChat");
  });
  it("an engine rebuild mid-answer (server says running or unknown) is no early Done, even after our first turn's rows", async () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    // Our first turn wrote rows, then the rebuild re-ran the send: the server reads running, then unknown while held.
    const read = vi.fn()
      .mockResolvedValueOnce(word({ state: "running" }))
      .mockResolvedValueOnce(word({ state: "unknown" }))
      .mockResolvedValueOnce(word({ state: "unknown" }))
      .mockResolvedValueOnce(word({ state: "running" }))
      .mockResolvedValue(word({ state: "ended", endedAt: 9 }));
    const follow = startFollow({ read, turnId: "turn-1", apply, until: Date.now() + 60_000, everyMs: 1_000 });
    await vi.advanceTimersByTimeAsync(3_500);
    expect(apply).not.toHaveBeenCalled();
    const first = msg({ role: "bot", kind: "text", text: "partial", turnId: "turn-1" });
    const terminal = msg({ kind: "activity", turnId: "turn-1", turnTerminal: true });
    expect(askView(record(), loaded([own({ dispatchedIn: "turn-1" }), first, terminal]), { turnId: "turn-2", ended: false }).s).toBe("running");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(apply).toHaveBeenCalledWith({ endedSend: true, endedTurn: "turn-1" });
    follow.stop();
    vi.useRealTimers();
    // The rebuild restamped our row to its new turn after that word: not Done, followed again.
    expect(askView(record({ endedSend: true, endedTurn: "turn-1" }), loaded([own({ dispatchedIn: "turn-2" })])).s).toBe("running");
    expect(askView(record({ endedSend: true, endedTurn: "turn-2" }), loaded([own({ dispatchedIn: "turn-2" })])).s).toBe("done");
  });
});

describe("L4B-FULL-FIX-1018: Stop that stopped nothing, refused, closing help", () => {
  const handlers = { onStop: vi.fn(), onRemove: vi.fn(), onRetry: vi.fn(), onOpenChat: vi.fn(), onDone: vi.fn() };
  const html = (view: AskView, rec: Partial<AskRecord> = {}) => renderToStaticMarkup(createElement(AskBody, { name: "Nova", view, record: record(rec), ...handlers }));
  it("stopped:false (the live run is not our turn yet, a rebuild) is said, never shown as a quiet Stop", async () => {
    expect(await stopTurn("c1", "t1", "turn-9", (async () => ({ ok: true, stopped: false })) as never)).toEqual({ stop: "missed" });
    expect(await stopTurn("c1", "t1", "turn-9", (async () => ({ ok: true, stopped: true })) as never)).toEqual({ stop: undefined });
    // An older server answers {ok:true} alone: as before, nothing to say.
    expect(await stopTurn("c1", "t1", "turn-9", (async () => ({ ok: true })) as never)).toEqual({ stop: undefined });
    const missed = html({ s: "running", turnId: "turn-9", answer: [] }, { stop: "missed" });
    expect(missed).toContain(say("ux.l4b.stopFailed"));
    expect(missed).toContain(`>${hx("ux.l4b.tryAgain")}<`);
    expect(missed).toContain(say("ux.l4b.openInChat"));
    expect(html({ s: "running", turnId: "turn-9", answer: [] })).not.toContain(say("ux.l4b.stopFailed"));
  });
  it("a refused question offers the chat, where its chip and Send again wait (no dead end)", () => {
    const refused = html({ s: "refused" });
    expect(refused).toContain(say("ux.l4b.refused"));
    expect(refused).toContain(say("ux.l4b.tryAgain"));
    expect(refused).toContain(say("ux.l4b.openInChat"));
    // Before the words left there is nothing in the chat yet.
    expect(html({ s: "sending" })).not.toContain(say("ux.l4b.openInChat"));
  });
  it("reopening drops only what the close ended: Stopping and Removing, never the question or a settled word", () => {
    expect(reopened(null)).toBeNull();
    const back = reopened(record({ stop: "stopping", cancel: "removing", queueId: "q1", endedSend: true }));
    expect(back).toEqual(record({ queueId: "q1", endedSend: true }));
    expect(reopened(record({ stop: "missed", cancel: "retry" }))).toEqual(record({ stop: "missed", cancel: "retry" }));
    // Reopened while Removing: queued again with Remove from line, not a stuck Removing.
    const chiefRows = chief({ messages: [] });
    expect(askView(back!, chiefRows).s).toBe("done");
    expect(askView(reopened(record({ queueId: "q1", cancel: "removing" }))!, chiefRows)).toEqual({ s: "queued", removing: false });
  });
});

describe("copy", () => {
  it("plain words, no em dashes, no banned words", () => {
    const copy = JSON.parse(src("../../locales/en-help/ask.json")) as Record<string, string>;
    for (const value of Object.values(copy)) {
      expect(value).not.toMatch(/—|–/);
      expect(value).not.toMatch(/\b(safe|free|forge)\b/i);
    }
  });
});

describe("kept Ask lifecycle (pure controller, no DOM mount)", () => {
  const scope = { owner: {}, account: "a", botId: "c1", threadId: "t1", signedOut: false };
  const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
  it("clears on revocation, target or account change and rejects old receipts", async () => {
    for (const changed of [{ signedOut: true }, { botId: "c2" }, { threadId: "t2" }, { account: "b" }, { owner: {} }]) {
      const life = createAskLifetime(); life.authorize(scope);
      const g = life.next(); life.keep(record({ gen: g }));
      const opening = life.open(); const late = deferred<Partial<AskRecord>>();
      const receipt = late.promise.then((p) => life.patch(g, p));
      life.authorize({ ...scope, ...changed });
      expect(opening.signal.aborted).toBe(true);
      expect(life.record).toBeNull();
      late.resolve({ phase: "accepted" }); await receipt;
      expect(life.record).toBeNull();
    }
  });
  it("revocation while closed erases the kept answer and invalidates the outstanding receipt", async () => {
    const life = createAskLifetime(); life.authorize(scope);
    const g = life.next(); life.keep(record({ gen: g, endedSend: true }));
    const opening = life.open(); opening.close();
    const response = deferred<{ status: number }>();
    const watch = createSessionWatch({ fetch: () => response.promise, now: () => 0, desktop: () => false });
    const unsubscribe = watch.onSignedOut(life.clear);
    const checking = watch.check(); response.resolve({ status: 401 }); await checking;
    life.patch(g, { phase: "accepted" });
    const back = life.open(); expect(life.record).toBeNull(); back.close(); unsubscribe();
  });
  it("close aborts Remove A and retires it; its late failure cannot overwrite Remove B", async () => {
    const life = createAskLifetime(); life.authorize(scope);
    const g = life.next(); life.keep(record({ gen: g, queueId: "q1" }));
    const a = life.open(); const attempt = a.begin(); const late = deferred<void>();
    const callback = late.promise.then(() => { if (attempt.live()) life.patch(g, { cancel: "retry" }); });
    a.close(); expect(a.signal.aborted).toBe(true); expect(attempt.live()).toBe(false);
    const b = life.open(); expect(b.begin().live()).toBe(true);
    life.patch(g, { cancel: "removed" }); late.resolve(); await callback;
    expect(life.record?.cancel).toBe("removed"); b.close();
  });
  it("late delivery survives close, reopening never sends, and keeps the ten-minute deadline", async () => {
    vi.useFakeTimers();
    try {
      const life = createAskLifetime(); life.authorize(scope);
      const send = vi.fn(); const g = life.submit(record({ phase: "sending" }), send)!.gen;
      const a = life.open(); const receipt = deferred<Partial<AskRecord>>();
      const pending = receipt.promise.then((p) => life.patch(g, p));
      a.close(); receipt.resolve({ phase: "accepted", queueId: "q1" }); await pending;
      const b = life.open(); expect(life.record?.phase).toBe("accepted");
      const until = life.deadline(g, 600_000); b.close();
      await vi.advanceTimersByTimeAsync(590_000);
      const c = life.open(); expect(life.deadline(g, 600_000)).toBe(until);
      const read = vi.fn(() => new Promise<never>(() => {}));
      startFollow({ read, until, outer: c.signal, apply: (p) => life.patch(g, p) });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(life.record?.lost).toBe(true); expect(send).toHaveBeenCalledTimes(1); c.close();
    } finally { vi.useRealTimers(); }
  });
  it("a chat resend's current queued/sending/refused attempt wins, then its accepted row runs", () => {
    const r = record({ phase: "refused" });
    const rows = chief({ messages: [own({ dispatchedIn: "turn-new" })] });
    expect(askView(r, rows).s).toBe("running");
    expect(reconcileDelivery(r, rows, [{ sendId: "s1", queueId: "q2", text: "q" }])).toMatchObject({ phase: "accepted", queueId: "q2" });
    expect(reconcileDelivery(r, rows, [{ sendId: "s1", queueId: "sending:s1", text: "q", sending: true }]).phase).toBe("sending");
    expect(reconcileDelivery(r, rows, [{ sendId: "s1", queueId: "q2", text: "q", refused: { notice: "stopped" } } as never]).phase).toBe("refused");
    expect(askView(r, chief({ id: "other", messages: rows.messages })).s).not.toBe("running");
  });
  it("Stop completion asks the server again; close suppresses that continuation", async () => {
    for (const close of [false, true]) {
      const end = new AbortController(); const reply = deferred<Partial<AskRecord>>(); const apply = vi.fn(); const read = vi.fn();
      const pending = settleStop(reply.promise, end.signal, apply, read);
      if (close) end.abort(); reply.resolve({ stop: "missed" }); await pending;
      expect(read).toHaveBeenCalledTimes(close ? 0 : 1); expect(apply).toHaveBeenCalledTimes(close ? 0 : 1);
    }
  });
  it("signed-out HelpAsk renders no question or answer (static render, not mounted)", () => {
    const spy = vi.spyOn(storeModule, "useStore").mockReturnValue({ state: { signedOut: true, bots: [chief()], pendingQueued: {} }, dispatch: vi.fn() } as never);
    try {
      expect(renderToStaticMarkup(createElement(HelpAsk, { screenTitle: "Routines", onOpenChat: vi.fn() }))).toBe("");
    } finally { spy.mockRestore(); forgetKeptAsk(); }
  });
  it("Stop rechecks turn-state through the active follow and reaches Done only on that read", async () => {
    vi.useFakeTimers();
    const life = createAskLifetime(); life.authorize(scope);
    const g = life.next(); life.keep(record({ gen: g }));
    const opening = life.open();
    try {
      const get = vi.fn().mockResolvedValueOnce({ state: "running" }).mockResolvedValue({ state: "ended" });
      const nudge = { current: undefined as (() => void) | undefined };
      const cleanup = startAskFollow({ life, record: life.record, view: { s: "running", turnId: "turn-9", answer: [] }, turnId: "turn-9", closing: { current: opening }, nudge, get });
      await vi.advanceTimersByTimeAsync(0);
      const post = deferred<{ stopped: boolean }>();
      const pending = settleStop(stopTurn("c1", "t1", "turn-9", vi.fn(() => post.promise) as never, 15_000, opening.signal), opening.signal, (p) => life.patch(g, p), () => { startAskNudge(nudge); });
      expect(get).toHaveBeenCalledTimes(1); expect(life.record?.endedSend).toBeUndefined();
      post.resolve({ stopped: false }); await pending; await vi.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledTimes(2);
      expect(life.record).toMatchObject({ stop: "missed", endedSend: true, endedTurn: "turn-9" });
      cleanup();
    } finally { opening.close(); vi.useRealTimers(); }
  });
  it("carries the opening signal to DELETE ", () => {
    expect(src("../../state/store.tsx")).toContain('method: "DELETE", signal: action.signal');
    expect(src("./HelpAsk.tsx")).toContain('signal: closing.current.signal');

  });
});

it("includes the agreed design unchanged (SHA-256 of the supplied input)", () => {
  expect(createHash("sha256").update(src("../../../designs/UX-L4B-FULL-1018.md")).digest("hex")).toBe("7dc09e914725051ad37252e655f90815e27fbec3359f0c9d0cb480ac2fd329f5");
});
