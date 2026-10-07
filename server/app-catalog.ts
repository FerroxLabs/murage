// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The connected-apps catalog: 1,500+ apps, not the curated 24.
//
// Until 0.1.61 the panel walked the whole catalog on every open, inside one
// 15-second budget, and when anything went wrong on the way (a slow page, a
// broker 502, the backend identity changing mid-walk, no backend at all) it
// quietly showed the curated 24 with no log line and no notice. The owner saw
// "a handful" of apps and six of his thirteen real connections disappeared
// from the Connected tab (CONNECTED-APPS-CATALOG.md, 2026-09-27).
//
// This module holds the catalog instead:
//   - every fallback carries a reason, is logged, and the panel offers Retry;
//   - the last complete catalog is kept on disk (connected-apps-catalog.json,
//     excluded RUNTIME in data-dir-inventory.ts) and served at once, stale
//     while it revalidates, so first paint never waits on the network;
//   - a broker that speaks catalog contract 2 (0161 lanes/apps
//     BROKER-CONTRACT.md) answers search and paging itself; today's broker,
//     which only passes the vendor's raw pages through, still works: the
//     whole list is walked once in the background and searched here.
//
// Nothing in here decides WHICH backend is used. server/composio.ts owns that
// and hands this module a CatalogBackend, so the own-key-wins rule stays in
// one place and this module never sees a credential.
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export type SignIn = "managed" | "own" | "none";

/** One app as the panel and the connect card need it. Slim on purpose. */
export interface CatalogApp {
  slug: string;
  label: string;
  /** at most 90 characters, never naming the connection service */
  blurb: string;
  logo: string | null;
  /** used for the client-side favicon fallback when logo is null/broken */
  domain: string | null;
  /** Toolkits such as public search need no user authorization. */
  noAuth?: boolean;
  /** managed: a hosted sign-in exists; own: the person brings their own
   * sign-in details; none: nothing to sign in to; absent: not reported */
  signIn?: SignIn;
}

/** Why the panel is showing featured apps instead of the whole catalog. */
export type CatalogFallbackReason =
  | "no-backend" | "timeout" | "network" | "http" | "auth" | "rate-limited"
  | "bad-response" | "incomplete" | "identity" | "cancelled" | "loading";

export interface CatalogBackend {
  kind: "broker" | "project";
  /** the credential fingerprint this backend was resolved under (hashed) */
  identity: string;
  /** stable across token re-mints: which catalog this is (hashed) */
  cacheKey: string;
  /** the identity composio.ts would resolve right now */
  current(): string | null;
  /** GET the catalog with contract query names: limit, cursor, sort, search */
  request(query: URLSearchParams, signal: AbortSignal): Promise<Response>;
}

// Curated fallback, the services agentcal's connectors page ships. Logos
// resolve client-side: logo → favicon(domain) → monogram.
export const CURATED: ReadonlyArray<CatalogApp> = Object.freeze([
  { slug: "slack", label: "Slack", blurb: "Post updates and read channels", domain: "slack.com", logo: null },
  { slug: "github", label: "GitHub", blurb: "Issues, pull requests, and code", domain: "github.com", logo: null },
  { slug: "gmail", label: "Gmail", blurb: "Read and send email", domain: "gmail.com", logo: null },
  { slug: "googlecalendar", label: "Google Calendar", blurb: "Read and create events", domain: "calendar.google.com", logo: null },
  { slug: "googlesheets", label: "Google Sheets", blurb: "Read and update spreadsheets", domain: "sheets.google.com", logo: null },
  { slug: "googledocs", label: "Google Docs", blurb: "Read and write documents", domain: "docs.google.com", logo: null },
  { slug: "googledrive", label: "Google Drive", blurb: "Browse and manage files", domain: "drive.google.com", logo: null },
  { slug: "notion", label: "Notion", blurb: "Pages and databases", domain: "notion.so", logo: null },
  { slug: "linear", label: "Linear", blurb: "Issues and project tracking", domain: "linear.app", logo: null },
  { slug: "sentry", label: "Sentry", blurb: "Errors and alerts", domain: "sentry.io", logo: null },
  { slug: "posthog", label: "PostHog", blurb: "Analytics, feature flags, experiments", domain: "posthog.com", logo: null },
  { slug: "discord", label: "Discord", blurb: "Messages and channels", domain: "discord.com", logo: null },
  { slug: "x", label: "X (Twitter)", blurb: "Post and read on X", domain: "x.com", logo: null },
  { slug: "reddit", label: "Reddit", blurb: "Browse and post", domain: "reddit.com", logo: null },
  { slug: "zapier", label: "Zapier", blurb: "Connect 9,000+ apps", domain: "zapier.com", logo: null },
  { slug: "hubspot", label: "HubSpot", blurb: "CRM search & updates", domain: "hubspot.com", logo: null },
  { slug: "salesforce", label: "Salesforce", blurb: "CRM records and reports", domain: "salesforce.com", logo: null },
  { slug: "jira", label: "Jira", blurb: "Issues and sprints", domain: "atlassian.com", logo: null },
  { slug: "asana", label: "Asana", blurb: "Tasks and projects", domain: "asana.com", logo: null },
  { slug: "trello", label: "Trello", blurb: "Boards and cards", domain: "trello.com", logo: null },
  { slug: "dropbox", label: "Dropbox", blurb: "Files and folders", domain: "dropbox.com", logo: null },
  { slug: "airtable", label: "Airtable", blurb: "Bases and records", domain: "airtable.com", logo: null },
  { slug: "figma", label: "Figma", blurb: "Files and comments", domain: "figma.com", logo: null },
  { slug: "stripe", label: "Stripe", blurb: "Payments and customers", domain: "stripe.com", logo: null },
].map((card) => Object.freeze(card)));

export const CURATED_SLUGS = CURATED.map((card) => card.slug);

export const APP_CATALOG_CACHE_FILE = "connected-apps-catalog.json";
const CACHE_VERSION = 1;
/** A complete catalog younger than this is served without asking again. */
export const CATALOG_FRESH_MS = 6 * 60 * 60_000;
/** One budget for a whole walk of the vendor's raw pages (today's broker and
 * an own key). It runs in the background; first paint never waits on it. */
const WALK_BUDGET_MS = 45_000;
const WALK_PAGE = 500;
const MAX_WALK_PAGES = 40;
const MAX_APPS = 20_000;
/** How many of the most used apps join the curated set on first paint. */
export const FEATURED_TOP = 24;
const SERVICE_TIMEOUT_MS = 6_000;
const STALE_RETRY_MS = 15 * 60_000;
/** After a failed refresh, how long a stale copy is served with the failure
 * instead of starting another walk on every open. */
const FAILURE_HOLD_MS = 60_000;
/** How long a connect card waits for a first walk on a broker that cannot
 * look one app up. */
const CARD_WAIT_MS = 10_000;
export const MAX_PAGE = 200;
export const MAX_SEARCH = 50;

// The connection service's own toolkits (its search, its helpers) are
// plumbing, not apps, and product copy never names the service.
const SERVICE_NAME = /composio/i;
const SLUG = /^[a-z0-9_][a-z0-9_.-]{0,80}$/;
// An app's own description is shown as Murage's copy, so it obeys the same
// rules: a description that talks about safety or price is left out rather
// than rewritten (em dashes are turned into commas above).
const OFF_COPY = /\b(?:un)?saf(?:e|ely|ety)\b|\bpric(?:e|es|ing)\b/i;
const CURSOR = /^[A-Za-z0-9+/_=-]{1,256}$/;

/** The vendor's raw toolkit or a contract-2 slim item, as one CatalogApp. */
export function slimApp(raw: unknown): CatalogApp | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown> & { meta?: Record<string, unknown> };
  const meta = t.meta && typeof t.meta === "object" ? t.meta : {};
  const slug = String(t.slug ?? t.key ?? t.name ?? "").trim().toLowerCase();
  if (!SLUG.test(slug)) return null;
  const label = String(t.name ?? t.label ?? t.slug ?? "").replace(/\s+/g, " ").replace(/\s*—\s*/g, " - ").trim().slice(0, 80) || slug;
  // the connection service's own toolkit is plumbing, not an app
  if (SERVICE_NAME.test(slug) || SERVICE_NAME.test(label)) return null;
  const rawBlurb = String(t.blurb ?? meta.description ?? t.description ?? "").replace(/\s+/g, " ").trim().replace(/\s*—\s*/g, ", ");
  const rawLogo = t.logo ?? meta.logo;
  const noAuth = t.no_auth === true || t.noAuth === true;
  let signIn: SignIn | undefined;
  if (noAuth) signIn = "none";
  else if (typeof t.managed_sign_in === "boolean") signIn = t.managed_sign_in ? "managed" : "own";
  else if (t.signIn === "managed" || t.signIn === "own" || t.signIn === "none") signIn = t.signIn;
  else if (Array.isArray(t.composio_managed_auth_schemes)) signIn = t.composio_managed_auth_schemes.length ? "managed" : "own";
  return {
    slug,
    label,
    // product copy never names the connection service, even in an app's
    // own description
    blurb: SERVICE_NAME.test(rawBlurb) || OFF_COPY.test(rawBlurb) ? "" : rawBlurb.slice(0, 90),
    logo: typeof rawLogo === "string" && /^https:\/\/[^\s"'<>]{1,500}$/i.test(rawLogo) ? rawLogo : null,
    noAuth,
    domain: typeof t.domain === "string" && /^[a-z0-9.-]{1,120}$/i.test(t.domain) ? t.domain : null,
    ...(signIn ? { signIn } : {}),
  };
}

/** A card for a slug nobody described: the panel's monogram fallback. */
export function monogramApp(slug: string): CatalogApp {
  const normalized = slug.trim().toLowerCase();
  return {
    slug: normalized,
    label: normalized.replace(/[-_.]+/g, " ").trim().replace(/\b\w/g, (letter) => letter.toUpperCase()) || normalized,
    blurb: "",
    logo: null,
    domain: null,
  };
}

// ── the snapshot: memory first, then disk ─────────────────────────────

interface Snapshot {
  cacheKey: string;
  identity: string;
  savedAt: number;
  /** 2 when the broker speaks catalog contract 2 */
  contract: 1 | 2;
  /** the service's own count; null when it never said */
  total: number | null;
  /** usage order, as the service ranked it */
  apps: CatalogApp[];
  /** the broker said this list is its previous one (contract 2 `stale`) */
  upstreamStale?: boolean;
}

const memory = new Map<string, Snapshot>();
/** Which contract each catalog answered with last, even before a whole
 * snapshot exists, so search knows where to go. */
const contracts = new Map<string, { value: 1 | 2; at: number }>();
/** A "this broker is old" answer is trusted for this long, then asked again,
 * so one odd answer cannot switch service search off for hours. */
const LEGACY_LATCH_MS = 30 * 60_000;
function contractOf(cacheKey: string): 1 | 2 | undefined {
  const known = contracts.get(cacheKey);
  if (!known) return undefined;
  if (known.value === 1 && Date.now() - known.at > LEGACY_LATCH_MS) return undefined;
  return known.value;
}
function noteContract(cacheKey: string, value: 1 | 2) {
  contracts.set(cacheKey, { value, at: Date.now() });
}
let byName: { snapshot: Snapshot; apps: CatalogApp[] } | null = null;

function cachePath() {
  return join(DATA_DIR, APP_CATALOG_CACHE_FILE);
}

/** The file's modification time when it last held nothing for a key, so a
 * miss is not re-read and re-parsed on every keystroke. */
const diskMisses = new Map<string, number>();
function readDisk(cacheKey: string): Snapshot | null {
  let mtime = -1;
  try {
    mtime = statSync(cachePath()).mtimeMs;
  } catch {
    return null;
  }
  if (diskMisses.get(cacheKey) === mtime) return null;
  const found = parseDisk(cacheKey);
  if (found) diskMisses.delete(cacheKey);
  else diskMisses.set(cacheKey, mtime);
  return found;
}

function parseDisk(cacheKey: string): Snapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), "utf8")) as Record<string, unknown>;
    if (parsed.v !== CACHE_VERSION || parsed.cacheKey !== cacheKey || !Array.isArray(parsed.apps)) return null;
    if (typeof parsed.savedAt !== "number" || typeof parsed.identity !== "string") return null;
    const apps = parsed.apps.slice(0, MAX_APPS).map(slimApp).filter((app): app is CatalogApp => app !== null);
    if (!apps.length) return null;
    const total = typeof parsed.total === "number" && Number.isSafeInteger(parsed.total) && parsed.total > 0 ? parsed.total : null;
    return { cacheKey, identity: parsed.identity, savedAt: parsed.savedAt, contract: parsed.contract === 2 ? 2 : 1, total, apps, ...(parsed.upstreamStale === true ? { upstreamStale: true } : {}) };
  } catch {
    // A cache we cannot read is the same as no cache.
    return null;
  }
}

function writeDisk(snapshot: Snapshot) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomic(cachePath(), JSON.stringify({ v: CACHE_VERSION, ...snapshot }));
  } catch (error) {
    console.warn(`[connectors] app catalog cache not saved: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function snapshotFor(cacheKey: string): Snapshot | null {
  const held = memory.get(cacheKey);
  if (held) return held;
  const disk = readDisk(cacheKey);
  if (disk) {
    memory.set(cacheKey, disk);
    noteContract(cacheKey, disk.contract);
  }
  return disk;
}

function commit(snapshot: Snapshot) {
  memory.delete(snapshot.cacheKey);
  memory.set(snapshot.cacheKey, snapshot);
  while (memory.size > 4) memory.delete(memory.keys().next().value!);
  noteContract(snapshot.cacheKey, snapshot.contract);
  writeDisk(snapshot);
}

/** For tests: forget the memory copy (and the disk copy when asked). */
export function resetAppCatalogState(options: { disk?: boolean } = {}) {
  memory.clear();
  contracts.clear();
  diskMisses.clear();
  generations.clear();
  byName = null;
  refreshes.clear();
  failures.clear();
  generation = 0;
  if (options.disk) {
    try {
      writeFileAtomic(cachePath(), "{}");
    } catch {
      // nothing written yet
    }
  }
}

// ── walking the whole catalog ─────────────────────────────────────────

type WalkOk = { ok: true; snapshot: Snapshot };
type WalkFailed = { ok: false; reason: CatalogFallbackReason; loaded: number; total: number | null; status?: number };
type WalkResult = WalkOk | WalkFailed;

function httpReason(status: number): CatalogFallbackReason {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limited";
  return "http";
}

/** Page through the whole catalog. Contract 2 and the vendor's raw pages
 * share one walker: both carry items, next_cursor and total_items. The raw
 * pages may also carry current_page/total_pages, which catch a walk that
 * ends "cleanly" on page 1 of 4 or replays one page behind fresh cursors
 * (upstream #1615). A partial catalog is never committed. */
async function walk(backend: CatalogBackend, signal: AbortSignal): Promise<WalkResult> {
  const bySlug = new Map<string, CatalogApp>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let records = 0;
  let contract: 1 | 2 = 1;
  let lastPage: number | undefined;
  let totalPages: number | undefined;
  let totalItems: number | null = null;
  let catalogTotal: number | null = null;
  let upstreamStale = false;
  const failed = (reason: CatalogFallbackReason, status?: number): WalkFailed =>
    ({ ok: false, reason, loaded: bySlug.size, total: totalItems, ...(status ? { status } : {}) });
  for (let page = 0; page < MAX_WALK_PAGES && records < MAX_APPS; page += 1) {
    if (signal.aborted) return failed(signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled");
    if (backend.current() !== backend.identity) return failed("identity");
    let json: Record<string, unknown>;
    try {
      const query = new URLSearchParams({ limit: String(WALK_PAGE), sort: "usage" });
      if (cursor) query.set("cursor", cursor);
      const response = await backend.request(query, signal);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return failed(httpReason(response.status), response.status);
      }
      json = await response.json() as Record<string, unknown>;
    } catch {
      if (signal.aborted) return failed(signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled");
      return failed(page === 0 ? "network" : "incomplete");
    }
    if (signal.aborted) return failed(signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled");
    if (backend.current() !== backend.identity) return failed("identity");
    if (!json || typeof json !== "object") return failed("bad-response");
    if (json.contract === 2) contract = 2;
    if (json.stale === true) upstreamStale = true;
    const items = json.items ?? json.data;
    if (!Array.isArray(items)) return failed("bad-response");
    const bounded = items.slice(0, MAX_APPS - records);
    records += bounded.length;
    for (const raw of bounded) {
      const app = slimApp(raw);
      if (app && !bySlug.has(app.slug)) bySlug.set(app.slug, app);
    }
    const total = Number(json.total_items);
    if (Number.isSafeInteger(total) && total > 0) totalItems = total;
    const whole = Number(json.catalog_total);
    if (Number.isSafeInteger(whole) && whole > 0) catalogTotal = whole;
    const pages = Number(json.total_pages);
    if (Number.isSafeInteger(pages) && pages > 0) totalPages = pages;
    const reported = Number(json.current_page);
    if (json.current_page !== undefined && Number.isSafeInteger(reported)) {
      // A page that does not advance is a replay behind a fresh cursor.
      if (lastPage !== undefined && reported <= lastPage) return failed("incomplete");
      lastPage = reported;
    }
    const next = typeof json.next_cursor === "string" ? json.next_cursor.trim() : "";
    const onLastPage = lastPage !== undefined && totalPages !== undefined && lastPage >= totalPages;
    if (!next || onLastPage) {
      const pagesShort = lastPage !== undefined && totalPages !== undefined && lastPage < totalPages;
      // Raw records, not unique cards: a catalog that lists one app twice is
      // complete, and failing closed on it would empty the page.
      const itemsShort = totalItems !== null && records < totalItems;
      if (bounded.length !== items.length || pagesShort || itemsShort) return failed("incomplete");
      if (!bySlug.size) return failed("bad-response");
      return {
        ok: true,
        snapshot: {
          cacheKey: backend.cacheKey,
          identity: backend.identity,
          // A broker serving its previous list because a rebuild failed: keep
          // it, but ask again in a quarter of an hour, not in six hours.
          savedAt: upstreamStale ? Date.now() - CATALOG_FRESH_MS + STALE_RETRY_MS : Date.now(),
          ...(upstreamStale ? { upstreamStale: true } : {}),
          contract,
          // The service's own count under contract 2. A raw walk counts the
          // apps it kept: the raw total includes the service's own plumbing.
          total: contract === 2 ? catalogTotal ?? totalItems ?? bySlug.size : bySlug.size,
          apps: [...bySlug.values()],
        },
      };
    }
    if (!CURSOR.test(next) || seenCursors.has(next)) return failed("incomplete");
    seenCursors.add(next);
    cursor = next;
  }
  return failed("incomplete");
}

function logFallback(reason: CatalogFallbackReason, detail = "") {
  // Counts and the reason only, never upstream text. Every fallback says why,
  // in the log as well as on screen (the old silent paths wrote nothing).
  console.warn(`[connectors] app catalog: showing featured apps (${reason})${detail}`);
}

function describeFailure(result: WalkFailed): string {
  const loaded = result.loaded.toLocaleString("en-US");
  const of = result.total !== null && result.total > result.loaded ? ` of ${result.total.toLocaleString("en-US")}` : "";
  const status = result.status ? `, HTTP ${result.status}` : "";
  return ` after ${loaded}${of} apps${status}`;
}

const refreshes = new Map<string, { identity: string; promise: Promise<WalkResult> }>();
/** The last refresh that failed, per catalog, until one succeeds. */
const failures = new Map<string, { reason: CatalogFallbackReason; detail: CatalogFallbackDetail; at: number }>();
let generation = 0;
const generations = new Map<string, number>();

/** One walk per catalog at a time. A late walk from an older request never
 * replaces a newer one's result (the backend may have changed meanwhile). */
function refresh(backend: CatalogBackend, signal?: AbortSignal): Promise<WalkResult> {
  const running = refreshes.get(backend.cacheKey);
  if (running && running.identity === backend.identity && !signal) return running.promise;
  const mine = ++generation;
  generations.set(backend.cacheKey, mine);
  const deadline = AbortSignal.timeout(WALK_BUDGET_MS);
  const walkSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const promise = walk(backend, walkSignal).then((result) => {
    if (result.ok) {
      failures.delete(backend.cacheKey);
      if (generations.get(backend.cacheKey) === mine && backend.current() === backend.identity) commit(result.snapshot);
    } else {
      if (result.reason !== "cancelled") failures.set(backend.cacheKey, { reason: result.reason, detail: { loaded: result.loaded, total: result.total }, at: Date.now() });
      logFallback(result.reason, describeFailure(result));
    }
    return result;
  }).finally(() => {
    if (refreshes.get(backend.cacheKey)?.promise === promise) refreshes.delete(backend.cacheKey);
  });
  if (!signal) refreshes.set(backend.cacheKey, { identity: backend.identity, promise });
  return promise;
}

// ── what the routes serve ─────────────────────────────────────────────

export interface CatalogFallbackDetail {
  loaded: number;
  total: number | null;
}

export interface CatalogView {
  /** api: a complete catalog; cache: the last complete one, being checked
   * again; curated: the featured 24 only, with `reason` saying why */
  source: "api" | "cache" | "curated";
  reason?: CatalogFallbackReason;
  detail?: CatalogFallbackDetail;
  /** every card held (the whole catalog, or the curated 24) */
  cards: CatalogApp[];
  /** the curated apps plus the most used ones: what first paint shows */
  featured: CatalogApp[];
  /** the whole catalog's size as the service reported it */
  total: number | null;
  /** the service searches and pages itself (contract 2) */
  serviceSearch: boolean;
  /** a newer copy is being fetched in the background */
  revalidating: boolean;
  savedAt: number | null;
}

function featuredFrom(apps: ReadonlyArray<CatalogApp>): CatalogApp[] {
  const seen = new Set<string>();
  const out: CatalogApp[] = [];
  const known = new Map(apps.map((app) => [app.slug, app]));
  for (const app of apps.slice(0, FEATURED_TOP)) {
    seen.add(app.slug);
    out.push(app);
  }
  for (const curated of CURATED) {
    if (seen.has(curated.slug)) continue;
    seen.add(curated.slug);
    // the live card when the catalog has it: its logo and its own words
    const live = known.get(curated.slug);
    out.push(live ? { ...live, domain: live.domain ?? curated.domain } : { ...curated });
  }
  return out;
}

function viewOf(snapshot: Snapshot, fresh: boolean, revalidating: boolean, reason?: CatalogFallbackReason, detail?: CatalogFallbackDetail): CatalogView {
  return {
    source: fresh && !snapshot.upstreamStale ? "api" : "cache",
    ...(reason ? { reason } : {}),
    ...(detail ? { detail } : {}),
    cards: snapshot.apps,
    featured: featuredFrom(snapshot.apps),
    total: snapshot.total,
    serviceSearch: snapshot.contract === 2,
    revalidating,
    savedAt: snapshot.savedAt,
  };
}

function curatedView(reason: CatalogFallbackReason, revalidating: boolean, detail?: CatalogFallbackDetail, cacheKey?: string): CatalogView {
  return {
    source: "curated",
    reason,
    ...(detail ? { detail } : {}),
    cards: CURATED.map((card) => ({ ...card })),
    featured: CURATED.map((card) => ({ ...card })),
    total: null,
    serviceSearch: cacheKey ? contractOf(cacheKey) === 2 : false,
    revalidating,
    savedAt: null,
  };
}

function isFresh(snapshot: Snapshot, backend: CatalogBackend) {
  // A new credential for the same catalog (a re-minted token) serves the old
  // copy at once but checks it again: the old one was fetched under someone
  // else's say-so.
  return snapshot.identity === backend.identity && Date.now() - snapshot.savedAt < CATALOG_FRESH_MS;
}

/**
 * The catalog for a panel or a caller that needs it.
 *
 * `waitMs` bounds how long this waits on a walk when nothing is held yet
 * (Infinity: until the walk ends). With a copy on disk it never waits unless
 * `force` (the panel's Retry), and then only as long as `waitMs`.
 */
export async function loadCatalog(
  backend: CatalogBackend | null,
  options: { waitMs?: number; force?: boolean; signal?: AbortSignal } = {},
): Promise<CatalogView> {
  if (!backend) {
    logFallback("no-backend");
    return curatedView("no-backend", false);
  }
  if (options.signal?.aborted) {
    logFallback("cancelled");
    return curatedView("cancelled", false);
  }
  const held = snapshotFor(backend.cacheKey);
  if (held && isFresh(held, backend) && !options.force) return viewOf(held, true, false);
  const waitMs = options.waitMs ?? Infinity;
  const failure = failures.get(backend.cacheKey);
  if (held && !options.force && failure && Date.now() - failure.at < FAILURE_HOLD_MS && !refreshes.has(backend.cacheKey)) {
    // The last check failed a moment ago: say so (with Retry) instead of
    // walking again on every open.
    return viewOf(held, false, false, failure.reason, failure.detail);
  }
  const pending = refresh(backend, options.signal);
  if (held && !options.force) {
    // Stale while it revalidates: first paint is the last complete catalog.
    void pending.catch(() => {});
    return viewOf(held, false, true, failure?.reason, failure?.detail);
  }
  const settled = await (Number.isFinite(waitMs)
    ? Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs).unref?.())])
    : pending);
  if (settled === null) {
    // Still walking: say so, and let the panel ask again.
    if (held) return viewOf(held, false, true);
    logFallback("loading");
    return curatedView("loading", true, undefined, backend.cacheKey);
  }
  if (settled.ok) {
    const current = snapshotFor(backend.cacheKey);
    return viewOf(current && current.savedAt >= settled.snapshot.savedAt ? current : settled.snapshot, true, false);
  }
  const detail = { loaded: settled.loaded, total: settled.total };
  if (held) return viewOf(held, false, false, settled.reason, detail);
  return curatedView(settled.reason, false, detail, backend.cacheKey);
}

/** The cached catalog only: no network, no wait. First paint's source.
 * Takes the catalog's cache key, which composio.ts can name before the
 * broker's readiness is known (a cold launch has not probed it yet). */
export function cachedCatalog(target: CatalogBackend | { cacheKey: string; identity?: string } | null): CatalogView | null {
  if (!target) return null;
  const held = snapshotFor(target.cacheKey);
  if (!held) return null;
  const fresh = held.identity === target.identity && Date.now() - held.savedAt < CATALOG_FRESH_MS;
  return viewOf(held, fresh, !fresh);
}

/** Cards for the slugs a person has connected, from what is held: the
 * catalog, then the curated set, then a monogram. Never a network call. */
export function knownApps(backend: CatalogBackend | null, slugs: ReadonlyArray<string>): Record<string, CatalogApp> {
  const held = backend ? snapshotFor(backend.cacheKey) : null;
  const index = new Map((held?.apps ?? []).map((app) => [app.slug, app]));
  // null prototype: a slug such as "__proto__" is an own key like any other
  const out: Record<string, CatalogApp> = Object.create(null);
  for (const raw of slugs) {
    const slug = raw.trim().toLowerCase();
    if (!SLUG.test(slug) || SERVICE_NAME.test(slug)) continue;
    const curated = CURATED.find((card) => card.slug === slug);
    const app = index.get(slug);
    out[slug] = app ? { ...app, domain: app.domain ?? curated?.domain ?? null } : curated ? { ...curated } : monogramApp(slug);
  }
  return out;
}

// ── search and paging ─────────────────────────────────────────────────

export interface CatalogPage {
  items: CatalogApp[];
  nextCursor: string | null;
  total: number | null;
  source: "service" | "local" | "curated";
  reason?: CatalogFallbackReason;
}

function score(app: CatalogApp, q: string): number {
  const label = app.label.toLowerCase();
  if (app.slug === q || label === q) return 0;
  if (label.startsWith(q) || app.slug.startsWith(q.replace(/\s+/g, ""))) return 1;
  if (label.split(/[\s()/-]+/).some((word) => word.startsWith(q))) return 2;
  if (label.includes(q) || app.slug.includes(q.replace(/\s+/g, ""))) return 3;
  if (app.blurb.toLowerCase().includes(q)) return 4;
  return -1;
}

/** Search what is held, most relevant first, usage order within a rank. */
export function searchLocal(apps: ReadonlyArray<CatalogApp>, query: string, limit = MAX_SEARCH): { items: CatalogApp[]; total: number } {
  const q = query.trim().toLowerCase();
  if (!q) return { items: [], total: 0 };
  const ranked = apps
    .map((app, index) => ({ app, index, rank: score(app, q) }))
    .filter((row) => row.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  return { items: ranked.slice(0, limit).map((row) => row.app), total: ranked.length };
}

async function serviceQuery(backend: CatalogBackend, query: URLSearchParams, signal?: AbortSignal): Promise<{ ok: true; json: Record<string, unknown>; apps: CatalogApp[] } | { ok: false; reason: CatalogFallbackReason; legacy?: boolean }> {
  const deadline = AbortSignal.timeout(SERVICE_TIMEOUT_MS);
  try {
    const response = await backend.request(query, signal ? AbortSignal.any([signal, deadline]) : deadline);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, reason: httpReason(response.status) };
    }
    const json = await response.json() as Record<string, unknown>;
    if (backend.current() !== backend.identity) return { ok: false, reason: "identity" };
    if (!json || typeof json !== "object" || json.contract !== 2) {
      // Today's broker ignores search and paging and answers with page one
      // of the raw catalog. That is not a search result: search here instead.
      // Only a raw catalog page marks the broker old; anything else is a
      // bad answer this once.
      const rawPage = !!json && typeof json === "object" && (Array.isArray(json.items) || Array.isArray(json.data));
      if (!rawPage) return { ok: false, reason: "bad-response" };
      noteContract(backend.cacheKey, 1);
      return { ok: false, reason: "bad-response", legacy: true };
    }
    noteContract(backend.cacheKey, 2);
    const items = Array.isArray(json.items) ? json.items : [];
    return { ok: true, json, apps: items.map(slimApp).filter((app): app is CatalogApp => app !== null) };
  } catch {
    return { ok: false, reason: deadline.aborted ? "timeout" : "network" };
  }
}

/** Search the whole catalog: the service when it searches (contract 2),
 * otherwise what is held on this computer. */
export async function searchCatalog(backend: CatalogBackend | null, query: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<CatalogPage> {
  const q = query.replace(/\s+/g, " ").trim().slice(0, 80);
  const limit = Math.max(1, Math.min(MAX_SEARCH, options.limit ?? MAX_SEARCH));
  if (!q) return { items: [], nextCursor: null, total: 0, source: "local" };
  let reason: CatalogFallbackReason | undefined;
  if (backend && backend.kind === "broker" && contractOf(backend.cacheKey) !== 1) {
    const answer = await serviceQuery(backend, new URLSearchParams({ search: q, limit: String(limit) }), options.signal);
    if (answer.ok) {
      const total = Number(answer.json.total_items);
      return { items: answer.apps.slice(0, limit), nextCursor: null, total: Number.isSafeInteger(total) ? total : answer.apps.length, source: "service" };
    }
    if (!answer.legacy) {
      reason = answer.reason;
      logFallback(answer.reason, ` while searching`);
    }
  }
  const held = backend ? snapshotFor(backend.cacheKey) : null;
  if (!held && backend) void refresh(backend).catch(() => {});
  const pool: CatalogApp[] = held ? held.apps : [...CURATED];
  const { items, total } = searchLocal(pool, q, limit);
  return {
    items,
    nextCursor: null,
    total,
    source: held ? "local" : "curated",
    ...(reason ? { reason } : !held ? { reason: backend ? "loading" as const : "no-backend" as const } : {}),
  };
}

function alphabetical(snapshot: Snapshot): CatalogApp[] {
  if (byName?.snapshot === snapshot) return byName.apps;
  const apps = [...snapshot.apps].sort((a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base" }) || a.slug.localeCompare(b.slug));
  byName = { snapshot, apps };
  return apps;
}

/** One page of "All apps", A to Z. Served from the held catalog when there
 * is one (no network), otherwise from the service's own paging (contract 2),
 * otherwise the curated set with the reason. Cursors are opaque to the
 * panel: `o:<offset>` for held pages, `s:<service cursor>` for the service. */
export async function catalogPage(backend: CatalogBackend | null, options: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {}): Promise<CatalogPage> {
  const limit = Math.max(1, Math.min(MAX_PAGE, options.limit ?? MAX_PAGE));
  const cursor = options.cursor ?? "";
  const held = backend ? snapshotFor(backend.cacheKey) : null;
  if (held && !cursor.startsWith("s:")) {
    const offset = /^o:\d{1,6}$/.test(cursor) ? Number(cursor.slice(2)) : 0;
    const apps = alphabetical(held);
    const items = apps.slice(offset, offset + limit);
    const next = offset + limit < apps.length ? `o:${offset + limit}` : null;
    return { items, nextCursor: next, total: apps.length, source: "local" };
  }
  if (backend && backend.kind === "broker" && contractOf(backend.cacheKey) !== 1) {
    const query = new URLSearchParams({ limit: String(limit), sort: "name" });
    const serviceCursor = cursor.startsWith("s:") ? cursor.slice(2) : "";
    if (serviceCursor && CURSOR.test(serviceCursor)) query.set("cursor", serviceCursor);
    const answer = await serviceQuery(backend, query, options.signal);
    if (answer.ok) {
      const next = typeof answer.json.next_cursor === "string" && CURSOR.test(answer.json.next_cursor) ? `s:${answer.json.next_cursor}` : null;
      const total = Number(answer.json.total_items);
      return { items: answer.apps.slice(0, limit), nextCursor: next, total: Number.isSafeInteger(total) ? total : null, source: "service" };
    }
    if (!answer.legacy) logFallback(answer.reason, " while paging");
    if (held) {
      // The service stopped answering mid-scroll, but a whole copy is held:
      // carry on from it (the panel drops apps it already has).
      const apps = alphabetical(held);
      return { items: apps.slice(0, limit), nextCursor: limit < apps.length ? `o:${limit}` : null, total: apps.length, source: "local" };
    }
    if (backend) void refresh(backend).catch(() => {});
    const apps = [...CURATED].sort((a, b) => a.label.localeCompare(b.label));
    return { items: apps.slice(0, limit), nextCursor: null, total: apps.length, source: "curated", reason: answer.legacy ? "loading" : answer.reason };
  }
  if (backend) void refresh(backend).catch(() => {});
  const apps = [...CURATED].sort((a, b) => a.label.localeCompare(b.label));
  return { items: apps.slice(0, limit), nextCursor: null, total: apps.length, source: "curated", reason: backend ? "loading" : "no-backend" };
}

/** The card for one slug, for a connect card or the Connected tab: held
 * catalog, curated set, the service's search (contract 2, exact slug),
 * then a monogram. Never walks the whole catalog. */
export async function catalogApp(backend: CatalogBackend | null, slug: string): Promise<CatalogApp> {
  const normalized = slug.trim().toLowerCase();
  const held = backend ? snapshotFor(backend.cacheKey) : null;
  const known = held?.apps.find((app) => app.slug === normalized);
  const curated = CURATED.find((card) => card.slug === normalized);
  if (known) return { ...known, domain: known.domain ?? curated?.domain ?? null };
  if (curated) return { ...curated };
  if (backend && backend.kind === "broker" && contractOf(backend.cacheKey) !== 1) {
    const answer = await serviceQuery(backend, new URLSearchParams({ search: normalized, limit: "10" }));
    const exact = answer.ok ? answer.apps.find((app) => app.slug === normalized) : undefined;
    if (exact) return exact;
    if (answer.ok) return monogramApp(normalized);
    if (!answer.legacy) {
      // The service is failing: a walk against it would fail too.
      logFallback(answer.reason, ` while describing ${normalized}`);
      return monogramApp(normalized);
    }
  }
  if (backend && !held) {
    // A broker that cannot look one app up (today's) or an own key: the
    // card still needs to know whether the app has a hosted sign-in, so wait
    // a bounded time for the first walk.
    const walked = await Promise.race([
      refresh(backend).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CARD_WAIT_MS).unref?.()),
    ]);
    const found = walked?.ok ? walked.snapshot.apps.find((app) => app.slug === normalized) : undefined;
    if (found) return found;
    if (!walked?.ok) logFallback(walked ? walked.reason : "loading", ` while describing ${normalized}`);
  }
  return monogramApp(normalized);
}

/** The long tail's one line, on a connect card and in the panel. The
 * connect page then asks for the details (an API key, a login). */
export const NEEDS_OWN_SIGN_IN = "Needs your own sign-in details. Connecting opens a page where you enter them.";
