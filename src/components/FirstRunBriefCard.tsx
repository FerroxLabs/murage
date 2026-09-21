// PARKED, PENDING THE OWNER'S DECISION (W16, 0.1.58).
//
// `brief` and `routines` are no longer steps. The morning
// brief is now an outcome of the `brief` job, and its "every morning?" offer
// arrives on that job's own result, where the person has just seen one.
//
// Nothing renders this today: server/setup-conversation.ts never emits its
// card variant. It stays in the tree, compiling and untouched otherwise, and
// its step calls point at PARKED_CARD_STEP rather than at a step that no
// longer exists. Whether it moves to another surface, returns later in the
// flow, or goes, is the owner's call and it has not been taken. Deleting
// tested work on a guess is how you lose a week.
//
// CARDS FIVE, SIX AND SEVEN: the brief, the proof, and two more.
//
// The brief is the moment the release is built around, so the card does the
// smallest possible amount of asking: one time, one switch, one button, and
// the button says the time back so nobody has to check what they picked.
//
// The card after it exists because a promise and a delivery are different
// products. `brief-ran` is the Chief saying it has already happened, with
// the brief itself in the thread underneath.

import { useState } from "react";

import {
  FIRST_RUN_BRIEF_TIME,
  FIRST_RUN_COPY,
  briefButtonLabel,
  briefRanLine,
} from "@/lib/first-run-copy";
import {
  PARKED_CARD_STEP,
  FIRST_RUN_CHIP,
  FIRST_RUN_FOCUS,
  FIRST_RUN_INPUT,
  FIRST_RUN_PRIMARY,
  FIRST_RUN_QUIET,
  FirstRunBubble,
  FirstRunFailure,
  FirstRunLine,
  createSetupRoutine,
  failureText,
  skipSetupStep,
  useSetupView,
} from "./FirstRunChrome";

const copy = FIRST_RUN_COPY.brief.brief;
const ranCopy = FIRST_RUN_COPY.brief["brief-ran"];
const moreCopy = FIRST_RUN_COPY.routines["more-routines"];

export function FirstRunBriefCard({ settled }: { settled: boolean }) {
  const [time, setTime] = useState(FIRST_RUN_BRIEF_TIME);
  const [weekdays, setWeekdays] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  // A CARD SETTLES FROM THE SERVER, NOT ONLY FROM THIS COMPONENT.
  //
  // This was `useState(settled)`, which reads the prop ONCE. `settled` is set
  // by the server when the step lands, and that can happen after this card
  // first rendered: another surface answered it, the step completed on its
  // own, or the app reopened mid-flow. The card went on showing an open form
  // with live buttons for a question that was already answered, which is most
  // of why the thread read as a wall of unfinished business.
  //
  // Derived instead, so the two ways a card can be finished agree: this
  // component did it, or the server says so.
  const [acted, setActed] = useState(false);
  const done = acted || settled;

  const schedule = async () => {
    if (busy) return;
    setBusy(true);
    setFailure("");
    try {
      await createSetupRoutine({ template: "brief", time, weekdaysOnly: weekdays });
      setActed(true);
    } catch (cause) {
      setFailure(failureText(cause, copy.failure));
    } finally {
      setBusy(false);
    }
  };

  const notNow = async () => {
    if (busy) return;
    setBusy(true);
    setFailure("");
    try {
      await skipSetupStep(PARKED_CARD_STEP);
      setActed(true);
    } catch (cause) {
      setFailure(failureText(cause, copy.failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FirstRunBubble>
      <div className="text-[15px] font-semibold text-ink">{copy.title}</div>
      <FirstRunLine>{copy.body}</FirstRunLine>
      <FirstRunLine>{copy.second}</FirstRunLine>
      <FirstRunLine quiet>{copy.permission}</FirstRunLine>

      {!done && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-[13px] text-ink-secondary">
            {copy.timeLabel}
            <input
              aria-label={copy.timeLabel}
              type="time"
              value={time}
              step={300}
              disabled={busy}
              onChange={(event) => setTime(event.target.value || FIRST_RUN_BRIEF_TIME)}
              className={`mt-1.5 w-[9rem] ${FIRST_RUN_INPUT} ${FIRST_RUN_FOCUS}`}
            />
          </label>
          <label className="flex min-h-11 items-center gap-2 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={weekdays}
              disabled={busy}
              onChange={(event) => setWeekdays(event.target.checked)}
              className="size-4"
            />
            {copy.weekdays}
          </label>
          <button type="button" disabled={busy} onClick={() => void schedule()} className={`${FIRST_RUN_PRIMARY} ${FIRST_RUN_FOCUS}`}>
            {busy ? copy.working : briefButtonLabel(time)}
          </button>
          <button type="button" disabled={busy} onClick={() => void notNow()} className={`${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
            {copy.dismiss}
          </button>
        </div>
      )}

      <FirstRunFailure message={failure} />
    </FirstRunBubble>
  );
}

/** It has already run, and the brief itself is the next thing in the
 *  thread. Nothing to press: this card is the Chief pointing at it. */
export function FirstRunBriefRanCard() {
  const { view } = useSetupView();
  // The brief's own scheduled time when the checklist knows it, and the
  // default otherwise. Never a time this card made up on its own that
  // disagrees with the routine.
  const time = readBriefTime(view?.steps) ?? FIRST_RUN_BRIEF_TIME;
  return (
    <FirstRunBubble>
      <FirstRunLine>{ranCopy.body}</FirstRunLine>
      <FirstRunLine>{briefRanLine(time)}</FirstRunLine>
    </FirstRunBubble>
  );
}

/** The brief step's own detail line carries its time when the server has
 *  one. Read defensively: a detail that is prose rather than a time is not
 *  a time, and a made up one would contradict the routine itself. */
function readBriefTime(steps: readonly { id: string; detail?: string }[] | undefined): string | null {
  const detail = steps?.find((step) => step.id === "brief")?.detail ?? "";
  const match = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(detail);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : null;
}

/** Two more, proposed from what is actually connected rather than from a
 *  list of everything the product can do. */
export function FirstRunMoreRoutinesCard({ settled }: { settled: boolean }) {
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const [failure, setFailure] = useState("");
  // Same reason as the card above: `settled` can arrive late.
  const [acted, setActed] = useState(false);
  const done = acted || settled;

  const add = async (template: "triage" | "watch") => {
    if (busy) return;
    setBusy(template);
    setFailure("");
    try {
      await createSetupRoutine({
        template,
        ...(template === "watch" && subject.trim() ? { subject: subject.trim() } : {}),
      });
      setAdded((current) => [...current, template]);
    } catch (cause) {
      setFailure(failureText(cause, moreCopy.failure));
    } finally {
      setBusy("");
    }
  };

  const enough = async () => {
    if (busy) return;
    setFailure("");
    try {
      await skipSetupStep(PARKED_CARD_STEP);
      setActed(true);
    } catch (cause) {
      setFailure(failureText(cause, moreCopy.failure));
    }
  };

  return (
    <FirstRunBubble>
      <div className="text-[15px] font-semibold text-ink">{moreCopy.title}</div>
      <FirstRunLine>{moreCopy.body}</FirstRunLine>

      <ul className="mt-3 grid gap-2">
        {moreCopy.rows.map((row) => {
          const running = added.includes(row.template);
          return (
            <li key={row.template} className="rounded-xl bg-inset px-3 py-2.5">
              <div className="text-[14px] text-ink">{row.label}</div>
              <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{row.why}</div>
              {row.template === "watch" && !running && (
                <input
                  aria-label={row.label}
                  placeholder={"placeholder" in row ? row.placeholder : undefined}
                  value={subject}
                  disabled={Boolean(busy) || done}
                  onChange={(event) => setSubject(event.target.value)}
                  className={`mt-2 ${FIRST_RUN_INPUT} ${FIRST_RUN_FOCUS}`}
                />
              )}
              <div className="mt-2">
                {running ? (
                  <span className="text-[13px] text-success">{moreCopy.added}</span>
                ) : (
                  <button
                    type="button"
                    disabled={Boolean(busy) || done}
                    onClick={() => void add(row.template as "triage" | "watch")}
                    className={`${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS}`}
                  >
                    {busy === row.template ? moreCopy.working : moreCopy.add}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <FirstRunFailure message={failure} />

      {!done && (
        <button type="button" disabled={Boolean(busy)} onClick={() => void enough()} className={`mt-2 ${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
          {moreCopy.dismiss}
        </button>
      )}
    </FirstRunBubble>
  );
}
