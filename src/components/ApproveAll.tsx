// SPDX-License-Identifier: AGPL-3.0-or-later
// Approve all on Needs you and Approvals (APPROVE-ALL-1016 rev 3; APPROVALS-SIMPLE-1018 sections 3 and 3b). The button
// shows only where the server's owner-app check says so (the desktop app or the owner's phone app, never a browser),
// and only when 2 or more rows ON SCREEN carry the server's `bulk: "ok"` stamp; its label is that count.
//
// Desktop: no sheet. The rows above the button are the list. A press reads the preview and applies exactly the
// displayed ok rows the preview also lists; if they differ nothing is applied ("The list changed."). Phone: the sheet
// stays (the device proof signs the exact list), each line the bot's own words plus the grey kind, never a command.
//
// 3b: anything open (the caution, the sheet, a note) belongs to the list it was opened over. When the displayed request
// rows change (Refresh, the 5 s beat bringing a different list, a row answered here or elsewhere, a tab change) it
// closes, and a preview still loading is dropped. An apply in flight keeps its lock; its result line stays only while
// the list just loses rows it was pressed over. Nothing here decides eligibility.
import { useEffect, useRef, useState } from "react";
import { api, useStoreIfAny } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { BotAvatar } from "./Avatar";
import { applyApproveAll, batchReason, boundToScreen, cardDetail, groupByBot, listToken, previewBody, previewGate, resultLine, resultSurvives, tickedCards, type ApplyResult, type ApproveAllPreview, type ApproveAllSurface, type EligibleCard, type PreviewScreen } from "@/lib/approve-all";
import { lowerFirst } from "@/lib/approval-row";
import { localizeOutsideNote } from "@/lib/outside-note";

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

type Step =
  | { at: "idle" }
  | { at: "caution" }
  | { at: "saving"; n: number }
  | { at: "previewing"; n: number }
  | { at: "applying"; n: number }
  | { at: "sheet"; preview: ApproveAllPreview; cards: EligibleCard[]; press: PressSnapshot }
  | { at: "note"; line: string }
  | { at: "result"; line: string; pressed: readonly string[] };

/** Section 3b: what a list change does to the open step. An apply in flight (already sent) is never torn down; a
 *  result line stays only while the list just loses rows it was pressed over (`resultSurvives`), and never over a
 *  Refresh; anything else (a preview still loading, the caution, the phone sheet, a note) closes (Astra r2 High: a
 *  loading preview used to count as "applying" and survived a Refresh). */
export function stepAfterListChange(step: { at: string; pressed?: readonly string[] }, nextKeys: readonly string[], manual: boolean): "keep" | "close" {
  if (step.at === "idle" || step.at === "applying") return "keep";
  if (step.at === "result" && !manual && step.pressed && resultSurvives(step.pressed, nextKeys)) return "keep";
  return "close";
}

/** The kind under a line on the phone sheet, the same words as a row's grey line. */
const kindWords = (kind: string) => t(`ux.l2b.door.kind.${["command", "edit", "app"].includes(kind) ? kind : "other"}` as LocaleKey);

export function ApproveAllButton({ ready, listed, screen, refreshes, onApplied, onChanged }: {
  /** the rows on screen the server stamped ok, as `threadId\0messageId`: the count, and exactly what a press answers */
  ready: readonly string[];
  /** every request row on screen, the same keys: its set is the list's generation token (3b) */
  listed: readonly string[];
  /** the Inbox query those rows came from: the preview reads the same page (RESIDUALS-1018-B row 6) */
  screen?: PreviewScreen;
  /** the page's Refresh presses: each closes anything open and reads the surface again */
  refreshes: number;
  onApplied: () => void;
  /** the list moved under a press: read it again */
  onChanged: () => void;
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
  const live = useRef({ token, gen, ready, listed, screen, mounted: true });
  live.current = { token, gen, ready, listed, screen, mounted: live.current.mounted };
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

  const n = ready.length;
  if (!surface.show) return null;
  // Never "Approve 0" or "Approve all 1": under 2 there is no button and nothing to open.
  if (n < 2 && (step.at === "idle" || step.at === "caution")) return null;

  const closeWith = (line: string) => { setStep({ at: "note", line }); onChanged(); };
  /** Apply the bound cards. Every post (and the phone's one signed retry) first checks the list has not moved. */
  const apply = async (preview: ApproveAllPreview, cards: EligibleCard[], press: PressSnapshot, names: string[]) => {
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
      onApplied();
      if (!live.current.mounted) return;
      // The result line shows only over the list it was pressed over: not after a Refresh, and not once a row the
      // press never saw arrived (Astra r2 High). Otherwise the list simply re-reads, with nothing stale on it.
      const sameGen = live.current.gen.split("|")[0] === press.gen.split("|")[0] && resultSurvives(pressed, live.current.listed);
      if (!sameGen) { setStep({ at: "idle" }); return; }
      const threadBot = new Map(preview.eligible.map((card) => [card.threadId, card.botId]));
      setStep({ at: "result", line: resultLine(done.results, (threadId) => botName(threadBot.get(threadId))), pressed });
    } catch (e) {
      if (!live.current.mounted) return;
      const code = (e as { code?: string })?.code;
      if (code === "changed") { closeWith(t("approveAll.changed")); return; }
      const message = e instanceof Error ? e.message : String(e);
      if (message && code !== "cancelled") setError(message);
      setStep({ at: "idle" });
    } finally {
      gate.done();
    }
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
    const names = [...new Set(bound.cards.map((card) => botName(card.botId)))];
    await apply(preview, bound.cards, press, names);
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
    if (surface.cautionDismissed) void run(pressSnapshot(live.current, id));
    else setStep({ at: "caution" });
  };
  const cancel = () => { act(); setError(null); setStep({ at: "idle" }); };

  return <div className="mt-3">
    {/* "The list changed" is never a dead end (Astra): the note keeps an enabled Approve all */}
    {(step.at === "idle" || step.at === "note") && n >= 2 && <button type="button" data-approve-all className={`${button} bg-accent text-accent-ink`} onClick={press}>{t("approveAll.button", { n })}</button>}
    {(step.at === "applying" || step.at === "previewing" || step.at === "saving") && <button type="button" data-approve-all className={`${button} bg-accent text-accent-ink`} disabled aria-busy="true">{t("approveAll.busy", { n: step.n })}</button>}
    {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
    {step.at === "caution" && <Caution onReview={cancel} onContinue={(dontShow) => void gotIt(dontShow)} />}
    {step.at === "sheet" && <ApproveAllSheet preview={step.preview} cards={step.cards} botName={botName} botOf={botOf} busy={gate.signing} onCancel={cancel} onApprove={(cards, names) => {
      // the phone checks the press's snapshot before it signs, and the post wrapper checks it again before the retry
      if (!stillPressed(step.press, live.current)) { closeWith(t("approveAll.changed")); return; }
      void apply(step.preview, cards, step.press, names);
    }} />}
    {(step.at === "result" || step.at === "note") && <p role="status" data-approve-all-line className="mt-1 text-[13px] text-ink">{step.line}</p>}
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
