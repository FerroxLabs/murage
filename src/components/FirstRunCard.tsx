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

import { FIRST_RUN_COPY, foundAgentsLine } from "@/lib/first-run-copy";
import type { Bot, Message } from "@/state/store";
import { readSetupCard } from "../../shared/setup-card";
import { FirstRunAppsCard } from "./FirstRunAppsCard";
import { FirstRunBriefCard, FirstRunBriefRanCard, FirstRunMoreRoutinesCard } from "./FirstRunBriefCard";
import { FirstRunBubble, FirstRunLine, useSetupView } from "./FirstRunChrome";
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
  const names = view.agents.filter((agent) => agent.installed).map((agent) => agent.name);
  if (names.length === 0) return <FirstRunBareAgentsCard />;
  return (
    <FirstRunBubble>
      <FirstRunLine>{foundAgentsLine(names)}</FirstRunLine>
      <FirstRunLine>{FIRST_RUN_COPY.agents.found.second}</FirstRunLine>
    </FirstRunBubble>
  );
}

function FirstRunBareAgentsCard() {
  return (
    <FirstRunBubble>
      <FirstRunLine>{FIRST_RUN_COPY.agents.bare.body}</FirstRunLine>
      <FirstRunLine>{FIRST_RUN_COPY.agents.bare.second}</FirstRunLine>
    </FirstRunBubble>
  );
}
