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

const button =
  "min-h-10 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";

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
          className={`${button} bg-accent text-accent-ink hover:brightness-110`}
          disabled={busy}
          onClick={() => void respond({ behavior: "allow" })}
        >
          Allow once
        </button>
        <button
          className={`${button} border-danger/40 text-danger`}
          disabled={busy}
          onClick={() => void respond({ behavior: "deny", message: "Denied by the user." })}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
