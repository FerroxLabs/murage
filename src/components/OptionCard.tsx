import { useState } from "react";
import { X } from "lucide-react";
import { useStore, visibleMessages, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { readIntakeCard } from "@/lib/onboarding-intake";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

/** First-run quiz, not a live provider ask (those carry requestId) and not a
 * turn of the setup conversation.
 *
 * The intake exclusion is load bearing rather than tidy. Without it this
 * returns true for every intake card, `shouldHideOnboardingCard` then hides
 * it through `talkedPast` as soon as any later user text message exists, and
 * the intake route appends exactly such a message on every single turn. The
 * question would disappear the instant it was answered, taking its own reply
 * chips with it. `ChatView` also branches to `IntakeTurn` before it reaches
 * this code at all: belt and braces, because either one alone is one edit
 * away from the same blank screen. */
export function isOnboardingCard(message: Message): boolean {
  if (readIntakeCard(message.card)) return false;
  return message.kind === "options" && !!message.card && !message.card.requestId;
}

/** A later user message on this path: they have already talked past the quiz. */
function talkedPast(message: Message, transcript: Message[]): boolean {
  const index = transcript.findIndex((entry) => entry.id === message.id);
  if (index < 0) return false;
  return transcript.slice(index + 1).some((later) => later.role === "user" && later.kind === "text");
}

/** Render nothing at all: the question was answered, so it is now a message in
 * the transcript, or an older server never recorded the hide and only the
 * transcript knows. A card the person hid is NOT hidden this way — it
 * collapses to the line below, which puts it back. Live asks are never this
 * card. */
export function shouldHideOnboardingCard(message: Message, transcript: Message[]): boolean {
  if (!isOnboardingCard(message) || !message.card) return false;
  if (message.card.answered) return true;
  // dismissed:false is an explicit "show me this again" and outranks the
  // transcript; undefined means nothing was ever recorded either way.
  if (message.card.dismissed === undefined) return talkedPast(message, transcript);
  return false;
}

/** The X on this card, and typing in the composer, both hide it — and until
 * now that was a one-way door with no control anywhere in the app to undo it.
 * While it is hidden and still unanswered, the card keeps its place in the
 * transcript as one line that brings it back. */
export function shouldOfferOnboardingCardBack(message: Message, transcript: Message[]): boolean {
  if (shouldHideOnboardingCard(message, transcript)) return false;
  if (!isOnboardingCard(message) || !message.card) return false;
  return message.card.dismissed === true && !message.card.answered;
}

export function OptionCard({
  botId,
  message,
}: {
  botId: string;
  message: Message;
}) {
  const { state, dispatch } = useStore();
  const [custom, setCustom] = useState("");
  const card = message.card;
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const transcript = bot ? visibleMessages(bot) : [];
  // Full thread, not the mounted window: a search-focus slice can omit the
  // later user message that means they already talked past this quiz.
  if (!card || shouldHideOnboardingCard(message, transcript)) return null;

  const answer = (text: string) => {
    if (!text.trim()) return;
    dispatch({ type: "answerCard", botId, messageId: message.id, answer: text.trim() });
  };

  if (shouldOfferOnboardingCardBack(message, transcript)) {
    return (
      <div className="flex w-full max-w-[840px] flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-secondary">
        <span>Setup question hidden.</span>
        <button
          type="button"
          onClick={() => dispatch({ type: "restoreCard", botId, messageId: message.id })}
          className="-mx-1 rounded-md px-1 py-0.5 text-ink underline decoration-hairline underline-offset-2 hover:bg-control"
        >
          Bring it back
        </button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[840px] rounded-2xl border border-hairline/50 bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[16px] font-semibold text-ink">{card.title}</div>
          <div className="mt-0.5 text-[14px] text-ink-secondary">
            {card.subtitle}
          </div>
        </div>
        <button
          type="button"
          // A bare X states no cost. This one is a hide the transcript keeps a
          // way back from; the live-ask X answers the provider with a denial,
          // and those are two different prices to name.
          aria-label={card.requestId ? "Dismiss this request" : "Hide this question"}
          title={card.requestId ? "Dismiss this request" : "Hide this question"}
          onClick={() =>
            dispatch({ type: "dismissCard", botId, messageId: message.id })
          }
          className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      <div className="mt-3 overflow-hidden rounded-lg border border-hairline/40">
        {card.options.map((opt, i) => (
          <button
            key={opt}
            disabled={!!card.answered}
            onClick={() => answer(opt)}
            className={cn(
              "flex w-full items-center gap-3 px-3 py-3 text-left text-[15px] text-ink",
              i > 0 && "border-t border-hairline/40",
              // `raised` is the wrong fill here: the light skins define it as
              // pure white, the same value as the card underneath, so a
              // hovered or answered row used to be invisible. `raised-hover`
              // is the one tone every skin guarantees stands off a surface.
              card.answered === opt
                ? "bg-raised-hover"
                : "hover:bg-raised-hover/60 disabled:hover:bg-transparent",
            )}
          >
            {/* `control` is the chip tone every skin guarantees on a card; the
                hairline keeps it a chip even on a row that is itself filled */}
            <span className="flex size-6 items-center justify-center rounded-md border border-hairline/50 bg-control text-[12px] font-medium text-ink-secondary">
              {LETTERS[i]}
            </span>
            {opt}
          </button>
        ))}
      </div>

      {/* a permission ask has no free-text answer — the broker only accepts
          allow/deny, so typing here used to fail silently */}
      {!card.answered && !card.tool && (
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && answer(custom)}
          placeholder="Type your own answer"
          className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
        />
      )}
    </div>
  );
}
