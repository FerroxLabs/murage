// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// C0 / TC-BROKER/1. See docs/contracts/today-calendar-v1.md; no I/O or authority is granted here.
// PROVISIONAL INTERFACE: P1/S1/L1/H1/U1/T1 parameter/result packaging is frozen in that document
// because the design names methods without complete signatures. It is not a runtime implementation.
import { z } from "zod";

export const TODAY_CALENDAR_CONTRACT = "murage.today-calendar/1" as const;
export const TODAY_CALENDAR_PROVIDER_VERSION = "google-calendar-v3/1" as const;
export const TODAY_CALENDAR_BROKER_PATH = "/v1/today-calendar/read" as const;
export const TODAY_CALENDAR_STATE_DB = "today-calendar-state.sqlite" as const;
export const TODAY_CALENDAR_PREFERENCES_PATH = "today-calendar-preferences.json" as const;
export const TODAY_CALENDAR_READ_TOOLS = ["GOOGLECALENDAR_LIST_CALENDARS", "GOOGLECALENDAR_EVENTS_LIST"] as const;
export const TODAY_CALENDAR_LIMITS = Object.freeze({
  idBytes: 1024, labelCharacters: 120, titleCharacters: 300, selections: 20,
  requestBytes: 64 * 1024, preferencesBytes: 64 * 1024, pageTokenBytes: 4096,
  bodyBytes: 2 * 1024 * 1024, attemptBytes: 10 * 1024 * 1024,
  requestMs: 15_000, attemptMs: 120_000, requests: 64, pages: 20, items: 2000, pageSize: 100,
  discoveryTtlMs: 300_000, metadataAccountThrottleMs: 30_000, metadataHomeWindowMs: 300_000,
  metadataHomeStarts: 20, leaseMs: 180_000, manualThrottleMs: 300_000,
  heartbeatMs: 5000, livenessMs: 15_000, historyDates: 8, manualHistory: 64,
  automaticAttempts: 3, manualAttempts: 1,
});
const utf8 = new TextEncoder();
const bytes = (s: string) => utf8.encode(s).length;
// Preserve a leading U+FEFF: it is valid identity data, not a transport BOM to strip.
const wellFormed = (s: string) => new TextDecoder("utf-8", {ignoreBOM:true}).decode(utf8.encode(s)) === s;
const cleanText = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
const plainText = (max: number) => z.string().refine(s => wellFormed(s) && s === cleanText(s) && [...s].length <= max);
export function sanitizeTodayText(value: string, max: number, fallback: string): string {
  return [...cleanText(new TextDecoder().decode(utf8.encode(value)))].slice(0, max).join("").trim() || fallback;
}
export const idSchema = z.string().min(1).refine(s => wellFormed(s) && bytes(s) <= TODAY_CALENDAR_LIMITS.idBytes);
export const labelSchema = plainText(120).refine(s => s.trim().length > 0);
export const counterSchema = z.number().int().nonnegative().refine(Number.isSafeInteger);
export const instantSchema = z.number().finite();
export const uuidSchema = z.string().uuid();
export const zoneSchema = z.string().min(1).max(200).refine(s => {
  // Intl accepts offset zones on some runtimes; the contract requires a named IANA zone.
  if (/^[+-]/.test(s)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: s }); return true; } catch { return false; }
});
export const morningTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
// Civil-date checks follow shared/app-triggers.ts isRfc3339Utc, including leap years; no Date rollover.
function isCivilDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y,m,d] = s.split("-").map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  return m >= 1 && m <= 12 && d >= 1 && d <= [31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31][m-1];
}
export const civilDateSchema = z.string().refine(isCivilDate);
function isRfc3339(s: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(s);
  return !!match && isCivilDate(match[1]) && Number.isFinite(Date.parse(s));
}
export const dateTimeSchema = z.string().max(100).refine(isRfc3339);
export const utcTimeSchema = dateTimeSchema.refine(s => s.endsWith("Z"));
export const dateValueSchema = z.union([
  z.object({ date: civilDateSchema }).strict(), z.object({ dateTime: dateTimeSchema }).strict(),
]);
export type DateValue = z.infer<typeof dateValueSchema>;
export const ownerBindingSchema = z.object({ homeId: idSchema, ownerSubject: idSchema, brokerPrincipal: idSchema }).strict();
export type OwnerBinding = z.infer<typeof ownerBindingSchema>;
export const stampSchema = z.object({ version: z.literal(1), ownerEpoch: idSchema, generation: counterSchema, snapshotRevision: counterSchema }).strict();
export type Stamp = z.infer<typeof stampSchema>;
export const expectedStampSchema = z.object({ expectedEpoch: idSchema, expectedGeneration: counterSchema }).strict();
export type ExpectedStamp = z.infer<typeof expectedStampSchema>;
/** Exact equality, including revision: a same-generation older publication is stale. */
export function matchesStamp(a: unknown, b: unknown): boolean {
  const left = stampSchema.safeParse(a), right = stampSchema.safeParse(b);
  return left.success && right.success && left.data.ownerEpoch === right.data.ownerEpoch
    && left.data.generation === right.data.generation && left.data.snapshotRevision === right.data.snapshotRevision;
}
export const BROKER_ERROR_CODES = ["auth_required","account_revoked","account_not_owned","calendar_removed","unsupported_connector","rate_limited","upstream_unavailable","timeout","aborted","too_large","malformed_response","authority_lost"] as const;
export const ERROR_CODES = [...BROKER_ERROR_CODES,"storage_error","invalid_input","stale_generation","stale_epoch","consent_required","selection_invalid","busy","throttled","step_up_required","snapshot_unavailable"] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export const statusSchema = z.enum(["off","setup_required","waiting","checking","retry_wait","ready","refresh_failed","restarted","expired","auth_required","selection_invalid","unsupported_connector","storage_error","unavailable"]);
export type Status = z.infer<typeof statusSchema>;
export const privacySchema = z.enum(["public","default","private","confidential","unknown"]);
export const accountSummarySchema = z.object({ accountId:idSchema,label:labelSchema,state:z.enum(["active","pending","revoked"]),provider:z.literal("googlecalendar") }).strict();
export type AccountSummary = z.infer<typeof accountSummarySchema>;
export const calendarItemSchema = z.object({ calendarId:idSchema,label:labelSchema,timeZone:zoneSchema,primary:z.boolean(),access:z.enum(["reader","writer","owner"]) }).strict();
export type CalendarItem = z.infer<typeof calendarItemSchema>;
export const brokerEventSchema = z.object({
  eventId:idSchema,originalStart:dateValueSchema.nullable(),start:dateValueSchema,end:dateValueSchema,
  status:z.enum(["confirmed","tentative","cancelled"]),selfResponse:z.enum(["accepted","tentative","needsAction","declined","absent"]),
  privacy:privacySchema,summary:z.string().refine(s => wellFormed(s) && bytes(s) <= TODAY_CALENDAR_LIMITS.bodyBytes).nullable(),updatedAt:utcTimeSchema,
}).strict().refine(e => {
  if ("date" in e.start && "date" in e.end) return e.start.date < e.end.date;
  return "dateTime" in e.start && "dateTime" in e.end && Date.parse(e.start.dateTime) < Date.parse(e.end.dateTime);
});
export type BrokerEvent = z.infer<typeof brokerEventSchema>;
const tokenSchema = z.string().min(1).refine(s => wellFormed(s) && bytes(s) <= 4096).nullable();
const brokerCommon = { contract:z.literal(TODAY_CALENDAR_CONTRACT),providerVersion:z.literal(TODAY_CALENDAR_PROVIDER_VERSION),requestId:uuidSchema };
const brokerRead = { ...brokerCommon,provider:z.literal("googlecalendar"),pageToken:tokenSchema };
export const brokerRequestSchema = z.discriminatedUnion("operation", [
  z.object({...brokerRead,operation:z.literal("accounts")}).strict(),
  z.object({...brokerRead,operation:z.literal("calendars"),accountId:idSchema,pageSize:z.literal(100)}).strict(),
  z.object({...brokerRead,operation:z.literal("events"),accountId:idSchema,calendarId:idSchema,timeMin:utcTimeSchema,timeMax:utcTimeSchema,singleEvents:z.literal(true),showDeleted:z.literal(false),pageSize:z.literal(100)}).strict()
    .refine(r => Date.parse(r.timeMin) < Date.parse(r.timeMax) && Date.parse(r.timeMax)-Date.parse(r.timeMin) <= 26*60*60*1000),
]);
export type BrokerRequest = z.infer<typeof brokerRequestSchema>;
const successCommon = {...brokerCommon,ok:z.literal(true),ownerBinding:idSchema,nextPageToken:tokenSchema};
export const brokerSuccessSchema = z.discriminatedUnion("operation", [
  z.object({...successCommon,operation:z.literal("accounts"),accountId:z.null(),items:z.array(accountSummarySchema).max(100)}).strict(),
  z.object({...successCommon,operation:z.literal("calendars"),accountId:idSchema,items:z.array(calendarItemSchema).max(100)}).strict(),
  z.object({...successCommon,operation:z.literal("events"),accountId:idSchema,items:z.array(brokerEventSchema).max(100)}).strict(),
]);
export const brokerFailureSchema = z.object({...brokerCommon,ok:z.literal(false),error:z.object({code:z.enum(BROKER_ERROR_CODES),retryAfterMs:counterSchema.nullable()}).strict()}).strict();
export const brokerResponseSchema = z.union([brokerSuccessSchema,brokerFailureSchema]);
export type BrokerResponse = z.infer<typeof brokerResponseSchema>;
export type BrokerSuccess = z.infer<typeof brokerSuccessSchema>;
export type BrokerFailure = z.infer<typeof brokerFailureSchema>;
/** Correlation only. Broker ownership, calendar membership and page-token binding still require P1 authority checks. */
export function matchesBrokerResponse(request: unknown, response: unknown, principal: string): boolean {
  const req = brokerRequestSchema.safeParse(request), res = brokerResponseSchema.safeParse(response);
  if (!req.success || !res.success || req.data.requestId !== res.data.requestId) return false;
  if (!res.data.ok) return true;
  return res.data.ownerBinding === principal && res.data.operation === req.data.operation
    && res.data.accountId === (req.data.operation === "accounts" ? null : req.data.accountId);
}
export const selectionItemSchema = z.object({provider:z.literal("googlecalendar"),accountId:idSchema,accountLabel:labelSchema,calendarId:idSchema,calendarLabel:labelSchema,sourceZone:zoneSchema}).strict();
export type SelectionItem = z.infer<typeof selectionItemSchema>;
const uniquePairs = (items: readonly {accountId:string;calendarId:string}[]) => new Set(items.map(s => JSON.stringify([s.accountId,s.calendarId]))).size === items.length;
export const selectionSchema = z.array(selectionItemSchema).max(20).refine(uniquePairs);
const preferencesFields = {morningTime:morningTimeSchema,syncZone:zoneSchema,showTitles:z.boolean(),showAllDay:z.boolean(),selection:selectionSchema};
export const preferencesSchema = z.object({format:z.literal("murage.today-calendar-preferences"),version:z.literal(1),...preferencesFields}).strict()
  .refine(value => bytes(JSON.stringify(value)) <= TODAY_CALENDAR_LIMITS.preferencesBytes);
export type InactivePreferences = z.infer<typeof preferencesSchema>;
/** Validate bytes before JSON.parse; both Python and TS capture/restore use the same 64-KiB ceiling. */
export function parseInactivePreferences(raw: string | Uint8Array): InactivePreferences {
  const size = typeof raw === "string" ? bytes(raw) : raw.byteLength;
  if (size > TODAY_CALENDAR_LIMITS.preferencesBytes) throw new Error("invalid_input");
  const text = typeof raw === "string" ? raw : new TextDecoder("utf-8", {fatal:true,ignoreBOM:true}).decode(raw);
  return preferencesSchema.parse(JSON.parse(text));
}
const settingsFields = {version:z.literal(1),enabled:z.boolean(),generation:counterSchema,...preferencesFields,lastMutationId:uuidSchema.nullable()};
export const settingsV1Schema = z.object({...settingsFields,ownerBinding:ownerBindingSchema.nullable(),consentedAt:instantSchema.nullable()}).strict()
  .refine(s => s.enabled ? s.ownerBinding !== null && s.consentedAt !== null && s.selection.length > 0 : s.consentedAt === null);
export type SettingsV1 = z.infer<typeof settingsV1Schema>;
export const ownerSettingsSchema = z.object({...settingsFields,hasConsent:z.boolean()}).strict().refine(s => s.enabled === s.hasConsent && (!s.enabled || s.selection.length > 0));
export type OwnerSettings = z.infer<typeof ownerSettingsSchema>;
export const mutationSelectionSchema = z.array(z.object({accountId:idSchema,calendarId:idSchema,discoveryId:z.string().min(1).max(200).nullable()}).strict()).max(20).refine(uniquePairs);
export const settingsMutationSchema = z.object({...expectedStampSchema.shape,mutationId:uuidSchema,enabled:z.boolean(),selection:mutationSelectionSchema,morningTime:morningTimeSchema,syncZone:zoneSchema,showTitles:z.boolean(),showAllDay:z.boolean()}).strict().refine(s => !s.enabled || s.selection.length > 0);
export type SettingsMutation = z.infer<typeof settingsMutationSchema>;
export const discoveryAccountsRequestSchema = z.object({...expectedStampSchema.shape,requestId:uuidSchema,metadataConsent:z.literal(true)}).strict();
export const discoveryCalendarsRequestSchema = discoveryAccountsRequestSchema.extend({accountId:idSchema}).strict();
export const refreshRequestSchema = z.object({...expectedStampSchema.shape,requestId:uuidSchema}).strict();
export const stopRequestSchema = z.object({...expectedStampSchema.shape,mutationId:uuidSchema}).strict();
export type DiscoveryAccountsRequest = z.infer<typeof discoveryAccountsRequestSchema>;
export type DiscoveryCalendarsRequest = z.infer<typeof discoveryCalendarsRequestSchema>;
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;
export type StopRequest = z.infer<typeof stopRequestSchema>;
export const todayStepUpModeSchema = z.enum(["none","native","web-device-key","web-passkey"]);
export type TodayStepUpMode = z.infer<typeof todayStepUpModeSchema>;
export type TodayWriteAction = "save" | "discover" | "refresh" | "stop";
export const capabilitiesSchema = z.object({
  canRead:z.boolean(),canDiscover:z.boolean(),canEdit:z.boolean(),canRefresh:z.boolean(),canStop:z.boolean(),canConnectAccount:z.boolean(),canDisconnectAccount:z.boolean(),
  requiresStepUp:z.array(z.enum(["discover","save","refresh","stop","connect","disconnect"])).max(6).refine(a => new Set(a).size === a.length),credentialHandoff:z.literal("computer").nullable(),stepUp:todayStepUpModeSchema,
}).strict();
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export const RUN_STATUSES = ["queued","claimed","running","retry_wait","succeeded","failed","cancelled","expired","interrupted"] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = Object.freeze({
  queued:["claimed","cancelled","expired"],claimed:["running","cancelled","expired","interrupted"],
  running:["succeeded","retry_wait","failed","cancelled","expired","interrupted"],retry_wait:["claimed","cancelled","expired"],
  interrupted:["retry_wait","failed","expired","cancelled"],succeeded:[],failed:[],cancelled:[],expired:[],
});
/** Structural transitions only; S1 also checks CAS, lease, retry budget, current day and authority. */
export function canTransitionRun(from: string, to: string): boolean {
  return Object.hasOwn(RUN_TRANSITIONS, from) && RUN_TRANSITIONS[from as RunStatus].includes(to as RunStatus);
}
export const claimSchema = z.object({runId:uuidSchema,leaseToken:idSchema,leaseExpiresAt:instantSchema,ownerBinding:ownerBindingSchema,generation:counterSchema,authorityEpoch:idSchema}).strict();
export type Claim = z.infer<typeof claimSchema>;
// PROVISIONAL INTERFACE: §4 names metadataThrottle but not its structure. Bounded rolling starts,
// scoped by exact account (null = accounts inventory), retain the home window across restart.
export const metadataThrottleSchema = z.array(z.object({accountId:idSchema.nullable(),startedAt:instantSchema}).strict()).max(20);
export const schedulerStateV1Schema = z.object({automaticDateHighWater:civilDateSchema.nullable(),automaticNotBefore:instantSchema.nullable(),lastAutomaticZone:zoneSchema.nullable(),lastAutomaticClaimAt:instantSchema.nullable(),manualNotBefore:instantSchema,metadataThrottle:metadataThrottleSchema,executionClaim:claimSchema.nullable()}).strict();
export type SchedulerStateV1 = z.infer<typeof schedulerStateV1Schema>;
export const runV1Schema = z.object({
  runId:uuidSchema,kind:z.enum(["automatic","manual"]),idempotencyKey:idSchema,ownerBinding:ownerBindingSchema,generation:counterSchema,syncDate:civilDateSchema,syncZone:zoneSchema,
  coverageStart:instantSchema,coverageEnd:instantSchema,scheduledAt:instantSchema,status:runStatusSchema,attemptsSpent:counterSchema,maxAttempts:z.union([z.literal(1),z.literal(3)]),
  nextRetryAt:instantSchema.nullable(),startedAt:instantSchema.nullable(),finishedAt:instantSchema.nullable(),error:errorCodeSchema.nullable(),
}).strict().refine(r => r.coverageStart < r.coverageEnd && r.attemptsSpent <= r.maxAttempts && r.maxAttempts === (r.kind === "automatic" ? 3 : 1));
export type RunV1 = z.infer<typeof runV1Schema>;
export const coverageSchema = z.object({start:instantSchema,end:instantSchema,date:civilDateSchema,zone:zoneSchema}).strict().refine(c => c.start < c.end);
export type Coverage = z.infer<typeof coverageSchema>;
export const meetingWhenSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("timed"),start:instantSchema,end:instantSchema}).strict().refine(w => w.start < w.end),
  z.object({kind:z.literal("all_day"),startDate:civilDateSchema,endDate:civilDateSchema,sourceZone:zoneSchema,overlapStart:instantSchema,overlapEnd:instantSchema}).strict().refine(w => w.startDate < w.endDate && w.overlapStart < w.overlapEnd),
]);
const meetingFields = {calendarLabel:labelSchema,sourceZone:zoneSchema,privacy:privacySchema,tentative:z.boolean(),title:plainText(300).refine(s => s.trim().length > 0),when:meetingWhenSchema};
const safePrivacy = (r: {privacy:string;title:string}) => r.privacy === "public" || r.privacy === "default" || r.title === "Busy";
// PROVISIONAL INTERFACE: the design names the identity tuple; DateValue preserves its final tagged element.
export const eventIdentitySchema = z.tuple([z.literal("googlecalendar"),idSchema,idSchema,idSchema,dateValueSchema]);
export const normalizedEventSchema = z.object({rowId:idSchema,identity:eventIdentitySchema,...meetingFields}).strict().refine(safePrivacy);
export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;
export const meetingRowSchema = z.object({id:idSchema,...meetingFields}).strict().refine(safePrivacy);
export type MeetingRow = z.infer<typeof meetingRowSchema>;
export const publishedSnapshotSchema = z.object({ownerEpoch:idSchema,generation:counterSchema,snapshotRevision:counterSchema,checkedAt:instantSchema,coverage:coverageSchema,expiresAt:instantSchema,complete:z.literal(true),rows:z.array(normalizedEventSchema).max(2000)}).strict().refine(s => s.expiresAt === s.coverage.end && s.checkedAt < s.expiresAt);
export type PublishedSnapshot = z.infer<typeof publishedSnapshotSchema>;
const settingsResponseFields = {...stampSchema.shape,settings:ownerSettingsSchema,connections:z.array(accountSummarySchema).max(2000),connectionStatus:z.enum(["known","unknown"]),capabilities:capabilitiesSchema,status:statusSchema,error:errorCodeSchema.nullable(),nextCheckAt:instantSchema.nullable()};
export const settingsResponseSchema = z.object(settingsResponseFields).strict().refine(s => s.generation === s.settings.generation);
export const mutationResponseSchema = z.object({...settingsResponseFields,mutationId:uuidSchema}).strict().refine(s => s.generation === s.settings.generation && s.mutationId === s.settings.lastMutationId);
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;
export type MutationResponse = z.infer<typeof mutationResponseSchema>;
const discoveryResponseFields = {...stampSchema.shape,complete:z.literal(true),discoveryId:z.string().min(1).max(200),expiresAt:instantSchema};
export const discoveryAccountsResponseSchema = z.object({...discoveryResponseFields,accounts:z.array(accountSummarySchema).max(2000)}).strict();
export const discoveryCalendarsResponseSchema = z.object({...discoveryResponseFields,accountId:idSchema,calendars:z.array(calendarItemSchema).max(2000)}).strict();
export type DiscoveryAccountsResponse = z.infer<typeof discoveryAccountsResponseSchema>;
export type DiscoveryCalendarsResponse = z.infer<typeof discoveryCalendarsResponseSchema>;
export const activeRunSchema = z.object({runId:uuidSchema,status:runStatusSchema,nextAttemptAt:instantSchema.nullable()}).strict();
export const refreshResponseSchema = z.object({...stampSchema.shape,runId:uuidSchema,coalesced:z.boolean(),runStatus:runStatusSchema,nextAttemptAt:instantSchema.nullable(),manualNotBefore:instantSchema}).strict();
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;
export const snapshotResponseSchema = z.object({
  ...stampSchema.shape,status:statusSchema,error:errorCodeSchema.nullable(),checkedAt:instantSchema.nullable(),coverage:coverageSchema.nullable(),expiresAt:instantSchema.nullable(),nextCheckAt:instantSchema.nullable(),activeRun:activeRunSchema.nullable(),rows:z.array(meetingRowSchema).max(2000),complete:z.boolean(),
}).strict().refine(s => s.complete
  ? (s.status === "ready" || s.status === "refresh_failed") && s.checkedAt !== null && s.coverage !== null && s.expiresAt === s.coverage.end && s.checkedAt < s.expiresAt
  : s.status !== "ready" && s.status !== "refresh_failed" && s.rows.length === 0 && s.checkedAt === null && s.coverage === null && s.expiresAt === null);
export type SnapshotResponse = z.infer<typeof snapshotResponseSchema>;
export const invalidationReasonSchema = z.enum(["ready","published","settings","off","titles_hidden","visibility","account_invalid","authority_lost","expired","shutdown","heartbeat"]);
export type InvalidationReason = z.infer<typeof invalidationReasonSchema>;
export const ownerInvalidationSchema = z.object({...stampSchema.shape,reason:invalidationReasonSchema}).strict();
export type OwnerInvalidation = z.infer<typeof ownerInvalidationSchema>;
export const invalidationEventSchema = z.enum(["ready","invalidate","heartbeat","closing"]);
export const stepUpRefusalSchema = z.object({error:z.object({code:z.literal("step_up_required")}).strict()}).strict();
export const apiErrorSchema = z.union([
  z.object({error:z.object({code:z.enum(ERROR_CODES.filter(code => code !== "throttled"))}).strict()}).strict(),
  z.object({error:z.object({code:z.literal("throttled")}).strict(),retryAt:instantSchema}).strict(),
]);
export type ApiError = z.infer<typeof apiErrorSchema>;
export const TODAY_CALENDAR_ROUTES = [
  ["GET","/api/today-calendar/settings"],["POST","/api/today-calendar/accounts"],["POST","/api/today-calendar/calendars"],
  ["PUT","/api/today-calendar/settings"],["POST","/api/today-calendar/refresh"],["DELETE","/api/today-calendar/selection"],
  ["GET","/api/today-calendar/snapshot"],["GET","/api/today-calendar/events"],
] as const;
