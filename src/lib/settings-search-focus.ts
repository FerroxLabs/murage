// Sean Q-C (SEAN-YES 2026-11-22, row F7 S3): while Settings is open, Mod+K focuses Settings search instead of opening the
// command palette. Owner: M6 lane (design Q-C places it on the M6 branch). Closed Settings keeps the palette as before.
// A host without a DOM lookup (a stubbed or absent document) has no Settings open, so the palette keeps the chord.
export function focusOpenSettingsSearch(doc: Partial<Pick<Document, "getElementById">> | undefined = globalThis.document): boolean {
  if (typeof doc?.getElementById !== "function") return false;
  const input = doc.getElementById("settings-search");
  if (!input || !input.isConnected || typeof (input as HTMLInputElement).focus !== "function") return false;
  if (input.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  (input as HTMLInputElement).focus();
  (input as HTMLInputElement).select?.();
  return true;
}
