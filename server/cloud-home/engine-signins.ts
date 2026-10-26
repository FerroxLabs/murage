// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Cloud sign-in lines (F4 C2): for each bot on a home, whether the engine it uses is signed in, and which
// Claude sign-in it uses. Names and booleans only: no token, key, account or expiry ever leaves this module.
//
// Claude has ONE sign-in per home plus an optional sign-in of the bot's own (an override that wins for that bot).
// Codex, Grok, Kimi, OpenCode and Antigravity are strictly per bot: no sign-in is shared, so signing one bot in
// never signs another in, and the "sign the other bots in" queue lists the bots that still need their own.
import type { IncomingMessage, ServerResponse } from "node:http";
import { cloudIdentity, isOwnerBrowser } from "../cloud-request-identity.ts";
import { botEngineSignIn, polledBotEngineSignIn, polledBotSignedInEngines } from "./signin-status.ts";
import { cloudHomeCopy } from "./copy.ts";
import type { SignInOffers } from "./signin-offers.ts";

/** The engines a Cloud home signs in, by driver kind, with the name the owner reads. */
export const SIGNIN_ENGINE_LABELS: Readonly<Record<string, string>> = {
  claudeAgent: "Claude", codex: "Codex", grokAgent: "Grok", kimiAgent: "Kimi", opencodeGo: "OpenCode", antigravityAgent: "Antigravity",
};

export interface BotEngineRef { id: string; name: string; driverKind: string }
export interface BotSignInLine {
  id: string; name: string;
  /** Driver kind of the engine the bot uses. */
  engine: string; label: string;
  signedIn: boolean;
  /** Claude only: which sign-in the bot runs on, "home" (the home-wide one) or "own" (this bot's override). Null when not signed in. */
  uses: "home" | "own" | null;
  /** A bot on Fuigo (the metered default) only: the engines it already has a sign-in for, so "Sign <bot> in to <engine> and use it" is offered for the rest. */
  signedInEngines?: string[];
  /** A bot on Fuigo only: engines whose "sign <bot> in and use it" offer the owner dismissed for good. */
  dismissed?: string[];
}
export interface BotSignInSource {
  signIn(driverKind: string, botId: string): Promise<{ signedIn: boolean; source: "home" | "bot" | null } | undefined>;
  signedInEngines?(botId: string): Promise<string[] | undefined>;
}
const FUIGO = "fuigoAgent";

const LINE_CONCURRENCY = 4;

/** One line per bot whose engine a home signs in, read by a few workers at a time and answered in the home's bot order.
 * undefined when the launcher cannot answer for any of them (off a home). */
export async function botSignInLines(bots: readonly BotEngineRef[], source: BotSignInSource = { signIn: polledBotEngineSignIn, signedInEngines: polledBotSignedInEngines }): Promise<BotSignInLine[] | undefined> {
  const slots: Array<BotSignInLine | null> = bots.map(() => null);
  const lineFor = async (bot: BotEngineRef): Promise<BotSignInLine | null> => {
    if (bot.driverKind === FUIGO) {
      const engines = await source.signedInEngines?.(bot.id);
      if (engines === undefined) return null;
      return { id: bot.id, name: bot.name, engine: FUIGO, label: "Fuigo", signedIn: true, uses: null, signedInEngines: engines.filter(name => name in SIGNIN_ENGINE_LABELS).sort() };
    }
    const label = SIGNIN_ENGINE_LABELS[bot.driverKind];
    if (!label) return null;
    const answer = await source.signIn(bot.driverKind, bot.id);
    if (answer === undefined) return null;
    return { id: bot.id, name: bot.name, engine: bot.driverKind, label, signedIn: answer.signedIn,
      uses: bot.driverKind === "claudeAgent" && answer.signedIn ? (answer.source === "bot" ? "own" : "home") : null };
  };
  let next = 0;
  const worker = async () => { while (next < bots.length) { const at = next++; slots[at] = await lineFor(bots[at]!); } };
  await Promise.all(Array.from({ length: Math.min(LINE_CONCURRENCY, bots.length) }, worker));
  const lines = slots.filter((line): line is BotSignInLine => line !== null);
  return lines.length > 0 || bots.length === 0 ? lines : undefined;
}

/** The "sign the other bots in" queue after `doneBotId` signed `engine` in: the other bots that use `engine` and still
 * need a sign-in of their own, in the order the home lists them. Claude has none: the home-wide sign-in covers every bot. */
export function signInQueue(lines: readonly BotSignInLine[], engine: string, doneBotId?: string): { id: string; name: string }[] {
  if (engine === "claudeAgent" || !SIGNIN_ENGINE_LABELS[engine]) return [];
  // A bot that uses `engine` without a sign-in, or a bot on Fuigo with none for it: signing it in moves a Fuigo bot to `engine`.
  return lines.filter(line => line.id !== doneBotId && ((line.engine === engine && !line.signedIn) || (line.engine === FUIGO && !(line.signedInEngines ?? []).includes(engine))))
    .map(line => ({ id: line.id, name: line.name }));
}

/** Tie-break for the engine a new bot is offered, after "the engine most other bots use". */
export const CREATE_STEP_ORDER = ["codex", "claudeAgent", "grokAgent", "kimiAgent", "opencodeGo"] as const;

/** The engines other bots are signed in to, counted by bot and judged by each bot's own store. Claude counts only when a
 * bot signed in with its own account (the home-wide one covers every bot, so it says nothing about this bot). */
export function pickCreateStepEngine(lines: readonly BotSignInLine[], newBotId: string, skip: ReadonlySet<string> = new Set()): { engine: string; label: string } | null {
  const counts = new Map<string, number>();
  const add = (engine: string) => counts.set(engine, (counts.get(engine) ?? 0) + 1);
  for (const line of lines) {
    if (line.id === newBotId) continue;
    if (line.engine === FUIGO) { for (const engine of new Set(line.signedInEngines ?? [])) if (engine !== "claudeAgent") add(engine); continue; }
    if (!line.signedIn) continue;
    if (line.engine === "claudeAgent") { if (line.uses === "own") add(line.engine); continue; }
    add(line.engine);
  }
  let best: string | null = null;
  for (const engine of CREATE_STEP_ORDER) {
    const n = skip.has(engine) ? 0 : counts.get(engine) ?? 0;
    if (n > 0 && (best === null || n > (counts.get(best) ?? 0))) best = engine;
  }
  return best ? { engine: best, label: SIGNIN_ENGINE_LABELS[best]! } : null;
}

/** The offer a bot shows: only a bot on Fuigo has one, for an engine another bot is signed in to that this bot has no sign-in for
 * and the owner has not dismissed. A bot that does not exist, or one already on an engine, has none. */
export function createStepFor(lines: readonly BotSignInLine[], botId: string, dismissed: readonly string[] = []): { engine: string; label: string } | null {
  const line = lines.find(candidate => candidate.id === botId);
  if (!line || line.engine !== FUIGO) return null;
  return pickCreateStepEngine(lines, botId, new Set([...(line.signedInEngines ?? []), ...dismissed]));
}

const ENGINE_QUERY = /^[A-Za-z]{1,32}$/, BOT_QUERY = /^[\w-]{1,64}$/;
function reply(res: ServerResponse, status: number, body: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "cache-control": "no-store", "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** GET /api/cloud/engine-signins[?engine=E[&after=<bot>]][&forBot=<bot>]: `{ bots: [line...] }`, plus `{ queue }` when an engine is named
 * and `{ createStep }` (the engine a new bot is offered to sign in to, or null) when `forBot` is. A bot on Fuigo carries the engines
 * whose offer the owner dismissed. POST /api/cloud/engine-signins/dismiss `{ bot, engine }` hides one bot's offer for good.
 * Called after cloudRequestAuth; an owner device or owner browser only. */
export function createEngineSignInsApi(options: { bots(): readonly BotEngineRef[]; source?: BotSignInSource; offers?: SignInOffers; readBody?(req: IncomingMessage): Promise<unknown> }) {
  const dismissOffer = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const identity = cloudIdentity(req.headers);
    if (!identity || identity.revoked || !(["owner-desktop", "owner-phone"].includes(identity.scope) || isOwnerBrowser(identity))) { reply(res, 403, { error: cloudHomeCopy.pairedDeviceRequired }); return true; }
    let body: unknown;
    try { body = await options.readBody?.(req); } catch { body = undefined; }
    const { bot, engine } = (body && typeof body === "object" ? body : {}) as { bot?: unknown; engine?: unknown };
    if (typeof bot !== "string" || !BOT_QUERY.test(bot) || typeof engine !== "string" || !(engine in SIGNIN_ENGINE_LABELS) || !options.bots().some(known => known.id === bot)) { reply(res, 400, { error: cloudHomeCopy.engineLoginUnknownAction }); return true; }
    if (!options.offers?.dismiss(bot, engine)) { reply(res, 503, { error: cloudHomeCopy.engineSignInsUnavailable }); return true; }
    reply(res, 200, { dismissed: true });
    return true;
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (req.method === "POST" && url.pathname === "/api/cloud/engine-signins/dismiss") return dismissOffer(req, res);
    if (req.method !== "GET" || url.pathname !== "/api/cloud/engine-signins") return false;
    const identity = cloudIdentity(req.headers);
    if (!identity || identity.revoked || !(["owner-desktop", "owner-phone"].includes(identity.scope) || isOwnerBrowser(identity))) { reply(res, 403, { error: cloudHomeCopy.pairedDeviceRequired }); return true; }
    const engine = url.searchParams.get("engine"), after = url.searchParams.get("after"), forBot = url.searchParams.get("forBot");
    if ([...url.searchParams.keys()].some(key => !["engine", "after", "forBot"].includes(key)) || (engine !== null && !ENGINE_QUERY.test(engine)) || (after !== null && (engine === null || !BOT_QUERY.test(after))) || (forBot !== null && !BOT_QUERY.test(forBot))) { reply(res, 400, { error: cloudHomeCopy.engineLoginUnknownAction }); return true; }
    const lines = await botSignInLines(options.bots(), options.source);
    if (lines === undefined) { reply(res, 503, { error: cloudHomeCopy.engineSignInsUnavailable }); return true; }
    const shown = lines.map(line => (line.engine === FUIGO && options.offers ? { ...line, dismissed: options.offers.dismissed(line.id) } : line));
    reply(res, 200, { bots: shown, ...(engine !== null ? { queue: signInQueue(lines, engine, after ?? undefined) } : {}), ...(forBot !== null ? { createStep: createStepFor(lines, forBot, options.offers?.dismissed(forBot) ?? []) } : {}) });
    return true;
  };
}

/** What a refused turn says. */
export const signInRequiredCopy = (bot: string, engine: string): string => `Sign ${bot} in to ${engine} first. In Murage on your computer, open Connect to your Cloud home, then choose Sign in next to ${bot} under your home.`;

/** The turn guard: a bot whose engine has no sign-in of its own (and no home-wide one) is refused before anything spawns,
 * with the plain prompt, instead of an unauthenticated CLI failing. Only a definite "not signed in" refuses: a launcher
 * that cannot answer, a non-home, and engines this panel does not gate pass. Antigravity is gated like the rest: nothing
 * starts its sign-in from a turn, so an unsigned bot is told where to sign in rather than spawning an unauthenticated agy. */
export async function assertBotEngineSignedIn(driverKind: string, bot: { id: string; name: string }, source: Pick<BotSignInSource, "signIn"> = { signIn: botEngineSignIn }): Promise<void> {
  const label = SIGNIN_ENGINE_LABELS[driverKind];
  if (!label) return;
  const answer = await source.signIn(driverKind, bot.id);
  if (answer !== undefined && !answer.signedIn) throw new Error(signInRequiredCopy(bot.name, label));
}

/** A new bot's default engine on a Cloud home comes ONLY from that bot's own sign-in status (never another bot's, never the
 * account's): an engine the bot is signed in to outranks Fuigo (the owner already pays for it), and anything else, unknown
 * included, leaves the bot on Fuigo. A bot not created yet (`botId` null) has no sign-in, so it starts on Fuigo. Off a home the pick is unchanged. */
export async function pickDefaultEngineForBot<T extends { driverKind?: string; snapshot: object }>(described: readonly T[], botId: string | null, pick: (readings: readonly T[]) => { instanceId: string; model: string }, source: Pick<BotSignInSource, "signIn"> = { signIn: botEngineSignIn }): Promise<{ instanceId: string; model: string }> {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") return pick(described);
  const readings = await Promise.all(described.map(async d => {
    if (!d.driverKind || !SIGNIN_ENGINE_LABELS[d.driverKind]) return d;
    const answer = botId ? await source.signIn(d.driverKind, botId) : undefined;
    return { ...d, snapshot: { ...d.snapshot, authenticated: answer?.signedIn === true } };
  }));
  return pick(readings);
}

/** After a bot's own sign-in ended: a bot still on Fuigo that is now signed in to `engine` moves onto it (the offer was "Sign <bot>
 * in to <engine> and use it"). A bot on any other engine stays where the owner put it. Returns the engine moved to, or null. */
export async function useEngineAfterSignIn(engine: string, bot: { id: string; driverKind: string }, move: (driverKind: string) => boolean, source: Pick<BotSignInSource, "signIn"> = { signIn: botEngineSignIn }): Promise<string | null> {
  if (bot.driverKind !== FUIGO || !SIGNIN_ENGINE_LABELS[engine] || engine === "claudeAgent") return null;
  const answer = await source.signIn(engine, bot.id);
  return answer?.signedIn === true && move(engine) ? engine : null;
}
