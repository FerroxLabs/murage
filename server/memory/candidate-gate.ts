// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The S4 quality gate (designs/MEMORY-GATE-1012.md): thin or passing extraction candidates stop here, before grounding, any write or
// any keep-card. Pure and deterministic, and it can only drop. A false drop costs a real memory and a thin keep costs one card, so a
// line is dropped only when ALL of it matches a closed shape; a name, a number or one extra word keeps it. Other languages match nothing.
export const GATE_REASONS = ["placeholder", "transient", "thin"] as const;
export type GateReason = typeof GATE_REASONS[number];
export type GateCounts = Record<GateReason, number>;
export interface GateFields { text: string; claimType?: string; update?: boolean; object?: string; when?: string; transient?: boolean }

/** Longer than this was never one of these shapes; the text rules are not read over it. */
const MAX_WORDS = 10, MAX_CHARS = 240, DAY_MS = 86_400_000;
/** Fiction and procedures are not statements about the owner's day; a correction that goes missing leaves a stale fact standing. */
const EXEMPT_CLAIMS = new Set(["character-canon", "procedure"]);

const SUBJECT = "(?:the (?:user|speaker|owner|person)|you|i|we|they|he|she)";
const BE = "(?: is| are| am|'s|'re|'m)";
const OWN = "(?:the|a|an|my|your|his|her|their|our)";
const NOW = "(?:currently|still|already|just|now|right now|presently|at the moment|today)";
/** No negation, plan or habit word: "You did not send the message", "You will send the file" and "You always read the post" stay. */
const AUX = "(?:has|have|had|just|really|also|still|already|recently)";
/** Handling or reacting only, never authorship or ownership: "You wrote the document" and "You own the image" stay. */
const VERB = "(?:likes?|liked|loves?|loved|enjoys?|enjoyed|sees?|saw|seen|views?|viewed|watch(?:es|ed)?|reads?|checks?|checked|opens?|opened|sends?|sent|shares?|shared|forwards?|forwarded|posts?|posted|uploads?|uploaded|attach(?:es|ed)?|receives?|received)";
const MEDIA = "(?:photo|image|picture|pic|screenshot|file|attachment|document|doc|video|clip|link|message|post)s?";
const PLACE = "(?:airport|gate|terminal|station|train station|bus station|bus stop|hotel|gym|office|restaurant|cafe|café|coffee shop|bar|pub|store|shop|supermarket|grocery store|mall|beach|lounge|lobby|queue|line|car|cab|taxi|uber|train|plane|flight|bus|ferry|subway|metro|traffic|meeting|call|home|work)";
const MEAL = "(?:breakfast|brunch|lunch|dinner|coffee|tea|beer|wine|drink|snack|meal|food)";
const PASSING = "(?:tired|sleepy|hungry|thirsty|sick|ill|unwell|cold|hot|fine|good|great|okay|ok|better|worse|bored|exhausted|sore)";
const TOWARD = `(?:home|back|out|(?:to|into|toward|towards) (?:${OWN} )?${PLACE})`;
const STATE = [
  `(?:at|in|on) (?:${OWN} )?${PLACE}`,
  `(?:sitting|standing|waiting|stuck|parked) (?:at|in|on|by|for) (?:${OWN} )?${PLACE}`,
  `(?:heading|going|driving|walking) ${TOWARD}`,
  `on (?:${OWN} )?way(?: ${TOWARD})?`,
  `(?:eating|having|drinking|grabbing|getting) (?:(?:a|an|some|my|your|his|her|their|our) )?${MEAL}`,
  "(?:waiting|boarding|commuting|traveling|travelling|sleeping|resting)",
  "about to (?:leave|board|land|take off|head out|go out|eat|sleep|arrive|step out|sign off)",
  `feeling (?:(?:a bit|a little|very|really|so|quite|pretty) )?${PASSING}`,
].join("|");

const BARE = `(?:it|this|that|these|those|(?:(?:${OWN}|this|that|these|those) )?${MEDIA})`;
const PLACEHOLDER = new RegExp(`^${SUBJECT}(?: ${AUX}){0,2} ${VERB} (?:it|this|that|these|those|(?:${OWN}|this|that|these|those) ${MEDIA})$`, "i");
const BARE_OBJECT = new RegExp(`^${BARE}$`, "i");
const PRESENT_STATE = new RegExp(`^(?:${SUBJECT}${BE} )?(?:${NOW} ){0,2}(?:${STATE})(?: ${NOW}){0,2}$`, "i");
const ACKNOWLEDGEMENT = /^(?:ok|okay|yes|yep|yeah|no|nope|sure|thanks|thank you|sounds good|got it|noted|great|cool|nice)$/i;
/** A digit, or a capital after the first word: a name, a place or a date means the line says something specific. */
const SPECIFIC = /\d| (?!I(?:'| |$))\p{Lu}/u;

function plainLine(text: string): string | null {
  if (text.length > MAX_CHARS) return null;
  const line = text.trim().replace(/[‘’]/g, "'").replace(/\s+/g, " ").replace(/[.!?…,;:]+$/, "");
  return line.split(" ").length > MAX_WORDS ? null : line;
}
/** A `when` on another day (a plan ahead, a dated past event) means this is not a state of about now. */
function dayNearNow(when: string | undefined, now: number): boolean {
  const at = when ? Date.parse(when) : Number.NaN;
  if (!Number.isFinite(at)) return true;
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return at >= today - DAY_MS && at < today + DAY_MS;
}

export function gateReason(candidate: GateFields, now = Date.now()): GateReason | null {
  if (candidate.update === true || (candidate.claimType !== undefined && EXEMPT_CLAIMS.has(candidate.claimType))) return null;
  const line = plainLine(candidate.text);
  if (line === null || SPECIFIC.test(line)) return null;
  const object = candidate.object?.trim();
  if (PLACEHOLDER.test(line) && (!object || BARE_OBJECT.test(object))) return "placeholder";
  // the whole line decides: the `transient` flag is never read here, so it can drop nothing
  if (dayNearNow(candidate.when, now) && PRESENT_STATE.test(line)) return "transient";
  return ACKNOWLEDGEMENT.test(line) ? "thin" : null;
}

/** The reply-only fields end here: what survives has the shape it had before them, so ids and everything after the gate are unchanged. */
export function gateCandidates<T extends GateFields>(candidates: readonly T[], now = Date.now()): { kept: Omit<T, "object" | "when" | "transient">[]; dropped: GateCounts } {
  const dropped: GateCounts = { placeholder: 0, transient: 0, thin: 0 };
  const kept: Omit<T, "object" | "when" | "transient">[] = [];
  for (const candidate of candidates) {
    const reason = gateReason(candidate, now);
    if (reason) { dropped[reason]++; continue; }
    const { object: _object, when: _when, transient: _transient, ...rest } = candidate;
    kept.push(rest);
  }
  return { kept, dropped };
}
