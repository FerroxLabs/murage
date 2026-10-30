// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The owner's time zone on the desktop, and the clock facts every bot is told
// about it. Until 1.0.8 the clock line named this computer's zone as "the
// owner's time zone", so a Mac set to UTC+07 while its owner works in Central
// gave the bot no Central anchor at all (1.0.8 dry run, TRIAGE.md g).
//
// The choice is part of the owner's profile (config.json `profile.timeZone`,
// written only through /api/owner/timezone), so it travels with the profile in
// a backup and a restore. Empty or absent means "follow this computer", the
// default, which works with no switch. A saved value that is not a zone (a hand
// edit, a restore from somewhere odd) also follows this computer: it never
// stops a turn.
//
// A Cloud home keeps its own zone in owner.json (cloud-home/timezone.ts) and
// its process TZ already follows it, so it never calls applyOwnerTimeZone.
import { validateOwnerTimeZone } from "./cloud-home/timezone.ts";

function liveZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

const BOOT_TZ = process.env.TZ;
const COMPUTER_ZONE = liveZone();
let chosen: string | null = null;

/** This computer's own zone, as it was before any owner choice. */
export const computerTimeZone = (): string => COMPUTER_ZONE;

/** The zone a saved profile value names, or null to follow the computer. */
export function chosenOwnerTimeZone(saved: unknown): string | null {
  if (typeof saved !== "string" || !saved.trim()) return null;
  try { return validateOwnerTimeZone(saved.trim()); } catch { return null; }
}

/** The zone the owner's clock follows for a saved profile value on a computer in `computer`. */
export function ownerTimeZoneFor(saved: unknown, computer: string): string {
  return chosenOwnerTimeZone(saved) ?? computer;
}

/** Make this server follow the owner's zone: the clock line reads it, and so
 *  does every local-time calculation here (a daily routine's 09:00, a reply's
 *  clock time), through the process TZ. Returns the zone now in force. */
export function applyOwnerTimeZone(saved: unknown): string {
  chosen = chosenOwnerTimeZone(saved);
  if (chosen) process.env.TZ = chosen;
  else if (BOOT_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = BOOT_TZ;
  return ownerTimeZone();
}

/** The owner's zone now: their choice, else the zone this process runs in. */
export function ownerTimeZone(): string {
  return chosen ?? liveZone();
}

// ── offsets and their changes ──────────────────────────────────────────────
const offsetFormats = new Map<string, Intl.DateTimeFormat>();
function offsetFormat(timeZone: string): Intl.DateTimeFormat {
  let format = offsetFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
    if (offsetFormats.size > 64) offsetFormats.clear();
    offsetFormats.set(timeZone, format);
  }
  return format;
}

/** "UTC-06:00", "UTC+05:30", or "UTC" at zero, as the clock line writes it. */
export function utcOffsetLabel(at: Date | number, timeZone: string): string {
  const value = offsetFormat(timeZone).formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  return value.replace("GMT", "UTC") || "UTC";
}

/** Minutes east of UTC at that instant. */
export function utcOffsetMinutes(at: Date | number, timeZone: string): number {
  const match = /([+-])(\d{1,2})(?::?(\d{2}))?/.exec(utcOffsetLabel(at, timeZone));
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

const DAY = 86_400_000;
export interface ZoneChange { at: number; from: number; to: number }

/** The first instant after `from` (exclusive) up to `to` where the offset is
 *  no longer the one at `from`, found to the minute. Days are sampled, so two
 *  changes inside one day (none exist) would read as none. */
function changeBetween(from: number, to: number, timeZone: string): ZoneChange | null {
  const base = utcOffsetMinutes(from, timeZone);
  let previous = from;
  for (let sample = Math.min(from + DAY, to); ; sample = Math.min(sample + DAY, to)) {
    if (utcOffsetMinutes(sample, timeZone) !== base) {
      let low = previous, high = sample;
      while (high - low > 60_000) {
        const middle = low + Math.floor((high - low) / 2);
        if (utcOffsetMinutes(middle, timeZone) === base) low = middle; else high = middle;
      }
      return { at: high, from: base, to: utcOffsetMinutes(high, timeZone) };
    }
    if (sample >= to) return null;
    previous = sample;
  }
}

/** The zone's nearest offset change within `aheadDays` after `at` or
 *  `behindDays` before it, the upcoming one first. */
export function nearbyZoneChange(at: Date | number, timeZone: string, aheadDays = 30, behindDays = 7): ZoneChange | null {
  const now = typeof at === "number" ? at : at.getTime();
  try {
    const ahead = changeBetween(now, now + aheadDays * DAY, timeZone);
    if (ahead) return ahead;
    const start = now - behindDays * DAY;
    // Walk forward from the start of the window to now: the last change in it is the one in force.
    let found: ZoneChange | null = null;
    for (let cursor = start, change = changeBetween(cursor, now, timeZone); change; cursor = change.at, change = changeBetween(cursor, now, timeZone)) found = change;
    return found;
  } catch {
    return null;
  }
}

/** One short sentence about a daylight saving change near `at`, or "". It
 *  rides every message with the clock line, so it stays one clause. */
export function daylightSavingNote(at: Date | number, timeZone: string): string {
  const change = nearbyZoneChange(at, timeZone);
  if (!change) return "";
  const now = typeof at === "number" ? at : at.getTime();
  const past = change.at <= now;
  const began = change.to > change.from;
  const verb = began ? (past ? "began" : "begins") : (past ? "ended" : "ends");
  let day: string;
  try { day = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "long" }).format(change.at); } catch { return ""; }
  return `Daylight saving time ${verb} on ${day}; times after that are ${utcOffsetLabel(change.at, timeZone)}.`;
}
