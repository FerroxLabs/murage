// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L5H results chat (designs/HOOKS-LINEAGE-1023.md r2, section 2). Owners: this file (route table, card writer, HELD reasons, the replay
// pass) is the L5H builder's; the Cloud side behind ResultAudiencePort is MurageCloud's (owner confirmation owed, until then an
// unwired port answers "unavailable" and a Cloud home fails closed to HELD); the host ports (HostPorts) are wired in server/index.ts.
//
// One chat per automation (route_key = home|owner|kind|automation). Every write is validated first; there is no fallback to the main chat,
// the launch chat, a room or the event payload. A route row holds a reserved thread id and an epoch: a chat is made once from the
// reserved id (crash safe), and a card is written only while the epoch read before the write is still current (W12).
import type { DatabaseSync } from "node:sqlite";

export type ResultKind = "webhook" | "app_event";
import type { HeldReason } from "../shared/event-results.ts";
export { HELD_COPY, heldActions, type HeldReason } from "../shared/event-results.ts";
export type AudienceAnswer = "owner_only" | "other_audience" | "unavailable";
/** Cloud homes only. MurageCloud owns the implementation. */
export interface ResultAudiencePort { check(input: { homeId: string; threadId: string; ownerAccountId: string }): Promise<AudienceAnswer> | AudienceAnswer }

export const RESULT_ROUTES_DDL = `CREATE TABLE IF NOT EXISTS event_result_routes (
  route_key TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL, route_epoch INTEGER NOT NULL, task_made INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`;
/** Own initializer (database.ts, the snapshot reference schema): not part of initializeAppTriggers, so a downgrade of connected-app triggers never drops a webhook route. */
export function initializeEventResultRoutes(db: DatabaseSync): void { db.exec(RESULT_ROUTES_DDL); }
export const RESULT_ROUTE_TABLES = ["event_result_routes"] as const;

export const routeKeyOf = (homeId: string, ownerAccountId: string, kind: ResultKind, automationId: string) => JSON.stringify([homeId, ownerAccountId, kind, automationId]);

export interface ResultRoute { routeKey: string; threadId: string; routeEpoch: number; taskMade: boolean }

/** The route table. Idempotent by route_key; the epoch only goes up. */
export class EventResultRoutes {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; db.exec(RESULT_ROUTES_DDL); }
  get(routeKey: string): ResultRoute | null {
    const row = this.db.prepare("SELECT thread_id, route_epoch, task_made FROM event_result_routes WHERE route_key=?").get(routeKey) as { thread_id: string; route_epoch: number; task_made: number } | undefined;
    return row ? { routeKey, threadId: row.thread_id, routeEpoch: row.route_epoch, taskMade: row.task_made === 1 } : null;
  }
  /** Create the route with a reserved thread id, or return the existing one (never a second chat for one key). */
  ensure(routeKey: string, reservedThreadId: string, now: number): ResultRoute {
    this.db.prepare("INSERT OR IGNORE INTO event_result_routes (route_key, thread_id, route_epoch, task_made, created_at) VALUES (?,?,1,0,?)").run(routeKey, reservedThreadId, now);
    return this.get(routeKey)!;
  }
  markTaskMade(routeKey: string, epoch: number): boolean {
    return Number(this.db.prepare("UPDATE event_result_routes SET task_made=1 WHERE route_key=? AND route_epoch=?").run(routeKey, epoch).changes) === 1;
  }
  /** A new chat for the route (the old one was deleted or moved): epoch + 1 and a new reserved id, only from the epoch the caller read. */
  bump(routeKey: string, fromEpoch: number, reservedThreadId: string): ResultRoute | null {
    const changed = Number(this.db.prepare("UPDATE event_result_routes SET route_epoch=route_epoch+1, thread_id=?, task_made=0 WHERE route_key=? AND route_epoch=?").run(reservedThreadId, routeKey, fromEpoch).changes);
    return changed === 1 ? this.get(routeKey) : null;
  }
}

export type ThreadState = { exists: false } | { exists: true; resultsRoute?: string; ownUnshared: boolean };
export interface ResultCard { id: string; runId: string; kind: ResultKind; text: string; link: { type: "run"; threadId: string } | { type: "automation"; automationId: string } }
export interface HostPorts {
  newThreadId(): string;
  /** The automation's bot, or undefined when it (and so the automation) is gone. */
  bot(botId: string): { shared: boolean } | undefined;
  thread(botId: string, threadId: string): ThreadState;
  /** Create the chat with the reserved id; the host sets TaskRecord.resultsRoute = routeKey (never from an API body). False when the bot is gone. */
  createResultsTask(botId: string, title: string, threadId: string, routeKey: string): boolean;
  /** app_event only: the kind=results origin row, committed before createTask so the hard zero guards the chat (C1, W16). Idempotent. */
  guardResultsThread?(threadId: string, botId: string, automationId: string): void;
  /** Idempotent by card id: a replay patches the card, never duplicates it. */
  writeCard(botId: string, threadId: string, card: ResultCard): void;
  /** First entry of a result into HELD on a route: the Results chat shows as unread (Opus H1a). */
  surfaceHeld?(botId: string, threadId: string | null, reason: HeldReason): void;
  now(): number;
}

export interface OwedResult {
  runId: string; kind: ResultKind; automationId: string; automationTitle: string; botId: string; ownerAccountId: string; homeId: string;
  /** Card body (resultCardText) and the run's own conversation, if it got one. */
  text: string; runThreadId?: string;
}
export type DeliverOutcome = { state: "written"; threadId: string } | { state: "held"; reason: HeldReason } | { state: "gone" };

/** Card text by outcome (2.5): the reply for completed, one fixed line otherwise. */
export function resultCardText(status: string, reply: string | undefined, display: string): string {
  if (status === "completed") return reply?.trim() || "Done.";
  if (status === "outcome_unknown") return "Review outcome. Murage can't tell whether this run finished; it will not run again by itself.";
  return display;
}

export class EventResults {
  private readonly heldSeen = new Set<string>();
  readonly routes: EventResultRoutes;
  private readonly host: HostPorts;
  private readonly audience: ResultAudiencePort | undefined;
  private readonly cloudHome: boolean;
  constructor(routes: EventResultRoutes, host: HostPorts, audience?: ResultAudiencePort, cloudHome = false) { this.routes = routes; this.host = host; this.audience = audience; this.cloudHome = cloudHome; }

  /** One owed result -> its card, or a HELD reason. Never throws for a bad target: it holds. */
  async deliver(result: OwedResult): Promise<DeliverOutcome> {
    const bot = this.host.bot(result.botId);
    if (!bot) return { state: "gone" };
    const key = routeKeyOf(result.homeId, result.ownerAccountId, result.kind, result.automationId);
    // bot_shared is checked before any chat check (Opus L3): no chat of a shared bot is unshared, and Recreate cannot help.
    if (bot.shared) return this.hold(result, key, "bot_shared");
    for (let attempt = 0; attempt < 4; attempt++) {
      let route = this.routes.ensure(key, this.host.newThreadId(), this.host.now());
      let state = this.host.thread(result.botId, route.threadId);
      if (!state.exists && route.taskMade) {
        // the chat was deleted: a new one at once, not HELD
        const next = this.routes.bump(key, route.routeEpoch, this.host.newThreadId());
        if (!next) continue;
        route = next; state = { exists: false };
      }
      if (!state.exists) {
        if (result.kind === "app_event") this.host.guardResultsThread?.(route.threadId, result.botId, result.automationId);
        if (!this.host.createResultsTask(result.botId, result.automationTitle, route.threadId, key)) return { state: "gone" };
        this.routes.markTaskMade(key, route.routeEpoch);
        state = this.host.thread(result.botId, route.threadId);
      }
      if (!state.exists || state.resultsRoute !== key || !state.ownUnshared) return this.hold(result, key, "target_moved");
      if (this.cloudHome) {
        let answer: AudienceAnswer = "unavailable";
        try { answer = this.audience ? await this.audience.check({ homeId: result.homeId, threadId: route.threadId, ownerAccountId: result.ownerAccountId }) : "unavailable"; } catch { answer = "unavailable"; }
        if (answer === "unavailable") return this.hold(result, key, "cloud_check_unavailable");
        if (answer === "other_audience") return this.hold(result, key, "target_moved");
      }
      // the epoch CAS and the chat check are re-read after the await: no await between them and the write below
      if (this.routes.get(key)?.routeEpoch !== route.routeEpoch) continue;
      const fresh = this.host.thread(result.botId, route.threadId);
      if (!fresh.exists || fresh.resultsRoute !== key || !fresh.ownUnshared) return this.hold(result, key, "target_moved");
      this.host.writeCard(result.botId, route.threadId, {
        id: `evres-${result.runId}`, runId: result.runId, kind: result.kind, text: result.text,
        link: result.runThreadId ? { type: "run", threadId: result.runThreadId } : { type: "automation", automationId: result.automationId },
      });
      this.heldSeen.delete(`${key}|${result.runId}`);
      return { state: "written", threadId: route.threadId };
    }
    return this.hold(result, key, "target_moved");
  }

  /** The owner's "Recreate results chat": only a route whose chat is moved gets a new one (epoch + 1); anything else is a no-op. */
  async recreate(result: Pick<OwedResult, "kind" | "automationId" | "homeId" | "ownerAccountId" | "botId">): Promise<boolean> {
    const key = routeKeyOf(result.homeId, result.ownerAccountId, result.kind, result.automationId);
    const route = this.routes.get(key);
    if (!route) return false;
    const state = this.host.thread(result.botId, route.threadId);
    if (!state.exists) return false;
    if (state.resultsRoute === key && state.ownUnshared) {
      if (!this.cloudHome || !this.audience) return false;
      try {
        if (await this.audience.check({ homeId: result.homeId, threadId: route.threadId, ownerAccountId: result.ownerAccountId }) !== "other_audience") return false;
      } catch { return false; }
    }
    if (this.host.bot(result.botId)?.shared !== false) return false;
    return this.routes.bump(key, route.routeEpoch, this.host.newThreadId()) !== null;
  }

  private hold(result: OwedResult, key: string, reason: HeldReason): DeliverOutcome {
    const route = this.routes.get(key);
    const seen = `${key}|${result.runId}`;
    if (!this.heldSeen.has(seen)) { this.heldSeen.add(seen); try { this.host.surfaceHeld?.(result.botId, route?.threadId ?? null, reason); } catch { /* the hold stands */ } }
    return { state: "held", reason };
  }
}

/** The replay pass over one source (webhook runs, or app runs): deliver every owed result; written -> done, held -> HELD, gone -> done. Bounded. */
export interface ResultSource {
  owed(limit: number): OwedResult[];
  hold(runId: string, reason: HeldReason): void;
  clear(runId: string, reason: "written" | "automation_deleted"): void;
}
export async function runResultPass(results: EventResults, source: ResultSource, limit = 50): Promise<{ written: number; held: number; gone: number }> {
  const tally = { written: 0, held: 0, gone: 0 };
  for (const owed of source.owed(limit)) {
    const outcome = await results.deliver(owed);
    if (outcome.state === "written") { source.clear(owed.runId, "written"); tally.written++; }
    else if (outcome.state === "held") { source.hold(owed.runId, outcome.reason); tally.held++; }
    else { source.clear(owed.runId, "automation_deleted"); tally.gone++; }
  }
  return tally;
}

/** The app-run side of the replay pass (2.3): over AppTriggerStore's owed/held rows. `display` is appRunDisplay (the base word for each state). */
export interface AppResultStorePort {
  resultsOwed(limit: number): Array<{ runId: string; routineId: string; botId: string; ownerAccountId: string; state: string; threadId: string | null }>;
  holdResult(runId: string, reason: string | null): boolean;
  clearOwed(runId: string, reason: string): boolean;
}
export function appResultSource(store: AppResultStorePort, homeId: string, display: (run: { state: string }) => string): ResultSource {
  return {
    owed: limit => store.resultsOwed(limit).map((run): OwedResult => ({
      runId: run.runId, kind: "app_event", automationId: run.routineId, automationTitle: run.routineId, botId: run.botId, ownerAccountId: run.ownerAccountId, homeId,
      text: resultCardText(run.state, undefined, display(run)), ...(run.threadId ? { runThreadId: run.threadId } : {}),
    })),
    hold: (runId, reason) => { store.holdResult(runId, reason); },
    clear: (runId, reason) => { store.clearOwed(runId, reason); },
  };
}
