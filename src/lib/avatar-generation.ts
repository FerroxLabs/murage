// Who is going to draw a generated avatar, and what the panel may say about it.
//
// The panel used to have one answer hardcoded into its JSX: GPT Image 2, on a
// key pasted into the panel itself. There are two providers now — the server
// resolves Flux Router first and the user's own OpenAI image key second
// (`resolveAvatarImageRoutes`, server/avatar-image.ts) — so "which one will
// actually run, and what does the person see" is a decision with four states.
// A ternary inside a .tsx is a decision no test can execute, so it lives here.
//
// THE ONE RULE THAT KEEPS THIS HONEST: the heading names the provider that the
// server will really use for the next request. The server's precedence is Flux
// first, OpenAI second; `providerFor` below is the same order, and it is the
// only place in the renderer that order is written down.

export interface AvatarGeneratorFacts {
  /** A Flux Router key is saved. `null` = GET /api/config has not answered. */
  flux: boolean | null;
  /** An OpenAI image key is saved. `null` = has not answered. */
  openAiImageKey: boolean | null;
  /** The last generate attempt in this panel came back an error. */
  lastAttemptFailed: boolean;
}

/** Who draws the picture. `none` = nothing can, yet. */
export type AvatarGeneratorProvider = "flux" | "openai" | "none";

export interface AvatarGeneratorPlan {
  provider: AvatarGeneratorProvider;
  /** Whether the direction box and the Generate button are worth showing. */
  canGenerate: boolean;
  heading: string;
  body: string;
  /** One line pointing at Settings, or null when there is nothing to offer. */
  fluxHint: string | null;
  /** The first-time "paste an OpenAI image key" field. */
  showKeyField: boolean;
  /** The tucked-away replace-the-key drawer. */
  showKeyDrawer: boolean;
}

/**
 * Every user-visible string this panel ships, in one place so the copy rules
 * (no em dashes, say what the person gets) are checkable in one pass.
 */
export const AVATAR_COPY = {
  fluxHeading: "Generate with Flux",
  fluxBody: "Flux Router draws one square avatar from this bot's name, role and your direction. It bills the Flux key saved in Settings.",
  openAiHeading: "Generate with your OpenAI key",
  openAiBody: "One low quality square draft, to keep the cost down. OpenAI bills your own API account.",
  emptyHeading: "Generate an avatar",
  emptyBody: "Paste an OpenAI image key below and this panel draws one from the bot's name and role.",
  /** The easy path. Points at the one field, in the one place it lives. */
  fluxHint: "A Flux Router key draws these too, with no second key to manage.",
  fluxHintAction: "Add one in Settings",
  keyDrawerLabel: "Replace OpenAI image key",
} as const;

/**
 * The server's precedence, restated for the renderer.
 *
 * Flux wins when it is there. `null` is "config has not answered", and it is
 * NOT read as "no key" — the same reasoning as `fluxInviteVisible`
 * (lib/flux-invite.ts): defaulting an unknown to false makes a machine that
 * has a key flash the wrong provider's name for a frame on every launch.
 */
export function providerFor(facts: AvatarGeneratorFacts): AvatarGeneratorProvider {
  if (facts.flux === true) return "flux";
  if (facts.openAiImageKey === true) return "openai";
  return "none";
}

/**
 * What the panel shows.
 *
 * The OpenAI key drawer is hidden while Flux is doing the work, because a
 * second key to paste is noise on a panel that already works. It comes BACK
 * the moment an attempt fails, and that is not decoration: FluxRouter's image
 * endpoint is entitled to paid, cleared accounts only (a free account is
 * answered 402 "image generation requires a paid plan",
 * flux-router/src/images_route.py), and this panel is the only place in the
 * whole app where an OpenAI image key can be entered. Hiding it unconditionally
 * would strand exactly the person the fallback exists for.
 */
export function avatarGeneratorPlan(facts: AvatarGeneratorFacts): AvatarGeneratorPlan {
  const provider = providerFor(facts);
  // Only a confirmed `false` offers Flux. See `providerFor` on why not null.
  const fluxHint = facts.flux === false ? AVATAR_COPY.fluxHint : null;
  if (provider === "flux") {
    return {
      provider,
      canGenerate: true,
      heading: AVATAR_COPY.fluxHeading,
      body: AVATAR_COPY.fluxBody,
      fluxHint,
      showKeyField: false,
      showKeyDrawer: facts.lastAttemptFailed,
    };
  }
  if (provider === "openai") {
    return {
      provider,
      canGenerate: true,
      heading: AVATAR_COPY.openAiHeading,
      body: AVATAR_COPY.openAiBody,
      fluxHint,
      showKeyField: false,
      showKeyDrawer: true,
    };
  }
  return {
    provider,
    canGenerate: false,
    heading: AVATAR_COPY.emptyHeading,
    body: AVATAR_COPY.emptyBody,
    fluxHint,
    showKeyField: true,
    showKeyDrawer: false,
  };
}
