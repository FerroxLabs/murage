// The Flux Router key: what it is worth saying about it, and the one rule that
// keeps the offer an offer.
//
// WHAT A FLUX KEY ACTUALLY DOES, read off the code rather than the pitch.
// `mergeFluxCatalog` (server/flux-surface.ts:110) appends four model rows —
// Flux Auto, Reasoning, Standard, Fast (FLUX_TIERS, flux-surface.ts:48) — to
// the model picker, and only for the three engines that have a wire surface
// implemented: Claude on Anthropic Messages, Qwen on OpenAI chat-completions,
// Codex on Responses (FLUX_SURFACE, flux-surface.ts:33). Picking one of those
// rows routes that bot's turns at api.fluxrouter.ai on the saved key
// (applyFluxSurface, flux-routing.ts) instead of the CLI's own account. Both
// gates — the picker rows and the spawn refusal (fluxSelectionRefusal,
// flux-surface.ts:160) — are conditioned on `fluxConfigured()`, so with no key
// the rows are never built and nothing anywhere else changes.
//
// A Flux key ALSO draws generated bot avatars. `resolveAvatarImageRoutes`
// (server/avatar-image.ts) posts to POST /v1/images/generations on the same
// host and puts that route FIRST, ahead of the separate `imageGen` OpenAI key,
// which stays as the fallback. This paragraph used to say the opposite, and the
// copy guard in flux-invite.test.ts was built on it; see the comment there.
// Voice is still NOT this key: `tts` is its own credential in server/config.ts,
// read by tts.ts, and nothing in that path consults flux-config.ts. The invite
// copy below therefore still says nothing about speech.
// It does not "empower all agents" either — five
// driver kinds (opencode, qoder, droid, auggie, copilot, kiro, vibe) are
// deliberately absent from the surface table, each for a checked reason
// recorded at flux-routing.ts:62-77.
//
// SO THE OFFER IS ADDITIVE, AND MUST BEHAVE LIKE IT. Every engine is separately
// authenticated: a signed-in Claude, Codex or Gemini CLI is what makes the app
// work, and it keeps working untouched with no Flux key at all. The invitation
// therefore may not gate, may not interrupt, and may not come back once someone
// has said no. `fluxInviteVisible` below is the whole of that policy, kept pure
// so every state it can be in is reachable from a test rather than from a
// running app on the right day.

/** Remembered per machine, so "not now" is not re-asked on every launch.
 *  Same shape and same reasoning as INSTALL_DISMISSED_KEY. */
export const FLUX_INVITE_DISMISSED_KEY = "murage-flux-invite-dismissed";

export interface FluxInviteFacts {
  /** A CONFIRMED desktop surface. `undefined` = the surface has not answered
   *  yet; `false` = a phone or another computer through the browser door. */
  desktop: boolean | undefined;
  /** Whether a Flux key is saved. `null` = GET /api/config has not answered. */
  configured: boolean | null;
  /** The person already said no. */
  dismissed: boolean;
  /** The welcome / email first-run screen is still up. */
  firstRunGate: boolean;
}

/**
 * Whether to offer the Flux key.
 *
 * Every clause is a refusal, and each one is load-bearing:
 *
 *  - Not a confirmed desktop. The whole Connections section this points at is
 *    `desktopOnly` (SettingsModal SECTIONS), because a paired phone is not
 *    allowed to see or edit workspace keys. Offering on a phone would be an
 *    invitation to open a door that surface does not have. `undefined` takes
 *    the same silent answer the welcome gate does: neutral is the narrow side.
 *
 *  - The first-run gate is up. Something already has the screen; a second
 *    invitation stacked on it is the nag this must never be.
 *
 *  - Already dismissed. Once, and never again on this machine.
 *
 *  - `configured` is not exactly `false`. `true` means there is a key and there
 *    is nothing to offer. `null` means config has not loaded, and that is the
 *    important one: defaulting an unknown to "no key" would flash the offer for
 *    a frame on every launch of a machine that already has one.
 */
export function fluxInviteVisible(facts: FluxInviteFacts): boolean {
  if (facts.desktop !== true) return false;
  if (facts.firstRunGate) return false;
  if (facts.dismissed) return false;
  return facts.configured === false;
}

/** The config PATCH that saves a key. `PUT /api/config` with this body is the
 *  only writer: `appConfigSchema.flux` (server/config.ts) accepts it,
 *  `syncCredentialEnv` republishes it as FLUX_API_KEY for the running process,
 *  and `flux` is absent from the route's reload-exclusion list, so the fleet
 *  rebuilds and the four rows appear without a restart. */
export function fluxKeyPatch(key: string): string {
  return JSON.stringify({ flux: { apiKey: key } });
}

/** What the key field shows when nothing is typed in it.
 *
 *  There is no saved key to mask, and that is the point: GET /api/config
 *  returns `flux: { configured }` and nothing else (server/index.ts), so the
 *  renderer never holds the secret in the first place. The configured
 *  placeholder says a key is saved without implying these dots are it. */
export function fluxKeyPlaceholder(configured: boolean): string {
  return configured ? "Saved. Paste a new key to replace it." : "Paste your Flux Router key";
}

/**
 * Every user-visible string this feature ships.
 *
 * Collected here for two reasons. It keeps the copy next to the verified facts
 * above, so nobody promises a capability this app does not route. And it makes
 * the house copy rules testable: no em dashes, and every line says what the person
 * gets rather than what the system is.
 */
export const FLUX_COPY = {
  /** The Settings row. Flux is one more field of the same shape as the Box,
   *  Composio and OpenCode rows it sits beside: one field, one paste, and no
   *  vocabulary the person has to learn first. */
  keyLabel: "Flux Router key",
  keyHelp:
    "Adds Flux Auto, Reasoning, Standard and Fast to the model picker for bots running Claude, Codex or Qwen. Pick Auto and the right model gets each job without you choosing. Your existing CLI logins keep working and nothing else changes.",
  keyLinkLabel: "Get a Flux Router key",
  keyHref: "https://fluxrouter.ai",
  connected: "Connected",

  /** First-run invitation. */
  inviteTitle: "Let your bots pick the right model",
  inviteBody:
    "One Flux Router key adds Flux Auto to the model picker for your Claude, Codex and Qwen bots, so the right model gets each job. Your CLI logins keep working, and Murage is already fine without it.",
  inviteAction: "Add a key",
  inviteDismiss: "Not now",
} as const;
