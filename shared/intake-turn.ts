/** The staged payload a new-bot setup conversation carries on an `options`
 *  card. One definition, imported by `server/store.ts` and
 *  `src/state/store.tsx`, the same way `shared/routine-request.ts` and
 *  `shared/skill-request.ts` already are.
 *
 *  It is a fourth staged-proposal payload following the `routineRequest` /
 *  `skillRequest` precedent exactly: the card holds a proposal, and nothing
 *  is installed until the person confirms it on the route that already
 *  enforces the desktop boundary. No new message kind is introduced.
 */

export type IntakeStep = "open" | "narrow" | "confirm";

export interface IntakeCandidate {
  /** Library catalogue slug. The ONLY thing the confirm button sends anywhere. */
  slug: string;
  name: string;
  /** Names only, for the subtitle. Never ids, never installed by this payload. */
  skillNames: string[];
}

export interface IntakeCardData {
  step: IntakeStep;
  /** confirm cards only. "profile" offers `candidate`; "general" offers nothing to install. */
  outcome?: "profile" | "general";
  /** confirm(profile) and narrow-check: the profile under discussion. */
  candidate?: IntakeCandidate;
  /** narrow-pick only: the two candidates whose names are the chips. */
  choices?: IntakeCandidate[];
  /** How many questions have been asked on this thread. Hard cap 2. */
  asked: 1 | 2;
}

/* ------------------------------------------------------------------ *
 *  CHIP ORDER. Read this before touching any array below.
 *
 *  THE RENDERER MAPS INTAKE CHIPS BY POSITION, NOT BY LABEL TEXT.
 *  That is deliberate: matching on the label would mean the renderer keeps
 *  its own copy of a sentence the server owns, and the two would drift the
 *  first time the copy was edited. The cost of that choice is that the
 *  ORDER of `card.options` carries the meaning.
 *
 *  So: index 0 is always the affirmative chip and index 1 is always the
 *  way out. Swap them and a person pressing "yes, set this up" is recorded
 *  as having declined, silently, with no error on either side of the seam.
 *  That failure is invisible in the transcript, invisible in the logs, and
 *  looks to the person like the product ignored them.
 *
 *  Because of that, no call site writes one of these arrays by hand. The
 *  fixed pairs are declared below by MEANING (`accept` / `decline`) and the
 *  ordered array is built from them, so getting the order wrong is not a
 *  thing a caller can express. Use `intakeChips` and `intakeNarrowPickChips`
 *  to construct, and `intakeChipIndex` to read a pressed chip back.
 * ------------------------------------------------------------------ */

/** A two-chip card's options, in the one order the renderer understands. */
export type IntakeChipPair = readonly [accept: string, decline: string];

/** The affirmative chip. Also `choices[0]` on a narrow-pick card. */
export const INTAKE_ACCEPT_INDEX = 0;
/** The way out. Also `choices[1]` on a narrow-pick card. */
export const INTAKE_DECLINE_INDEX = 1;

/** Every fixed two-chip card in the intake, keyed by meaning rather than by
 *  position. Editing a label here is safe; the order is not expressible. */
const INTAKE_CHOICES = {
  /** NARROW-CHECK: we named a profile and are asking whether it is right. */
  "narrow-check": { accept: "That's about right", decline: "Not really, it's something else" },
  /** CONFIRM(profile): the one card whose accept press installs anything. */
  "confirm-profile": { accept: "Set that up", decline: "Keep me general instead" },
  /** CONFIRM(general): declining here opens the library, it does not undo. */
  "confirm-general": { accept: "That's fine", decline: "Show me the library" },
} as const;

export type IntakeChoiceKind = keyof typeof INTAKE_CHOICES;

/** Build a fixed card's chips. Always accept first, decline second. */
export function intakeChips(kind: IntakeChoiceKind): IntakeChipPair {
  const { accept, decline } = INTAKE_CHOICES[kind];
  return [accept, decline];
}

/** NARROW-PICK's chips are two profile names rather than a yes and a no, but
 *  position still carries the meaning: the first chip is `choices[0]` and the
 *  second is `choices[1]`. Pass the candidates in the same order they go into
 *  `IntakeCardData.choices` and the two cannot disagree. */
export function intakeNarrowPickChips(first: IntakeCandidate, second: IntakeCandidate): IntakeChipPair {
  return [first.name, second.name];
}

/** Read a pressed chip back off the card's OWN stored options, by position.
 *
 *  Returns `null` for anything that is not one of the two chips, which is
 *  the normal case: invariant I7 says every intake question also accepts
 *  free text through the composer, so a `null` here means "the person typed
 *  something" and never "the person answered wrongly". */
export function intakeChipIndex(options: readonly string[], text: string): 0 | 1 | null {
  if (options.length !== 2) return null;
  if (text === options[INTAKE_ACCEPT_INDEX]) return INTAKE_ACCEPT_INDEX;
  if (text === options[INTAKE_DECLINE_INDEX]) return INTAKE_DECLINE_INDEX;
  return null;
}
