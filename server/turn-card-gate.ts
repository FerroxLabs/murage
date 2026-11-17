// The one place a turn-scoped error or notice card is written. Once the owner's Stop reaches a turn, no card the engine, a
// driver, the bus or the turn's own failure handling writes for that turn is shown; suppressing a card never freezes,
// reorders or changes what is logged. A newer admitted turn ends the record's hold, so its real errors still show.
import type { TurnEnd } from "./turn-end.ts";

export type TurnCardSite = "runtime-error" | "failed-line" | "empty-line" | "fold-notice" | "watchdog" | "limit" | "backup"
  | "submission" | "dispatch-failure" | "give-back" | "room-member" | "ledger-present" | "delegations-dropped";
export interface TurnCardScope {
  threadId: string; generation?: string; turnId?: string; botId?: string;
  /** "murage" with no turnId and no generation is the bus's own health warning: never held back. */
  provider?: string;
  lease?: { readonly frozenEnd?: TurnEnd };
}
interface StopRecord { threadId: string; generation?: string; botId?: string; turnIds: Set<string>; current: boolean }

const MAX_RECORDS = 1_000;

export function createTurnCardGate(options: { liveTurnElsewhere?(turnId: string, generation: string | undefined): boolean } = {}) {
  const records: StopRecord[] = [];
  const sameBot = (record: StopRecord, botId: string | undefined) => !record.botId || !botId || record.botId === botId;
  const matches = (record: StopRecord, scope: TurnCardScope): boolean => {
    if (record.threadId !== scope.threadId || !sameBot(record, scope.botId)) return false;
    if (scope.turnId !== undefined && record.turnIds.has(scope.turnId)) return true;
    if (scope.generation !== undefined && record.generation !== undefined) return scope.generation === record.generation;
    if (!record.current) return false;
    return scope.turnId === undefined || !options.liveTurnElsewhere?.(scope.turnId, record.generation);
  };
  const silenced = (scope: TurnCardScope): boolean => {
    if (scope.lease?.frozenEnd?.kind === "silent") return true;
    if (scope.provider === "murage" && scope.turnId === undefined && scope.generation === undefined) return false;
    return records.some(record => matches(record, scope));
  };
  return {
    noteStop(stop: { threadId: string; generation?: string; botId?: string; turnIds: readonly string[] }): void {
      const known = records.find(r => r.threadId === stop.threadId && r.generation === stop.generation && r.botId === stop.botId && r.current);
      if (known) { for (const id of stop.turnIds) known.turnIds.add(id); return; }
      if (records.length >= MAX_RECORDS) records.shift();
      records.push({ threadId: stop.threadId, generation: stop.generation, botId: stop.botId, turnIds: new Set(stop.turnIds), current: true });
    },
    attachTurn(generation: string, providerTurnId: string): void {
      for (const record of records) if (record.generation === generation) record.turnIds.add(providerTurnId);
    },
    admitted(threadId: string, generation: string, botId?: string): void {
      for (const record of records) {
        if (record.threadId === threadId && record.generation !== generation && sameBot(record, botId)) record.current = false;
      }
    },
    silenced,
    write(site: TurnCardSite, scope: TurnCardScope, card: () => void): boolean {
      if (silenced(scope)) { console.info(`[turn] card-suppressed site=${site} after=owner-stop`); return false; }
      card();
      return true;
    },
  };
}
export type TurnCardGate = ReturnType<typeof createTurnCardGate>;
