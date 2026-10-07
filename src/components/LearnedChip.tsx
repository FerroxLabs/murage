// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Ember will do this differently: lead with the decision." One muted chip
// under a bot's reply for something the harness really stored: a lesson, a
// memory entry, a praised or won example (design section 12a and 16). One
// chip per reply; several things merge into one headline. A tap opens the
// details in place: the words, and Edit, Undo or Forget, Not quite. It is not
// a dialog and it asks nothing: the task goes on under it.
//
// The wording comes from the shipped templates (shared/learned-chip.ts), never
// from a model. After Undo the chip says "Undone" with Keep for 30 seconds,
// then it is gone, because nothing is stored any more.
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { LearnedChipHandlers, ThreadChips } from "@/lib/learned-chips";
import { KEEP_WINDOW_MS, buildChip, chipClause, keepAvailable, templateKey, type ChipItem, type ChipModel } from "../../shared/learned-chip";

const key = (name: string) => `learnedChip.${name}` as LocaleKey;
const LESSON_MAX = 280;

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const CHIP = `inline-flex min-h-8 max-w-full items-center rounded-full border border-hairline/60 bg-raised/50 px-3 py-1 text-left text-[12.5px] leading-snug text-ink-secondary hover:bg-raised ${FOCUS}`;
const ACTION = `min-h-11 rounded-lg px-3 text-[13px] text-ink hover:bg-raised disabled:opacity-50 ${FOCUS}`;

/** The words on the chip itself. */
export function chipHeadline(model: ChipModel, botName: string): string {
  if (model.only) {
    const item = model.only;
    if (item.state === "undone") return t(key("undone"));
    if (item.state === "suggested") return t(key("suggested"), { text: chipClause(item.text).replace(/[.!?\u2026]+$/u, "") });
    return t(templateKey(item.group, item.template) as LocaleKey, { bot: botName, text: chipClause(item.text) });
  }
  const { remembered, learned } = model.counts;
  const phrase = (count: number) => count === 1 ? t(key("count.one")) : t(key("count.many"), { count });
  if (remembered && learned) return t(key("merge.both"), { bot: botName, remembered: phrase(remembered), learned: phrase(learned) });
  return remembered ? t(key("merge.remembered"), { bot: botName, remembered: phrase(remembered) }) : t(key("merge.learned"), { bot: botName, learned: phrase(learned) });
}

export type SheetAction = "edit" | "undo" | "forget" | "notQuite" | "notExample" | "keep" | "keepIt";
/** What the tap sheet offers for one item, in the order shown. */
export function sheetActions(item: ChipItem, now: number): SheetAction[] {
  if (item.state === "undone") return item.actions.restorable && keepAvailable(item, now) ? ["keep"] : [];
  // A waiting suggestion offers one quiet tap and nothing else; ignoring it costs nothing.
  if (item.state === "suggested") return item.actions.keepIt ? ["keepIt"] : [];
  const out: SheetAction[] = [];
  if (item.actions.edit) out.push("edit");
  if (item.actions.undo) out.push("undo");
  if (item.actions.forget) out.push("forget");
  if (item.actions.notQuite) out.push("notQuite");
  if (item.actions.notExample) out.push("notExample");
  return out;
}

const LABEL: Record<SheetAction, string> = { edit: "edit", undo: "undo", forget: "forget", notQuite: "notQuite", notExample: "notExample", keep: "keep", keepIt: "keepIt" };

export interface LearnedChipProps {
  botName: string;
  items: readonly ChipItem[];
  handlers: LearnedChipHandlers;
  /** Called after any change so the list can be read again. */
  onChanged?: () => void;
  /** Start with the details showing (tests and previews). */
  defaultOpen?: boolean;
  /** For tests and previews. */
  now?: number;
}

/** A waiting suggestion: one quiet line with one tap. No sheet, no dialog, no dismiss button; it fades from here on its own. Each
 * suggestion stands alone, so it keeps its tap even when something else was learned under the same reply. */
function SuggestionLine({ botName, item, handlers, onChanged }: { botName: string; item: ChipItem; handlers: LearnedChipHandlers; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /** What a kept suggestion now does, shown for a few seconds in place of the line. */
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openAccess = useContext(AccessLinkContext);
  useEffect(() => () => { if (reloadTimer.current) clearTimeout(reloadTimer.current); }, []);
  if (confirmed) return <p role="status" className="mt-1.5 text-[12.5px] text-ink-secondary" data-testid="learned-chip-confirmed">{confirmed}</p>;
  // Approvals follow the Access settings; no lesson can change them, so there is nothing to keep.
  if (item.aboutApprovals) return (
    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1" data-testid="learned-chip-suggestion">
      <span className="min-w-0 break-words text-[12.5px] leading-snug text-ink-secondary">{t(key("approvalsNote"), { bot: botName })}</span>
      {openAccess && <button type="button" data-learned-focus="open-access" className={ACTION} onClick={openAccess}>{t(key("openAccess"))}</button>}
    </div>
  );
  const keep = () => {
    setBusy(true); setFailed(false);
    handlers.keepSuggestion(item).then(() => {
      setConfirmed(t(key(item.keepScope === "thread" ? "keptHere" : item.keepScope === "customers" ? "keptCustomers" : item.keepScope === "everywhere" ? "keptEverywhere" : "keptChats"), { bot: botName }));
      // The list is read again after the confirmation has been seen, not before.
      reloadTimer.current = setTimeout(() => onChanged?.(), 4000);
    }, () => setFailed(true)).finally(() => setBusy(false));
  };
  return (
    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1" data-testid="learned-chip-suggestion">
      <span className="min-w-0 break-words text-[12.5px] leading-snug text-ink-secondary">{t(key("suggested"), { text: chipClause(item.text).replace(/[.!?\u2026]+$/u, "") })}</span>
      <button type="button" data-learned-focus={`keep-it:${item.eventId}`} disabled={busy} className={ACTION} onClick={keep}>{t(key("keepIt"))}</button>
      {failed && <span role="status" className="text-[12px] text-ink-secondary">{t(key("failed"))}</span>}
    </div>
  );
}

export function LearnedChip(props: LearnedChipProps) {
  const waiting = props.items.filter(item => item.state === "suggested" && Boolean(item.eventId));
  const rest = props.items.filter(item => item.state !== "suggested");
  return (
    <>
      {rest.length > 0 && <LearnedChipBody {...props} items={rest} />}
      {waiting.map(item => <SuggestionLine key={item.eventId} botName={props.botName} item={item} handlers={props.handlers} onChanged={props.onChanged} />)}
    </>
  );
}

function LearnedChipBody({ botName, items, handlers, onChanged, defaultOpen = false, now: fixedNow }: LearnedChipProps) {
  const [clock, setClock] = useState(() => Date.now());
  const now = fixedNow ?? clock;
  const [open, setOpen] = useState(defaultOpen);
  const [editing, setEditing] = useState<{ eventId: string; selectAll: boolean } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [focusNext, setFocusNext] = useState<string | null>(null);
  const chipButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const sheetId = useId();

  // An undone item leaves when its Keep window ends.
  useEffect(() => {
    if (fixedNow !== undefined) return;
    const undone = items.filter(item => item.state === "undone" && typeof item.undoneAt === "number").map(item => item.undoneAt! + KEEP_WINDOW_MS - Date.now());
    if (!undone.length) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, Math.min(...undone)) + 50);
    return () => clearTimeout(timer);
  }, [items, clock, fixedNow]);
  useEffect(() => { if (editing) { input.current?.focus(); if (editing.selectAll) input.current?.select(); } }, [editing]);
  useEffect(() => {
    if (!focusNext) return;
    const found = document.querySelector<HTMLElement>(`[data-learned-focus="${CSS.escape(focusNext)}"]`);
    // The thing to focus may arrive with the next list; wait for it unless it is gone for good.
    const pending = !found && focusNext !== "chip" && items.some(item => focusNext.endsWith(item.eventId));
    if (pending) return;
    (found ?? chipButton.current)?.focus();
    setFocusNext(null);
  }, [focusNext, items]);

  const model = buildChip(items, now);
  // The honesty rule, once more at the door: no stored event, no chip.
  if (!model) return null;

  const run = async (work: () => Promise<void>, focusAfter: string | null) => {
    setBusy(true); setFailed(false);
    try { await work(); onChanged?.(); setFocusNext(focusAfter ?? "chip"); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  const act = (item: ChipItem, action: SheetAction) => {
    if (action === "edit" || action === "notQuite") { setDraft(item.text); setEditing({ eventId: item.eventId, selectAll: action === "notQuite" }); return; }
    if (action === "keep") return void run(() => handlers.keep(item), "chip");
    return void run(() => handlers.undo(item), item.actions.restorable ? `keep:${item.eventId}` : "chip");
  };
  const save = (item: ChipItem) => {
    const text = draft.trim();
    if (!text || text === item.text) { setEditing(null); setFocusNext(`edit:${item.eventId}`); return; }
    void run(async () => { await handlers.edit(item, text); setEditing(null); }, "chip");
  };
  const closeSheet = () => { setOpen(false); setEditing(null); setFocusNext("chip"); };

  return (
    <div className="mt-1.5 min-w-0" data-testid="learned-chip" onKeyDown={event => { if (event.key === "Escape" && open) { event.stopPropagation(); closeSheet(); } }}>
      <button
        ref={chipButton} type="button" data-learned-focus="chip" className={CHIP}
        aria-expanded={open} aria-controls={sheetId} aria-label={t(key("chipLabel"), { bot: botName })}
        onClick={() => setOpen(value => !value)}
      >
        <span className="min-w-0 break-words">{chipHeadline(model, botName)}</span>
      </button>
      {open && (
        <div id={sheetId} role="group" aria-label={t(key("sheetLabel"), { bot: botName })} className="mt-1 max-w-xl space-y-2 rounded-lg border border-hairline/50 bg-app px-3 py-2 text-[13px]">
          <ul className="space-y-2">
            {model.items.map(item => (
              <li key={item.eventId} className="space-y-1">
                {editing?.eventId === item.eventId ? (
                  <form className="flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); save(item); }}>
                    <input
                      ref={input} value={draft} maxLength={item.kind === "remembered" ? 1000 : LESSON_MAX} disabled={busy} aria-label={t(key("editLabel"), { bot: botName })}
                      onChange={event => setDraft(event.target.value)}
                      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setEditing(null); setFocusNext(`edit:${item.eventId}`); } }}
                      className={`min-h-11 min-w-0 flex-1 rounded-lg border border-hairline bg-app px-3 text-[13px] ${FOCUS}`}
                    />
                    <button type="submit" disabled={busy || !draft.trim()} className={ACTION}>{t(key("save"))}</button>
                    <button type="button" disabled={busy} className={ACTION} onClick={() => { setEditing(null); setFocusNext(`edit:${item.eventId}`); }}>{t(key("cancel"))}</button>
                  </form>
                ) : (
                  <>
                    <p className="whitespace-pre-wrap break-words text-ink">{item.state === "undone" ? t(key("undone")) : item.text}</p>
                    {item.state === "active" && item.kind !== "kept" && <p className="text-[12px] text-ink-secondary">{t(key(item.kind === "improved" ? "improvedNote" : "fromChat"))}</p>}
                    <div className="flex flex-wrap gap-1">
                      {sheetActions(item, now).map(action => (
                        <button
                          key={action} type="button" disabled={busy} className={ACTION}
                          data-learned-focus={action === "keep" ? `keep:${item.eventId}` : action === "edit" || action === "notQuite" ? `edit:${item.eventId}` : undefined}
                          onClick={() => act(item, action)}
                        >{t(key(LABEL[action]))}</button>
                      ))}
                    </div>
                    {item.first && item.state === "active" && <p className="text-[12px] text-ink-secondary">{t(key("firstHint"))}</p>}
                    {item.state === "active" && item.actions.undo && <p className="text-[12px] text-ink-secondary">{t(key("undoNote"))}</p>}
                  </>
                )}
              </li>
            ))}
          </ul>
          {failed && <p role="status" className="text-[12px] text-ink-secondary">{t(key("failed"))}</p>}
        </div>
      )}
    </div>
  );
}

const ChipsContext = createContext<ThreadChips | null>(null);
/** Opens the bot's Permissions section (where approvals live). Absent in a room, where the chip only says where approvals are. */
const AccessLinkContext = createContext<(() => void) | null>(null);
export function AccessLinkProvider({ open, children }: { open: (() => void) | null; children: ReactNode }) {
  return <AccessLinkContext.Provider value={open}>{children}</AccessLinkContext.Provider>;
}
export function ChipsProvider({ value, children }: { value: ThreadChips; children: ReactNode }) {
  return <ChipsContext.Provider value={value}>{children}</ChipsContext.Provider>;
}

/** The chip under one bot reply, from the conversation's stored events. Renders nothing when none was stored. */
export function MessageChip({ messageId, botName }: { messageId: string; botName: string }) {
  const chips = useContext(ChipsContext);
  const items = chips?.byReply.get(messageId);
  if (!chips || !items?.length) return null;
  return <LearnedChip botName={botName} items={items} handlers={chips.handlers} onChanged={chips.reload} />;
}
