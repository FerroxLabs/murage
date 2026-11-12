// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID, createHash } from 'node:crypto';
import { Ledger, settle_verdict, write_outcome, type TerminalEvent, type WriteReason, type SettleVerdict } from './turn-settle.ts';
import { decide } from './outside-authority.ts';
import { managedBotProfile } from './bot-management.ts';
import { sectionKey, type Store, type BotRecord } from './store.ts';
import type { StagedBot, HeldBotWork, PendingBotRevision } from './bot-staging-types.ts';
const fail = (message: string, status = 409): never => { throw Object.assign(new Error(message), { status }); };
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
};
export interface BotWriteHooks {
  dispatch?: (bot: BotRecord, work: HeldBotWork) => void | Promise<void>;
  dropped?: (work: HeldBotWork, text: string) => void;
  validate?: (bot: BotRecord, candidate: BotRecord) => void;
  activated?: (bot: BotRecord) => void;
  reviewNeeded?: (bot: BotRecord) => void;
  reviewed?: (bot: BotRecord) => void;
  settled?: (generation: string, verdict: SettleVerdict) => void;
}
export class BotOutsideWrites {
  readonly ledger = new Ledger();
  private store: Store;
  private live: (threadId: string) => string | null;
  private deliveries = new Set<Promise<void>>();
  private releasing = new Set<string>();
  private hooks: BotWriteHooks;
  constructor(store: Store, live: (threadId: string) => string | null, hooks: BotWriteHooks = {}) { this.store = store; this.live = live; this.hooks = hooks; }
  async flush() { await Promise.all([...this.deliveries]); }
  release(generation: string) {
    this.ledger.abnormal(undefined, generation);
    this.settle(generation, { ok: false, stopReason: 'released' });
    // Keep a bounded tombstone window so an event cannot bind to a later run on the same thread.
    if (this.ledger.rows.size > 1000) for (const [gen, row] of this.ledger.rows) {
      if (!row.settled || gen === generation) continue;
      this.ledger.rows.delete(gen);
      for (const [ptid, bound] of this.ledger.by_ptid) if (bound === gen) this.ledger.by_ptid.delete(ptid);
      if (this.ledger.rows.size <= 1000) break;
    }
  }
  private commit(candidates: Map<string, BotRecord>) {
    const work = [...candidates].flatMap(([id, next]) => next.staged ? [] : (this.store.bot(id)?.staged?.heldWork ?? []).map(item => ({ id, item })));
    for (const { id, item } of work) { const next = candidates.get(id)!; next.pendingHeldWork = [...(next.pendingHeldWork ?? []), { ...item, ref: item.ref ?? randomUUID() }]; }
    const previouslyPending = new Set([...candidates.keys()].filter(id => { const b = this.store.bot(id); return b?.staged || b?.pendingRevision; }));
    this.store.commitBotReview(candidates);
    for (const bot of candidates.values()) {
      const pending = bot.staged ?? bot.pendingRevision;
      if (pending && pending.reason !== 'turn-open') this.hooks.reviewNeeded?.(bot);
      else if (!pending && previouslyPending.has(bot.id)) this.hooks.reviewed?.(bot);
    }
    for (const bot of candidates.values()) if (!bot.staged && !bot.pendingRevision) this.hooks.activated?.(bot);
    for (const id of new Set(work.map(w => w.id))) this.releasePending(id);
  }
  /** Crash recovery uses the same durable transfer as activation. The dispatch sink must deduplicate by ref. */
  recoverHeldWork() { for (const bot of this.store.activeBots()) if (bot.pendingHeldWork?.length) this.releasePending(bot.id); }
  private releasePending(id: string) {
    if (this.releasing.has(id) || !this.hooks.dispatch) return;
    this.releasing.add(id);
    const delivery = (async () => {
      for (;;) {
        const bot = this.store.activeBot(id), item = bot?.pendingHeldWork?.[0];
        if (!bot || !item) return;
        try { await this.hooks.dispatch!(bot, item); }
        catch { this.hooks.dropped?.(item, 'The original request or permissions for this held work are no longer available, so it did not run.'); }
        const current = this.store.bot(id);
        if (!current) return;
        const next = structuredClone(current);
        next.pendingHeldWork = next.pendingHeldWork?.filter(work => work.ref !== item.ref);
        if (!next.pendingHeldWork?.length) delete next.pendingHeldWork;
        this.store.commitBotReview(new Map([[id, next]]));
      }
    })();
    this.deliveries.add(delivery);
    void delivery.then(() => { this.deliveries.delete(delivery); this.releasing.delete(id); }, () => { this.deliveries.delete(delivery); this.releasing.delete(id); });
  }
  private conflicts(candidates: Map<string, BotRecord>): boolean {
    const roster = this.store.bots.map(b => candidates.get(b.id) ?? b).filter(b => !b.hidden && !b.staged);
    return [...candidates.values()].some(b => !b.hidden && !b.staged && roster.some(other => other.id !== b.id && sectionKey(other.section) === sectionKey(b.section)
      && (other.name.toLowerCase() === b.name.toLowerCase() || other.chiefOfStaff && b.chiefOfStaff)));
  }
  staging(generation: string, byThreadId: string, byBotId: string, reason: WriteReason, intended: StagedBot['intended']): StagedBot {
    return { rev: 1, at: Date.now(), generation, byThreadId, byBotId, reason, intended: structuredClone(intended), heldWork: [] };
  }
  record(id: string) {
    const bot = this.store.bot(id), pending = bot?.staged ?? bot?.pendingRevision;
    if (!pending) return;
    const row = this.ledger.rows.get(pending.generation);
    if (pending.reason !== 'turn-open') this.hooks.reviewNeeded?.(bot!);
    if (row && !row.settled && pending.reason === 'turn-open') { row.writes = row.writes.filter(([other]) => other !== id); row.writes.push([id, pending.rev]); }
  }
  revision(id: string, generation: string, byThreadId: string, byBotId: string, reason: WriteReason, fields: PendingBotRevision['fields'], baseRevision: string) {
    const bot = this.store.bot(id); if (!bot || bot.staged) return fail('This bot is waiting for review.');
    const pendingRevision: PendingBotRevision = { rev: (bot.pendingRevision?.rev ?? 0) + 1, at: Date.now(), generation, byThreadId, byBotId, reason, fields: structuredClone(fields), baseRevision };
    this.store.commitBotReview(new Map([[id, { ...bot, pendingRevision }]])); this.record(id);
    return { id, pendingReview: true, startsWhen: reason === 'turn-open' ? 'reply-ends' : 'owner-review' };
  }
  discard(id: string) {
    const bot = this.store.bot(id); if (!bot) return fail('No such bot.', 404);
    if (bot.staged) { const work = bot.staged.heldWork; this.store.deleteBot(id); this.hooks.reviewed?.(bot); for (const item of work) this.hooks.dropped?.(item, `${bot.name} was discarded, so the work you handed it did not run.`); return; }
    const next = structuredClone(bot); delete next.pendingRevision;
    this.store.commitBotReview(new Map([[id, next]])); this.hooks.reviewed?.(bot);
  }
  display(bot: BotRecord) {
    return { id: bot.id, name: bot.name, role: bot.title, instructions: bot.description, modelSelection: bot.modelSelection, section: bot.section ?? '', lead: bot.chiefOfStaff === true, archived: bot.hidden === true, autoApprove: bot.autoApprove === true, fullAccess: bot.fullAccess === true, noLimits: bot.noLimits === true, alwaysAllow: bot.alwaysAllow ?? [], tasks: (bot.tasks ?? []).map(t => ({ threadId: t.threadId, autoApprove: t.autoApprove === true, fullAccess: t.fullAccess === true, noLimits: t.noLimits === true, alwaysAllow: t.alwaysAllow ?? [] })) };
  }
  review(id: string) {
    const bot = this.store.bot(id); if (!bot) return fail('No such bot.', 404);
    const pending = bot.staged ?? bot.pendingRevision; if (!pending) return fail('This bot changed. Read it again and retry.');
    const spec = { ...this.display(bot), staged: bot.staged ?? null, pendingRevision: bot.pendingRevision ?? null };
    return { spec, digest: createHash('sha256').update(canonical(spec)).digest('hex') };
  }
  private activate(bot: BotRecord): BotRecord {
    const next = structuredClone(bot);
    const pending = next.pendingRevision;
    if (pending) {
      if (managedBotProfile(bot).revision !== pending.baseRevision) return fail('This bot changed. Read it again and retry.');
      const f = pending.fields;
      if (f.name !== undefined) next.name = f.name;
      if (f.role !== undefined) next.title = f.role;
      if (f.instructions !== undefined) next.description = f.instructions;
      if (f.modelSelection) next.modelSelection = f.modelSelection;
      if (f.section !== undefined) next.section = f.section;
      if (f.restore) next.hidden = false;
      if (f.lead) next.chiefOfStaff = true;
      delete next.pendingRevision;
    }
    if (next.staged) {
      const { intended } = next.staged;
      const levels = { autoApprove: intended.autoApprove, fullAccess: intended.fullAccess, noLimits: intended.noLimits };
      Object.assign(next, levels);
      next.tasks = next.tasks?.map(t => ({ ...t, ...levels }));
      if (intended.modelSelection) next.modelSelection = intended.modelSelection;
      if (intended.lead) next.chiefOfStaff = true;
      delete next.staged;
    }
    if (this.store.activeBots().some(b => b.id !== bot.id && sectionKey(b.section) === sectionKey(next.section)
      && (b.name.toLowerCase() === next.name.toLowerCase() || next.chiefOfStaff && b.chiefOfStaff))) return fail('This team changed. Read it again and retry.');
    this.hooks.validate?.(bot, next);
    return next;
  }
  settle(generation: string, event: TerminalEvent) {
    const row = this.ledger.take(generation); if (!row) return;
    const verdict = settle_verdict(row, event, this.live(row.thread), row.origin);
    const candidates = new Map<string, BotRecord>();
    for (const [id, rev] of row.writes) {
      const bot = this.store.bot(id), pending = bot?.staged ?? bot?.pendingRevision;
      if (!bot || !pending || pending.generation !== generation) continue;
      const outcome = write_outcome(verdict, rev, pending.rev);
      if (outcome === 'active') {
        try { candidates.set(id, this.activate(bot)); continue; } catch { /* changed state needs review */ }
      }
      const next = structuredClone(bot), p = next.staged ?? next.pendingRevision!;
      p.reason = outcome === 'active' ? 'unsettled' : outcome; p.rev++;
      candidates.set(id, next);
    }
    if (this.conflicts(candidates)) for (const [id] of candidates) {
      const next = structuredClone(this.store.bot(id)!); const pending = next.staged ?? next.pendingRevision!;
      pending.reason = 'unsettled'; pending.rev++; candidates.set(id, next);
    }
    this.commit(candidates);
    this.hooks.settled?.(generation, verdict);
    return verdict;
  }
  apply(items: Array<{ id: string; digest: string }>, surface: string, renderer: string) {
    if (!items.length || new Set(items.map(i => i.id)).size !== items.length) return fail('Select each bot once.');
    const candidates = new Map<string, BotRecord>();
    for (const item of items) {
      const current = this.review(item.id);
      const [result] = decide({ kind: 'review', action: 'activate' }, { surface, seen: { renderer, digest: item.digest }, live_digest: current.digest });
      if (result === '403') return fail('Switch this bot on from the Murage computer or phone app.', 403);
      if (result !== 'activated') return fail('This changed since you opened it.');
      candidates.set(item.id, this.activate(this.store.bot(item.id)!));
    }
    if (this.conflicts(candidates)) return fail('This team changed. Read it again and retry.');
    this.commit(candidates);
  }
  hold(id: string, work: HeldBotWork) {
    const bot = this.store.bot(id); if (!bot?.staged) return false;
    const held = bot.staged.heldWork;
    if (work.ref && held.some(item => item.kind === work.kind && item.ref === work.ref && item.fromThreadId === work.fromThreadId)) return true;
    if (held.length >= 20 || held.reduce((n, w) => n + w.text.length, 0) + work.text.length > 20_000) return fail('This bot is waiting for your review, so it cannot take more work yet.');
    const next = structuredClone(bot); next.staged!.heldWork.push(structuredClone(work)); next.staged!.rev++;
    this.store.commitBotReview(new Map([[id, next]])); this.record(id); return true;
  }
}
