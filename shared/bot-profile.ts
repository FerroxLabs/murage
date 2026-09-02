/** Profile input limits shared by every web and server write surface. */
export const BOT_PROFILE_LIMITS = {
  name: 100,
  title: 200,
  description: 4000,
  /** The voice note, not a second brief. `description` already reaches the
   * model verbatim on every turn — but it is also what a Chief of Staff, the
   * avatar prompt, the team manifest and the project scout read when they
   * decide who does the work. "Be snarky" does not belong in any of those.
   * `persona` is appended to the persona string and read by NOTHING else, and
   * the small cap is the design: a person who cannot write 4000 characters of
   * voice writes a voice note instead of a second brief. */
  persona: 280,
  voice: 200,
} as const;
