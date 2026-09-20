// The eight cards of the guided first run, as markup only.
//
// THE ONE RULE THIS FILE EXISTS TO KEEP: the server owns every step's state.
// Nothing in here decides that a step is finished, and nothing re-words a
// blockage. `SetupStepView.status` is rendered as it arrives — never derived
// from `done`, never from what the person just clicked — and a blocked step
// shows the server's own `block.message` verbatim. A second copy of that
// sentence here would be a second copy to get wrong, and the case it covers
// (a Flux Router key that authenticates perfectly and then cannot spend) is
// precisely the one where a guess would accuse the person of a wrong key.
//
// Kept free of the store and of `fetch` so every branch can be rendered in a
// unit test without a harness, the way FluxInviteBody is.
import { useState } from "react";
import { Check, CircleAlert, CircleDashed, ExternalLink, Loader2, MinusCircle } from "lucide-react";

import type { SetupStep, SetupStepView, SetupView } from "../../shared/setup";
import { SETUP_NOTE_MAX, SETUP_SOLO_CREW } from "../../shared/setup";
import { FLUX_SIGNUP_URL } from "./FluxRouterConnection";
import { cn } from "@/lib/cn";

// ── copy ───────────────────────────────────────────────────────────────
/** Setup says "brain"; the engine's own name goes underneath it, and the
 *  word "engine" stays in Settings where the engines are managed. */
export interface SetupCardCopy {
  /** The card's heading. Also the checklist row's label. */
  title: string;
  /** The one question the card asks, in the person's words. */
  question: string;
  /** What is still outstanding once the step has been passed over. Skipped
   *  is not done, and the card has to keep saying so. */
  skipped: string;
}

export const SETUP_CARDS: Record<SetupStep, SetupCardCopy> = {
  flux: {
    title: "Your Flux Router key",
    question: "Do you have your Flux Router key?",
    skipped:
      "Passed over. The included brain and connected apps stay locked until a key is saved. "
      + "You can come back to this from Settings at any time.",
  },
  purpose: {
    title: "What you're here for",
    question: "What would you like taken off your plate?",
    skipped: "Passed over. Your Chief will ask again the first time it needs to know.",
  },
  brain: {
    title: "Give your bots a brain",
    question: "Can your Chief answer yet?",
    skipped: "Passed over. Until a brain answers, your bots can be talked to but cannot reply.",
  },
  crew: {
    title: "Meet your crew",
    question: "Who should work alongside your Chief?",
    skipped: "Passed over. It is just your Chief for now, which is a perfectly good place to start.",
  },
  apps: {
    title: "Connect the apps it uses",
    question: "Which apps should your bots be able to reach?",
    skipped: "Passed over. Your bots cannot reach your apps until one is connected and granted.",
  },
  "first-task": {
    title: "Try one real thing",
    question: "Give your Chief something real to do.",
    skipped: "Passed over. Nothing here has been proved end to end yet.",
  },
  voice: {
    title: "Your writing voice",
    question: "How should your bots sound when they write for you?",
    skipped: "Passed over. Your bots will write in their own voice.",
  },
  wrap: {
    title: "Wrap up",
    question: "Here's what I'll remember.",
    skipped: "Passed over. Nothing was written to your Chief's notebook.",
  },
};

/** The four chips on the purpose card. Free text is the real answer; these
 *  are shortcuts for the four things people arrive wanting. */
export const PURPOSE_CHIPS = [
  "Email and calendar",
  "Research and writing",
  "Code and repositories",
  "Sales and outreach",
] as const;

/** The voice card's chips. Optional, like the whole step. */
export const VOICE_CHIPS = ["Short and direct", "Warm and friendly", "Formal and precise"] as const;

/** Three first tasks that need nothing installed and no app connected, so
 *  the step can be attempted on any machine. */
export const FIRST_TASKS = [
  "Introduce yourself and tell me what you can do today.",
  "Write me a three-line plan for my next working hour.",
  "Summarise what you know about me so far.",
] as const;

/** Never a count we have not verified. Flux Router's catalog is not read by
 *  this panel, so "500+" would be a number nothing here can stand behind. */
export const APPS_CLAIM = "hundreds of apps, including Gmail, Slack, Notion and GitHub";

// ── what a card says ───────────────────────────────────────────────────
/** "3 of 8 done", pinned at the top of the thread. Straight from the
 *  server's own count: the panel never adds one for a click in flight. */
export function setupProgressLabel(view: Pick<SetupView, "progress">): string {
  return `${view.progress.done} of ${view.progress.total} done`;
}

/** The sentence under a card's title.
 *
 * A blocked step shows the SERVER's words and nothing else. The block is the
 * explanation — "the key is saved and there is nothing to re-paste" — and
 * inventing a local variant is how a spend ceiling ends up presented as a bad
 * key. `detail` is the fallback only when a block arrived without a message,
 * which no server we ship sends. */
export function setupCardNote(step: SetupStepView): string | null {
  switch (step.status) {
    case "blocked":
      return step.block?.message?.trim() || step.detail || null;
    case "skipped":
      return SETUP_CARDS[step.id].skipped;
    case "done":
      return null;
    default:
      return step.detail ?? null;
  }
}

/** The word next to a card's mark. Text, not colour alone — the state has to
 *  survive a greyscale screen and a screen reader. */
export const SETUP_STATUS_LABEL: Record<SetupStepView["status"], string> = {
  done: "Done",
  skipped: "Passed over",
  blocked: "Blocked",
  open: "To do",
};

/** A blocked step is NOT a step the person got wrong, so the checklist never
 *  offers to undo or re-enter anything on it. */
export function setupCardCanSkip(step: SetupStepView): boolean {
  return step.status === "open" || step.status === "blocked";
}

// ── pieces ─────────────────────────────────────────────────────────────
const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-panel";

const primaryButton = cn(
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-[14px] font-medium text-accent-ink transition-[filter] hover:brightness-110 disabled:opacity-60",
  focusRing,
);

const secondaryButton = cn(
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-hairline/60 bg-control px-4 py-2.5 text-[14px] font-medium text-ink hover:bg-raised-hover disabled:opacity-60",
  focusRing,
);

const quietButton = cn(
  "inline-flex min-h-11 items-center justify-center rounded-lg px-2 text-[13px] text-ink-secondary underline underline-offset-2 hover:text-ink disabled:opacity-60",
  focusRing,
);

const chipButton = cn(
  "inline-flex min-h-11 items-center justify-center rounded-full border border-hairline/60 bg-control px-3.5 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-60",
  focusRing,
);

const textField = cn(
  "w-full rounded-xl border border-hairline/60 bg-app px-3 py-2.5 text-[14px] text-ink placeholder:text-ink-secondary",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
);

function StatusMark({ status }: { status: SetupStepView["status"] }) {
  const icon =
    status === "done" ? <Check size={14} aria-hidden="true" />
      : status === "skipped" ? <MinusCircle size={14} aria-hidden="true" />
        : status === "blocked" ? <CircleAlert size={14} aria-hidden="true" />
          : <CircleDashed size={14} aria-hidden="true" />;
  return (
    <span
      data-setup-mark={status}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full",
        status === "done" ? "bg-success/15 text-success"
          : status === "blocked" ? "bg-warning/15 text-warning"
            : "bg-control text-ink-secondary",
      )}
    >
      {icon}
    </span>
  );
}

// ── the handlers a card needs ──────────────────────────────────────────
export interface SetupActions {
  /** Record what the person said. The server decides what that changes. */
  answer(step: SetupStep, answer: string): void;
  skip(step: SetupStep): void;
  reopen(step: SetupStep): void;
  /** Pass over every step that is not finished. */
  letMeIn(): void;
  /** Settings → the one Flux Router key field. No second key box here. */
  addFluxKey(): void;
  /** Settings → Engines, where the AI you already pay for is signed in. */
  chooseBrain(): void;
  /** Send a greeting to the Chief, in its own thread. */
  sayHello(): void;
  browseCrews(): void;
  connectApps(): void;
  /** Send one of the prefilled first tasks to the Chief. */
  startFirstTask(task: string): void;
  /** Write the lines to the Chief's notebook, then record the answer. */
  saveMemory(text: string): void;
}

export interface SetupCardProps {
  step: SetupStepView;
  view: SetupView;
  actions: SetupActions;
  /** The Chief's own brain, by name, joined from the engine list. The wire
   *  view carries the BUNDLED engine's readiness but not the name of what
   *  the Chief is on, so the panel supplies it. */
  brainName?: string;
  /** This card is the one the checklist is on. */
  expanded: boolean;
  busy: boolean;
  onExpand(): void;
}

/** One card. Open, done, passed over or blocked — decided entirely by
 *  `step.status`, which is the server's answer. */
export function SetupCard({ step, view, actions, brainName, expanded, busy, onExpand }: SetupCardProps) {
  const copy = SETUP_CARDS[step.id];
  const note = setupCardNote(step);
  const headingId = `setup-card-${step.id}`;
  return (
    <section
      aria-labelledby={headingId}
      data-setup-step={step.id}
      data-setup-status={step.status}
      className={cn(
        "rounded-2xl border bg-panel px-4 py-3.5",
        step.status === "blocked" ? "border-warning/40" : "border-hairline/45",
      )}
    >
      <div className="flex items-start gap-3">
        <StatusMark status={step.status} />
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="text-[15px] font-semibold text-ink">
            {copy.title}
          </h3>
          <p className="mt-0.5 text-[12px] font-medium uppercase tracking-[0.06em] text-ink-secondary">
            {SETUP_STATUS_LABEL[step.status]}
          </p>
          {note && (
            <p
              data-setup-note={step.status === "blocked" ? "block" : step.status}
              className={cn("mt-2 text-[13px] leading-relaxed", step.status === "blocked" ? "text-ink" : "text-ink-secondary")}
            >
              {note}
            </p>
          )}
        </div>
        {!expanded && (
          <button type="button" onClick={onExpand} className={cn(secondaryButton, "shrink-0 px-3 py-1.5 text-[13px]")}>
            {step.status === "done" ? "Change" : "Open"}
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-3 border-t border-hairline/30 pt-3">
          {step.status === "done" ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-[13px] text-ink-secondary">
                This one is finished. Changing it reopens the card — nothing is reinstalled.
              </p>
              <button type="button" disabled={busy} onClick={() => actions.reopen(step.id)} className={secondaryButton}>
                Change
              </button>
            </div>
          ) : (
            <>
              <p className="text-[14px] text-ink">{copy.question}</p>
              <div className="mt-3">
                <SetupCardBody step={step} view={view} actions={actions} brainName={brainName} busy={busy} />
              </div>
              {setupCardCanSkip(step) && step.id !== "wrap" && (
                <div className="mt-3 flex items-center gap-3">
                  <button type="button" disabled={busy} onClick={() => actions.skip(step.id)} className={quietButton}>
                    Skip this for now
                  </button>
                  {busy && <Loader2 size={14} className="animate-spin text-ink-secondary" aria-hidden="true" />}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function stepStatus(view: SetupView, id: SetupStep): SetupStepView["status"] {
  return view.steps.find((step) => step.id === id)?.status ?? "open";
}

/** The controls for one open card. Every one of them either records an
 *  answer or opens the real place the thing is done — there is no second
 *  key field, no second installer and no second crew review in here. */
function SetupCardBody({
  step,
  view,
  actions,
  brainName,
  busy,
}: {
  step: SetupStepView;
  view: SetupView;
  actions: SetupActions;
  brainName?: string;
  busy: boolean;
}) {
  switch (step.id) {
    case "flux":
      return (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] leading-relaxed text-ink-secondary">
            One key unlocks the most: it makes the included brain work, and it is how connected apps run —{" "}
            {APPS_CLAIM}. Skipping is fine; those two stay locked until a key is saved.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={actions.addFluxKey} className={primaryButton}>
              Paste your key
            </button>
            <a href={FLUX_SIGNUP_URL} target="_blank" rel="noopener noreferrer" className={secondaryButton}>
              Get a key
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          </div>
        </div>
      );

    case "purpose":
      return <PurposeBody busy={busy} actions={actions} />;

    case "brain":
      return (
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-[14px] font-medium text-ink">Your Chief's brain</p>
            <p className="mt-0.5 text-[13px] text-ink-secondary">{brainName ?? "Not chosen yet"}</p>
          </div>
          {!view.engine.ready && (
            <p className="text-[13px] leading-relaxed text-ink-secondary">
              The included brain cannot run on this machine
              {view.engine.reason ? `: ${view.engine.reason}` : "."} Use the AI you already pay for, or a local model.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={actions.sayHello} className={primaryButton}>
              Say hello
            </button>
            <button type="button" disabled={busy} onClick={actions.chooseBrain} className={secondaryButton}>
              Use the AI you already pay for
            </button>
          </div>
          <p className="text-[12.5px] text-ink-secondary">
            This step is done when your Chief actually answers — not when a brain is picked.
          </p>
        </div>
      );

    case "crew":
      return (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] leading-relaxed text-ink-secondary">
            The Chief you already met stays your Chief. A crew installed now reports to it.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={actions.browseCrews} className={primaryButton}>
              Pick a crew
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => actions.answer("crew", SETUP_SOLO_CREW)}
              className={secondaryButton}
            >
              Just one assistant
            </button>
          </div>
        </div>
      );

    case "apps":
      return (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] leading-relaxed text-ink-secondary">
            {APPS_CLAIM}. Each app stays off for every bot until you grant it.
          </p>
          {stepStatus(view, "flux") !== "done" && (
            <p data-setup-points-at="flux" className="text-[13px] leading-relaxed text-ink-secondary">
              Connected apps run through Flux Router, so start with your Flux Router key above.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={actions.connectApps} className={primaryButton}>
              Add an app
            </button>
          </div>
        </div>
      );

    case "first-task":
      return (
        <div className="flex flex-col gap-2">
          {FIRST_TASKS.map((task) => (
            <button
              key={task}
              type="button"
              disabled={busy}
              onClick={() => actions.startFirstTask(task)}
              className={cn(secondaryButton, "w-full justify-start px-3.5 text-left")}
            >
              {task}
            </button>
          ))}
          <p className="mt-1 text-[12.5px] text-ink-secondary">
            This step is done when a real reply lands, so it spends tokens on the brain shown above.
          </p>
        </div>
      );

    case "voice":
      return <VoiceBody busy={busy} actions={actions} />;

    case "wrap":
      return <WrapBody busy={busy} view={view} actions={actions} />;
  }
}

function PurposeBody({ busy, actions }: { busy: boolean; actions: SetupActions }) {
  const [draft, setDraft] = useState("");
  const answer = draft.trim();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {PURPOSE_CHIPS.map((chip) => (
          <button key={chip} type="button" disabled={busy} onClick={() => actions.answer("purpose", chip)} className={chipButton}>
            {chip}
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] text-ink-secondary">Or say it in your own words</span>
        <input
          type="text"
          value={draft}
          maxLength={SETUP_NOTE_MAX}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Keep my inbox under control"
          className={textField}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || answer.length === 0}
          onClick={() => actions.answer("purpose", answer)}
          className={primaryButton}
        >
          Save this
        </button>
        <button type="button" disabled={busy} onClick={actions.letMeIn} className={quietButton}>
          Just let me in
        </button>
      </div>
    </div>
  );
}

function VoiceBody({ busy, actions }: { busy: boolean; actions: SetupActions }) {
  const [draft, setDraft] = useState("");
  const answer = draft.trim();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {VOICE_CHIPS.map((chip) => (
          <button key={chip} type="button" disabled={busy} onClick={() => actions.answer("voice", chip)} className={chipButton}>
            {chip}
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] text-ink-secondary">Or paste something you wrote</span>
        <textarea
          rows={3}
          value={draft}
          maxLength={SETUP_NOTE_MAX}
          onChange={(event) => setDraft(event.target.value)}
          className={textField}
        />
      </label>
      <button
        type="button"
        disabled={busy || answer.length === 0}
        onClick={() => actions.answer("voice", answer)}
        className={primaryButton}
      >
        Save this
      </button>
    </div>
  );
}

/** The exact lines that will be saved to the Chief's notebook, editable
 *  before they are saved. Nothing is written until the button is pressed. */
export function setupMemoryLines(view: SetupView): string {
  const note = (id: SetupStep) => view.steps.find((step) => step.id === id)?.note?.trim();
  const lines = ["# What I'll remember"];
  const purpose = note("purpose");
  const voice = note("voice");
  if (purpose) lines.push(`- What you want taken off your plate: ${purpose}`);
  if (voice) lines.push(`- How you like things written: ${voice}`);
  if (lines.length === 1) lines.push("- You set me up and went straight to work.");
  return `${lines.join("\n")}\n`;
}

function WrapBody({ busy, view, actions }: { busy: boolean; view: SetupView; actions: SetupActions }) {
  const [draft, setDraft] = useState(() => setupMemoryLines(view));
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] text-ink-secondary">
          These exact lines go into your Chief's notebook. Edit them before they are saved.
        </span>
        <textarea
          rows={5}
          value={draft}
          aria-label="Lines your Chief will remember"
          onChange={(event) => setDraft(event.target.value)}
          className={cn(textField, "font-mono text-[12.5px]")}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || draft.trim().length === 0}
          onClick={() => actions.saveMemory(draft)}
          className={primaryButton}
        >
          Save and finish
        </button>
      </div>
      <p className="text-[12.5px] text-ink-secondary">Type /setup any time to come back to this list.</p>
    </div>
  );
}

// ── the whole checklist ────────────────────────────────────────────────
export interface SetupChecklistBodyProps {
  view: SetupView;
  actions: SetupActions;
  /** The bot hosting the checklist, by name. */
  chiefName?: string;
  brainName?: string;
  /** Which card is open. `null` follows the server's `next`. */
  openStep: SetupStep | null;
  onOpenStep(step: SetupStep): void;
  busyStep: SetupStep | null;
}

/** Store-free and fetch-free, so every state can be rendered in a test. */
export function SetupChecklistBody({
  view,
  actions,
  chiefName,
  brainName,
  openStep,
  onOpenStep,
  busyStep,
}: SetupChecklistBodyProps) {
  const expandedId = openStep ?? view.next;
  const percent = view.progress.total === 0 ? 0 : Math.round((view.progress.done / view.progress.total) * 100);
  return (
    <div className="flex min-h-0 flex-col">
      {/* Pinned at the top of the thread, above every card. */}
      <div className="sticky top-0 z-10 border-b border-hairline/40 bg-panel px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[13px] text-ink-secondary">
            {chiefName ? `${chiefName}, your Chief of Staff, is setting you up` : "Setting you up"}
          </p>
          <p data-setup-progress="" role="status" className="text-[13px] font-semibold text-ink">
            {setupProgressLabel(view)}
          </p>
        </div>
        <div
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-control"
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={view.progress.total}
          aria-valuenow={view.progress.done}
          aria-valuetext={setupProgressLabel(view)}
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <div className="flex flex-col gap-2.5 overflow-y-auto px-4 py-4">
        {view.steps.map((step) => (
          <SetupCard
            key={step.id}
            step={step}
            view={view}
            actions={actions}
            brainName={brainName}
            expanded={expandedId === step.id}
            busy={busyStep === step.id}
            onExpand={() => onOpenStep(step.id)}
          />
        ))}
      </div>
    </div>
  );
}
