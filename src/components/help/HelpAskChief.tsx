// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Ask about this screen" in the help panel (L4B fallback, 1.0.17). The box
// holds the question only until Ask: then it goes into the Chief of Staff's
// composer (src/lib/help-ask-chief.ts), on this computer, and nothing is
// sent until the owner presses Send there. It is not the feedback form: no
// word typed here reaches a feedback report or any request
// (FeedbackForm.test.ts keeps the form and the panel free of text boxes).
import { useId, useRef, useState } from "react";
import { ASK_MAX_CHARS } from "@/lib/help-ask-chief";
import { hx } from "./help-copy";

/** Ask moves focus to the Chief's composer, where Enter sends. A held Enter that pressed Ask would repeat into that
 *  composer and send, so a key-pressed Ask waits until the key is let go. A click or a tap asks at once. */
export function releaseGate(run: () => void) {
  let held = false;
  let pending = false;
  return {
    keyDown(key: string) { if (key === "Enter" || key === " ") held = true; },
    keyUp(key: string) {
      if (key !== "Enter" && key !== " ") return;
      held = false;
      if (pending) { pending = false; run(); }
    },
    submit() { if (held) pending = true; else run(); },
    /** Focus left the box before the key came up: nothing is asked. */
    cancel() { held = false; pending = false; },
  };
}

export function AskAboutScreen({ chiefName, onAsk }: { chiefName: string; onAsk: (question: string) => void }) {
  const ids = useId();
  const [question, setQuestion] = useState("");
  const latest = useRef(question);
  latest.current = question;
  const onAskRef = useRef(onAsk);
  onAskRef.current = onAsk;
  const gate = useRef<ReturnType<typeof releaseGate> | null>(null);
  gate.current ??= releaseGate(() => onAskRef.current(latest.current));
  return (
    <section aria-labelledby={`${ids}-h`} data-help-ask className="border-b border-hairline/40 px-5 py-4">
      <h3 id={`${ids}-h`} className="mb-2.5 text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-secondary">{hx("ux.l4b.ask.heading")}</h3>
      <form
        className="flex flex-col gap-2"
        onKeyDown={(event) => { if (!event.repeat) gate.current!.keyDown(event.key); }}
        onKeyUp={(event) => gate.current!.keyUp(event.key)}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) gate.current!.cancel(); }}
        onSubmit={(event) => { event.preventDefault(); gate.current!.submit(); }}
      >
        <textarea
          aria-label={hx("ux.l4b.ask.label")}
          placeholder={hx("ux.l4b.ask.placeholder")}
          value={question}
          maxLength={ASK_MAX_CHARS}
          rows={2}
          onChange={(event) => setQuestion(event.target.value)}
          className="w-full resize-none rounded-lg border border-hairline/60 bg-app px-3 py-2 text-[14px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border"
        />
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-[13px] leading-5 text-ink-secondary">{hx("ux.l4b.ask.answers", { name: chiefName })}</p>
          <button type="submit" className="min-h-11 shrink-0 rounded-lg bg-accent px-4 text-[14px] font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border">
            {hx("ux.l4b.ask.button", { name: chiefName })}
          </button>
        </div>
      </form>
    </section>
  );
}
