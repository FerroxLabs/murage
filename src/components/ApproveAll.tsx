// SPDX-License-Identifier: AGPL-3.0-or-later
// Approve all on Needs you and Approvals (APPROVE-ALL-1016 rev 3; APPROVALS-SIMPLE-1018 sections 3 and 3b). The button
// shows only where the server's owner-app check says so (the desktop app or the owner's phone app, never a browser),
// and whenever 2 or more approval rows wait (NOLIM-1019 N3); its label counts the rows ON SCREEN carrying the server's
// `bulk: "ok"` stamp, and a list with none of them shows it disabled ("N need a look").
//
// Desktop (scope "screen"): a press reads the preview, binds it to the displayed ok rows the preview also lists (if they
// differ nothing is applied, "The list changed.") and opens the REVIEW panel (T12, designs/BATCH-APPROVE-REVIEW-1023.md):
// the owner ticks, and only an Approve activation answers the ticked cards. The chat thread's Approve all keeps the
// direct path. Phone: the sheet
// stays (the device proof signs the exact list), each line the bot's own words plus the grey kind, never a command.
//
// 3b: anything open (the caution, the sheet, a note) belongs to the list it was opened over. When the displayed request
// rows change (Refresh, the 5 s beat bringing a different list, a row answered here or elsewhere, a tab change) it
// closes, and a preview still loading is dropped. An apply in flight keeps its lock; its result line stays only while
// the list just loses rows it was pressed over. Nothing here decides eligibility.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { api, requestFailedSentence, useStoreIfAny } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { BotAvatar } from "./Avatar";
import { approveAllCounts, approveAllLabel } from "../../shared/approve-all-counts";
import { applyApproveAll, applyRefusalMeansChanged, approveClickAllowed, batchReason, bindForRefresh, boundToScreen, cardDetail, carryTicks, groupByBot, judgeThreadWindow, listToken, noEligibleOutcome, previewBody, previewGate, reasonLine, requestIdOfKey, resultLine, resultSurvives, reviewKey, reviewResultKey, reviewSent, threadAsPreview, threadPreviewBody, threadResultNotes, threadWindows, tickedCards, type ApplyResult, type PendingKey, type ApproveAllPreview, type ApproveAllSurface, type EligibleCard, type PreviewScreen, type ThreadPreview } from "@/lib/approve-all";
import { lowerFirst } from "@/lib/approval-row";
import { localizeOutsideNote } from "@/lib/outside-note";
import { isHeldActivation } from "@/lib/needs-keys";

const button = "min-h-11 rounded-lg px-3 py-1.5 text-[13px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60";

/** The server's answer to "does this surface show Approve all", read again whenever `key` moves (a Refresh, a new
 *  list). Any failure reads as hidden. */
export function useApproveAllSurface(key: string | number = 0): [ApproveAllSurface, (dismissed: boolean) => Promise<void>] {
  const [surface, setSurface] = useState<ApproveAllSurface>({ show: false });
  useEffect(() => {
    let live = true;
    api("/api/inbox/approve-all/surface", { method: "POST", body: "{}" })
      .then((value: ApproveAllSurface) => { if (live) setSurface(value?.show === true ? value : { show: false }); })
      .catch(() => { if (live) setSurface({ show: false }); });
    return () => { live = false; };
  }, [key]);
  const setDismissed = async (dismissed: boolean) => {
    const value = await api("/api/inbox/approve-all/caution", { method: "POST", body: JSON.stringify({ dismissed }) }) as { cautionDismissed?: boolean };
    setSurface((current) => ({ ...current, cautionDismissed: value?.cautionDismissed === true }));
  };
  return [surface, setDismissed];
}

/** What the person saw when they pressed (designs/APPROVALS-SIMPLE-1018-gotit-design.md, Opus r2 High): the interaction
 *  it belongs to, the list generation, and a copy of the on-screen ok rows, taken at the click before any await. A press
 *  approves exactly this set or nothing. */
export interface PressSnapshot { id: number; gen: string; ready: readonly string[]; screen?: PreviewScreen }
export function pressSnapshot(now: { gen: string; ready: readonly string[]; screen?: PreviewScreen }, id: number): PressSnapshot {
  // the screen's query too (RESIDUALS-1018-B row 6): the preview reads the page the press was made over
  return { id, gen: now.gen, ready: [...now.ready], ...(now.screen ? { screen: { ...now.screen } } : {}) };
}
/** After any await: still on screen, the same generation (no Refresh, no list move, even one that came back), and the
 *  same ok rows (a stamp can flip while the id set stays put). */
export function stillPressed(press: PressSnapshot, now: { gen: string; ready: readonly string[]; mounted: boolean }): boolean {
  return now.mounted && now.gen === press.gen && listToken(now.ready) === listToken(press.ready);
}
/** "Got it" with or without "Don't show this again": the save first (a failure is swallowed: the caution simply shows
 *  again next time), then the press goes on only over the list it was made over. "gone": the tab was left or a newer
 *  action (a press, Review them first, Cancel) owns the screen, so do nothing. "changed": the list moved, apply nothing. */
export const CAUTION_SAVE_TIMEOUT_MS = 10_000;
/** A save that never settles would leave "Approving {n}..." disabled; past the bound it counts as a failed save and the
 *  checks below still run (Opus r3 Low). */
export async function continueFromCaution(press: PressSnapshot, save: (() => Promise<unknown>) | null,
  now: () => { gen: string; ready: readonly string[]; mounted: boolean; interaction: number }): Promise<"run" | "changed" | "gone"> {
  if (save) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((done) => { timer = setTimeout(done, CAUTION_SAVE_TIMEOUT_MS); });
    try { await Promise.race([save(), bound]); } catch { /* the caution shows again next time */ } finally { clearTimeout(timer); }
  }
  const live = now();
  if (!live.mounted || live.interaction !== press.id) return "gone";
  return stillPressed(press, live) ? "run" : "changed";
}

/** T12 D4: what the review panel holds. `gone` = reviewed cards whose row left the list (never sent). */
interface ReviewData { press: PressSnapshot; preview: ApproveAllPreview; cards: EligibleCard[]; selection: ReadonlySet<string>; fresh: ReadonlySet<string>; gone: ReadonlySet<string>; expired: boolean; refreshesAt: number }
type Step =
  | { at: "idle" }
  | ({ at: "review" } & ReviewData)
  | { at: "refreshing"; rv: ReviewData }
  | { at: "done"; line: string; rv: ReviewData; perCard: ReadonlyMap<string, string> }
  | { at: "caution" }
  | { at: "saving"; n: number }
  | { at: "previewing"; n: number }
  | { at: "applying"; n: number; rv?: ReviewData; sent?: string[] }
  | { at: "sheet"; preview: ApproveAllPreview; cards: EligibleCard[]; press: PressSnapshot; notes?: string }
  | { at: "note"; line: string; sticky?: boolean }
  | { at: "result"; line: string; pressed: readonly string[] };

/** Section 3b: what a list change does to the open step. An apply in flight (already sent) is never torn down; a
 *  result line stays only while the list just loses rows it was pressed over (`resultSurvives`), and never over a
 *  Refresh; anything else (a preview still loading, the caution, the phone sheet, a note) closes (Astra r2 High: a
 *  loading preview used to count as "applying" and survived a Refresh). */
export function stepAfterListChange(step: { at: string; pressed?: readonly string[]; sticky?: boolean }, nextKeys: readonly string[], manual: boolean): "keep" | "close" {
  if (step.at === "idle" || step.at === "applying") return "keep";
  // T12 D5: the desktop review, its refresh, its per-card result and the unconfirmed line belong to the frozen batch, not
  // the screen: a passive move (the 5 s beat, a new row, a bot chip) keeps them; only a manual Refresh closes them.
  if (step.at === "review" || step.at === "refreshing" || step.at === "done" || (step.at === "note" && step.sticky)) return manual ? "close" : "keep";
  if (step.at === "result" && !manual && step.pressed && resultSurvives(step.pressed, nextKeys)) return "keep";
  return "close";
}

/** The kind under a line on the phone sheet, the same words as a row's grey line. */
const kindWords = (kind: string) => t(`ux.l2b.door.kind.${["command", "edit", "app"].includes(kind) ? kind : "other"}` as LocaleKey);

export function ApproveAllButton({ ready, listed, threadId, counts: displayedCounts, scope = "screen", screen, refreshes, onApplied, onChanged }: {
  /** NOLIM-1019 N3: the Inbox's own tally of the approvals on screen (shown) and the ones the server stamped ok */
  counts?: ReturnType<typeof approveAllCounts>;
  /** "screen" (Inbox, Needs you): a press answers exactly the ok rows on screen. "thread" (the chat, Rev 3.3, which cannot
   *  tell which cards go in bulk): a press asks the server for a preview of this thread's shown cards, in windows, and
   *  answers the ones it lists as eligible; the rest stay for their own Allow. */
  scope?: "screen" | "thread";
  /** scope "thread": the chat's thread */
  threadId?: string;
  /** the rows on screen the server stamped ok, as `threadId\0messageId` (scope "thread": every shown card as `chatRequestKey`): the count, and exactly what a press answers */
  ready: readonly string[];
  /** every request row on screen, the same keys: its set is the list's generation token (3b) */
  listed: readonly string[];
  /** the Inbox query those rows came from: the preview reads the same page (RESIDUALS-1018-B row 6) */
  screen?: PreviewScreen;
  /** the page's Refresh presses: each closes anything open and reads the surface again */
  refreshes: number;
  onApplied?: () => void;
  /** the list moved under a press: read it again */
  onChanged?: () => void;
}) {
  const token = listToken(listed);
  const [surface, setDismissed] = useApproveAllSurface(`${refreshes}|${token}`);
  const [step, setStep] = useState<Step>({ at: "idle" });
  const [error, setError] = useState<string | null>(null);
  const gate = useRef(previewGate()).current;
  const store = useStoreIfAny();
  const bots = store?.state.bots ?? [];
  const botOf = (id?: string) => bots.find((bot) => bot.id === id);
  const botName = (id?: string) => botOf(id)?.name ?? t("approveAll.botFallback");
  // The live list, for checks made after an await (a press binds to the rows on screen at the click). `gen` is the
  // Refresh presses, a monotonic count of list moves (A->B->A is a move, Astra) and the list's set: a press made before
  // any of them never lands after it.
  const moved = useRef({ token, n: 0 });
  if (moved.current.token !== token) moved.current = { token, n: moved.current.n + 1 };
  const gen = `${refreshes}|${moved.current.n}|${token}`;
  // The person's actions (a press, Got it, Review them first, Cancel): a flow started under an older one does nothing.
  const interaction = useRef(0);
  const act = () => ++interaction.current;
  const live = useRef({ token, gen, ready, listed, screen, refreshes, mounted: true });
  live.current = { token, gen, ready, listed, screen, refreshes, mounted: live.current.mounted };
  const seen = useRef({ token, refreshes });
  const stepNow = useRef<Step>(step);
  stepNow.current = step;
  // Astra r2 High: leaving the tab unmounts this button. A preview still loading then must never go on to apply rows
  // that are no longer on screen; an apply already sent keeps its lock and finishes, but shows nothing.
  useEffect(() => {
    live.current.mounted = true;
    return () => {
      live.current.mounted = false;
      if (!gate.signing) gate.retire();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const manual = refreshes !== seen.current.refreshes;
    if (!manual && token === seen.current.token) return;
    seen.current = { token, refreshes };
    if (stepAfterListChange(stepNow.current, listed, manual) === "keep") return;
    if (!gate.signing) gate.retire();
    setError(null);
    setStep({ at: "idle" });
  }, [token, refreshes]); // eslint-disable-line react-hooks/exhaustive-deps

  // T12 D4: the ONE place an await landing or a review exit sets the step. `gone` (unmounted, or a newer action owns the
  // screen) sets nothing visible. The apply landings release the sign lock first (`landApply`), `gone` included.
  type Outcome =
    | { at: "gone" } | { at: "cancelled" }
    | { at: "review"; data: ReviewData }
    | { at: "expired" }
    | { at: "done"; line: string; rv: ReviewData; perCard: ReadonlyMap<string, string> }
    | { at: "note"; line: string; sticky?: boolean }
    | { at: "error"; message: string };
  const settle = (outcome: Outcome) => {
    if (outcome.at === "gone") return;
    if (outcome.at === "cancelled") { interaction.current += 1; if (!gate.signing) gate.retire(); focusBack.current = true; setError(null); setStep({ at: "idle" }); return; }
    if (outcome.at === "review") { setError(null); setStep({ at: "review", ...outcome.data }); return; }
    if (outcome.at === "expired") { setStep((cur) => cur.at === "applying" && cur.rv ? { at: "review", ...cur.rv, expired: true } : cur); return; }
    if (outcome.at === "done") { setError(null); setStep({ at: "done", line: outcome.line, rv: outcome.rv, perCard: outcome.perCard }); return; }
    if (outcome.at === "note") { setStep({ at: "note", line: outcome.line, ...(outcome.sticky ? { sticky: true } : {}) }); onChanged?.(); return; }
    setError(outcome.message); setStep({ at: "idle" });
  };
  const landApply = (outcome: Outcome) => { gate.done(); settle(outcome); };

  // T12 D5: a reviewed card whose row leaves the list is `gone` (greyed, unticked, never sent), whatever moved the list.
  useEffect(() => {
    const on = new Set(listed);
    const mark = (rv: ReviewData): ReviewData => {
      const gone = new Set(rv.gone);
      const selection = new Set(rv.selection);
      for (const card of rv.cards) if (!on.has(reviewKey(card))) { gone.add(reviewKey(card)); selection.delete(card.requestId); }
      return gone.size === rv.gone.size ? rv : { ...rv, gone, selection };
    };
    setStep((cur) => cur.at === "review" ? { ...cur, ...mark(cur) } : cur.at === "refreshing" ? { ...cur, rv: mark(cur.rv) } : cur);
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  // T12 D5 (Opus L3: by value): a change of the screen (view, page, query, Show snoozed) closes the review, nothing applied.
  const screenKey = JSON.stringify(screen ?? null);
  const seenScreen = useRef(screenKey);
  const focusBack = useRef(false);
  useEffect(() => {
    if (seenScreen.current === screenKey) return;
    seenScreen.current = screenKey;
    const at = stepNow.current;
    if (at.at === "review" || at.at === "refreshing" || at.at === "done" || (at.at === "note" && at.sticky)) settle({ at: "cancelled" });
  }, [screenKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Escape or Cancel in the review hands focus back to the Approve all button, once it has remounted.
  useEffect(() => {
    if (step.at !== "idle" || !focusBack.current) return;
    focusBack.current = false;
    document.querySelector<HTMLButtonElement>("[data-approve-all]")?.focus();
  }, [step.at]);

  // NOLIM-1019 N3: two waiting approvals show the button, whether or not any can go in bulk (the 11-06 gate counted only
  // `bulk: ok` rows, so a list of held cards hid it). Under 2 there is no button. The chat does not know which cards are
  // eligible, so its label carries no count; the Inbox's says what the press would approve and what needs a look.
  const chat = scope === "thread" && threadId !== undefined;
  const counts = chat ? { visible: listed.length >= 2, disabled: false, ok: listed.length, rest: 0 }
    : displayedCounts ?? approveAllCounts(listed.map(key => ({ kind: "request", bulk: ready.includes(key) ? "ok" : "held" })));
  const label = chat ? t("approveAll.buttonAll")
    : counts.rest === 0 ? t("approveAll.button", { n: counts.ok })
    : approveAllLabel(counts, { approve: ok => t("approveAll.approveCount", { ok }), look: rest => t("approveAll.needLook", { rest }) });
  if (!surface.show) return null;
  if (!counts.visible && (step.at === "idle" || step.at === "caution")) return null;

  const closeWith = (line: string) => { setStep({ at: "note", line }); onChanged?.(); };
  /** Apply the bound cards. Every post (and the phone's one signed retry) first checks the list has not moved. `notes` is
   *  what a chat press adds under the result line (the cards that wait for their own Allow, a press-again nudge). */
  const apply = async (preview: ApproveAllPreview, cards: EligibleCard[], press: PressSnapshot, names: string[], notes = "") => {
    if (!stillPressed(press, live.current)) { if (live.current.mounted) closeWith(t("approveAll.changed")); return; }
    if (!gate.sign()) return;
    const pressed = [...live.current.listed];
    setError(null);
    setStep({ at: "applying", n: cards.length });
    try {
      const done = await applyApproveAll(
        (body) => {
          // every post, and the phone's one signed retry: still on screen, the same list and ok rows as at the press
          if (!stillPressed(press, live.current)) return Promise.reject(Object.assign(new Error(t("approveAll.changed")), { code: "changed" }));
          return api("/api/inbox/approve-all/apply", { method: "POST", body: JSON.stringify(body) }) as Promise<{ approved: number; results: ApplyResult[] }>;
        },
        preview, cards, batchReason(cards.length, names));
      onApplied?.();
      if (!live.current.mounted) return;
      // The result line shows only over the list it was pressed over: not after a Refresh, and not once a row the
      // press never saw arrived (Astra r2 High). Otherwise the list simply re-reads, with nothing stale on it.
      const sameGen = live.current.gen.split("|")[0] === press.gen.split("|")[0] && resultSurvives(pressed, live.current.listed);
      if (!sameGen) { setStep({ at: "idle" }); return; }
      const threadBot = new Map(preview.eligible.map((card) => [card.threadId, card.botId]));
      const line = resultLine(done.results, (resultThread) => botName(threadBot.get(resultThread)));
      setStep({ at: "result", line: notes ? `${line} ${notes}` : line, pressed });
    } catch (e) {
      if (!live.current.mounted) return;
      const code = (e as { code?: string })?.code;
      // "changed" only when the list moved or the server refused the batch as no longer matching (Rev 3.3 U4 e)
      if (code === "changed" || applyRefusalMeansChanged(e)) { closeWith(t("approveAll.changed")); return; }
      const message = e instanceof Error ? e.message : String(e);
      if (message && code !== "cancelled") setError(message);
      setStep({ at: "idle" });
    } finally {
      gate.done();
    }
  };

  // The chat press (Rev 3.3 U4/V3): the thread preview of the shown cards, in windows of THREAD_WINDOW, until one window has
  // eligible cards. Per window, after the await: the press snapshot first (the list moved: "changed"), then the check of
  // the preview against what was asked (a protocol error is the failed-preview line, never "changed"), then the next
  // window. Windows without eligible cards are read only; a batch exists only for the window that has some.
  const runThread = async (press: PressSnapshot, ticket: number) => {
    const asked = threadWindows(press.ready.map((key) => requestIdOfKey(threadId!, key)).filter((id): id is string => id !== null));
    let excluded = 0;
    let closed = 0;
    for (let at = 0; at < asked.length; at += 1) {
      let preview: ThreadPreview;
      try {
        preview = await api("/api/inbox/approve-all/preview", { method: "POST", body: threadPreviewBody(threadId!, asked[at]!) }) as ThreadPreview;
      } catch (e) {
        if (!gate.accepts(ticket) || !live.current.mounted || interaction.current !== press.id) return;
        setError(e instanceof Error ? e.message : String(e));
        setStep({ at: "idle" });
        return;
      }
      if (!gate.accepts(ticket) || !live.current.mounted) return;
      if (interaction.current !== press.id) return;
      const bound = judgeThreadWindow(stillPressed(press, live.current), preview, threadId!, asked[at]!.map((id) => `${threadId!}\u0000${id}`));
      if (bound.at === "changed") { closeWith(t("approveAll.changed")); return; }
      if (bound.at === "protocol") { setError(requestFailedSentence(502)); setStep({ at: "idle" }); return; }
      if (bound.at === "empty") { excluded += bound.excluded; closed += bound.closed; continue; }
      const windowsRemain = at < asked.length - 1;
      const asPreview = threadAsPreview(preview, windowsRemain);
      const notes = threadResultNotes(excluded + bound.excluded, bound.later > 0 || windowsRemain);
      if (surface.app === "phone") { setStep({ at: "sheet", preview: asPreview, cards: bound.cards, press, notes }); return; }
      await apply(asPreview, bound.cards, press, [...new Set(bound.cards.map((card) => botName(card.botId)))], notes);
      return;
    }
    closeWith(noEligibleOutcome({ excluded, closed }) === "eachOwn" ? t("approveAll.eachOwn") : t("approveAll.none"));
  };

  // Single flight (review H2): a second press while a preview loads does nothing, and a preview (or its failure) that
  // lands after a sign started, after a newer preview, or after the list moved (3b, gate.retire) is dropped.
  // `press` was taken at the click; nothing below reads the rows on screen again except to check they have not moved.
  const run = async (press: PressSnapshot) => {
    if (!stillPressed(press, live.current)) { if (live.current.mounted) closeWith(t("approveAll.changed")); return; }
    const ticket = gate.begin();
    if (ticket === null) return;
    setError(null);
    setStep({ at: "previewing", n: press.ready.length });
    if (chat) { await runThread(press, ticket); return; }
    let preview: ApproveAllPreview;
    try {
      preview = await api("/api/inbox/approve-all/preview", { method: "POST", body: previewBody(press.screen) }) as ApproveAllPreview;
    } catch (e) {
      if (!gate.accepts(ticket) || !live.current.mounted || interaction.current !== press.id) return;
      setError(e instanceof Error ? e.message : String(e));
      setStep({ at: "idle" });
      return;
    }
    // Dropped when the list moved, a Refresh was pressed or the tab was left while it loaded (gate.retire), and
    // checked again here in case the retire raced the response.
    if (!gate.accepts(ticket) || !live.current.mounted) return;
    if (interaction.current !== press.id) return;
    if (!stillPressed(press, live.current)) { closeWith(t("approveAll.changed")); return; }
    const bound = boundToScreen(preview, press.ready);
    if (bound.at === "none") { closeWith(t("approveAll.none")); return; }
    if (bound.at === "changed") { closeWith(t("approveAll.changed")); return; }
    if (surface.app === "phone") { setStep({ at: "sheet", preview, cards: bound.cards, press }); return; }
    // T12 D1: the desktop opens the review; nothing is answered until an Approve activation there.
    if (surface.app === "desktop") {
      settle({ at: "review", data: { press, preview, cards: bound.cards, selection: new Set(bound.cards.map((card) => card.requestId)), fresh: new Set(), gone: new Set(), expired: false, refreshesAt: live.current.refreshes } });
      return;
    }
    const names = [...new Set(bound.cards.map((card) => botName(card.botId)))];
    await apply(preview, bound.cards, press, names);
  };
  /** T12 D5: Approve in the review. Synchronously, before any await: the ticked cards still on the list, in preview order.
   *  Not `stillPressed`: the list's generation moves on every arrival, and the review is bound to the frozen batch. */
  const approveReview = async () => {
    const rv = stepNow.current;
    if (rv.at !== "review" || rv.expired) return;
    if (!live.current.mounted || interaction.current !== rv.press.id || live.current.refreshes !== rv.refreshesAt) return;
    const sent = reviewSent(rv.cards, rv.selection, rv.gone, live.current.listed);
    if (sent.length === 0 || !gate.sign()) return;
    const applying: Step = { at: "applying", n: sent.length, rv, sent };
    stepNow.current = applying;
    setError(null);
    setStep(applying);
    const sentCards = rv.cards.filter((card) => sent.includes(card.requestId));
    const names = [...new Set(sentCards.map((card) => botName(card.botId)))];
    let done: { approved: number; results: ApplyResult[] };
    try {
      done = await applyApproveAll((body) => api("/api/inbox/approve-all/apply", { method: "POST", body: JSON.stringify(body) }) as Promise<{ approved: number; results: ApplyResult[] }>, rv.preview, sentCards, batchReason(sent.length, names));
    } catch (e) {
      const { status, body } = (e ?? {}) as { status?: unknown; body?: { code?: unknown } };
      const code = typeof body?.code === "string" ? body.code : "";
      onApplied?.();
      if (!live.current.mounted || interaction.current !== rv.press.id) { landApply({ at: "gone" }); return; }
      // 409 batch gone or used: the review stays, out of date. A reply with another 4xx: nothing applied, an error line.
      // No answer or 5xx: never re-posted; the owner is told it cannot be confirmed and the list is re-read.
      if (status === 409 && (code === "batch_unknown" || code === "batch_used")) landApply({ at: "expired" });
      else if (typeof status === "number" && status >= 400 && status < 500) landApply({ at: "error", message: e instanceof Error ? e.message : String(e) });
      else landApply({ at: "note", line: t("approveAll.review.unconfirmed"), sticky: true });
      return;
    }
    onApplied?.();
    if (!live.current.mounted || interaction.current !== rv.press.id) { landApply({ at: "gone" }); return; }
    // a manual Refresh or a change of screen while it applied: the result is dropped, the list re-reads (an empty error closes to idle)
    if (live.current.refreshes !== rv.refreshesAt || JSON.stringify(live.current.screen ?? null) !== JSON.stringify(rv.press.screen ?? null)) { landApply({ at: "error", message: "" }); return; }
    const threadBot = new Map(rv.preview.eligible.map((card) => [card.threadId, card.botId]));
    const line = resultLine(done.results, (resultThread) => botName(threadBot.get(resultThread)));
    const perCard = new Map(done.results.map((r) => {
      const { key, reason } = reviewResultKey(r);
      return [r.requestId, t(key, { why: reason ? reasonLine(reason) : "" })] as const;
    }));
    landApply({ at: "done", line, rv, perCard });
  };
  /** T12 D4: Refresh list from the out-of-date review: a fresh snapshot under the same interaction, the preview re-read,
   *  bound to that snapshot's ready rows (no `changed`), ticks carried only for the same id and digest. */
  const refreshList = async () => {
    const rv = stepNow.current;
    if (rv.at !== "review" || !rv.expired) return;
    const snap = pressSnapshot(live.current, rv.press.id);
    const ticket = gate.begin();
    if (ticket === null) return;
    setError(null);
    const waiting: Step = { at: "refreshing", rv };
    stepNow.current = waiting;
    setStep(waiting);
    let preview: ApproveAllPreview;
    try {
      preview = await api("/api/inbox/approve-all/preview", { method: "POST", body: previewBody(snap.screen) }) as ApproveAllPreview;
    } catch (e) {
      if (!gate.accepts(ticket) || !live.current.mounted || interaction.current !== snap.id) return;
      settle({ at: "error", message: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (!gate.accepts(ticket) || !live.current.mounted || interaction.current !== snap.id) return;
    const cards = bindForRefresh(preview, snap.ready);
    if (cards.length === 0) { settle({ at: "note", line: t("approveAll.none") }); return; }
    const carry = carryTicks(rv, cards);
    // a row that left the list while the refresh loaded is `gone` from the start
    const on = new Set(live.current.listed);
    const gone = new Set(cards.filter((card) => !on.has(reviewKey(card))).map(reviewKey));
    for (const card of cards) if (gone.has(reviewKey(card))) carry.selection.delete(card.requestId);
    settle({ at: "review", data: { press: snap, preview, cards, selection: carry.selection, fresh: carry.fresh, gone, expired: false, refreshesAt: live.current.refreshes } });
  };
  // Opus r2 High: the snapshot is taken at the "Got it" click, before the "Don't show this again" save is awaited, so a
  // row that arrives during the save is never approved; a moved list says so and applies nothing.
  const gotIt = async (dontShow: boolean) => {
    if (stepNow.current.at !== "caution") return; // a second Got it while this one saves does nothing
    const snap = pressSnapshot(live.current, act());
    const saving: Step = { at: "saving", n: snap.ready.length };
    stepNow.current = saving;
    setError(null);
    setStep(saving);
    const verdict = await continueFromCaution(snap, dontShow ? () => setDismissed(true) : null, () => ({ ...live.current, interaction: interaction.current }));
    if (verdict === "gone") return;
    if (verdict === "changed") { closeWith(t("approveAll.changed")); return; }
    await run(snap);
  };
  const press = () => {
    const id = act();
    // T12 D1: on the desktop's own list the caution is folded into the review panel's footer
    if (surface.cautionDismissed || (surface.app === "desktop" && !chat)) void run(pressSnapshot(live.current, id));
    else setStep({ at: "caution" });
  };
  const cancel = () => { act(); setError(null); setStep({ at: "idle" }); };
  const cancelReview = () => { if (stepNow.current.at !== "applying") settle({ at: "cancelled" }); };
  const toggle = (ids: readonly string[], on: boolean) => setStep((cur) => {
    if (cur.at !== "review") return cur;
    const next = new Set(cur.selection);
    for (const id of ids) { const card = cur.cards.find((c) => c.requestId === id); if (on && card && !cur.gone.has(reviewKey(card))) next.add(id); else if (!on) next.delete(id); }
    return { ...cur, selection: next };
  });

  return <div className="mt-3">
    {/* "The list changed" is never a dead end (Astra): the note keeps an enabled Approve all */}
    {(step.at === "idle" || step.at === "note" || step.at === "result" || step.at === "done") && counts.visible && <button type="button" data-approve-all className={`${button} bg-accent text-accent-ink`} disabled={counts.disabled} onClick={press}>{label}</button>}
    {(step.at === "applying" || step.at === "previewing" || step.at === "saving") && <button type="button" data-approve-all className={`${button} bg-accent text-accent-ink`} disabled aria-busy="true">{t("approveAll.busy", { n: step.n })}</button>}
    {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
    {(step.at === "review" || step.at === "refreshing" || (step.at === "applying" && step.rv) || step.at === "done") && (() => {
      const mode = step.at === "review" ? (step.expired ? "expired" : "review") : step.at === "applying" ? "applying" : step.at === "refreshing" ? "refreshing" : "done";
      const rv = step.at === "review" ? step : step.rv!;
      return <ApproveAllReview rv={rv} mode={mode} line={step.at === "done" ? step.line : ""} perCard={step.at === "done" ? step.perCard : undefined} botName={botName} botOf={botOf}
        onToggle={toggle} onApprove={() => void approveReview()} onCancel={cancelReview} onRefresh={() => void refreshList()} />;
    })()}
    {step.at === "caution" && <Caution onReview={cancel} onContinue={(dontShow) => void gotIt(dontShow)} />}
    {step.at === "sheet" && <ApproveAllSheet preview={step.preview} cards={step.cards} botName={botName} botOf={botOf} busy={gate.signing} onCancel={cancel} onApprove={(cards, names) => {
      // the phone checks the press's snapshot before it signs, and the post wrapper checks it again before the retry
      if (!stillPressed(step.press, live.current)) { closeWith(t("approveAll.changed")); return; }
      void apply(step.preview, cards, step.press, names, step.notes ?? "");
    }} />}
    {step.at === "note" && <p role="status" data-approve-all-line className="mt-1 text-[13px] text-ink">{step.line}</p>}
    {step.at === "result" && <p role="status" data-approve-all-line className="mt-1 text-[13px] text-ink">{step.line}</p>}
  </div>;
}

export function Caution({ onReview, onContinue }: { onReview: () => void; onContinue: (dontShow: boolean) => void }) {
  const [dontShow, setDontShow] = useState(false);
  return <div role="group" data-box-exempt="inline step inside the Approvals list" aria-labelledby="approve-all-caution" className="mt-3 rounded-xl bg-card p-4">
    <h2 id="approve-all-caution" className="text-[15px] font-semibold">{t("approveAll.caution.title")}</h2>
    <p className="mt-2 text-[13px] text-ink-secondary">{t("approveAll.caution.body")}</p>
    <label className="mt-3 flex min-h-11 items-center gap-2 text-[13px]"><input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />{t("approveAll.caution.dontShow")}</label>
    <div className="mt-3 flex justify-end gap-2">
      <button type="button" className={`${button} bg-inset text-ink`} onClick={onReview}>{t("approveAll.sheet.cancel")}</button>
      <button type="button" className={`${button} bg-accent text-accent-ink`} onClick={() => onContinue(dontShow)}>{t("approveAll.caution.gotIt")}</button>
    </div>
  </div>;
}

/** T12 D1-D3 and D6: the desktop review panel. The panel root owns the keys: no key approves by default (Enter on a box,
 *  line or heading does nothing, a held key never approves, focus opens on the heading), arrows and j/k rove the boxes,
 *  Space ticks, Escape cancels in review and does nothing while an apply is in flight (and never reaches the Inbox dialog,
 *  whose own Escape would close the whole Inbox and lose the result). */
export function ApproveAllReview({ rv, mode, line, perCard, botName, botOf, onToggle, onApprove, onCancel, onRefresh }: {
  rv: ReviewData; mode: "review" | "expired" | "refreshing" | "applying" | "done"; line: string; perCard?: ReadonlyMap<string, string>;
  botName: (id?: string) => string; botOf: (id?: string) => Parameters<typeof BotAvatar>[0]["bot"] | undefined;
  onToggle: (requestIds: readonly string[], on: boolean) => void; onApprove: () => void; onCancel: () => void; onRefresh: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const pending = useRef<PendingKey | null>(null);
  const [cursor, setCursor] = useState(0);
  const lastBox = useRef<HTMLInputElement | null>(null);
  const locked = mode !== "review";
  useEffect(() => { heading.current?.focus(); }, [mode === "done"]); // eslint-disable-line react-hooks/exhaustive-deps
  // The button that had focus (Approve, Refresh list) is disabled or gone while an apply or refresh is in flight; focus must
  // stay inside the panel, or Escape reaches the Inbox dialog's own handler and closes the whole Inbox (Opus review M).
  useEffect(() => { if (mode === "applying" || mode === "refreshing" || !root.current?.contains(document.activeElement)) heading.current?.focus(); }, [mode]);
  useEffect(() => {
    root.current?.querySelectorAll<HTMLInputElement>("input[data-review-box]").forEach((box) => {
      const ids = (box.dataset.ids ?? "").split(",").filter(Boolean);
      const on = ids.filter((id) => rv.selection.has(id)).length;
      box.indeterminate = on > 0 && on < ids.length;
    });
  });
  // A passive removal greys a row (its box turns disabled). Roving must never strand a keyboard user: the tab stop moves to the
  // first live box when the cursor box is not live, and focus that sat on the box that went away moves to a live box.
  useEffect(() => {
    const all = Array.from(root.current?.querySelectorAll<HTMLInputElement>("input[data-review-box]") ?? []);
    const live = all.filter((box) => !box.disabled);
    const firstLive = all.findIndex((box) => !box.disabled);
    if (firstLive >= 0 && (all[cursor] === undefined || all[cursor]!.disabled)) setCursor(firstLive);
    const was = lastBox.current;
    if (was && was.disabled && (document.activeElement === was || document.activeElement === document.body)) {
      lastBox.current = null;
      const after = all.slice(all.indexOf(was) + 1).find((box) => !box.disabled) ?? live[live.length - 1];
      (after ?? heading.current)?.focus();
    }
  });
  const groups = groupByBot(rv.cards);
  const ticked = rv.cards.filter((card) => rv.selection.has(card.requestId) && !rv.gone.has(reviewKey(card))).length;
  const boxes = () => Array.from(root.current?.querySelectorAll<HTMLInputElement>("input[data-review-box]:not(:disabled)") ?? []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (mode !== "applying") onCancel(); return; }
    if (event.key === "Enter" || event.key === " ") pending.current = { repeat: isHeldActivation(event), onApprove: target.hasAttribute("data-review-approve") };
    if (event.key === "Enter" && target.tagName !== "BUTTON") { event.preventDefault(); return; }
    const all = boxes();
    const at = all.indexOf(target as HTMLInputElement);
    if (at < 0 || event.metaKey || event.ctrlKey || event.altKey) return;
    const to = event.key === "ArrowDown" || event.key === "j" ? at + 1 : event.key === "ArrowUp" || event.key === "k" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? all.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    const next = all[Math.max(0, Math.min(all.length - 1, to))];
    next?.focus();
  };
  const onKeyUp = (event: ReactKeyboardEvent<HTMLElement>) => { if (event.key !== " " || (event.target as HTMLElement).tagName !== "BUTTON") pending.current = null; };
  const click = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const was = pending.current;
    pending.current = null;
    if (approveClickAllowed(event.detail, was)) onApprove();
  };
  let index = -1;
  const box = (ids: readonly string[], label: string, disabled = false) => {
    index += 1;
    const mine = index;
    const on = ids.filter((id) => rv.selection.has(id)).length;
    return <input type="checkbox" data-review-box data-ids={ids.join(",")} className="mt-2" aria-label={label} checked={ids.length > 0 && on === ids.length} disabled={locked || disabled}
      tabIndex={mine === cursor ? 0 : -1} onFocus={(event) => { lastBox.current = event.currentTarget; setCursor(mine); }} onBlur={(event) => { if (!event.currentTarget.disabled) lastBox.current = null; }} onChange={(event) => onToggle(ids, event.target.checked)} />;
  };
  return <div ref={root} role="group" data-box-exempt="inline step inside the Approvals list" aria-labelledby="approve-all-review" className="mt-3 rounded-xl bg-card p-4" onKeyDown={onKeyDown} onKeyUp={onKeyUp} onClick={() => { pending.current = null; }}>
    <h2 id="approve-all-review" ref={heading} tabIndex={-1} className="text-[15px] font-semibold focus:outline-none">{t(rv.cards.length === 1 ? "approveAll.review.title.one" : "approveAll.review.title.other", { n: rv.cards.length })}</h2>
    {mode === "done" && <p role="status" data-approve-all-line className="mt-1 text-[13px] text-ink">{line}</p>}
    {mode === "expired" && <p role="status" className="mt-1 text-[13px] text-ink">{t("approveAll.review.expired")}</p>}
    <ul className="mt-3 space-y-2">
      {groups.map((group) => {
        const bot = botOf(group.botId || undefined);
        const name = botName(group.botId || undefined);
        const mine = rv.cards.filter((card) => (card.botId ?? "") === group.botId);
        const live = mine.filter((card) => !rv.gone.has(reviewKey(card)));
        return <li key={group.botId || "none"} className="flex items-start gap-3">
          {box(live.map((card) => card.requestId), name, live.length === 0)}
          {bot && <BotAvatar bot={bot} size={28} />}
          <div className="min-w-0 text-[13px]">
            <div className="font-medium">{name} ({mine.length})</div>
            {group.kinds.map((kind) => {
              const inKind = mine.filter((card) => (["command", "edit", "app"].includes(card.kindLine) ? card.kindLine : "other") === kind.kind);
              const liveKind = inKind.filter((card) => !rv.gone.has(reviewKey(card)));
              return <div key={kind.kind}>
                {group.kinds.length > 1 && <div className="mt-1 flex items-start gap-2 text-ink-secondary">{box(liveKind.map((card) => card.requestId), `${name}: ${kindWords(kind.kind)}`, liveKind.length === 0)}<span className="pt-2">{kindWords(kind.kind)} ({inKind.length})</span></div>}
                <ul data-testid="approve-all-cards" className="mt-1 space-y-1">
                  {inKind.map((card) => {
                    const gone = rv.gone.has(reviewKey(card));
                    const detail = cardDetail(card);
                    const wants = t("ux.l2b.door.wants", { bot: name, wants: card.wants ? lowerFirst(card.wants) : t(`ux.l2b.door.wantsKind.${["command", "edit", "app"].includes(card.kindLine) ? card.kindLine : "other"}` as LocaleKey) });
                    return <li key={`${card.threadId}:${card.requestId}`} data-request-id={card.requestId} data-gone={gone ? "true" : undefined} className="flex items-start gap-2 break-words">
                      {box([card.requestId], wants, gone)}
                      <span className={gone ? "text-ink-secondary" : "text-ink"}>
                        {wants}{rv.fresh.has(card.requestId) && <span data-testid="approve-all-new" className="ml-2 text-[12px] text-accent">{t("approveAll.review.new")}</span>}
                        <span className="block text-[12px] text-ink-secondary">{kindWords(card.kindLine)}</span>
                        {[detail.tool, detail.subtitle, detail.summary].filter(Boolean).map((text) => <span key={text} className="block text-[12px] text-ink-secondary">{text}</span>)}
                        {detail.held && <span data-testid="approve-all-held" className="block text-[12px] text-ink-secondary">{localizeOutsideNote(detail.held)}</span>}
                        {gone && <span data-testid="approve-all-gone" className="block text-[12px] text-ink-secondary">{t("approveAll.review.gone")}</span>}
                        {perCard?.has(card.requestId) && <span data-testid="approve-all-result" className="block text-[12px] font-medium text-ink">{perCard.get(card.requestId)}</span>}
                      </span>
                    </li>;
                  })}
                </ul>
              </div>;
            })}
          </div>
        </li>;
      })}
    </ul>
    <p className="mt-4 text-[12px] text-ink-secondary">{t("approveAll.caution.body")}</p>
    {mode !== "done" && <div className="mt-3 flex justify-end gap-2">
      <button type="button" className={`${button} bg-inset text-ink`} disabled={mode === "applying"} onClick={onCancel}>{t("approveAll.sheet.cancel")}</button>
      {mode === "expired" && <button type="button" className={`${button} bg-accent text-accent-ink`} onClick={onRefresh}>{t("approveAll.review.refresh")}</button>}
      {mode === "refreshing" && <button type="button" className={`${button} bg-accent text-accent-ink`} disabled aria-busy="true">{t("approveAll.review.refreshing")}</button>}
      {(mode === "review" || mode === "applying") && ticked > 0 && <button type="button" data-review-approve className={`${button} bg-accent text-accent-ink`} disabled={mode === "applying"} onBlur={() => { pending.current = null; }} onClick={click}>{t("approveAll.sheet.approve", { n: ticked })}</button>}
    </div>}
  </div>;
}

/** The phone's confirm sheet. Each line is the bot's own words and the grey kind, grouped by bot, never a command;
 *  Approve hands over these same card objects, which the device proof signs (design 7.3). Ticks lock while a sign is
 *  in flight (review H2). `cards` are the preview's own objects for the rows on screen. */
export function ApproveAllSheet({ preview, cards = preview.eligible, botName, botOf, busy, onCancel, onApprove }: {
  preview: ApproveAllPreview; cards?: EligibleCard[]; botName: (id?: string) => string; botOf: (id?: string) => Parameters<typeof BotAvatar>[0]["bot"] | undefined; busy: boolean;
  onCancel: () => void; onApprove: (cards: EligibleCard[], botNames: string[]) => void;
}) {
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set());
  const groups = groupByBot(cards);
  const ticked = tickedCards(cards, unticked);
  const toggle = (botId: string) => busy ? undefined : setUnticked((current) => {
    const next = new Set(current);
    if (next.has(botId)) next.delete(botId); else next.add(botId);
    return next;
  });
  const names = groups.filter((group) => !unticked.has(group.botId)).map((group) => botName(group.botId || undefined));
  return <div role="group" data-box-exempt="inline step inside the Approvals list" aria-labelledby="approve-all-sheet" className="mt-3 rounded-xl bg-card p-4">
    <h2 id="approve-all-sheet" className="text-[15px] font-semibold">{ticked.length ? t(ticked.length === 1 ? "approveAll.sheet.title.one" : "approveAll.sheet.title.other", { n: ticked.length }) : t("approveAll.caution.title")}</h2>
    {preview.more > 0 && <p className="mt-1 text-[13px] text-ink-secondary">{t("approveAll.sheet.more")}</p>}
    <ul className="mt-3 space-y-2">
      {groups.map((group) => {
        const bot = botOf(group.botId || undefined);
        const name = botName(group.botId || undefined);
        return <li key={group.botId || "none"} className="flex items-start gap-3">
          <input type="checkbox" className="mt-2" aria-label={name} checked={!unticked.has(group.botId)} disabled={busy} onChange={() => toggle(group.botId)} />
          {bot && <BotAvatar bot={bot} size={28} />}
          <div className="min-w-0 text-[13px]">
            <div className="font-medium">{name} ({group.requestIds.length})</div>
            <ul data-testid="approve-all-cards" className="mt-1 space-y-1">
              {cards.filter((card) => (card.botId ?? "") === group.botId).map((card) => {
                const held = cardDetail(card).held;
                return <li key={`${card.threadId}:${card.requestId}`} data-request-id={card.requestId} data-digest={card.digest} className="break-words">
                  <span className="text-ink">{t("ux.l2b.door.wants", { bot: name, wants: card.wants ? lowerFirst(card.wants) : t(`ux.l2b.door.wantsKind.${["command", "edit", "app"].includes(card.kindLine) ? card.kindLine : "other"}` as LocaleKey) })}</span>
                  <span className="block text-[12px] text-ink-secondary">{kindWords(card.kindLine)}</span>
                  {held && <span data-testid="approve-all-held" className="block text-[12px] text-ink-secondary">{localizeOutsideNote(held)}</span>}
                </li>;
              })}
            </ul>
          </div>
        </li>;
      })}
    </ul>
    <p className="mt-4 text-[12px] text-ink-secondary">{t("approveAll.sheet.footer")}</p>
    <div className="mt-3 flex justify-end gap-2">
      <button type="button" className={`${button} bg-inset text-ink`} disabled={busy} onClick={onCancel}>{t("approveAll.sheet.cancel")}</button>
      {ticked.length > 0 && <button type="button" className={`${button} bg-accent text-accent-ink`} disabled={busy || !preview.batchId} onClick={() => onApprove(ticked, names)}>{t("approveAll.sheet.approve", { n: ticked.length })}</button>}
    </div>
  </div>;
}

/** Settings > Approvals: bring the caution back, on the surfaces that can press Approve all and only once it was hidden. */
export function ApproveAllReminderReset() {
  const [surface, setDismissed] = useApproveAllSurface();
  const [done, setDone] = useState(false);
  if (!surface.show || (!surface.cautionDismissed && !done)) return null;
  return <div className="mt-3 text-[13px]">
    {done ? <span role="status" className="text-ink-secondary">{t("approveAll.settings.done")}</span>
      : <button type="button" className={`${button} bg-inset text-ink`} onClick={() => void setDismissed(false).then(() => setDone(true), () => undefined)}>{t("approveAll.settings.reset")}</button>}
  </div>;
}
