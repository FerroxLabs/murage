// DG8 slice 2 (designs/DESIGN-U15-USAGE-READS-1021.md; GAP-PLAN-LIMITS-109 section 11 HTTP contract): the owner's plan
// usage report. Read only: it writes no state, creates or clears no hold, and Refresh only asks the existing service for a
// read on a process that is already running (no spawn, resend, rotation or continuation). No credential revision, home
// path or raw subject key leaves the server.
import { createHmac, randomBytes } from "node:crypto";
import type { PlanStatus, PlanReason, PlanSource, PlanWindow } from "../shared/plan-usage.ts";
import type { PlanUsageService } from "./plan-usage.ts";

export interface PlanUsageWindowView {
  label: string;
  usedPercent: number | null;
  resetsAt: number | null;
  windowSeconds: number | null;
  limitReached: boolean;
}

export interface PlanUsageRow {
  /** Opaque, stable across pages and reads for this service lifetime. */
  id: string;
  engine: string;
  /** The bot whose engine account this is, or null for the owner's own. */
  bot: string | null;
  status: PlanStatus;
  reason: PlanReason | null;
  source: PlanSource | null;
  checkedAt: number | null;
  freshUntil: number | null;
  windows: PlanUsageWindowView[];
  /** A read is queued or running now, even when an older reading is still shown. */
  refreshing: boolean;
}

export interface PlanUsageReport {
  accounts: PlanUsageRow[];
  serverNow: number;
  /** Live accounts after this page that are not in it. */
  omitted: number;
  /** Cursor for the next page, or null at the end. */
  nextCursor: number | null;
  /** A Cloud home: Codex plan reads are not bound there yet, so the list is empty by design. */
  cloud: boolean;
}

/** At most this many rows per report (GAP section 11 HTTP contract). */
export const PLAN_REPORT_PAGE = 32;

/** A bounded cursor from the query string: a whole number in 0..100000, else 0. */
export function planCursor(raw: string | null | undefined): number {
  if (!raw || !/^\d{1,6}$/.test(raw)) return 0;
  const n = Number(raw);
  return n <= 100_000 ? n : 0;
}

export interface PlanUsageLabels {
  /** The engine instance as Settings names it; undefined when the instance is gone (the row is left out). */
  engine(instanceId: string): string | undefined;
  /** A bot's name; undefined when the bot is gone (the row is left out). */
  bot(botId: string): string | undefined;
}

/** `codex:<instanceId>:<botId|owner>` (server/drivers/codex.ts), else null. */
export function parsePlanSubject(subjectKey: string): { engineKind: string; instanceId: string; botId: string | null } | null {
  const match = /^([a-z][\w-]{0,40}):([\w-]{1,100}):([\w-]{1,100})$/.exec(subjectKey);
  if (!match) return null;
  return { engineKind: match[1], instanceId: match[2], botId: match[3] === "owner" ? null : match[3] };
}

const windowView = (w: PlanWindow): PlanUsageWindowView => ({
  label: w.label, usedPercent: w.usedPercent, resetsAt: w.resetsAt, windowSeconds: w.windowSeconds, limitReached: w.limitKind !== null,
});

const reportSecrets = new WeakMap<object, Buffer>();
function accountId(service: object, key: string): string {
  let secret = reportSecrets.get(service);
  if (!secret) { secret = randomBytes(32); reportSecrets.set(service, secret); }
  return createHmac("sha256", secret).update(key).digest("hex");
}

type ReportService = Pick<PlanUsageService, "allSubjectKeys" | "observation" | "refreshing">;

/**
 * The live subjects a report covers, over the FULL subject set (filter first, then page): an account whose engine
 * instance or bot is gone is left out before the 32-row cap, so stale subjects never push live ones off the page.
 * `onlyBotId` keeps one bot's own subject (G25).
 */
export function planSubjects(service: Pick<PlanUsageService, "allSubjectKeys">, labels: PlanUsageLabels, onlyBotId?: string): string[] {
  return service.allSubjectKeys().filter((key) => {
    const parsed = parsePlanSubject(key);
    if (!parsed || labels.engine(parsed.instanceId) === undefined) return false;
    if (onlyBotId !== undefined) return parsed.botId === onlyBotId;
    return parsed.botId === null || labels.bot(parsed.botId) !== undefined;
  });
}

/** One page of live subjects and what is left after it. */
function planPage(service: Pick<PlanUsageService, "allSubjectKeys">, labels: PlanUsageLabels, cursor: number, onlyBotId?: string) {
  const live = planSubjects(service, labels, onlyBotId);
  const start = Math.min(cursor, live.length);
  const keys = live.slice(start, start + PLAN_REPORT_PAGE);
  const end = start + keys.length;
  return { keys, start, omitted: live.length - end, nextCursor: end < live.length ? end : null };
}

export interface PlanReportOptions { cursor?: number; onlyBotId?: string; cloud?: boolean }

export function planUsageReport(service: ReportService, labels: PlanUsageLabels, now: number, options: PlanReportOptions = {}): PlanUsageReport {
  const page = planPage(service, labels, options.cursor ?? 0, options.onlyBotId);
  const accounts = page.keys.map((key): PlanUsageRow => {
    const parsed = parsePlanSubject(key)!;
    const seen = service.observation(key);
    return {
      id: accountId(service, key),
      engine: labels.engine(parsed.instanceId)!,
      bot: parsed.botId === null ? null : labels.bot(parsed.botId) ?? null,
      status: seen.status,
      reason: seen.reason,
      source: seen.source,
      checkedAt: seen.lastSuccessAt ?? seen.observedAt,
      freshUntil: seen.freshUntil,
      windows: seen.windows.map(windowView),
      refreshing: seen.status === "checking" || service.refreshing(key),
    };
  });
  return { accounts, serverNow: now, omitted: page.omitted, nextCursor: page.nextCursor, cloud: options.cloud === true };
}

/** Owner Refresh: one bounded read request per account on the same page that is already running; returns the report at once. */
export function refreshPlanUsage(
  service: ReportService & Pick<PlanUsageService, "demand">,
  labels: PlanUsageLabels,
  now: number,
  options: Omit<PlanReportOptions, "onlyBotId"> = {},
): PlanUsageReport {
  service.demand(planPage(service, labels, options.cursor ?? 0).keys, { owner: true });
  return planUsageReport(service, labels, now, options);
}
