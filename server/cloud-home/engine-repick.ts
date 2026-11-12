// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two places Murage moves a bot it picked an engine for onto Fuigo (the engine it ships), out of server/index.ts so a test can
// drive the real passes: the Chief's move on a setup read once the Flux key routes, and the re-pick of every Murage-picked bot when
// the key lands on a Cloud home. index.ts keeps thin wrappers that hand in its store, registry and engine readings.
//
// The rule both follow (design CLOUD-SIGNIN-UNKNOWN): an unknown sign-in read never moves a bot. Any sign-in engine whose read for
// that bot did not answer skips the pass (the next pass retries), and the current engine is left only on a definite signed-out read.
import { pickDefaultEngine, type EngineChoice, type EngineReading } from "../default-engine.ts";
import { botEngineReadings, mayMoveOffEngine, repickAutoPicked, setupMayMoveChief, type BotSignInSource } from "./engine-signins.ts";

export interface RepickBot { id: string; name: string; engineAutoPicked?: boolean; modelSelection: { instanceId: string; model: string } }
export interface RepickDeps {
  store: {
    bot(id: string): RepickBot | null | undefined;
    readonly bots: readonly RepickBot[];
    patchBot(id: string, patch: { modelSelection: EngineChoice; engineAutoPicked?: true }): unknown;
  };
  registry: { get(instanceId: string): { driverKind?: string } | null | undefined };
  described(options: { catalogs: "fresh" | "due" }): Promise<readonly EngineReading[]>;
  /** The bot's own sign-in read. Defaults to the launcher's fresh read. */
  source?: Pick<BotSignInSource, "signIn">;
  pick?(readings: readonly EngineReading[]): EngineChoice;
  log?(line: string): void;
  warn?(line: string): void;
  sleep?(ms: number): Promise<void>;
}

const FUIGO = "fuigoAgent";
/** The re-pick tries a few times because the engine catalogue forms a moment after the key. */
export const REPICK_DELAYS_MS: readonly number[] = [0, 2000, 6000, 15000];

/** The Chief's move onto the shipped engine on a setup read. A no-op once the Chief is on Fuigo with the default model, so polling
 * the setup route cannot thrash the Chief's engine. */
export async function moveChiefToShippedEngine(view: { fluxReady?: boolean; chiefBotId?: string | null; conversationLive(): boolean }, deps: RepickDeps): Promise<void> {
  const { store, registry } = deps;
  if (!view.fluxReady || !view.chiefBotId) return;
  const chief = store.bot(view.chiefBotId);
  if (!chief) return;
  // On a Cloud home only an engine Murage picked itself is moved (the hello card stays in the thread for good, so it says nothing about
  // who chose): an owner's own pick (the mark is clear) is never put back on Fuigo. The desktop moves only while the first run is live.
  if (!setupMayMoveChief(chief, () => view.conversationLive())) return;
  const murageOwnPick = process.env.MURAGE_CLOUD_ROLE === "home";
  const startedSelection = JSON.stringify(chief.modelSelection);
  const described = await deps.described({ catalogs: "due" });
  const { readings, unanswered } = await botEngineReadings(described, chief.id, deps.source);
  const selection = (deps.pick ?? pickDefaultEngine)(readings);
  if (!selection.instanceId || !selection.model) return;
  const picked = described.find((instance) => instance.instanceId === selection.instanceId);
  if (picked?.driverKind !== FUIGO) return;
  // An unknown read of any sign-in engine for the Chief never commits Fuigo: skip this pass, the next setup read retries.
  if (unanswered.length > 0) return;
  // Leaving the current engine needs a definite "not signed in" for it: a sign-in read that did not answer never moves the Chief onto the meter.
  if (!(await mayMoveOffEngine(registry.get(chief.modelSelection.instanceId)?.driverKind, chief.id, deps.source))) return;
  // The awaits above can span an owner's own pick. For a move that did not need the hello card, the owner's choice wins.
  if (murageOwnPick) {
    const fresh = store.bot(chief.id);
    if (!fresh || fresh.engineAutoPicked !== true || JSON.stringify(fresh.modelSelection) !== startedSelection) return;
  }
  // The model moves too, not only the engine: before a key exists Fuigo's default may be a local model it found, and a Chief left
  // pinned to it would make the key card's promise untrue once the catalogue re-forms around the key.
  const current = chief.modelSelection;
  if (current.instanceId === selection.instanceId && current.model === selection.model) return;
  store.patchBot(chief.id, { modelSelection: selection });
  deps.log?.(`setup: put the Chief on the shipped engine (${selection.instanceId} ${selection.model})`);
}

/** One re-pick pass: every bot whose engine Murage picked itself moves onto Fuigo once Fuigo is the default pick for it, made with
 * that bot's own sign-in reads. An owner's explicit choice carries no mark and is never touched. */
export async function repickAutoPickedBotsOnce(deps: RepickDeps, delays: readonly number[] = REPICK_DELAYS_MS): Promise<void> {
  const { store, registry } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (const delay of delays) {
    if (delay) await sleep(delay);
    const candidates = store.bots.filter(bot => bot.engineAutoPicked === true && registry.get(bot.modelSelection.instanceId)?.driverKind !== FUIGO);
    if (!candidates.length) return;
    const described = await deps.described({ catalogs: "fresh" });
    for (const bot of candidates) {
      const { readings, unanswered } = await botEngineReadings(described, bot.id, deps.source);
      const pick = (deps.pick ?? pickDefaultEngine)(readings);
      const currentKind = registry.get(bot.modelSelection.instanceId)?.driverKind;
      const move = repickAutoPicked(bot, { driverKind: currentKind }, pick, described.find(item => item.instanceId === pick.instanceId)?.driverKind);
      // An unknown read of any sign-in engine for this bot skips it this pass; the next pass (or the next key update) retries.
      if (!move || unanswered.length > 0) continue;
      // Only a definite "not signed in" on the bot's current engine moves it: an unanswered read leaves it where it is.
      if (!(await mayMoveOffEngine(currentKind, bot.id, deps.source)) || store.bot(bot.id)?.engineAutoPicked !== true) continue;
      try {
        store.patchBot(bot.id, { modelSelection: move, engineAutoPicked: true });
        deps.log?.(`engine: moved ${bot.name} onto the shipped engine (${move.instanceId} ${move.model})`);
      } catch (error) {
        deps.warn?.(`engine: could not move ${bot.name} onto the shipped engine: ${error instanceof Error ? error.message : "save failed"}`);
      }
    }
  }
}
