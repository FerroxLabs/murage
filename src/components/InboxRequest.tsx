// What a waiting request says, and how it is answered, from inside the Inbox.
//
// The Inbox projection (server/inbox.ts) deliberately carries no card text:
// it is metadata, and a card's title, subtitle and tool command must never
// leak into it. So an Inbox row used to be headed "Question needs an answer"
// above the person's OWN message, with no way to reply except walking to the
// conversation.
//
// The words come from the transcript instead, through the ordinary
// `GET /api/threads/:id/messages?around=…` route every other reader uses, and
// the answer goes back out through `POST /api/threads/:id/respond` — the same
// route the card in the conversation posts to. No second answering path, and
// no second copy of the question.
import { useState } from "react";

import { api } from "@/state/store";
import type { OptionCardData } from "@/state/store";
import { isQuestionCard, questionsForCard, type QuestionAnswer } from "../../shared/questions";
import { QuestionCardView } from "./QuestionCard";

/** A request that is still open: nothing answered it, dismissed it, and the
 * bot has not stopped waiting. */
export function requestOpen(card: OptionCardData | undefined | null): boolean {
  return Boolean(card?.requestId) && !card!.answered && !card!.dismissed && !card!.expired;
}

/** How this request can be settled from the Inbox.
 *
 * A routine or skill proposal is a document to read before deciding, and a
 * folder-trust card is a decision about a folder — those keep their review
 * surface in the conversation and are only opened, never answered here. */
export function inlineAnswerKind(card: OptionCardData | undefined | null): "question" | "approval" | null {
  if (!requestOpen(card)) return null;
  if (card!.routineRequest || card!.skillRequest || card!.intake || card!.folderTrust) return null;
  if (isQuestionCard(card)) return "question";
  return card!.tool ? "approval" : null;
}

/** The bot's own words, for a card that asks something in them: a question
 * card's first question.
 *
 * Nothing else. A permission card's own title is one of a handful of fixed
 * Murage strings ("Approval needed"), which says no more than the Inbox
 * already does, and its subtitle is the command — that belongs in the
 * conversation, not in a list. Those rows keep the projection's heading. */
export function requestHeadline(card: OptionCardData | undefined | null): string {
  if (!card || !isQuestionCard(card)) return "";
  return questionsForCard(card)[0]?.question.trim() ?? "";
}

// SHAPE ONLY. NO COLOUR.
//
// THE DEFECT THIS SPLIT FIXES. This constant used to carry
// `border-hairline/50 bg-control text-ink` too, and each variant appended its
// own colour on top: `${button} bg-accent text-accent-ink`. Tailwind
// utilities of the same kind have the SAME specificity, so the winner is
// decided by the order the rules appear in the stylesheet, not by the order
// they appear in the class attribute. `bg-control` won, and the primary
// action — the one that says Allow once — rendered as a dim grey slab that
// reads as disabled. It was never disabled. It just looked dead, which is
// worse than ugly: it teaches somebody that the button does not work, on the
// one control in this panel that has to be pressed.
//
// Deny escaped only by luck: `text-danger` happened to win its own coin toss
// against `text-ink`.
//
// So the base holds layout, shape and focus, and every variant brings its own
// background, text and border. Nothing overlaps, so nothing can be decided by
// stylesheet order.
const button =
  "min-h-10 rounded-lg border px-3 py-2 text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";

/** The answer this panel exists to collect. Solid, and the only filled
 *  control here, so the eye lands on it before it reads anything. */
const buttonPrimary = `${button} border-accent bg-accent text-accent-ink hover:brightness-110`;

/** Refusing is a real answer and gets a real control, in the colour of what
 *  it does, but it is outlined rather than filled: two solid buttons side by
 *  side make the person choose between two shouts. */
const buttonDanger = `${button} border-danger/50 bg-transparent text-danger hover:bg-danger/10`;

/** The third answer a stop-line card offers (deleting outside its folder,
 *  paying, messaging someone new): allow the same kind of action in the same
 *  place for the rest of the task. Outlined and neutral, with its own full
 *  set of colours rather than a colour appended to `button`, which is the
 *  mistake above. */
const buttonQuiet = `${button} border-hairline/60 bg-transparent text-ink hover:bg-control`;

/** Answer a waiting request without leaving the Inbox. `onSettled` lets the
 * list refresh from the server rather than guess the new state. */
export function InboxRequestAnswer({
  threadId,
  card,
  botName,
  onSettled,
}: {
  threadId: string;
  card: OptionCardData;
  botName?: string;
  onSettled: () => void;
}) {
  const kind = inlineAnswerKind(card);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!kind) return null;

  const respond = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/threads/${threadId}/respond`, { method: "POST", body: JSON.stringify({ requestId: card.requestId, ...body }) });
      onSettled();
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : "This answer could not be sent. Open the request instead.");
    }
  };

  if (kind === "question") {
    return (
      <div className="mt-3">
        <QuestionCardView
          card={card}
          botName={botName}
          busy={busy}
          error={error}
          onSubmit={(answers: QuestionAnswer[]) => void respond({ behavior: "answer", answers })}
          onSkip={() => void respond({ behavior: "skip" })}
          // A late answer needs the conversation's own composer; the Inbox
          // never sends a message on a bot's behalf.
          onSendAsMessage={() => setError("This question has expired. Open the request to send a late answer.")}
        />
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-xl border border-accent/30 bg-inset p-3">
      {/* The command itself stays in the conversation. The Inbox is a place
          to answer from, not a second reader of what a bot would run. */}
      <p className="mb-2 text-[12px] text-ink-secondary">Open the request to see exactly what {botName || "this bot"} would run.</p>
      {error && <p role="alert" className="mb-2 text-[12px] text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          className={buttonPrimary}
          disabled={busy}
          onClick={() => void respond({ behavior: "allow" })}
        >
          Allow once
        </button>
        {card.taskAllowKey && (
          <button
            className={buttonQuiet}
            disabled={busy}
            title="Allow the same kind of action in the same place until this task ends"
            onClick={() => void respond({ behavior: "allow", allowForTask: true })}
          >
            Allow for this task
          </button>
        )}
        <button
          className={buttonDanger}
          disabled={busy}
          onClick={() => void respond({ behavior: "deny", message: "Denied by the user." })}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
