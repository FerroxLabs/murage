// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.8 owner time zone (TRIAGE.md a, b, g): the clock line names the owner's
// zone, not the computer's; a daylight saving change near today gets one
// clause; the choice is saved on the owner's profile and travels with it; and
// a connected-app answer whose times are in another zone gets one line.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { comingDaysLine, nowPrompt } from "./bot-shapes.ts";
import { DATA_DIR, loadConfig, parseConfigPatch, parseStoredConfig, saveConfig } from "./config.ts";
import { foreignTimesNote, hasForeignTimes, withForeignTimesNote } from "./connector-time-note.ts";
import {
  applyOwnerTimeZone, chosenOwnerTimeZone, computerTimeZone, daylightSavingNote, nearbyZoneChange, ownerTimeZone, ownerTimeZoneFor,
} from "./owner-time-zone.ts";

const BANGKOK = "Asia/Bangkok";
const CENTRAL = "America/Chicago";
/** 26 October 2026, 8:30 pm in Chicago (CDT), already Tuesday 8:30 am in Bangkok. */
const DEMO_EVENING = new Date("2026-10-27T01:30:00Z");

describe("the clock line for a Central owner on a UTC+07 computer", () => {
  it("follows the computer by default, with no switch", () => {
    expect(ownerTimeZoneFor(undefined, BANGKOK)).toBe(BANGKOK);
    expect(ownerTimeZoneFor("", BANGKOK)).toBe(BANGKOK);
    expect(ownerTimeZoneFor("   ", BANGKOK)).toBe(BANGKOK);
  });

  it("names the owner's chosen zone, day and time, never the computer's", () => {
    const line = nowPrompt(DEMO_EVENING, ownerTimeZoneFor(CENTRAL, BANGKOK));
    expect(line).toContain("It is now Monday, 26 October 2026, 8:30 pm (20:30) in the owner's time zone, America/Chicago (UTC-05:00).");
    expect(line).not.toContain(BANGKOK);
    expect(line).not.toContain("Tuesday");
    // the computer's own line, for contrast: the day the dry run's bot was handed
    expect(nowPrompt(DEMO_EVENING, BANGKOK)).toContain("Tuesday, 27 October 2026, 8:30 am (08:30) in the owner's time zone, Asia/Bangkok (UTC+07:00).");
  });

  it("follows the computer when the saved value is not a zone, so a hand edit never stops a turn", () => {
    expect(chosenOwnerTimeZone("Not/AZone")).toBeNull();
    expect(chosenOwnerTimeZone(42)).toBeNull();
    expect(ownerTimeZoneFor("Not/AZone", BANGKOK)).toBe(BANGKOK);
    expect(chosenOwnerTimeZone(" America/Chicago ")).toBe(CENTRAL);
  });

  describe("on this server", () => {
    afterEach(() => { applyOwnerTimeZone(""); });
    it("makes the chosen zone the server's clock and puts the computer's back when cleared", () => {
      const computer = computerTimeZone();
      const other = computer === CENTRAL ? BANGKOK : CENTRAL;
      const bootTz = process.env.TZ;
      // what a daily routine's 09:00 reads: the local clock, not only Intl
      const hourIn = (timeZone: string) => Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(DEMO_EVENING));
      expect(applyOwnerTimeZone(other)).toBe(other);
      expect(ownerTimeZone()).toBe(other);
      expect(process.env.TZ).toBe(other);
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(other);
      expect(DEMO_EVENING.getHours()).toBe(hourIn(other));
      expect(applyOwnerTimeZone("")).toBe(computer);
      expect(ownerTimeZone()).toBe(computer);
      expect(computerTimeZone()).toBe(computer);
      expect(process.env.TZ).toBe(bootTz);
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(computer);
      expect(DEMO_EVENING.getHours()).toBe(hourIn(computer));
    });
  });
});

describe("the daylight saving clause around 1 November 2026 (US Central)", () => {
  it("names the coming change and the offset after it, in the line itself", () => {
    expect(nowPrompt(DEMO_EVENING, CENTRAL)).toMatch(/\(UTC-05:00\)\. Daylight saving time ends on 1 November; times after that are UTC-06:00\. Coming days: Tue 27 Oct, /);
    expect(daylightSavingNote(new Date("2026-10-02T12:00:00Z"), CENTRAL)).toBe("Daylight saving time ends on 1 November; times after that are UTC-06:00.");
  });

  it("finds the change to the minute: 2 am CDT is 07:00 UTC", () => {
    const change = nearbyZoneChange(DEMO_EVENING, CENTRAL)!;
    expect(Math.abs(change.at - Date.UTC(2026, 10, 1, 7, 0))).toBeLessThanOrEqual(60_000);
    expect(change).toMatchObject({ from: -300, to: -360 });
  });

  it("says it ended for a week after, then goes quiet", () => {
    expect(daylightSavingNote(new Date("2026-11-03T15:00:00Z"), CENTRAL)).toBe("Daylight saving time ended on 1 November; times after that are UTC-06:00.");
    expect(nowPrompt(new Date("2026-11-03T15:00:00Z"), CENTRAL)).toContain("(UTC-06:00). Daylight saving time ended on 1 November");
    expect(daylightSavingNote(new Date("2026-11-10T15:00:00Z"), CENTRAL)).toBe("");
  });

  it("is silent more than 30 days before, and for zones with no change", () => {
    expect(daylightSavingNote(new Date("2026-09-25T12:00:00Z"), CENTRAL)).toBe("");
    expect(daylightSavingNote(DEMO_EVENING, BANGKOK)).toBe("");
    expect(daylightSavingNote(DEMO_EVENING, "UTC")).toBe("");
    expect(nowPrompt(new Date("2026-09-24T01:03:00Z"), BANGKOK)).toBe(" It is now Thursday, 24 September 2026, 8:03 am (08:03) in the owner's time zone, Asia/Bangkok (UTC+07:00). Coming days: Fri 25 Sep, Sat 26 Sep, Sun 27 Sep, Mon 28 Sep, Tue 29 Sep, Wed 30 Sep, Thu 1 Oct, Fri 2 Oct, Sat 3 Oct, Sun 4 Oct, Mon 5 Oct, Tue 6 Oct, Wed 7 Oct, Thu 8 Oct.");
  });

  it("reads a start of daylight saving too (Sydney, 4 October 2026)", () => {
    expect(daylightSavingNote(new Date("2026-09-20T00:00:00Z"), "Australia/Sydney")).toBe("Daylight saving time begins on 4 October; times after that are UTC+11:00.");
  });

  it("stays plain: no em dash, no safe words", () => {
    for (const text of [nowPrompt(DEMO_EVENING, CENTRAL), daylightSavingNote(new Date("2026-11-03T15:00:00Z"), CENTRAL), foreignTimesNote(CENTRAL, DEMO_EVENING.getTime())]) {
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toMatch(/\b(?:un)?saf(?:e|ely|ety)\b/i);
      expect(text).not.toMatch(/composio/i);
    }
  });
});

describe("the time zone setting on the owner's profile", () => {
  const file = join(DATA_DIR, "config.json");
  beforeEach(() => { mkdirSync(DATA_DIR, { recursive: true }); rmSync(file, { force: true }); });
  afterEach(() => { rmSync(file, { force: true }); });

  it("is absent by default, which follows the computer", () => {
    expect(loadConfig().profile?.timeZone).toBeUndefined();
    expect(ownerTimeZoneFor(loadConfig().profile?.timeZone, BANGKOK)).toBe(BANGKOK);
  });

  it("persists beside the name and email, and a later profile save keeps it", () => {
    saveConfig({ profile: { name: "Fixture owner", email: "owner@example.test" } });
    saveConfig({ profile: { timeZone: CENTRAL } });
    saveConfig({ profile: { name: "Renamed owner" } });
    expect(JSON.parse(readFileSync(file, "utf8")).profile).toEqual({ name: "Renamed owner", email: "owner@example.test", timeZone: CENTRAL });
    expect(ownerTimeZoneFor(loadConfig().profile?.timeZone, BANGKOK)).toBe(CENTRAL);
    // "Follow this computer" saves an empty zone
    saveConfig({ profile: { timeZone: "" } });
    expect(ownerTimeZoneFor(loadConfig().profile?.timeZone, BANGKOK)).toBe(BANGKOK);
    expect(loadConfig().profile?.name).toBe("Renamed owner");
  });

  it("has one door: the general config route refuses it", () => {
    expect(() => parseConfigPatch({ profile: { timeZone: CENTRAL } })).toThrowError(expect.objectContaining({ status: 400 }));
    expect(parseConfigPatch({ profile: { name: "Fixture owner" } }).profile).toEqual({ name: "Fixture owner" });
  });

  it("is read from config.json on another computer (the backup round trip is in installation-state-snapshot.test.ts)", () => {
    saveConfig({ profile: { name: "Fixture owner", timeZone: CENTRAL } });
    const exported = readFileSync(file, "utf8");
    rmSync(file, { force: true });
    expect(ownerTimeZoneFor(loadConfig().profile?.timeZone, BANGKOK)).toBe(BANGKOK);
    writeFileSync(file, exported);
    expect(parseStoredConfig(JSON.parse(exported)).profile?.timeZone).toBe(CENTRAL);
    expect(ownerTimeZoneFor(loadConfig().profile?.timeZone, BANGKOK)).toBe(CENTRAL);
  });

  it("imports a config whose zone this computer does not know without failing, and follows the computer", () => {
    writeFileSync(file, JSON.stringify({ profile: { name: "Fixture owner", timeZone: "Mars/Olympus_Mons" } }));
    expect(loadConfig().profile?.name).toBe("Fixture owner");
    expect(ownerTimeZoneFor(loadConfig().profile?.timeZone, BANGKOK)).toBe(BANGKOK);
  });
});

describe("connected-app answers with times in another zone", () => {
  const rpc = (text: string) => JSON.stringify({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text }] } });
  const freeBusy = JSON.stringify({ calendars: { primary: { busy: [{ start: "2026-10-27T15:00:00Z", end: "2026-10-27T16:30:00Z" }, { start: "2026-10-27T19:00:00Z", end: "2026-10-27T21:00:00Z" }] } } });
  const now = DEMO_EVENING.getTime();

  it("adds one line naming the owner's zone under a free/busy answer in UTC", () => {
    const bytes = new TextEncoder().encode(rpc(freeBusy));
    const out = JSON.parse(new TextDecoder().decode(withForeignTimesNote(bytes, "application/json", CENTRAL, now)));
    expect(out.result.content).toHaveLength(2);
    expect(out.result.content[0].text).toBe(freeBusy);
    expect(out.result.content[1].text).toBe(foreignTimesNote(CENTRAL, now));
    expect(out.result.content[1].text).toContain("The owner's time zone is America/Chicago, UTC-05:00 now. Daylight saving time ends on 1 November; times after that are UTC-06:00.");
  });

  it("annotates an event stream on its last result frame only", () => {
    const body = `event: message\ndata: ${rpc(freeBusy)}\n\n`;
    const out = new TextDecoder().decode(withForeignTimesNote(new TextEncoder().encode(body), "text/event-stream", CENTRAL, now));
    const frame = JSON.parse(out.split("\n").find((line) => line.startsWith("data:"))!.slice(5));
    expect(frame.result.content.at(-1).text).toContain("Note from Murage");
  });

  it("leaves an answer alone when its times already carry the owner's offset, or carry none", () => {
    expect(hasForeignTimes('{"start":{"dateTime":"2026-11-10T09:00:00-06:00"}}', CENTRAL)).toBe(false);
    expect(hasForeignTimes('{"start":{"dateTime":"2026-10-27T10:00:00-05:00"}}', CENTRAL)).toBe(false);
    expect(hasForeignTimes('{"start":{"dateTime":"2026-11-10T09:00:00"}}', CENTRAL)).toBe(false);
    expect(hasForeignTimes('{"start":{"date":"2026-11-10"}}', CENTRAL)).toBe(false);
    // the October offset written into a November time: an hour out after daylight saving ends
    expect(hasForeignTimes('{"start":{"dateTime":"2026-11-10T10:00:00-05:00"}}', CENTRAL)).toBe(true);
    for (const text of ['{"start":{"dateTime":"2026-11-10T09:00:00-06:00"}}', "no times here", "{not json"]) {
      const bytes = new TextEncoder().encode(rpc(text));
      expect(withForeignTimesNote(bytes, "application/json", CENTRAL, now)).toBe(bytes);
    }
    const unreadable = new TextEncoder().encode("2026-10-27T15:00:00Z but not JSON");
    expect(withForeignTimesNote(unreadable, "application/json", CENTRAL, now)).toBe(unreadable);
  });

  it("reads a calendar list's time range as a range, not as an offset", () => {
    // "09:00-10:00" is 09:00 to 10:00, never 09:00 at UTC-10:00
    expect(hasForeignTimes("2026-10-27 09:00-10:00 Standup", CENTRAL)).toBe(false);
    expect(hasForeignTimes("2026-10-27 09:00+10:00", CENTRAL)).toBe(false);
    // a spaced time with seconds, or a T time, still carries its offset
    expect(hasForeignTimes("2026-10-27 19:00:00Z", CENTRAL)).toBe(true);
    expect(hasForeignTimes("2026-10-27T19:00Z", CENTRAL)).toBe(true);
    // no zone is 15 hours or more from UTC
    expect(hasForeignTimes("2026-10-27T09:00:00-15:00", CENTRAL)).toBe(false);
    expect(hasForeignTimes("2026-10-27T09:00:00+14:00", CENTRAL)).toBe(true);
  });

  it("adds nothing for an owner in UTC reading UTC times", () => {
    const bytes = new TextEncoder().encode(rpc(freeBusy));
    expect(withForeignTimesNote(bytes, "application/json", "UTC", now)).toBe(bytes);
  });
});

// 1.0.8 gate: given only today's weekday, a bot called Wednesday 28 October 2026 a Tuesday. The clock line now
// lists the next 14 days with their weekdays, counted on the owner's calendar.
describe("the coming days on the clock line", () => {
  it("names each of the next 14 days with its weekday, in the owner's zone", () => {
    const line = nowPrompt(DEMO_EVENING, CENTRAL);
    expect(line).toContain("Coming days: Tue 27 Oct, Wed 28 Oct, Thu 29 Oct, Fri 30 Oct, Sat 31 Oct, Sun 1 Nov, Mon 2 Nov, Tue 3 Nov, Wed 4 Nov, Thu 5 Nov, Fri 6 Nov, Sat 7 Nov, Sun 8 Nov, Mon 9 Nov.");
    // the same instant is already Tuesday in Bangkok, so its days start a day later
    expect(comingDaysLine(DEMO_EVENING, BANGKOK)).toMatch(/^Coming days: Wed 28 Oct, Thu 29 Oct, /);
    expect(comingDaysLine(DEMO_EVENING, BANGKOK).split(", ")).toHaveLength(14);
  });

  it("stays right at 23:30 just before the night daylight saving ends (Chicago, 31 October 2026)", () => {
    // 23:30 CDT on Saturday 31 October; at 2 am on Sunday clocks go back to CST
    expect(comingDaysLine(new Date("2026-11-01T04:30:00Z"), CENTRAL)).toBe("Coming days: Sun 1 Nov, Mon 2 Nov, Tue 3 Nov, Wed 4 Nov, Thu 5 Nov, Fri 6 Nov, Sat 7 Nov, Sun 8 Nov, Mon 9 Nov, Tue 10 Nov, Wed 11 Nov, Thu 12 Nov, Fri 13 Nov, Sat 14 Nov.");
  });

  it("stays right at 00:30 on the day daylight saving ends, where adding 24 hours lands on the same date", () => {
    // 00:30 CDT on Sunday 1 November; 24 hours later is 23:30 CST, still 1 November
    expect(comingDaysLine(new Date("2026-11-01T05:30:00Z"), CENTRAL)).toMatch(/^Coming days: Mon 2 Nov, Tue 3 Nov, .* Sun 15 Nov\.$/);
  });

  it("stays right at 23:30 the night daylight saving begins (Sydney, 4 October 2026)", () => {
    // 23:30 AEST on Saturday 3 October; 24 hours later is already 00:30 on Monday 5 October
    expect(comingDaysLine(new Date("2026-10-03T13:30:00Z"), "Australia/Sydney")).toBe("Coming days: Sun 4 Oct, Mon 5 Oct, Tue 6 Oct, Wed 7 Oct, Thu 8 Oct, Fri 9 Oct, Sat 10 Oct, Sun 11 Oct, Mon 12 Oct, Tue 13 Oct, Wed 14 Oct, Thu 15 Oct, Fri 16 Oct, Sat 17 Oct.");
  });

  it("stays one short line, whatever the chat holds", () => {
    expect(comingDaysLine(DEMO_EVENING, CENTRAL).length).toBeLessThan(200);
    expect(comingDaysLine(DEMO_EVENING, CENTRAL)).not.toMatch(/[—–]/);
  });
});
