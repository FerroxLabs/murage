/** The composer is one line tall until something is typed, so on a narrow
 * screen a long placeholder was clipped mid-word. There it keeps only the part
 * before " — " ("Ember is working"); the rest is a hint a wide screen has room
 * for. */
export function compactPlaceholder(text: string, narrow: boolean): string {
  if (!narrow) return text;
  const cut = text.indexOf(" — ");
  return cut > 0 ? text.slice(0, cut) : text;
}
