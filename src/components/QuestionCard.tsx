// One question card for every engine (0.1.52 ASK2).
//
// "Don't make me think": the header chip says what the question is about,
// each option carries its own description, a radio means pick one and a
// checkbox means pick any, and "Other" is always right there to type into.
// The keyboard does all of it: 1-9 picks in the focused question, Tab moves
// to the next question, Enter sends, Esc asks before skipping.
//
// A question never silently disappears. Answered and skipped cards stay as a
// read-only record; an expired one (the bot stopped waiting) keeps its
// inputs and offers "Send as a message", so a late answer still arrives.
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Check, Clock, CornerDownLeft, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Message, type OptionCardData } from "@/state/store";
import {
  answerComplete,
  answersAsMessage,
  questionsForCard,
  type QuestionAnswer,
  type QuestionSpec,
} from "../../shared/questions";

export type QuestionCardState = "open" | "answered" | "skipped" | "expired" | "sent" | "closed";

/** Where a question card stands, from the persisted card alone. */
export function questionCardState(card: OptionCardData): QuestionCardState {
  if (card.sentAsMessage) return "sent";
  if (card.expired || card.answered === "expired") return "expired";
  if (!card.answered) return "open";
  if (card.answered === "skipped" || card.answered === "deny") return "skipped";
  if (card.answered === "unavailable") return "closed";
  return "answered";
}

export interface Draft {
  selected: string[];
  other: string;
}
export type Drafts = Record<string, Draft>;

const emptyDraft: Draft = { selected: [], other: "" };

/** Seed the inputs: an answered card shows what was chosen. */
export function initialDrafts(questions: readonly QuestionSpec[], answers: readonly QuestionAnswer[] | undefined): Drafts {
  const drafts: Drafts = {};
  for (const question of questions) {
    const answer = answers?.find((candidate) => candidate.id === question.id);
    drafts[question.id] = { selected: [...(answer?.selected ?? [])], other: answer?.other ?? "" };
  }
  return drafts;
}

/** Pick (or unpick) one option. Single-select replaces the pick and clears
 * the free text; multi-select toggles. */
export function toggleOption(drafts: Drafts, question: QuestionSpec, label: string): Drafts {
  const draft = drafts[question.id] ?? emptyDraft;
  if (!question.multiSelect) return { ...drafts, [question.id]: { selected: [label], other: "" } };
  const selected = draft.selected.includes(label)
    ? draft.selected.filter((candidate) => candidate !== label)
    : [...draft.selected, label];
  return { ...drafts, [question.id]: { ...draft, selected } };
}

/** Typing in "Other" selects it; for a single-select question that replaces
 * any option that was picked. */
export function setOther(drafts: Drafts, question: QuestionSpec, text: string): Drafts {
  const draft = drafts[question.id] ?? emptyDraft;
  const selected = !question.multiSelect && text.trim() ? [] : draft.selected;
  return { ...drafts, [question.id]: { selected, other: text } };
}

export function draftAnswers(questions: readonly QuestionSpec[], drafts: Drafts): QuestionAnswer[] {
  return questions.map((question) => {
    const draft = drafts[question.id] ?? emptyDraft;
    const other = question.allowOther ? draft.other.trim() : "";
    return { id: question.id, selected: [...draft.selected], ...(other ? { other } : {}) };
  });
}

export function draftsComplete(questions: readonly QuestionSpec[], drafts: Drafts): boolean {
  const answers = draftAnswers(questions, drafts);
  return questions.every((question, index) => answerComplete(question, answers[index]));
}

export type QuestionKeyAction = { type: "toggle"; index: number } | { type: "submit" } | { type: "skip" } | null;

/** What a key means inside one question. Digits pick options (never while
 * typing in "Other"); Enter sends; Esc starts a skip. */
export function questionKeyAction(key: string, optionCount: number, inTextField: boolean): QuestionKeyAction {
  if (key === "Escape") return { type: "skip" };
  if (key === "Enter") return { type: "submit" };
  if (inTextField) return null;
  if (/^[1-9]$/.test(key)) {
    const index = Number(key) - 1;
    return index < optionCount ? { type: "toggle", index } : null;
  }
  return null;
}

export interface QuestionCardViewProps {
  card: OptionCardData;
  /** who is asking, for the "Name asks" line */
  botName?: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (answers: QuestionAnswer[]) => void;
  onSkip: () => void;
  onSendAsMessage: (answers: QuestionAnswer[], text: string) => void;
}

export function QuestionCardView({ card, botName, busy = false, error, onSubmit, onSkip, onSendAsMessage }: QuestionCardViewProps) {
  const questions = questionsForCard(card);
  const state = questionCardState(card);
  const [drafts, setDrafts] = useState<Drafts>(() => initialDrafts(questions, card.answers));
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const baseId = useId();
  const editable = (state === "open" || state === "expired") && !busy;
  const complete = draftsComplete(questions, drafts);
  const secret = questions.some((question) => question.secret);
  const name = botName ?? t("questions.yourBot");

  const submit = () => {
    if (!editable || !complete) return;
    const answers = draftAnswers(questions, drafts);
    if (state === "expired") {
      if (!secret) onSendAsMessage(answers, answersAsMessage(questions, answers));
    } else onSubmit(answers);
  };

  const onQuestionKey = (event: KeyboardEvent<HTMLElement>, question: QuestionSpec) => {
    const inTextField = event.target instanceof HTMLInputElement;
    const action = questionKeyAction(event.key, question.options.length, inTextField);
    if (!action) return;
    if (action.type === "skip") {
      if (state !== "open") return;
      event.preventDefault();
      setConfirmingSkip(true);
      return;
    }
    if (action.type === "submit") {
      event.preventDefault();
      submit();
      return;
    }
    if (!editable) return;
    event.preventDefault();
    setDrafts((current) => toggleOption(current, question, question.options[action.index]!.label));
  };

  return (
    <section
      aria-label={t("questions.cardLabel", { name })}
      data-question-state={state}
      className={cn(
        "w-full max-w-[840px] rounded-2xl border bg-card p-4",
        state === "open" ? "border-accent/40" : state === "expired" ? "border-warning/40" : "border-hairline/30",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink-secondary">{t("questions.asks", { name })}</span>
          {state === "expired" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning">
              <Clock size={11} aria-hidden /> {t("questions.expired")}
            </span>
          )}
        </div>
        {state === "open" && !confirmingSkip && (
          <button
            type="button"
            aria-label={t("questions.skip")}
            title={t("questions.skip")}
            onClick={() => setConfirmingSkip(true)}
            disabled={busy}
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div className="mt-2 flex flex-col gap-4">
        {questions.map((question, questionIndex) => {
          const draft = drafts[question.id] ?? emptyDraft;
          const labelId = `${baseId}-q${questionIndex}`;
          const otherOn = draft.other.trim() !== "";
          return (
            <div
              key={question.id}
              role={question.multiSelect ? "group" : "radiogroup"}
              aria-labelledby={labelId}
              tabIndex={editable ? 0 : -1}
              onKeyDown={(event) => onQuestionKey(event, question)}
              className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              {question.header && (
                <span className="mb-1.5 inline-block rounded-full border border-hairline/50 bg-control px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                  {question.header}
                </span>
              )}
              <p id={labelId} className="text-[15.5px] font-semibold leading-snug text-ink">
                {question.question}
              </p>
              <p className="mt-0.5 text-[12px] text-ink-secondary">
                {question.multiSelect ? t("questions.chooseAny") : t("questions.chooseOne")}
              </p>
              <div className="mt-2 overflow-hidden rounded-lg border border-hairline/40">
                {question.options.map((option, optionIndex) => {
                  const checked = draft.selected.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      role={question.multiSelect ? "checkbox" : "radio"}
                      aria-checked={checked}
                      tabIndex={-1}
                      disabled={!editable}
                      onClick={() => setDrafts((current) => toggleOption(current, question, option.label))}
                      className={cn(
                        "flex w-full items-start gap-3 px-3 py-2.5 text-left",
                        optionIndex > 0 && "border-t border-hairline/40",
                        checked ? "bg-raised-hover" : "hover:bg-raised-hover/60 disabled:hover:bg-transparent",
                        !editable && !checked && "opacity-60",
                      )}
                    >
                      <Indicator multi={question.multiSelect} checked={checked} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14.5px] text-ink">{option.label}</span>
                        {option.description && (
                          <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-secondary">{option.description}</span>
                        )}
                      </span>
                      {optionIndex < 9 && editable && (
                        <kbd className="mt-0.5 shrink-0 rounded border border-hairline/50 bg-control px-1.5 text-[11px] text-ink-secondary">
                          {optionIndex + 1}
                        </kbd>
                      )}
                    </button>
                  );
                })}
                {question.allowOther && (editable || otherOn) && (
                  <label
                    className={cn(
                      "flex w-full items-center gap-3 px-3 py-2",
                      question.options.length > 0 && "border-t border-hairline/40",
                      otherOn && "bg-raised-hover",
                    )}
                  >
                    <Indicator multi={question.multiSelect} checked={otherOn} />
                    <span className="shrink-0 text-[14.5px] text-ink">{t("questions.other")}</span>
                    <input
                      type={question.secret ? "password" : "text"}
                      value={draft.other}
                      disabled={!editable}
                      maxLength={2000}
                      aria-label={t("questions.otherLabel", { question: question.question })}
                      placeholder={t("questions.otherPlaceholder")}
                      onChange={(event) => {
                        const text = event.target.value;
                        setDrafts((current) => setOther(current, question, text));
                      }}
                      className="min-w-0 flex-1 rounded-md border border-hairline/40 bg-inset px-2.5 py-1.5 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-60"
                    />
                  </label>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {state === "expired" && (
        <p className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          {secret ? t("questions.secretExpired") : t("questions.expiredNote", { name })}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[12.5px] text-danger">
          {error}
        </p>
      )}

      {confirmingSkip && state === "open" ? (
        <div role="alertdialog" aria-label={t("questions.skip")} className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-[13px] text-ink-secondary">{t("questions.skipConfirm", { name })}</span>
          <button
            type="button"
            autoFocus
            onClick={() => setConfirmingSkip(false)}
            onKeyDown={(event) => { if (event.key === "Escape") setConfirmingSkip(false); }}
            className="rounded-full border border-hairline/50 px-3.5 py-1.5 text-[13.5px] text-ink hover:bg-control"
          >
            {t("questions.keepAnswering")}
          </button>
          <button
            type="button"
            onClick={() => { setConfirmingSkip(false); onSkip(); }}
            className="rounded-full border border-danger/40 px-3.5 py-1.5 text-[13.5px] text-danger hover:bg-danger/10"
          >
            {t("questions.skip")}
          </button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2 text-[13px] text-ink-secondary">
          {state === "open" && (
            <>
              <span className="mr-auto hidden text-[12px] sm:inline">{t("questions.keys")}</span>
              <button
                type="button"
                onClick={submit}
                disabled={!complete || busy}
                className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-[13.5px] font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? t("questions.sending") : t("questions.submit")}
                {!busy && <CornerDownLeft size={13} aria-hidden />}
              </button>
            </>
          )}
          {state === "expired" && !secret && (
            <button
              type="button"
              onClick={submit}
              disabled={!complete || busy}
              className="rounded-full bg-accent px-3.5 py-1.5 text-[13.5px] font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? t("questions.sending") : t("questions.sendAsMessage")}
            </button>
          )}
          {state === "answered" && (
            <span className="inline-flex items-center gap-1.5"><Check size={14} className="text-success" /> {t("questions.answered")}</span>
          )}
          {state === "sent" && (
            <span className="inline-flex items-center gap-1.5"><Check size={14} className="text-success" /> {t("questions.sent")}</span>
          )}
          {state === "skipped" && <span className="inline-flex items-center gap-1.5"><X size={14} /> {t("questions.skipped")}</span>}
          {state === "closed" && <span>{t("questions.closed")}</span>}
        </div>
      )}
    </section>
  );
}

function Indicator({ multi, checked }: { multi: boolean; checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
        multi ? "rounded-[4px]" : "rounded-full",
        checked ? "border-accent bg-accent text-white" : "border-hairline bg-inset",
      )}
    >
      {checked && (multi ? <Check size={11} strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-white" />)}
    </span>
  );
}

/** The store-connected card, rendered in ChatView and GroupView wherever a
 * request card with questions appears. Answers go by THREAD, so a question
 * raised inside a room is answered the same way as one in a 1:1 chat. */
export function QuestionCard({
  message,
  threadId,
  botId,
  groupId,
  botName,
}: {
  message: Message;
  threadId: string;
  /** 1:1 chats: the bot whose composer route carries a late answer */
  botId?: string;
  /** rooms: the room whose composer route carries a late answer */
  groupId?: string;
  botName?: string;
}) {
  const { dispatch } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = message.card;
  const settledKey = `${card?.answered ?? ""}:${card?.expired ? 1 : 0}:${card?.sentAsMessage ? 1 : 0}`;
  // the server's message.patch is the confirmation; a changed card ends the wait
  useEffect(() => setBusy(false), [settledKey]);
  if (!card?.requestId) return null;
  const requestId = card.requestId;
  const failed = (text: string) => {
    setBusy(false);
    setError(text);
  };
  return (
    <QuestionCardView
      card={card}
      botName={botName}
      busy={busy}
      error={error}
      onSubmit={(answers) => {
        setBusy(true);
        setError(null);
        dispatch({ type: "answerQuestion", threadId, requestId, behavior: "answer", answers, onError: failed });
      }}
      onSkip={() => {
        setBusy(true);
        setError(null);
        dispatch({ type: "answerQuestion", threadId, requestId, behavior: "skip", onError: failed });
      }}
      onSendAsMessage={(answers, text) => {
        setBusy(true);
        setError(null);
        dispatch({ type: "sendQuestionAsMessage", botId, groupId, threadId, requestId, text, answers, onError: failed });
      }}
    />
  );
}
