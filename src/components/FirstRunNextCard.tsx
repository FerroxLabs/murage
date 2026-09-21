// PARKED, PENDING THE OWNER'S DECISION (W16, 0.1.58).
//
// the closing card. `flow` now ends on the job's own
// result, which carries "take something else off my plate", so a separate
// "what would you like to do next?" would be a second ending to one scene.
//
// Nothing renders this today: server/setup-conversation.ts never emits its
// card variant. It stays in the tree, compiling and untouched otherwise, and
// its step calls point at PARKED_CARD_STEP rather than at a step that no
// longer exists. Whether it moves to another surface, returns later in the
// flow, or goes, is the owner's call and it has not been taken. Deleting
// tested work on a guess is how you lose a week.
//
// CARD EIGHT: what would you like to do.
//
// Every button here SAYS something, in the person's own voice, into the
// conversation they are already in. Nothing opens a pane, nothing navigates
// away, and nothing here is a menu of features: it is four ways to start
// working, three bigger ones, and one press for backups (FirstRunBackupsRow,
// which reads the real schedule rather than asserting one).
//
// "Hire your first teammate" is a job and never a team. Somebody with one
// job turns up and does it; a team is a thing you manage.

import { useState } from "react";

import { FIRST_RUN_COPY, type FirstRunOffer } from "@/lib/first-run-copy";
import { useStore, type Bot } from "@/state/store";
import {
  FIRST_RUN_CHIP,
  FIRST_RUN_FOCUS,
  FirstRunBubble,
  FirstRunLine,
} from "./FirstRunChrome";
import { FirstRunBackupsRow } from "./FirstRunBackupsRow";

const copy = FIRST_RUN_COPY.routines.next;

export function FirstRunNextCard({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [said, setSaid] = useState("");

  const say = (offer: FirstRunOffer) => {
    if (said) return;
    setSaid(offer.label);
    // The ordinary send, exactly as the composer sends: the answer to "what
    // would you like to do" is them asking for it, so it belongs in the
    // transcript as their message.
    dispatch({ type: "send", botId: bot.id, text: offer.say, threadId: bot.threadId });
  };

  const row = (offers: readonly FirstRunOffer[]) => (
    <div className="mt-2 flex flex-wrap gap-2">
      {offers.map((offer) => (
        <button
          key={offer.label}
          type="button"
          disabled={Boolean(said)}
          onClick={() => say(offer)}
          className={`${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS}`}
        >
          {offer.label}
        </button>
      ))}
    </div>
  );

  return (
    <FirstRunBubble>
      <div className="text-[15px] font-semibold text-ink">{copy.title}</div>
      <FirstRunLine>{copy.body}</FirstRunLine>

      <div className="mt-3 text-[13px] text-ink-secondary">{copy.workLabel}</div>
      {row(copy.work)}

      <div className="mt-3 text-[13px] text-ink-secondary">{copy.moreLabel}</div>
      {row(copy.more)}
      <FirstRunLine quiet>{copy.hireWhy}</FirstRunLine>

      {/* Backups are a smart default, and one press. The row reads the real
          schedule before it says anything: on a computer where backups are
          already running it is one quiet line and no button, and on one where
          they are not it says so rather than claiming otherwise. */}
      <FirstRunBackupsRow />
    </FirstRunBubble>
  );
}
