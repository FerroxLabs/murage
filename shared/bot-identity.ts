/** Personality is an owner-authored imprint, independent of memory and engine. */
export function personalityImprint(persona: string | null | undefined): string {
  return persona?.trim() ? persona : "Professional and Natural";
}

/** Ids that begin with this prefix belong to the system, never to a bot or a group. The Cloud home's own UI check
 * keeps a browser profile and scope under one of them, so no bot may ever name it. */
export const RESERVED_BOT_ID_PREFIX = "__murage-";
export function isReservedBotId(id: string): boolean { return id.startsWith(RESERVED_BOT_ID_PREFIX); }
/** The Cloud home UI canary's browser identity (18 characters; valid for the launcher, the scope unit and the namespace). */
export const CANARY_BROWSER_ID = `${RESERVED_BOT_ID_PREFIX}ui-canary`;
