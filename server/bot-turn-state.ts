// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { join } from "node:path";
import { existsSync, unlinkSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { cancelCoalesced, hasPendingCoalesced, scheduleCoalesced, writeFileAtomic } from "./atomic.ts";
import { afterCommit, onRollback } from "./tx-scope.ts";
import { readPersistedJson, readPersistedRecords, PersistedStateRecoveryError } from "./persisted-state.ts";
import type { BotRecord, TaskRecord } from "./store.ts";

// Producer owner: recall-scope-c (bounded task deltas). Consumer owner: recall-scope-c (boot, backup and downgrade).
const taskFields = ["unread", "title", "pinned", "pinnedMessageId", "link", "linkAuto", "lastInstanceId", "resumeCursors", "resumeSeals", "resumeAudiences", "resumeContracts", "resumePlainToolNames", "resumeIncarnations", "resumePolicies", "replayPending", "effortSent", "usage", "usageTurnKeys"] as const;
const taskFile = (bot: string, thread: string) => createHash("sha256").update(JSON.stringify([bot, thread])).digest("hex") + ".json";

/** These cosmetic fields cannot change memory audiences or grants. Month
 * buckets already have fixed retention caps. This file grows with the live
 * bot roster, never with task history. A full roster write assigns a fresh
 * generation, so an old delta cannot undo a checkpoint, restore or deletion. */
const fields = ["unread", "usageMonths", "usageRoutineMonths"] as const;
const usageFields = ["usageMonths", "usageRoutineMonths"] as const;
type TurnState = Partial<Pick<BotRecord, typeof fields[number]>> & { soleTask?: { threadId: string; unread: boolean } };
type Delta = { base: string; state: TurnState; writtenAt?: number };
let lastWrite = 0;
const writtenAt = () => lastWrite = Math.max(Date.now(), lastWrite + 1);
export type CheckpointBot = BotRecord & { turnStateBase?: string };
export class BotTurnState {
  private bases = new Map<string, string>();
  private states = new Map<string, Delta>();
  private path: string;
  private taskDir: string;
  constructor(dataDir: string) { this.path = join(dataDir, "bot-turn-state.json"); this.taskDir = join(dataDir, "bot-task-state"); }
  file(): string { return this.path; }
  load(bots: CheckpointBot[], read: (path:string)=>unknown = readPersistedJson): boolean {
    const saved = read(this.path) as { version?: unknown; bots?: Record<string, Delta> } | undefined;
    if (saved !== undefined) {
      if (!saved || saved.version !== 1 || !saved.bots || typeof saved.bots !== "object" || Array.isArray(saved.bots)) throw new PersistedStateRecoveryError(this.path, "invalid-shape");
      for (const [id, delta] of Object.entries(saved.bots)) {
        if (!delta || typeof delta.base !== "string" || !delta.state || typeof delta.state !== "object" || Array.isArray(delta.state)
          || delta.writtenAt !== undefined && (!Number.isSafeInteger(delta.writtenAt) || delta.writtenAt < 0)
          || Object.keys(delta.state).some(key => key !== "soleTask" && !fields.includes(key as typeof fields[number]))) throw new PersistedStateRecoveryError(this.path, "invalid-shape");
        if (Object.hasOwn(delta.state, "soleTask")) {
          const task = delta.state.soleTask;
          if (!task || typeof task !== "object" || Array.isArray(task) || typeof task.threadId !== "string" || typeof task.unread !== "boolean"
            || Object.keys(task).some(key => key !== "threadId" && key !== "unread")) throw new PersistedStateRecoveryError(this.path, "invalid-shape");
        }
        this.states.set(id, delta);
      }
    }
    let needsCheckpoint = false;
    for (const bot of bots) {
      const base = bot.turnStateBase;
      delete bot.turnStateBase;
      if (typeof base !== "string") { needsCheckpoint = true; continue; }
      this.bases.set(bot.id, base);
      const delta = this.states.get(bot.id);
      if (delta?.base !== base) continue;
      lastWrite=Math.max(lastWrite,delta.writtenAt??0);
      for (const key of fields) { delete bot[key]; if (Object.hasOwn(delta.state, key)) Object.assign(bot, { [key]: delta.state[key] }); }
      const soleTask = delta.state.soleTask;
      if (soleTask && bot.tasks?.length === 1 && bot.tasks[0]!.threadId === soleTask.threadId) bot.tasks[0]!.unread = soleTask.unread;
    }
    // Deleted bots and prior checkpoint generations never ride the next write.
    for (const [id, delta] of this.states) if (this.bases.get(id) !== delta.base) this.states.delete(id);
    for (const bot of bots) {
      if (!this.bases.has(bot.id)) continue;
      let newestTask = 0;
      let newestUsage = this.states.get(bot.id)?.writtenAt ?? 0;
      for (const task of bot.tasks ?? []) {
        const path = join(this.taskDir, taskFile(bot.id, task.threadId));
        const delta = read(path) as {base?: unknown; state?: Record<string, unknown>; writtenAt?: number; botUsage?: Record<string, unknown>} | undefined;
        if (delta === undefined) continue;
        if (!delta || typeof delta.base !== "string" || !delta.state || typeof delta.state !== "object" || Array.isArray(delta.state)
          || delta.writtenAt !== undefined && (!Number.isSafeInteger(delta.writtenAt) || delta.writtenAt < 0)
          || Object.keys(delta.state).some(key => !taskFields.includes(key as typeof taskFields[number]))
          || delta.botUsage !== undefined && (!delta.botUsage || typeof delta.botUsage !== "object" || Array.isArray(delta.botUsage)
            || Object.keys(delta.botUsage).some(key => !usageFields.includes(key as typeof usageFields[number])))
          || Object.hasOwn(delta.state, "unread") && typeof delta.state.unread !== "boolean") throw new PersistedStateRecoveryError(path, "invalid-shape");
        if (delta.base !== this.bases.get(bot.id)) continue;
        lastWrite=Math.max(lastWrite,delta.writtenAt??0);
        newestTask = Math.max(newestTask, delta.writtenAt ?? 0);
        if (delta.botUsage && (delta.writtenAt ?? 0) > newestUsage) {
          for (const key of usageFields) { delete bot[key]; if (Object.hasOwn(delta.botUsage, key)) Object.assign(bot, {[key]: delta.botUsage[key]}); }
          newestUsage = delta.writtenAt ?? 0;
        }
        for (const key of taskFields) {
          if (key === "unread" && bot.tasks?.length === 1 && (this.states.get(bot.id)?.writtenAt ?? 0) > (delta.writtenAt ?? 0)) continue;
          delete task[key]; if (Object.hasOwn(delta.state, key)) Object.assign(task, {[key]: delta.state[key]});
        }
        if (task.threadId === bot.threadId) for (const key of ["resumeCursors", "resumePolicies", "replayPending", "pinnedMessageId"] as const) {
          delete bot[key]; if (task[key] !== undefined) Object.assign(bot, {[key]: structuredClone(task[key])});
        }
      }
      if (newestTask > (this.states.get(bot.id)?.writtenAt ?? 0) && bot.tasks?.length) bot.unread = bot.tasks.some(task => task.unread);
    }
    return needsCheckpoint;
  }
  checkpoint(bots: readonly BotRecord[], base?: string): void {
    const pending = hasPendingCoalesced(this.path);
    cancelCoalesced(this.path);
    const bases = this.bases, states = this.states;
    onRollback(() => { this.bases = bases; this.states = states; if (pending) scheduleCoalesced(this.path, () => this.flush()); });
    this.bases = new Map(); this.states = new Map();
    if (base !== undefined) for (const bot of bots) this.bases.set(bot.id, base);
    // A rolled-back roster still needs its generation-bound task files. Prune only after the enclosing transaction commits.
    afterCommit(() => {
      const current = new Set(this.bases.values());
      if (existsSync(this.taskDir)) for (const name of readdirSync(this.taskDir)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const path = join(this.taskDir, name), delta = readPersistedJson(path) as { base?: string } | undefined;
        if (!delta?.base || !current.has(delta.base)) unlinkSync(path);
      }
    });
  }
  writeTask(bot: BotRecord, task: TaskRecord): void {
    const base = this.bases.get(bot.id);
    if (!base) throw new Error("Bot task state needs a roster checkpoint");
    const state: Record<string, unknown> = {};
    for (const key of taskFields) if (task[key] !== undefined) state[key] = task[key];
    const botUsage: Record<string, unknown> = {};
    for (const key of usageFields) if (bot[key] !== undefined) botUsage[key] = bot[key];
    mkdirSync(this.taskDir, {recursive: true, mode: 0o700});
    // The provider's idempotency key, task totals and bounded month buckets commit in ONE rename.
    writeFileAtomic(join(this.taskDir, taskFile(bot.id, task.threadId)), JSON.stringify({base, state, botUsage, writtenAt: writtenAt()}), {mode: 0o600});
  }
  has(bot: BotRecord): boolean { return this.bases.has(bot.id); }
  stage(bot: BotRecord): void {
    const base = this.bases.get(bot.id);
    if (!base) throw new Error("Bot turn state needs a roster checkpoint");
    const state: TurnState = {};
    for (const key of fields) if (bot[key] !== undefined) Object.assign(state, { [key]: bot[key] });
    if (bot.tasks?.length === 1 && bot.tasks[0]!.unread !== undefined) state.soleTask = { threadId: bot.tasks[0]!.threadId, unread: bot.tasks[0]!.unread! };
    this.states.set(bot.id, { base, state, writtenAt: writtenAt() });
  }
  flush(): void {
    writeFileAtomic(this.path, JSON.stringify({ version: 1, bots: Object.fromEntries(this.states) }), { mode: 0o600 });
  }
  write(bot: BotRecord): void {
    const before = this.states.get(bot.id);
    this.stage(bot);
    try { this.flush(); }
    catch (error) { if (before) this.states.set(bot.id, before); else this.states.delete(bot.id); throw error; }
  }
}

/** The same durable view boot reads: checkpoint plus generation-bound deltas. */
export function readBotRecords(dataDir: string): BotRecord[] {
  const records = readPersistedRecords<CheckpointBot>(join(dataDir, "bots.json"));
  new BotTurnState(dataDir).load(records);
  return records;
}

/** Older builds read only bots.json. Commit the generation-fenced durable view
 * before removing its sidecar; an interrupted fold is safe to repeat. */
export function foldBotTurnStateForDowngrade(root: string): void {
  const sidecar = join(root, "bot-turn-state.json");
  const taskDir = join(root, "bot-task-state");
  if (!existsSync(sidecar) && !existsSync(taskDir)) return;
  const records = readPersistedRecords<CheckpointBot>(join(root, "bots.json"));
  new BotTurnState(root).load(records);
  for (const record of records) delete record.turnStateBase;
  writeFileAtomic(join(root, "bots.json"), JSON.stringify(records), { mode: 0o600 });
  if (existsSync(sidecar)) unlinkSync(sidecar);
  if (existsSync(taskDir)) rmSync(taskDir, {recursive: true});
}
