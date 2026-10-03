// Reading a spoken answer to an approval on a call.
//
// It used to count a yes only as the first word, so "I'll allow it for the
// rest of the call" was neither yes nor no: the card stayed open, the work
// waited on it, and the owner thought they had answered (heard live,
// 2026-09-23). And "don't ask me again" began with "don't", so it was a no.

/** A yes as the first word. */
const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|go for it|do it|allow|approve|approved|fine|please do)\b/i;
/** A no as the first word. */
const NO = /^(no|nope|nah|don'?t|do not|stop|deny|denied|cancel|never|skip it)\b/i;
/** A yes that covers the ordinary requests until the call ends. */
const YES_FOR_CALL =
  /\b(for (the )?rest of (the|this) call|for (the|this) (whole )?call|yes to (all|everything)|allow (it |them )?all|until (i|we) hang up|always allow|allow everything)\b/i;
/** Words whose negation is about asking, not about the request: "don't ask me
 *  again" is a yes for the call, but only when nothing else is negated. */
const STOP_ASKING = /\b(don'?t (ask|keep asking)( me)?( again)?|stop asking|no need to ask)\b/i;
/** Consent anywhere in a short answer: "you can go ahead", "sure, do it". */
const YES_ANYWHERE = /\b(yes|yeah|yep|yup|sure|ok|okay|go ahead|go for it|do it|allow( it)?|approve|approved|fine|please do|you can)\b/i;
/** Speech-to-text often drops the apostrophe ("dont allow everything"), so
 *  the bare spellings count as a negation too. */
const NEGATED = /\b(no|nope|nah|not|never|nothing|deny|denied|cancel|stop|wait|do not|dont|cant|wont|didnt|shouldnt)\b|n't\b/i;
/** Longer than this is a question or a thought, not an answer. */
const SHORT_WORDS = 8;

export type ApprovalAnswer = "allow" | "allow-for-call" | "deny";

/** The owner's decision in `said`, or null when it is not one (a question
 *  about the request, say): consent is never guessed.
 *
 *  A negation that comes before a yes governs it ("do not allow everything",
 *  "no, don't allow it") and is a no. A yes followed by a negation ("allow it
 *  but not the email") is unclear, so the card stays open and the bot asks
 *  again. */
export function approvalAnswer(said: string): ApprovalAnswer | null {
  const text = said.trim().replace(/[\u2018\u2019]/g, "'").replace(/^(um+|uh+|er+|so|well|oh)[,.\s]+/i, "");
  if (!text) return null;
  const asking = STOP_ASKING.exec(text);
  // the asking phrase is blanked so its own "don't" or "no" is not a refusal
  const rest = asking ? text.replace(STOP_ASKING, " ".repeat(asking[0].length)) : text;
  const negAt = rest.search(NEGATED);
  const callAt = text.search(YES_FOR_CALL);
  const yesAts = [callAt, asking ? asking.index : -1, rest.search(YES_ANYWHERE)].filter((at) => at >= 0);
  const yesAt = yesAts.length ? Math.min(...yesAts) : -1;
  if (negAt >= 0) {
    if (yesAt < 0) return NO.test(text) || text.split(/\s+/).length <= SHORT_WORDS ? "deny" : null;
    return negAt < yesAt ? "deny" : null;
  }
  if (callAt >= 0 || asking) return "allow-for-call";
  if (yesAt < 0) return null;
  return YES.test(text) || text.split(/\s+/).length <= SHORT_WORDS ? "allow" : null;
}
