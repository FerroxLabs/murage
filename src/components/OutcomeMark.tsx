// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The outcome mark in the chat (design section 16): two choices for a bot's
// reply, each one tap that records at once; then, on the same line and
// optional, a value and a reason, and Undo. And the card for an outcome the
// bot proposed: "Looks like this closed. Won?" with Won, Lost and Not yet.
// Nothing here is a dialog or a required step.
import { createContext, useContext, useState, type ReactNode } from "react";
import { CircleX, ThumbsDown, ThumbsUp, Trophy } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { ThreadOutcomes } from "@/lib/outcomes";
import { isSalesBot, outcomeChoices, type OutcomeKind, type OutcomeView } from "../../shared/outcome-choices";

const oKey = (name: string) => `outcome.${name}` as LocaleKey;
const markLabel = (kind: OutcomeKind) => t(oKey(`mark.${kind}`));
const wordOf = (kind: OutcomeKind) => t(oKey(`word.${kind}`));
const failedText = (error: unknown) => (error instanceof Error && error.message ? error.message : t(oKey("failed")));
const OutcomesContext = createContext<ThreadOutcomes | null>(null);
export function OutcomesProvider({ value, children }: { value: ThreadOutcomes; children: ReactNode }) {
  return <OutcomesContext.Provider value={value}>{children}</OutcomesContext.Provider>;
}
export const useOutcomes = (): ThreadOutcomes | null => useContext(OutcomesContext);

type BotLike = { name?: string; title?: string; description?: string };
const ICONS: Record<OutcomeKind, typeof Trophy> = { won: Trophy, lost: CircleX, good: ThumbsUp, bad: ThumbsDown };
const RAIL_BUTTON = "rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100";
const FIELD = "rounded-md border border-hairline/50 bg-transparent px-2 py-1 text-[13px] text-ink placeholder:text-ink-secondary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50";
const QUIET = "rounded-md px-1.5 py-0.5 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50";

/** Can this message be marked? A bot's own reply, not a status line. */
export const isMarkableReply = (message: { role: string; kind: string; text?: string; actorKind?: string; murage?: unknown }) =>
  message.role === "bot" && message.kind === "text" && Boolean(message.text?.trim()) && message.actorKind !== "murage" && !message.murage;

/** The two choices for the phone's message sheet (same predicate as the rail). */
export function outcomeSheetActions(
  outcomes: ThreadOutcomes | null,
  bot: BotLike,
  message: Parameters<typeof isMarkableReply>[0] & { id: string },
  /** In a room: the member who wrote the reply, whose mark it is. */
  botId?: string,
): Array<{ id: string; label: string; icon: ReactNode; onSelect: () => void }> {
  if (!outcomes || !isMarkableReply(message)) return [];
  return outcomeChoices(bot).map(choice => {
    const Icon = ICONS[choice.kind];
    return { id: `outcome-${choice.kind}`, label: markLabel(choice.kind), icon: <Icon size={18} />, onSelect: () => { outcomes.mark(message.id, choice.kind, botId).catch(() => undefined); } };
  });
}

/** The two choices as hover-rail buttons (desktop). Returns null when this message cannot be marked. */
export function OutcomeRailButtons({ bot, messageId, message, botId }: { bot: BotLike; messageId: string; message: Parameters<typeof isMarkableReply>[0]; botId?: string }) {
  const outcomes = useOutcomes();
  const [failed, setFailed] = useState<string | null>(null);
  if (!outcomes || !isMarkableReply(message)) return null;
  const current = outcomes.marks.get(messageId)?.kind;
  return (
    <>
      {outcomeChoices(bot).map(choice => {
        const Icon = ICONS[choice.kind];
        return (
          <button
            key={choice.kind}
            type="button"
            aria-label={markLabel(choice.kind)}
            aria-pressed={current === choice.kind}
            title={failed ?? markLabel(choice.kind)}
            onClick={() => { setFailed(null); outcomes.mark(messageId, choice.kind, botId).catch(error => setFailed(failedText(error))); }}
            className={cn(RAIL_BUTTON, current === choice.kind && "text-ink opacity-100")}
          >
            <Icon size={14} />
          </button>
        );
      })}
    </>
  );
}

/** The one line under a marked reply or an answered question: what was marked,
 * optional value and reason, and Undo. */
export function OutcomeStrip({ outcome }: { outcome: OutcomeView }) {
  const outcomes = useOutcomes();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(outcome.value === null ? "" : String(outcome.value));
  const [currency, setCurrency] = useState(outcome.currency ?? "USD");
  const [reason, setReason] = useState(outcome.reason ?? "");
  const [status, setStatus] = useState<string | null>(null);
  if (!outcomes || outcome.kind === "open") return null;
  const summary = [
    t(oKey(`marked.${outcome.kind}`)),
    outcome.value !== null ? `${outcome.value}${outcome.currency ? ` ${outcome.currency}` : ""}` : null,
    outcome.reason,
  ].filter(Boolean).join(" · ");
  const save = async () => {
    const number = value.trim() === "" ? null : Number(value);
    if (number !== null && (!Number.isFinite(number) || number < 0)) { setStatus(t(oKey("valueNumber"))); return; }
    if (number !== null && !/^[A-Za-z]{3}$/.test(currency.trim())) { setStatus(t(oKey("currencyCode"))); return; }
    setStatus(null);
    try {
      await outcomes.details(outcome, { reason: reason.trim(), value: number, currency: number === null ? null : currency.trim().toUpperCase() });
      setOpen(false);
    } catch (error) { setStatus(failedText(error)); }
  };
  return (
    <div role="status" className="mt-1 flex max-w-full flex-col gap-1 text-[12.5px] text-ink-secondary" data-testid="outcome-strip">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span>{summary}</span>
        {!open && <button type="button" className={QUIET} onClick={() => setOpen(true)}>{t(oKey("addDetails"))}</button>}
        <button type="button" className={QUIET} onClick={() => { outcomes.undo(outcome).catch(error => setStatus(failedText(error))); }}>{t(oKey("undo"))}</button>
      </div>
      {open && (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={event => { event.preventDefault(); void save(); }}
          onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}
        >
          <input aria-label={t(oKey("value"))} inputMode="decimal" className={cn(FIELD, "w-24")} placeholder={t(oKey("value"))} value={value} onChange={event => setValue(event.target.value)} autoFocus />
          <input aria-label={t(oKey("currency"))} className={cn(FIELD, "w-16 uppercase")} maxLength={3} value={currency} onChange={event => setCurrency(event.target.value)} />
          <input aria-label={t(oKey("reason"))} className={cn(FIELD, "min-w-40 flex-1")} placeholder={t(oKey("reasonHint"))} maxLength={280} value={reason} onChange={event => setReason(event.target.value)} />
          <button type="submit" className="rounded-full bg-accent px-3 py-1 text-[12.5px] font-medium text-white">{t(oKey("save"))}</button>
          <button type="button" className={QUIET} onClick={() => setOpen(false)}>{t(oKey("cancel"))}</button>
        </form>
      )}
      {status && <div className="text-danger">{status}</div>}
    </div>
  );
}

/** Under a bot reply: its mark, when it has one. */
export function MessageOutcome({ messageId }: { messageId: string }) {
  const outcome = useOutcomes()?.marks.get(messageId);
  return outcome ? <OutcomeStrip outcome={outcome} /> : null;
}

/** "Looks like this closed. Won?" The bot may only ask; the tap is the answer. */
export function ProposedOutcomeCard({ bot }: { bot: BotLike }) {
  const outcomes = useOutcomes();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [answered, setAnswered] = useState<OutcomeView | null>(null);
  const proposal = outcomes?.proposal;
  if (!outcomes) return null;
  if (answered && !proposal) return <div className="flex justify-start"><OutcomeStrip outcome={outcomes.marks.get(answered.messageId ?? "") ?? answered} /></div>;
  if (!proposal) return null;
  const [first, second] = outcomeChoices(bot);
  const sales = isSalesBot(bot);
  const answer = async (choice: OutcomeKind | "not-yet") => {
    setBusy(true); setStatus(null);
    try { const done = await outcomes.answer(proposal, choice); if (done) setAnswered(done); }
    catch (error) { setStatus(failedText(error)); }
    finally { setBusy(false); }
  };
  const button = "rounded-full border border-hairline/50 px-3 py-1 text-[13px] text-ink hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50";
  return (
    <div className="flex justify-start" data-testid="proposed-outcome">
      <div role="group" aria-label={t(oKey("proposal.label"))} className="flex max-w-[min(42rem,100%)] flex-col gap-1.5 rounded-2xl border border-hairline/40 bg-panel px-3.5 py-2.5">
        <div className="text-[14px] text-ink">{sales ? t(oKey("proposal.sales")) : t(oKey("proposal.other"))}</div>
        {proposal.note && <div className="text-[12.5px] text-ink-secondary">{proposal.note}</div>}
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" disabled={busy} className={button} onClick={() => void answer(first.kind)}>{wordOf(first.kind)}</button>
          <button type="button" disabled={busy} className={button} onClick={() => void answer(second.kind)}>{wordOf(second.kind)}</button>
          <button type="button" disabled={busy} className={cn(button, "border-transparent text-ink-secondary")} onClick={() => void answer("not-yet")}>{t(oKey("notYet"))}</button>
        </div>
        {status && <div role="alert" className="text-[12.5px] text-danger">{status}</div>}
      </div>
    </div>
  );
}
