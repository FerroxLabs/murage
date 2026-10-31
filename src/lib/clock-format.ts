// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One clock format everywhere (UX review R1-25: Today, chat and Routines mixed
// "7:12", "08:00" and "06:30" on one screen). The owner's system language
// decides 12 or 24 hours and how the hour is written; Murage never forces a
// cycle or pads the hour itself. Every owner-visible time of day goes through
// formatClock (or clockFormatter when a caller needs the Intl object).
// L-COPY-A owns this file; screen owners switch their own call sites to it.

export type ClockOptions = { timeZone?: string; locale?: string };

/** The one shape: hour as the locale writes it, minutes always two digits, no seconds. */
export const CLOCK_OPTIONS: Readonly<Intl.DateTimeFormatOptions> = Object.freeze({ hour: "numeric", minute: "2-digit" });

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The shared formatter. `locale` is for tests; left out, the system language decides. */
export function clockFormatter({ timeZone, locale }: ClockOptions = {}): Intl.DateTimeFormat {
  const id = `${locale ?? ""}|${timeZone ?? ""}`;
  let formatter = formatters.get(id);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { ...CLOCK_OPTIONS, timeZone });
    formatters.set(id, formatter);
  }
  return formatter;
}

/** A moment as a time of day, for example "7:05 AM" or "07:05" depending on the system language. */
export function formatClock(at: number | Date, options: ClockOptions = {}): string {
  return clockFormatter(options).format(at);
}

/** A wall-clock "HH:MM" (a routine's schedule, a quiet-hours bound) in the same format.
 * Text that is not a valid 24-hour "H:MM" or "HH:MM" comes back unchanged. */
export function formatClockText(text: string, options: Omit<ClockOptions, "timeZone"> = {}): string {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  if (!match) return text;
  const at = Date.UTC(2000, 0, 1, Number(match[1]), Number(match[2]));
  return formatClock(at, { ...options, timeZone: "UTC" });
}
