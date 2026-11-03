// THE ONE PLACE MURAGE MOVES A BOT TO ANOTHER ENGINE ON ITS OWN.
//
// 1.0.14 FIRST-ENGINE-DESKTOP-REPICK-1014-R3b, section 5. The rules, in full:
// - N0: nothing here reads a sign-in: no sign-in field of a scan, no sign-in ranking, no probe. A reading that is slow, stale or
//   conservative can therefore never change the answer.
// - N1: a bot on a live instance that is not Fuigo is never moved. Only the owner moves it (the "Use Fuigo instead" tap).
// - N2: only a marked bot (engineAutoPicked, Murage chose its engine) moves, and only to Fuigo:
//   E Empty: no engine at all (or a legacy blank model on that same Fuigo instance), when the scan shows exactly one usable Fuigo.
//   G Gone: its instance no longer exists, when the scan shows exactly one usable Fuigo and no other usable engine.
// Every write is a compare and set (Store.casEngineMove) on the engine revision read before the scan, with the branch predicate and
// the shared target check T run synchronously at the write, so nothing that changed during the scan await is overwritten.
import { fuigoMoveModel, fuigoSplit, type EngineReading } from "./default-engine.ts";
import type { BotRecord } from "./store.ts";

export type EngineMoveBranch = "E" | "G";

export interface EngineMove {
  branch: EngineMoveBranch;
  selection: { instanceId: string; model: string };
}

/** The live instance as the commit-time check reads it (registry.get). */
export interface LiveInstance {
  readonly driverKind: string;
  readonly enabled: boolean;
  readonly models: { readonly default?: string; readonly options: ReadonlyArray<{ id: string }> };
}

export interface RepickRegistry {
  readonly generation: number;
  scanTicket(): number;
  get(instanceId: string): LiveInstance | null;
}

export interface RepickStore {
  readonly bots: readonly BotRecord[];
  bot(id: string): BotRecord | null | undefined;
  casEngineMove: (botId: string, move: { expectRev: number; selection: { instanceId: string; model: string }; mark: "keep" | "clear"; requireMark: boolean; predicate: (bot: BotRecord) => boolean }) => "moved" | "stale";
}

/** Pure and total: where a bot would move given one scan, and on which branch, or null. Reads no sign-in field. */
export function decideEngineMove(bot: Pick<BotRecord, "modelSelection">, described: readonly EngineReading[]): EngineMove | null {
  const { fuigo, others } = fuigoSplit(described);
  // Two Fuigo instances: there is no ranking to choose between them, so the owner picks.
  if (fuigo.length !== 1) return null;
  const target = fuigo[0]!;
  const selection = { instanceId: target.instanceId, model: fuigoMoveModel(target) };
  const current = bot.modelSelection;
  if (current.instanceId === "") return { branch: "E", selection };
  const present = described.find(entry => entry.instanceId === current.instanceId);
  // A legacy marked Fuigo bot with a blank model takes that same instance's default, never another instance's.
  if (current.model === "" && present?.driverKind === "fuigoAgent") return present.instanceId === target.instanceId ? { branch: "E", selection } : null;
  if (!present && others.length === 0) return { branch: "G", selection };
  return null;
}

/** The shared commit-time target check T (section 4). Synchronous. */
export function targetCheck(registry: RepickRegistry, gen: number, selection: { instanceId: string; model: string }, driverKind = "fuigoAgent"): boolean {
  if (registry.generation !== gen) return false;
  const live = registry.get(selection.instanceId);
  if (live === null || live.enabled === false || live.driverKind !== driverKind) return false;
  return selection.model !== "" && live.models.options.some(option => option.id === selection.model);
}

/** The branch predicate, read at the write against the bot as it is now (section 5 and BR1). */
export function branchHolds(registry: RepickRegistry, gen: number, bot: BotRecord, move: EngineMove, described: readonly EngineReading[]): boolean {
  const current = bot.modelSelection;
  if (move.branch === "E") {
    if (current.instanceId === "") return true;
    return current.model === "" && current.instanceId === move.selection.instanceId && registry.get(current.instanceId)?.driverKind === "fuigoAgent";
  }
  // G: the instance is really gone, was absent from this scan, nothing in the fleet changed since, and (BR1) this same scan shows
  // exactly one usable Fuigo and no other usable engine.
  const { fuigo, others } = fuigoSplit(described);
  return current.instanceId !== ""
    && registry.get(current.instanceId) === null
    && !described.some(entry => entry.instanceId === current.instanceId)
    && registry.generation === gen
    && fuigo.length === 1 && others.length === 0;
}

/** Synchronous pre-check: could this bot ever be moved by a pass? Marked, and with no engine, a blank model, or an instance the fleet no
 * longer has. A marked bot on a live engine (N1) never costs a scan. */
export function couldMoveEngine(registry: Pick<RepickRegistry, "get">, bot: Pick<BotRecord, "engineAutoPicked" | "modelSelection">): boolean {
  if (bot.engineAutoPicked !== true) return false;
  const current = bot.modelSelection;
  return current.instanceId === "" || current.model === "" || registry.get(current.instanceId) === null;
}

export const REPICK_LADDER_MS = [0, 2000, 6000, 15000] as const;

export function createEngineRepick(deps: {
  store: RepickStore;
  registry: RepickRegistry;
  describe: (options: { catalogs: "fresh"; startedAfter: number }) => Promise<readonly EngineReading[]>;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  ladder?: readonly number[];
}) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const log = deps.log ?? ((line: string) => console.log(line));
  const ladder = deps.ladder ?? REPICK_LADDER_MS;
  let running: Promise<void> | null = null;
  let queued: { promise: Promise<void>; resolve: () => void } | null = null;

  /** One attempt over the bots still waiting: one scan (the only await), then a synchronous compare and set per bot. A bot that moved,
   * or whose revision or mark changed, leaves `waiting`; the rest wait for the next attempt. */
  async function attempt(waiting: Map<string, number>, ticket: number): Promise<void> {
    const gen = deps.registry.generation;
    const described = await deps.describe({ catalogs: "fresh", startedAfter: ticket });
    for (const [botId, startRev] of [...waiting]) {
      try {
        const bot = deps.store.bot(botId);
        if (!bot || bot.engineAutoPicked !== true || (bot.engineRev ?? 0) !== startRev) { waiting.delete(botId); continue; }
        const move = decideEngineMove(bot, described);
        // BR1: no write is attempted at all when there is no move.
        if (!move) continue;
        const result = deps.store.casEngineMove(botId, {
          expectRev: startRev, selection: move.selection, mark: "keep", requireMark: true,
          predicate: live => branchHolds(deps.registry, gen, live, move, described) && targetCheck(deps.registry, gen, move.selection),
        });
        if (result === "moved") { waiting.delete(botId); log(`engine: moved ${botId} to ${move.selection.instanceId} ${move.selection.model} (${move.branch})`); }
      } catch (error) {
        // One bot's failed write never stops the others.
        log(`engine: could not move ${botId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async function pass(attemptZeroDone: () => void): Promise<void> {
    // Revisions are read once, before any await: an owner write during the pass makes every later write for that bot stale.
    const waiting = new Map<string, number>();
    for (const bot of deps.store.bots) if (couldMoveEngine(deps.registry, bot)) waiting.set(bot.id, bot.engineRev ?? 0);
    let ticket = deps.registry.scanTicket();
    try {
      for (let index = 0; index < ladder.length && waiting.size; index++) {
        if (index > 0) { await sleep(ladder[index]! - ladder[index - 1]!); ticket = deps.registry.scanTicket(); }
        try { await attempt(waiting, ticket); }
        catch (error) { log(`engine: scan failed: ${error instanceof Error ? error.message : String(error)}`); }
        if (index === 0) attemptZeroDone();
      }
    } finally { attemptZeroDone(); }
  }

  function start(): Promise<void> {
    let resolve!: () => void;
    const attemptZero = new Promise<void>(r => { resolve = r; });
    let done = false;
    const once = () => { if (!done) { done = true; resolve(); } };
    running = pass(once).finally(() => {
      running = null;
      const next = queued;
      queued = null;
      if (next) void start().then(next.resolve);
    });
    return attemptZero;
  }

  return {
    /** Start a pass for `trigger`. Resolves when attempt 0 of a pass that STARTED after this call has finished; a call during a pass
     * runs one more pass after it (single flight, run again). A trigger decides nothing. */
    request(trigger: string): Promise<void> {
      void trigger;
      if (!running) return start();
      if (!queued) { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); queued = { promise, resolve }; }
      return queued.promise;
    },
    /** Resolves when no pass is running (tests). */
    async idle(): Promise<void> { while (running) await running; },
  };
}
