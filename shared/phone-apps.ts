// Per-bot phone grants (lock two, design §5/§6) and the tool list a turn sees: grant ∩ what the phone reports.
import { PHONE_CAPABILITIES, type PhoneCapability, type PhoneToolName } from "./phone-jobs-contract.ts";

export type PhoneApps = Partial<{
  calendar: "read" | "add" | "change";
  reminders: "read" | "change";
  contacts: "read";
  location: "approximate" | "precise";
  alarms: "set";
  messages: "compose";
  calls: "dial";
}>;

export interface PhoneReport {
  calendar?: "full" | "write-only";
  reminders?: boolean;
  contacts?: "full" | "limited";
  location?: "approximate" | "precise";
  alarms?: boolean;
  messages?: boolean;
  calls?: boolean;
}

/** The values each capability may hold besides off (an absent key). The web card renders one choice per entry. */
export const PHONE_APP_VALUES: Record<PhoneCapability, readonly string[]> = {
  calendar: ["read", "add", "change"],
  reminders: ["read", "change"],
  contacts: ["read"],
  location: ["approximate", "precise"],
  alarms: ["set"],
  messages: ["compose"],
  calls: ["dial"],
};

/** Absent key = off. Unknown keys and values are refused; the result is a fresh object. */
export function normalizePhoneApps(raw: unknown): { ok: true; value: PhoneApps } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: {} };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "phoneApps must be an object" };
  const out: Record<string, string> = {};
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(PHONE_APP_VALUES, key)) return { ok: false, error: `unknown phone app: ${key.slice(0, 40)}` };
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v !== "string" || !PHONE_APP_VALUES[key as PhoneCapability].includes(v)) return { ok: false, error: `invalid value for ${key}` };
    out[key] = v;
  }
  return { ok: true, value: out as PhoneApps };
}

/** Tools the grant allows on a phone that reports `report` (design §5). Order is stable: catalog order. */
export function phoneTools(grant: PhoneApps, report: PhoneReport): PhoneToolName[] {
  const t: PhoneToolName[] = [];
  const cal = Object.hasOwn(grant, "calendar") ? grant.calendar : undefined;
  if ((cal === "read" || cal === "change") && report.calendar === "full") t.push("phone_calendar_read", "phone_calendar_find_free_time");
  if ((cal === "add" || cal === "change") && (report.calendar === "full" || report.calendar === "write-only")) t.push("phone_calendar_add");
  if (cal === "change" && report.calendar === "full") t.push("phone_calendar_change");
  const rem = grant.reminders;
  if (report.reminders === true && rem !== undefined) {
    t.push("phone_reminders_read");
    if (rem === "change") t.push("phone_reminders_add", "phone_reminders_complete");
  }
  if (grant.contacts === "read" && (report.contacts === "full" || report.contacts === "limited")) t.push("phone_contacts_search", "phone_contacts_get");
  // One tool; the grant and report bound its precision (see locationPrecision).
  if (grant.location !== undefined && (report.location === "approximate" || report.location === "precise")) t.push("phone_location_get");
  if (grant.alarms === "set" && report.alarms === true) t.push("phone_alarm_set", "phone_timer_set");
  if (grant.messages === "compose" && report.messages === true) t.push("phone_text_compose");
  if (grant.calls === "dial" && report.calls === true) t.push("phone_call_dial");
  return t;
}

/** The most precise location a turn may ask for: the lesser of the grant and the report, or null. */
export function locationPrecision(grant: PhoneApps, report: PhoneReport): "approximate" | "precise" | null {
  if (grant.location === undefined || report.location === undefined) return null;
  return grant.location === "precise" && report.location === "precise" ? "precise" : "approximate";
}

const ALL_REPORTED: PhoneReport = { calendar: "full", reminders: true, contacts: "full", location: "precise", alarms: true, messages: true, calls: true };
const CAPABILITY_OF = (tool: PhoneToolName): PhoneCapability =>
  tool.startsWith("phone_calendar") ? "calendar" : tool.startsWith("phone_reminders") ? "reminders" : tool.startsWith("phone_contacts") ? "contacts"
    : tool === "phone_location_get" ? "location" : tool === "phone_alarm_set" || tool === "phone_timer_set" ? "alarms" : tool === "phone_text_compose" ? "messages" : "calls";

/** Capabilities whose grant lost a tool or precision between `before` and `after`; the caller revokes their open jobs (F7). Catalog order. */
export function narrowedCapabilities(before: PhoneApps, after: PhoneApps): PhoneCapability[] {
  const had = phoneTools(before, ALL_REPORTED);
  const has = new Set(phoneTools(after, ALL_REPORTED));
  const lost = new Set(had.filter((n) => !has.has(n)).map(CAPABILITY_OF));
  if (before.location === "precise" && after.location === "approximate") lost.add("location");
  return PHONE_CAPABILITIES.filter((c) => lost.has(c));
}
