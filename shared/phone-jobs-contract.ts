// Phone-jobs contract shared by the harness (server) and tested against the
// fixtures in apps/mobile/contract/phone-jobs.json, which Swift and Java read too.
// The companion door cannot import shared/ (TS6059 under build:companion), so it keeps
// a byte-for-byte twin of the tag, token pattern, message builder and keyId (plan B8).
// No imports beyond zod, and no Node builtins: web code loads this module. The keyId hash lives in
// shared/phone-jobs-hash.ts (server and door side only); shared/web-safe-imports.test.ts guards this.
import { z } from "zod";

export const PHONE_JOBS_TAG = "murage-phone-jobs/1";
export const PHONE_JOBS_TTL_MS = 60000;
export const PHONE_TOKEN = /^murage_pj_[A-Za-z0-9_-]{43}$/;
export const RESULT_MAX_BYTES = 262144;

export const PHONE_CAPABILITIES = ["calendar", "reminders", "contacts", "location", "alarms", "messages", "calls"] as const;
export type PhoneCapability = (typeof PHONE_CAPABILITIES)[number];
export const RESULT_CODES = ["denied", "unsupported", "too_large", "invalid_result", "declined"] as const;

export interface PhoneJobsMessageFields { origin: string; keyId: string; nonce: string; expiresAt: number }

/** UTF-8 of tag, origin, keyId, nonce and decimal expiresAt joined by LF, no trailing newline. */
export function phoneJobsMessage(f: PhoneJobsMessageFields): string {
  return [PHONE_JOBS_TAG, f.origin, f.keyId, f.nonce, String(f.expiresAt)].join("\n");
}

const text = (max: number) => z.string().min(1).max(max);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuid4 = z.string().regex(UUID_V4);
const LEASE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const leaseToken = z.string().regex(LEASE_TOKEN);

const capability = z.enum(PHONE_CAPABILITIES);

const report = z.strictObject({
  calendar: z.enum(["full", "write-only"]).optional(),
  reminders: z.boolean().optional(),
  contacts: z.enum(["full", "limited"]).optional(),
  location: z.enum(["approximate", "precise"]).optional(),
  alarms: z.boolean().optional(),
  messages: z.boolean().optional(),
  calls: z.boolean().optional(),
});

/** Body of PUT /api/phones/self. The device id comes from the bearer, never the body. */
export const registrationSchema = z.strictObject({
  name: text(80),
  platform: z.enum(["ios", "android"]),
  osVersion: text(40),
  appVersion: text(40),
  timeZone: text(64),
  protocol: z.literal(1),
  capabilities: report,
});

export const offerSchema = z.strictObject({
  operationId: uuid4,
  offerId: uuid4,
  workspace: text(120),
  bot: z.strictObject({ id: text(128), name: text(120) }),
  capability,
  action: z.string().regex(/^[a-z]+\.[a-z_]+$/).max(48),
  args: z.record(z.string(), z.unknown()),
  say: text(240),
  provider: z.strictObject({ id: text(64), name: text(120) }),
  expiresAt: z.number().int().positive(),
  leaseMs: z.union([z.literal(45000), z.literal(180000)]),
});

export const pollSchema = z.strictObject({ jobs: z.array(offerSchema).max(1) });

export const leaseRequestSchema = z.strictObject({ offerId: uuid4 });

export const leaseAnswerSchema = z.union([
  z.strictObject({ active: z.literal(true), leaseToken }),
  z.strictObject({ active: z.literal(false) }),
]);

const withinResultBound = (v: unknown): boolean => {
  try {
    const s = JSON.stringify(v);
    return s === undefined || new TextEncoder().encode(s).length <= RESULT_MAX_BYTES;
  } catch {
    return false;
  }
};

/** ok true carries result and no error/code; ok false carries a code (and a short error) and no result. The JSON of the result is at most RESULT_MAX_BYTES. */
export const resultSchema = z
  .strictObject({
    leaseToken,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().min(1).max(500).optional(),
    code: z.enum(RESULT_CODES).optional(),
  })
  .refine((b) => (b.ok ? b.error === undefined && b.code === undefined : b.code !== undefined && b.result === undefined), { message: "ok/result/error/code mismatch" })
  .refine((b) => withinResultBound(b.result), { message: "result too large" });

export type PhoneJobOffer = z.infer<typeof offerSchema>;
export type ResultBody = z.infer<typeof resultSchema>;

// ---- S1b: per-action arguments and results, and the targeted read ----

export const PHONE_TOOL_NAMES = [
  "phone_calendar_read", "phone_calendar_find_free_time", "phone_calendar_add", "phone_calendar_change",
  "phone_reminders_read", "phone_reminders_add", "phone_reminders_complete",
  "phone_contacts_search", "phone_contacts_get", "phone_location_get",
  "phone_alarm_set", "phone_timer_set", "phone_text_compose", "phone_call_dial",
] as const;
export type PhoneToolName = (typeof PHONE_TOOL_NAMES)[number];

export const PHONE_ACTIONS: Record<PhoneToolName, { action: string; capability: PhoneCapability }> = {
  phone_calendar_read: { action: "calendar.read", capability: "calendar" },
  phone_calendar_find_free_time: { action: "calendar.free_time", capability: "calendar" },
  phone_calendar_add: { action: "calendar.add", capability: "calendar" },
  phone_calendar_change: { action: "calendar.change", capability: "calendar" },
  phone_reminders_read: { action: "reminders.read", capability: "reminders" },
  phone_reminders_add: { action: "reminders.add", capability: "reminders" },
  phone_reminders_complete: { action: "reminders.complete", capability: "reminders" },
  phone_contacts_search: { action: "contacts.search", capability: "contacts" },
  phone_contacts_get: { action: "contacts.get", capability: "contacts" },
  phone_location_get: { action: "location.get", capability: "location" },
  phone_alarm_set: { action: "alarms.set", capability: "alarms" },
  phone_timer_set: { action: "alarms.timer", capability: "alarms" },
  phone_text_compose: { action: "messages.compose", capability: "messages" },
  phone_call_dial: { action: "calls.dial", capability: "calls" },
};

const DAY_MS = 86400000;
/** ISO 8601 date-time with an offset (Z or +hh:mm), and a real calendar instant. */
const isoTime = z
  .string()
  .max(40)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "not a real time" });
const id = z.string().min(1).max(256);
const bound = (max: number) => z.string().max(max);
const intIn = (min: number, max: number) => z.number().int().min(min).max(max);
const t = (s: string) => Date.parse(s);

const range = (maxDays: number) => (a: { start: string; end: string }) => t(a.end) > t(a.start) && t(a.end) - t(a.start) <= maxDays * DAY_MS;

const Event = z.strictObject({
  id, title: bound(500), start: isoTime, end: isoTime, allDay: z.boolean(), calendar: bound(200),
  location: bound(500).optional(), notes: bound(4000).optional(),
});
const Contact = z.strictObject({
  id, name: bound(200),
  phones: z.array(z.strictObject({ label: bound(50).optional(), number: bound(40).min(1) })).max(10),
  emails: z.array(z.strictObject({ label: bound(50).optional(), address: bound(254).min(1) })).max(10),
});
const outcome = z.strictObject({ outcome: z.enum(["set", "clock_app_opened"]) });

export const actionArgsSchema: Record<string, z.ZodType> = {
  "calendar.read": z.strictObject({ start: isoTime, end: isoTime, includeNotes: z.boolean().optional(), limit: intIn(1, 200).optional() }).refine(range(31), { message: "end after start, at most 31 days" }),
  "calendar.free_time": z.strictObject({ start: isoTime, end: isoTime, durationMinutes: intIn(5, 480), limit: intIn(1, 20).optional() }).refine(range(14), { message: "end after start, at most 14 days" }),
  "calendar.add": z
    .strictObject({ title: text(500), start: isoTime, end: isoTime, allDay: z.boolean().optional(), location: bound(500).optional(), notes: bound(4000).optional() })
    .refine((a) => t(a.end) > t(a.start), { message: "end after start" }),
  "calendar.change": z
    .strictObject({ id, title: text(500).optional(), start: isoTime.optional(), end: isoTime.optional(), location: bound(500).optional(), notes: bound(4000).optional() })
    .refine((a) => a.title !== undefined || a.start !== undefined || a.end !== undefined || a.location !== undefined || a.notes !== undefined, { message: "nothing to change" }),
  "reminders.read": z.strictObject({ includeCompleted: z.boolean().optional(), limit: intIn(1, 200).optional() }),
  "reminders.add": z.strictObject({ title: text(500), due: bound(64).optional(), notes: bound(4000).optional() }),
  "reminders.complete": z.strictObject({ id }),
  "contacts.search": z.strictObject({ query: text(100), limit: intIn(1, 25).optional() }),
  "contacts.get": z.strictObject({ id }),
  "location.get": z.strictObject({ precision: z.enum(["approximate", "precise"]) }),
  "alarms.set": z.strictObject({ hour: intIn(0, 23), minute: intIn(0, 59), label: bound(100).optional() }),
  "alarms.timer": z.strictObject({ seconds: intIn(1, 86400), label: bound(100).optional() }),
  "messages.compose": z.strictObject({ to: z.array(text(40)).min(1).max(10), body: bound(2000) }),
  "calls.dial": z.strictObject({ number: text(40) }),
};

export const actionResultSchema: Record<string, z.ZodType> = {
  "calendar.read": z.strictObject({ events: z.array(Event).max(200), truncated: z.boolean() }),
  "calendar.free_time": z.strictObject({ slots: z.array(z.strictObject({ start: isoTime, end: isoTime })).max(20) }),
  "calendar.add": z.strictObject({ id, writeOnly: z.boolean() }),
  "calendar.change": z.strictObject({ id }),
  "reminders.read": z.strictObject({
    reminders: z.array(z.strictObject({ id, title: bound(500), due: bound(64).optional(), completed: z.boolean(), list: bound(200) })).max(200),
    truncated: z.boolean(),
  }),
  "reminders.add": z.strictObject({ id }),
  "reminders.complete": z.strictObject({ id, completed: z.literal(true) }),
  "contacts.search": z.strictObject({ contacts: z.array(Contact).max(25), limited: z.boolean() }),
  "contacts.get": z.strictObject({ contact: Contact.nullable(), limited: z.boolean() }),
  "location.get": z.strictObject({
    lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), accuracyMeters: z.number().min(0),
    precision: z.enum(["approximate", "precise"]), at: bound(64).min(1),
  }),
  "alarms.set": outcome,
  "alarms.timer": outcome,
  "messages.compose": z.strictObject({ outcome: z.literal("opened_for_you_to_send") }),
  "calls.dial": z.strictObject({ outcome: z.literal("dialer_opened") }),
};

const ACTION_CAPABILITY = new Map<string, PhoneCapability>(Object.values(PHONE_ACTIONS).map((a) => [a.action, a.capability]));

/** The offer's action is known, its capability matches that action, and its args parse. */
export function offerArgsValid(offer: PhoneJobOffer): boolean {
  const cap = ACTION_CAPABILITY.get(offer.action);
  if (cap === undefined || cap !== offer.capability) return false;
  return actionArgsSchema[offer.action].safeParse(offer.args).success;
}

/** The result is within RESULT_MAX_BYTES and parses for the action. Unknown actions are refused. */
export function resultValid(action: string, result: unknown): boolean {
  const schema = actionResultSchema[action];
  if (schema === undefined || !withinResultBound(result)) return false;
  return schema.safeParse(result).success;
}

/** Answer of GET /api/phones/self/jobs?eventRef=<64 hex> and GET /api/phones/self/jobs/:operationId. */
export type TargetedAnswer =
  | { jobs: [PhoneJobOffer] }
  | { leased: true; expiresAt: number }
  | { handled: true; reason: "done" | "revoked" | "ended" | "unknown" };

export const targetedAnswerSchema: z.ZodType<TargetedAnswer> = z.union([
  z.strictObject({ jobs: z.tuple([offerSchema]) }),
  z.strictObject({ leased: z.literal(true), expiresAt: z.number().int().positive() }),
  z.strictObject({ handled: z.literal(true), reason: z.enum(["done", "revoked", "ended", "unknown"]) }),
]);
