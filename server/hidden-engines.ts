// 1.0.18 U22 G20 (upstream f4fe7cb06, #4159): hide an engine you do not use.
// A hidden engine is left out of every list the server builds for choosing a
// model (the app's engine list, the first-bot probe, the automatic engine
// mover, engine health), because they all read describedInstances, which
// passes through withoutHiddenEngines. Its CLI and sign-in are untouched.
// Upstream filtered withInstanceConfig in default-model-selection.ts and
// refused in routes/instances.ts; Murage has neither file, so the rules live
// here and server/index.ts calls them.
import type { InstanceConfigMap } from "./contracts.ts";

/** Every list a person or the server chooses a model from passes here. */
export function withoutHiddenEngines<T extends { instanceId: string }>(instances: readonly T[], configs: InstanceConfigMap): T[] {
  return instances.filter((instance) => configs[instance.instanceId]?.hidden !== true);
}

/** One engine by id: a hidden engine is never offered, saved or started as a bot's limit backup (Astra r2 Medium). */
export function isHiddenEngine(configs: InstanceConfigMap, instanceId: string): boolean {
  return configs[instanceId]?.hidden === true;
}

export interface HiddenEngineRow { instanceId: string; driverKind: string; displayName: string }

/** The folded "Hidden (n)" list in Engines settings. */
export function hiddenEngineRows(configs: InstanceConfigMap, driverName: (driverKind: string) => string | undefined): HiddenEngineRow[] {
  return Object.entries(configs)
    .filter(([, entry]) => entry.hidden === true)
    .map(([instanceId, entry]) => ({ instanceId, driverKind: entry.driver, displayName: entry.displayName ?? driverName(entry.driver) ?? instanceId }));
}

interface SelectionHolder { instanceId?: string }
export interface HideEngineReading {
  instanceId: string;
  driverKind: string | undefined;
  /** The engine health primary (bootSelection): what a new first bot is born on. */
  primaryId: string | null;
  /** A running turn runs on its bot's or its task's selection, so these cover it. */
  /** A saved limit backup counts too: a later limit would start it on its own (Astra r1 Medium). */
  bots: ReadonlyArray<{ modelSelection: SelectionHolder; limitBackup?: { selection?: SelectionHolder } | null; tasks?: ReadonlyArray<{ lastInstanceId?: string; modelSelection?: SelectionHolder }> }>;
}

export const FUIGO_NOT_HIDDEN = "Fuigo stays in every model list. You can switch it off instead.";
export const ENGINE_IN_USE = "Choose another engine for the bots and conversations using this one before hiding it.";

/** Why hiding this engine is refused, or null when it may go. Fuigo always stays first and shown; an engine a bot, a
 * conversation (a task's selection or its last engine), a running turn or the new-bot default uses cannot go. */
export function hideEngineRefusal(reading: HideEngineReading): { status: 400 | 409; error: string } | null {
  if (reading.driverKind === "fuigoAgent") return { status: 400, error: FUIGO_NOT_HIDDEN };
  const id = reading.instanceId;
  const inUse = reading.primaryId === id || reading.bots.some((bot) => bot.modelSelection.instanceId === id
    || bot.limitBackup?.selection?.instanceId === id
    || (bot.tasks ?? []).some((task) => task.lastInstanceId === id || task.modelSelection?.instanceId === id));
  return inUse ? { status: 409, error: ENGINE_IN_USE } : null;
}
