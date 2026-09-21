// THE MORNING BRIEF: what is in one, in what order, and why.
//
// This is the artifact the whole relationship is built on. It is the thing
// that arrives every morning whether or not anybody asked, so it is the only
// part of the product that has to be worth reading on day two hundred rather
// than impressive once.
//
// The shape here is the SAME shape the first run's sample brief renders. That
// is deliberate and it is a constraint, not a convenience: the sample has to
// be the real template with example data in it, because a sample with
// invented sections would be a promise the daily brief could not keep. So
// every section below is one a real routine can actually fill, and the sample
// fills exactly these and no others.
//
// THE ORDER IS THE EDITORIAL JUDGEMENT, and it was cross-researched rather
// than guessed. Two models were given the same brief independently and
// converged on nearly the same answer: lead with what the person has to
// decide, then the day in front of them, then what moved, then what was
// handled for them, and keep anything noticed for last. Both were emphatic
// about the same omissions, which are listed on `BriefData` below.
//
// The rules this file's copy is held to are the first run's rules, for the
// same reason: it is the same voice. No em dashes. Nothing about what
// anything costs. No adjectives of urgency, because a deadline is a fact and
// "urgent" is a feeling, and an assistant that manufactures urgency is doing
// what spam does.

/** One thing that needs a decision from the owner.
 *
 *  A list of options is a failure to do the job: both models said so in
 *  almost the same words. So `recommend` is not optional in spirit, even
 *  where it is optional in the type, and a brief that fills this section
 *  with questions rather than recommendations is a brief doing half its
 *  work. */
export interface BriefDecision {
  /** The decision itself, as a thing to be decided. Not "Maya emailed". */
  title: string;
  /** What is actually being asked, and what hangs on it. One or two lines. */
  detail: string;
  /** What the assistant would do, and why. This is the whole point. */
  recommend?: string;
  /** A real time or date, never a word like "urgent". "by noon", "Thursday". */
  by?: string;
}

/** Something on today, said the way a person says it out loud. */
export interface BriefEntry {
  /** "9:30", "This afternoon", "" when the time is not the point. */
  when?: string;
  title: string;
  /** The one thing that makes this entry useful. Optional, and usually the
   *  reason the entry is in the brief at all. */
  detail?: string;
}

/**
 * A morning brief, as data.
 *
 * WHAT IS DELIBERATELY NOT HERE, because both models named these as the
 * things that make a brief get skimmed and then ignored:
 *
 *   No counts. "You have 47 unread" is a number nobody can act on.
 *   No transcription of the calendar. The brief is an edit of the day, not
 *     a copy of it.
 *   No news unrelated to something the owner is already working on.
 *   No item repeated unchanged from yesterday.
 *   No routine reports of the assistant's own successes beyond one line.
 *   No encouragement, no quotations, no productivity advice.
 *
 * Every section is optional and an empty one is OMITTED rather than rendered
 * empty, because a heading with nothing under it is the assistant filling a
 * quota. A brief with nothing in any section is a legitimate brief and says
 * so in one line: see `quiet`.
 */
export interface BriefData {
  /** What the Chief calls them. The brief is addressed to somebody. */
  ownerName: string;
  /** The day this covers, already formatted for reading. */
  dateLabel: string;
  /** Decisions owed. First, always, because this is the only section that
   *  needs the owner rather than merely informing them. */
  needsYou?: readonly BriefDecision[];
  /** The shape of the day in front of them. */
  today?: readonly BriefEntry[];
  /** What moved while they were not looking. */
  overnight?: readonly BriefEntry[];
  /** What the assistant did on its own, one line each. This section is how
   *  graduated trust becomes visible: the owner can always see what was sent
   *  in their name without having to go and look for it. */
  handled?: readonly BriefEntry[];
  /** Patterns, lead times and silences. Last, because it is the least
   *  urgent and the most easily skipped on a busy morning. */
  noticed?: readonly BriefEntry[];
  /**
   * The one line a quiet day gets.
   *
   * "Nothing needs you today" is a complete and successful brief. Both
   * models said so independently, and it is the single clearest signal that
   * the assistant is editing rather than padding. Used only when every
   * section is empty.
   */
  quiet?: string;
}

/** The sections, in the order they are read, with the heading each carries. */
export const BRIEF_SECTIONS = [
  { key: "needsYou", heading: "Needs you" },
  { key: "today", heading: "Today" },
  { key: "overnight", heading: "Overnight" },
  { key: "handled", heading: "Handled for you" },
  { key: "noticed", heading: "Worth knowing" },
] as const;

export type BriefSectionKey = (typeof BRIEF_SECTIONS)[number]["key"];

/** Whether this brief has anything in it at all. A brief with no sections
 *  renders its one quiet line instead of five empty headings. */
export function briefIsQuiet(data: BriefData): boolean {
  return BRIEF_SECTIONS.every((section) => (data[section.key] ?? []).length === 0);
}
