// 1.0.9 phone tools S21. The renderer has no DOM in vitest here, so the card is split into pure pieces (mode, merge, grant, save) and a
// presentational view that renders to static markup; the container only wires them to fetches.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PHONE_CARD_COPY, PHONE_COPY } from "../../shared/phone-copy";
import { driverMountsPhoneJobs } from "../../server/phone-jobs-engines";
import { mergePhones, nextGrant, PhoneAccessView, phoneCardMode, savePhoneApps, type PhoneDeviceRow } from "./PhoneAccessCard";

const view = (mode: "hidden" | "cloud" | "engine" | "ready", extra: { grant?: object; rows?: PhoneDeviceRow[] } = {}) =>
  renderToStaticMarkup(createElement(PhoneAccessView, { mode, grant: extra.grant ?? {}, rows: extra.rows ?? [], busy: false, error: null, onChange: () => {} }));
const esc = (s: string) => s.replace(/'/g, "&#x27;");

describe("when the card shows", () => {
  it("is hidden on a desktop that does not offer phone tools, and off the desktop surface", () => {
    expect(phoneCardMode({ cloud: false, desktop: true, offered: false, engineMounts: true })).toBe("hidden");
    expect(phoneCardMode({ cloud: false, desktop: true, offered: null, engineMounts: true })).toBe("hidden");
    expect(phoneCardMode({ cloud: false, desktop: false, offered: true, engineMounts: true })).toBe("hidden");
    expect(view("hidden")).toBe("");
  });
  it("is hidden on Cloud while the host flag is off or unknown (flag off is 1.0.8)", () => {
    expect(phoneCardMode({ cloud: true, desktop: true, offered: false, engineMounts: true, flag: false })).toBe("hidden");
    expect(phoneCardMode({ cloud: true, desktop: true, offered: false, engineMounts: true, flag: null })).toBe("hidden");
    expect(phoneCardMode({ cloud: true, desktop: true, offered: false, engineMounts: true })).toBe("hidden");
  });
  it("says Coming to Murage Cloud on a Cloud home with the flag on, with no toggles", () => {
    expect(phoneCardMode({ cloud: true, desktop: true, offered: false, engineMounts: true, flag: true })).toBe("cloud");
    const html = view("cloud");
    expect(html).toContain(PHONE_COPY.cloud);
    expect(html).not.toContain("<select");
  });
  it("says the engine cannot use phone tools, with no toggles", () => {
    expect(phoneCardMode({ cloud: false, desktop: true, offered: true, engineMounts: false })).toBe("engine");
    const html = view("engine");
    expect(html).toContain(esc(PHONE_CARD_COPY.engineUnsupported));
    expect(html).not.toContain("<select");
    expect(driverMountsPhoneJobs("openclawAgent")).toBe(false);
    expect(driverMountsPhoneJobs("antigravityAgent")).toBe(false);
  });
});

describe("grant rows", () => {
  it("renders one row per capability, Off by default, with the section 6 values", () => {
    const html = view("ready");
    expect((html.match(/<select/g) ?? []).length).toBe(7);
    expect((html.match(/<option value="off" selected/g) ?? []).length).toBe(7);
    for (const v of ["read", "add", "change", "approximate", "precise", "set", "compose", "dial"]) expect(html).toContain(`value="${v}"`);
    expect(html).not.toContain('value="write"');
  });
  it("shows a stored grant as selected", () => {
    const html = view("ready", { grant: { calendar: "add", location: "precise" } });
    expect(html).toMatch(/<option value="add" selected/);
    expect(html).toMatch(/<option value="precise" selected/);
  });
  it("toggling sends exactly { phoneApps } and Off removes the key", async () => {
    expect(nextGrant({}, "calendar", "read")).toEqual({ calendar: "read" });
    expect(nextGrant({ calendar: "read", alarms: "set" }, "calendar", "off")).toEqual({ alarms: "set" });
    const sent: Array<{ path: string; init: RequestInit }> = [];
    await savePhoneApps(async (path, init) => { sent.push({ path, init }); }, "bot 1", { calendar: "change" });
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe("/api/bots/bot%201");
    expect(sent[0].init.method).toBe("PATCH");
    expect(JSON.parse(String(sent[0].init.body))).toEqual({ phoneApps: { calendar: "change" } });
    expect(Object.keys(JSON.parse(String(sent[0].init.body)))).toEqual(["phoneApps"]);
  });
});

describe("device states", () => {
  const paired = [
    { id: "a", name: "Registered phone", phoneJobsReady: true },
    { id: "b", name: "No passcode phone", phoneJobsReady: false },
    { id: "c", name: "Old app phone", phoneJobsReady: true },
    { id: "d", name: "Very old sidecar phone" },
  ];
  const regs = [{ deviceId: "a", name: "Registered phone", capabilities: { calendar: "full" as const, reminders: true, location: "approximate" as const, messages: false } }];
  const rows = mergePhones(paired, regs);
  it("merges paired devices with registrations into one row each", () => {
    expect(rows.map((r) => [r.id, r.state])).toEqual([["a", "registered"], ["b", "passcode"], ["c", "update-app"], ["d", "passcode"]]);
  });
  it("renders each state's line", () => {
    const html = view("ready", { rows });
    expect(html).toContain("Registered phone");
    expect(html).toContain("Reports: Calendar, Reminders, Location</p>");
    expect(html).toContain(PHONE_COPY.passcode);
    expect(html).toContain(PHONE_COPY.oldApp);
  });
  it("says so when no phone is paired", () => {
    expect(view("ready")).toContain(PHONE_CARD_COPY.noPhones);
  });
  it("a registration for a phone the computer no longer lists is still shown", () => {
    expect(mergePhones([], regs).map((r) => r.state)).toEqual(["registered"]);
  });
  it("never shows contents: the card carries only the activity note", () => {
    expect(view("ready", { rows })).toContain(PHONE_CARD_COPY.activityNote);
  });
});

describe("card copy", () => {
  const banned = ["sa" + "fe", "unsa" + "fe", "sa" + "fety"];
  const strings = (v: unknown): string[] => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
  it("has no em dash and no banned word, in the card copy or the rendered markup", () => {
    for (const s of [...strings(PHONE_CARD_COPY), ...strings(PHONE_COPY), view("ready", { rows: mergePhones([{ id: "x", name: "P" }], []) })]) {
      expect(s).not.toMatch(/—/);
      for (const w of banned) expect(s.toLowerCase()).not.toMatch(new RegExp(`\\b${w}\\b`));
    }
  });
});
