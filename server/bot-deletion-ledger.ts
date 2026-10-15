// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This run's removals of bots, numbered like every other bot change (BOTADDED-DESIGN-V3 r6 §4). A real deletion and a hide each
// carry the number of the bot's last frame (`taskDelta.seq(id)`, which outlives `forget`) and the run (`tasksEpoch`), so a
// client can order any record it later meets for that id against the removal. Nothing here is durable: the durable proof of a
// deletion is the owner-deletion record written before the registry forgets the bot (store.ts deleteBot, owner-deletions.ts).
//
// The roster's `removed[]` is a sliding window of the last ANSWER_TTL_MS: it exists only to fence answers still within their
// life, so older entries are pruned on every read and write.

/** How long a client applies an HTTP answer after it was sent; a removal older than this cannot be overtaken by one. */
export const ANSWER_TTL_MS = 10 * 60_000;

export type RemovalKind = "deleted" | "hidden";

export interface Removal {
  tasksSeq: number;
  tasksEpoch: string;
  kind: RemovalKind;
  at: number;
  /** A deletion only: whether the paired phone could see the bot when it was deleted (captured by the DELETE route in its
   * commit callback). Any other deletion path leaves it false. */
  companionVisible: boolean;
}

/** Who asks for the roster: the owner's desktop (unscoped), the owner's phone or door (scoped), or anyone else. */
export type RosterAudience = "owner-desktop" | "owner-scoped" | "other";

export interface RemovedEntry { id: string; tasksSeq: number; tasksEpoch: string; kind: RemovalKind }

export function createBotDeletionLedger(options: { now?: () => number; ttlMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? ANSWER_TTL_MS;
  const entries = new Map<string, Removal>();
  const prune = () => {
    const cut = now() - ttl;
    for (const [id, entry] of entries) if (entry.at < cut) entries.delete(id);
  };
  return {
    /** A real deletion: it replaces any hide entry for the id. */
    deleted(id: string, tasksSeq: number, tasksEpoch: string): void {
      prune();
      entries.set(id, { tasksSeq, tasksEpoch, kind: "deleted", at: now(), companionVisible: false });
    },
    /** A hide frame was sent for a bot. Only the transition is recorded: a later change to a still-hidden bot keeps the first
     * hide's number (its own frame is newer and the client orders it on its own). */
    hidden(id: string, tasksSeq: number, tasksEpoch: string): void {
      prune();
      if (entries.has(id)) return;
      entries.set(id, { tasksSeq, tasksEpoch, kind: "hidden", at: now(), companionVisible: false });
    },
    /** The bot is visible again (a restore): its hide no longer describes it. */
    shown(id: string): void {
      if (entries.get(id)?.kind === "hidden") entries.delete(id);
    },
    /** The DELETE route captured, in its commit callback, whether the phone could see the bot. */
    markCompanionVisible(id: string, visible: boolean): void {
      const entry = entries.get(id);
      if (entry?.kind === "deleted") entry.companionVisible = visible;
    },
    /** This run's deletion of the id, if still within the window. */
    deletion(id: string): Removal | undefined {
      prune();
      const entry = entries.get(id);
      return entry?.kind === "deleted" ? entry : undefined;
    },
    /** The roster's `removed[]`, or undefined when this audience gets none (r6 M6 and H-r6-1): the owner's desktop holds archived
     * bots as hidden records, so it gets deletions only; the owner's scoped roster gets hides and the deletions the phone could
     * see; nobody else gets the field. */
    removedFor(audience: RosterAudience): RemovedEntry[] | undefined {
      if (audience === "other") return undefined;
      prune();
      const out: RemovedEntry[] = [];
      for (const [id, entry] of entries) {
        const listed = audience === "owner-desktop"
          ? entry.kind === "deleted"
          : entry.kind === "hidden" || entry.companionVisible;
        if (listed) out.push({ id, tasksSeq: entry.tasksSeq, tasksEpoch: entry.tasksEpoch, kind: entry.kind });
      }
      return out;
    },
  };
}
export type BotDeletionLedger = ReturnType<typeof createBotDeletionLedger>;

/** DELETEs of one bot run one at a time: a second DELETE for an id waits for the one in flight and then runs its own route from
 * the top (its own preconditions, so a plain DELETE never inherits an `ifArchived` refusal). Only DELETEs are serialised; the
 * archived and running checks are re-made at the commit. */
export function createPerKeySerialiser() {
  const running = new Map<string, Promise<unknown>>();
  return {
    async run<T>(key: string, body: () => Promise<T>): Promise<T> {
      for (let held = running.get(key); held; held = running.get(key)) await held.catch(() => {});
      const mine = body();
      running.set(key, mine);
      try { return await mine; } finally { if (running.get(key) === mine) running.delete(key); }
    },
    busy(key: string): boolean { return running.has(key); },
  };
}

/** The re-check made synchronously inside the deletion's commit callback, before the registry forgets the bot: a restore during
 * the route's awaits defeats an `ifArchived` delete, and a turn started meanwhile defeats any delete. */
export function commitRefusal(bot: { hidden?: boolean } | null | undefined, options: { ifArchived: boolean; running: boolean }): "gone" | "restored" | "running" | null {
  if (!bot) return "gone";
  if (options.ifArchived && !bot.hidden) return "restored";
  if (options.running) return "running";
  return null;
}
