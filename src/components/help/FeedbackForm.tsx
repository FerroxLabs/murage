// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Tell us what to make easier": the masterclass testers' feedback form, at
// the foot of the help panel (plan section 4, R17). It is feedback for the
// Murage team, not a help request: it says so, and "Ask your bot" sits right
// beside that line so help is always the first option. Nobody replies to it,
// so it never asks for an email and never promises an answer.
//
// In 1.0.12 the owner picks what got in the way on this screen from three
// choices; there is no box to type into. What leaves the computer is the
// screen envelope (src/lib/screen-envelope.ts) and the choice's fixed
// sentence, never text the owner typed. Feedback by words comes in 1.0.13
// with the shared scrubber (designs/L4A-SCRUBBER-REDESIGN-1012.md section 5).
// The "What we send" fold shows that exact request before Send; the relay
// adds only the app version, the system and an install number, and the fold
// says so.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "@/state/store";
import {
  buildFeedbackRequest,
  checkFeedbackRequest,
  FEEDBACK_CHOICES,
  type FeedbackChoice,
  type FeedbackRequest,
  type FeedbackSurface,
  type ScreenEnvelope,
} from "@/lib/screen-envelope";
import { hx } from "./help-copy";

export type FeedbackPhase = "editing" | "sending" | "sent" | "failed" | "too-many" | "too-long";
export interface FeedbackOutcome { sent: boolean; reason?: string }
export type SendFeedback = (request: FeedbackRequest) => Promise<FeedbackOutcome>;

/** The relay answers within 10 s (lane L-FB); a little longer here so its own
 *  answer, not this timer, is what the owner sees. */
export const FEEDBACK_TIMEOUT_MS = 12_000;

export const postFeedback: SendFeedback = async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEEDBACK_TIMEOUT_MS);
  try {
    const body = await api("/api/feedback", { method: "POST", body: JSON.stringify(request), signal: controller.signal });
    return body?.sent === true ? { sent: true } : { sent: false, reason: typeof body?.reason === "string" ? body.reason : "not_sent" };
  } catch (error) {
    const status = (error as { status?: number }).status;
    return { sent: false, reason: status === 429 ? "rate_limited" : status === 413 ? "too_long" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
};

/** Where an outcome leaves the form. Only the relay's own {sent:true} is sent
 *  (it answers that only for the control plane's {ok:true,id}). Sending too
 *  often (429) and too long (413) have their own words; every other failure,
 *  an endpoint not deployed yet included, keeps the choice and says to try later. */
export function phaseAfter(outcome: FeedbackOutcome): FeedbackPhase {
  if (outcome.sent) return "sent";
  if (outcome.reason === "rate_limited") return "too-many";
  return outcome.reason === "too_long" ? "too-long" : "failed";
}

/** The copy key for each choice's shown label. */
export const FEEDBACK_CHOICE_LABEL: Readonly<Record<FeedbackChoice, string>> = Object.freeze({
  complicated: "ux.l4a.feedback.choice.complicated",
  "cant-do": "ux.l4a.feedback.choice.cantDo",
  "cant-find": "ux.l4a.feedback.choice.cantFind",
});

const button = "min-h-11 rounded-lg px-4 text-[14px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border";

export interface FeedbackFormProps {
  envelope: ScreenEnvelope;
  surface: FeedbackSurface;
  onCancel: () => void;
  onAskBot: () => void;
  send?: SendFeedback;
  /** Tests start the form in a given state; the app never passes these. */
  initialPhase?: FeedbackPhase;
  initialChoice?: FeedbackChoice;
  now?: () => Date;
}

export function FeedbackForm({ envelope, surface, onCancel, onAskBot, send = postFeedback, initialPhase = "editing", initialChoice, now = () => new Date() }: FeedbackFormProps) {
  const ids = useId();
  const [choice, setChoice] = useState<FeedbackChoice | null>(initialChoice ?? null);
  const [phase, setPhase] = useState<FeedbackPhase>(initialPhase);
  const [nudge, setNudge] = useState(false);
  // One time for the preview and the send, so the fold shows the request exactly.
  const createdAt = useRef(now());
  const status = useRef<HTMLParagraphElement>(null);
  const request = useMemo(() => (choice ? buildFeedbackRequest({ envelope, choice, surface, now: createdAt.current }) : null), [envelope, choice, surface]);
  useEffect(() => { if (phase !== "editing") status.current?.focus(); }, [phase]);

  const submit = async () => {
    if (phase === "sending") return;
    if (!request) { setNudge(true); return; }
    // Only a request of the agreed shape leaves: the envelope plus one fixed sentence.
    if (checkFeedbackRequest(request) !== null) { setPhase("failed"); return; }
    setPhase("sending");
    const next = phaseAfter(await send(request));
    if (next === "sent") setChoice(null);
    setPhase(next);
  };

  if (phase === "sent") {
    return (
      <div className="flex flex-col items-start gap-3">
        <p ref={status} tabIndex={-1} role="status" className="text-[14px] leading-5 text-ink outline-none">{hx("ux.l4a.feedback.sent")}</p>
        <button type="button" className={`${button} border border-hairline/60 text-ink hover:bg-app`}
          onClick={() => { createdAt.current = now(); setPhase("editing"); }}>
          {hx("ux.l4a.feedback.sendAnother")}
        </button>
      </div>
    );
  }

  const failedLine = phase === "failed" ? hx("ux.l4a.feedback.failed") : phase === "too-many" ? hx("ux.l4a.feedback.tooMany") : phase === "too-long" ? hx("ux.l4a.feedback.tooLong") : null;
  return (
    <form className="flex flex-col gap-3" aria-labelledby={`${ids}-title`} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <h3 id={`${ids}-title`} className="text-[15px] font-semibold text-ink">{hx("ux.l4a.feedback.open")}</h3>
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-[13px] leading-5 text-ink-secondary">{hx("ux.l4a.feedback.notSupport")}</p>
        <button type="button" onClick={onAskBot} className={`${button} shrink-0 border border-hairline/60 text-ink hover:bg-app`}>
          {hx("ux.l4a.feedback.askBot")}
        </button>
      </div>
      <fieldset className="flex flex-col gap-1" disabled={phase === "sending"} aria-describedby={nudge ? `${ids}-nudge` : undefined}>
        <legend className="mb-1 text-[14px] font-medium leading-5 text-ink">{hx("ux.l4a.feedback.wordsLabel")}</legend>
        {FEEDBACK_CHOICES.map((value) => (
          <label key={value} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 text-[14px] leading-5 text-ink hover:bg-app">
            <input
              type="radio"
              name={`${ids}-choice`}
              value={value}
              checked={choice === value}
              onChange={() => { setChoice(value); setNudge(false); }}
              className="size-4 shrink-0 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border"
            />
            {hx(FEEDBACK_CHOICE_LABEL[value])}
          </label>
        ))}
      </fieldset>
      <p data-feedback-words-next className="text-[13px] leading-5 text-ink-secondary">{hx("ux.l4a.feedback.wordsNext")}</p>
      {nudge && <p id={`${ids}-nudge`} role="alert" className="text-[13px] text-ink">{hx("ux.l4a.feedback.needChoice")}</p>}
      <details className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
        <summary className="min-h-9 cursor-pointer py-1.5 text-[13px] font-medium text-ink">{hx("ux.l4a.feedback.whatWeSend")}</summary>
        <pre data-feedback-preview className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-4 text-ink">
          {request ? JSON.stringify(request, null, 2) : hx("ux.l4a.feedback.pickFirst")}
        </pre>
        <p className="mt-2 text-[12px] leading-4 text-ink-secondary">{hx("ux.l4a.feedback.added")}</p>
      </details>
      <p className="text-[13px] leading-5 text-ink-secondary">{hx("ux.l4a.feedback.privacy")}</p>
      {phase === "sending" && <p ref={status} tabIndex={-1} role="status" className="text-[13px] text-ink outline-none">{hx("ux.l4a.feedback.sending")}</p>}
      {failedLine && <p ref={status} tabIndex={-1} role="alert" className="text-[13px] text-ink outline-none">{failedLine}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={phase === "sending"} className={`${button} text-ink-secondary hover:bg-app`}>
          {hx("ux.l4a.feedback.cancel")}
        </button>
        <button type="submit" disabled={phase === "sending"} className={`${button} bg-accent text-white disabled:opacity-60`}>
          {hx("ux.l4a.feedback.send")}
        </button>
      </div>
    </form>
  );
}
