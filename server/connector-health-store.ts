import { CONNECTOR_PROBE_INTERVAL_MS, PREFLIGHT_LOOKAHEAD_MS } from "../shared/connector-safe-reads.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
// Durable reconnect incidents. No credentials or upstream error bodies belong here.
import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const accountIncidentSchema = z.object({ incidentId: z.string(), at: z.number(), notifiedAt: z.number().optional() });
const markSchema = z.object({
  at: z.number(), cause: z.string().max(80), accountKey: z.string().nullable(),
  replaces: z.array(z.string()).optional(),
  accounts: z.array(z.object({ id: z.string(), alias: z.string().optional() })).optional(),
  accountIncidents: z.record(z.string(), accountIncidentSchema).optional(),
  incidentId: z.string(), notifiedAt: z.number().optional(),
});
export type AppHealthMark = z.infer<typeof markSchema>;
const routineLearningSchema = z.object({ owner: z.string(), revision: z.number(), slugs: z.array(z.string()) });
const schema = z.object({ v: z.literal(1), marks: z.record(z.string(), z.record(z.string(), markSchema)), cooldowns: z.record(z.string(), z.number()), revisions: z.record(z.string(), z.number()).default({}), probes: z.record(z.string(), z.number()).default({}), unverified: z.record(z.string(), z.number()).default({}), routineToolkits: z.record(z.string(), routineLearningSchema).default({}) });
export const RECONNECT_COOLDOWN_MS = 24 * 60 * 60_000;
type Change = { owner: string; slug: string; mark: AppHealthMark | null } | { cooldown: string; at: number } | { revision: string; at: number } | { probe: string; at: number } | { unverified: string; at: number | null } | { routine: string; learning: z.infer<typeof routineLearningSchema> | null } | { reset: true; owner?: string };

export class ConnectorHealthStore {
  private state: z.infer<typeof schema>;
  private changed = new Set<() => void>();
  onChange(listener: () => void) { this.changed.add(listener); return () => { this.changed.delete(listener); }; }
  private resolved = new Set<(mark: AppHealthMark) => void>();
  onResolved(listener: (mark: AppHealthMark) => void) { this.resolved.add(listener); return () => { this.resolved.delete(listener); }; }
  private pending = new Map<string, Change>();
  private depth = 0;
  private file: string;
  private now: () => number;
  constructor(file: string, now = Date.now) {
    this.file = file; this.now = now;
    this.state = existsSync(file) ? schema.parse(JSON.parse(readFileSync(file, "utf8"))) : this.empty();
    // A line is one committed check. A torn final append is ignored; completed
    // records are validated. The old snapshot remains readable during upgrade.
    if (existsSync(`${file}.journal`)) {
      const journal = readFileSync(`${file}.journal`, "utf8");
      const lines = journal.split("\n");
      if (lines.at(-1)) truncateSync(`${file}.journal`, Buffer.byteLength(journal.slice(0, journal.lastIndexOf("\n") + 1)));
      for (const line of lines.slice(0, -1)) if (line) for (const change of JSON.parse(line) as Change[]) this.apply(change);
      this.state = schema.parse(this.state);
    }
  }
  private empty(): z.infer<typeof schema> { return { v: 1, marks: {}, cooldowns: {}, revisions: {}, probes: {}, unverified: {}, routineToolkits: {} }; }
  private apply(change: Change) {
    if ("reset" in change) { if (change.owner) {
      delete this.state.marks[change.owner];
      for (const key of Object.keys(this.state.unverified)) if (JSON.parse(key)[0] === change.owner) delete this.state.unverified[key];
      for (const [key, record] of Object.entries(this.state.routineToolkits)) if (record.owner === change.owner) delete this.state.routineToolkits[key];
    } else this.state = this.empty(); }
    else if ("unverified" in change) {
      if (change.at === null) delete this.state.unverified[change.unverified]; else this.state.unverified[change.unverified] = change.at;
    }
    else if ("routine" in change) {
      if (change.learning === null) delete this.state.routineToolkits[change.routine]; else this.state.routineToolkits[change.routine] = change.learning;
    }
    else if ("probe" in change) this.state.probes[change.probe] = change.at;
    else if ("cooldown" in change) this.state.cooldowns[change.cooldown] = change.at;
    else if ("revision" in change) this.state.revisions[change.revision] = change.at;
    else if (change.mark) (this.state.marks[change.owner] ??= {})[change.slug] = change.mark;
    else delete this.state.marks[change.owner]?.[change.slug];
  }
  private queue(key: string, change: Change) { this.pending.set(key, change); if (!this.depth) this.save(); }
  private dirty(owner: string, slug: string) { this.queue(JSON.stringify([owner, slug]), { owner, slug, mark: this.get(owner, slug) ?? null }); }
  private save() {
    if (!this.pending.size) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    // Serialize changed records only, once per check. A one-account change does
    // not rewrite a thousand unrelated incidents or emit a thousand events.
    appendFileSync(`${this.file}.journal`, `${JSON.stringify([...this.pending.values()])}\n`, { mode: 0o600 });
    this.pending.clear();
    for (const listener of this.changed) { try { listener(); } catch { /* Status delivery never changes the incident. */ } }
  }
  batch<T>(work: () => T): T { this.depth++; try { return work(); } finally { if (!--this.depth) this.save(); } }
  mark(owner: string, slug: string, cause: string, accountKey: string | null): boolean {
    if (this.get(owner, slug)) return false;
    (this.state.marks[owner] ??= {})[slug] = { at: this.now(), cause, accountKey, incidentId: randomUUID() };
    this.dirty(owner, slug); return true;
  }
  get(owner: string, slug: string) { return this.state.marks[owner]?.[slug]; }
  slugs(owner: string) { return Object.keys(this.state.marks[owner] ?? {}).sort(); }
  update(owner: string, slug: string, patch: Partial<Omit<AppHealthMark, "at" | "cause">>) {
    const mark = this.get(owner, slug);
    if (!mark || (!(patch.accounts && !mark.accountIncidents) && Object.entries(patch).every(([key, value]) => JSON.stringify(mark[key as keyof AppHealthMark]) === JSON.stringify(value)))) return false;
    if (patch.accounts) {
      const previous = mark.accountIncidents ?? {};
      const next: NonNullable<AppHealthMark["accountIncidents"]> = {};
      for (const account of patch.accounts) {
        const legacyFirst = !mark.accountIncidents && !Object.keys(next).length;
        next[account.id] = previous[account.id] ?? (legacyFirst
          ? { incidentId: mark.incidentId, at: mark.at, ...(mark.notifiedAt !== undefined ? { notifiedAt: mark.notifiedAt } : {}) }
          : { incidentId: randomUUID(), at: this.now() });
      }
      for (const [id, incident] of Object.entries(previous)) if (!next[id]) this.resolve({ ...mark, ...incident, accounts: mark.accounts?.filter(a => a.id === id) });
      patch = { ...patch, accountIncidents: next };
    }
    Object.assign(mark, patch);
    this.dirty(owner, slug); return true;
  }
  private resolve(mark: AppHealthMark) { for (const listener of this.resolved) { try { listener(mark); } catch { /* Delivery cannot undo recovery. */ } } }
  clear(owner: string, slug: string) {
    const mark = this.get(owner, slug);
    if (!mark) return false;
    delete this.state.marks[owner]![slug]; this.dirty(owner, slug);
    const incidents = Object.values(mark.accountIncidents ?? {});
    if (incidents.length) for (const incident of incidents) this.resolve({ ...mark, ...incident });
    else this.resolve(mark);
    return true;
  }
  clearAll(owner?: string) { const change = { reset: true as const, ...(owner ? { owner } : {}) }; this.apply(change); this.queue(`reset:${owner ?? ""}`, change); }
  observeCredential(owner: string, slug: string, needsReconnect: boolean, revision: number, signedInAt?: number) {
    if (!Number.isFinite(revision) || revision <= (this.state.revisions[`${owner}:${slug}`] ?? -Infinity)) return;
    this.batch(() => {
      this.state.revisions[`${owner}:${slug}`] = revision;
      this.queue(`revision:${owner}:${slug}`, { revision: `${owner}:${slug}`, at: revision });
      if (needsReconnect) this.mark(owner, slug, "sign-in no longer accepted", String(revision));
      else if (signedInAt !== undefined && signedInAt > (this.get(owner, slug)?.at ?? Infinity)) this.clear(owner, slug);
    });
  }
  /** Reserve before dispatch; failed and timed-out attempts consume the same
   * hourly budget. The journal makes restart and token renewal respect it. */
  claimProbe(owner: string, slug: string, account: string, now: number): boolean {
    const probe = JSON.stringify([owner, slug, account]);
    if (now - (this.state.probes[probe] ?? -Infinity) < CONNECTOR_PROBE_INTERVAL_MS) return false;
    this.state.probes[probe] = now;
    this.queue(`probe:${probe}`, { probe, at: now });
    return true;
  }
  get unverified(): Readonly<Record<string, number>> { return this.state.unverified; }
  get routineToolkits(): Readonly<Record<string, z.infer<typeof routineLearningSchema>>> { return this.state.routineToolkits; }
  setUnverified(owner: string, slug: string, account: string) {
    const unverified = JSON.stringify([owner, slug, account]);
    if (this.state.unverified[unverified] !== undefined) return;
    const change = { unverified, at: this.now() }; this.apply(change); this.queue(`unverified:${unverified}`, change);
  }
  clearUnverified(owner: string, slug: string, account: string) {
    const unverified = JSON.stringify([owner, slug, account]);
    if (this.state.unverified[unverified] === undefined) return;
    const change = { unverified, at: null }; this.apply(change); this.queue(`unverified:${unverified}`, change);
  }
  learnRoutine(owner: string, routine: string, revision: number, slugs: readonly string[]) {
    const key = JSON.stringify([owner, routine]);
    const held = this.state.routineToolkits[key];
    const learning = { owner, revision, slugs: [...new Set([...(held?.revision === revision ? held.slugs : []), ...slugs])].sort() };
    if (JSON.stringify(learning) === JSON.stringify(held)) return;
    const change = { routine: key, learning }; this.apply(change); this.queue(`routine:${key}`, change);
  }
  /** Definition revision changes and deletion invalidate learning on the next
   * monitor/dispatch selection. Runs and nextRunAt changes do not edit it. */
  scheduledToolkits(owner: string, routines: readonly { id: string; updatedAt: number; enabled: boolean; nextRunAt: number | null }[], now: number): string[] {
    const slugs = new Set<string>();
    this.batch(() => {
      for (const [key, learning] of Object.entries(this.state.routineToolkits)) {
        if (learning.owner !== owner) continue;
        const id = JSON.parse(key)[1] as string;
        const routine = routines.find(routine => routine.id === id);
        if (!routine || routine.updatedAt !== learning.revision) {
          const change = { routine: key, learning: null }; this.apply(change); this.queue(`routine:${key}`, change); continue;
        }
        if (routine.enabled && routine.nextRunAt !== null && routine.nextRunAt - now <= PREFLIGHT_LOOKAHEAD_MS) for (const slug of learning.slugs) slugs.add(slug);
      }
    });
    return [...slugs].sort();
  }
  rekey(previous: string, next: string) {
    if (previous === next) return;
    this.batch(() => {
      for (const [slug, mark] of Object.entries(this.state.marks[previous] ?? {})) {
        (this.state.marks[next] ??= {})[slug] ??= mark;
        delete this.state.marks[previous]![slug]; this.dirty(previous, slug); this.dirty(next, slug);
      }
      for (const [key, at] of Object.entries(this.state.probes)) {
        const [owner, slug, account] = JSON.parse(key) as string[];
        if (owner !== previous) continue;
        const probe = JSON.stringify([next, slug, account]);
        const latest = Math.max(at, this.state.probes[probe] ?? -Infinity);
        this.state.probes[probe] = latest; this.queue(`probe:${probe}`, { probe, at: latest });
      }
      for (const [key, at] of Object.entries(this.state.unverified)) {
        const [owner, slug, account] = JSON.parse(key) as string[];
        if (owner !== previous) continue;
        const unverified = JSON.stringify([next, slug, account]);
        const change = { unverified, at }; this.apply(change); this.queue(`unverified:${unverified}`, change);
      }
      for (const [key, record] of Object.entries(this.state.routineToolkits)) {
        if (record.owner !== previous) continue;
        const routine = JSON.parse(key)[1] as string;
        this.learnRoutine(next, routine, record.revision, record.slugs);
        const change = { routine: key, learning: null }; this.apply(change); this.queue(`routine:${key}`, change);
      }
      for (const [key, at] of Object.entries(this.state.cooldowns)) if (key.startsWith(`${previous}:`)) {
        const cooldown = `${next}:${key.slice(previous.length + 1)}`;
        this.state.cooldowns[cooldown] = at; this.queue(`cooldown:${cooldown}`, { cooldown, at });
      }
    });
  }
  due(owner: string, slug: string, accountId?: string) {
    const mark = this.get(owner, slug);
    const incident = accountId ? mark?.accountIncidents?.[accountId] ?? mark : mark;
    const key = `${owner}:${slug}${accountId ? `:${accountId}` : ""}`;
    return !!incident && incident.notifiedAt === undefined && this.now() - (this.state.cooldowns[key] ?? -Infinity) >= RECONNECT_COOLDOWN_MS;
  }
  delivered(owner: string, slug: string, accountId?: string) {
    const mark = this.get(owner, slug); if (!mark) return;
    this.batch(() => {
      const at = this.now();
      const incident = accountId ? mark.accountIncidents?.[accountId] : mark;
      if (incident) incident.notifiedAt = at;
      const ids = accountId ? [accountId] : ["", ...Object.keys(mark.accountIncidents ?? {})];
      for (const id of ids) {
        if (id && mark.accountIncidents?.[id]) mark.accountIncidents[id]!.notifiedAt = at;
        const cooldown = `${owner}:${slug}${id ? `:${id}` : ""}`;
        this.state.cooldowns[cooldown] = at; this.queue(`cooldown:${cooldown}`, { cooldown, at });
      }
      this.dirty(owner, slug);
    });
  }
}
