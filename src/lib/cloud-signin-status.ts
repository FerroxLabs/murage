// F4 C2: the per-bot sign-in lines of a Cloud home and the "sign the other bots in" queue, as the Connect panel shows them.
// Names and booleans only: the home tells us whether a bot's engine is signed in, never a token. Claude has one sign-in
// per home and an optional one of the bot's own; Codex, Grok, Kimi and OpenCode are per bot, and nothing is copied.
import type { EngineLoginEngine } from "@/lib/engine-login-terminal";

export interface BotSignInState { engine: string; label: string; signedIn: boolean; uses: "home" | "own" | null; /** A bot on Fuigo only: the engines it already has a sign-in for. */ signedInEngines?: string[]; /** A bot on Fuigo only: engines whose offer the owner dismissed for good (kept on the home). */ dismissed?: string[] }
export interface HomeBot { id: string; name: string; signIn?: BotSignInState }

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
export function ownSignInNeeded(bots: readonly HomeBot[], botId: string): CreateStep | null {
  const state = bots.find((bot) => bot.id === botId)?.signIn;
  if (!state || state.engine === FUIGO || state.signedIn || !canSignInHere(state.engine)) return null;
  return { engine: state.engine, label: state.label };
}

/** This bot's own sign-in for the engine it uses, for the error card; undefined when the home did not say (or the bot is on Fuigo). */
export function ownSignedInOf(bots: readonly HomeBot[] | undefined, botId: string): boolean | undefined {
  const state = bots?.find((bot) => bot.id === botId)?.signIn;
  return !state || state.engine === FUIGO ? undefined : state.signedIn;
}
