// Reading a spoken answer to an approval on a call.
//
// It used to count a yes only as the first word, so "I'll allow it for the
// rest of the call" was neither yes nor no: the card stayed open, the work
// waited on it, and the owner thought they had answered (heard live,
// 2026-09-23). And "don't ask me again" began with "don't", so it was a no.

/** A yes as the first word. */
const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|go for it|do it|allow|approve|approved|fine|please do)\b/i;
/** A no as the first word. "stop" and "don't" are read after the call-long
 *  phrases, which include "stop asking" and "don't ask again". */
const PLAIN_NO = /^(no|nope|deny|denied|cancel|never|skip it)\b/i;
const NO = /^(no|nope|don'?t|do not|stop|deny|denied|cancel|never|skip it)\b/i;
/** A yes that covers every ordinary request until the call ends. */
const YES_FOR_CALL =
  /\b(for (the )?rest of (the|this) call|for (the|this) (whole )?call|yes to (all|everything)|allow (it |them )?all|until (i|we) hang up|don'?t (ask|keep asking)( me)?( again)?|stop asking|(no|don'?t) need to ask|always allow|allow everything)\b/i;
/** Consent anywhere in a short answer: "you can go ahead", "sure, do it". */
const YES_ANYWHERE = /\b(yes|yeah|yep|yup|sure|ok|okay|go ahead|go for it|do it|allow( it)?|approve|approved|fine|please do|you can)\b/i;
const NEGATED = /\b(no|nope|not|don'?t|do not|never|deny|denied|cancel|stop|wait)\b/i;
/** Longer than this is a question or a thought, not an answer. */
const SHORT_WORDS = 8;

export type ApprovalAnswer = "allow" | "allow-for-call" | "deny";

/** The owner's decision in `said`, or null when it is not one (a question
 *  about the request, say): consent is never guessed. */
export function approvalAnswer(said: string): ApprovalAnswer | null {
  const text = said.trim().replace(/^(um+|uh+|er+|so|well|oh)[,.\s]+/i, "");
  if (!text) return null;
  if (PLAIN_NO.test(text)) return "deny";
  if (YES_FOR_CALL.test(text)) return "allow-for-call";
  if (NO.test(text)) return "deny";
  if (YES.test(text)) return "allow";
  const short = text.split(/\s+/).length <= SHORT_WORDS;
  const yes = YES_ANYWHERE.test(text);
  const no = NEGATED.test(text);
  if (short && yes && !no) return "allow";
  if (short && no && !yes) return "deny";
  return null;
}
