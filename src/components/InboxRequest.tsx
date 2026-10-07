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
import { decideWithFreshAuth } from "@/lib/fresh-auth";
import { allowNeedsComputer, approvalSurface, useComputerOnlyRefusal } from "@/lib/approval-surface";
import { inNativeShell } from "@/lib/native-shell";
import { useDecisionFeedback, type DecisionHooks } from "@/lib/approval-feedback";
import { ApprovalBusyLabel, ApprovalConfirmLine, approvalButton } from "./ApprovalFeedback";
import { useDesktopSurface } from "@/lib/use-surface";
import { ComputerOnlyNotice } from "./ComputerOnlyNotice";
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
  `inline-flex min-h-10 items-center justify-center rounded-lg border px-3 py-2 text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus`;

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
  // Allow once, Allow for this task and Deny: the tapped one works, the rest are held until it settles.
  const feedback = useDecisionFeedback();
  const desktop = useDesktopSurface();
  const refused = useComputerOnlyRefusal(threadId, card.requestId ?? "");
  const computerOnly = kind === "approval" && allowNeedsComputer(approvalSurface(desktop, inNativeShell()), card, refused);
  // A phone's Allow on a card not rated low may meet fresh authentication, which signs the card's details.
  const reviewFirst = kind === "approval" && desktop !== true && card.lowRisk !== true;
  if (!kind) return null;

  const respond = async (body: Record<string, unknown>, hooks?: DecisionHooks) => {
    setBusy(true);
    setError(null);
    // An Allow may be met by a fresh-auth challenge on the phone (SEC-006):
    // the helper asks for Face ID and re-posts once. A cancel leaves the card
    // waiting with no error.
    let failed = false;
    let failure = "";
    await decideWithFreshAuth(
      (extra) => api(`/api/threads/${threadId}/respond`, { method: "POST", body: JSON.stringify({ requestId: card.requestId, ...body, ...extra }) }),
      {
        threadId,
        requestId: card.requestId ?? "",
        decision: body.behavior === "allow" ? (body.allowForTask ? "allow-task" : "allow") : undefined,
        card,
        botName,
        onDevicePrompt: hooks?.devicePrompt,
      },
      { onError: (message, code) => { failed = true; failure = code === "cancelled" ? "" : message || "This answer could not be sent. Open the request instead."; }, showError: () => {} },
    );
    if (!failed) {
      // Accepted: the buttons stay held until the refetch replaces this row.
      hooks?.succeed();
      onSettled();
      return;
    }
    // A Deny that pre-empted this Allow owns the card now: this late failure says nothing to show.
    if (hooks && !hooks.live()) return;
    setBusy(false);
    hooks?.settle();
    if (failure) setError(failure);
  };
  /** One tap on an approval button: buzz, show it working, hold the others. */
  const decide = (choice: "allow" | "allow-task" | "deny", body: Record<string, unknown>) =>
    feedback.run(choice, (hooks) => respond(body, hooks), choice === "deny" ? { preempt: true } : undefined);
  // A Deny is never held by an Allow in flight; it goes out at once and takes over the card.
  const btn = (choice: string, classes: string) => approvalButton(feedback, choice, classes, choice === "deny");

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
      {reviewFirst ? (
        // SEC-006: an Allow on a card that may need fresh authentication signs a digest of the tool, command,
        // summary and hold. So the owner sees exactly those, here, before the Allow that can start native auth.
        <div data-testid="inbox-request-details" className="mb-2 space-y-1 text-[12.5px] text-ink">
          {typeof card.tool === "string" && card.tool && <p className="font-mono text-[12px] text-ink-secondary">{card.tool}</p>}
          {card.subtitle && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-control p-2 font-mono text-[12px]">{card.subtitle}</pre>}
          {typeof card.summary === "string" && card.summary && card.summary !== card.subtitle && <p className="break-words">{card.summary}</p>}
          {typeof card.held === "string" && card.held && <p className="break-words text-ink-secondary">{card.held}</p>}
        </div>
      ) : (
        // A low-rated card needs no proof, so the command stays in the conversation.
        <p className="mb-2 text-[12px] text-ink-secondary">Open the request to see exactly what {botName || "this bot"} would run.</p>
      )}
      {error && <p role="alert" className="mb-2 text-[12px] text-danger">{error}</p>}
      {computerOnly && <ComputerOnlyNotice className="mb-2 text-[12.5px] text-ink-secondary" />}
      <ApprovalConfirmLine prompting={feedback.prompting} className="mb-2 text-[12.5px] text-ink-secondary" />
      <div role="group" aria-label="Answer" className="flex flex-wrap gap-2" aria-busy={feedback.busy !== null}>
        {!computerOnly && (
          <>
            <button
              {...btn("allow", buttonPrimary)}
              onClick={() => decide("allow", { behavior: "allow" })}
            >
              <ApprovalBusyLabel busy={feedback.busy === "allow"}>Allow once</ApprovalBusyLabel>
            </button>
            {card.taskAllowKey && (
              <button
                {...btn("allow-task", buttonQuiet)}
                title="Allow the same kind of action in the same place until this task ends"
                onClick={() => decide("allow-task", { behavior: "allow", allowForTask: true })}
              >
                <ApprovalBusyLabel busy={feedback.busy === "allow-task"}>Allow for this task</ApprovalBusyLabel>
              </button>
            )}
          </>
        )}
        <button
          {...btn("deny", buttonDanger)}
          onClick={() => decide("deny", { behavior: "deny", message: "Denied by the user." })}
        >
          <ApprovalBusyLabel busy={feedback.busy === "deny"}>Deny</ApprovalBusyLabel>
        </button>
      </div>
    </div>
  );
}
