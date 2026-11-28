// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CHIEF-TRANSFER-1023 (designs/CHIEF-TRANSFER-1023.md r3, SCOPE-1023 row T8).
// Owners: SERVER side (store chiefEpoch, journal, preview/commit, guards, recovery) = this file + server/store.ts; CHANNEL side
// (quiesce/endMove/retarget on each service) = server/channels/<channel>/service.ts and telegram-service.ts; index.ts wires the adapters.
//
// One owner-only transfer: preview (writes nothing) -> commit (one synchronous block from the fence check to the roster write) ->
// per-channel moveTarget -> DONE. The journal (chief-transfer.json) holds exactly one record: the current transfer or the last DONE.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { isReadOnly } from "./read-only-start.ts";
import { formerChiefOutcome } from "../shared/chief-handover.ts";
import { inertBot, RosterPostCommitError, sectionKey, type BotRecord, type Store } from "./store.ts";
import { botAccessPolicy } from "./bot-access-role.ts";

export const CHIEF_TRANSFER_REQUIRED = { code: "chief-transfer-required", error: "Choose a new Chief first." } as const;

export type TransferChannel = "telegram" | "slack" | "discord" | "signal" | "whatsapp";
export const TRANSFER_CHANNELS: readonly TransferChannel[] = ["telegram", "slack", "discord", "signal", "whatsapp"];

/** The one guard behind PATCH /api/bots/:id (D1). While a workspace Chief exists only the transfer sheet moves or clears the role. */
export function chiefTransferRequired(store: Pick<Store, "workspaceChief">, botId: string, body: Record<string, unknown>): boolean {
  const sitting = store.workspaceChief();
  if (!sitting) return false;
  if (sitting.id === botId) {
    return body.hidden === true || body.chiefOfStaff === false || (body.chiefScope != null && body.chiefScope !== "workspace");
  }
  return body.chiefScope === "workspace";
}

/** The one rule for a routine whose bot is hidden, missing or staged. The scheduler's `botState` and the transfer sheet both call this,
 * so the sheet's "will fail each time they are due" line cannot drift from what the scheduler does. `busy` is read lazily. */
export function routineBotState(bot: { hidden?: boolean; staged?: unknown } | null | undefined, busy: () => boolean): "ready" | "busy" | "missing" | "staged" {
  return !bot || bot.hidden ? "missing" : bot.staged ? "staged" : busy() ? "busy" : "ready";
}

const LEVELS = ["Ask", "Auto", "Full access", "No limits"] as const;
export function permissionLevel(bot: Pick<BotRecord, "autoApprove" | "fullAccess" | "noLimits">): { level: (typeof LEVELS)[number]; rank: number } {
  const rank = bot.noLimits ? 3 : bot.fullAccess ? 2 : bot.autoApprove ? 1 : 0;
  return { level: LEVELS[rank]!, rank };
}

export interface Pairing { channel: TransferChannel; connectionId: string; target: string; live: boolean }
export interface Fence {
  epoch: number; fromId: string; toId: string | null; fromRev: number; toRev: number | null; fromSel: string; toSel: string | null;
  pairings: Pairing[]; appAccess: Array<{ id: string; revision: number; roleBinding: string }>;
}
export interface ChannelOutcome { channel: TransferChannel; result: "moved" | `paused:${string}`; reconnecting?: true }
export interface Outcome {
  id: string; from: string; to: string; fromName: string; toName: string; channels: ChannelOutcome[]; stoppedRuns: number;
  /** "done" or "nothing-changed" (with `reason`). */
  status: "done" | "nothing-changed"; reason?: string;
}
type JournalState = "intent" | "role-saved" | "done";
export interface Journal {
  id: string; state: JournalState; epochBefore: number; epochAfter: number; from: string; to: string; move: TransferChannel[];
  fenced: TransferChannel[]; outcome?: Outcome; shownAt?: number;
}

/** What the transfer needs from one chat app. index.ts builds one per service over the live instance. Each service keeps owning its own files. */
export interface ChannelAdapter {
  channel: TransferChannel;
  /** The saved pairing whose target is `from`, or null (not paired, paused, closed). */
  pairing(from: string): Pairing | null;
  /** Runs in flight for this pairing (a chat message or routine run started from the app). */
  inFlight(): number;
  quiesce(): void;
  endMove(): void;
  /** Today's Chief-changed pause on the live instance. */
  pause(): Promise<void>;
  /** Signal only: persist a Chief-change pause without waiting for a listener. */
  pauseForChiefChange?(): Promise<void> | void;
  /** Cancel run ids only. Never revokes the human connection. Returns how many it cancelled. */
  stopRuns(): Promise<number>;
  /** Runtime only: no file write, no revoke. */
  stopOld(): Promise<void>;
  savedTarget(): string | null;
  cfgTarget(): string | undefined;
  /** Connection file(s) -> `to`, paused:false. */
  writeFiles(to: string): void;
  /** cfg.<channel>.targetBotId = to (no-op for Signal). */
  writeCfg(to: string): void;
  /** New instance bound to `to` (or a fresh resume on the stopped one). `start:false` (boot recovery) only builds it: the gate-checked boot resume starts it. */
  rebuild(to: string, start: boolean): Promise<"reconnecting" | void>;
  /** Roll back an aborted commit: retire the quiesced instance and start one on the old target again, as it was. */
  restart(from: string): Promise<void>;
}

export interface TransferDeps {
  store: Store;
  dataDir: string;
  adapters: () => ChannelAdapter[];
  /** null when the bot's engine may lead; otherwise the plain reason. */
  leadershipError: (bot: BotRecord) => string | null;
  routines: (botId: string) => Array<{ id: string; name: string; schedule: unknown }>;
  emit?: (outcome: Outcome) => void;
  now?: () => number;
}

export type TransferResult = { status: number; body: Record<string, unknown> };
const stale = (): TransferResult => ({ status: 409, body: { code: "chief-transfer-stale", error: "Something changed. Check again." } });

const CHANNEL_STEP_MS = 10_000;
async function channelStep<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Chat app hand-over timed out")), CHANNEL_STEP_MS);
      timer.unref();
    })]);
  } finally { clearTimeout(timer); }
}

export class ChiefTransfer {
  private readonly file: string;
  private readonly deps: TransferDeps;
  /** The journal as this process last wrote it; a best-effort write that fails still records it here, so a disk fault cannot strand a hand-over. */
  private mem: Journal | null;
  constructor(deps: TransferDeps) { this.deps = deps; this.file = join(deps.dataDir, "chief-transfer.json"); this.mem = this.readFile(); }

  // ---- journal ----
  private readFile(): Journal | null {
    if (!existsSync(this.file)) return null;
    try { return JSON.parse(readFileSync(this.file, "utf8")) as Journal; } catch { return null; }
  }
  read(): Journal | null { return this.mem; }
  private write(journal: Journal): void { writeFileAtomic(this.file, JSON.stringify(journal), { mode: 0o600 }); this.mem = journal; }
  /** A journal write after the role has landed must never strand the hand-over: the in-memory record stays right and the move goes on. */
  private writeBestEffort(journal: Journal): void { try { this.write(journal); } catch { this.mem = journal; } }
  /** The listener hold: a channel named by a record still in `intent` or `role-saved` is skipped by the store.onChange pause listeners. */
  holds(channel: TransferChannel): boolean {
    const record = this.read();
    return !!record && record.state !== "done" && record.move.includes(channel);
  }
  /** The last DONE outcome, once: `shownAt` is set on first display. */
  takeOutcome(): Outcome | null {
    const record = this.read();
    if (isReadOnly() || !record || record.state !== "done" || !record.outcome || record.shownAt !== undefined) return null;
    this.writeBestEffort({ ...record, shownAt: (this.deps.now ?? Date.now)() });
    return record.outcome;
  }

  // ---- preview / fence ----
  private selOf(bot: BotRecord): string { return JSON.stringify({ m: bot.modelSelection, h: bot.hidden === true, s: bot.staged !== undefined, section: sectionKey(bot.section) }); }
  private pairingsFor(fromId: string): Pairing[] {
    return this.deps.adapters().map(adapter => adapter.pairing(fromId)).filter((p): p is Pairing => p !== null);
  }
  private roleChanges(from: BotRecord, to: BotRecord | null): BotRecord[] {
    if (!to || from.id === to.id) return [from];
    const teamLead = this.deps.store.bots.filter(bot => bot.id !== from.id && bot.id !== to.id
      && bot.chiefOfStaff === true && sectionKey(bot.section) === sectionKey(to.section));
    return [from, to, ...teamLead];
  }
  fence(fromId: string, toId: string | null): Fence | null {
    const from = this.deps.store.bot(fromId), to = toId ? this.deps.store.bot(toId) : null;
    if (!from || (toId && !to)) return null;
    return { epoch: this.deps.store.chiefEpoch, fromId, toId, fromRev: from.permissionRev ?? 0, toRev: to ? to.permissionRev ?? 0 : null,
      fromSel: this.selOf(from), toSel: to ? this.selOf(to) : null, pairings: this.pairingsFor(fromId),
      appAccess: this.roleChanges(from, to ?? null).filter(bot => bot.connectedAppAccess !== undefined).map(bot => {
        const { revision, roleBinding } = botAccessPolicy(bot);
        return { id: bot.id, revision, roleBinding };
      }) };
  }
  private eligibility(bot: BotRecord): string | null {
    if (bot.hidden === true) return "This bot is archived.";
    if (bot.staged !== undefined || inertBot(bot)) return "This bot is waiting for your review.";
    return this.deps.leadershipError(bot);
  }
  preview(fromId: string, toId: string | null): TransferResult {
    const { store } = this.deps;
    const chief = store.workspaceChief();
    if (!chief || chief.id !== fromId) return { status: 409, body: { code: "chief-transfer-stale", error: "Something changed. Check again." } };
    const to = toId ? store.bot(toId) : null;
    if (toId && !to) return { status: 404, body: { error: "no such bot" } };
    const fence = this.fence(fromId, toId)!;
    const routines = this.deps.routines(fromId).map(routine => ({ id: routine.id, name: routine.name, schedule: routine.schedule }));
    const fromLevel = permissionLevel(chief), toLevel = to ? permissionLevel(to) : null;
    const pairings = fence.pairings.map(p => ({ ...p, checked: p.live }));
    const higher = !!toLevel && toLevel.rank > fromLevel.rank
      ? pairings.filter(p => p.live).map(p => p.channel) : [];
    const candidates = store.bots.filter(bot => bot.id !== fromId && bot.hidden !== true && !inertBot(bot)).map(bot => ({
      id: bot.id, name: bot.name, eligible: this.eligibility(bot) === null, reason: this.eligibility(bot) }));
    const appAccessResets = to ? this.roleChanges(chief, to).flatMap(bot => {
      if (bot.connectedAppAccess === undefined) return [];
      const policy = botAccessPolicy(bot);
      if (!policy.grants.length && !policy.allowWrites && policy.mode === "restricted") return [];
      return [{ id: bot.id, name: bot.name, apps: [...new Set(policy.grants.map(grant => grant.toolkit))] }];
    }) : [];
    const displaced = to ? this.roleChanges(chief, to).slice(2) : [];
    const formerRole = to ? formerChiefOutcome(chief, store.bots.filter(bot => bot.id !== to.id && !displaced.includes(bot)), this.deps.leadershipError(chief) === null) : null;
    return { status: 200, body: {
      from: { id: chief.id, name: chief.name, ...fromLevel, standingAllows: chief.alwaysAllow?.length ?? 0 },
      to: to ? { id: to.id, name: to.name, ...toLevel!, standingAllows: to.alwaysAllow?.length ?? 0, eligible: this.eligibility(to) === null, reason: this.eligibility(to) } : null,
      formerRole, candidates, routines,
      // the line the sheet shows when opened from the archive hint: the scheduler's own rule for a hidden bot
      archiveRoutinesFail: routineBotState({ hidden: true }, () => false) === "missing" && routines.length > 0,
      pairings, appAccessResets, higherLevelApps: higher, inFlight: this.deps.adapters().reduce((n, a) => n + (a.pairing(fromId)?.live ? a.inFlight() : 0), 0),
      fence } };
  }

  // ---- commit ----
  async commit(input: { fence?: Fence; move?: unknown }): Promise<TransferResult> {
    const { store } = this.deps;
    if (isReadOnly()) return { status: 409, body: { code: "chief-transfer-read-only", error: "Nothing changed. Murage is running read-only." } };
    const open = this.read();
    if (open && open.state !== "done") return { status: 409, body: { code: "chief-transfer-busy", error: "A hand-over is finishing. Check again in a moment." } };
    const fence = input.fence;
    if (!fence || typeof fence.fromId !== "string" || typeof fence.toId !== "string") return stale();
    const chief = store.workspaceChief(), to = store.bot(fence.toId);
    if (!chief || !to || chief.id !== fence.fromId || chief.id === to.id) return stale();
    const live = this.fence(fence.fromId, fence.toId)!;
    const { pairings: fencedPairings, ...liveRest } = live;
    const { pairings: askedPairings, ...askedRest } = fence;
    if (JSON.stringify(liveRest) !== JSON.stringify(askedRest) || JSON.stringify(fencedPairings) !== JSON.stringify(askedPairings)) return stale();
    if (!Array.isArray(input.move) || !input.move.every(c => typeof c === "string")) return { status: 400, body: { error: "move must list chat apps" } };
    const move = [...new Set(input.move as string[])] as TransferChannel[];
    const liveChannels = new Set(fencedPairings.filter(p => p.live).map(p => p.channel));
    if (!move.every(channel => liveChannels.has(channel))) return stale();
    const refused = this.eligibility(to);
    if (refused) return { status: 409, body: { code: "chief-transfer-ineligible", error: refused } };

    // ---- synchronous block: no await from here to the end of step 4 (same rule as the PATCH route) ----
    const epochBefore = store.chiefEpoch;
    const journal: Journal = { id: `ct-${(this.deps.now ?? Date.now)()}-${Math.random().toString(36).slice(2, 8)}`, state: "intent",
      epochBefore, epochAfter: epochBefore + 1, from: chief.id, to: to.id, move, fenced: fencedPairings.filter(p => p.live).map(p => p.channel) };
    this.write(journal);
    const adapters = this.deps.adapters();
    const byChannel = new Map(adapters.map(adapter => [adapter.channel, adapter]));
    for (const channel of move) byChannel.get(channel)?.quiesce();
    const snapshot = store.bots.map(bot => ({ bot, chiefOfStaff: bot.chiefOfStaff, chiefScope: bot.chiefScope, hidden: bot.hidden, individual: bot.individual }));
    try {
      store.setChiefOfStaff(to.id, undefined, "workspace", former => this.deps.leadershipError(former) === null);
    } catch (error) {
      if (!(error instanceof RosterPostCommitError)) {
        // before commit: put every role field back in this same synchronous block, so no other code ever observes `to` as Chief
        for (const row of snapshot) {
          const set = (key: "chiefOfStaff" | "chiefScope" | "hidden" | "individual") => { if (row[key] === undefined) delete (row.bot as unknown as Record<string, unknown>)[key]; else (row.bot as unknown as Record<string, unknown>)[key] = row[key]; };
          set("chiefOfStaff"); set("chiefScope"); set("hidden"); set("individual");
        }
        for (const channel of move) byChannel.get(channel)?.endMove();
        const outcome = this.outcome(journal, [], 0, "nothing-changed", "Murage could not save the roster.");
        this.writeBestEffort({ ...journal, state: "done", outcome });
        // outside the synchronous block: the quiesced apps start again on the old Chief, exactly as they were (their files were never touched)
        for (const channel of move) {
          const adapter = byChannel.get(channel);
          if (!adapter) continue;
          try {
            await channelStep(adapter.stopOld());
            await channelStep(adapter.restart(chief.id));
          } catch { try { await this.pauseOne(adapter); } catch { /* the app stays stopped; the owner pairs it again in Settings */ } }
        }
        return { status: 500, body: { error: "Nothing changed. Murage could not save the roster.", outcome } };
      }
    }
    // ---- end of the synchronous block ----
    this.writeBestEffort({ ...journal, state: "role-saved", epochAfter: store.chiefEpoch });
    const outcome = await this.finish({ ...journal, state: "role-saved", epochAfter: store.chiefEpoch }, adapters, true);
    return { status: 200, body: { outcome } };
  }

  private outcome(journal: Journal, channels: ChannelOutcome[], stoppedRuns: number, status: Outcome["status"], reason?: string): Outcome {
    const name = (id: string) => this.deps.store.bot(id)?.name ?? "";
    return { id: journal.id, from: journal.from, to: journal.to, fromName: name(journal.from), toName: name(journal.to), channels, stoppedRuns, status, ...(reason ? { reason } : {}) };
  }

  /** ROLE_SAVED -> REBOUND -> DONE, shared by commit and boot recovery. `move` channels are moved (idempotently); every other fenced
   * pairing is paused here; a failure in one channel never leaves the transfer without a terminal DONE. */
  private async finish(journal: Journal, adapters: ChannelAdapter[], start: boolean): Promise<Outcome> {
    const channels: ChannelOutcome[] = [];
    let stoppedRuns = 0;
    const byChannel = new Map(adapters.map(adapter => [adapter.channel, adapter]));
    for (const channel of journal.fenced) {
      if (journal.move.includes(channel)) continue;
      const adapter = byChannel.get(channel);
      let result: ChannelOutcome["result"] = "paused:left-paused";
      try {
        await this.pauseOne(adapter);
      } catch { result = "paused:save-failed"; }
      channels.push({ channel, result });
    }
    for (const channel of journal.move) {
      const adapter = byChannel.get(channel);
      if (!adapter) { channels.push({ channel, result: "paused:chief-changed" }); continue; }
      const moved = await this.moveTarget(adapter, journal.to, journal.epochAfter, start);
      stoppedRuns += moved.stopped;
      channels.push({ channel, result: moved.result, ...(moved.reconnecting ? { reconnecting: true } : {}) });
    }
    const outcome = this.outcome(journal, channels, stoppedRuns, "done");
    // a live commit's caller shows the outcome from the response, so it is already shown; a recovered one is shown once on the next open
    this.writeBestEffort({ ...journal, state: "done", outcome, ...(start ? { shownAt: (this.deps.now ?? Date.now)() } : {}) });
    try { this.deps.emit?.(outcome); } catch { /* the journal holds the outcome; a missed event only delays the sheet until its next read */ }
    return outcome;
  }

  /** Today's Chief-changed pause. Signal has no listener and no persisted pause of its own, so it gets the durable one. */
  private async pauseOne(adapter: ChannelAdapter | undefined): Promise<void> {
    if (!adapter) return;
    await channelStep(Promise.resolve(adapter.pauseForChiefChange ? adapter.pauseForChiefChange() : adapter.pause()));
  }

  /** One function used by commit and by recovery (D4 moveTarget). `start:false` is boot recovery: files and the new instance only, the gated boot resume starts it. */
  async moveTarget(adapter: ChannelAdapter, to: string, epochAfter: number, start = true): Promise<{ result: ChannelOutcome["result"]; stopped: number; reconnecting?: boolean }> {
    const { store } = this.deps;
    // fence: another election landed since the role save -> move nothing; today's Chief-changed pause so the file matches the outcome
    if (store.chiefEpoch !== epochAfter || store.workspaceChief()?.id !== to) {
      adapter.endMove();
      try { await this.pauseOne(adapter); } catch { return { result: "paused:save-failed", stopped: 0 }; }
      return { result: "paused:chief-changed", stopped: 0 };
    }
    if (adapter.savedTarget() === to && adapter.cfgTarget() === to) { adapter.endMove(); return { result: "moved", stopped: 0 }; }
    let stopped = 0;
    try {
      stopped = await channelStep(adapter.stopRuns());
      await channelStep(adapter.stopOld());
      adapter.writeFiles(to);
      adapter.writeCfg(to);
      adapter.endMove();
      const state = await channelStep(adapter.rebuild(to, start));
      return { result: "moved", stopped, reconnecting: state === "reconnecting" };
    } catch {
      // fail closed, exactly today's state: clear `moving`, leave the pairing paused (the file says paused when the disk allows)
      adapter.endMove();
      try { await this.pauseOne(adapter); } catch { /* the file could not be written; the outcome still says paused */ }
      return { result: "paused:save-failed", stopped };
    }
  }

  // ---- boot recovery ----
  /** Runs after the channel services are constructed and before any resume(). */
  async recover(): Promise<Outcome | null> {
    const record = this.read();
    if (isReadOnly() || !record || record.state === "done") return null;
    const { store } = this.deps;
    const adapters = this.deps.adapters();
    if (record.state === "intent" && store.chiefEpoch === record.epochBefore) {
      const outcome = this.outcome(record, [], 0, "nothing-changed", "Murage stopped first.");
      this.writeBestEffort({ ...record, state: "done", outcome });
      return outcome;
    }
    if (store.chiefEpoch === record.epochAfter) {
      // intent or role-saved with the roster already holding the new Chief
      return this.finish({ ...record, state: "role-saved" }, adapters, false);
    }
    // any other epoch: no moves; pending channels report chief-changed
    const channels: ChannelOutcome[] = [];
    for (const channel of record.fenced) {
      const adapter = adapters.find(a => a.channel === channel);
      adapter?.endMove();
      try { await this.pauseOne(adapter); } catch { /* reported below */ }
      channels.push({ channel, result: "paused:chief-changed" });
    }
    const outcome = this.outcome(record, channels, 0, "done");
    this.writeBestEffort({ ...record, state: "done", outcome });
    return outcome;
  }
}
