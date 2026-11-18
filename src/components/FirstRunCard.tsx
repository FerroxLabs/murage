// THE FIRST RUN, AS MESSAGES IN THE CHIEF OF STAFF'S THREAD.
//
// One dispatch, one component per card. The card on the wire says only which
// step and which variant it is (shared/setup-card.ts) and is read through
// `readSetupCard`, the same defensive gate `readIntakeCard` applies: a card
// from a newer build, or a restored transcript, must never throw its way
// into the message list.
//
// WHY THIS SHAPE AT ALL. The version this replaces was three stacked
// onboarding surfaces, the main one an eight card modal whose buttons
// dropped the person into a settings pane. The verdict on it was plain: it
// should boot into a chat with your chief of staff, and the chief guides you
// through setting it up. So every card here is a bubble in a transcript that
// is still there tomorrow, every action happens where the person is
// standing, and nothing sends anybody to Settings.

import { LazyFirstRunPhoneCard } from "./FirstRunPhoneCardLazy";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { FIRST_RUN_COPY, stepHeadingFor } from "@/lib/first-run-copy";
import { permissionModeOf } from "@/lib/permission-mode";
import { inNativeShell } from "@/lib/native-shell";
import { useDesktopSurface } from "@/lib/use-surface";
import { isCloudHome } from "@/lib/cloud-workspace";
import { uxCloud } from "@/lib/cloud-ux-copy";
import { firstRunDetection, type FirstRunEngineRow } from "@/lib/first-run-detect";
import type { Bot, Message } from "@/state/store";
import { renderBriefHtml } from "../../shared/brief-html";
import { trustedPreviewDocument, useSanitizerReady } from "@/lib/trusted-html";
import { sampleBrief } from "../../shared/brief-sample";
import { readSetupCard, type SetupCardVariant } from "../../shared/setup-card";
import { SETUP_DETECT_ANSWER } from "../../shared/setup";
import { FirstRunAppsCard } from "./FirstRunAppsCard";
import { FirstRunBriefCard, FirstRunBriefRanCard, FirstRunMoreRoutinesCard } from "./FirstRunBriefCard";
import {
  FIRST_RUN_CHIP,
  FIRST_RUN_FOCUS,
  FIRST_RUN_PRIMARY,
  FIRST_RUN_QUIET,
  FirstRunBubble,
  FirstRunFailure,
  FirstRunLine,
  answerSetupStep,
  failureText,
  skipSetupStep,
  forgetSetupView,
  useSetupReadGaveUp,
  useSetupView,
} from "./FirstRunChrome";
import { FirstRunFluxCard, FirstRunNoKeyCard } from "./FirstRunFluxCard";
import { FirstRunHelloCard } from "./FirstRunHelloCard";
import { FirstRunDoItCard, FirstRunJobsCard } from "./FirstRunJobsCard";
import { FirstRunNextCard } from "./FirstRunNextCard";
import { FirstRunNotifyCard } from "./FirstRunNotifyCard";
import { FirstRunHireCard } from "./FirstRunHireCard";
import { FirstRunMoveGrokCard } from "./FirstRunMoveGrokCard";
import { SandboxedFrame } from "./SandboxedFrame";

export function FirstRunCard({ bot, message }: { bot: Bot; message: Message }) {
  const desktop = useDesktopSurface();
  const card = readSetupCard(message.card);
  if (!card) return null;
  const settled = Boolean(card.settled);
  // The first-run checklist is the computer's (server/route-policy.ts makes
  // every /api/setup route desktop-only), so a phone can neither read a step
  // nor skip one. A step drawn there sat on its waiting line for good. The
  // phone says where the step finishes; a step already done is history the
  // computer keeps.
  if (inNativeShell() || desktop === false) {
    return settled ? null : (
      <FirstRunBubble>
        <FirstRunLine quiet>{FIRST_RUN_COPY.elsewhere}</FirstRunLine>
      </FirstRunBubble>
    );
  }
  // Not known yet is not the computer: a phone browser would otherwise show
  // the computer's controls for the moment the question takes.
  if (desktop === undefined) return null;
  // A Cloud home has no engines of its own to look for and no Flux key to offer: those two cards are never drawn, and their
  // steps are passed over by themselves so the flow goes straight on to the jobs.
  if (isCloudHome()) {
    const passed = CLOUD_PASSED_CARDS[card.variant];
    if (passed !== undefined) return passed === "none" ? null : <CloudPassedStep step={passed} settled={settled} />;
  }
  const heading = stepHeadingFor(card.variant);
  const body = firstRunCardBody(bot, message, card.variant, settled);
  if (!body) return null;
  if (!heading) return body;
  return (
    <div className="w-full min-w-0">
      <FirstRunStepHeading>{heading}</FirstRunStepHeading>
      {body}
    </div>
  );
}

/** Cards a Cloud home never draws: the step each one asks for, or "none" for a card that only reports. */
const CLOUD_PASSED_CARDS: Partial<Record<SetupCardVariant, "detect" | "flux" | "none">> = {
  found: "detect",
  bare: "detect",
  "signed-out": "detect",
  key: "flux",
  "no-key": "none",
  "bare-needs-key": "none",
  "sample-brief": "none",
};

/** Whether a Cloud home should pass this step over now: not once it is settled, not before the view has answered. The Flux
 *  step is passed over unless it is already done or passed: a saved key whose payment was refused leaves it blocked, and a
 *  Cloud customer is never held there (a real problem with credits is said later, in plain words, not by a card that is
 *  never drawn). */
export function cloudPassWanted(
  step: "detect" | "flux",
  view: { fluxReady: boolean; steps?: readonly { id: string; status: string }[] } | null,
  settled: boolean,
): boolean {
  if (settled || view === null) return false;
  if (step !== "flux") return true;
  const status = view.steps?.find((row) => row.id === "flux")?.status;
  return status !== "done" && status !== "skipped";
}

/** What a Cloud passed step shows, in one place so each state can be tested: every state that is not quiet is a visible
 *  line with a working button. "passing" is quiet only while the pass is in flight, and a failed pass becomes "passFailed". */
export type CloudPassState = "settled" | "passing" | "readFailed" | "passFailed";
export function cloudPassState(input: { settled: boolean; view: unknown; readGaveUp: boolean; failure: string }): CloudPassState {
  if (input.settled) return "settled";
  if (input.failure) return "passFailed";
  if (input.view === null && input.readGaveUp) return "readFailed";
  return "passing";
}

/** The one call that passes a step over: `detect` is answered the way its own button answers it, `flux` is skipped. */
export function passCloudStep(
  step: "detect" | "flux",
  deps: { answer: typeof answerSetupStep; skip: typeof skipSetupStep } = { answer: answerSetupStep, skip: skipSetupStep },
): Promise<void> {
  return step === "detect" ? deps.answer("detect", SETUP_DETECT_ANSWER) : deps.skip("flux");
}

/**
 * Passes a step over for a Cloud home and draws nothing, unless that fails: then one plain line and a way to try again.
 * `detect` is answered the way its own button answers it. `flux` is skipped only while no Flux key is saved; with a key the
 * step finishes by itself.
 */
function CloudPassedStep({ step, settled }: { step: "detect" | "flux"; settled: boolean }) {
  const { view } = useSetupView();
  const readGaveUp = useSetupReadGaveUp();
  const [failure, setFailure] = useState("");
  const [tries, setTries] = useState(0);
  const ready = cloudPassWanted(step, view, false);
  useEffect(() => {
    if (settled || !ready) return;
    let live = true;
    void passCloudStep(step).catch((cause) => {
      if (live) setFailure(failureText(cause, uxCloud("ux.cloud.firstRun.stepFailed")));
    });
    return () => { live = false; };
  }, [step, settled, ready, tries]);
  const state = cloudPassState({ settled, view, readGaveUp, failure });
  if (state === "readFailed") {
    return (
      <FirstRunBubble>
        <FirstRunFailure message={uxCloud("ux.cloud.firstRun.stepFailed")} />
        <button type="button" className={`${FIRST_RUN_PRIMARY} ${FIRST_RUN_FOCUS} mt-2`} onClick={() => forgetSetupView()}>
          {uxCloud("ux.cloud.firstRun.tryAgain")}
        </button>
      </FirstRunBubble>
    );
  }
  if (state !== "passFailed") return null;
  return (
    <FirstRunBubble>
      <FirstRunFailure message={failure} />
      <button type="button" className={`${FIRST_RUN_PRIMARY} ${FIRST_RUN_FOCUS} mt-2`} onClick={() => { setFailure(""); setTries((n) => n + 1); }}>
        {uxCloud("ux.cloud.firstRun.continue")}
      </button>
    </FirstRunBubble>
  );
}

/**
 * A rule across the page with the step's name on it.
 *
 * Deliberately quiet: this is punctuation, not a headline. It exists so the
 * eye has somewhere to stop on a thread that scrolls, and so somebody
 * returning tomorrow can see which part they are in.
 */
function FirstRunStepHeading({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 mt-4 flex items-center gap-3 first:mt-0" role="separator" aria-label={String(children)}>
      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-secondary">{children}</span>
      <span className="h-px flex-1 bg-hairline/50" aria-hidden="true" />
    </div>
  );
}

function firstRunCardBody(bot: Bot, message: Message, variant: SetupCardVariant, settled: boolean) {
  void message;
  switch (variant) {
    case "welcome":
      return <FirstRunHelloCard settled={settled} bot={bot} />;
    case "found":
      return <FirstRunAgentsCard bot={bot} settled={settled} />;
    case "bare":
      return <FirstRunBareAgentsCard settled={settled} onward />;
    case "signed-out":
      return <FirstRunSignedOutAgentsCard settled={settled} />;
    case "sample-brief":
      return <FirstRunSampleBriefCard />;
    case "key":
      // §1.5: the example brief is the Flux card's hook, shown first,
      // because the picture earns the ask. One card key, two parts.
      return (
        <div className="w-full min-w-0">
          <FirstRunSampleBriefCard hook />
          <FirstRunFluxCard settled={settled} />
        </div>
      );
    case "no-key":
      return <FirstRunNoKeyCard />;
    case "jobs":
      return <FirstRunJobsCard settled={settled} bot={bot} />;
    case "do-it":
      return <FirstRunDoItCard bot={bot} settled={settled} />;
    case "notify":
      return <FirstRunNotifyCard settled={settled} />;
    case "hire":
      return <FirstRunHireCard settled={settled} bot={bot} />;
    case "move-grok":
      return <FirstRunMoveGrokCard settled={settled} bot={bot} />;
    // ── PARKED, AND THEREFORE HISTORY. ───────────────────────────────────
    //
    // WHAT AN UPGRADING 0.1.57 INSTALL SEES, DECIDED. W16 re-cut six steps to
    // five, so `SETUP_STATE_VERSION` went 2 to 3 and the checklist resets:
    // `loadState` does not recognise a file naming `agents`, `apps`, `brief`
    // and `routines`, and starts fresh. But the OLD CARDS ARE STILL IN THAT
    // PERSON'S TRANSCRIPT, and they were built against steps that no longer
    // exist. Their controls write through `PARKED_CARD_STEP`, which is `flow`
    // — so pressing "Not now" on a Gmail card from last week would settle the
    // new flow's final step, and a brief card would attach a routine to a
    // step about something else entirely.
    //
    // So a parked card renders SETTLED, always. It is a record of what was
    // said then, it reads correctly, and nothing on it can be pressed into a
    // step it was never about. Nothing is deleted and nothing is hidden: the
    // words stay exactly as they were, which is the point of a transcript.
    case "bare-needs-key":
      // PARKED, AND THE ONE PARKED FOR BEING A DEAD END RATHER THAN FOR
      // BELONGING TO A DELETED STEP. It was the Flux step's opening on a
      // blank machine: two sentences, no control, and the only box that takes
      // a key on a card the server showed only to machines that did not need
      // one. The Flux step opens on `key` on every machine now, and the Flux
      // card carries this card's words itself when the machine is blank.
      //
      // Settled, like the rest of the park: it is a record of what was said,
      // it reads correctly, and the real Flux card arrives beneath it because
      // that card has a different key.
      return <FirstRunBareAgentsCard needsKey settled />;
    case "apps":
      return <FirstRunAppsCard settled />;
    case "brief":
      return <FirstRunBriefCard settled />;
    case "brief-ran":
      return <FirstRunBriefRanCard />;
    case "more-routines":
      return <FirstRunMoreRoutinesCard settled />;
    case "next":
      // The only parked card with no step to write. Its offers are ordinary
      // sends into the thread, which is a thing a person may still want to
      // do, and which cannot settle anything.
      return <FirstRunNextCard bot={bot} />;
    case "phone":
    case "phone-needs-tailscale":
      // Both land on one component on purpose: which of the two is honest is
      // decided by probing this machine, not by what the server guessed.
      return <LazyFirstRunPhoneCard settled />;
    default:
      return null;
  }
}

/**
 * CARD TWO: the Chief opens with an answer.
 *
 * Names the engines that were really found, because a sentence a person
 * cannot check is a sentence that costs the first hour its credibility. If
 * the checklist has not answered yet the card says nothing rather than
 * guessing, and if nothing turns out to be installed it says the bare
 * machine's sentence instead. "I found your agents" on a machine with none
 * is the exact small lie this variant exists to avoid.
 */
function FirstRunAgentsCard({ bot, settled }: { bot: Bot; settled: boolean }) {
  const { view } = useSetupView();
  const detect = FIRST_RUN_COPY.agents.detect;
  const detection = firstRunDetection(view);
  if (!view) return null;
  const found = view.agents.filter((agent) => agent.installed);
  if (found.length === 0) return <FirstRunBareAgentsCard needsKey settled={settled} onward />;

  // §1.4 Variant D: the Chief is on a named local model, so it says which
  // one (and, in 1.0.12, nothing about where typed text goes). Proven ONLY by
  // `chiefLocalModel`, the Chief's own selected model on a loopback host, and
  // its engine being one that can answer here. Never the engine's default
  // model and never just a registered host: unsure is the Variant A line.
  const chiefEngineHere = !!view.chiefInstanceId && found.some((agent) => agent.id === view.chiefInstanceId);
  const onLocal = chiefEngineHere ? view.chiefLocalModel : undefined;
  // The level, said once as an example, and only while it is true.
  const onAsk = permissionModeOf(bot) === "ask";

  return (
    <FirstRunBubble>
      <FirstRunLine>{onLocal?.model.trim() ? detect.localChief(onLocal.model.trim()) : detect.foundChief}</FirstRunLine>
      <div className="mt-2 text-[15px] font-semibold text-ink">{detect.heading}</div>

      {/* EVERYTHING RUNNABLE GETS A ROW, and nothing else: first run never
          names an engine nobody is signed in to (FUIGO-FIRST-SIGNIN-PLACEMENT,
          1.0.14). */}
      <ul className="mt-3 grid gap-1.5">
        {detection.rows.map((row) => (
          <FirstRunEngineRowView key={row.id} row={row} />
        ))}
      </ul>

      <FirstRunLine quiet>{detect.closing}</FirstRunLine>
      {onAsk && <FirstRunLine quiet>{detect.askLevel}</FirstRunLine>}
      <FirstRunDetectOnward settled={settled} />
    </FirstRunBubble>
  );
}

/**
 * THE WAY OUT OF THE DETECTION REPORT, AND WITHOUT IT THE FLOW STOPS HERE.
 *
 * `detect` is settled by `nothingToThinkWith(live) || setupStepAnswered`. On
 * a machine that has anything at all the first half is false, so the only
 * road out is a recorded answer — and until this control existed, nothing in
 * `src/` ever recorded one. `nextSetupStep` therefore returned `detect` for
 * ever and THE FLUX SCREEN WAS NEVER SHOWN to anybody with an engine, which
 * is most installs. The copy for this button had been written and was sitting
 * unused in `FIRST_RUN_COPY.agents.detect.action`.
 *
 * It rides on all three detection variants, because all three are the same
 * step and any of them can be the last card a person is looking at: what was
 * found, what came in the box, and the one nobody is signed in to.
 *
 * `settled` hides it rather than disabling it. A report that has been read is
 * history, and history does not carry a live button.
 */
function FirstRunDetectOnward({ settled, label, ghost = false }: { settled: boolean; label?: string; ghost?: boolean }) {
  const [acted, setActed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const detect = FIRST_RUN_COPY.agents.detect;

  const onward = async () => {
    if (busy) return;
    setBusy(true);
    setFailure("");
    try {
      await answerSetupStep("detect", SETUP_DETECT_ANSWER);
      setActed(true);
    } catch (cause) {
      // Said where it happened, and the button stays. A step that could not
      // be recorded is a step to press again, not a dead end with a toast.
      setFailure(failureText(cause, detect.failure));
    } finally {
      setBusy(false);
    }
  };

  if (acted || settled) return null;
  return (
    <div className="mt-3 flex flex-col items-end">
      <button type="button" disabled={busy} onClick={() => void onward()} className={`${ghost ? FIRST_RUN_QUIET : FIRST_RUN_PRIMARY} ${FIRST_RUN_FOCUS}`}>
        {label ?? detect.action}
      </button>
      <FirstRunFailure message={failure} />
    </div>
  );
}

/**
 * One engine, said in three parts.
 *
 * The glyph is decorative and is marked so: the row already says in words
 * everything the shape says, and a screen reader that announced "chip outline"
 * before every engine would be reading out the decoration and burying the
 * name. `FirstRunEngineIcon` is `local` or `cloud`, and the two are
 * drawn rather than lettered because a first glance down the list should
 * answer "how many of these are mine and on this machine" without reading.
 */
function FirstRunEngineRowView({ row }: { row: FirstRunEngineRow }) {
  return (
    <li className="flex items-start gap-2.5 rounded-lg border border-hairline/40 bg-inset px-3 py-2">
      <span aria-hidden="true" className="mt-0.5 shrink-0 text-ink-secondary">
        {row.icon === "local" ? "▢" : "☁"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium text-ink">{row.title}</span>
        <span className="block text-[13px] text-ink-secondary">{row.detail}</span>
      </span>
      <span className="shrink-0 text-[12.5px] text-ink-secondary">{row.tag}</span>
    </li>
  );
}

/**
 * TOMORROW MORNING, BEFORE ANYTHING IS ASKED FOR.
 *
 * The card that answers "what does this actually do" with the thing itself.
 * It sits immediately in front of the key card because both cross-research
 * models, independently, said the same: show, then ask. An offer somebody can
 * already see the point of is not a pitch.
 *
 * It is a real render of the real template with example data in it, which is
 * the constraint that keeps it honest. Every section in it is one the daily
 * routine can fill, so it is not a promise the next morning cannot keep.
 *
 * NO MODEL CALL AND NO NETWORK. That is what lets this exist at all: there is
 * no free starter allowance, so the thing that demonstrates the product
 * before the ask has to cost nothing to produce and have no abuse surface.
 * `shared/brief-html.ts` pins that property with its own test.
 *
 * Shown through the same hardened seam the Files pane uses for an HTML
 * artifact: `artifactPreviewHtml` strips anything active and adds a strict
 * CSP, and the frame is sandboxed with no referrer. The page is ours and is
 * already inert, but this is generated markup carrying the owner's own name,
 * and the established gate is better than a second opinion about it.
 */
function FirstRunSampleBriefCard({ hook = false }: { hook?: boolean }) {
  const sanitizer = useSanitizerReady(); // markup made before the sanitizer loaded is empty: draw again when it arrives
  const { view } = useSetupView();
  const [whole, setWhole] = useState(false);
  const copy = FIRST_RUN_COPY.flux["sample-brief"];
  // HANDED TO THE FRAME VERBATIM, not through `artifactPreviewHtml`.
  //
  // That scrubber exists to defang HTML somebody else wrote, and part of
  // defanging is stripping every <meta>. On a display at 2x scaling that
  // removed the page's viewport tag, so the document laid itself out at a
  // width that was not the frame's, rendered centred on the wrong width, and
  // had its right-hand side clipped with a dead gutter on the left. It cannot
  // be reproduced at 1x, which is why the first attempt to fix it missed.
  //
  // This page is ours: generated here, escaped at one seam, and pinned by
  // shared/brief-html.test.ts to contain no script, no link, no frame and no
  // network reference of any kind. It carries its own strict CSP. And the
  // frame is still `sandbox=""` with no allow-* at all, which is what
  // actually stops script rather than the scrubbing did.
  const html = useMemo(
    () => trustedPreviewDocument(renderBriefHtml(sampleBrief(view?.ownerName ?? ""))),
    [view?.ownerName, sanitizer],
  );
  if (!view) return null;

  return (
    // FULL WIDTH, AND NOT A BUBBLE.
    //
    // This card used to sit inside `FirstRunBubble`, which caps at 88% of a
    // 42rem column, with the brief in a 26rem frame. Seen on a real machine
    // that meant about a third of a page, cut off mid-sentence, with no way
    // to reach the rest and the key card arriving directly underneath. The
    // owner's words were that it "jumps past it", and the screenshot showed
    // why: there was nothing there to stop at.
    //
    // The row is wrapped in `className="contents"` (ChatView), so this root
    // is a direct child of the transcript's `flex w-full flex-col`. A `w-full`
    // element with no max-width therefore spans the whole column, which is
    // the only way out of the bubble that does not involve editing the four
    // places that cap one.
    //
    // The Chief still SPEAKS in a bubble, because that is speech. What it
    // hands over is a document, and a document gets the width of the page.
    // `min-w-0` is not decoration. A flex item defaults to `min-width: auto`,
    // which refuses to shrink below its content, so a wide child can push the
    // item past its container: the transcript scroller is `overflow-x-hidden`,
    // and the result on a real machine was the brief rendering wider than the
    // column with its right-hand side clipped off. Every level from here down
    // to the frame has to be allowed to shrink, or the widest one wins.
    <div className="w-full min-w-0">
      <FirstRunBubble>
        {/* §1.4 Variant C: on a machine with nothing to think with, the
            detection report never ran, so the Chief says what it found here,
            before the picture. */}
        {hook && view.nothingToThinkWith && (
          <>
            <FirstRunLine>{FIRST_RUN_COPY.agents["bare-needs-key"].body}</FirstRunLine>
            <FirstRunLine>{FIRST_RUN_COPY.agents["bare-needs-key"].second}</FirstRunLine>
          </>
        )}
        <FirstRunLine>{copy.body}</FirstRunLine>
        {!hook && <FirstRunLine>{copy.second}</FirstRunLine>}
      </FirstRunBubble>

      <figure className="mt-3 w-full min-w-0 max-w-full overflow-hidden rounded-2xl border border-hairline/50 bg-card">
        <figcaption className="flex items-center justify-between gap-3 border-b border-hairline/40 px-4 py-2.5">
          <span className="text-[12.5px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">
            {hook ? copy.frameTitle : copy.sheetLabel}
          </span>
          <button
            type="button"
            className={`${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS} shrink-0`}
            aria-expanded={whole}
            onClick={() => setWhole((open) => !open)}
          >
            {whole ? copy.showLess : copy.showAll}
          </button>
        </figcaption>
        <SandboxedFrame
          title={copy.frameTitle}
          sandbox=""
          referrerPolicy="no-referrer"
          html={html}
          // Tall enough that the first decision is never cut in half, and an
          // expanded height that clears the whole example rather than a
          // guess at it.
          className={`block w-full min-w-0 max-w-full bg-white ${whole ? "h-[82rem]" : hook ? "h-[24rem]" : "h-[40rem]"}`}
        />
      </figure>

      <FirstRunBubble>
        {/* The line under the frame (§1.5). The parked card asked its own
            question here; as the Flux card's hook, the offer follows instead. */}
        <FirstRunLine quiet>{hook ? copy.second : copy.third}</FirstRunLine>
      </FirstRunBubble>
    </div>
  );
}

/**
 * Two opposite things to say about a machine with nothing else on it.
 *
 * Murage ships the engine, not a brain. When something IS within its reach, a
 * local model or a key already saved, the one in the box really is running
 * and really is what is answering. When there is nothing, saying that would
 * be the first sentence the Chief ever spoke and it would be false, so it
 * says what is actually true and points at the card that fixes it.
 */
function FirstRunBareAgentsCard({
  needsKey = false,
  onward = false,
  settled = false,
}: { needsKey?: boolean; onward?: boolean; settled?: boolean }) {
  const copy = needsKey ? FIRST_RUN_COPY.agents["bare-needs-key"] : FIRST_RUN_COPY.agents.bare;
  return (
    <FirstRunBubble>
      <FirstRunLine>{copy.body}</FirstRunLine>
      <FirstRunLine>{copy.second}</FirstRunLine>
      {/* This card answers the DETECTION step when it is detection's own
          report, and the Flux step when it is that step's opening. Only the
          first is a question with a way on. */}
      {onward && <FirstRunDetectOnward settled={settled} />}
    </FirstRunBubble>
  );
}

/**
 * DETECTION FOUND ONLY ENGINES NOBODY IS SIGNED IN TO: FUIGO AND FLUX ONLY.
 *
 * Flux Router and Fuigo are front and center (Sean 11-02,
 * FUIGO-FIRST-SIGNIN-PLACEMENT). This card used to name each signed-out engine
 * and put a sign-in button for it in the Chief's card. Another engine is
 * reachable from Settings and engine setup and is never pushed here, so the
 * card says what the engine in the box can do now, in the words the bare card
 * already uses: running when it can answer, the key next when it cannot.
 *
 * `agents` is already filtered by `runnable()` on the server, so an empty list
 * IS "nothing can answer yet", the same reading as `canCarryOn` in
 * FirstRunFluxCard.tsx. The view is read live, so a key saved in another
 * window changes the line.
 */
function FirstRunSignedOutAgentsCard({ settled }: { settled: boolean }) {
  const { view } = useSetupView();
  if (!view) return null;
  // The engine in the box itself, never "any engine": `installed: false` is Fuigo.
  return <FirstRunBareAgentsCard needsKey={!view.agents.some((agent) => !agent.installed)} onward settled={settled} />;
}
