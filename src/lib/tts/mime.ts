// The clip type the native call player is told (spec §4.1, Limits). Native
// accepts exactly audio/mpeg, audio/wav, audio/aac and audio/mp4 and answers
// badArgs for anything else, parameters included, so the page folds the
// aliases the voice services and browsers use into those four first. Native
// also sniffs the bytes and the sniffed type wins, so the label only has to
// be one it accepts.

const ALIASES: Record<string, string> = {
  "audio/mp3": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/wave": "audio/wav",
  "audio/x-wav": "audio/wav",
};

/** Parameters and case dropped, aliases folded. No type at all becomes
 *  audio/mpeg, every voice service's default. An unknown type is passed on
 *  as it is, so native refuses it (and the clip fails) rather than guessing. */
export function normaliseMime(mime: string | null | undefined): string {
  const bare = (mime ?? "").split(";")[0].trim().toLowerCase();
  if (!bare) return "audio/mpeg";
  return ALIASES[bare] ?? bare;
}
