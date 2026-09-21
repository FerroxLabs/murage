// THE HOUSE RULES, ONCE.
//
// THE DEFECT THIS EXISTS FOR. "Never sell on price" was enforced by three
// separate regexes, hand-copied into first-run-copy.test.ts,
// first-run-flow.test.ts and first-run-jobs.test.ts. `pay` was added to the
// first one after "Any OpenAI-style service you already pay for" shipped on
// the no-key branch of a blank machine for a whole release, and the other two
// were left as they were. So the rule was fixed in one place of three and the
// hole stayed open on the two surfaces nobody happened to be looking at.
//
// Three copies of one rule is the real defect. A rule that has to be fixed in
// three places gets fixed in one. This module is the rule; the tests import
// it and none of them holds a copy of the pattern.
//
// It lives beside the copy it governs rather than in a test file because
// three test files need it and a test file is not an import target anybody
// should reach for.

/**
 * Money in any form: the adjectives, the nouns and the figures.
 *
 * The first run says what the thing DOES, never what it costs. `pay`/`paid`
 * are in here for the reason above; `free` is in here because free is a price
 * too and the flow has been rejected for leading on it.
 */
export const MONEY_WORDS =
  /\b(cheap\w*|discount\w*|wholesale|afford\w*|budget\w*|spend\w*|cost\w*|pric\w*|pay\w*|paid|token\w*|free|dollars?|cents?|per month|save money|value for money)\b/i;

/** A figure with a currency on it, in any of the three the app is read in. */
export const MONEY_FIGURE = /[$£€]\s?\d/;

/**
 * What a line says about money, or null.
 *
 * Returns the offending word rather than a boolean so a failure names what it
 * found: a test that says only "false" sends the next person back to the
 * regex to work out which word tripped it.
 */
export function sellsOnPrice(text: string): string | null {
  return MONEY_WORDS.exec(text)?.[0] ?? (MONEY_FIGURE.test(text) ? (MONEY_FIGURE.exec(text)?.[0] ?? null) : null);
}
