// Teach intent (TEACH-ENTRY 1.0.23 D9.1): does an OWNER message offer to teach
// the bot a procedure? One pure function, read by the renderer (the Teach card)
// and by the server (the one conditional prompt note), so both give the same
// answer. No I/O and no model call: a handful of anchored expressions over at
// most 240 characters of the message being sent, never the history.
//
// A phrase matches only a BARE offer: the offer must be the whole message. Any
// request after it (a second sentence, a colon, a semicolon, a new line, or
// ", and/then/so/but ..."), a question about remembering, a quote or code, or a
// learner other than "you" means a normal turn.

export type TeachIntent =
  | { via: "slash"; task: string }
  | { via: "phrase"; kind: "teach-you" | "show-you" | "remember-how"; task: string };

/** Characters of the message the detector reads; a longer message is never a bare offer. */
export const TEACH_INTENT_WINDOW = 240;
/** Same soft cap as a learned skill's description (server/skill-learn.ts LEARN_DESCRIPTION_SOFT_MAX). */
export const TEACH_TASK_MAX = 60;

const SLASH = /^\/teach(?=\s|$)\s*([\s\S]*)$/i;
const NEGATION = new Set(["not", "don't", "dont", "never", "no", "can't", "cant", "cannot", "won't", "wont", "wouldn't", "shouldn't"]);
const LEADS = new Set([
  "i want to", "i wanna", "i'd like to", "i would like to", "i really want to", "i need to",
  "let me", "let us", "let's", "can i", "could i", "may i",
  "i'll", "i will", "i'm going to", "i am going to", "i'm gonna", "we want to", "we'll", "we will",
]);
const BARE_OBJECT = /^(?:something|a skill|a new skill|a thing|this)$/;
const NO_TASK = /^(?:this|that|it)$/;

/** First letter capitalised, a leading "do " and a trailing "this/that/it" dropped, cut at a word to 60. */
export function teachTaskPrefill(words: string): string {
  let task = words.split(/[.!?\n]/, 1)[0]!.replace(/\s+/g, " ").trim();
  task = task.replace(/^do\s+/i, "").replace(/\s+(?:this|that|it)$/i, "").trim();
  if (NO_TASK.test(task.toLowerCase())) task = "";
  if (task.length > TEACH_TASK_MAX) {
    const cut = task.slice(0, TEACH_TASK_MAX + 1);
    const space = cut.lastIndexOf(" ");
    task = (space > 0 ? cut.slice(0, space) : cut.slice(0, TEACH_TASK_MAX)).trim();
  }
  return task ? task[0]!.toUpperCase() + task.slice(1) : "";
}

function stripLead(text: string, botName: string | undefined): string {
  let rest = text;
  const name = botName?.trim().toLowerCase();
  for (let i = 0; i < 2; i += 1) {
    const before = rest;
    rest = rest.replace(/^(?:ok|okay|so|hey)\b[,!]?\s+/, "");
    if (name && rest.startsWith(name)) {
      const after = rest.slice(name.length);
      const m = /^\s*,\s+/.exec(after);
      if (m) rest = after.slice(m[0].length);
    }
    if (rest === before) break;
  }
  return rest;
}

/** The offer must end where its task ends: only trailing . ! ? "please" or "now" may follow. */
function bareRest(rest: string): string | null {
  const body = rest.replace(/(?:[\s,]+(?:please|now))*[\s.!?]*$/i, "").trim();
  if (/[.!?:;\n]/.test(body)) return null;
  if (/,\s*(?:and|then|so|but)\b/.test(body)) return null;
  return body;
}

/** Whether an OWNER message asks to teach the bot a procedure. Pure: no I/O, no model, ≤ 240 chars read. */
export function teachIntent(text: string, botName?: string): TeachIntent | null {
  const trimmed = text.trim();
  const slash = SLASH.exec(trimmed);
  if (slash) return { via: "slash", task: teachTaskPrefill(slash[1]!) };
  // A quote, a code span or a fence is something the owner pasted, never a bare offer (fail closed).
  if (/`/.test(trimmed) || /^\s*>/m.test(trimmed)) return null;
  if (trimmed.length > TEACH_INTENT_WINDOW) return null;
  const lower = stripLead(trimmed.toLowerCase().replace(/[’‘]/g, "'").replace(/[ \t]+/g, " "), botName);
  const original = trimmed.replace(/[ \t]+/g, " ");
  const offset = original.length - lower.length;
  const keep = (from: number): string => original.slice(offset + from);

  const remember = /^(remember|learn) how (to|i) (\S[\s\S]*)$/.exec(lower);
  if (remember) {
    // Imperative only: "Remember how I do X?" is a question about the past, not an offer.
    if (/\?\s*$/.test(lower)) return null;
    const rest = bareRest(keep(lower.length - remember[3]!.length));
    if (rest === null) return null;
    return { via: "phrase", kind: "remember-how", task: teachTaskPrefill(rest) };
  }

  const watch = /^watch me (\S[\s\S]*)$/.exec(lower);
  if (watch) {
    const rest = bareRest(keep(lower.length - watch[1]!.length));
    if (rest === null) return null;
    return { via: "phrase", kind: "show-you", task: teachTaskPrefill(rest) };
  }

  const verb = /^((?:[a-z']+ ){0,5}?)(teach|show) ([a-z']+)(?: ([\s\S]*))?$/.exec(lower);
  if (!verb) return null;
  const leadWords = verb[1]!.trim().split(" ").filter(Boolean);
  if (leadWords.slice(-3).some((w) => NEGATION.has(w))) return null;
  if (!LEADS.has(leadWords.filter((w) => !NEGATION.has(w)).join(" "))) return null;
  if (verb[3] !== "you") return null;
  const tail = verb[4] ?? "";
  const restOriginal = tail ? keep(lower.length - tail.length) : "";
  const rest = bareRest(restOriginal);
  if (rest === null) return null;
  const restLower = rest.toLowerCase();
  if (verb[2] === "show") {
    const how = /^how (?:i|we|to) (\S.*)$/.exec(restLower);
    if (!how) return null;
    return { via: "phrase", kind: "show-you", task: teachTaskPrefill(rest.slice(rest.length - how[1]!.length)) };
  }
  if (BARE_OBJECT.test(restLower)) return { via: "phrase", kind: "teach-you", task: "" };
  const how = /^(?:how (?:to|i|we)|to) (\S.*)$/.exec(restLower);
  if (!how) return null;
  return { via: "phrase", kind: "teach-you", task: teachTaskPrefill(rest.slice(rest.length - how[1]!.length)) };
}
