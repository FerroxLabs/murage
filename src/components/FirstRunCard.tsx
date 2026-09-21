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

import { useState } from "react";

import { FIRST_RUN_COPY, foundAgentsLine, localModelLine, signedOutAgentsLine } from "@/lib/first-run-copy";
import type { Bot, Message } from "@/state/store";
import { readSetupCard } from "../../shared/setup-card";
import { FirstRunAppsCard } from "./FirstRunAppsCard";
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
