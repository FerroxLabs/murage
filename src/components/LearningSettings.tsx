// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Learning (design section 16): one screen, one scroll, no dialog.
// The switch and the intro, This month, Tell it something, What it learned,
// Remembers, Suggestions, Results, and a More fold for the rest. It shows only
// what the harness stored; every change reads the lists again; nothing here
// interrupts the task. The words all come from t(), never from the harness.
import { useCallback, useEffect, useRef, useState } from "react";

import { api, useStore, type Bot } from "@/state/store";
import { screenText as s } from "@/lib/learning-screen";
import {
  CHANGES_SHOWN, MEMORIES_SHOWN, MEMORY_MAX, LESSON_MAX, activeCount, addLesson as addLessonRequest, answerFeedback, applySuggestion, canCheck, conflictLine, editLesson, editMemory, editSuggestion,
  canEditLesson, canWiden, fetchFeedback, fetchHistory, fetchLearning, fetchLessons, fetchMemoryStatus, fetchOutcomes, fetchSuggestions, forgetMemory, keepDeadline, keepLesson, lessonFrom, lessonRows, lessonSource, sharePicked,
  marksLine, memoryEntries, memoryIsOff, monthWithUndone, needMoreLine, notNowSuggestion, patchLearning, plainError, readLearningState, recentChanges, restoreOriginal, forgetLearningData,
  seeAllLabel, shownRows, startRun, suggestionEditMax, suggestionLine, suggestionWhy, undoEvent, undoLesson, unsureText, usageLine, widenLesson,
  type FeedbackRow, type LessonList, type LearningState, type LocalUndo, type MemoryEntry, type MemoryStatusView, type OutcomeCounts, type Suggestion, type Lesson, type SettingsPatch,
} from "@/lib/learning-screen";
import { fetchLearningCounts, monthLine, type LearningCountsAnswer } from "@/lib/learning-counts";
import { learningEventLabel, type LearningPage } from "@/lib/memory-learning";
import { Switch } from "./SettingsPrimitives";

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const ACTION = `min-h-11 rounded-lg px-3 text-[13px] text-ink hover:bg-raised disabled:opacity-50 ${FOCUS}`;
const PRIMARY = `min-h-11 rounded-lg bg-accent px-4 text-[13px] font-medium text-white disabled:opacity-50 ${FOCUS}`;
const FIELD = `min-h-11 min-w-0 flex-1 rounded-lg border border-hairline bg-app px-3 text-[13px] ${FOCUS}`;
const MUTED = "text-[12.5px] leading-snug text-ink-secondary";
const HEADING = `text-[14px] font-medium text-ink ${FOCUS}`;

export interface LearningData {
  state: LearningState | null;
  lessons: LessonList | null;
  suggestions: Suggestion[];
  feedback: FeedbackRow[];
  outcomes: OutcomeCounts | null;
  history: LearningPage | null;
  memory: MemoryStatusView | null;
  counts: LearningCountsAnswer | null;
  /** Lessons the owner just undid, each with how long Keep is on offer. */
  undone: Record<string, LocalUndo>;
  loading: boolean;
  loadFailed: boolean;
}
export const emptyLearningData: LearningData = { state: null, lessons: null, suggestions: [], feedback: [], outcomes: null, history: null, memory: null, counts: null, undone: {}, loading: true, loadFailed: false };

/** Every tap the screen offers. A handler reads the lists again before it resolves and throws when the harness refused. */
export interface LearningHandlers {
  setEnabled(on: boolean): Promise<void>;
  setAskFirst(on: boolean): Promise<void>;
  /** Turn customer learning on with the chosen chats in one change, or off. */
  setProspect(on: boolean, threadIds: string[]): Promise<void>;
  saveProspectChats(threadIds: string[]): Promise<void>;
  addLesson(text: string): Promise<{ duplicate: boolean }>;
  editLesson(lesson: Lesson, text: string): Promise<void>;
  undoLesson(lesson: Lesson): Promise<void>;
  /** "Use in every conversation": the kept note reaches every conversation this bot has. */
  widenLesson(lesson: Lesson): Promise<void>;
  keepLesson(lesson: Lesson): Promise<void>;
  applySuggestion(item: Suggestion, recipients?: string[]): Promise<void>;
  editSuggestion(item: Suggestion, text: string): Promise<void>;
  notNow(item: Suggestion): Promise<void>;
  answerFeedback(row: FeedbackRow, answer: "yes" | "no"): Promise<void>;
  editMemory(entry: MemoryEntry, text: string): Promise<void>;
  forgetMemory(entry: MemoryEntry): Promise<void>;
  undoEvent(eventId: string): Promise<void>;
  check(): Promise<void>;
  restore(): Promise<number>;
  forgetData(): Promise<void>;
  openMemory(): void;
  openMemorySettings(): void;
  /** The bot's Permissions section, where approvals live. */
  openPermissions(): void;
  retry(): void;
}

type Notice = { tone: "ok" | "error"; text: string } | null;
type Editing = { kind: "lesson" | "memory" | "suggestion"; id: string } | null;

export interface LearningViewProps {
  botName: string;
  data: LearningData;
  tasks: ReadonlyArray<{ threadId: string; title: string }>;
  handlers: LearningHandlers;
  /** For tests and previews. */
  now?: number;
  defaultMoreOpen?: boolean;
  defaultExpanded?: boolean;
  defaultPicking?: boolean;
  defaultConfirmRestore?: boolean;
}

export function LearningView({ botName, data, handlers, now: fixedNow, defaultMoreOpen = false, defaultExpanded = false, defaultConfirmRestore = false }: LearningViewProps) {
  const [clock, setClock] = useState(() => Date.now());
  const now = fixedNow ?? clock;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState("");
  const [tell, setTell] = useState("");
  const [tellNote, setTellNote] = useState<string | null>(null);
  /** Bots the owner switched off on a share suggestion, by suggestion id. */
  const [skipped, setSkipped] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [confirmRestore, setConfirmRestore] = useState(defaultConfirmRestore);
  const [confirmForget, setConfirmForget] = useState(false);
  const [focusNext, setFocusNext] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  const rows = lessonRows(data.lessons?.lessons ?? [], data.undone, now);
  // An undone lesson leaves when its Keep window ends.
  useEffect(() => {
    if (fixedNow !== undefined) return;
    const waits = rows.filter(row => row.undone && row.keepUntil !== null).map(row => row.keepUntil! - Date.now());
    if (!waits.length) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, Math.min(...waits)) + 50);
    return () => clearTimeout(timer);
  });
  useEffect(() => { if (editing) { field.current?.focus(); field.current?.select(); } }, [editing]);
  useEffect(() => {
    if (!focusNext) return;
    const find = (name: string) => root.current?.querySelector<HTMLElement>(`[data-learning-focus="${CSS.escape(name)}"]`);
    (find(focusNext) ?? find("heading:top"))?.focus();
    setFocusNext(null);
  }, [focusNext, data]);

  const run = async (work: () => Promise<unknown>, focusAfter: string, ok?: string, errorOf: (error: unknown) => string = plainError) => {
    setBusy(true); setNotice(null);
    try { await work(); if (ok) setNotice({ tone: "ok", text: ok }); setFocusNext(focusAfter); }
    catch (error) { setNotice({ tone: "error", text: errorOf(error) }); }
    finally { setBusy(false); }
  };

  const { state } = data;
  if (!state) {
    return (
      <div ref={root} data-testid="learning-settings" className="min-h-24 space-y-2">
        {data.loadFailed
          ? <><p role="status" className={MUTED}>{s("error.load")}</p><button type="button" className={ACTION} onClick={handlers.retry}>{s("retry")}</button></>
          : <p role="status" className={MUTED}>{s("loading")}</p>}
      </div>
    );
  }
  const { settings } = state;

  // ── What it learned ─────────────────────────────────────────────────
  const shown = shownRows(rows, expanded);
  const learnedCount = activeCount(rows);
  const nextSuggestion = (id: string) => data.suggestions.find(item => item.id !== id);
  const entries = memoryEntries(data.history?.events ?? []);
  const shownEntries = entries.slice(0, MEMORIES_SHOWN);
  const exactCount = data.history !== null && data.history.nextCursor === null;
  const changes = recentChanges(data.history?.events ?? [], learningEventLabel, CHANGES_SHOWN);
  const marks = data.outcomes ? marksLine(data.outcomes) : null;
  const needMore = data.outcomes ? needMoreLine(data.outcomes) : null;
  const usage = usageLine(data.memory);
  const month = data.counts ? monthWithUndone(monthLine(data.counts.counts), data.counts.counts.undone) : null;

  const editForm = (max: number, label: string, onSave: (text: string) => Promise<unknown>, focusAfter: string, saveLabel = s("save")) => (
    <form className="flex min-w-0 flex-1 basis-full flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); const text = draft.trim(); if (!text) return; void run(async () => { await onSave(text); setEditing(null); }, focusAfter); }}>
      <input ref={field} value={draft} maxLength={max} disabled={busy} aria-label={label} onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setEditing(null); setFocusNext(focusAfter); } }} className={FIELD} />
      <button type="submit" disabled={busy || !draft.trim()} className={ACTION}>{saveLabel}</button>
      <button type="button" disabled={busy} className={ACTION} onClick={() => { setEditing(null); setFocusNext(focusAfter); }}>{s("cancel")}</button>
    </form>
  );
  const startEdit = (kind: "lesson" | "memory" | "suggestion", id: string, text: string) => { setDraft(text); setEditing({ kind, id }); };
  const isEditing = (kind: string, id: string) => editing?.kind === kind && editing.id === id;

  return (
    <div ref={root} data-testid="learning-settings" className="min-w-0 space-y-6">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span id="learning-switch-label" data-learning-focus="heading:top" tabIndex={-1} className={`text-[15px] font-medium text-ink ${FOCUS}`}>{s("switch.label")}</span>
          <Switch checked={settings.enabled} disabled={busy} aria-labelledby="learning-switch-label" className={FOCUS} onClick={() => void run(() => handlers.setEnabled(!settings.enabled), "switch")} data-learning-focus="switch" />
        </div>
        <p className={MUTED}>{s("intro", { bot: botName })}</p>
        {month && <p className={MUTED}>{month}</p>}
        {notice && <p role="status" className={`text-[12.5px] ${notice.tone === "error" ? "text-danger" : "text-ink-secondary"}`}>{notice.text}</p>}
      </div>

      <section aria-labelledby="learning-tell" className="space-y-2">
        <h3 id="learning-tell" className={HEADING}>{s("tell.heading")}</h3>
        <form className="flex flex-wrap items-center gap-2" onSubmit={event => {
          event.preventDefault();
          const text = tell.trim();
          if (!text) return;
          setBusy(true); setTellNote(null);
          handlers.addLesson(text).then(
            ({ duplicate }) => { setTell(""); setNotice({ tone: "ok", text: duplicate ? s("tell.duplicate") : s("tell.added") }); setFocusNext("tell"); },
            error => setTellNote(plainError(error)),
          ).finally(() => setBusy(false));
        }}>
          <input value={tell} maxLength={LESSON_MAX} disabled={busy} placeholder={s("tell.placeholder")} aria-label={s("tell.label", { bot: botName })} data-learning-focus="tell"
            onChange={event => setTell(event.target.value)} className={FIELD} />
          <button type="submit" disabled={busy || !tell.trim()} className={PRIMARY}>{s("tell.add")}</button>
        </form>
        {tellNote && <p role="status" className="text-[12.5px] text-danger">{tellNote}</p>}
      </section>

      <section aria-labelledby="learning-learned" className="space-y-2">
        <h3 id="learning-learned" data-learning-focus="heading:learned" tabIndex={-1} className={HEADING}>{s("learned.heading", { count: learnedCount })}</h3>
        {rows.length === 0 && <p className={MUTED}>{s("learned.empty")}</p>}
        <ul className="divide-y divide-hairline/40">
          {shown.map(({ lesson, undone }) => (
            <li key={lesson.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2" data-learning-row={lesson.id}>
              {isEditing("lesson", lesson.id) ? editForm(LESSON_MAX, s("edit.lessonLabel"), text => handlers.editLesson(lesson, text), `edit:${lesson.id}`) : undone ? (
                <>
                  <p className="min-w-0 flex-1 basis-48 break-words text-[13.5px] text-ink-secondary">{s("undone")}</p>
                  <div className="flex flex-wrap gap-1"><button type="button" disabled={busy} data-learning-focus={`keep:${lesson.id}`} className={ACTION} onClick={() => void run(() => handlers.keepLesson(lesson), `edit:${lesson.id}`)}>{s("keep")}</button></div>
                </>
              ) : (
                <>
                  <div className="min-w-0 flex-1 basis-48"><p className="break-words text-[13.5px] text-ink">{lesson.text}</p><p className={MUTED}>{lessonSource(lesson, now)}</p>{conflictLine(lesson) && <p className={MUTED} data-learning-conflict={lesson.id}>{conflictLine(lesson)}</p>}</div>
                  <div className="flex flex-wrap gap-1">
                    {canEditLesson(lesson) && <button type="button" disabled={busy} data-learning-focus={`edit:${lesson.id}`} className={ACTION} onClick={() => startEdit("lesson", lesson.id, lesson.text)}>{s("edit")}</button>}
                    {canWiden(lesson) && <button type="button" disabled={busy} data-learning-focus={`widen:${lesson.id}`} className={ACTION} onClick={() => void run(() => handlers.widenLesson(lesson), `widen:${lesson.id}`)}>{s("widen")}</button>}
                    <button type="button" disabled={busy} className={ACTION} onClick={() => void run(() => handlers.undoLesson(lesson), `keep:${lesson.id}`)}>{s("undo")}</button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
        {rows.length > shown.length && <button type="button" className={ACTION} onClick={() => setExpanded(true)}>{s("learned.more", { count: rows.length - shown.length })}</button>}
        {expanded && rows.length > 5 && <button type="button" className={ACTION} onClick={() => setExpanded(false)}>{s("learned.less")}</button>}
        {data.feedback.length > 0 && (
          <div className="space-y-1">
            <h4 className={MUTED}>{s("unsure.heading", { count: data.feedback.length })}</h4>
            <ul className="space-y-1">
              {data.feedback.map((row, index) => {
                const after = data.feedback[index + 1] ?? data.feedback[index - 1];
                const focusAfter = after ? `yes:${after.id}` : "heading:learned";
                return (
                  <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <p className="min-w-0 flex-1 basis-48 break-words text-[13px] text-ink">{unsureText(row)}</p>
                    <div className="flex flex-wrap gap-1">
                      <button type="button" disabled={busy} data-learning-focus={`yes:${row.id}`} className={ACTION} onClick={() => void run(() => handlers.answerFeedback(row, "yes"), focusAfter)}>{s("yes")}</button>
                      <button type="button" disabled={busy} className={ACTION} onClick={() => void run(() => handlers.answerFeedback(row, "no"), focusAfter)}>{s("no")}</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <section aria-labelledby="learning-remembers" className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 id="learning-remembers" data-learning-focus="heading:remembers" tabIndex={-1} className={HEADING}>{exactCount ? s("remembers.headingCount", { count: entries.length }) : s("remembers.heading")}</h3>
          {memoryIsOff(data.memory)
            ? <span className={MUTED}>{s("memory.off")}</span>
            : data.memory && <span className={MUTED}>{s("memory.on")}</span>}
        </div>
        {memoryIsOff(data.memory) && <button type="button" className={ACTION} onClick={handlers.openMemorySettings}>{s("memory.open")}</button>}
        {shownEntries.length === 0 && !memoryIsOff(data.memory) && <p className={MUTED}>{s("remembers.empty")}</p>}
        <ul className="divide-y divide-hairline/40">
          {shownEntries.map((entry, index) => {
            const after = shownEntries[index + 1] ?? shownEntries[index - 1];
            return (
              <li key={entry.recordId} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2" data-learning-row={entry.recordId}>
                {isEditing("memory", entry.recordId) ? editForm(MEMORY_MAX, s("edit.memoryLabel"), text => handlers.editMemory(entry, text), `medit:${entry.recordId}`) : (
                  <>
                    <div className="min-w-0 flex-1 basis-48"><p className="break-words text-[13.5px] text-ink">{entry.text}</p><p className={MUTED}>{lessonFrom("feedback", entry.createdAt, now)}</p></div>
                    <div className="flex flex-wrap gap-1">
                      <button type="button" disabled={busy} data-learning-focus={`medit:${entry.recordId}`} className={ACTION} onClick={() => startEdit("memory", entry.recordId, entry.text)}>{s("edit")}</button>
                      <button type="button" disabled={busy} className={ACTION} onClick={() => void run(() => handlers.forgetMemory(entry), after ? `medit:${after.recordId}` : "heading:remembers")}>{s("forget")}</button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {entries.length > 0 && <button type="button" className={ACTION} onClick={handlers.openMemory}>{seeAllLabel(entries.length, data.history?.nextCursor ?? null)}</button>}
      </section>

      {data.suggestions.length > 0 && (
        <section aria-labelledby="learning-suggestions" className="space-y-2">
          <h3 id="learning-suggestions" data-learning-focus="heading:suggestions" tabIndex={-1} className={HEADING}>{s("suggestions.heading", { count: data.suggestions.length })}</h3>
          <p className={MUTED}>{s("waiting.intro", { bot: botName })}</p>
          <ul className="divide-y divide-hairline/40">
            {data.suggestions.map(item => {
              const after = nextSuggestion(item.id);
              const focusAfter = after ? `apply:${after.id}` : "heading:learned";
              return (
                <li key={item.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2" data-learning-row={item.id}>
                  {isEditing("suggestion", item.id) ? (
                    <>
                      <p className={`basis-full ${MUTED}`}>{s("edit.notChecked")}</p>
                      {editForm(suggestionEditMax(item), s("edit.suggestionLabel"), text => handlers.editSuggestion(item, text), `sedit:${item.id}`)}
                    </>
                  ) : (
                    <>
                      <div className="min-w-0 flex-1 basis-48"><p className="break-words text-[13.5px] text-ink">{suggestionLine(item)}</p><p className={MUTED}>{s("why.line", { reason: suggestionWhy(item) })}</p>{item.kind === "procedure" && item.edited && <p className={MUTED}>{s("edit.notChecked")}</p>}
                        {item.scope === "bots" && (
                          <fieldset className="mt-1 flex flex-wrap gap-x-3 gap-y-1"><legend className={MUTED}>{s("share.group")}</legend>
                            {(item.recipients ?? []).map(r => (
                              <label key={r.id} className="flex items-center gap-1 text-[12.5px] text-ink"><input type="checkbox" disabled={busy} checked={!(skipped[item.id] ?? []).includes(r.id)}
                                onChange={event => setSkipped(prev => ({ ...prev, [item.id]: event.target.checked ? (prev[item.id] ?? []).filter(id => id !== r.id) : [...(prev[item.id] ?? []), r.id] }))} />{s("share.recipient", { name: r.name })}</label>
                            ))}
                          </fieldset>
                        )}</div>
                      <div className="flex flex-wrap gap-1">
                        {item.kind === "lesson" && item.aboutApprovals ? (
                          <>
                            <p className={`basis-full ${MUTED}`}>{s("approvals.note", { bot: botName })}</p>
                            <button type="button" data-learning-focus={`apply:${item.id}`} className={ACTION} onClick={handlers.openPermissions}>{s("approvals.open")}</button>
                          </>
                        ) : <button type="button" data-learning-focus={`apply:${item.id}`} className={ACTION} disabled={busy || (item.scope === "bots" && sharePicked(item, skipped[item.id]).length === 0)} onClick={() => void run(() => handlers.applySuggestion(item, item.scope === "bots" ? sharePicked(item, skipped[item.id]) : undefined), focusAfter)}>{s("apply")}</button>}
                        {!(item.kind === "lesson" && (item.lessonKind === "style" || item.aboutApprovals)) && <button type="button" disabled={busy} data-learning-focus={`sedit:${item.id}`} className={ACTION} onClick={() => startEdit("suggestion", item.id, item.text)}>{s("edit")}</button>}
                        <button type="button" disabled={busy} className={ACTION} onClick={() => void run(() => handlers.notNow(item), focusAfter)}>{s("notNow")}</button>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {data.outcomes && (
        <section aria-labelledby="learning-results" className="space-y-2">
          <h3 id="learning-results" className={HEADING}>{s("results.heading")}</h3>
          {marks && <p className="text-[13px] text-ink">{marks}</p>}
          {needMore && <p className={MUTED}>{needMore}</p>}
          {canCheck(state) && <button type="button" disabled={busy} className={ACTION} onClick={() => void run(() => handlers.check(), "heading:top", undefined, error => plainError(error, s("error.save"), true))}>{s("results.check")}</button>}
        </section>
      )}

      <details open={defaultMoreOpen ? true : undefined} className="rounded-xl border border-hairline/50 px-3">
        <summary className={`min-h-11 cursor-pointer list-none py-3 text-[14px] font-medium text-ink ${FOCUS}`}>{s("more.summary")}</summary>
        <div className="space-y-5 pb-3">
          <div className="flex items-center justify-between gap-3">
            <span id="learning-ask-label" className="min-w-0 text-[13.5px] text-ink">{s("askFirst.label")}</span>
            <Switch checked={settings.askFirst} disabled={busy} aria-labelledby="learning-ask-label" className={FOCUS} onClick={() => void run(() => handlers.setAskFirst(!settings.askFirst), "askFirst")} data-learning-focus="askFirst" />
          </div>

          {/* Tier 1 does not use customer or audience messages yet, so the switch is not offered (T1-17).
              TODO(Tier 2): bring the switch and the chat picker back when lessons and results consume prospect text; handlers.setProspect and saveProspectChats stay for that. */}
          <div className="space-y-1">
            <p className="text-[13.5px] text-ink">{s("prospect.label")}</p>
            <p className={MUTED}>{s("prospect.later")}</p>
          </div>

          <div className="space-y-2">
            <h4 data-learning-focus="heading:recent" tabIndex={-1} className={`text-[13.5px] font-medium text-ink ${FOCUS}`}>{s("recent.heading")}</h4>
            <p className={MUTED}>{s("recent.note")}</p>
            {changes.length === 0 && <p className={MUTED}>{s("recent.empty")}</p>}
            <ul className="divide-y divide-hairline/40">
              {changes.map(change => (
                <li key={change.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-1.5">
                  <div className="min-w-0 flex-1 basis-48"><p className="text-[12.5px] text-ink-secondary">{change.undone ? s("undone") : change.label}</p>{change.text && <p className="break-words text-[13px] text-ink">{change.text}</p>}</div>
                  {change.canUndo && <button type="button" disabled={busy} className={ACTION} onClick={() => void run(() => handlers.undoEvent(change.id), "heading:recent")}>{s("undo")}</button>}
                </li>
              ))}
            </ul>
          </div>

          {usage && <p className={MUTED}>{usage}</p>}

          <div className="space-y-2">
            {!confirmRestore
              ? <button type="button" className={ACTION} data-learning-focus="restore" onClick={() => setConfirmRestore(true)}>{s("restore.button")}</button>
              : (
                <div role="group" aria-label={s("restore.button")} className="space-y-2">
                  <p className="text-[13px] text-ink">{s("restore.ask")}</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={busy} className={PRIMARY} onClick={() => void run(async () => { const count = await handlers.restore(); setConfirmRestore(false); setNotice({ tone: "ok", text: s("restore.done", { count }) }); }, "heading:top")}>{s("restore.yes")}</button>
                    <button type="button" disabled={busy} className={ACTION} onClick={() => { setConfirmRestore(false); setFocusNext("restore"); }}>{s("cancel")}</button>
                  </div>
                </div>
              )}
            <p className={MUTED}>{s("restore.note")}</p>
          </div>

          <div className="space-y-2">
            {!confirmForget
              ? <button type="button" className={ACTION} data-learning-focus="forgetData" onClick={() => setConfirmForget(true)}>{s("forgetData.button")}</button>
              : (
                <div role="group" aria-label={s("forgetData.button")} className="space-y-2">
                  <p className="text-[13px] text-ink">{s("forgetData.ask")}</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={busy} className={PRIMARY} onClick={() => void run(async () => { await handlers.forgetData(); setConfirmForget(false); setNotice({ tone: "ok", text: s("forgetData.done") }); }, "heading:top")}>{s("forgetData.yes")}</button>
                    <button type="button" disabled={busy} className={ACTION} onClick={() => { setConfirmForget(false); setFocusNext("forgetData"); }}>{s("cancel")}</button>
                  </div>
                </div>
              )}
            <p className={MUTED}>{s("forgetData.note")}</p>
          </div>
        </div>
      </details>
    </div>
  );
}

// ── the live screen ─────────────────────────────────────────────────────
export function LearningSettings({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [data, setData] = useState<LearningData>(emptyLearningData);
  const live = useRef(data);
  live.current = data;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const botId = bot.id;

  const load = useCallback(async () => {
    const [state, lessons, suggestions, feedback, outcomes, history, memory, counts] = await Promise.allSettled([
      fetchLearning(api, botId), fetchLessons(api, botId), fetchSuggestions(api, botId), fetchFeedback(api, botId), fetchOutcomes(api, botId),
      fetchHistory(api, botId), fetchMemoryStatus(api), fetchLearningCounts(api, botId),
    ]);
    if (!alive.current) return;
    const keep = <T,>(result: PromiseSettledResult<T>, old: T): T => (result.status === "fulfilled" ? result.value : old);
    setData(prev => ({
      ...prev,
      state: keep(state, prev.state), lessons: keep(lessons, prev.lessons), suggestions: keep(suggestions, prev.suggestions), feedback: keep(feedback, prev.feedback),
      outcomes: keep(outcomes, prev.outcomes), history: keep(history, prev.history), memory: keep(memory, prev.memory), counts: keep(counts, prev.counts),
      loading: false, loadFailed: state.status === "rejected" && prev.state === null,
    }));
  }, [botId]);
  useEffect(() => { void load(); }, [load]);

  const handlers: LearningHandlers = {
    async setEnabled(on) { await settingsChange({ enabled: on }); },
    async setAskFirst(on) { await settingsChange({ askFirst: on }); },
    async setProspect(on, threadIds) { await settingsChange(on ? { prospectLearning: true, prospectThreadIds: threadIds } : { prospectLearning: false }); },
    async saveProspectChats(threadIds) { await settingsChange({ prospectThreadIds: threadIds }); },
    async addLesson(text) {
      const answer = await addLessonRequest(api, botId, live.current.lessons?.revision ?? 0, text);
      await load();
      return { duplicate: answer?.duplicate === true };
    },
    async editLesson(lesson, text) { await editLesson(api, botId, lesson, text); await load(); },
    async undoLesson(lesson) {
      const answer = await undoLesson(api, botId, lesson);
      const until = keepDeadline(answer, Date.now());
      setData(prev => ({ ...prev, undone: { ...prev.undone, [lesson.id]: { lesson: { ...lesson, state: "undone" }, until } } }));
      await load();
    },
    async widenLesson(lesson) { await widenLesson(api, botId, lesson); await load(); },
    async keepLesson(lesson) {
      await keepLesson(api, lesson);
      setData(prev => { const { [lesson.id]: _gone, ...rest } = prev.undone; return { ...prev, undone: rest }; });
      await load();
    },
    async applySuggestion(item, recipients) { await applySuggestion(api, botId, item, recipients); await load(); },
    async editSuggestion(item, text) { await editSuggestion(api, botId, item, text); await load(); },
    async notNow(item) { await notNowSuggestion(api, botId, item); await load(); },
    async answerFeedback(row, answer) { await answerFeedback(api, botId, row, answer); await load(); },
    async editMemory(entry, text) { await editMemory(api, entry, text); await load(); },
    async forgetMemory(entry) { await forgetMemory(api, entry); await load(); },
    async undoEvent(eventId) { await undoEvent(api, eventId); await load(); },
    async check() { await startRun(api, botId); await load(); },
    async restore() { const count = await restoreOriginal(api, botId); setData(prev => ({ ...prev, undone: {} })); await load(); return count; },
    async forgetData() { await forgetLearningData(api, botId); setData(prev => ({ ...prev, undone: {} })); await load(); },
    openMemory() { window.dispatchEvent(new CustomEvent("murage:open-memory", { detail: { botId } })); },
    openMemorySettings() { dispatch({ type: "toggleAppSettings", open: true, section: "memory" }); },
    openPermissions() { dispatch({ type: "toggleSettings", open: true, intent: { section: "permissions" } }); },
    retry() { setData(prev => ({ ...prev, loading: true, loadFailed: false })); void load(); },
  };

  async function settingsChange(patch: SettingsPatch) {
    try {
      const next = await patchLearning(api, botId, live.current.state?.revision ?? 0, patch);
      setData(prev => ({ ...prev, state: next }));
    } catch (error) {
      // A conflict hands back the latest: show it, then let the owner try again.
      const latest = (error as { status?: number; body?: unknown })?.status === 409 ? (error as { body?: { settings?: unknown } }).body : null;
      if (latest?.settings) setData(prev => ({ ...prev, state: readLearningState(latest) }));
      throw error;
    }
    await load();
  }

  return <LearningView botName={bot.name} data={data} tasks={bot.tasks ?? []} handlers={handlers} />;
}
