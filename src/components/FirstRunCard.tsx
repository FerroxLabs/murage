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

import { useMemo, useState } from "react";

import { FIRST_RUN_COPY, foundAgentsLine, localModelLine, signedOutAgentsLine } from "@/lib/first-run-copy";
import type { Bot, Message } from "@/state/store";
import { renderBriefHtml } from "../../shared/brief-html";
import { sampleBrief } from "../../shared/brief-sample";
import { readSetupCard } from "../../shared/setup-card";
import { FirstRunAppsCard } from "./FirstRunAppsCard";
import { artifactPreviewHtml } from "./Files";
import { FirstRunBriefCard, FirstRunBriefRanCard, FirstRunMoreRoutinesCard } from "./FirstRunBriefCard";
import {
  FIRST_RUN_CHIP,
  FIRST_RUN_FOCUS,
  FIRST_RUN_PRIMARY,
  FirstRunBubble,
  FirstRunLine,
  useSetupView,
} from "./FirstRunChrome";
import { FirstRunFluxCard, FirstRunNoKeyCard } from "./FirstRunFluxCard";
import { FirstRunHelloCard } from "./FirstRunHelloCard";
import { FirstRunNextCard } from "./FirstRunNextCard";
import { FirstRunPhoneCard } from "./FirstRunPhoneCard";

export function FirstRunCard({ bot, message }: { bot: Bot; message: Message }) {
  const card = readSetupCard(message.card);
  if (!card) return null;
  const settled = Boolean(card.settled);

  switch (card.variant) {
    case "welcome":
      return <FirstRunHelloCard settled={settled} />;
    case "found":
      return <FirstRunAgentsCard />;
    case "bare":
      return <FirstRunBareAgentsCard />;
    case "bare-needs-key":
      return <FirstRunBareAgentsCard needsKey />;
    case "signed-out":
      return <FirstRunSignedOutAgentsCard settled={settled} />;
    case "sample-brief":
      return <FirstRunSampleBriefCard />;
    case "key":
      return <FirstRunFluxCard settled={settled} />;
    case "no-key":
      return <FirstRunNoKeyCard />;
    case "apps":
      return <FirstRunAppsCard settled={settled} />;
    case "brief":
      return <FirstRunBriefCard settled={settled} />;
    case "brief-ran":
      return <FirstRunBriefRanCard />;
    case "more-routines":
      return <FirstRunMoreRoutinesCard settled={settled} />;
    case "next":
      return <FirstRunNextCard bot={bot} />;
    case "phone":
    case "phone-needs-tailscale":
      // Both land on one component on purpose: which of the two is honest is
      // decided by probing this machine, not by what the server guessed.
      return <FirstRunPhoneCard settled={settled} />;
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
function FirstRunAgentsCard() {
  const { view } = useSetupView();
  if (!view) return null;
  const found = view.agents.filter((agent) => agent.installed);
  if (found.length === 0) return <FirstRunBareAgentsCard needsKey />;

  // A local model is named by its MODEL, never by the connection Murage
  // reaches it through. "You already had OpenAI-compatible (OpenRouter /
  // Groq)" was the Chief's opening line to somebody whose model was on their
  // own hard disk, and it was wrong twice: an engine id, and two cloud
  // vendors that had nothing to do with them.
  const local = found.find((agent) => agent.localModel)?.localModel;
  const rest = found.filter((agent) => !agent.localModel).map((agent) => agent.name);

  return (
    <FirstRunBubble>
      {local && <FirstRunLine>{localModelLine(local.model, local.host)}</FirstRunLine>}
      {rest.length > 0 && <FirstRunLine>{foundAgentsLine(rest)}</FirstRunLine>}
      <FirstRunLine>{FIRST_RUN_COPY.agents.found.second}</FirstRunLine>
    </FirstRunBubble>
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
function FirstRunSampleBriefCard() {
  const { view } = useSetupView();
  const [whole, setWhole] = useState(false);
  const copy = FIRST_RUN_COPY.flux["sample-brief"];
  const html = useMemo(
    () => artifactPreviewHtml(renderBriefHtml(sampleBrief(view?.ownerName ?? ""))),
    [view?.ownerName],
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
        <FirstRunLine>{copy.body}</FirstRunLine>
        <FirstRunLine>{copy.second}</FirstRunLine>
      </FirstRunBubble>

      <figure className="mt-3 w-full min-w-0 max-w-full overflow-hidden rounded-2xl border border-hairline/50 bg-card">
        <figcaption className="flex items-center justify-between gap-3 border-b border-hairline/40 px-4 py-2.5">
          <span className="text-[12.5px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">
            {copy.sheetLabel}
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
        <iframe
          title={copy.frameTitle}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={html}
          // Tall enough that the first decision is never cut in half, and an
          // expanded height that clears the whole example rather than a
          // guess at it.
          className={`block w-full min-w-0 max-w-full bg-white ${whole ? "h-[82rem]" : "h-[40rem]"}`}
        />
      </figure>

      <FirstRunBubble>
        <FirstRunLine quiet>{copy.third}</FirstRunLine>
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
function FirstRunBareAgentsCard({ needsKey = false }: { needsKey?: boolean }) {
  const copy = needsKey ? FIRST_RUN_COPY.agents["bare-needs-key"] : FIRST_RUN_COPY.agents.bare;
  return (
    <FirstRunBubble>
      <FirstRunLine>{copy.body}</FirstRunLine>
      <FirstRunLine>{copy.second}</FirstRunLine>
    </FirstRunBubble>
  );
}

/**
 * IT IS HERE, AND NOBODY IS SIGNED IN TO IT.
 *
 * The card that used not to exist. A signed-out engine still answers
 * `--version` and still hands over its full model list, so it read as a
 * working agent: the "found" card claimed we had connected it, the checklist
 * ticked, and on a machine with no key it was the only candidate the selector
 * had, so the Chief was pointed at an engine that died on the first thing it
 * was ever asked to do.
 *
 * Why a COMMAND and not a button that does it. The sign-in is a device auth
 * flow that opens a browser and waits on a code, and running it invisibly
 * from inside the app would hide the one moment where the person has to prove
 * who they are. This person installed Codex themselves, so the command is the
 * help they actually want. `signInCommand` comes from the driver, which is
 * the only thing that knows it, so nothing here is hardcoded per engine.
 *
 * "Check again" rather than polling: the sign-in happens in another window
 * and finishes when it finishes. One honest button beats a spinner that
 * cannot know.
 */
function FirstRunSignedOutAgentsCard({ settled }: { settled: boolean }) {
  const { view, refresh } = useSetupView();
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState("");
  const copy = FIRST_RUN_COPY.agents["signed-out"];

  // The server decides WHICH card is owed; what it says is re-read live, so a
  // sign-in finished in another window empties this list and the card stops
  // asking for something that is already done.
  const waiting = view?.signedOutAgents ?? [];
  if (!view) return null;
  if (waiting.length === 0) {
    return (
      <FirstRunBubble>
        <FirstRunLine>{copy.done}</FirstRunLine>
      </FirstRunBubble>
    );
  }

  const commands = waiting
    .map((agent) => ({ name: agent.name, command: agent.signInCommand }))
    .filter((row): row is { name: string; command: string } => Boolean(row.command));

  return (
    <FirstRunBubble>
      <FirstRunLine>{signedOutAgentsLine(waiting.map((agent) => agent.name))}</FirstRunLine>
      <FirstRunLine>{copy.second}</FirstRunLine>
      <FirstRunLine>{copy.third}</FirstRunLine>
      {!settled && !shown && commands.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className={`${FIRST_RUN_PRIMARY} ${FIRST_RUN_FOCUS}`}
            onClick={() => setShown(true)}
          >
            {copy.action}
          </button>
        </div>
      )}
      {shown && (
        <div className="mt-3 space-y-2">
          {commands.map((row) => (
            <div key={row.name} className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
              <p className="text-[13px] text-ink-secondary">{copy.commandFor(row.name)}</p>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <code className="select-all text-[13.5px] text-ink">{row.command}</code>
                <button
                  type="button"
                  className={`${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS} shrink-0`}
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(row.command)
                      .then(() => setCopied(row.name))
                      // A clipboard the browser refused is not a failure worth
                      // a red box: the command is on screen and selectable.
                      .catch(() => setCopied(""));
                  }}
                >
                  {copied === row.name ? copy.copied : copy.copy}
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className={`${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS}`}
            onClick={() => refresh()}
          >
            {copy.recheck}
          </button>
        </div>
      )}
    </FirstRunBubble>
  );
}
