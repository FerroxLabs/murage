// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Ask about this screen" (UX-L4B-FULL, designs/UX-L4B-FULL-1018.md sections 3, 7 to 9). A lazy chunk inside the help
// panel. The owner's question goes to the Chief's chat as an ordinary owner message, sent `noSteer`, so the server runs
// it as its own turn and nothing else joins it. The panel only SHOWS that turn: our row is found by its sendId, the
// answer is the bot rows stamped with the turn our row was released to (`dispatchedIn`), never "the latest reply". The
// panel writes nothing to the transcript, so a late answer is only ever a chat row. Each Ask bumps a generation, and an
// older generation's callbacks never repaint the panel. The question outlives closing help (section 3.3): only Done or a
// new Ask drops it within the same signed-in scope. Closing ends every request and timer of that opening; reopening follows it.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, useStore, useStreaming, type Bot, type Message } from "@/state/store";
import { isDefinitiveFailure } from "@/state/send-delivery";
import { useTurnLive, type TurnLive } from "@/state/turn-status";
import { newSendId } from "@/lib/send-id";
import { botRole } from "@/lib/bot-role";
import { onSignedOut, sessionSignedOut } from "@/lib/session-check";
import { createAskLifetime, reconcileDelivery, settleStop } from "./help-ask-lifetime";
export { attempts, reopened } from "./help-ask-lifetime";
import { askSetTimeout, askClearTimeout, askAddAbort, askRemoveAbort, askOnSignedOut, askScope, askApi, askLive, askStream, askSubscribe, askObserve } from "./help-ask-port";
import { hx } from "./help-copy";

/** The visible Chief, never "the first bot". */
export const chiefOf = (bots: readonly Bot[]): Bot | undefined => bots.find((b) => !b.hidden && botRole(b) === "chief");

/** The exact outgoing words: the owner's question and the screen's fixed catalogue title (never a name, H3). */
export const askText = (question: string, screenTitle: string): string =>
  `${question.trim()}\n\n${hx("ux.l4b.sentFrom", { screen: screenTitle })}`;

/** One Ask, as the panel holds it. Everything else is read from the store. */
export interface AskRecord {
  gen: number;
  sendId: string;
  botId: string;
  threadId: string;
  question: string;
  /** The exact words posted, so Try again resends the same words under the same sendId (the server dedupes on it). */
  text: string;
  /** "uncertain": delivery failed in a way that does not say the server lacks it (the outbox gave up, a timeout).
   *  Only our own row in the transcript says it arrived; nothing is sent again from here. */
  phase: "sending" | "accepted" | "uncertain" | "refused";
  queueId?: string;
  /** Remove from line: on the wire, or what the 404's `state` said. "started" means follow the turn. */
  cancel?: "removing" | "removed" | "missing" | "retry" | "started";
  /** "missed": the route answered `stopped: false` (the live run is not this turn, e.g. a rebuild has not stamped it yet). */
  stop?: "stopping" | "unconfirmed" | "failed" | "missed";
  stopLine?: string;
  /** The turn the SERVER (or a frame naming it) says has ended. Done only while it is still our row's turn, so a turn
   *  restamped after a rebuild is followed afresh (designs/UX-L4B-CLIENT-TURNSTATE-1019.md). */
  endedTurn?: string;
  /** The server said the SEND ended (its last turn ended, nothing of it live or waiting): Done even before our row's
   *  turn id reaches the store. Slice 1 keys "ended" on the send and only for a send that ran. */
  endedSend?: true;
  /** Handed to the chat: the follow limit passed (reads failed, a 403, or the server never said "ended"). */
  lost?: true;
}

export type AskView =
  | { s: "sending" | "refused" | "removed" | "missing" | "removeRetry" | "inChat" | "starting" }
  | { s: "queued"; removing: boolean }
  | { s: "running" | "approval" | "done"; turnId: string; answer: Message[]; streaming?: string };

const unloaded = (bot: Bot) => Boolean(bot.messagesUnloaded || bot.firstPageEvents);

/** An open card of our turn: a live ask with no answer yet. */
const openCard = (m: Message, turnId: string) =>
  m.kind === "options" && m.turnId === turnId && Boolean(m.card) && !m.card!.answered && !m.card!.dismissed && !m.card!.expired && !m.card!.answers?.length;

/** What the panel shows for an Ask, from the record, the Chief's rows in the store and the thread's live turn. */
export function askView(record: AskRecord, bot: Bot | undefined, live: TurnLive = { ended: false }, streaming?: string, pending?: import("@/state/store").AppState["pendingQueued"][string]): AskView {
  record = reconcileDelivery(record, bot, pending);
  if (record.phase === "refused") return { s: "refused" };
  if (record.cancel === "removed") return { s: "removed" };
  if (record.cancel === "missing") return { s: "missing" };
  if (record.phase === "sending") return { s: "sending" };
  // Rows not in the store (never loaded, a newer task on screen, the Chief gone): the answer is in the chat.
  if (!bot || bot.id !== record.botId || bot.threadId !== record.threadId || unloaded(bot)) return { s: "inChat" };
  const own = bot.messages.find((m) => m.role === "user" && m.sendId === record.sendId);
  if (!own && record.phase === "uncertain") return { s: "inChat" };
  const turnId = own?.dispatchedIn;
  if (record.lost) return { s: "inChat" };
  if (!turnId) {
    if (record.endedSend) return { s: "done", turnId: "", answer: [] };
    if (record.queueId && !own && record.cancel !== "started") {
      return record.cancel === "retry" ? { s: "removeRetry" } : { s: "queued", removing: record.cancel === "removing" };
    }
    return { s: "starting" };
  }
  const answer = bot.messages.filter((m) => m.role === "bot" && m.turnId === turnId && m.kind === "text" && Boolean(m.text?.trim()));
  // Ended only when the SERVER says so for our send (TURNSTATE-1019). Rows (other turns' late rows, our own terminal row
  // before a rebuild restamps us) and live frames (an unnamed turn.completed takes the thread's current id) are hints to
  // ask it. A word given for an older turn id of ours (restamped since) is not Done: the panel asks again.
  if (record.endedTurn === turnId || (record.endedSend && record.endedTurn === undefined)) return { s: "done", turnId, answer };
  if (bot.messages.some((m) => openCard(m, turnId))) return { s: "approval", turnId, answer };
  // The live words are ours only while the thread's live turn is ours.
  const words = live.turnId === turnId && !live.ended && streaming?.trim() ? streaming : undefined;
  return { s: "running", turnId, answer, ...(words ? { streaming: words } : {}) };
}

/** A send error the server meant (a 4xx refusal), or words that never left (the outbox is full): Try again is honest.
 *  Anything else (the outbox gave up, a timeout) may have reached the server, so it is never called refused. */
export function deliveryRefused(error: unknown): boolean {
  return isDefinitiveFailure(error) || (error as { status?: unknown } | null)?.status === 507;
}

/** What a failed Remove from line means, from the 404's `state` (section 9.4, G-L1). "again": the row is still being
 *  sent, so the panel asks once more. No answer is ever Done from a 404 alone: "started" follows the turn. */
export function cancelOutcome(error: unknown): Partial<AskRecord> | "again" {
  const said = (error as { body?: { state?: unknown; messageId?: unknown } } | null)?.body;
  switch (said?.state) {
    case "started": return { cancel: "started" };
    case "cancelled": return { cancel: "removed" };
    case "missing": return { cancel: "missing" };
    case "sending": return "again";
    case "failed": return typeof said.messageId === "string" ? { cancel: "started" } : { phase: "refused" };
    default: return { cancel: "retry" };
  }
}

/** How long Stop and Remove from line may take before the panel says they did not go through. */
export const ASK_REQUEST_MS = 15_000;

/** One request with a deadline, which the panel's close (`outer`) also ends. Rejects on either. */
export async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, deadlineMs = ASK_REQUEST_MS, outer?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let timerActive = true;
  if (import.meta.env.MODE === "help-fixture") askObserve("requestTimer", () => ({ active: timerActive }));
  const late = new Promise<never>((_, reject) => {
    const end = (why: string) => { controller.abort(); reject(Object.assign(new Error(why), { status: 408 })); };
    timer = askSetTimeout(() => end("timed out"), deadlineMs);
    onAbort = () => end("closed");
    if (outer?.aborted) onAbort(); else askAddAbort(outer, onAbort);
  });
  late.catch(() => {});
  try {
    return await Promise.race([run(controller.signal), late]);
  } finally {
    timerActive = false;
    askClearTimeout(timer);
    if (onAbort) askRemoveAbort(outer, onAbort);
  }
}

/** Stop, aimed at our turn only: the route stops the thread's run only when it is still this turn (`{ok, stopped}`).
 *  `stopped: false` stopped nothing, so it is never shown as stopped: the panel says so, keeps Open in chat (the chat's
 *  own Stop) and asks the server where its question is. Bounded, and ended by close. */
export async function stopTurn(botId: string, threadId: string, turnId: string, post: typeof api = api, deadlineMs = ASK_REQUEST_MS, outer?: AbortSignal): Promise<Partial<AskRecord>> {
  try {
    const said = await bounded((signal) => post(`/api/bots/${botId}/interrupt`, { method: "POST", body: JSON.stringify({ threadId, turnId }), signal }), deadlineMs, outer);
    return (said as { stopped?: unknown } | null)?.stopped === false ? { stop: "missed" } : { stop: undefined };
  } catch (error) {
    const e = error as { body?: { code?: unknown }; message?: string } | null;
    return e?.body?.code === "provider_stop_unconfirmed" ? { stop: "unconfirmed", stopLine: e.message } : { stop: "failed" };
  }
}

/** What the server says of our question: slice 1's owner-only turn-state read (feat/1019-ux-l4b-server). `unknown`
 *  never means ended. */
export interface AskTurnWord { state: "queued" | "running" | "ended" | "unknown"; endedAt?: number }

/** Slice 1's owner-only route (feat/1019-ux-l4b-server 37abf2204): GET ?threadId&sendId[&turnId] -> {state, endedAt?}.
 *  A paired phone reads it through the door's owner proof (L4B-PHONE-TURNSTATE 1.0.20). A 403 (no proof), like any
 *  failed read, is still "unknown", never Done, and the 10 min limit hands the question to the chat. */
export const ASK_STATE_PATH = (botId: string) => `/api/bots/${botId}/turn-state`;

export function askState(botId: string, threadId: string, sendId: string, turnId: string | undefined, signal: AbortSignal, get: typeof api = api): Promise<AskTurnWord> {
  const query = new URLSearchParams({ threadId, sendId, ...(turnId ? { turnId } : {}) });
  return get(`${ASK_STATE_PATH(botId)}?${query}`, { signal });
}

export interface FollowOptions {
  read: (signal: AbortSignal) => Promise<AskTurnWord>;
  /** The turn the reads ask about (our row's dispatchedIn), if released yet. */
  turnId?: string;
  apply: (change: Partial<AskRecord>) => void;
  /** The absolute time (Date.now()) the follow hands the question to the chat. */
  until: number;
  everyMs?: number;
  /** Closing help. */
  outer?: AbortSignal;
}

/** Follows one question from the server: a read at once, every `everyMs`, and on `nudge`; one read in flight, each
 *  bounded; `stop` (or `outer`) aborts the read in flight. At `until` it hands over to the chat (`lost`), whatever the
 *  reads did (TURNSTATE-1019). */
export function startFollow({ read, turnId, apply, until, everyMs = ASK_FOLLOW_EVERY_MS, outer }: FollowOptions): { nudge: () => void; stop: () => void } {
  const local = new AbortController();
  const over = () => local.signal.aborted;
  let inFlight = false;
  let tick: ReturnType<typeof setTimeout> | undefined;
  if (import.meta.env.MODE === "help-fixture") askObserve("followResources", () => ({ timers: over() ? 0 : 1 + Number(tick !== undefined), listener: !over() && !!outer }));
  const stop = () => { local.abort(); askClearTimeout(tick); askClearTimeout(limit); askRemoveAbort(outer, stop); };
  const limit = askSetTimeout(() => { if (!over()) { stop(); apply({ lost: true }); } }, Math.max(0, until - Date.now()));
  if (outer?.aborted) stop(); else askAddAbort(outer, stop);
  const check = () => {
    if (over() || inFlight) return;
    inFlight = true;
    askClearTimeout(tick); tick = undefined;
    void bounded(read, ASK_REQUEST_MS, local.signal)
      .then((word) => { const change = followChange(word, turnId); if (change && !over()) apply(change); })
      .catch(() => {})
      .finally(() => { inFlight = false; if (!over()) tick = askSetTimeout(check, everyMs); });
  };
  check();
  return { nudge: check, stop };
}

/** The change a server word makes to the record. "ended" is keyed on the SEND and given only for a send that ran (its
 *  last turn holds rows, nothing of it live or queued), so it is Done even if our row's turn id never reached the store.
 *  queued, running, unknown and any failed read (403 on a paired phone included) change nothing. */
export function followChange(word: AskTurnWord | undefined, turnId: string | undefined): Partial<AskRecord> | undefined {
  if (word?.state !== "ended") return undefined;
  return turnId ? { endedSend: true, endedTurn: turnId } : { endedSend: true };
}

const primary = "min-h-11 shrink-0 rounded-lg bg-accent px-4 text-[14px] font-medium text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border";
const secondary = "min-h-11 shrink-0 rounded-lg border border-hairline/60 px-3 text-[13px] font-medium text-ink hover:bg-app disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border";
const line = "text-[13px] leading-5 text-ink";

export interface AskBodyProps {
  name: string;
  view: AskView;
  record: Pick<AskRecord, "question" | "stop" | "stopLine">;
  onStop: () => void;
  onRemove: () => void;
  onRetry: () => void;
  onOpenChat: () => void;
  onDone: () => void;
}

/** The states after Ask, drawn from a view alone (tests render it from fixtures). */
export function AskBody({ name, view, record, onStop, onRemove, onRetry, onOpenChat, onDone }: AskBodyProps) {
  const open = <button type="button" className={secondary} onClick={onOpenChat}>{hx("ux.l4b.openInChat")}</button>;
  const busy = view.s === "sending" || view.s === "starting" || view.s === "queued" || view.s === "running" || view.s === "approval";
  const done = <button type="button" className={secondary} disabled={busy} onClick={onDone}>{hx("ux.l4b.done")}</button>;
  const say = (key: string) => <p className={line}>{hx(key, { name })}</p>;
  const turn = view.s === "running" || view.s === "approval" || view.s === "done";
  return (
    <div data-help-ask-state={view.s} className="flex flex-col gap-3">
      <p className="whitespace-pre-wrap rounded-lg bg-app px-3 py-2 text-[13px] text-ink-secondary">{record.question}</p>
      <div aria-live="polite" className="flex flex-col gap-3">
        {view.s === "sending" && say("ux.l4b.sending")}
        {view.s === "refused" && say("ux.l4b.refused")}
        {view.s === "removed" && say("ux.l4b.removed")}
        {view.s === "missing" && say("ux.l4b.missing")}
        {view.s === "removeRetry" && say("ux.l4b.removeFailed")}
        {view.s === "inChat" && say("ux.l4b.inChat")}
        {view.s === "starting" && say("ux.l4b.starting")}
        {view.s === "queued" && say("ux.l4b.queued")}
        {turn && (
          <>
            <h4 className="text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-secondary">{hx("ux.l4b.answers", { name })}</h4>
            {view.answer.map((m) => <div key={m.id} data-help-answer className="whitespace-pre-wrap text-[14px] leading-6 text-ink">{m.text}</div>)}
            {view.s === "running" && view.streaming && <div data-help-streaming className="whitespace-pre-wrap text-[14px] leading-6 text-ink">{view.streaming}</div>}
            {view.s === "running" && view.answer.length === 0 && !view.streaming && say("ux.l4b.working")}
            {view.s === "approval" && say("ux.l4b.approval")}
            {view.s === "done" && say("ux.l4b.saved")}
            {view.s === "running" && record.stop === "unconfirmed" && record.stopLine && <p className={line}>{record.stopLine}</p>}
            {view.s === "running" && (record.stop === "failed" || record.stop === "missed") && say("ux.l4b.stopFailed")}
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {view.s === "queued" && <button type="button" className={secondary} disabled={view.removing} onClick={onRemove}>{hx(view.removing ? "ux.l4b.removing" : "ux.l4b.removeFromLine")}</button>}
        {(view.s === "removeRetry" || view.s === "refused") && <button type="button" className={secondary} onClick={view.s === "refused" ? onRetry : onRemove}>{hx("ux.l4b.tryAgain")}</button>}
        {view.s === "running" && (
          <button type="button" className={secondary} disabled={record.stop === "stopping"} onClick={onStop}>
            {hx(record.stop === "stopping" ? "ux.l4b.stopping" : record.stop ? "ux.l4b.tryAgain" : "ux.l4b.stop")}
          </button>
        )}
        {/* The chat is always one press away once the question may have reached it, Stopping and Removing included. A
            refused question waits there too, as the chat's chip with its own Send again (section 3.4). */}
        {view.s !== "sending" && view.s !== "removed" && open}
        {done}
      </div>
    </div>
  );
}

/** The panel follows an accepted question by asking the server this often, and hands it to the chat after the limit
 *  (approval cards wait for the owner, so a turn may rightly outlast any panel). Nothing waits forever (A-M2). */
export const ASK_FOLLOW_EVERY_MS = 5_000;
export const ASK_FOLLOW_MS = 10 * 60_000;
/** A transcript page that failed to load is asked for again, a bounded number of times, this far apart. */
export const ASK_LOAD_TRIES = 3;
export const ASK_LOAD_RETRY_MS = 2_000;

/** Kept in the lazy chunk across openings, but never across sign-out, account, Chief or task changes. */
const lifetime = createAskLifetime();
// This subscription intentionally survives panel close, as does the kept question.
askOnSignedOut(onSignedOut, () => lifetime.clear());
const keep = lifetime.keep;
export function forgetKeptAsk() { lifetime.clear(); }

export interface HelpAskProps {
  /** The screen's fixed catalogue title (feedbackEnvelopeForScreen().title), never a name. */
  screenTitle: string;
  onOpenChat: (botId: string, threadId?: string) => void;
}

type Ref<T> = { current: T };
type AskLifetime = ReturnType<typeof createAskLifetime>;
type Opening = ReturnType<AskLifetime["open"]>;

/** Effect bodies share the same cleanup path in React and controller tests. */
export function startAskOpening({ life, show, opening, closing, timers }: {
  life: AskLifetime; show: (r: AskRecord | null) => void; opening: Ref<Opening | null>;
  closing: Ref<{ signal: AbortSignal }>; timers: Ref<Set<ReturnType<typeof setTimeout>>>;
}) {
  const current = life.open(show);
  if (import.meta.env.MODE === "help-fixture") askObserve("opening", () => ({ aborted: current.signal.aborted, timers: current.signal.aborted ? 0 : timers.current.size }));
  opening.current = current;
  closing.current = current;
  return () => {
    current.close();
    for (const handle of timers.current) askClearTimeout(handle);
    timers.current.clear();
  };
}

export function startAskPage({ record, needsPage, loads, dispatch }: {
  record: AskRecord | null; needsPage: boolean; loads: Ref<{ key: string; tries: number }>;
  dispatch: (action: { type: "loadFirstPage"; threadId: string }) => void;
}) {
  let active = true;
  let handle: ReturnType<typeof setTimeout> | undefined;
  if (import.meta.env.MODE === "help-fixture") askObserve("pageTimer", () => ({ active: active && handle !== undefined }));
  const cleanup = () => { active = false; askClearTimeout(handle); handle = undefined; };
  if (!record || !needsPage) return cleanup;
  const key = `${record.gen}:${record.threadId}`;
  if (loads.current.key !== key) loads.current = { key, tries: 0 };
  const tries = loads.current.tries;
  if (tries > ASK_LOAD_TRIES) return cleanup;
  const load = () => { handle = undefined; if (active) { loads.current.tries++; dispatch({ type: "loadFirstPage", threadId: record.threadId }); } };
  if (tries === 0) load();
  else handle = askSetTimeout(load, ASK_LOAD_RETRY_MS * tries);
  return cleanup;
}

/** Shared by HelpAsk and the fixture's retained-mount dependency probe. */
export function useAskPage({ record, needsPage, loads, dispatch }: Parameters<typeof startAskPage>[0]) {
  useEffect(() => startAskPage({ record, needsPage, loads, dispatch }), [record, needsPage, dispatch]);
}

export function askFollowKey(record: AskRecord | null, view: AskView | null, turnId?: string) {
  const following = view?.s === "queued" || view?.s === "starting" || view?.s === "running" || view?.s === "approval";
  return record && following ? `${record.gen}:${record.sendId}:${turnId ?? ""}` : "";
}

export function startAskFollow({ life, record, view, turnId, closing, nudge, get = askApi(api) }: {
  life: AskLifetime; record: AskRecord | null; view: AskView | null; turnId?: string;
  closing: Ref<{ signal: AbortSignal }>; nudge: Ref<(() => void) | undefined>; get?: typeof api;
}) {
  if (!record || !askFollowKey(record, view, turnId)) return () => {};
  const { gen: g, botId, threadId, sendId } = record;
  const until = life.deadline(g, ASK_FOLLOW_MS);
  const follow = startFollow({
    read: (signal) => askState(botId, threadId, sendId, turnId, signal, get),
    turnId, apply: (change) => life.patch(g, change),
    until, outer: closing.current.signal,
  });
  if (import.meta.env.MODE === "help-fixture") askObserve("follow", { key: askFollowKey(record, view, turnId), until });
  nudge.current = follow.nudge;
  return () => { follow.stop(); if (nudge.current === follow.nudge) nudge.current = undefined; };
}

export function startAskNudge(nudge: Ref<(() => void) | undefined>) {
  nudge.current?.();
  return () => {};
}

export default function HelpAsk({ screenTitle, onOpenChat }: HelpAskProps) {
  const ids = useId();
  const store = useStore();
  const [, fixtureRender] = useState(0);
  useEffect(() => {
    if (import.meta.env.MODE === "help-fixture") return askSubscribe(() => fixtureRender((n) => n + 1));
  }, []);
  const { state, dispatch } = askScope(store, api);
  useEffect(() => {
    if (import.meta.env.MODE === "help-fixture") {
      askObserve("mount", ids); return () => askObserve("unmount", ids);
    }
  }, [ids]);
  const chief = chiefOf(state.bots);
  const account = state.config?.profile?.email;
  const [draft, setDraft] = useState({ text: "", owner: dispatch, account, botId: chief?.id, threadId: chief?.threadId });
  const question = draft.owner === dispatch && draft.account === account && draft.botId === chief?.id && draft.threadId === chief?.threadId ? draft.text : "";
  const setQuestion = (text: string) => setDraft({ text, owner: dispatch, account, botId: chief?.id, threadId: chief?.threadId });
  const [, setRecord] = useState<AskRecord | null>(null);
  const signedOut = state.signedOut || sessionSignedOut();
  lifetime.authorize({ owner: dispatch, account: state.config?.profile?.email, botId: chief?.id, threadId: chief?.threadId, signedOut });
  const saved = lifetime.record;
  const record = saved ? reconcileDelivery(saved, state.bots.find((b) => b.id === saved.botId), state.pendingQueued[saved.threadId]) : null;
  const loads = useRef<{ key: string; tries: number }>({ key: "", tries: 0 });
  const opening = useRef<ReturnType<typeof lifetime.open> | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  /** Every request in flight (Stop, the follow reads): closing help ends them all. */
  const closing = useRef<{ signal: AbortSignal }>({ signal: new AbortController().signal });
  /** Asks the server now rather than at the next tick; set while an Ask is followed. */
  const nudge = useRef<(() => void) | undefined>(undefined);
  /** Applies a change only while its Ask is still the kept one (and, with `when`, still in that state). A delivery
   *  receipt after help closed still lands, so a reopened panel shows where the question really is. */
  const patch = lifetime.patch;
  /** A timer closing help clears; its callback runs only for the Ask that set it. */
  const later = useCallback((g: number, fn: () => void, ms: number) => {
    // A callback after this opening closed (a Remove's late answer) sets no timer nobody would clear.
    if (closing.current.signal.aborted) return;
    const handle = askSetTimeout(() => { timers.current.delete(handle); if (lifetime.generation === g) fn(); }, ms);
    timers.current.add(handle);
  }, []);
  // This opening shows the kept question. Closing help ends every request and timer of this opening; the question stays.
  useEffect(() => startAskOpening({ life: lifetime, show: setRecord, opening, closing, timers }), [signedOut, chief?.id, chief?.threadId, dispatch, account]);

  const bot = record ? state.bots.find((b) => b.id === record.botId) : undefined;
  const live = askLive(useTurnLive(record?.threadId));
  const { streaming } = useStreaming();
  const view = record ? askView(record, bot, live, askStream(streaming)[record.threadId], state.pendingQueued[record.threadId]) : null;
  const turnId = view && "turnId" in view ? view.turnId : undefined;

  // The transcript: the existing first-page loader for the Chief's thread, without selecting its chat (H2). A failed
  // page (firstPageFailed clears firstPageEvents) is asked for again, bounded, for this Ask only.
  const needsPage = Boolean(record && bot && bot.threadId === record.threadId && bot.messagesUnloaded && !bot.firstPageEvents);
  useAskPage({ record, needsPage, loads, dispatch });

  // The key changes only for activation, a new Ask or a restamped turn; the deadline stays absolute.
  const followKey = askFollowKey(record, view, turnId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => startAskFollow({ life: lifetime, record, view, turnId, closing, nudge }), [followKey]);
  useEffect(() => startAskNudge(nudge), [live.turnId, live.ended, bot?.busy, turnId]);

  /** A first Ask mints its sendId; Try again resends the same words under the same one, as the chat's Send again does. */
  const send = (botId: string, threadId: string, words: string, text: string, again?: string) => {
    if (signedOut || closing.current.signal.aborted) return;
    const sendId = again ?? newSendId();
    lifetime.submit({ sendId, botId, threadId, question: words, text, phase: "sending" }, ({ gen: g }) => dispatch({
      type: "send", botId, threadId, text, sendId, noSteer: true,
      ...(again ? { resend: true as const, actionId: crypto.randomUUID() } : {}),
      onReceipt: (receipt) => patch(g, { phase: "accepted", ...(receipt.queued && receipt.queueId ? { queueId: receipt.queueId } : {}) }),
      onError: (error) => { patch(g, { phase: deliveryRefused(error) ? "refused" : "uncertain" }); return true; },
    }));
  };

  const removeFrom = (g: number, botId: string, queueId: string, tries: number) => {
    // Only the newest attempt may speak; a timeout retires its attempt, so its late answer never overwrites a newer one.
    const attempt = opening.current?.begin();
    if (!attempt || !attempt.live()) return;
    const mine = attempt.live;
    if (import.meta.env.MODE === "help-fixture") askObserve("attempt", () => ({ generation: g, live: mine() }));
    patch(g, { cancel: "removing" });
    // A DELETE that never answers is a failed Remove, with Try again and Open in chat.
    later(g, () => { if (mine()) { attempt.retire(); patch(g, { cancel: "retry" }, (r) => r.cancel === "removing"); } }, ASK_REQUEST_MS);
    dispatch({
      type: "cancelQueued", botId, queueId, signal: closing.current.signal,
      onDone: () => { if (mine()) patch(g, { cancel: "removed" }); },
      onError: (error) => {
        if (!mine()) return true;
        const outcome = cancelOutcome(error);
        if (outcome === "again" && tries < 4) later(g, () => { if (mine()) removeFrom(g, botId, queueId, tries + 1); }, 1_000);
        else patch(g, outcome === "again" ? { cancel: "retry" } : outcome);
        return true;
      },
    });
  };
  const remove = () => { if (record?.queueId) removeFrom(record.gen, record.botId, record.queueId, 0); };

  const stop = () => {
    if (!record || !turnId) return;
    const g = record.gen;
    const ends = closing.current.signal;
    patch(g, { stop: "stopping" });
    // A Stop the close ended says nothing: the reopened panel shows Stop again and asks the server.
    void settleStop(stopTurn(record.botId, record.threadId, turnId, askApi(api), ASK_REQUEST_MS, ends), ends,
      (change) => patch(g, change), () => { startAskNudge(nudge); });
  };

  const finish = () => { lifetime.next(); keep(null); setQuestion(""); };

  if (signedOut) return null;

  if (!chief) {
    return (
      <section data-help-ask className="border-b border-hairline/40 px-5 py-4">
        <p className="text-[14px] leading-5 text-ink">{hx("ux.l4b.noChief")}</p>
      </section>
    );
  }
  const name = (bot ?? chief).name;
  const words = question.trim();
  return (
    <section data-help-ask aria-labelledby={`${ids}-h`} className="border-b border-hairline/40 px-5 py-4">
      <h3 id={`${ids}-h`} className="mb-2.5 text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-secondary">{hx("ux.l4b.heading")}</h3>
      {record && view ? (
        <AskBody name={name} view={view} record={record} onStop={stop} onRemove={remove}
          onRetry={() => send(record.botId, record.threadId, record.question, record.text, record.sendId)}
          onOpenChat={() => onOpenChat(record.botId, record.threadId)} onDone={finish} />
      ) : (
        <form className="flex flex-col gap-2.5" onSubmit={(event) => { event.preventDefault(); if (words) send(chief.id, chief.threadId, words, askText(words, screenTitle)); }}>
          <textarea aria-label={hx("ux.l4b.label")} placeholder={hx("ux.l4b.placeholder")} value={question} rows={3}
            onChange={(event) => setQuestion(event.target.value)}
            className="w-full resize-y rounded-lg border border-hairline/60 bg-app px-3 py-2 text-[14px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border" />
          <p className="text-[12px] leading-5 text-ink-secondary">{hx("ux.l4b.before", { name })}</p>
          {words && (
            <div data-help-ask-preview>
              <p className="text-[12px] font-semibold text-ink-secondary">{hx("ux.l4b.preview")}</p>
              <p className="whitespace-pre-wrap rounded-lg bg-app px-3 py-2 text-[13px] text-ink">{askText(words, screenTitle)}</p>
            </div>
          )}
          <button type="submit" className={`${primary} self-end`} disabled={!words}>{hx("ux.l4b.ask")}</button>
        </form>
      )}
    </section>
  );
}
