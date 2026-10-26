// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Whether an engine is signed in on a Cloud home, as the ROOT launcher knows it.
//
// The server cannot read a sign-in on a home: the stores are root-only (`/data/engine-homes/<engine>/signin`
// for a home-wide sign-in, `.../<engine>/bots/<bot>/signin` for a per-bot one) and a probe the server runs
// (`codex login status`, an `auth.json` look in its own $HOME) carries no bot, so the launcher stages no
// sign-in into it. Every driver's own check therefore reads "not signed in" on a home, even with a bot that
// is signed in, and the new-bot ranking (default-engine.ts) then drops the engine below Fuigo, which is
// metered: the owner pays twice and our engine outranks the sign-in they already own (F4 brief, C2).
//
// This reads the launcher's `bot-state-query` (names and timestamps only, never a secret) once without a bot
// (the home-wide C stores) and once per bot (that bot's own store, the C store winning), and answers one
// question: has the owner signed this engine in ANYWHERE on this home? That is the "they already pay for
// this" signal the ranking wants. It is NOT "this bot can run it": a bot with no store of its own still
// needs its own sign-in (`botEngineSignedIn`), and that per-bot line is what the Cloud UI shows.
//
// Active only on a Cloud home (MURAGE_CLOUD_ROLE=home); elsewhere every function answers null/undefined.
import { queryCloudBotState, type CloudLauncherSpawn } from "./bot-state.ts";

export interface CloudHomeSignIns {
  /** Launcher engine names signed in by a home-wide (C) store. */
  readonly homeWide: ReadonlySet<string>;
  /** Per bot: the engines it is signed in to (its own B store, or a home-wide C store). */
  readonly perBot: ReadonlyMap<string, ReadonlySet<string>>;
  /** True when a bot could not be read, or the home has more bots than are read: "not signed in anywhere" is then unknown. */
  readonly incomplete: boolean;
}

const CACHE_MS = 5_000;
const MAX_BOTS = 200;
const CONCURRENCY = 4;

let listBots: () => readonly string[] = () => [];
let launcher: CloudLauncherSpawn | undefined;
/** One read at a time: `done` is set when it finishes, and the TTL runs from there, so a slow read is never served stale. */
let cached: { done?: number; value: Promise<CloudHomeSignIns | null> } | null = null;

/** Wire the bot list (and, in tests, the launcher). Called once at startup; clears the cache. */
export function configureCloudSignIns(options: { bots?: () => readonly string[]; launch?: CloudLauncherSpawn } = {}): void {
  listBots = options.bots ?? (() => []);
  launcher = options.launch;
  cached = null;
}
/** Forget what was read: the next question asks the launcher again (after a sign-in or sign-out). */
export function forgetCloudSignIns(): void { cached = null; botCache.clear(); }

/** One launcher question per bot per CACHE_MS, for the status lines the open windows poll. A failed read is never kept.
 * The turn guard and the "use it after sign-in" step do NOT read through this: they must see a sign-in that just landed. */
const botCache = new Map<string, { done?: number; value: ReturnType<typeof queryCloudBotState> }>();
function cachedBotState(botId: string) {
  const hit = botCache.get(botId);
  if (hit && (hit.done === undefined || Date.now() - hit.done <= CACHE_MS)) return hit.value;
  const entry: { done?: number; value: ReturnType<typeof queryCloudBotState> } = { value: queryCloudBotState(botId, launcher) };
  entry.value.then(() => { entry.done = Date.now(); }, () => { if (botCache.get(botId) === entry) botCache.delete(botId); });
  botCache.set(botId, entry);
  return entry.value;
}

const onHome = (): boolean => process.env.MURAGE_CLOUD_ROLE === "home";
/** The launcher names Antigravity by its short engine name; the registry and the desktop use the driver kind. */
export const launcherEngine = (driverKind: string): string => (driverKind === "antigravityAgent" ? "antigravity" : driverKind);
const signed = (engines: Record<string, { signedIn: boolean }>): Set<string> =>
  new Set(Object.entries(engines).filter(([, state]) => state.signedIn).map(([name]) => name));

async function read(): Promise<CloudHomeSignIns | null> {
  let homeWide: Set<string>;
  try { homeWide = signed((await queryCloudBotState(undefined, launcher)).engines); } catch { return null; }
  const all = [...new Set(listBots())];
  const ids = all.slice(0, MAX_BOTS);
  let incomplete = all.length > ids.length;
  const perBot = new Map<string, ReadonlySet<string>>();
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const bot = ids[next++]!;
      // One bot the launcher cannot read says nothing about the others.
      try { perBot.set(bot, signed((await queryCloudBotState(bot, launcher)).engines)); } catch { incomplete = true; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  return { homeWide, perBot, incomplete };
}

/** What the launcher holds, or null off a home or when it cannot answer. Cached for a few seconds. */
export function readCloudHomeSignIns(): Promise<CloudHomeSignIns | null> {
  if (!onHome()) return Promise.resolve(null);
  if (!cached || (cached.done !== undefined && Date.now() - cached.done > CACHE_MS)) {
    const entry: NonNullable<typeof cached> = { value: read() };
    entry.value = entry.value.finally(() => { entry.done = Date.now(); });
    cached = entry;
  }
  return cached.value;
}

/** True when any home-wide store or any bot's store signs this engine (a driver kind) in; false when none
 * does; undefined off a home, when the launcher cannot answer, or when a bot could not be read (the caller keeps its own reading). */
export async function cloudEngineSignedInSomewhere(driverKind: string): Promise<boolean | undefined> {
  const reading = await readCloudHomeSignIns();
  if (!reading) return undefined;
  const engine = launcherEngine(driverKind);
  if (reading.homeWide.has(engine) || [...reading.perBot.values()].some(engines => engines.has(engine))) return true;
  // A bot the launcher could not read might be the signed-in one: unknown, and the caller keeps its own reading.
  return reading.incomplete ? undefined : false;
}

/** Whether THIS bot can run the engine on its own sign-in (its B store, or a home-wide C store); undefined
 * when the launcher cannot answer. A new bot reads false for every per-bot engine until it is signed in. */
export async function botEngineSignedIn(driverKind: string, botId: string): Promise<boolean | undefined> {
  if (!onHome()) return undefined;
  try { return (await queryCloudBotState(botId, launcher)).engines[launcherEngine(driverKind)]?.signedIn === true; } catch { return undefined; }
}

/** The per-bot answer behind `botEngineSignedIn`, with which store answered: for Claude, "bot" is the bot's own
 * sign-in and "home" the home-wide one (F4 C2). `source` is null when the engine is not signed in or the launcher
 * does not say. undefined when the launcher cannot answer. */
export async function botEngineSignIn(driverKind: string, botId: string): Promise<{ signedIn: boolean; source: "home" | "bot" | null } | undefined> {
  if (!onHome()) return undefined;
  try {
    const state = (await queryCloudBotState(botId, launcher)).engines[launcherEngine(driverKind)];
    return { signedIn: state?.signedIn === true, source: state?.signedIn === true ? state.source ?? null : null };
  } catch { return undefined; }
}

/** Every engine (driver kind) this bot can run on a sign-in of its own or the home's, from one launcher question; undefined when it cannot answer. */
export async function botSignedInEngines(botId: string): Promise<string[] | undefined> {
  if (!onHome()) return undefined;
  try {
    const engines = (await queryCloudBotState(botId, launcher)).engines;
    return Object.entries(engines).filter(([, state]) => state.signedIn).map(([name]) => (name === "antigravity" ? "antigravityAgent" : name));
  } catch { return undefined; }
}

/** `botEngineSignIn` for the polled status lines: the same answer, at most one launcher question per bot per CACHE_MS. */
export async function polledBotEngineSignIn(driverKind: string, botId: string): Promise<{ signedIn: boolean; source: "home" | "bot" | null } | undefined> {
  if (!onHome()) return undefined;
  try {
    const state = (await cachedBotState(botId)).engines[launcherEngine(driverKind)];
    return { signedIn: state?.signedIn === true, source: state?.signedIn === true ? state.source ?? null : null };
  } catch { return undefined; }
}

/** `botSignedInEngines` for the polled status lines, cached the same way. */
export async function polledBotSignedInEngines(botId: string): Promise<string[] | undefined> {
  if (!onHome()) return undefined;
  try {
    const engines = (await cachedBotState(botId)).engines;
    return Object.entries(engines).filter(([, state]) => state.signedIn).map(([name]) => (name === "antigravity" ? "antigravityAgent" : name));
  } catch { return undefined; }
}
