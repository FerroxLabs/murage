// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owner reads of Sentinel (1.0.9, GAP-SENTINEL-109 sections 6.3, 7 and 8.1).
//
//   GET /api/sentinel/summary                                  the last published view.json (summary + <= 25 rows)
//   GET /api/sentinel/issues?state=open|resolved&after=&limit= one page from the scanner store, read-only
//
// Fixed filters only (state, after, limit; each at most once; anything else is 400). limit defaults to 25, at most 50;
// a page stays within 64 KiB (publication.ts). No raw evidence: evidence references, source tokens and related
// fingerprints are removed before a row leaves. A read never starts a scan and never opens a source database; it reads
// only what the scanner last committed or published, through publication.ts.
//
// Who may read: the installation's proven owner, and nobody else. On the desktop that is the renderer's per-launch proof
// (requestSurface === "desktop"); on a Cloud home it is an owner-desktop or owner-phone session, or the owner's passkey
// browser (ownerBrowserActs). A bot's internal capability, a paired browser extension, a script grant, a channel contact,
// a remembered or chat-only browser, an unsigned caller and the public health class all get the unknown-route 404.
// route-policy.ts classifies both routes `desktop` (never `health`); cloudRouteDecision repeats the owner rule.
//
// The scanner's output root is located through the same paths.ts helpers the host used to write it: the opaque
// installation id (shared/sentinel-installation.mjs) names <OS state dir>/MurageSentinel/<id>, and the descriptor there
// must load, validate and name this installation. A foreign or redirected root is unavailable, never read.
//
// The desktop host's view (electron/sentinel-host.mjs) sits beside the descriptor as host-status.json: registration,
// mechanism, heartbeat fresh|stale|waiting, heartbeatAt and the health root's state. It is read with the descriptor's
// file checks (owner-only, no link, one name, at most HOST_STATUS_MAX_BYTES) and validated field by field. A stale
// scanner heartbeat, or a registration that needs attention, makes the summary's coverage partial: the card then says
// "Some health checks are waiting for fresh information." with the last complete check, never "No issues found" or a
// stale "Checked" time. A missing or invalid file changes nothing (Cloud and self-host have no desktop host).
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { HEALTH_LIMITS } from "../../shared/health-protocol.mjs";
import { sentinelInstallationIdOf } from "../../shared/sentinel-installation.mjs";
import type { HealthIssue, HealthIssuesResponse, HealthSummaryResponse } from "../../shared/sentinel-view.ts";
import { ownerBrowserActs, type CloudRequestIdentity } from "../cloud-request-identity.ts";
import { SENTINEL_OWNER_ROUTE, sentinelCloudDecision } from "../route-policy.ts";
import { DESCRIPTOR_FILE, checkOwnedFile, defaultOutputRoot, loadDescriptor, readSmallVerified, type LoadOptions, type PlatformOptions } from "./paths.ts";
import { readIssuesPage, readPublishedView, type IssueDetail } from "./publication.ts";
import type { SentinelView } from "./types.ts";

export const SENTINEL_SUMMARY_PATH = "/api/sentinel/summary";
export const SENTINEL_ISSUES_PATH = "/api/sentinel/issues";
export const SENTINEL_ROUTE = SENTINEL_OWNER_ROUTE;
export { sentinelCloudDecision };

export interface OwnerProof {
  /** True on a Cloud home (MURAGE_CLOUD_ROLE=home). */
  cloudHome: boolean;
  /** requestSurface(headers, query) for a desktop launch. */
  surface: "desktop" | "remote";
  /** The Cloud session that signed this request, when there is one. */
  cloudIdentity?: CloudRequestIdentity | undefined;
  /** A script grant resolved for this request (never an owner). */
  grant?: boolean;
}

/** Whether this caller is the installation's owner for Health reads. Fails closed. */
export function sentinelOwner(proof: OwnerProof): boolean {
  if (proof.grant) return false;
  if (proof.cloudHome) {
    const identity = proof.cloudIdentity;
    if (!identity || identity.revoked) return false;
    return identity.scope === "owner-desktop" || identity.scope === "owner-phone" || ownerBrowserActs(identity);
  }
  return proof.surface === "desktop";
}

export interface SentinelLocation { installationId: string; outputRoot: string }
export type LocateResult = { ok: true; value: SentinelLocation } | { ok: false; reason: string };

export interface LocateOptions extends LoadOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Canonical data directory (defaults to realpath of dataDir). */
  canonical?: string;
}

/** Finds this installation's scanner output root and checks its descriptor names this installation. */
export function locateSentinel(dataDir: string, opts: LocateOptions = {}): LocateResult {
  let canonical: string;
  try { canonical = opts.canonical ?? realpathSync.native(dataDir); } catch { return { ok: false, reason: "data-dir" }; }
  const installationId = sentinelInstallationIdOf(canonical);
  const outputRoot = defaultOutputRoot(installationId, { platform: opts.platform, env: opts.env, home: opts.home });
  if (!outputRoot) return { ok: false, reason: "output-root" };
  // The scanner may see the installation through a projected path (Cloud), so the installation root itself is not
  // required to exist here; the descriptor's id and output root must still be exactly this installation's.
  const loaded = loadDescriptor(join(outputRoot, DESCRIPTOR_FILE), { ...opts, requireInstallationRoot: opts.requireInstallationRoot ?? false });
  if (!loaded.ok) return { ok: false, reason: loaded.reason };
  if (loaded.value.installationId !== installationId || loaded.value.outputRoot !== outputRoot) return { ok: false, reason: "foreign" };
  return { ok: true, value: { installationId, outputRoot } };
}

export const HOST_STATUS_FILE = "host-status.json";
export const HOST_STATUS_MAX_BYTES = 1024;
const HOST_REGISTRATIONS = new Set(["unregistered", "staged", "registered", "proven", "registration-needed"]);
const HOST_MECHANISMS = new Set(["launchd", "systemd", "task-scheduler", "supervisor", "autostart"]);
const HOST_HEARTBEATS = new Set(["waiting", "fresh", "stale"]);
const HOST_ROOT_STATES = new Set(["absent", "initializing", "ready", "publishing", "publication-deferred"]);
const HOST_KEYS = ["version", "installationId", "at", "registration", "mechanism", "heartbeat", "heartbeatAt", "rootState"];

/** The desktop host's view of this installation's scanner (electron/sentinel-host.mjs writeHostStatus). */
export interface HostStatus {
  at: number;
  registration: "unregistered" | "staged" | "registered" | "proven" | "registration-needed";
  mechanism: "launchd" | "systemd" | "task-scheduler" | "supervisor" | "autostart" | null;
  heartbeat: "waiting" | "fresh" | "stale";
  heartbeatAt: number | null;
  rootState: string;
}

const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Reads <outputRoot>/host-status.json with the descriptor's file checks. null when absent, refused or invalid. */
export function readHostStatus(outputRoot: string, installationId: string, opts: PlatformOptions = {}): HostStatus | null {
  try {
    const file = join(outputRoot, HOST_STATUS_FILE);
    const checked = checkOwnedFile(file, opts);
    if (!checked.ok || !checked.value) return null;
    const bytes = readSmallVerified(file, checked.value, HOST_STATUS_MAX_BYTES);
    if (!bytes.ok) return null;
    const raw = JSON.parse(bytes.value.toString("utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (Object.keys(raw).some(key => !HOST_KEYS.includes(key))) return null;
    if (raw.version !== 1 || raw.installationId !== installationId || !time(raw.at)) return null;
    if (typeof raw.registration !== "string" || !HOST_REGISTRATIONS.has(raw.registration)) return null;
    if (raw.mechanism !== null && (typeof raw.mechanism !== "string" || !HOST_MECHANISMS.has(raw.mechanism))) return null;
    if (typeof raw.heartbeat !== "string" || !HOST_HEARTBEATS.has(raw.heartbeat)) return null;
    if (raw.heartbeatAt !== null && !time(raw.heartbeatAt)) return null;
    if (typeof raw.rootState !== "string" || !HOST_ROOT_STATES.has(raw.rootState)) return null;
    return {
      at: raw.at, registration: raw.registration as HostStatus["registration"], mechanism: raw.mechanism as HostStatus["mechanism"],
      heartbeat: raw.heartbeat as HostStatus["heartbeat"], heartbeatAt: raw.heartbeatAt as number | null, rootState: raw.rootState,
    };
  } catch { return null; }
}

/** Whether the host says the scanner's coverage is incomplete: its heartbeat is stale (and no scan committed since the
 *  host said so), or its registration needs attention and no fresh heartbeat shows a fallback scanner running. */
export function hostCoverageIncomplete(view: SentinelView | null, host: HostStatus | null): boolean {
  if (!host) return false;
  if (host.registration === "registration-needed" && host.heartbeat !== "fresh") return true;
  return host.heartbeat === "stale" && (view?.summary.lastCheckedAt ?? 0) <= host.at;
}

/** The view as the owner sees it: coverage partial while the host says checks are waiting. Never widens coverage. */
export function viewWithHostStatus(view: SentinelView | null, host: HostStatus | null): SentinelView | null {
  if (!view || !hostCoverageIncomplete(view, host) || view.summary.coverage !== "complete") return view;
  return { ...view, summary: { ...view.summary, coverage: "partial" } };
}

/** The published view for this location with the host's status applied. */
export function readOwnerView(location: SentinelLocation, platform?: NodeJS.Platform): SentinelView | null {
  const view = readPublishedView(location.outputRoot, platform);
  if (!view) return null;
  return viewWithHostStatus(view, readHostStatus(location.outputRoot, location.installationId, platform ? { platform } : {}));
}

/** Strips what is not for the owner surface: evidence references, source tokens, related fingerprints. */
export function ownerIssue(item: IssueDetail): HealthIssue {
  const { evidence: _evidence, sourceKey: _sourceKey, relatedFingerprints: _related, ...rest } = item;
  return rest;
}

export interface SentinelReadContext {
  owner: boolean;
  /** Located lazily, only for an owner. */
  locate: () => LocateResult;
  platform?: NodeJS.Platform;
}

export interface SentinelReadAnswer { status: number; body: unknown }

const ISSUE_QUERY_KEYS = new Set(["state", "after", "limit"]);

/** Parses the fixed issue filters; null when anything else is present or a value is out of range. */
export function parseIssuesQuery(query: URLSearchParams): { state: "open" | "resolved"; after: string | null; limit: number } | null {
  for (const key of new Set(query.keys())) if (!ISSUE_QUERY_KEYS.has(key) || query.getAll(key).length !== 1) return null;
  const state = query.get("state");
  if (state !== "open" && state !== "resolved") return null;
  const after = query.get("after");
  if (after !== null && (after.length === 0 || after.length > 512)) return null;
  const rawLimit = query.get("limit");
  let limit: number = HEALTH_LIMITS.apiLimitDefault;
  if (rawLimit !== null) {
    if (!/^\d{1,3}$/.test(rawLimit)) return null;
    limit = Number(rawLimit);
    if (limit < 1 || limit > HEALTH_LIMITS.apiLimitMax) return null;
  }
  return { state, after, limit };
}

/** Answers a Sentinel owner read, or null when the path is not one. Never throws. */
export function handleSentinelRead(method: string, path: string, query: URLSearchParams, ctx: SentinelReadContext): SentinelReadAnswer | null {
  if (!SENTINEL_ROUTE.test(path)) return null;
  if (method !== "GET" || !ctx.owner) return { status: 404, body: { error: "no such route" } };
  try {
    if (path === SENTINEL_SUMMARY_PATH) {
      if ([...query.keys()].length > 0) return { status: 400, body: { error: "bad-request" } };
      const located = ctx.locate();
      if (!located.ok) return { status: 200, body: { status: located.reason === "descriptor-missing" || located.reason === "output-root" ? "waiting" : "unavailable", view: null } satisfies HealthSummaryResponse };
      const view = readOwnerView(located.value, ctx.platform);
      return { status: 200, body: { status: view ? "ready" : "waiting", view } satisfies HealthSummaryResponse };
    }
    const parsed = parseIssuesQuery(query);
    if (!parsed) return { status: 400, body: { ok: false, reason: "bad-request" } satisfies HealthIssuesResponse };
    const located = ctx.locate();
    if (!located.ok) return { status: 503, body: { ok: false, reason: "unavailable" } satisfies HealthIssuesResponse };
    const page = readIssuesPage(located.value.outputRoot, located.value.installationId, { state: parsed.state, after: parsed.after, limit: parsed.limit }, ctx.platform);
    if (!page.ok) {
      const status = page.reason === "refresh" ? 409 : page.reason === "unavailable" ? 503 : 400;
      return { status, body: { ok: false, reason: page.reason } satisfies HealthIssuesResponse };
    }
    const body: HealthIssuesResponse = { ok: true, storeRevision: page.storeRevision, items: page.items.map(ownerIssue), next: page.next };
    return { status: 200, body };
  } catch {
    return { status: 503, body: { ok: false, reason: "unavailable" } };
  }
}
