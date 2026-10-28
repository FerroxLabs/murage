import { describe, expect, it } from "vitest";
import { PHONE_TOOL_NAMES } from "./phone-jobs-contract.ts";
import { normalizePhoneApps, narrowedCapabilities, phoneTools, type PhoneReport } from "./phone-apps.ts";

const fullReport: PhoneReport = { calendar: "full", reminders: true, contacts: "full", location: "precise", alarms: true, messages: true, calls: true };

describe("normalizePhoneApps", () => {
  it("treats absent input and absent keys as off", () => {
    expect(normalizePhoneApps(undefined)).toEqual({ ok: true, value: {} });
    expect(normalizePhoneApps({})).toEqual({ ok: true, value: {} });
    expect(normalizePhoneApps({ calendar: "read" })).toEqual({ ok: true, value: { calendar: "read" } });
  });
  it("accepts every value of the catalog", () => {
    const all = { calendar: "change", reminders: "change", contacts: "read", location: "precise", alarms: "set", messages: "compose", calls: "dial" };
    expect(normalizePhoneApps(all)).toEqual({ ok: true, value: all });
    for (const v of ["read", "add", "change"]) expect(normalizePhoneApps({ calendar: v }).ok).toBe(true);
    for (const v of ["approximate", "precise"]) expect(normalizePhoneApps({ location: v }).ok).toBe(true);
  });
  it("refuses every value outside the catalog", () => {
    const bad: unknown[] = [
      { calendar: "delete" }, { calendar: "" }, { calendar: true }, { calendar: null }, { calendar: ["read"] }, { calendar: "READ" },
      { reminders: "add" }, { reminders: "read " }, { contacts: "write" }, { contacts: "change" }, { location: "always" }, { location: "exact" },
      { alarms: "delete" }, { messages: "send" }, { calls: "call" }, { calls: 1 },
    ];
    for (const raw of bad) expect(normalizePhoneApps(raw).ok, JSON.stringify(raw)).toBe(false);
  });
  it("refuses unknown keys, inherited keys and non-objects", () => {
    for (const raw of [{ camera: "read" }, { calendar: "read", extra: "x" }, JSON.parse('{"__proto__":{"calendar":"read"}}'), { constructor: "read" }, "calendar", 5, [], [{ calendar: "read" }], null]) {
      expect(normalizePhoneApps(raw).ok, JSON.stringify(raw)).toBe(false);
    }
  });
  it("names the problem and does not mutate or alias the input", () => {
    const r = normalizePhoneApps({ calendar: "delete" });
    expect(r.ok === false && r.error).toMatch(/calendar/);
    const input = { calendar: "read" };
    const out = normalizePhoneApps(input);
    expect(out.ok && out.value).not.toBe(input);
  });
});

describe("phoneTools", () => {
  it("gives no tools for an empty grant, whatever the phone reports", () => {
    expect(phoneTools({}, fullReport)).toEqual([]);
  });
  it("gives no tools for a grant the phone does not report", () => {
    expect(phoneTools({ calendar: "read", reminders: "read", contacts: "read", location: "approximate", alarms: "set", messages: "compose", calls: "dial" }, {})).toEqual([]);
  });
  it("maps calendar grants", () => {
    expect(phoneTools({ calendar: "read" }, fullReport)).toEqual(["phone_calendar_read", "phone_calendar_find_free_time"]);
    expect(phoneTools({ calendar: "add" }, fullReport)).toEqual(["phone_calendar_add"]);
    expect(phoneTools({ calendar: "change" }, fullReport)).toEqual(["phone_calendar_read", "phone_calendar_find_free_time", "phone_calendar_add", "phone_calendar_change"]);
  });
  it("write-only calendar report lists add only (D14)", () => {
    const r: PhoneReport = { calendar: "write-only" };
    expect(phoneTools({ calendar: "change" }, r)).toEqual(["phone_calendar_add"]);
    expect(phoneTools({ calendar: "add" }, r)).toEqual(["phone_calendar_add"]);
    expect(phoneTools({ calendar: "read" }, r)).toEqual([]);
  });
  it("maps reminders; an Android phone never reports them", () => {
    expect(phoneTools({ reminders: "read" }, fullReport)).toEqual(["phone_reminders_read"]);
    expect(phoneTools({ reminders: "change" }, fullReport)).toEqual(["phone_reminders_read", "phone_reminders_add", "phone_reminders_complete"]);
    expect(phoneTools({ reminders: "change" }, { reminders: false })).toEqual([]);
  });
  it("maps contacts for full and limited access", () => {
    expect(phoneTools({ contacts: "read" }, { contacts: "full" })).toEqual(["phone_contacts_search", "phone_contacts_get"]);
    expect(phoneTools({ contacts: "read" }, { contacts: "limited" })).toEqual(["phone_contacts_search", "phone_contacts_get"]);
  });
  it("location precise with an approximate report gives the one location tool, no more", () => {
    expect(phoneTools({ location: "precise" }, { location: "approximate" })).toEqual(["phone_location_get"]);
    expect(phoneTools({ location: "approximate" }, { location: "precise" })).toEqual(["phone_location_get"]);
    expect(phoneTools({ location: "approximate" }, {})).toEqual([]);
  });
  it("alarms are not listed below iOS 26 (F16)", () => {
    expect(phoneTools({ alarms: "set" }, { alarms: true })).toEqual(["phone_alarm_set", "phone_timer_set"]);
    expect(phoneTools({ alarms: "set" }, { alarms: false })).toEqual([]);
  });
  it("messages and calls", () => {
    expect(phoneTools({ messages: "compose", calls: "dial" }, fullReport)).toEqual(["phone_text_compose", "phone_call_dial"]);
    expect(phoneTools({ messages: "compose", calls: "dial" }, { messages: false, calls: false })).toEqual([]);
  });
  it("only ever returns known tool names, once each", () => {
    const all = phoneTools({ calendar: "change", reminders: "change", contacts: "read", location: "precise", alarms: "set", messages: "compose", calls: "dial" }, fullReport);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...PHONE_TOOL_NAMES].sort());
  });
});

describe("narrowedCapabilities", () => {
  it("reports calendar when change narrows to read", () => {
    expect(narrowedCapabilities({ calendar: "change" }, { calendar: "read" })).toEqual(["calendar"]);
  });
  it("reports a removed key, and reports nothing for no change or widening", () => {
    expect(narrowedCapabilities({ calls: "dial", contacts: "read" }, { contacts: "read" })).toEqual(["calls"]);
    expect(narrowedCapabilities({ calendar: "read" }, { calendar: "read" })).toEqual([]);
    expect(narrowedCapabilities({ calendar: "read" }, { calendar: "change" })).toEqual([]);
    expect(narrowedCapabilities({}, { calendar: "change" })).toEqual([]);
  });
  it("reports a sideways move that drops a tool, and precise to approximate", () => {
    expect(narrowedCapabilities({ calendar: "read" }, { calendar: "add" })).toEqual(["calendar"]);
    expect(narrowedCapabilities({ location: "precise" }, { location: "approximate" })).toEqual(["location"]);
    expect(narrowedCapabilities({ reminders: "change" }, { reminders: "read" })).toEqual(["reminders"]);
  });
  it("lists several in catalog order", () => {
    expect(narrowedCapabilities({ calls: "dial", calendar: "read", alarms: "set" }, {})).toEqual(["calendar", "alarms", "calls"]);
  });
});
