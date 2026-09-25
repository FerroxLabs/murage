/** The composer is one line tall until something is typed, so on a narrow
 * screen a long placeholder was clipped mid-word. There it keeps only its
 * lead ("Ember is working"); the hint is for a wide screen, which shows both
 * as two sentences. */
export function compactPlaceholder(lead: string, hint: string | undefined, narrow: boolean): string {
  if (narrow || !hint) return lead;
  return `${lead}. ${hint.charAt(0).toUpperCase()}${hint.slice(1)}`;
}
