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
import { botEngineSignIn, polledBotEngineSignIn, polledBotSignedInEngines, readSignInState } from "./signin-status.ts";
import { cloudHomeCopy } from "./copy.ts";
import type { SignInOffers } from "./signin-offers.ts";

/** The engines a Cloud home signs in, by driver kind, with the name the owner reads. */
export const SIGNIN_ENGINE_LABELS: Readonly<Record<string, string>> = {
  claudeAgent: "Claude", codex: "Codex", grokAgent: "Grok", kimiAgent: "Kimi", opencodeGo: "OpenCode", antigravityAgent: "Antigravity",
};

export interface BotEngineRef { id: string; name: string; driverKind: string; instanceId?: string }
export interface BotSignInLine {
  id: string; name: string;
  /** Driver kind of the engine the bot uses. */
  engine: string; label: string;
  /** The engine instance the bot's own setting names, so a chat that runs on another one (its own picker) can tell this line is not about it. */
  instanceId?: string;
  signedIn: boolean;
  /** Claude only: which sign-in the bot runs on, "home" (the home-wide one) or "own" (this bot's override). Null when not signed in. */
  uses: "home" | "own" | null;
  /** The engines the bot already has a sign-in for. On Fuigo (the metered default) it drives "Sign <bot> in to <engine> and use it" for the rest;
   * on any other engine it tells a chat running on another engine whether that one is signed in. Absent when the launcher did not say. */
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
      return { id: bot.id, name: bot.name, ...(bot.instanceId ? { instanceId: bot.instanceId } : {}), engine: FUIGO, label: "Fuigo", signedIn: true, uses: null, signedInEngines: engines.filter(name => name in SIGNIN_ENGINE_LABELS).sort() };
    }
    const label = SIGNIN_ENGINE_LABELS[bot.driverKind];
    if (!label) return null;
    const answer = await source.signIn(bot.driverKind, bot.id);
    if (answer === undefined) return null;
    // Every engine this bot is signed in to, so a chat running on another engine than the bot's own can be gated for that engine.
    const engines = await source.signedInEngines?.(bot.id);
    return { id: bot.id, name: bot.name, ...(bot.instanceId ? { instanceId: bot.instanceId } : {}), engine: bot.driverKind, label, signedIn: answer.signedIn,
      uses: bot.driverKind === "claudeAgent" && answer.signedIn ? (answer.source === "bot" ? "own" : "home") : null,
      ...(engines !== undefined ? { signedInEngines: engines.filter(name => name in SIGNIN_ENGINE_LABELS).sort() } : {}) };
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
export const signInRequiredCopy = (bot: string, engine: string): string => `Sign ${bot} in to ${engine} first. Open Settings, then Connect, to sign in.`;

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

/** The engine readings a bot's default pick ranks, with each sign-in engine's `authenticated` set from THIS bot's own read: true
 * when signed in, false when signed out, and left undefined (set over the driver's own answer) when the read did not answer or threw,
 * so an unknown engine sits in the middle rank and never in the signed-out one. `unanswered` lists those driver kinds: a move site
 * skips its pass while it is not empty. A bot not created yet (`botId` null) has no sign-in, so every sign-in engine reads signed out. */
export async function botEngineReadings<T extends { driverKind?: string; snapshot: object }>(described: readonly T[], botId: string | null, source: Pick<BotSignInSource, "signIn"> = { signIn: botEngineSignIn }): Promise<{ readings: T[]; unanswered: string[] }> {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") return { readings: [...described], unanswered: [] };
  const unanswered: string[] = [];
  const readings = await Promise.all(described.map(async d => {
    if (!d.driverKind || !SIGNIN_ENGINE_LABELS[d.driverKind]) return d;
    const kind = d.driverKind;
    const state = botId ? await readSignInState(() => source.signIn(kind, botId)) : "signedOut";
    if (state === "unknown") unanswered.push(kind);
    return { ...d, snapshot: { ...d.snapshot, authenticated: state === "unknown" ? undefined : state === "signedIn" } };
  }));
  return { readings, unanswered };
}

/** A new bot's default engine on a Cloud home comes ONLY from that bot's own sign-in status (never another bot's, never the
 * account's): an engine the bot is signed in to outranks Fuigo (the owner already pays for it), and anything else, unknown
 * included, leaves the bot on Fuigo. A bot not created yet (`botId` null) has no sign-in, so it starts on Fuigo. Off a home the pick is unchanged. */
export async function pickDefaultEngineForBot<T extends { driverKind?: string; snapshot: object }>(described: readonly T[], botId: string | null, pick: (readings: readonly T[]) => { instanceId: string; model: string }, source: Pick<BotSignInSource, "signIn"> = { signIn: botEngineSignIn }): Promise<{ instanceId: string; model: string }> {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") return pick(described);
  return pick((await botEngineReadings(described, botId, source)).readings);
}

/** The Cloud home birth fallback, made fresh at every birth (never a value cached at boot). Store.birthSelection has already tried the
 * live Fuigo and found none usable, so Fuigo is left out of the readings here: a Fuigo reading from before it became unusable can
 * never win. The rest is the default pick for a bot not created yet (every sign-in engine reads signed out), over the latest
 * probe readings that the live registry still holds. Synchronous because a birth is. */
export function homeBirthFallback<T extends { instanceId?: string; driverKind?: string; snapshot: object }>(readings: () => readonly T[], pick: (readings: readonly T[]) => { instanceId: string; model: string }, current?: () => ReadonlyMap<string, CurrentEngineReading>): () => { instanceId: string; model: string } {
  // `current` is what the registry holds RIGHT NOW for each enabled instance, with its latest answered state and its live model list.
  // A reading with no entry (removed, switched off, replaced under the same id, never answered) is dropped, and so is one whose current
  // state is not ready. The survivors are ranked on the current state and models, never on the boot-time reading.
  return () => {
    const now = current?.();
    const candidates: T[] = [];
    for (const d of readings()) {
      if (d.driverKind === FUIGO) continue;
      let reading: T = d;
      if (now) {
        const live = d.instanceId === undefined ? undefined : now.get(d.instanceId);
        if (!live || live.snapshot.state !== "available") continue;
        reading = { ...d, snapshot: live.snapshot, models: live.models };
      }
      candidates.push(d.driverKind && SIGNIN_ENGINE_LABELS[d.driverKind] ? { ...reading, snapshot: { ...reading.snapshot, authenticated: false } } : reading);
    }
    return pick(candidates);
  };
}

/** One enabled instance as the registry holds it now: its latest answered state and its live model list. */
export interface CurrentEngineReading { snapshot: { state: string; authenticated?: boolean }; models: { default?: string; options?: ReadonlyArray<{ id: string }> } }

/** A bot whose engine Murage picked itself (not the owner) and that is not on Fuigo moves to the shipped engine once the default
 * pick, made with this bot's own sign-in status, is Fuigo: that only happens when Fuigo is usable (it has a catalogue) and the
 * bot's current engine is not signed in. Returns the selection to move to, or null (an owner's choice, a bot already on Fuigo, or nothing to do). */
export function repickAutoPicked(bot: { engineAutoPicked?: boolean }, current: { driverKind?: string }, pick: { instanceId: string; model: string }, pickedDriverKind: string | undefined): { instanceId: string; model: string } | null {
  if (process.env.MURAGE_CLOUD_ROLE !== "home" || bot.engineAutoPicked !== true) return null;
  if (current.driverKind === FUIGO || pickedDriverKind !== FUIGO || !pick.instanceId || !pick.model) return null;
  return pick;
}

/** The last word before Murage moves a bot off its current engine onto Fuigo (the re-pick and the Chief's setup move). On a Cloud home a
 * bot leaves an engine that has a sign-in only when a fresh read of THAT engine, for THAT bot, is a definite "not signed in". A read
 * that does not answer (or throws) is unknown, and unknown never moves a bot onto the meter. Already on Fuigo (only the model changes),
 * an engine with no sign-in of its own, and off a home: unchanged, the pick decides. */
export async function mayMoveOffEngine(currentDriverKind: string | undefined, botId: string, source: Pick<BotSignInSource, "signIn"> = { signIn: botEngineSignIn }): Promise<boolean> {
  if (process.env.MURAGE_CLOUD_ROLE !== "home" || !currentDriverKind || currentDriverKind === FUIGO || !SIGNIN_ENGINE_LABELS[currentDriverKind]) return true;
  return (await readSignInState(() => source.signIn(currentDriverKind, botId))) === "signedOut";
}

/** Whether the setup route may move the Chief at all. On a Cloud home only an engine Murage picked itself (the mark is set): once the
 * owner chose (the mark is clear) the Chief stays, hello card or not. On the desktop, only while the guided first run is live. */
export function setupMayMoveChief(chief: { engineAutoPicked?: boolean }, conversationLive: () => boolean): boolean {
  if (process.env.MURAGE_CLOUD_ROLE === "home") return chief.engineAutoPicked === true;
  return conversationLive();
}

/** After a bot's own sign-in ended: a bot still on Fuigo that is now signed in to `engine` moves onto it (the offer was "Sign <bot>
 * in to <engine> and use it"). A bot on any other engine stays where the owner put it. Returns the engine moved to, or null. */
export async function useEngineAfterSignIn(engine: string, bot: { id: string; driverKind: string }, move: (driverKind: string) => boolean, source: Pick<BotSignInSource, "signIn"> = { signIn: botEngineSignIn }): Promise<string | null> {
  if (bot.driverKind !== FUIGO || !SIGNIN_ENGINE_LABELS[engine] || engine === "claudeAgent") return null;
  const answer = await source.signIn(engine, bot.id);
  return answer?.signedIn === true && move(engine) ? engine : null;
}

/** The write half of "Sign <bot> in to <engine> and use it". `started` is what the bot was on when the sign-in ended (before the
 * sign-in and catalogue reads, which take a while). The move is the Store's compare and set: it lands only if the bot is STILL on that
 * selection at the same engineRev when it is written, so an owner pick made during the wait is never overwritten. */
type Selection = { instanceId: string; model: string };
export async function moveBotOntoSignedInEngine(
  deps: {
    store: { casEngineMove(id: string, move: { expectRev: number; selection: Selection; mark: "keep" | "clear"; requireMark: boolean; predicate: (bot: { modelSelection: Selection }) => boolean }): "moved" | "stale" };
    target(driverKind: string): Promise<Selection | undefined>;
  },
  botId: string, driverKind: string, started: { modelSelection: Selection; engineRev?: number },
): Promise<"moved" | "stale" | "none"> {
  const target = await deps.target(driverKind);
  if (!target) return "none";
  const startedSelection = JSON.stringify(started.modelSelection);
  return deps.store.casEngineMove(botId, {
    expectRev: started.engineRev ?? 0, selection: target, mark: "clear", requireMark: false,
    predicate: bot => JSON.stringify(bot.modelSelection) === startedSelection,
  });
}
