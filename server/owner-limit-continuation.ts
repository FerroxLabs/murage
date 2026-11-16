// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: nl-backup owns these private tickets and their backup dispatcher.
// Tickets never enter the decision claim/provenance system. They authorize
// exactly one source -> backup application, and cannot grant service access.
import { randomUUID } from 'node:crypto';
import { beginWrite, endWrite, undoWrite } from './write-tx.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { ModelSelection } from './contracts.ts';

export const OWNER_LIMIT_OBJECTS = {
  tables: ['owner_limit_epochs', 'owner_limit_applications', 'owner_limit_card_epochs', 'limit_failover_rows'],
  triggers: ['owner_limit_card_insert', 'owner_limit_card_queue'],
  indexes: ['owner_limit_pending_thread', 'messages_engine_limit_notice'],
} as const;
export function initializeOwnerLimitStorage(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS owner_limit_epochs(thread_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS owner_limit_applications(source_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, epoch INTEGER NOT NULL, state TEXT NOT NULL, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS owner_limit_pending_thread ON owner_limit_applications(thread_id,state);`);
  db.exec('CREATE TABLE IF NOT EXISTS owner_limit_card_epochs(approval_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, epoch INTEGER NOT NULL)');
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='approval_records'").get()) {
    const record = "INSERT OR IGNORE INTO owner_limit_card_epochs SELECT NEW.id,NEW.thread_id,COALESCE((SELECT epoch FROM owner_limit_epochs WHERE thread_id=NEW.thread_id),0);";
    db.exec(`CREATE TRIGGER IF NOT EXISTS owner_limit_card_insert AFTER INSERT ON approval_records WHEN NEW.service='event-limit' BEGIN ${record} END;
      CREATE TRIGGER IF NOT EXISTS owner_limit_card_queue AFTER UPDATE OF queue_kind ON approval_records WHEN NEW.queue_kind='event-limit' BEGIN ${record} END;`);
    // Upgrade only: an old open Ask card receives no live authority. Its
    // cancellation fence is installed once, before serving any owner action.
    db.exec("INSERT OR IGNORE INTO owner_limit_card_epochs SELECT id,thread_id,COALESCE((SELECT epoch FROM owner_limit_epochs WHERE thread_id=approval_records.thread_id),0) FROM approval_records WHERE state='open' AND service='event-limit'");
  }
  db.exec('CREATE TABLE IF NOT EXISTS limit_failover_rows(row_id TEXT PRIMARY KEY, send_id TEXT NOT NULL UNIQUE, value TEXT NOT NULL)');
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='messages'").get())
    db.exec("CREATE INDEX IF NOT EXISTS messages_engine_limit_notice ON messages(thread_id,kind,json_extract(json,'$.tool.name')) WHERE json_valid(json)");
}

export interface OwnerLimitSnapshot {
  botId: string; threadId: string; generation: string; sourceMessageId: string;
  sourceDigest: string; principal: string; policy: string; epoch: number; selection?: string;
}
export interface LimitApplication {
  sourceKey: string; rowId: string; sendId: string; snapshot: OwnerLimitSnapshot;
  to: ModelSelection; kind: 'automatic' | 'raised' | 'explicit'; approvalId?: string;
}
interface Ticket {
  snapshot: OwnerLimitSnapshot; phase: 'captured' | 'transferred' | 'selected' | 'claimed' | 'cancelled';
  provider?: string; source?: object; turnId?: string; application?: string;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export class OwnerLimitContinuations {
  private readonly tickets = new WeakMap<object, Ticket>();
  private readonly threads = new Map<string, Set<object>>();
  private readonly current: (snapshot: OwnerLimitSnapshot) => boolean;
  constructor(current: (snapshot: OwnerLimitSnapshot) => boolean) { this.current = current; }
  private mint(snapshot: OwnerLimitSnapshot, phase: Ticket['phase']): object {
    const ticket = Object.freeze({});
    this.tickets.set(ticket, { snapshot: structuredClone(snapshot), phase });
    let thread = this.threads.get(snapshot.threadId);
    if (!thread) this.threads.set(snapshot.threadId, thread = new Set());
    thread.add(ticket); return ticket;
  }
  capture(snapshot: OwnerLimitSnapshot, facts: { admitted: boolean; live: boolean; ownerTyped: boolean; ownerAudience: boolean; unlimited: boolean; firstHop: boolean }): object | undefined {
    if (facts.admitted !== true || facts.live !== true || facts.ownerTyped !== true || facts.ownerAudience !== true || facts.unlimited !== true || facts.firstHop !== true || !this.current(snapshot)) return;
    return this.mint(snapshot, 'captured');
  }
  bindProvider(ticket: object, provider: string, source: object): void {
    const t = this.tickets.get(ticket);
    if (!t || t.phase !== 'captured' || t.source || !this.current(t.snapshot)) return;
    t.provider = provider; t.source = source;
  }
  observeStarted(ticket: object, event: { threadId: string; providerInstanceId?: string; turnId?: string }, source: object | undefined): void {
    const t = this.tickets.get(ticket);
    if (t?.phase === 'captured' && !t.turnId && event.turnId && event.threadId === t.snapshot.threadId && event.providerInstanceId === t.provider && source === t.source && source) t.turnId = event.turnId;
  }
  transferAtLimit(ticket: object, event: { threadId: string; providerInstanceId?: string; turnId?: string }, source: object | undefined, genuineLimit: boolean): object | undefined {
    const t = this.tickets.get(ticket);
    if (!t || t.phase !== 'captured' || !genuineLimit || !event.turnId || event.turnId !== t.turnId || event.threadId !== t.snapshot.threadId || event.providerInstanceId !== t.provider || !source || source !== t.source || !this.current(t.snapshot)) return;
    t.phase = 'transferred'; return ticket;
  }
  authorizeRaisedCard(snapshot: OwnerLimitSnapshot, allowedOwnerAction: boolean): object | undefined {
    if (!allowedOwnerAction || !this.current(snapshot)) return;
    return this.mint(snapshot, 'transferred');
  }
  snapshot(ticket: object): OwnerLimitSnapshot | undefined { const t = this.tickets.get(ticket); return t && t.phase !== 'cancelled' ? structuredClone(t.snapshot) : undefined; }
  select(ticket: object, application: LimitApplication): boolean {
    const t = this.tickets.get(ticket);
    if (!t || t.phase !== 'transferred' || !same(t.snapshot, application.snapshot) || !this.current(t.snapshot)) return false;
    t.application = JSON.stringify(application); t.phase = 'selected'; return true;
  }
  validate(ticket: object, application: LimitApplication): boolean {
    const t = this.tickets.get(ticket);
    return Boolean(t && (t.phase === 'selected' || t.phase === 'claimed') && t.application === JSON.stringify(application) && this.current(t.snapshot));
  }
  claim(ticket: object, application: LimitApplication): boolean {
    const t = this.tickets.get(ticket);
    if (!t || t.phase !== 'selected' || !this.validate(ticket, application)) return false;
    t.phase = 'claimed'; return true;
  }
  cancel(threadId: string, generation?: string): void {
    const thread = this.threads.get(threadId);
    for (const ticket of thread ?? []) {
      const t = this.tickets.get(ticket)!;
      if (generation && t.snapshot.generation !== generation) continue;
      t.phase = 'cancelled'; thread!.delete(ticket);
    }
    if (!thread?.size) this.threads.delete(threadId);
  }
  retire(ticket: object): void {
    const t = this.tickets.get(ticket); if (!t) return;
    t.phase = 'cancelled';
    const thread = this.threads.get(t.snapshot.threadId); thread?.delete(ticket);
    if (!thread?.size) this.threads.delete(t.snapshot.threadId);
  }
}

/** Indexed canonical source application, shared by auto, raise and card answer.
 * A submitted/uncertain attempt is never made pending by retry or restart. */
export class LimitApplications {
  private initialized?: DatabaseSync;
  private readonly failedStops = new Set<string>();
  private readonly database: () => DatabaseSync;
  constructor(database: () => DatabaseSync) { this.database = database; }
  private db(): DatabaseSync {
    const db = this.database();
    if (db !== this.initialized) {
      initializeOwnerLimitStorage(db);
      this.initialized = db;
    }
    return db;
  }
  epoch(threadId: string): number { return Number((this.db().prepare('SELECT epoch FROM owner_limit_epochs WHERE thread_id=?').get(threadId) as { epoch: number } | undefined)?.epoch ?? 0); }
  get(threadId: string, sourceMessageId: string): LimitApplication | undefined {
    const row = this.db().prepare('SELECT value FROM owner_limit_applications WHERE source_key=?').get(`${threadId}:${sourceMessageId}`) as { value: string } | undefined;
    return row && JSON.parse(row.value);
  }
  cardCurrent(approvalId: string, threadId: string): boolean {
    if (this.failedStops.has(threadId)) return false;
    const row = this.db().prepare('SELECT epoch FROM owner_limit_card_epochs WHERE approval_id=? AND thread_id=?').get(approvalId, threadId) as { epoch: number } | undefined;
    return row !== undefined && row.epoch === this.epoch(threadId);
  }
  pending(threadId: string): LimitApplication[] {
    return (this.db().prepare("SELECT value FROM owner_limit_applications WHERE thread_id=? AND state='pending' AND epoch=?").all(threadId, this.epoch(threadId)) as { value: string }[]).map(row => JSON.parse(row.value));
  }
  prepare(snapshot: OwnerLimitSnapshot, to: ModelSelection, kind: LimitApplication['kind'], rowId: string = randomUUID(), approvalId?: string): LimitApplication {
    const db = this.db(), sourceKey = `${snapshot.threadId}:${snapshot.sourceMessageId}`;
    if (this.failedStops.has(snapshot.threadId) || this.epoch(snapshot.threadId) !== snapshot.epoch) throw new Error('backup-continuation-cancelled');
    const previous = db.prepare('SELECT state,value FROM owner_limit_applications WHERE source_key=?').get(sourceKey) as { state: string; value: string } | undefined;
    if (previous) {
      const app: LimitApplication = JSON.parse(previous.value);
      if (previous.state !== 'pending' || app.snapshot.epoch !== snapshot.epoch || !same(app.to, to) || app.snapshot.principal !== snapshot.principal || app.snapshot.sourceDigest !== snapshot.sourceDigest) throw new Error('backup-continuation-already-applied');
      // Fresh owner authority may reconcile the same unsubmitted source after
      // restart, preserving the row/send identity. It never revives a ticket.
      const refreshed = { ...app, snapshot: structuredClone(snapshot), kind };
      db.prepare("UPDATE owner_limit_applications SET value=? WHERE source_key=? AND state='pending'").run(JSON.stringify(refreshed), sourceKey);
      return refreshed;
    }
    const app: LimitApplication = { sourceKey, rowId, sendId: randomUUID().replaceAll('-', ''), snapshot: structuredClone(snapshot), to: structuredClone(to), kind, ...(approvalId ? { approvalId } : {}) };
    db.prepare("INSERT INTO owner_limit_applications VALUES(?,?,?,'pending',?)").run(sourceKey, snapshot.threadId, snapshot.epoch, JSON.stringify(app));
    return app;
  }
  current(app: LimitApplication): boolean {
    if (this.failedStops.has(app.snapshot.threadId) || this.epoch(app.snapshot.threadId) !== app.snapshot.epoch) return false;
    return Boolean(this.db().prepare("SELECT 1 FROM owner_limit_applications WHERE source_key=? AND state IN ('pending','submitted') AND value=?").get(app.sourceKey, JSON.stringify(app)));
  }
  claim(app: LimitApplication): boolean {
    if (this.failedStops.has(app.snapshot.threadId) || this.epoch(app.snapshot.threadId) !== app.snapshot.epoch) return false;
    return this.db().prepare("UPDATE owner_limit_applications SET state='submitted' WHERE source_key=? AND state='pending' AND value=?").run(app.sourceKey, JSON.stringify(app)).changes === 1;
  }
  cancel(threadId: string): void {
    this.failedStops.add(threadId);
    const db = this.db();
    beginWrite(db, 'owner_limit_stop');
    try {
      db.prepare('INSERT INTO owner_limit_epochs VALUES(?,1) ON CONFLICT(thread_id) DO UPDATE SET epoch=epoch+1').run(threadId);
      // Epochs fence every old application, including submitted attempts,
      // without rewriting the thread's completed history on each Stop.
      endWrite(db, 'owner_limit_stop');
      this.failedStops.delete(threadId);
    } catch (error) { undoWrite(db, 'owner_limit_stop'); throw error; }
  }
}
