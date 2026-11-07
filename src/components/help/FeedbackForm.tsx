// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Tell us what to make easier": the masterclass testers' feedback form, at
// the foot of the help panel (plan section 4, R17). It is feedback for the
// Murage team, not a help request: it says so, and "Ask your bot" sits right
// beside that line so help is always the first option. Nobody replies to it,
// so it never asks for an email and never promises an answer.
//
// The owner picks what got in the way on this screen from three choices;
// there is no box to type into. What leaves the computer is the
// screen envelope (src/lib/screen-envelope.ts) and the choice's fixed
// sentence, never text the owner typed (FIX-LEDGER UX-L4A-WORDS holds the
// case for a words box).
// The "What we send" fold shows that request before Send (its time is set
// when Send is pressed, and the fold then shows the one sent); the relay
// adds only the app version, the system and an install number, and the fold
// says so.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "@/state/store";
import {
  buildFeedbackRequest,
  gateReasonKey,
  checkFeedbackRequest,
  FEEDBACK_CHOICES,
  type FeedbackChoice,
  type FeedbackRequest,
  type FeedbackSurface,
  type ScreenEnvelope,
} from "@/lib/screen-envelope";
import { screenEntry } from "@/lib/screens-index";
import { useHelpCopy } from "@/lib/help-copy-store";
import { localeCode } from "@/lib/i18n";
import { hx } from "./help-copy";

export type FeedbackPhase = "editing" | "sending" | "sent" | "failed" | "too-many";
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
 *  often (429) has its own words; every other failure, an endpoint not
 *  deployed yet included, keeps the choice and says to try later. */
export function phaseAfter(outcome: FeedbackOutcome): FeedbackPhase {
  if (outcome.sent) return "sent";
  return outcome.reason === "rate_limited" ? "too-many" : "failed";
}

/** The copy key for each choice's shown label. */
export const FEEDBACK_CHOICE_LABEL: Readonly<Record<FeedbackChoice, string>> = Object.freeze({
  complicated: "ux.l4a.feedback.choice.complicated",
  "cant-do": "ux.l4a.feedback.choice.cantDo",
  "cant-find": "ux.l4a.feedback.choice.cantFind",
});

/** The request Send posts: built when Send is pressed, so createdAt is the
 *  send time, not the time the form opened. */
export function feedbackRequestAtSend({ envelope, choice, surface, now }: { envelope: ScreenEnvelope; choice: FeedbackChoice; surface: FeedbackSurface; now: () => Date }): FeedbackRequest {
  return buildFeedbackRequest({ envelope, choice, surface, now: now() });
}

/** "What we send", in a language other than English (L-COPY r3). The request
 *  itself stays the fixed English contract the relay checks (screen-envelope.ts);
 *  the fold shows the same fields in the reader's language: the screen by its
 *  title from the active Help pack, the choice by its shown label, each gate
 *  by its localized reason, each control by its localized label, and the
 *  time. No raw ids (a Settings page is named by the screen title already).
 *  A line under it says the team receives these same fields in English. A
 *  {name} in a title is filled with the name the panel shows, else the
 *  localized word for a chat or a group, never the English fixed word. */
export function previewFields(request: FeedbackRequest, choice: FeedbackChoice, name = ""): { id: string; text: string }[] {
  const entry = screenEntry(request.screen);
  const fallbackName = hx(request.screen.startsWith("group") ? "ux.l4a.feedback.groupWord" : "ux.l4a.feedback.chatWord");
  const fields = [
    { id: "screen", text: entry ? hx(entry.title, { name: name.trim() || fallbackName }) : hx("ux.l4a.panel.label") },
    { id: "choice", text: hx(FEEDBACK_CHOICE_LABEL[choice]) },
  ];
  for (const gate of request.state.gates ?? []) {
    const reason = gateReasonKey(gate.id);
    if (reason) fields.push({ id: `gate:${gate.id}`, text: hx(reason) });
  }
  for (const control of request.controls) {
    const label = entry?.controls.find((item) => item.id === control.id)?.label;
    if (label) fields.push({ id: `control:${control.id}`, text: hx(label) });
  }
  const when = new Date(request.createdAt);
  let time = request.createdAt;
  try { time = when.toLocaleString(localeCode()); } catch { /* an engine without that locale keeps the ISO time */ }
  fields.push({ id: "createdAt", text: time });
  return fields;
}

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
  /** The bot or chat name the panel shows, for a {name} title in the localized preview (never sent). */
  name?: string;
  now?: () => Date;
}

export function FeedbackForm({ envelope, surface, onCancel, onAskBot, send = postFeedback, initialPhase = "editing", initialChoice, name = "", now = () => new Date() }: FeedbackFormProps) {
  const ids = useId();
  const [choice, setChoice] = useState<FeedbackChoice | null>(initialChoice ?? null);
  const [phase, setPhase] = useState<FeedbackPhase>(initialPhase);
  const [nudge, setNudge] = useState(false);
  // createdAt is the moment Send is pressed (the relay contract). Until then
  // the fold shows the request as of now; pressing Send stamps the time, sends
  // that request, and the fold shows the one that was sent.
  const [createdAt, setCreatedAt] = useState(now);
  const status = useRef<HTMLParagraphElement>(null);
  const preview = useMemo(() => (choice ? buildFeedbackRequest({ envelope, choice, surface, now: createdAt }) : null), [envelope, choice, surface, createdAt]);
  const { code } = useHelpCopy();
  useEffect(() => { if (phase !== "editing") status.current?.focus(); }, [phase]);

  const submit = async () => {
    if (phase === "sending") return;
    if (!choice) { setNudge(true); return; }
    const request = feedbackRequestAtSend({ envelope, choice, surface, now });
    setCreatedAt(new Date(request.createdAt));
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
          onClick={() => setPhase("editing")}>
          {hx("ux.l4a.feedback.sendAnother")}
        </button>
      </div>
    );
  }

  const failedLine = phase === "failed" ? hx("ux.l4a.feedback.failed") : phase === "too-many" ? hx("ux.l4a.feedback.tooMany") : null;
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
      {nudge && <p id={`${ids}-nudge`} role="alert" className="text-[13px] text-ink">{hx("ux.l4a.feedback.needChoice")}</p>}
      <details className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
        <summary className="min-h-9 cursor-pointer py-1.5 text-[13px] font-medium text-ink">{hx("ux.l4a.feedback.whatWeSend")}</summary>
        {code === "en" || !preview ? (
          <pre data-feedback-preview className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-4 text-ink">
            {preview ? JSON.stringify(preview, null, 2) : hx("ux.l4a.feedback.pickFirst")}
          </pre>
        ) : (
          <div data-feedback-preview className="mt-2 text-[12px] leading-4 text-ink">
            <ul className="flex flex-col gap-1">
              {previewFields(preview, choice!, name).map((field) => <li key={field.id} data-field={field.id} className="break-words">{field.text}</li>)}
            </ul>
            <p className="mt-2 text-ink-secondary">{hx("ux.l4a.feedback.previewEnglish")}</p>
          </div>
        )}
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
