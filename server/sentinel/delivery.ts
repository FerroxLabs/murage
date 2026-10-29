// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sentinel delivery: pages and the daily digest (1.0.9, GAP-SENTINEL-109 sections 8.2 to 8.4).
//
// ONE DELIVERY OWNER. The server that holds the installation's data-dir lease is the only delivery owner; its ledger is
// `<DATA_DIR>/sentinel-delivery.json` (owner-only, excluded from backup: data-dir-inventory.ts). It is separate from the
// scanner store (which this code only reads, through publication.readPageIntents) and from health/ (rebuildable metadata).
// Each server start is a new delivery-owner generation.
//
// LEDGER. Keyed by intent id. Each pass reads every page intent the scanner store holds (its 30-day retention and fixed
// ceiling bound the list; the lifecycle already limits them: S01/S02 only, one per episode, 24 h reopen cooldown, 3 per
// rolling 24 h) and adds the ones whose id is not in the ledger: `ready` while the issue episode is still open and the
// intent was made after the ledger was, `suppressed` otherwise (it stays in Health and the digest). No revision watermark: an intent is never skipped,
// however many arrive at once or however long the owner was away. States: ready -> attempted -> delivered | suppressed | uncertain.
// A claim persists `attempted` with the generation BEFORE anything is shown, keyed by installation + fingerprint +
// episode + generation (the deliveryId). A crash after the claim leaves `attempted`; the next start turns it into
// `uncertain` and never sends it again: bounded interruption over a duplicate page. The issue stays in Health and the
// digest. A ready page whose issue closes before it is claimed is suppressed. At claim time the ledger itself also keeps
// the 3-per-rolling-24 h cap and the 24 h per-issue cooldown from its own short list of recent claims (the last 24 h, at
// most RECENT_CLAIMS_MAX, kept apart from the entries), so pages held while the owner was away never arrive as a burst
// and a claim still counts after its intent leaves the store. The ledger records when it was made. A missing,
// unreadable, foreign or older-version ledger (after a restore, since it is backup-excluded, or corruption) is replaced
// by a new one: every intent the store already holds is older than it and is taken in as `suppressed`, so nothing is
// paged twice; only intents made after it are delivered. A fresh install still gets its first-scan pages, because the
// server makes its ledger before the scanner's first intents. Entries the store no longer holds are forgotten (they can
// never come back); at most as many entries as the store holds intents.
//
// PAGE PATH (the existing server -> desktop notification mechanism). deliverPages() runs only while an owner stream is
// connected (an unscoped SSE client: the desktop renderer or a Cloud owner session); otherwise intents wait as `ready` for
// the next authorized session. A claimed page goes through applyHealthPagePreferences (the failures category and quiet
// hours; generic lock-screen text always). Suppressed pages are acknowledged `suppressed`: they stay in Health, appear in
// the digest, and are never replayed. A shown page is broadcast as the ordinary `{kind:"notify"}` frame with the
// installation-scoped `health-page` variant (desktop audience only, sse-visibility.ts); the renderer shows one native
// notification with the generic text and opens Health. Acknowledged `delivered` when an owner stream received the frame.
//
// FOR THE DESKTOP HOST (electron, lane C2). No second channel: native pages already arrive through the notify frame. The
// claim API below (HealthDelivery.claimNextPage -> {deliveryId, installationId, titleKey, bodyKey, route}, and
// acknowledge(deliveryId, "delivered" | "suppressed")) is the single owner's interface; the server's own loop is its
// only caller. electron/sentinel-host.mjs keeps an injectable delivery adapter (claimNextPage/ack) that electron/main.mjs
// does not inject, so the host claims nothing (sentinel-host.node-test.mjs checks main.mjs). A host that ever needs to
// show pages without a renderer gets an owner-only route onto these two calls, replacing the renderer path, never a
// second ledger: a claim persists `attempted` before anything is shown, so one intent is claimed at most once.
//
// DIGEST. One in-app digest (an Inbox item), default 09:00 local: the host's zone on desktop and self-host, the persisted
// owner.timeZone on Cloud. At most one per local calendar date, and the slot must be at least 23 h after the previous
// digest's slot (a DST spring-forward day is 23 h long; a timezone change can never produce a second digest in a day).
// At most one per 24 h of actual publication too. Missed while offline: one accumulated digest at the next session,
// also when that session ends before 09:00, if the previous 09:00 passed after the ledger was made without a digest and
// there is something to say (it then counts as that day's digest). Days with nothing open, changed or newly resolved are
// skipped. Stable id `health-digest-<date>-<storeRevision>`, so re-rendering never duplicates it. Compact: <= 5 grouped
// rows (by title) ranked by impact then recency, the remaining count, one Recovered count.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HEALTH_TOKEN_PATTERN } from "../../shared/health-protocol.mjs";
import { HEALTH_PAGE_BODY_KEY, applyHealthPagePreferences, type HealthPageNotification } from "../../shared/notification-preferences.ts";
import { DIGEST_ROWS, severityRank, type HealthDigest, type HealthDigestRow, type SentinelView, type ViewRow } from "../../shared/sentinel-view.ts";
import { writeFileAtomic } from "../atomic.ts";
import { PAGE_CAP, PAGE_CAP_WINDOW_MS, PAGE_COOLDOWN_MS } from "./lifecycle.ts";
import type { PageIntent } from "./publication.ts";
import { INTENTS_MAX } from "./store.ts";

export const DELIVERY_FILE = "sentinel-delivery.json";
export const DELIVERY_FILE_MAX_BYTES = 512 * 1024;
/** As many entries as the scanner store can hold intents, so an entry for an intent the store still holds is never pruned
 * (and so never re-added and replayed). */
export const LEDGER_ENTRIES_MAX = INTENTS_MAX;
export const DIGEST_LOCAL_MINUTES = 9 * 60;
export const DIGEST_MIN_GAP_MS = 23 * 60 * 60_000;
/** At most one digest per 24 h of actual publication. */
export const DIGEST_PUBLISH_GAP_MS = 24 * 60 * 60_000;
/** Recent claims the ledger keeps for the cap and the cooldown: above PAGE_CAP, so the window is always fully counted. */
export const RECENT_CLAIMS_MAX = 8;
const CLAIM_WINDOW_MS = Math.max(PAGE_CAP_WINDOW_MS, PAGE_COOLDOWN_MS);

export type DeliveryState = "ready" | "attempted" | "delivered" | "suppressed" | "uncertain";

export interface LedgerEntry {
  intentId: string;
  fingerprint: string;
  episode: number;
  titleKey: string;
  createdAt: number;
  state: DeliveryState;
  /** Delivery-owner generation that claimed it, or null while ready. */
  generation: number | null;
  deliveryId: string | null;
  claimedAt: number | null;
  settledAt: number | null;
}

export interface DigestLedger {
  /** Local date of the last digest slot handled (sent or skipped as empty). */
  lastDate: string | null;
  lastSlotAt: number | null;
  /** When the last digest was made: the "since" point of the next one. */
  lastAt: number | null;
  current: HealthDigest | null;
}

/** A page claim that still counts toward the cap and the cooldown (one shown, or left uncertain). */
export interface RecentClaim { deliveryId: string; fingerprint: string; at: number }

export interface LedgerFile {
  version: 3;
  installationId: string;
  /** When this ledger was made: intents created before it are taken in as suppressed, never paged. */
  createdAt: number;
  generation: number;
  entries: LedgerEntry[];
  /** Claims of the last 24 h, at most RECENT_CLAIMS_MAX, independent of the entries. */
  claims: RecentClaim[];
  digest: DigestLedger;
}

export interface HealthPageClaim {
  deliveryId: string;
  installationId: string;
  titleKey: string;
  bodyKey: string;
  route: "health";
}

export type IntentReader = () => { ok: true; intents: PageIntent[] } | { ok: false; reason: string };

const STATES: readonly DeliveryState[] = ["ready", "attempted", "delivered", "suppressed", "uncertain"];
const HEX64 = /^[0-9a-f]{64}$/;
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isNullableInt = (value: unknown): value is number | null => value === null || isInt(value);
const DELIVERY_ID = /^[0-9a-f]{32}$/;

function validClaim(raw: unknown): raw is RecentClaim {
  const c = raw as Record<string, unknown>;
  return typeof c === "object" && c !== null && typeof c.deliveryId === "string" && DELIVERY_ID.test(c.deliveryId)
    && typeof c.fingerprint === "string" && HEX64.test(c.fingerprint) && isInt(c.at);
}

function validEntry(raw: unknown): raw is LedgerEntry {
  const e = raw as Record<string, unknown>;
  return typeof e === "object" && e !== null
    && typeof e.intentId === "string" && e.intentId.length > 0 && e.intentId.length <= 200
    && typeof e.fingerprint === "string" && HEX64.test(e.fingerprint)
    && isInt(e.episode) && typeof e.titleKey === "string" && e.titleKey.length <= 200 && isInt(e.createdAt)
    && STATES.includes(e.state as DeliveryState) && isNullableInt(e.generation)
    && (e.deliveryId === null || (typeof e.deliveryId === "string" && DELIVERY_ID.test(e.deliveryId)))
    && isNullableInt(e.claimedAt) && isNullableInt(e.settledAt);
}

/** Parses a ledger file body; null when anything is off (the caller starts an empty ledger). */
export function parseLedger(text: string, installationId: string): LedgerFile | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw?.version !== 3 || raw.installationId !== installationId || !isInt(raw.createdAt) || !isInt(raw.generation) || raw.generation < 0) return null;
    if (!Array.isArray(raw.entries) || raw.entries.length > LEDGER_ENTRIES_MAX || !raw.entries.every(validEntry)) return null;
    if (!Array.isArray(raw.claims) || raw.claims.length > RECENT_CLAIMS_MAX || !raw.claims.every(validClaim)) return null;
    const d = raw.digest as Record<string, unknown>;
    if (typeof d !== "object" || d === null || !(d.lastDate === null || (typeof d.lastDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.lastDate)))
      || !isNullableInt(d.lastSlotAt) || !isNullableInt(d.lastAt) || !(d.current === null || typeof d.current === "object")) return null;
    return raw as unknown as LedgerFile;
  } catch { return null; }
}

export const deliveryIdOf = (installationId: string, fingerprint: string, episode: number, generation: number): string =>
  createHash("sha256").update(JSON.stringify(["murage-sentinel-delivery", installationId, fingerprint, episode, generation])).digest("hex").slice(0, 32);

export interface HealthDeliveryOptions {
  dataDir: string;
  installationId: string;
  now?: () => number;
  /** The ledger file (default <dataDir>/sentinel-delivery.json). */
  file?: string;
  /** Persistence (tests inject a failing writer). */
  write?: (file: string, text: string) => void;
}

/** The single delivery owner's ledger. Every method is synchronous, bounded and never throws. */
export class HealthDelivery {
  private readonly file: string;
  private readonly now: () => number;
  private readonly write: (file: string, text: string) => void;
  private ledger: LedgerFile;
  private readonly options: HealthDeliveryOptions;

  constructor(options: HealthDeliveryOptions) {
    this.options = options;
    if (!HEALTH_TOKEN_PATTERN.test(options.installationId)) throw new Error("HEALTH_INSTALLATION_ID_INVALID");
    this.file = options.file ?? join(options.dataDir, DELIVERY_FILE);
    this.now = options.now ?? Date.now;
    this.write = options.write ?? ((file, text) => writeFileAtomic(file, text, { mode: 0o600 }));
    this.ledger = this.fresh(0);
  }

  private fresh(generation: number): LedgerFile {
    return { version: 3, installationId: this.options.installationId, createdAt: this.now(), generation, entries: [], claims: [],
      digest: { lastDate: null, lastSlotAt: null, lastAt: null, current: null } };
  }

  private read(): LedgerFile | null {
    try {
      const st = lstatSync(this.file);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > DELIVERY_FILE_MAX_BYTES) return null;
      return parseLedger(readFileSync(this.file, "utf8"), this.options.installationId);
    } catch { return null; }
  }

  private persist(): boolean {
    try { this.write(this.file, JSON.stringify(this.ledger)); return true; } catch { return false; }
  }

  /** Loads the ledger as a new delivery-owner generation. Claims left `attempted` by a previous generation become
   *  `uncertain` (never resent). A missing or unusable ledger is replaced by a new one made now. */
  start(): void {
    const loaded = this.read();
    this.ledger = loaded ?? this.fresh(0);
    this.ledger.generation += 1;
    const at = this.now();
    for (const entry of this.ledger.entries) if (entry.state === "attempted") { entry.state = "uncertain"; entry.settledAt = at; }
    this.persist();
  }

  get generation(): number { return this.ledger.generation; }
  entries(): readonly LedgerEntry[] { return this.ledger.entries; }
  counts(): Record<DeliveryState, number> {
    const counts = { ready: 0, attempted: 0, delivered: 0, suppressed: 0, uncertain: 0 };
    for (const entry of this.ledger.entries) counts[entry.state]++;
    return counts;
  }

  /** Takes the scanner store's page intents into the ledger by id: a new one is `ready` while its issue episode is open
   *  and it was made after the ledger, `suppressed` otherwise; a ready one whose issue closed is suppressed; settled entries the store no longer holds are
   *  forgotten. Answers how many entries were added. */
  sync(read: IntentReader): number {
    try {
      const result = read();
      if (!result.ok) return 0;
      const at = this.now();
      const ledger = this.ledger;
      const byId = new Map(ledger.entries.map(entry => [entry.intentId, entry]));
      const held = new Set<string>();
      let added = 0;
      let changed = false;
      for (const intent of result.intents) {
        if (!HEX64.test(intent.fingerprint)) continue;
        held.add(intent.id);
        const entry = byId.get(intent.id);
        if (entry) {
          if (entry.state === "ready" && !intent.open) { entry.state = "suppressed"; entry.settledAt = at; changed = true; }
          continue;
        }
        const deliverable = intent.open && intent.createdAt >= ledger.createdAt;
        const next: LedgerEntry = { intentId: intent.id, fingerprint: intent.fingerprint, episode: intent.episode, titleKey: intent.titleKey, createdAt: intent.createdAt,
          state: deliverable ? "ready" : "suppressed", generation: null, deliveryId: null, claimedAt: null, settledAt: deliverable ? null : at };
        ledger.entries.push(next);
        byId.set(intent.id, next);
        added++;
      }
      const kept = ledger.entries.filter(entry => held.has(entry.intentId) || entry.state === "attempted");
      if (kept.length !== ledger.entries.length) { ledger.entries = kept; changed = true; }
      if (added > 0) this.prune();
      if (added > 0 || changed) this.persist();
      return added;
    } catch { return 0; }
  }

  private prune(): void {
    const entries = this.ledger.entries;
    if (entries.length <= LEDGER_ENTRIES_MAX) return;
    const settled = entries.filter(e => e.state !== "ready" && e.state !== "attempted").sort((a, b) => (a.settledAt ?? a.createdAt) - (b.settledAt ?? b.createdAt));
    const drop = new Set(settled.slice(0, entries.length - LEDGER_ENTRIES_MAX));
    this.ledger.entries = entries.filter(e => !drop.has(e));
    // Unsettled entries above the cap (cannot happen under the scanner's 3-per-day cap) keep the newest.
    if (this.ledger.entries.length > LEDGER_ENTRIES_MAX) this.ledger.entries = this.ledger.entries.slice(-LEDGER_ENTRIES_MAX);
  }

  /** Claims the oldest ready page for this generation, persisting the claim before answering. At most PAGE_CAP claims in a
   *  rolling 24 h (a held page waits as ready); a ready page for an issue claimed in the last 24 h is suppressed (the
   *  cooldown). Both read the ledger's recent claims, not the entries. Null when none can be claimed or the claim could not
   *  be recorded (it then stays ready). */
  claimNextPage(): HealthPageClaim | null {
    const at = this.now();
    const recent = this.ledger.claims.filter(c => at - c.at < CLAIM_WINDOW_MS);
    if (recent.filter(c => at - c.at < PAGE_CAP_WINDOW_MS).length >= PAGE_CAP) return null;
    let cooled = false;
    let entry: LedgerEntry | undefined;
    for (const candidate of this.ledger.entries) {
      if (candidate.state !== "ready") continue;
      if (recent.some(c => c.fingerprint === candidate.fingerprint && at - c.at < PAGE_COOLDOWN_MS)) {
        candidate.state = "suppressed";
        candidate.settledAt = at;
        cooled = true;
        continue;
      }
      entry = candidate;
      break;
    }
    if (!entry) { if (cooled) this.persist(); return null; }
    const before = { ...entry };
    const claimsBefore = this.ledger.claims;
    entry.state = "attempted";
    entry.generation = this.ledger.generation;
    entry.deliveryId = deliveryIdOf(this.options.installationId, entry.fingerprint, entry.episode, this.ledger.generation);
    entry.claimedAt = at;
    this.ledger.claims = [...recent, { deliveryId: entry.deliveryId, fingerprint: entry.fingerprint, at }].slice(-RECENT_CLAIMS_MAX);
    if (!this.persist()) { Object.assign(entry, before); this.ledger.claims = claimsBefore; return null; }
    return { deliveryId: entry.deliveryId, installationId: this.options.installationId, titleKey: entry.titleKey, bodyKey: HEALTH_PAGE_BODY_KEY, route: "health" };
  }

  /** Settles a claim of this generation. False for an unknown id, another generation's claim or a settled entry. A page
   *  the preferences suppressed was never shown, so its claim stops counting toward the cap and the cooldown. */
  acknowledge(deliveryId: string, outcome: "delivered" | "suppressed" | "uncertain"): boolean {
    const entry = this.ledger.entries.find(e => e.deliveryId === deliveryId);
    if (!entry || entry.state !== "attempted" || entry.generation !== this.ledger.generation) return false;
    if (outcome === "suppressed") this.ledger.claims = this.ledger.claims.filter(c => c.deliveryId !== deliveryId);
    entry.state = outcome;
    entry.settledAt = this.now();
    this.persist();
    return true;
  }

  // ── digest ──────────────────────────────────────────────────────────────

  currentDigest(): HealthDigest | null { return this.ledger.digest.current; }

  /** Makes today's digest when it is due. Answers the new digest, or null (not due, inside 24 h of the last one, nothing
   *  to say, or no view). A morning catch-up with nothing to say leaves the day to its own 09:00. */
  maybeDigest(view: SentinelView | null, timeZone: string): HealthDigest | null {
    try {
      const now = this.now();
      const d = this.ledger.digest;
      const due = digestDue(now, timeZone, d.lastDate !== null && d.lastSlotAt !== null ? { date: d.lastDate, slotAt: d.lastSlotAt } : null, this.ledger.createdAt);
      if (!due || !view || (d.lastAt !== null && now - d.lastAt < DIGEST_PUBLISH_GAP_MS)) return null;
      const digest = buildDigest(view, d.lastAt, due.date, now);
      if (!digest && due.catchUp) return null;
      d.lastDate = due.date;
      d.lastSlotAt = due.slotAt;
      if (digest) { d.current = digest; d.lastAt = now; }
      this.persist();
      return digest;
    } catch { return null; }
  }
}

// ── page loop ─────────────────────────────────────────────────────────────

export interface PageDeliveryDeps {
  /** cfg.notifications, read live. */
  prefs: () => unknown;
  now: () => Date;
  /** An owner stream is connected (desktop renderer or Cloud owner session). */
  ownerSessionPresent: () => boolean;
  /** Puts the frame on the existing notify path; true when an owner stream received it. */
  send: (notification: HealthPageNotification) => boolean;
}

/** Claims and shows ready pages (at most 3 per call, the scanner's own daily cap). Never throws. */
export function deliverPages(delivery: HealthDelivery, deps: PageDeliveryDeps): { delivered: number; suppressed: number; uncertain: number } {
  const out = { delivered: 0, suppressed: 0, uncertain: 0 };
  try {
    if (!deps.ownerSessionPresent()) return out;
    for (let i = 0; i < 3; i++) {
      const claim = delivery.claimNextPage();
      if (!claim) break;
      const shown = applyHealthPagePreferences({ kind: "health-page", ...claim }, deps.prefs(), deps.now());
      if (!shown) { delivery.acknowledge(claim.deliveryId, "suppressed"); out.suppressed++; continue; }
      let sent = false;
      try { sent = deps.send(shown); } catch { sent = false; }
      delivery.acknowledge(claim.deliveryId, sent ? "delivered" : "uncertain");
      if (sent) out.delivered++; else out.uncertain++;
    }
  } catch { /* delivery never throws into the server */ }
  return out;
}

// ── digest timing (pure) ──────────────────────────────────────────────────

function wallParts(at: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const values: Record<string, number> = {};
  for (const part of format.formatToParts(at)) if (part.type !== "literal") values[part.type] = Number(part.value);
  return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute!, second: values.second! };
}
/** The wall clock at `at` in `timeZone`, as if it were UTC (ms). */
const wallAsUtc = (at: number, timeZone: string) => { const p = wallParts(at, timeZone); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second); };
const pad = (n: number) => String(n).padStart(2, "0");

/** The local calendar date (YYYY-MM-DD) at `at`. */
export function localDate(at: number, timeZone: string): string {
  const p = wallParts(at, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The instant of `minutes` after local midnight on `date` in `timeZone`. A skipped wall time (DST gap) resolves to the
 *  first instant after it; a repeated one (fold) to its first occurrence. */
export function localSlot(date: string, minutes: number, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const requested = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const exact: number[] = [];
  const any: number[] = [];
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = requested + hours * 3_600_000;
    const candidate = requested - (wallAsUtc(sample, timeZone) - sample);
    any.push(candidate);
    if (wallAsUtc(candidate, timeZone) === requested) exact.push(candidate);
  }
  return exact.length ? Math.min(...exact) : Math.max(...any);
}

/** Whether a digest is due at `now`: past today's 09:00 local slot, on a later local date than the last one, and at
 *  least 23 h after the last slot. Before today's slot, yesterday's 09:00 that passed after `createdAt` (the ledger's
 *  creation) with no digest is caught up at once and counts as today's digest (its slot is the missed one; `catchUp`).
 *  Answers today's date and the slot, or null. */
export function digestDue(now: number, timeZone: string, last: { date: string; slotAt: number } | null, createdAt: number): { date: string; slotAt: number; catchUp: boolean } | null {
  const date = localDate(now, timeZone);
  let slotAt = localSlot(date, DIGEST_LOCAL_MINUTES, timeZone);
  const catchUp = now < slotAt;
  if (catchUp) {
    const yesterday = localDate(localSlot(date, 0, timeZone) - 1, timeZone);
    if (last && last.date >= yesterday) return null;
    slotAt = localSlot(yesterday, DIGEST_LOCAL_MINUTES, timeZone);
    if (slotAt <= createdAt) return null;
  }
  if (last && (last.date >= date || slotAt - last.slotAt < DIGEST_MIN_GAP_MS)) return null;
  return { date, slotAt, catchUp };
}

/** The compact digest from the published view, or null when nothing is open, changed or newly resolved since `sinceAt`. */
export function buildDigest(view: SentinelView, sinceAt: number | null, date: string, now: number): HealthDigest | null {
  const since = sinceAt ?? Number.NEGATIVE_INFINITY;
  const unresolved = view.rows.filter(row => row.state !== "resolved");
  const recoveredCount = view.rows.filter(row => row.resolution === "observed-recovery" && (row.resolvedAt ?? 0) > since).length;
  const changed = view.rows.some(row => row.lastSeenAt > since || (row.resolvedAt ?? Number.NEGATIVE_INFINITY) > since);
  if (unresolved.length === 0 && view.summary.openCount === 0 && !changed && recoveredCount === 0) return null;
  const groups = new Map<string, HealthDigestRow>();
  for (const row of unresolved) groupInto(groups, row);
  const ranked = [...groups.values()].sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.lastSeenAt - a.lastSeenAt || a.titleKey.localeCompare(b.titleKey));
  const rows = ranked.slice(0, DIGEST_ROWS);
  const shown = rows.reduce((sum, row) => sum + row.issues, 0);
  return { id: `health-digest-${date}-${view.storeRevision}`, date, storeRevision: view.storeRevision, createdAt: now, rows,
    moreCount: Math.max(0, view.summary.openCount - shown), recoveredCount };
}

function groupInto(groups: Map<string, HealthDigestRow>, row: ViewRow): void {
  const current = groups.get(row.titleKey);
  if (!current) {
    groups.set(row.titleKey, { titleKey: row.titleKey, severity: row.severity, issues: 1, count: row.count, firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt });
    return;
  }
  current.issues++;
  current.count += row.count;
  if (severityRank(row.severity) > severityRank(current.severity)) current.severity = row.severity;
  current.firstSeenAt = Math.min(current.firstSeenAt, row.firstSeenAt);
  current.lastSeenAt = Math.max(current.lastSeenAt, row.lastSeenAt);
}
