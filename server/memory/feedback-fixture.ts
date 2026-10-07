// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Labelled messages for feedback detection (bot-learning batch B2). Each row is
// an owner message after a bot turn, what a well-behaved stage 2 classifier
// answers (`model`), and what the pipeline must decide. `noConn` is the
// decision when there is no learning connection (stage 1 only, strength capped
// at 2, correction only after "no,", "instead", "next time", "from now on" or
// "remember"); absent means the same as `expect`, `null` means not applicable.
export type FixtureExpect =
  | { outcome: "none" }
  | { outcome: "dropped" }
  | { outcome: "feedback"; state: "detected" | "unsure" | "ignored"; polarity: "+" | "-"; strength: 1 | 2 | 3; correction?: string | null; target?: "turn" | "action" | "other"; action?: string | null };

export interface FixtureRow {
  id: string;
  category: "praise" | "complaint" | "correction" | "sarcasm" | "third-party" | "quoted" | "off-topic" | "late" | "confidence" | "contract" | "not-feedback";
  text: string;
  /** The bot turn it follows; defaults to a short email draft that sent an email. */
  prior?: { text?: string; ageHours?: number; lastActionFailed?: boolean; actions?: Array<{ label: string; summary?: string; ok?: boolean }> };
  replyTo?: boolean;
  /** Stage 2's answer. A string is sent raw (to test contract failures); "throw" makes the classifier fail. */
  model?: Record<string, unknown> | string | "throw";
  expect: FixtureExpect;
  noConn?: FixtureExpect | null;
}

const yes = (polarity: "+" | "-", strength: 1 | 2 | 3, confidence = 0.9, correction: string | null = null, target = "turn") =>
  ({ isFeedback: true, target, polarity, strength, correction, confidence });
const no = { isFeedback: false, target: "other", polarity: "-", strength: 1, correction: null, confidence: 0.95 };
const fb = (state: "detected" | "unsure" | "ignored", polarity: "+" | "-", strength: 1 | 2 | 3, extra: Partial<Extract<FixtureExpect, { outcome: "feedback" }>> = {}): FixtureExpect => ({ outcome: "feedback", state, polarity, strength, ...extra });
const NONE: FixtureExpect = { outcome: "none" };

export const FEEDBACK_FIXTURE: readonly FixtureRow[] = [
  // ---- praise
  { id: "praise-good-job", category: "praise", text: "good job", model: yes("+", 2), expect: fb("detected", "+", 2) },
  { id: "praise-perfect", category: "praise", text: "perfect", model: yes("+", 3), expect: fb("detected", "+", 3), noConn: fb("detected", "+", 2) },
  { id: "praise-well-done-thanks", category: "praise", text: "Well done, thanks", model: yes("+", 2), expect: fb("detected", "+", 2) },
  { id: "praise-exactly", category: "praise", text: "exactly", model: yes("+", 2), expect: fb("detected", "+", 2) },
  { id: "praise-love-it", category: "praise", text: "love it", model: yes("+", 3), expect: fb("detected", "+", 3), noConn: fb("detected", "+", 2) },
  { id: "praise-nailed-it", category: "praise", text: "nailed it!", model: yes("+", 3), expect: fb("detected", "+", 3), noConn: fb("detected", "+", 2) },
  { id: "praise-thats-it", category: "praise", text: "that's it", model: yes("+", 2), expect: fb("detected", "+", 2) },
  { id: "praise-great-work", category: "praise", text: "great work on that", model: yes("+", 2), expect: fb("detected", "+", 2) },
  { id: "praise-caps", category: "praise", text: "PERFECT", model: yes("+", 3), expect: fb("detected", "+", 3), noConn: fb("detected", "+", 2) },
  { id: "praise-intensifier-raises", category: "praise", text: "good job, really", model: yes("+", 2), expect: fb("detected", "+", 3), noConn: fb("detected", "+", 2) },
  { id: "praise-mild-ok-dropped", category: "praise", text: "ok", replyTo: true, model: yes("+", 1, 0.8), expect: NONE, noConn: NONE },
  { id: "praise-mild-thanks-dropped", category: "praise", text: "thanks", replyTo: true, model: yes("+", 1, 0.8), expect: NONE, noConn: NONE },
  { id: "praise-nice-one-model-only", category: "praise", text: "nice one", replyTo: true, model: yes("+", 2), expect: NONE, noConn: NONE },
  { id: "praise-the-email", category: "praise", text: "Perfect, that's exactly the email I wanted", model: yes("+", 3), expect: fb("detected", "+", 3), noConn: fb("detected", "+", 2) },

  // ---- complaint
  { id: "complaint-wrong", category: "complaint", text: "wrong", model: yes("-", 2), expect: fb("detected", "-", 2) },
  { id: "complaint-sucks", category: "complaint", text: "that sucks", model: yes("-", 3), expect: fb("detected", "-", 3), noConn: fb("detected", "-", 2) },
  { id: "complaint-terrible", category: "complaint", text: "terrible", model: yes("-", 3), expect: fb("detected", "-", 3), noConn: fb("detected", "-", 2) },
  { id: "complaint-not-quite-mild", category: "complaint", text: "not quite", model: yes("-", 1, 0.85), expect: fb("detected", "-", 1) },
  { id: "complaint-not-what-asked", category: "complaint", text: "that's not what I asked", model: yes("-", 2), expect: fb("detected", "-", 2) },
  { id: "complaint-stop-doing", category: "complaint", text: "stop doing that", model: yes("-", 2), expect: fb("detected", "-", 2) },
  { id: "complaint-meh", category: "complaint", text: "meh", model: yes("-", 1, 0.8), expect: fb("detected", "-", 1) },
  { id: "complaint-caps", category: "complaint", text: "WRONG", model: yes("-", 2), expect: fb("detected", "-", 3), noConn: fb("detected", "-", 2) },
  { id: "complaint-repeated-no", category: "complaint", text: "no no no", model: yes("-", 1, 0.85), expect: fb("detected", "-", 2) },
  { id: "complaint-this-sucks", category: "complaint", text: "this sucks", model: yes("-", 3), expect: fb("detected", "-", 3), noConn: fb("detected", "-", 2) },
  { id: "complaint-not-that", category: "complaint", text: "not that", model: yes("-", 2), expect: fb("detected", "-", 2) },
  { id: "complaint-names-action-by-text", category: "complaint", text: "Terrible. You sent it to the wrong list", model: yes("-", 3), expect: fb("detected", "-", 3, { target: "action", action: "send_email" }), noConn: fb("detected", "-", 2, { target: "action", action: "send_email" }) },
  { id: "complaint-model-names-action", category: "complaint", text: "that was wrong", prior: { actions: [{ label: "send_email", summary: "email to client" }, { label: "calendar_create", summary: "added a meeting" }] }, model: yes("-", 2, 0.9, null, "action:calendar_create"), expect: fb("detected", "-", 2, { target: "action", action: "calendar_create" }), noConn: fb("detected", "-", 2) },
  { id: "complaint-model-invents-action", category: "complaint", text: "that was wrong", model: yes("-", 2, 0.9, null, "action:delete_everything"), expect: fb("detected", "-", 2, { target: "turn" }), noConn: fb("detected", "-", 2) },

  // ---- corrections
  { id: "corr-no-do-it-like", category: "correction", text: "no, do it like the last one", model: yes("-", 2, 0.9, "do it like the last one"), expect: fb("detected", "-", 3, { correction: "do it like the last one" }), noConn: fb("detected", "-", 2, { correction: "do it like the last one" }) },
  { id: "corr-next-time", category: "correction", text: "next time, lead with the decision", model: yes("-", 1, 0.9, "lead with the decision"), expect: fb("detected", "-", 2, { correction: "lead with the decision" }) },
  { id: "corr-from-now-on", category: "correction", text: "from now on always cc my assistant", model: yes("-", 1, 0.9, "always cc my assistant"), expect: fb("detected", "-", 2, { correction: "from now on always cc my assistant" }) },
  { id: "corr-remember", category: "correction", text: "remember to sign off with just my first name", model: yes("-", 1, 0.9, "sign off with just my first name"), expect: fb("detected", "-", 2, { correction: "remember to sign off with just my first name" }) },
  { id: "corr-instead", category: "correction", text: "instead use the shorter version", model: yes("-", 1, 0.9, "use the shorter version"), expect: fb("detected", "-", 2, { correction: "instead use the shorter version" }), noConn: fb("detected", "-", 2, { correction: "instead use the shorter version" }) },
  { id: "corr-dont-model-only", category: "correction", text: "don't use emojis", model: yes("-", 1, 0.9, "don't use emojis"), expect: fb("detected", "-", 2, { correction: "don't use emojis" }), noConn: NONE },
  { id: "corr-no-wrong-then-instruction", category: "correction", text: "no, that's wrong, use the Q3 numbers", model: yes("-", 2, 0.9, "use the Q3 numbers"), expect: fb("detected", "-", 3, { correction: "use the Q3 numbers" }), noConn: fb("detected", "-", 2, { correction: "use the Q3 numbers" }) },
  { id: "corr-should-have", category: "correction", text: "should have asked me first", model: yes("-", 1, 0.9, "ask the owner first"), expect: fb("detected", "-", 1, { correction: null }), noConn: NONE },
  { id: "corr-never-names-day", category: "correction", text: "never send on Fridays", model: yes("-", 1, 0.9, "never send on Fridays"), expect: fb("detected", "-", 2, { correction: "never send on Fridays" }), noConn: NONE },
  { id: "corr-always-link", category: "correction", text: "always include the unsubscribe link", model: yes("-", 1, 0.9, "always include the unsubscribe link"), expect: fb("detected", "-", 2, { correction: "always include the unsubscribe link" }), noConn: NONE },
  { id: "corr-wrong-then-instead", category: "correction", text: "That's wrong. Use bullet points instead.", model: yes("-", 2, 0.9, "Use bullet points"), expect: fb("detected", "-", 3, { correction: "Use bullet points instead" }), noConn: fb("detected", "-", 2, { correction: null }) },
  { id: "corr-names-a-tool-is-not-venting", category: "correction", text: "no, send it through Slack instead", model: yes("-", 1, 0.9, "send it through Slack instead"), expect: fb("detected", "-", 2, { correction: "send it through Slack instead" }) },
  { id: "corr-reply-no-lexicon", category: "correction", text: "I said no emojis", replyTo: true, model: yes("-", 1, 0.85, "no emojis"), expect: NONE, noConn: NONE },

  // ---- sarcasm
  { id: "sarcasm-perfect-now-broken", category: "sarcasm", text: "perfect, now it's broken", model: yes("+", 2, 0.9), expect: fb("unsure", "-", 2) },
  { id: "sarcasm-oh-great", category: "sarcasm", text: "Oh great, well done", model: yes("+", 2, 0.9), expect: fb("unsure", "-", 2) },
  { id: "sarcasm-thanks-a-lot", category: "sarcasm", text: "thanks a lot, perfect", model: yes("+", 3, 0.9), expect: fb("unsure", "-", 3), noConn: fb("unsure", "-", 2) },
  { id: "sarcasm-good-job-nothing-works", category: "sarcasm", text: "good job, now nothing works", model: yes("+", 2, 0.9), expect: fb("unsure", "-", 2) },
  { id: "sarcasm-praise-after-failed-action", category: "sarcasm", text: "perfect", prior: { actions: [{ label: "send_email", summary: "email to client", ok: false }] }, model: yes("+", 3, 0.9), expect: fb("unsure", "+", 3), noConn: fb("unsure", "+", 2) },
  { id: "sarcasm-wow-really-helpful", category: "sarcasm", text: "wow, great, really helpful", replyTo: true, model: yes("+", 2, 0.9), expect: NONE, noConn: NONE },

  // ---- venting at a third party
  { id: "third-boss", category: "third-party", text: "My boss is terrible", model: yes("-", 3, 0.9, null, "other"), expect: fb("ignored", "-", 3, { target: "other" }), noConn: fb("ignored", "-", 2, { target: "other" }) },
  { id: "third-company", category: "third-party", text: "Honestly Stripe's dashboard is wrong again", model: yes("-", 2, 0.9, null, "other"), expect: fb("ignored", "-", 2, { target: "other" }) },
  { id: "third-mention", category: "third-party", text: "@dave is terrible at this", model: yes("-", 3, 0.9, null, "other"), expect: fb("ignored", "-", 3, { target: "other" }), noConn: fb("ignored", "-", 2, { target: "other" }) },
  { id: "third-she-is", category: "third-party", text: "she is wrong about the deadline", model: yes("-", 2, 0.9, null, "other"), expect: fb("ignored", "-", 2, { target: "other" }) },
  { id: "third-model-says-other", category: "third-party", text: "that sucks", model: yes("-", 3, 0.9, null, "other"), expect: fb("ignored", "-", 3, { target: "other" }), noConn: fb("detected", "-", 2) },
  { id: "third-praise-person", category: "third-party", text: "Dave did a good job on the deck", model: yes("+", 2, 0.9, null, "other"), expect: fb("ignored", "+", 2, { target: "other" }) },
  { id: "third-direct-address-stays-feedback", category: "third-party", text: "Wrong, you sent it to Acme", model: yes("-", 2, 0.9), expect: fb("detected", "-", 2, { target: "action", action: "send_email" }) },
  { id: "third-inc-suffix", category: "third-party", text: "Globex Corp is terrible", model: yes("-", 3, 0.9, null, "other"), expect: fb("ignored", "-", 3, { target: "other" }), noConn: fb("ignored", "-", 2, { target: "other" }) },

  // ---- quoted or forwarded text
  { id: "quoted-block", category: "quoted", text: "> That sucks, honestly", model: yes("-", 3, 0.9), expect: fb("ignored", "-", 3, { target: "other" }), noConn: fb("ignored", "-", 2, { target: "other" }) },
  { id: "quoted-inline", category: "quoted", text: 'He wrote "that sucks and I hate it" in his review', model: yes("-", 3, 0.9), expect: fb("ignored", "-", 3, { target: "other" }), noConn: fb("ignored", "-", 2, { target: "other" }) },
  { id: "quoted-forwarded", category: "quoted", text: "Forwarded message: wrong address, terrible service", model: yes("-", 3, 0.9), expect: fb("ignored", "-", 3, { target: "other" }), noConn: fb("ignored", "-", 2, { target: "other" }) },
  { id: "quoted-code-fence", category: "quoted", text: "```\nperfect\n```", model: yes("+", 3, 0.9), expect: fb("ignored", "+", 3, { target: "other" }), noConn: fb("ignored", "+", 2, { target: "other" }) },

  // ---- off-topic
  { id: "off-btw", category: "off-topic", text: "good job. btw what's the weather tomorrow", model: yes("+", 2, 0.85), expect: fb("unsure", "+", 2) },
  { id: "off-unrelated", category: "off-topic", text: "perfect. unrelated, can you book a flight to Lisbon", model: yes("+", 3, 0.85), expect: fb("unsure", "+", 3), noConn: fb("unsure", "+", 2) },
  { id: "off-new-subject", category: "off-topic", text: "Perfect, now let's discuss quarterly revenue forecasts for next month planning", model: yes("+", 3, 0.85), expect: fb("unsure", "+", 3), noConn: fb("unsure", "+", 2) },
  { id: "off-control-on-topic", category: "off-topic", text: "Perfect, that's exactly the email I wanted", model: yes("+", 3, 0.9), expect: fb("detected", "+", 3), noConn: fb("detected", "+", 2) },
  { id: "off-model-says-no", category: "off-topic", text: "what's the weather tomorrow", replyTo: true, model: no, expect: NONE, noConn: NONE },

  // ---- late replies
  { id: "late-praise-8h", category: "late", text: "good job", prior: { ageHours: 8 }, model: yes("+", 2), expect: fb("unsure", "+", 2) },
  { id: "late-complaint-7h", category: "late", text: "wrong", prior: { ageHours: 7 }, model: yes("-", 2), expect: fb("unsure", "-", 2) },
  { id: "late-control-5h", category: "late", text: "good job", prior: { ageHours: 5 }, model: yes("+", 2), expect: fb("detected", "+", 2) },
  { id: "late-reply-to-old-message", category: "late", text: "no, use the shorter version", prior: { ageHours: 30 }, replyTo: true, model: yes("-", 1, 0.9, "use the shorter version"), expect: fb("unsure", "-", 2, { correction: "use the shorter version" }), noConn: fb("unsure", "-", 2, { correction: "use the shorter version" }) },

  // ---- confidence gate
  { id: "conf-065-unsure", category: "confidence", text: "good job", model: yes("+", 2, 0.65), expect: fb("unsure", "+", 2), noConn: null },
  { id: "conf-069-unsure", category: "confidence", text: "wrong", model: yes("-", 2, 0.69), expect: fb("unsure", "-", 2), noConn: null },
  { id: "conf-070-detected", category: "confidence", text: "wrong", model: yes("-", 2, 0.7), expect: fb("detected", "-", 2) },
  { id: "conf-reply-model-unsure", category: "confidence", text: "hmm okay", replyTo: true, model: yes("-", 1, 0.4), expect: NONE, noConn: NONE },

  // ---- stage 2 contract failures fall back to stage 1 (cap 2, limited correction)
  { id: "contract-garbage-text", category: "contract", text: "good job", model: "I think it is feedback", expect: fb("detected", "+", 2), noConn: null },
  { id: "contract-bad-strength", category: "contract", text: "that sucks", model: { isFeedback: true, target: "turn", polarity: "-", strength: 5, correction: null, confidence: 0.9 }, expect: fb("detected", "-", 2), noConn: null },
  { id: "contract-throws", category: "contract", text: "perfect", model: "throw", expect: fb("detected", "+", 2), noConn: null },
  { id: "contract-missing-confidence", category: "contract", text: "wrong", model: { isFeedback: true, target: "turn", polarity: "-", strength: 2, correction: null }, expect: fb("detected", "-", 2), noConn: null },
  { id: "contract-fenced-json-ok", category: "contract", text: "good job", model: "```json\n" + JSON.stringify(yes("+", 3)) + "\n```", expect: fb("detected", "+", 3), noConn: null },
  { id: "contract-correction-on-praise-dropped", category: "contract", text: "good job", model: yes("+", 2, 0.9, "keep doing this"), expect: fb("detected", "+", 2, { correction: null }) },

  // ---- not feedback at all
  { id: "none-no-problem", category: "not-feedback", text: "no problem, thanks", model: no, expect: NONE },
  { id: "none-no-worries", category: "not-feedback", text: "no worries", replyTo: true, model: no, expect: NONE },
  { id: "none-new-request", category: "not-feedback", text: "can you also check the calendar", model: no, expect: NONE },
  { id: "none-question-about-wrong", category: "not-feedback", text: "what's wrong with the report?", model: no, expect: NONE },
  { id: "none-send-to", category: "not-feedback", text: "send it to Dana", replyTo: true, model: no, expect: NONE },
  { id: "none-no-answers-question", category: "not-feedback", text: "no", prior: { text: "Should I send it now?" }, model: no, expect: NONE },
  { id: "none-yes-exactly-answers-question", category: "not-feedback", text: "yes exactly", prior: { text: "Do you want me to send it to the whole list?" }, model: no, expect: NONE },
  { id: "none-too-long", category: "not-feedback", text: "perfect " + "and then please also remember to do all of the other things on my list ".repeat(5), model: yes("+", 3), expect: NONE },
  { id: "none-never-mind", category: "not-feedback", text: "never mind, I'll do it myself", model: no, expect: NONE },
  { id: "none-always-asks", category: "not-feedback", text: "I always read these on Sunday", model: no, expect: NONE },
];
