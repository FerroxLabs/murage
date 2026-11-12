// F4 C2: the per-bot sign-in lines of a Cloud home and the "sign the other bots in" queue, as the Connect panel shows them.
// Names and booleans only: the home tells us whether a bot's engine is signed in, never a token. Claude has one sign-in
// per home and an optional one of the bot's own; Codex, Grok, Kimi and OpenCode are per bot, and nothing is copied.
import type { EngineLoginEngine } from "@/lib/engine-login-terminal";

export interface BotSignInState { engine: string; label: string; signedIn: boolean; uses: "home" | "own" | null; /** The engines the bot already has a sign-in for (absent when the home did not say). */ signedInEngines?: string[]; /** A bot on Fuigo only: engines whose offer the owner dismissed for good (kept on the home). */ dismissed?: string[] }
/** `instanceId` is the engine instance the bot's own setting names (not a chat's own picker). */
export interface HomeBot { id: string; name: string; instanceId?: string; signIn?: BotSignInState }

const SIGN_IN_ENGINES: readonly string[] = ["codex", "claudeAgent", "grokAgent", "kimiAgent", "opencodeGo"];
/** The engines this panel can open a sign-in for (Antigravity signs in from the bot's own chat). */
export const canSignInHere = (engine: string): engine is EngineLoginEngine => SIGN_IN_ENGINES.includes(engine);

/** "Codex: signed in", "Codex: needs sign-in"; Claude also says whose account the bot runs on. Null when the home did not say. */
export function signInLine(bot: HomeBot): string | null {
  const state = bot.signIn;
  if (!state || state.engine === FUIGO) return null;
  if (!state.signedIn) return `${state.label}: needs sign-in`;
  if (state.engine === "claudeAgent") return state.uses === "own" ? `${state.label}: signed in with its own account` : `${state.label}: signed in with the home's account`;
  return `${state.label}: signed in`;
}

/** Fuigo is the metered default, not a sign-in the owner made. */
const FUIGO = "fuigoAgent";
const PER_BOT_ENGINES: readonly string[] = ["codex", "grokAgent", "kimiAgent", "opencodeGo"];
export const skipKey = (botId: string, engine: string) => `${botId}:${engine}`;

/** The other bots that should be offered "Sign <bot> in to <engine> and use it" after `doneBotId` signed `engine` in: bots already on
 * that engine without a sign-in, and bots on Fuigo with none for it (signing in moves them onto it). None for Claude (the home's
 * sign-in covers every bot) or for a bot the owner already skipped. A bot on another engine the owner chose is never listed. */
export function botsToSignIn(bots: readonly HomeBot[], engine: string, doneBotId: string, skipped: ReadonlySet<string> = new Set()): HomeBot[] {
  if (engine === "claudeAgent" || !canSignInHere(engine)) return [];
  return bots.filter((bot) => bot.id !== doneBotId && !skipped.has(skipKey(bot.id, engine)) && bot.signIn !== undefined && !(bot.signIn.dismissed ?? []).includes(engine)
    && ((bot.signIn.engine === engine && !bot.signIn.signedIn) || (bot.signIn.engine === FUIGO && !(bot.signIn.signedInEngines ?? []).includes(engine))));
}

/** The first offer when the panel opens: an engine some bot is signed in to, and a bot that still lacks it. */
export function firstOffer(bots: readonly HomeBot[], skipped: ReadonlySet<string> = new Set()): { bot: HomeBot; engine: string; label: string } | null {
  const signed = new Set<string>();
  for (const bot of bots) {
    if (bot.signIn?.engine === FUIGO) for (const engine of bot.signIn.signedInEngines ?? []) signed.add(engine);
    else if (bot.signIn?.signedIn) signed.add(bot.signIn.engine);
  }
  for (const engine of PER_BOT_ENGINES) {
    if (!signed.has(engine)) continue;
    const bot = botsToSignIn(bots, engine, "", skipped)[0];
    if (bot) return { bot, engine, label: ENGINE_NAMES[engine] ?? engine };
  }
  return null;
}
const ENGINE_NAMES: Record<string, string> = { codex: "Codex", grokAgent: "Grok", kimiAgent: "Kimi", opencodeGo: "OpenCode" };
export const engineName = (engine: string) => ENGINE_NAMES[engine] ?? engine;
const SIGN_IN_LABELS: Record<string, string> = { claudeAgent: "Claude", ...ENGINE_NAMES };

/** Plain words for the offer after a sign-in. */
export const queueOfferCopy = (bot: HomeBot, label: string) => `${label} is signed in on another bot. ${bot.name} needs its own ${label} sign-in.`;
export const queueOfferButton = (bot: HomeBot, label: string) => `Sign ${bot.name} in to ${label} and use it`;
export const OWN_CLAUDE_BUTTON = "Use a different Claude account for this bot";
/** The home-level setup line: some bot has this engine signed in. It says nothing about any one bot. */
export const homeSetUpLine = (engine: string) => `${engine} is set up on this home`;
export const HOME_CLAUDE_BUTTON = "Use the home's Claude account";

/** The step a new bot shows on Cloud when another bot is already signed in to an engine (the home picks the engine and the bot's
 * own store decides). Skipping it, or a failure, leaves the bot on Fuigo; finishing it moves the bot onto the engine. */
export interface CreateStep { engine: string; label: string }
export const createStepTitle = (bot: string, step: CreateStep) => `Sign ${bot} in to ${step.label}`;
export const createStepBody = (bot: string, step: CreateStep) => `${step.label} is signed in on another bot. Sign ${bot} in to ${step.label} to use it, or skip and ${bot} starts on Fuigo.`;
export const createStepButton = (bot: string, step: CreateStep) => `Sign ${bot} in to ${step.label}`;
export const CREATE_STEP_SKIP = "Skip for now";
/** The same offer on the bot's own surface, until it is signed in or dismissed. */
export const botOfferButton = queueOfferButton;
export const OFFER_DISMISS = "Not now";

/** The sign-in a bot's chat needs, from the bot's OWN line on the home (never another bot's, never the home's overall state), or null
 * when it can chat. Claude is signed in when the home's Claude sign-in is valid or the bot has its own (the home already folds that
 * into `signedIn`); every other engine is strictly per bot. A bot on Fuigo, a bot the home did not describe, or an engine this panel
 * cannot sign in has nothing to gate: the check before the engine starts stays the backstop. */
export function ownSignInNeeded(bots: readonly HomeBot[], botId: string, inUseInstanceId?: string, inUseEngine?: string): CreateStep | null {
  const line = bots.find((bot) => bot.id === botId);
  // The line is about the engine in the bot's own setting. A chat can run on another one through its own picker. Then the gate follows
  // the engine in use, the same way the check before the engine starts does: Fuigo, an engine this panel cannot sign in, or one the
  // bot is signed in to keeps the text box; any other engine the bot is not signed in to is gated for that engine. When the home did
  // not say which engines the bot is signed in to, nothing blocks here and the check before the engine starts stays the backstop.
  if (line?.instanceId && inUseInstanceId && line.instanceId !== inUseInstanceId) {
    const signedIn = line.signIn?.signedInEngines;
    if (!inUseEngine || inUseEngine === FUIGO || !canSignInHere(inUseEngine) || signedIn === undefined || signedIn.includes(inUseEngine)) return null;
    return { engine: inUseEngine, label: SIGN_IN_LABELS[inUseEngine] ?? inUseEngine };
  }
  const state = line?.signIn;
  if (!state || state.engine === FUIGO || state.signedIn || !canSignInHere(state.engine)) return null;
  return { engine: state.engine, label: state.label };
}

/** CLOUD-NOKEY-FALLBACK: the approved words while a Cloud home's Flux credit is still on its way. Other engines are one line that
 * points at Settings, Engines; nothing here offers another engine's sign-in. */
export const FUIGO_READY_COPY = {
  title: "Getting Fuigo ready",
  line: "Your bots run on Fuigo with your Flux credit. This takes a minute or two. You can keep looking around.",
  slow: "Fuigo is taking longer than usual. We're on it. Need help? Email support@murage.ai.",
  others: "Prefer your own Claude, ChatGPT or Grok sign-in? Add it in Settings.",
} as const;

/** After this long on "Getting Fuigo ready" the line becomes the slow one. */
export const FUIGO_SLOW_AFTER_MS = 10 * 60_000;

/** CLOUD-NOKEY-FALLBACK: true on a Cloud home while the home's Flux credit is not ready (unknown counts as not ready) and the chat
 * does not run on Fuigo. The gate then shows "Getting Fuigo ready" in place of another engine's sign-in. Always false off a home. */
export function fuigoPendingHere(opts: { cloud: boolean; fluxReady: boolean | undefined; inUseEngine?: string }): boolean {
  return opts.cloud && opts.fluxReady !== true && opts.inUseEngine !== FUIGO;
}

/** The lines the Fuigo card shows after `elapsedMs` on screen: the slow line from FUIGO_SLOW_AFTER_MS on. */
export function fuigoReadyLines(elapsedMs: number): { title: string; line: string; others: string } {
  return { title: FUIGO_READY_COPY.title, line: elapsedMs >= FUIGO_SLOW_AFTER_MS ? FUIGO_READY_COPY.slow : FUIGO_READY_COPY.line, others: FUIGO_READY_COPY.others };
}

/** A Flux status reading (config.flux) as ready, not ready, or unknown while the config is not loaded. */
export function fluxReadyOf(config: { flux?: { configured?: boolean; keyState?: string } } | null | undefined): boolean | undefined {
  if (config == null) return undefined;
  return config.flux?.configured === true && (config.flux.keyState === undefined || config.flux.keyState === "ok");
}

/** This bot's own sign-in for the engine it uses, for the error card; undefined when the home did not say (or the bot is on Fuigo). */
export function ownSignedInOf(bots: readonly HomeBot[] | undefined, botId: string): boolean | undefined {
  const state = bots?.find((bot) => bot.id === botId)?.signIn;
  return !state || state.engine === FUIGO ? undefined : state.signedIn;
}

/** Engines whose sign-in runs from a BROWSER owner session on a home: the vendor's own CLI on the home, through the ticketed relay
 * (server/cloud-home/engine-login-target.ts). Claude opens a link and takes one pasted code; Codex (ChatGPT), Grok and Kimi show a
 * link and a device code to enter on the vendor's page, so they take no typing at all. OpenCode's sign-in is a menu a filter cannot
 * drive (it saves a key instead), and Antigravity signs in from the bot's own chat, so neither is here.
 * Add an engine here only when its button has a route to send the customer to. */
export const BROWSER_SIGNIN_ENGINES: readonly string[] = ["claudeAgent", "codex", "grokAgent", "kimiAgent"];

/** Whether the "Sign <bot> in to <engine>" offer may show here. With the desktop bridge (the Cloud window) or off a Cloud home page,
 * as before. In a browser on a home there is no computer to hand the sign-in to, so an engine with no browser route shows no offer
 * at all, and never a line that sends the customer to a computer they do not have. */
export function signInOfferHere(engine: string, env: { homePage: boolean; bridge: boolean }): boolean {
  return env.bridge || !env.homePage || BROWSER_SIGNIN_ENGINES.includes(engine);
}
