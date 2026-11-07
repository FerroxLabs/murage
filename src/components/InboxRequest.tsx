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
import type { Message, OptionCardData } from "@/state/store";
import { approvalTitle } from "@/lib/pending-approval";
import { t } from "@/lib/i18n";
import { answersInOneTap, isQuestionCard, questionsForCard, type QuestionAnswer } from "../../shared/questions";
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

/** What the open card's Allow once and Deny post, beside the requestId. The
 *  Needs you row's one-click Approve and Don't allow post these same bodies. */
/** The live card of a waiting request, read from the transcript (the Inbox projection carries no card text), or
 *  null when it is gone or has no request. The Inbox door and Today read cards through this one helper. */
export async function readRequestCard(link: { threadId: string; messageId: string }, signal?: AbortSignal): Promise<OptionCardData | null> {
  try {
    const thread = await api(`/api/threads/${link.threadId}/messages?around=${link.messageId}&limit=1`, { signal }) as { messages?: { id: string; card?: OptionCardData }[] };
    const card = thread.messages?.find(message => message.id === link.messageId)?.card;
    return card?.requestId ? card : null;
  } catch { return null; }
}

export const ALLOW_ONCE_BODY: Readonly<Record<string, unknown>> = Object.freeze({ behavior: "allow" });
export const DENY_BODY: Readonly<Record<string, unknown>> = Object.freeze({ behavior: "deny", message: "Denied by the user." });

/** About this many characters of WHAT is asked fit one Needs you row. */
const SUMMARY_CHARS = 120;
function oneLine(text: string | undefined): string {
  return (text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.replace(/\s+/g, " ") ?? "";
}
function cutLine(text: string): string {
  return text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS - 1).trimEnd()}…`;
}

/** NEEDSYOU-INLINE-APPROVE: the one line a Needs you row shows for a waiting
 *  request, so nobody approves a blind "Approval requested". A permission
 *  card: the open card's own title (the action) plus its target (the card's
 *  one-line summary, else the command's first line). A question: the bot's
 *  own question. Cut to about 120 characters. */
export function requestSummary(card: OptionCardData | undefined | null): string {
  return summaryOf(card).text;
}

/** The row's line, whether it shows ALL of what is decided (the whole question, or the whole command on one line,
 *  not cut), and the whole text when it does not. A row whose line is not complete shows `whole` beside its answer
 *  buttons (Astra full review High: "Apply this change?\nThis deletes all archived records." read "Apply this
 *  change?" beside Yes / No), so nobody answers words they could not see, and ordinary long commands still get
 *  Approve (Sean: "still needs an Approve button on that card"). */
export function summaryOf(card: OptionCardData | undefined | null): { text: string; complete: boolean; whole: string } {
  if (!card) return { text: "", complete: false, whole: "" };
  const lines = (text: string | undefined) => (text ?? "").split(/\r?\n/).filter((line) => line.trim()).length;
  if (isQuestionCard(card)) {
    const headline = requestHeadline(card);
    const line = oneLine(headline);
    return { text: cutLine(line), complete: lines(headline) <= 1 && line.length <= SUMMARY_CHARS, whole: headline };
  }
  if (!card.tool) return { text: "", complete: false, whole: "" };
  const title = approvalTitle({ message: { card } as unknown as Message, requestId: card.requestId ?? "", tool: card.tool, detail: card.subtitle ?? "", held: card.held });
  // The command itself is the target (a card summary may name only the tool); the summary only when there is none.
  const command = oneLine(card.subtitle);
  const summary = oneLine(card.summary);
  const target = command || (summary && summary !== oneLine(card.title) ? summary : "");
  const full = target && !title.includes(target) ? `${title}: ${target}` : title;
  return { text: cutLine(full), complete: lines(card.subtitle) <= 1 && full.length <= SUMMARY_CHARS, whole: (card.subtitle ?? "").trim() || target };
}

/** How a collapsed Needs you row may answer with one click, or null for Open only. */
export type QuickAnswer = { kind: "approval" } | { kind: "choice"; questionId: string; options: [string, string] };

/** Tools whose card is a decision of its own kind (a remembered consent, a choice
 *  of engine, a page-derived browser action): Open only. */
const OPEN_ONLY_TOOLS = new Set(["local_computer_consent", "murage_limit_offer", "browser_extension_action", "venue_post"]);

/** Only a card the open view settles with one plain press: a permission whose
 *  open view shows Allow once beside Deny and nothing to read first, or one
 *  question with exactly two plain options that a single tap answers. A scope
 *  to pick (Allow for this task), typed input, several options, a proposal, an
 *  email, a publish, a card the phone must review first or the computer must
 *  answer: Open only. */
export function quickAnswerOf(card: OptionCardData | undefined | null, gates: { computerOnly: boolean; reviewFirst: boolean }): QuickAnswer | null {
  const kind = inlineAnswerKind(card);
  if (!kind) return null;
  const c = card!;
  // the server cut the tool input short for display: nobody can see all of it on a row, Open only (as Approve all)
  if (c.toolInputTruncated === true) return null;
  if (c.kind || c.publish || c.mcpEnable || c.browserSetup || c.limitOffer || c.emailSend || c.emailTrustOffer) return null;
  if (kind === "approval") {
    if (gates.computerOnly || gates.reviewFirst || c.taskAllowKey || OPEN_ONLY_TOOLS.has(c.tool ?? "")) return null;
    return { kind: "approval" };
  }
  const questions = questionsForCard(c);
  if (!answersInOneTap(questions, { state: "open", folderTrust: Boolean(c.folderTrust) })) return null;
  const question = questions[0]!;
  const labels = question.options.map((option) => option.label.trim());
  if (labels.length !== 2 || labels.some((label) => !label) || question.options.some((option) => option.description?.trim())) return null;
  return { kind: "choice", questionId: question.id, options: [question.options[0]!.label, question.options[1]!.label] };
}

/** Each one-click button: its label, the decision it is held as, and the body it
 *  posts. Approve and Don't allow are the open card's Allow once and Deny; a
 *  two-option question sends what a one-tap pick in the open card sends. */
export function quickAnswerChoices(quick: QuickAnswer): Array<{ key: string; label: string; choice: "allow" | "deny" | "answer"; body: Record<string, unknown> }> {
  if (quick.kind === "approval") {
    return [
      { key: "allow", label: t("projects.inbox.approve"), choice: "allow", body: ALLOW_ONCE_BODY },
      { key: "deny", label: t("projects.inbox.deny"), choice: "deny", body: DENY_BODY },
    ];
  }
  return quick.options.map((label, at) => ({ key: `option-${at}`, label, choice: "answer" as const, body: { behavior: "answer", answers: [{ id: quick.questionId, selected: [label] }] } }));
}

/** Posting an answer to a waiting request, for the open card and the Needs you
 *  row alike: ONE route (`POST /api/threads/:id/respond`), fresh authentication
 *  where the card needs it, held buttons while it is in flight. */
function useRequestAnswer(threadId: string, card: OptionCardData, botName: string | undefined, onSettled: () => void) {
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
  return { kind, busy, error, setError, feedback, computerOnly, reviewFirst, respond, decide, btn };
}

/** Answer a waiting request without leaving the Inbox. `onSettled` lets the
 * list refresh from the server rather than guess the new state. */
export function InboxRequestAnswer({
  threadId,
  card,
  botName,
  onSettled,
  details = false,
}: {
  threadId: string;
  card: OptionCardData;
  botName?: string;
  onSettled: () => void;
  /** Opened from "Show details": show the exact tool and command on every card. */
  details?: boolean;
}) {
  const { kind, busy, error, setError, feedback, computerOnly, reviewFirst, respond, decide, btn } = useRequestAnswer(threadId, card, botName, onSettled);
  if (!kind) return null;

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
      {reviewFirst || details ? (
        // SEC-006: an Allow on a card that may need fresh authentication signs a digest of the tool, command,
        // summary and hold. So the owner sees exactly those, here, before the Allow that can start native auth.
        // APPROVALS-SIMPLE-1018: the Needs you and Approvals panel opens only from "Show details" (`details`), so it
        // shows the exact tool and command on every card there.
        <div data-testid="inbox-request-details" data-review-first={reviewFirst ? "" : undefined} className="mb-2 space-y-1 text-[12.5px] text-ink">
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
              onClick={() => decide("allow", ALLOW_ONCE_BODY)}
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
          onClick={() => decide("deny", DENY_BODY)}
        >
          <ApprovalBusyLabel busy={feedback.busy === "deny"}>Deny</ApprovalBusyLabel>
        </button>
      </div>
    </div>
  );
}

/** NEEDSYOU-INLINE-APPROVE: the one-click answer on a collapsed Needs you row.
 *  The same hook, route and bodies as the open card above; nothing at all for
 *  a card that keeps Open only (quickAnswerOf). A failure says why, here. */
export function InboxQuickAnswer({
  threadId,
  card,
  botName,
  labelledBy,
  onSettled,
}: {
  threadId: string;
  card: OptionCardData;
  botName?: string;
  /** the row's summary line, which names this group for a screen reader */
  labelledBy: string;
  onSettled: () => void;
}) {
  const answer = useRequestAnswer(threadId, card, botName, onSettled);
  const quick = quickAnswerOf(card, answer);
  const { feedback, busy, error, btn, decide, respond } = answer;
  // A refusal can take the buttons away (the server said only the computer may answer): its reason still shows.
  if (!quick) return error ? <p role="alert" className="max-w-xs text-right text-[12px] text-danger">{error}</p> : null;
  const choices = quickAnswerChoices(quick);
  const quickButton = "whitespace-nowrap";
  // APPROVALS-SIMPLE-1018: no command beside the buttons. The row's line says what the bot wants, in words, and wraps
  // (so all of it is seen); the command is one press away under Show details.
  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      <div role="group" aria-labelledby={labelledBy} aria-busy={feedback.busy !== null || busy} className="flex flex-wrap justify-end gap-2">
        {choices.map((entry, at) => entry.choice === "answer"
          ? (
            <button key={entry.key} type="button" data-needs-quick className={`${at === 0 ? buttonPrimary : buttonQuiet} ${quickButton}`} aria-disabled={busy || undefined}
              onClick={() => { if (!busy) void respond(entry.body); }}>
              {entry.label}
            </button>
          )
          : entry.choice === "allow"
            ? (
              <button key={entry.key} type="button" data-needs-quick {...btn("allow", `${buttonPrimary} ${quickButton}`)} onClick={() => decide("allow", ALLOW_ONCE_BODY)}>
                <ApprovalBusyLabel busy={feedback.busy === "allow"}>{entry.label}</ApprovalBusyLabel>
              </button>
            )
            : (
              <button key={entry.key} type="button" data-needs-quick {...btn("deny", `${buttonDanger} ${quickButton}`)} onClick={() => decide("deny", DENY_BODY)}>
                <ApprovalBusyLabel busy={feedback.busy === "deny"}>{entry.label}</ApprovalBusyLabel>
              </button>
            ))}
      </div>
      <ApprovalConfirmLine prompting={feedback.prompting} className="text-[12px] text-ink-secondary" />
      {error && <p role="alert" className="max-w-xs text-right text-[12px] text-danger">{error}</p>}
    </div>
  );
}
