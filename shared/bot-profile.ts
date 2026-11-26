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

/** The longest bot description a package or team file carries. Profile edits
 * stop at `description`, but a Chief creates bots with up to 8000 characters of
 * instructions and older or imported bots were never capped, so export and import
 * must carry far more than the edit box allows: every bot Murage keeps must leave
 * and come back whole (1.0.20 export-toolong). */
export const BOT_DESCRIPTION_PORTABLE_MAX = 100_000;
