import { randomBytes } from "node:crypto";
import type { TelegramUpdate } from "./telegram-update.ts";
import type { TelegramButton, TelegramTransport } from "./telegram-transport.ts";
import { QUESTION_LIMITS, QUESTION_TIMEOUT_MS, type QuestionAnswer, type QuestionSpec } from "../shared/questions.ts";

export interface TelegramApproval {
  id: string;
  fingerprint: string;
  summary: string;
  /** A question card (0.1.52 ASK3): the same questions the desktop card
   * shows, answered through the same validated path. Absent for a
   * permission. */
  questions?: QuestionSpec[];
}
/** What the owner decided about a question, in the desktop card's own terms. */
export type TelegramQuestionReply = { behavior: "answer"; answers: QuestionAnswer[] } | { behavior: "skip" };
export interface TelegramApprovalActions {
  pending: () => TelegramApproval[];
  resolve: (approval: TelegramApproval, behavior: "allow" | "deny") => Promise<boolean>;
  /** Deliver a question's answer (or skip). The harness validates it
   * against the persisted card exactly as it does a desktop answer. */
  answer?: (approval: TelegramApproval, reply: TelegramQuestionReply) => Promise<{ ok: true } | { ok: false; error: string }>;
}
type Owner = { senderId: string; chatId: string };
/** Per-question progress for a question offer, process-local like the offer. */
type QuestionDraft = {
  /** index of the question currently on screen */
  cursor: number;
  /** completed answers, in question order */
  answers: QuestionAnswer[];
  /** picks toggled on the current multi-select */
  picks: string[];
  /** the owner's own words for the current question, when allowed */
  other?: string;
  /** "Reply with text" was tapped: the next private message is the answer */
  awaitingText: boolean;
};
type Offer = { approval: TelegramApproval; nonce: string; expires: number; messageId?: number; consumed: boolean; outcome?: string; editAttempted?: boolean; draft?: QuestionDraft };
type ApprovalTransport = Pick<TelegramTransport, "sendMessage" | "answerCallbackQuery"> & Partial<Pick<TelegramTransport, "settleApprovalMessage" | "editQuestionMessage">>;

const PERMISSION_TTL = 600000;
/** A question offer lives as long as the engine waits for the card. */
const QUESTION_TTL = QUESTION_TIMEOUT_MS;
/** Telegram messages cap at 4096 characters; a question that cannot be shown whole stays in-app. */
const QUESTION_TEXT_MAX = 3500;
const label = (text: string) => (text.length > 60 ? `${text.slice(0, 59)}…` : text);
const CHECKED = "☑";
const UNCHECKED = "☐";
const TEXT_ANSWER = "Reply with text";
const SKIP = "Skip question";
const SUBMIT = "Submit";

/** Process-local offers intentionally die on restart/revoke. They authorize one
 * exact pending action, not a new user turn or permanent policy change. */
export class TelegramApprovals {
  private offers = new Map<string, Offer>();
  private readonly actions: TelegramApprovalActions;
  private readonly transport: ApprovalTransport;
  private readonly now: () => number;
  constructor(actions: TelegramApprovalActions,
    transport: ApprovalTransport,
    now: () => number = Date.now) {
    this.actions = actions; this.transport = transport; this.now = now;
  }
  clear() { this.offers.clear(); }
  private stillPending(offer: Offer) {
    return this.actions.pending().some(item => item.id === offer.approval.id && item.fingerprint === offer.approval.fingerprint);
  }
  private async settle(offer: Offer, owner: Owner, signal: AbortSignal) {
    if (!offer.outcome || !offer.messageId || offer.editAttempted || !this.transport.settleApprovalMessage) return;
    offer.editAttempted = true; // cosmetic failure never replays a decision
    const head = offer.draft ? this.questionText(offer, offer.draft.cursor) : offer.approval.summary;
    try {
      await this.transport.settleApprovalMessage({ chatId: owner.chatId, messageId: offer.messageId,
        text: `${head}\n\n${offer.outcome}`, signal });
    } catch { /* The callback result still reports the actual decision. */ }
  }
  async publish(owner: Owner, active: () => boolean, signal: AbortSignal) {
    const pending = this.actions.pending().slice(0, 32);
    for (const [id, offer] of this.offers) {
      if (!active()) return;
      if (!pending.some(item => item.id === id && item.fingerprint === offer.approval.fingerprint) || this.now() >= offer.expires) {
        offer.consumed = true;
        offer.outcome ??= this.now() >= offer.expires
          ? (offer.draft ? "Expired. If you still want to answer, do it in Murage." : "Expired. Review this action in Murage.")
          : (offer.draft ? "No longer waiting for an answer. See the conversation in Murage." : "No longer pending. Review the decision in Murage.");
        await this.settle(offer, owner, signal);
        if (this.now() > offer.expires + 600000 || pending.some(item => item.id === id && item.fingerprint !== offer.approval.fingerprint)) this.offers.delete(id);
      }
    }
    for (const approval of pending) {
      if (!active()) return;
      if (this.offers.has(approval.id)) continue;
      if (this.offers.size >= 32) {
        const oldestSettled = [...this.offers].find(([, offer]) => offer.consumed);
        if (oldestSettled) this.offers.delete(oldestSettled[0]);
        else continue;
      }
      if (approval.questions?.length) {
        await this.publishQuestion(approval, owner, active, signal);
        continue;
      }
      // Never ask an owner to approve details hidden by truncation.
      if (!approval.summary || approval.summary.length > 3000) continue;
      const offer: Offer = { approval: { ...approval }, nonce: randomBytes(24).toString("hex"), expires: this.now() + PERMISSION_TTL, consumed: false };
      this.offers.set(approval.id, offer); // uncertain send must not auto-repeat
      const message = await this.transport.sendMessage({ chatId: owner.chatId,
        text: `${approval.summary}\n\nAllow once or deny this exact action. Expires in 10 minutes.`,
        buttons: [{ text: "Allow once", data: `${offer.nonce}:a` }, { text: "Deny", data: `${offer.nonce}:d` }], signal });
      if (active() && this.offers.get(approval.id) === offer) offer.messageId = message.messageId;
    }
  }

  // ── questions ────────────────────────────────────────────────────────

  /** The message for question `index`: header, text, numbered options, and
   * how to answer. Null when it cannot be shown whole. */
  private questionText(offer: Offer, index: number): string {
    const questions = offer.approval.questions ?? [];
    const question = questions[index]!;
    const lines = [
      questions.length > 1 ? `${offer.approval.summary} (${index + 1}/${questions.length})` : offer.approval.summary,
      `${question.header ? `${question.header}: ` : ""}${question.question}`,
    ];
    if (question.options.length) {
      lines.push("");
      question.options.forEach((option, i) => lines.push(`${i + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`));
    }
    return lines.join("\n");
  }
  private questionHint(question: QuestionSpec): string {
    const how = question.multiSelect
      ? "Tap the options you want, then Submit."
      : question.options.length
        ? "Tap an answer."
        : "";
    const text = question.allowOther ? `${how ? `${how} ` : ""}Tap "${TEXT_ANSWER}" to answer in your own words.` : how;
    return `${text}\nExpires in ${Math.round(QUESTION_TTL / 60000)} minutes.`;
  }
  private questionKeyboard(offer: Offer): TelegramButton[][] {
    const draft = offer.draft!;
    const question = offer.approval.questions![draft.cursor]!;
    const key = (action: string) => `${offer.nonce}:q${draft.cursor}:${action}`;
    const rows: TelegramButton[][] = question.options.map((option, i) => [{
      text: question.multiSelect ? `${draft.picks.includes(option.label) ? CHECKED : UNCHECKED} ${label(option.label)}` : label(option.label),
      data: key(question.multiSelect ? `t${i}` : `o${i}`),
    }]);
    const actions: TelegramButton[] = [];
    if (question.allowOther) actions.push({ text: draft.other ? `${CHECKED} ${TEXT_ANSWER}` : TEXT_ANSWER, data: key("w") });
    if (question.multiSelect) actions.push({ text: SUBMIT, data: key("s") });
    actions.push({ text: SKIP, data: key("x") });
    rows.push(actions);
    return rows;
  }
  private questionBody(offer: Offer): string {
    const draft = offer.draft!;
    const question = offer.approval.questions![draft.cursor]!;
    const note = draft.other ? `\nYour words: ${draft.other}` : "";
    return `${this.questionText(offer, draft.cursor)}${note}\n\n${this.questionHint(question)}`;
  }
  private async publishQuestion(approval: TelegramApproval, owner: Owner, active: () => boolean, signal: AbortSignal) {
    // A question the owner would have to answer blind stays in-app.
    if (!this.actions.answer || !approval.summary) return;
    const offer: Offer = {
      approval: { ...approval, questions: approval.questions!.map(question => ({ ...question })) },
      nonce: randomBytes(24).toString("hex"), expires: this.now() + QUESTION_TTL, consumed: false,
      draft: { cursor: 0, answers: [], picks: [], awaitingText: false },
    };
    if (approval.questions!.some((_, index) => this.questionText(offer, index).length > QUESTION_TEXT_MAX)) return;
    this.offers.set(approval.id, offer); // uncertain send must not auto-repeat
    await this.sendQuestion(offer, owner, active, signal);
  }
  private async sendQuestion(offer: Offer, owner: Owner, active: () => boolean, signal: AbortSignal) {
    const message = await this.transport.sendMessage({ chatId: owner.chatId, text: this.questionBody(offer), keyboard: this.questionKeyboard(offer), signal });
    if (active() && this.offers.get(offer.approval.id) === offer) offer.messageId = message.messageId;
  }
  private async redrawQuestion(offer: Offer, owner: Owner, signal: AbortSignal) {
    if (!offer.messageId || !this.transport.editQuestionMessage) return;
    try {
      await this.transport.editQuestionMessage({ chatId: owner.chatId, messageId: offer.messageId, text: this.questionBody(offer), keyboard: this.questionKeyboard(offer), signal });
    } catch { /* the buttons still carry the state; the next tap re-renders */ }
  }
  /** Record the current question's answer and move on: the next question
   * gets its own message; after the last one the whole answer is delivered
   * through the harness's validated path, exactly once. */
  private async advance(offer: Offer, owner: Owner, answer: QuestionAnswer, active: () => boolean, signal: AbortSignal): Promise<string> {
    const draft = offer.draft!;
    const questions = offer.approval.questions!;
    draft.answers.push(answer);
    const words = [...answer.selected, ...(answer.other ? [answer.other] : [])].join(", ");
    if (draft.cursor + 1 < questions.length) {
      // close this question's message, then ask the next
      if (offer.messageId && this.transport.settleApprovalMessage) {
        try { await this.transport.settleApprovalMessage({ chatId: owner.chatId, messageId: offer.messageId, text: `${this.questionText(offer, draft.cursor)}\n\nYour answer: ${words}`, signal }); } catch { /* cosmetic */ }
      }
      draft.cursor += 1; draft.picks = []; delete draft.other; draft.awaitingText = false;
      offer.messageId = undefined;
      if (active()) await this.sendQuestion(offer, owner, active, signal);
      return `Noted: ${words}`.slice(0, 200);
    }
    // Consume before invoking the engine; exceptions never authorize replay.
    offer.consumed = true;
    let text: string;
    try {
      const result = active() ? await this.actions.answer!(offer.approval, { behavior: "answer", answers: draft.answers }) : { ok: false as const, error: "Telegram is no longer connected." };
      text = result.ok ? "Answered." : `Not delivered: ${result.error}`.slice(0, 200);
    } catch { text = "Could not confirm this answer reached your bot. Check the conversation in Murage; do not repeat it."; }
    offer.outcome = text;
    return text;
  }
  /** "Reply with text" was tapped: the owner's next private message is the
   * answer to the question on screen, not a new prompt for the bot. Returns
   * true when the message was consumed. */
  async captureText(update: Extract<TelegramUpdate, { kind: "message" }>, owner: Owner, active: () => boolean, signal: AbortSignal): Promise<boolean> {
    if (!active() || update.senderId !== owner.senderId || update.chatId !== owner.chatId) return false;
    const offer = [...this.offers.values()].find(item => item.draft?.awaitingText && !item.consumed && this.now() < item.expires);
    if (!offer || !this.stillPending(offer)) return false;
    const draft = offer.draft!;
    const question = offer.approval.questions![draft.cursor]!;
    const text = update.text.trim();
    let reply: string;
    if (/^\/cancel$/i.test(text)) {
      draft.awaitingText = false;
      reply = "Okay — tap an option or Skip on the question above.";
    } else if (text.length > QUESTION_LIMITS.otherChars) {
      reply = `That answer is longer than ${QUESTION_LIMITS.otherChars.toLocaleString("en-US")} characters. Send a shorter one.`;
    } else if (question.multiSelect) {
      draft.other = text; draft.awaitingText = false;
      await this.redrawQuestion(offer, owner, signal);
      reply = "Noted. Tap Submit when you are done, or keep picking options.";
    } else {
      draft.awaitingText = false;
      reply = await this.advance(offer, owner, { id: question.id, selected: [], other: text }, active, signal);
      await this.settle(offer, owner, signal);
    }
    if (active()) await this.transport.sendMessage({ chatId: owner.chatId, text: reply, replyToMessageId: update.messageId, signal });
    return true;
  }
  private async answerQuestion(offer: Offer, index: number, action: string, owner: Owner, active: () => boolean, signal: AbortSignal): Promise<string> {
    const draft = offer.draft!;
    const question = offer.approval.questions![draft.cursor]!;
    if (index !== draft.cursor) return "That question was already answered.";
    const optionAt = (n: number) => question.options[n]?.label;
    if (action === "x") {
      offer.consumed = true;
      let text: string;
      try {
        const result = active() ? await this.actions.answer!(offer.approval, { behavior: "skip" }) : { ok: false as const, error: "Telegram is no longer connected." };
        text = result.ok ? "Skipped. Your bot was told you did not answer." : `Not delivered: ${result.error}`.slice(0, 200);
      } catch { text = "Could not confirm the skip reached your bot. Check the conversation in Murage."; }
      offer.outcome = text;
      return text;
    }
    if (action === "w") {
      if (!question.allowOther) return "This question takes one of its options.";
      draft.awaitingText = true;
      return "Reply in this chat with your answer. Send /cancel to go back to the options.";
    }
    if (action.startsWith("o")) {
      const picked = question.multiSelect ? undefined : optionAt(Number(action.slice(1)));
      if (!picked) return "That option is not available.";
      return this.advance(offer, owner, { id: question.id, selected: [picked] }, active, signal);
    }
    if (action.startsWith("t")) {
      const picked = question.multiSelect ? optionAt(Number(action.slice(1))) : undefined;
      if (!picked) return "That option is not available.";
      draft.picks = draft.picks.includes(picked) ? draft.picks.filter(item => item !== picked) : [...draft.picks, picked];
      await this.redrawQuestion(offer, owner, signal);
      return draft.picks.length ? `Selected: ${draft.picks.join(", ")}`.slice(0, 200) : "Nothing selected yet.";
    }
    if (action === "s") {
      if (!question.multiSelect) return "That option is not available.";
      if (!draft.picks.length && !draft.other) return "Pick at least one option first.";
      return this.advance(offer, owner, { id: question.id, selected: [...draft.picks], ...(draft.other ? { other: draft.other } : {}) }, active, signal);
    }
    return "That option is not available.";
  }

  async answer(update: Extract<TelegramUpdate, { kind: "callback" }>, owner: Owner, active: () => boolean, signal: AbortSignal) {
    if (!active() || update.senderId !== owner.senderId || update.chatId !== owner.chatId) return;
    const permission = /^([a-f0-9]{48}):([ad])$/.exec(update.data);
    const question = /^([a-f0-9]{48}):q(\d{1,2}):([ot]\d{1,2}|[swx])$/.exec(update.data);
    const nonce = permission?.[1] ?? question?.[1];
    const offer = nonce ? [...this.offers.values()].find(item => item.nonce === nonce) : undefined;
    let text = offer?.consumed && offer.messageId === update.messageId && offer.outcome
      ? offer.outcome : "This approval is expired, changed, or already answered. Review it in Murage.";
    if (offer && !offer.consumed && offer.messageId === update.messageId && this.now() < offer.expires && this.stillPending(offer)) {
      if (question && offer.draft) {
        text = await this.answerQuestion(offer, Number(question[2]), question[3]!, owner, active, signal);
      } else if (permission && !offer.draft) {
        // Consume before invoking the engine; exceptions never authorize replay.
        offer.consumed = true;
        try {
          const ok = active() && await this.actions.resolve(offer.approval, permission[2] === "a" ? "allow" : "deny");
          if (ok) text = permission[2] === "a" ? "Allowed once." : "Denied.";
        } catch { text = "Could not confirm this decision. Review the action in Murage; do not repeat it."; }
        offer.outcome = text;
      }
    }
    if (active()) {
      try { await this.transport.answerCallbackQuery({ id: update.callbackId, text, signal }); }
      finally { if (active() && offer?.consumed) await this.settle(offer, owner, signal); }
    }
  }
}
