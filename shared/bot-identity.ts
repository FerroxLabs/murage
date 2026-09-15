/** Personality is an owner-authored imprint, independent of memory and engine. */
export function personalityImprint(persona: string | null | undefined): string {
  return persona?.trim() ? persona : "Professional and Natural";
}
