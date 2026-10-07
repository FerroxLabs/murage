// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lessons a bot suggested, waiting for the owner's yes (design section 12:
// suggestions only; everything else about learning lives in the bot's
// Learning section). Nothing here interrupts: the rows sit in the list, each
// answer is one tap, and an edit happens in the row.
import { useRef, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { SUGGESTION_EDIT_MAX, answerSuggestion, editSuggestion, canEditSuggestion, suggestionNote, suggestionSentence, suggestionTitle, type LearningSuggestion } from "@/lib/inbox-learning-suggestions";

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const button = `min-h-11 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50 ${FOCUS}`;
const field = `min-h-11 w-full min-w-0 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink ${FOCUS}`;

export function InboxLearningSuggestions({ rows, onSettled, onOpenLearning }: { rows: readonly LearningSuggestion[]; onSettled: () => void; onOpenLearning?: (botId: string) => void }) {
  // Rows answered here leave at once; the refresh that follows confirms it.
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  // Rows edited here show their new words and version until the refresh brings the same.
  const [edited, setEdited] = useState<Readonly<Record<string, LearningSuggestion>>>({});
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = useRef(false);

  const run = async (work: () => Promise<{ ok: true } | { ok: false; message: string }>, done: () => void) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError(null);
    try {
      const result = await work();
      if (result.ok) { done(); onSettled(); } else setError(result.message);
    } finally { working.current = false; setBusy(false); }
  };
  const answer = (row: LearningSuggestion, verb: "apply" | "not-now") =>
    run(() => answerSuggestion(api, row, verb), () => { setGone(current => new Set([...current, row.lessonId])); setEditing(null); });
  const save = (row: LearningSuggestion, draft: string) => run(async () => {
    const result = await editSuggestion(api, row, draft);
    if (result.ok) setEdited(current => ({ ...current, [row.lessonId]: result.suggestion }));
    return result;
  }, () => setEditing(null));

  return <ul className="space-y-2" aria-label={t("inboxLearning.section")}>
    {rows.filter(row => !gone.has(row.lessonId)).map(base => {
      // A refresh that already carries a newer version wins over the local copy.
      const local = edited[base.lessonId];
      const row = local && local.version >= base.version ? local : base;
      const isEditing = editing?.id === row.lessonId;
      return <li key={row.lessonId} className="rounded-xl border border-hairline/50 bg-raised/30 p-4 text-[13px]">
        <p className="font-medium text-ink">{suggestionTitle(row)}</p>
        {isEditing
          ? <form className="mt-2" onSubmit={event => { event.preventDefault(); void save(row, editing.draft); }}>
              <label className="sr-only" htmlFor={`suggestion-${row.lessonId}`}>{t("inboxLearning.editLabel", { bot: row.botName })}</label>
              <input id={`suggestion-${row.lessonId}`} autoFocus className={field} maxLength={SUGGESTION_EDIT_MAX} value={editing.draft}
                onChange={event => setEditing({ id: row.lessonId, draft: event.target.value })}
                onKeyDown={event => { if (event.key === "Escape") setEditing(null); }} />
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="submit" className={button} disabled={busy || !editing.draft.trim()}>{t("inboxLearning.save")}</button>
                <button type="button" className={button} onClick={() => setEditing(null)}>{t("inboxLearning.cancel")}</button>
              </div>
            </form>
          : <>
              <p className="mt-1 text-ink-secondary">{suggestionSentence(row)}</p>
              {suggestionNote(row) && <p className="mt-1 text-ink-secondary">{suggestionNote(row)}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <button className={button} disabled={busy} onClick={() => void answer(row, "apply")}>{t("inboxLearning.apply")}</button>
                {canEditSuggestion(row) && <button className={button} disabled={busy} onClick={() => setEditing({ id: row.lessonId, draft: row.text })}>{t("inboxLearning.edit")}</button>}
                <button className={button} disabled={busy} onClick={() => void answer(row, "not-now")}>{t("inboxLearning.notNow")}</button>
                {onOpenLearning && <button className={button} onClick={() => onOpenLearning(row.botId)}>{t("inboxLearning.open")}</button>}
              </div>
            </>}
      </li>;
    })}
    {error && <li role="alert" className="text-[13px] text-danger">{error}</li>}
  </ul>;
}
