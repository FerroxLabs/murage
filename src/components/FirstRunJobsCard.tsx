// STEPS FOUR AND FIVE, RENDERED.
//
// The behaviour of both was already built, tested and shipped as pure
// modules: `src/lib/first-run-jobs.ts` decides what each job still needs and
// where pressing it goes, `src/lib/first-run-flow.ts` reads what the person
// typed and assembles every result screen out of it. NOTHING RENDERED EITHER
// OF THEM. `firstRunCardBody` had no case for `jobs` or `do-it`, both fell to
// `default: return null`, and `FirstRunCard` returns null on a null body, so
// the last two steps of the flow drew literally nothing. Not a blank card:
// nothing. This file is the renderer half.
//
// THE SPLIT IN HERE IS THE SAME ONE THAT MADE THE MODULES TESTABLE. Every
// screen is a presentational component that takes the module's own output and
// renders it, and they are exported, so a test can put every machine and every
// possible input through the real components without a server, a clock or a
// DOM. The two stateful cards below hold nothing but where the person is and
// what they typed.
//
// WHAT IS NOT PERSISTED, AND WHY. The typed text and the parsed items live in
// this component for this session only. Restoring a half-typed day into a box
// the person has forgotten about is worse than asking again. The CHOSEN JOB is
// recorded, because `chat` is settled by "a job was chosen" and there is
// nothing on the machine to re-measure that from; the note is the job's id and
// it is what brings the two cards, which are two separate messages in the
// transcript, to the same subject.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { connectApp } from "@/lib/connect-app";
import { FIRST_RUN_COPY } from "@/lib/first-run-copy";
import { installFirstRunCrew } from "@/lib/first-run-crew";
import { engineRowTitle } from "@/lib/first-run-detect";
import {
  briefRoutineRequest,
  businessResult,
  dayResult,
  escapeHatchScreen,
  finishFirstRunJob,
  firstRunInputScreen,
  firstRunStage,
  notesResult,
  parseLines,
  researchResult,
  workingLines,
  type FirstRunBusinessResult,
  type FirstRunCrewReading,
  type FirstRunDayResult,
  type FirstRunFlowStage,
  type FirstRunInputScreen,
  type FirstRunItem,
  type FirstRunNotesResult,
  type FirstRunResearchResult,
} from "@/lib/first-run-flow";
import {
  FIRST_RUN_JOB_IDS,
  FIRST_RUN_JOB_SHAPES,
  afterConnect,
  chiefLead,
  chiefQuestion,
  chiefStatusLine,
  firstRunConnectScreen,
  firstRunJobRows,
  firstRunJobWorld,
  firstRunSearchRouting,
  typedMayShowWorking,
  typedReply,
  type FirstRunConnectScreen,
  type FirstRunJobId,
  type FirstRunJobNeed,
  type FirstRunJobRow,
  type FirstRunJobWorld,
  type FirstRunSearchRouting,
} from "@/lib/first-run-jobs";
import { FLUX_KEY_NOT_A_KEY, fluxBridge, readFluxStatus, saveFluxKey } from "@/lib/flux-key-paste";
import { useDesktopSurface } from "@/lib/use-surface";
import { api, useStore, type Bot } from "@/state/store";
import type { SetupJobApp, SetupView } from "../../shared/setup";
import {
  FIRST_RUN_CHIP,
  FIRST_RUN_FOCUS,
  FIRST_RUN_PRIMARY,
  FIRST_RUN_QUIET,
  FirstRunBubble,
  FirstRunFailure,
  FirstRunLine,
  FirstRunNote,
  answerSetupStep,
  createSetupRoutine,
  failureText,
  forgetSetupView,
  openOutside,
  reopenSetupStep,
  useSetupView,
} from "./FirstRunChrome";
import { FirstRunFluxConnect } from "./FirstRunFluxCard";
import { FLUX_SIGNUP_URL } from "./FluxRouterConnection";

const jobsCopy = FIRST_RUN_COPY.chat.jobs;
const flowCopy = FIRST_RUN_COPY.flow["do-it"];
const appsCopy = FIRST_RUN_COPY.apps.apps;

// ── what the two cards need to know about this machine ─────────────────

/**
 * The world the job rules read, built from the live view and from how a web
 * search would leave this computer.
 *
 * `/api/config` is read once. Until it answers, the routing is the DEFAULT
 * route rather than a guess: `firstRunSearchRouting(undefined)` is
 * `anonymous`, which is the route an unconfigured machine really takes, and
 * `researchNote` says nothing at all on it. So a slow config read costs a
 * sentence that would not have been shown anyway, rather than showing one
 * about an account the person may not have.
 */
export function useFirstRunWorld(view: SetupView | null): FirstRunJobWorld | null {
  const [search, setSearch] = useState<FirstRunSearchRouting | null>(null);
  useEffect(() => {
    let live = true;
    void api("/api/config")
      .then((config) => {
        if (live) setSearch(firstRunSearchRouting(config?.webSearch));
      })
      // A config this card could not read is not a reason to say anything
      // about somebody's search account.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return useMemo(() => (view ? firstRunJobWorld(view, search ?? "anonymous") : null), [view, search]);
}

/** The engine that is answering, named the way its owner names it, for the
 *  Chief's third status line. "" when nothing is, which that line has its own
 *  wording for. */
function engineName(view: SetupView | null): string {
  const first = view?.agents[0];
  return first ? engineRowTitle(first) : "";
}

/** The job the person chose, read back off the step that recorded it. A note
 *  from an older build, or from a job that no longer exists, reads as no
 *  choice rather than throwing its way into the card. */
export function chosenJob(view: SetupView | null): FirstRunJobId | null {
  const note = (view?.steps.find((step) => step.id === "chat")?.note ?? "").trim();
  return (FIRST_RUN_JOB_IDS as readonly string[]).includes(note) ? (note as FirstRunJobId) : null;
}

/**
 * "OR JUST TELL ME WHAT YOU NEED", CARRIED BETWEEN TWO MESSAGES.
 *
 * The escape hatch goes STRAIGHT to the notes box, past the connect screen,
 * which is the one place in this flow that deliberately skips a gate. The
 * jobs card and the do-it card are two separate messages in the transcript
 * and two separate components, so the fact has to live somewhere they can
 * both see.
 *
 * Session-scoped on purpose, and never persisted: it is a thing that happened
 * in this conversation, in this window, like the typed text beside it. A
 * restart puts the person back at the jobs, which is exactly what §8 asks for.
 */
let escaped = false;
export function takeEscapeHatch(): void {
  escaped = true;
}
export function tookEscapeHatch(): boolean {
  return escaped;
}
export function forgetEscapeHatch(): void {
  escaped = false;
}

// ── step four: what can I take off your plate ──────────────────────────

/**
 * A row as this card draws it. The tag and the note are the two things that
 * need the machine, so both are nullable, and on a view that has not arrived
 * they are simply absent rather than guessed at.
 */
type JobRowView = Pick<FirstRunJobRow, "id" | "title" | "sub" | "note"> & {
  tag: FirstRunJobRow["tag"] | null;
};

/**
 * THE FIVE JOBS BEFORE THE MACHINE IS KNOWN.
 *
 * The question, the titles and what each job is are true on every computer,
 * so they are shown. The TAG is not: "ready now" on a machine nobody has
 * looked at is exactly the small lie this release exists to delete, so the
 * rows arrive untagged and unpressable and fill in the moment the view lands.
 * `readSetupView` retries a failed read, so "the moment" really arrives.
 */
const UNKNOWN_ROWS: readonly JobRowView[] = jobsCopy.rows.map((row) => ({
  id: row.id,
  title: row.title,
  sub: row.sub,
  tag: null,
  note: null,
}));

/**
 * THE CHIEF'S OWN SCREEN.
 *
 * One question, five answers, and every row says live what it is still
 * waiting on. The tags are recomputed on every render from the view, so a
 * person who comes back from a browser window with Gmail connected sees it
 * immediately without pressing anything.
 *
 * A view that has not arrived yet still gets the question and the five rows,
 * because those are true on every machine. What it does NOT get is a tag or a
 * pressable row: "ready now" on a machine nobody has looked at is the exact
 * small lie this release exists to delete.
 */
export function FirstRunJobsCard({ settled }: { settled: boolean }) {
  const { view } = useSetupView();
  const world = useFirstRunWorld(view);
  const [busy, setBusy] = useState("");
  const [failure, setFailure] = useState("");
  const [acted, setActed] = useState(false);
  const done = acted || settled;

  const choose = async (id: FirstRunJobId, viaEscape: boolean) => {
    if (busy || done) return;
    setBusy(id);
    setFailure("");
    try {
      if (viaEscape) takeEscapeHatch();
      else forgetEscapeHatch();
      await answerSetupStep("chat", id);
      setActed(true);
    } catch (cause) {
      forgetEscapeHatch();
      setFailure(failureText(cause, flowCopy.failure));
    } finally {
      setBusy("");
    }
  };

  const rows: readonly JobRowView[] | null = world ? firstRunJobRows(world) : null;

  return (
    <FirstRunBubble>
      {world && <FirstRunLine quiet>{chiefStatusLine(world, engineName(view))}</FirstRunLine>}
      <div className="mt-2 text-[17px] font-semibold text-ink">{chiefQuestion(view?.ownerName ?? "")}</div>
      <FirstRunLine>{world ? chiefLead(world) : jobsCopy.lead}</FirstRunLine>

      <ul className="mt-3 grid gap-2">
        {(rows ?? UNKNOWN_ROWS).map((row, index) => (
          <li key={row.id}>
            <button
              type="button"
              disabled={done || !rows || busy === row.id}
              onClick={() => void choose(row.id, false)}
              className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left ${FIRST_RUN_FOCUS} ${
                index === 0 ? "border-accent/60" : "border-hairline/40"
              } bg-inset disabled:opacity-60`}
            >
              <span className="min-w-0">
                <span className="block text-[14px] font-medium text-ink">{row.title}</span>
                <span className="block text-[12.5px] leading-relaxed text-ink-secondary">{row.sub}</span>
              </span>
              {row.tag && (
                <span
                  className={`shrink-0 text-[12.5px] ${
                    row.tag.tone === "ready" ? "text-success" : row.tag.tone === "accent" ? "text-accent" : "text-ink-secondary"
                  }`}
                >
                  {row.tag.text}
                </span>
              )}
            </button>
            {row.note && <p className="mt-1 px-3 text-[12.5px] text-ink-secondary">{row.note}</p>}
          </li>
        ))}
      </ul>

      {!done && (
        <button
          type="button"
          disabled={!rows || Boolean(busy)}
          onClick={() => void choose("notes", true)}
          className={`mt-2 ${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}
        >
          {jobsCopy.escape}
        </button>
      )}
      <FirstRunFailure message={failure} />
    </FirstRunBubble>
  );
}

// ── step five: the screens, each one taking the module's own answer ────

/** A quiet eyebrow over a block, which is how every result screen separates
 *  its parts without a second heading. */
function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="mt-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">{children}</div>;
}

export function FirstRunConnectView({
  screen,
  busy,
  failure,
  desktop,
  onConnect,
  onSkipToInput,
  onElsewhere,
}: {
  screen: FirstRunConnectScreen;
  busy: FirstRunJobNeed | "";
  failure: string;
  desktop: boolean | undefined;
  onConnect: (need: FirstRunJobNeed) => void;
  onSkipToInput: () => void;
  onElsewhere: () => void;
}) {
  return (
    <FirstRunBubble>
      <div className="text-[15px] font-semibold text-ink">{screen.heading}</div>
      <FirstRunLine>{screen.lead}</FirstRunLine>
      {screen.appsUnreadable && <FirstRunLine quiet>{flowCopy.connect.unreadable}</FirstRunLine>}

      <ul className="mt-3 grid gap-2">
        {screen.rows.map((row) => (
          <li key={row.need} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-inset px-3 py-2">
            <span className="min-w-0">
              <span className="block text-[14px] text-ink">{row.bold}</span>
              <span className="block text-[12.5px] leading-relaxed text-ink-secondary">{row.small}</span>
            </span>
            {/* The key is pasted in here; an app sign-in happens in a browser
                window this machine has to be able to open. Never a button
                that cannot work: a phone is told where the switch is. */}
            {row.need === "flux" || desktop === true ? (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => onConnect(row.need)}
                className={`${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS} shrink-0`}
              >
                {busy === row.need ? appsCopy.connecting : appsCopy.connect}
              </button>
            ) : (
              <span className="text-[12.5px] text-ink-secondary">{appsCopy.desktopOnly}</span>
            )}
          </li>
        ))}
      </ul>

      <FirstRunFailure message={failure} />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {screen.skipToInput && (
          <button type="button" disabled={Boolean(busy)} onClick={onSkipToInput} className={`${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
            {screen.skipToInput}
          </button>
        )}
        <button type="button" disabled={Boolean(busy)} onClick={onElsewhere} className={`${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
          {screen.elsewhere}
        </button>
      </div>
    </FirstRunBubble>
  );
}

/** THE BOX, AND THE PLACEHOLDER STAYS A PLACEHOLDER. An earlier version
 *  pre-filled the notes box with example text and it was caught in review:
 *  text in the box is the person's, always. */
export function FirstRunInputView({
  screen,
  value,
  busy,
  onChange,
  onGo,
  onElsewhere,
}: {
  screen: FirstRunInputScreen;
  value: string;
  busy: boolean;
  onChange: (next: string) => void;
  onGo: () => void;
  onElsewhere: () => void;
}) {
  return (
    <FirstRunBubble>
      <div className="text-[15px] font-semibold text-ink">{screen.heading}</div>
      <FirstRunLine>{screen.lead}</FirstRunLine>
      {screen.connectedLine && <FirstRunLine quiet>{screen.connectedLine}</FirstRunLine>}
      <label className="mt-3 block">
        <span className="sr-only">{screen.heading}</span>
        <textarea
          aria-label={screen.heading}
          rows={screen.rows}
          value={value}
          disabled={busy}
          placeholder={screen.placeholder}
          onChange={(event) => onChange(event.target.value)}
          className={`w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] leading-relaxed text-ink ${FIRST_RUN_FOCUS}`}
        />
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy || !value.trim()} onClick={onGo} className={`${FIRST_RUN_PRIMARY} ${FIRST_RUN_FOCUS}`}>
          {screen.go}
        </button>
        <button type="button" disabled={busy} onClick={onElsewhere} className={`${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
          {screen.elsewhere}
        </button>
      </div>
    </FirstRunBubble>
  );
}

/** The three counted lines, revealed in order. Every number in them came off
 *  what the person typed. */
export function FirstRunWorkingView({ lines, shown }: { lines: readonly string[]; shown: number }) {
  return (
    <FirstRunBubble>
      <div role="status">
        {lines.slice(0, Math.max(1, shown)).map((line, index) => (
          <p
            key={line}
            className={index === lines.length - 1 ? "mt-2 text-[15px] font-semibold text-ink" : "mt-2 text-[15px] text-ink-secondary"}
          >
            {line}
          </p>
        ))}
      </div>
    </FirstRunBubble>
  );
}

function ResultColumn({ column }: { column: FirstRunDayResult["fixed"] }) {
  return (
    <div className="min-w-0 flex-1 basis-48">
      <Eyebrow>{column.heading}</Eyebrow>
      {column.items.length === 0 ? (
        <p className="mt-1 text-[13px] text-ink-secondary">{column.empty}</p>
      ) : (
        <ul className="mt-1 grid gap-1">
          {column.items.map((item) => (
            <li key={item} className="text-[13.5px] text-ink">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function FirstRunDayResultView({
  result,
  busy,
  failure,
  onMorning,
  onAgain,
}: {
  result: FirstRunDayResult;
  busy: boolean;
  failure: string;
  onMorning: () => void;
  onAgain: () => void;
}) {
  return (
    <FirstRunBubble>
      <div className="text-[17px] font-semibold text-ink">{result.header}</div>
      <FirstRunLine quiet>{result.provenance}</FirstRunLine>

      <Eyebrow>{result.riskEyebrow}</Eyebrow>
      {result.risk ? (
        <>
          <FirstRunLine>{result.risk.line}</FirstRunLine>
          <FirstRunLine quiet>{result.risk.reason}</FirstRunLine>
          <FirstRunLine quiet>{result.risk.advice}</FirstRunLine>
        </>
      ) : (
        <>
          <FirstRunLine>{result.calm!.body}</FirstRunLine>
          <FirstRunLine quiet>{result.calm!.second}</FirstRunLine>
        </>
      )}

      <div className="mt-2 flex flex-wrap gap-4">
        <ResultColumn column={result.fixed} />
        <ResultColumn column={result.waiting} />
      </div>

      {result.morning && (
        <div className="mt-4 rounded-xl border border-hairline/50 bg-inset px-3 py-2.5">
          <div className="text-[14px] font-semibold text-ink">{result.morning.heading}</div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{result.morning.body}</p>
          {result.morning.taken ? (
            <FirstRunNote>{result.morning.taken}</FirstRunNote>
          ) : (
            <button type="button" disabled={busy} onClick={onMorning} className={`mt-2 ${FIRST_RUN_PRIMARY} ${FIRST_RUN_FOCUS}`}>
              {busy ? result.morning.working : result.morning.button}
            </button>
          )}
          <FirstRunFailure message={failure} />
        </div>
      )}

      <button type="button" onClick={onAgain} className={`mt-3 ${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
        {result.again}
      </button>
    </FirstRunBubble>
  );
}

export function FirstRunNotesResultView({ result, onAgain }: { result: FirstRunNotesResult; onAgain: () => void }) {
  return (
    <FirstRunBubble>
      <div className="text-[17px] font-semibold text-ink">{result.header}</div>
      <FirstRunLine quiet>{result.provenance}</FirstRunLine>
      <Eyebrow>{result.eyebrow}</Eyebrow>
      {result.empty ? (
        <FirstRunLine>{result.empty}</FirstRunLine>
      ) : (
        <ol className="mt-1 grid gap-1.5">
          {result.steps.map((step, index) => (
            <li key={`${index}-${step.text}`} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-inset px-3 py-2">
              <span className="min-w-0 text-[13.5px] text-ink">{step.text}</span>
              <span className="shrink-0 text-[12.5px] text-ink-secondary">{step.tag}</span>
            </li>
          ))}
        </ol>
      )}
      <FirstRunLine quiet>{result.caveat}</FirstRunLine>
      <button type="button" onClick={onAgain} className={`mt-3 ${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
        {result.again}
      </button>
    </FirstRunBubble>
  );
}

/**
 * The research job's answer arrives in the THREAD, not in this card.
 *
 * The topic was sent as an ordinary message from the person, exactly as the
 * composer sends one, so the Chief answers it below in its own voice with
 * whatever engine this machine routes to. That is the honest wiring: this
 * card has no model behind it and must not draw a box that looks like one.
 * What it does own is the one thing the module decided, which is whether to
 * say that a bigger model would read this faster.
 *
 * AND WHETHER THE QUESTION GOT THERE AT ALL. This screen took no failure, so
 * the card's own `setFailure` had nowhere to appear on the one job whose
 * whole result lives somewhere else: a send the server refused drew this
 * screen unchanged, with its quiet return button, saying nothing. That is the
 * one thing the person cannot check for themselves, because the answer they
 * are waiting for is in a thread that will never get one.
 */
export function FirstRunResearchResultView(
  { result, failure = "", onAgain }: { result: FirstRunResearchResult; failure?: string; onAgain: () => void },
) {
  return (
    <FirstRunBubble>
      {result.onLocal && <FirstRunLine quiet>{result.onLocal}</FirstRunLine>}
      <FirstRunFailure message={failure} />
      <button type="button" onClick={onAgain} className={`mt-2 ${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
        {result.again}
      </button>
    </FirstRunBubble>
  );
}

/**
 * THE SCREEN THAT COULD NOT BE ASSEMBLED, WHICH IS STILL A SCREEN.
 *
 * Every screen builder in the two modules can return null on purpose: a
 * connect screen with nothing left missing and an input screen for a job with
 * no box are both "there is nothing here to draw", and null is the honest
 * answer to give the card. What the CARD may not do with that null is render
 * a lead with nothing under it, or render nothing at all. Both shapes have
 * shipped in this release already.
 *
 * `firstRunStage` now makes both cases unreachable by dropping a pin the
 * moment it stops being drawable. This is what would be drawn if one ever
 * were, and like every other screen in the flow it carries the way back.
 */
export function FirstRunLostView({ onAgain }: { onAgain: () => void }) {
  return (
    <FirstRunBubble>
      <FirstRunLine>{flowCopy.lost}</FirstRunLine>
      <button type="button" onClick={onAgain} className={`mt-3 ${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
        {flowCopy.again}
      </button>
    </FirstRunBubble>
  );
}

/**
 * THE CREW IS STILL INSTALLING, OR IT REFUSED.
 *
 * The result screen names two bots and a review, and it must not draw any of
 * that before the install has answered: a screen describing a crew the person
 * did not get is the worst thing to be wrong about, because it is the first
 * claim in the whole first run they can go and check.
 *
 * So this says the one thing that is true either way, and it carries the way
 * back. A refusal that left the three working lines on screen with nothing
 * under them would be the blank body this release is about, wearing a
 * sentence.
 */
export function FirstRunCrewWaitingView({ failure, onAgain }: { failure: string; onAgain: () => void }) {
  return (
    <FirstRunBubble>
      <FirstRunLine>{flowCopy.working.businessShape}</FirstRunLine>
      <FirstRunFailure message={failure} />
      <button type="button" onClick={onAgain} className={`mt-3 ${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
        {flowCopy.again}
      </button>
    </FirstRunBubble>
  );
}

export function FirstRunBusinessResultView({
  result,
  busy,
  taken,
  failure,
  onSwitchOn,
  onAgain,
}: {
  result: FirstRunBusinessResult;
  busy: boolean;
  taken: boolean;
  failure: string;
  onSwitchOn: () => void;
  onAgain: () => void;
}) {
  return (
    <FirstRunBubble>
      <div className="text-[17px] font-semibold text-ink">{result.header}</div>
      <FirstRunLine quiet>{result.lead}</FirstRunLine>
      <Eyebrow>{result.botsEyebrow}</Eyebrow>
      <ul className="mt-1 grid gap-1.5">
        {result.bots.map((bot) => (
          <li key={bot.name} className="rounded-lg bg-inset px-3 py-2">
            <span className="block text-[14px] text-ink">{bot.name}</span>
            {bot.role && <span className="block text-[12.5px] text-ink-secondary">{bot.role}</span>}
          </li>
        ))}
      </ul>
      {result.reviewEyebrow && <Eyebrow>{result.reviewEyebrow}</Eyebrow>}
      {result.reviewLine && <FirstRunLine>{result.reviewLine}</FirstRunLine>}
      {result.offer && (
        <div className="mt-2">
          {taken ? (
            <FirstRunNote>{result.offer.taken}</FirstRunNote>
          ) : (
            <button type="button" disabled={busy} onClick={onSwitchOn} className={`${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS}`}>
              {result.offer.label}
            </button>
          )}
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{result.offer.why}</p>
        </div>
      )}
      <FirstRunFailure message={failure} />
      <button type="button" onClick={onAgain} className={`mt-3 ${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
        {result.again}
      </button>
    </FirstRunBubble>
  );
}

// ── step five, joined up ───────────────────────────────────────────────

const WORKING_STEP_MS = 400;
const WORKING_TOTAL_MS = 2_300;
/** How long the card waits for the server to acknowledge the research send
 *  before calling it not gone through. Generous enough to cover a slow write
 *  and a queued turn, short enough that nobody is left watching a spinner
 *  over a route that is never going to answer. */
const SEND_WAIT_MS = 20_000;

/**
 * THE CHOSEN JOB, FROM WHAT IT NEEDS THROUGH TO ITS RESULT.
 *
 * One card and four stages, because the whole of step five is one scene: they
 * picked a job, it asked for what it needed, they typed, it worked, here is
 * the answer. Every stage's words come out of the two modules; nothing is
 * decided here except where the person is.
 */
export function FirstRunDoItCard({ bot, settled }: { bot: Bot; settled: boolean }) {
  // NOTHING ON A RESULT SCREEN IS AN OPEN QUESTION. Every other card in this
  // flow hides its controls once the server says the step landed; this one's
  // only control is "take something else off my plate", which is the way back
  // to the Chief and is still the right offer afterwards.
  void settled;
  const { view } = useSetupView();
  const { dispatch } = useStore();
  const world = useFirstRunWorld(view);
  const desktop = useDesktopSurface();
  const id = chosenJob(view);
  const job = id ? FIRST_RUN_JOB_SHAPES[id] : null;

  const [moved, setStage] = useState<FirstRunFlowStage | null>(null);
  const [typed, setTyped] = useState("");
  const [items, setItems] = useState<readonly FirstRunItem[]>([]);
  const [shown, setShown] = useState(1);
  const [busyNeed, setBusyNeed] = useState<FirstRunJobNeed | "">("");
  const [pasting, setPasting] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [crew, setCrew] = useState<FirstRunCrewReading | null>(null);
  const [briefTaken, setBriefTaken] = useState(false);
  const [reviewTaken, setReviewTaken] = useState(false);
  const gone = useRef(false);
  /** The research send, in flight since they pressed go. Held here rather
   *  than in state because it is not something a render reads: it is the one
   *  thing `finish` has to wait for before the step may be settled. */
  const sending = useRef<Promise<void> | null>(null);

  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
    };
  }, []);

  // WHERE THIS JOB STARTS, DERIVED RATHER THAN SET BY AN EFFECT.
  //
  // The module already answers "where does pressing this job go", so the
  // first screen is a computation, not a state change. An effect would mean
  // one render with no stage at all, which on this card is one frame of the
  // exact blank body this whole release is about.
  //
  // `moved` wins once the person has moved, because after that they are
  // driving and a re-render because a poll landed must not throw them back to
  // the connect screen they have just come through. BUT A PIN MUST NOT
  // OUTLIVE THE STATE IT WAS PINNED AGAINST, which is why this is a rule in
  // the module rather than a `??` here: a `connect` pinned against "two
  // things are missing" used to win for ever, so a second account completed
  // in a browser tab left the card with a lead and nothing else. The escape
  // hatch is the one path that skips the gate: the notes job reaches for no
  // account, and asking for a key before letting somebody type a sentence is
  // the form this release exists to delete.
  const stage: FirstRunFlowStage | null = firstRunStage(job, world, moved, tookEscapeHatch());

  /**
   * The ordinary send, exactly as the composer sends, AND HEARD BACK FROM.
   *
   * The question is theirs, so it belongs in the transcript as their message
   * and the Chief answers it below in its own voice. What changed is that the
   * card now waits for the server's own answer: a bare dispatch reports
   * nothing at all, so a refused write, a signed-out engine or a dead provider
   * were indistinguishable from a delivered question, and the step was
   * recorded complete over every one of them.
   *
   * Bounded, because the other way to be wrong here is a spinner that never
   * ends. A send the server has not acknowledged inside the wait is reported
   * as not gone through, which is the honest reading of it.
   */
  const sendResearch = (text: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const late = setTimeout(() => reject(new Error(flowCopy.failure)), SEND_WAIT_MS);
      dispatch({
        type: "send",
        botId: bot.id,
        text,
        threadId: bot.threadId,
        onSent: () => {
          clearTimeout(late);
          resolve();
        },
        // True: the failure is shown on this card, where it happened, so the
        // store adds no toast over the top of it.
        onError: (cause) => {
          clearTimeout(late);
          reject(cause);
          return true;
        },
      });
    });

  const finish = async () => {
    if (!job) return;
    try {
      await finishFirstRunJob(job, {
        install: async () => {
          const installed = await installFirstRunCrew(api);
          if (!gone.current) setCrew(installed);
        },
        // Started when they pressed go, so the three counted lines are the
        // send's own latency rather than a cover for nothing having happened.
        // Only dispatched here if something reached this stage another way.
        send: () => sending.current ?? sendResearch(typed.trim()),
        settle: async () => {
          setStage("result");
          await answerSetupStep("flow", job.id);
        },
        gone: () => gone.current,
      });
    } catch (cause) {
      if (gone.current) return;
      setFailure(failureText(cause, flowCopy.failure));
      setStage("result");
    }
  };

  // The three counted lines, then the answer. Cleared on the way out, so a
  // card unmounted mid-count leaves no timer behind it.
  useEffect(() => {
    if (stage !== "working") return;
    const timers = [
      setTimeout(() => setShown(2), WORKING_STEP_MS),
      setTimeout(() => setShown(3), WORKING_STEP_MS * 2),
      setTimeout(() => void finish(), WORKING_TOTAL_MS),
    ];
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  /** Back to the Chief, with the job, the text and the parsed items cleared.
   *  None of the three was ever persisted; the choice was, so it is the one
   *  thing that has to be put back. */
  const elsewhere = async () => {
    setTyped("");
    setItems([]);
    setStage(null);
    setFailure("");
    // A send that belonged to the job they have just left must not be what
    // the NEXT job waits for.
    sending.current = null;
    forgetEscapeHatch();
    try {
      await reopenSetupStep("chat");
    } catch (cause) {
      setFailure(failureText(cause, flowCopy.failure));
    }
  };

  const connect = async (need: FirstRunJobNeed) => {
    if (!job || !world || busyNeed) return;
    if (need === "flux") {
      void openOutside(FLUX_SIGNUP_URL);
      setPasting(true);
      return;
    }
    if (desktop !== true) return;
    setBusyNeed(need);
    setFailure("");
    try {
      const result = await connectApp(need as SetupJobApp, {
        request: api,
        openExternal: openOutside,
        desktop,
        cancelled: () => gone.current,
      });
      if (gone.current) return;
      if (!result.connected) return;
      // Connecting the LAST missing thing advances by itself. Making somebody
      // press a second button to start the work they already asked for is a
      // form.
      const now: FirstRunJobWorld = { ...world, connected: [...world.connected, need], appsUnreadable: false };
      setStage(afterConnect(job, now));
      forgetSetupView();
    } catch (cause) {
      if (!gone.current) setFailure(failureText(cause, appsCopy.failure));
    } finally {
      if (!gone.current) setBusyNeed("");
    }
  };

  const saveKey = async () => {
    if (!job || !world || busy || !key.trim()) return;
    setBusy(true);
    setFailure("");
    try {
      const status = await readFluxStatus(api);
      await saveFluxKey(key, { status, bridge: fluxBridge(), request: api, desktop: desktop === true });
      setKey("");
      setPasting(false);
      setStage(afterConnect(job, { ...world, fluxReady: true }));
      forgetSetupView();
    } catch (cause) {
      setFailure(failureText(cause, flowCopy.failure));
    } finally {
      setBusy(false);
    }
  };

  const morning = async () => {
    if (busy) return;
    setBusy(true);
    setFailure("");
    try {
      await createSetupRoutine(briefRoutineRequest());
      setBriefTaken(true);
    } catch (cause) {
      setFailure(failureText(cause, flowCopy.morning.failure));
    } finally {
      setBusy(false);
    }
  };

  // A job that has not been chosen yet is not this card's to guess at. It is
  // never the normal case: the server only plans this card once `chat` is
  // settled, and `chat` is settled by a recorded job id.
  if (!job || !id || !world) return null;

  if (pasting) {
    return (
      <FirstRunFluxConnect
        value={key}
        busy={busy}
        failure={failure}
        onChange={(next) => {
          setKey(next);
          if (failure === FLUX_KEY_NOT_A_KEY) setFailure("");
        }}
        onSubmit={() => void saveKey()}
        onAgain={() => void openOutside(FLUX_SIGNUP_URL)}
        onCancel={() => setPasting(false)}
      />
    );
  }

  if (stage === "connect") {
    const screen = firstRunConnectScreen(job, world);
    // UNREACHABLE, AND DRAWN ANYWAY. `firstRunStage` drops a pin the moment
    // it stops being drawable, so a connect stage with nothing missing no
    // longer arrives here. It used to, and what it rendered was the generic
    // lead on its own: no advance, no input, no control. A card that renders
    // a lead and nothing else is the same failure class as the blank cards
    // this release has already shipped twice, so the null case gets a screen
    // with words and a way off it rather than a body that is not there.
    if (!screen) return <FirstRunLostView onAgain={() => void elsewhere()} />;
    return (
      <FirstRunConnectView
        screen={screen}
        busy={busyNeed}
        failure={failure}
        desktop={desktop}
        onConnect={(need) => void connect(need)}
        onSkipToInput={() => setStage("input")}
        onElsewhere={() => void elsewhere()}
      />
    );
  }

  if (stage === "input") {
    const screen = tookEscapeHatch() ? escapeHatchScreen(world) : firstRunInputScreen(job, world);
    // The same rule, and this one used to return null outright: a job with no
    // box, pinned to the input stage, drew literally nothing.
    if (!screen) return <FirstRunLostView onAgain={() => void elsewhere()} />;
    return (
      <FirstRunInputView
        screen={screen}
        value={typed}
        busy={busy}
        onChange={setTyped}
        onGo={() => {
          setItems(parseLines(typed));
          setShown(1);
          // NOTHING SPINS WHEN THERE IS NOTHING BEHIND IT. On a machine with
          // nothing to think with and no key the box keeps what they wrote and
          // says so; a working state there is a wait that never ends.
          const working = typedMayShowWorking(world);
          // THE WORK STARTS HERE, NOT AFTER THE THEATRE. The three counted
          // lines used to play out in full and the send fired afterwards, from
          // the same timer that then recorded the step done. Sending now means
          // those lines cover a real wait, and `finish` has something to have
          // heard back from by the time it settles anything.
          if (id === "research" && working) {
            const started = sendResearch(typed.trim());
            // The real handling is in `finish`, which awaits this. The empty
            // catch is only so a send that fails during the counted lines is
            // not reported as an unhandled rejection before anyone asks.
            started.catch(() => {});
            sending.current = started;
          }
          setStage(working ? "working" : "result");
        }}
        onElsewhere={() => void elsewhere()}
      />
    );
  }

  if (stage === "working") {
    return <FirstRunWorkingView lines={workingLines(id, items, typed)} shown={shown} />;
  }

  if (stage !== "result") return null;

  const kept = typedReply(world);
  if (kept && id !== "business") {
    return (
      <FirstRunBubble>
        <FirstRunLine>{kept}</FirstRunLine>
        <button type="button" onClick={() => void elsewhere()} className={`mt-3 ${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
          {flowCopy.again}
        </button>
      </FirstRunBubble>
    );
  }

  if (id === "brief" || id === "day") {
    return (
      <FirstRunDayResultView
        result={dayResult(job, items, world, briefTaken)}
        busy={busy}
        failure={failure}
        onMorning={() => void morning()}
        onAgain={() => void elsewhere()}
      />
    );
  }
  if (id === "notes") return <FirstRunNotesResultView result={notesResult(items)} onAgain={() => void elsewhere()} />;
  if (id === "research") {
    return (
      <FirstRunResearchResultView
        result={researchResult(world)}
        failure={failure}
        onAgain={() => void elsewhere()}
      />
    );
  }
  // The crew, described from the package rather than from memory. Until the
  // install answers there is nothing true to say about what they got, and if
  // it refused there has to be a way off this screen.
  if (!crew) return <FirstRunCrewWaitingView failure={failure} onAgain={() => void elsewhere()} />;
  return (
    <FirstRunBusinessResultView
      result={businessResult(crew)}
      busy={busy}
      taken={reviewTaken}
      failure={failure}
      onSwitchOn={() => setReviewTaken(true)}
      onAgain={() => void elsewhere()}
    />
  );
}
