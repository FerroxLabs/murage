// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX L5B: "New routine in words". Reads the When out of one English sentence
// ("every weekday at 8, send me a brief") and leaves the task. Deterministic:
// no model, no network, the same sentence and clock give the same answer. What
// it cannot read is `when: null`, which the sheet shows as "When: pick a time"
// with the full editor one click away. It never hands back a start in the past.
//
// Hours without am or pm: 1 to 6 read as afternoon (at 3 = 15:00), 7 to 11 as
// morning, and morning/afternoon/evening/night words move them to that part of
// the day. Morning alone is 08:00, afternoon 14:00, evening 18:00, night 20:00.

import { addDays, atLocalTime, startOfDay } from "@/lib/routine-calendar";
import type { RoutineSchedule } from "@/lib/routines";

export type ScheduleWhen =
  | { type: "daily"; time: string; weekdays: number[] }
  | { type: "once"; at: number }
  | { type: "interval"; everyMinutes: number; anchorAt: number };

export interface ScheduleWords {
  /** null: the sentence has no When this parser can read (or it is in the past). */
  when: ScheduleWhen | null;
  /** The sentence without its When words, first letter capitalised. */
  task: string;
}

const MINUTE = 60_000;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

const DAY_WORDS: Array<[number, string[]]> = [
  [0, ["sunday", "sun"]],
  [1, ["monday", "mon"]],
  [2, ["tuesday", "tues", "tue"]],
  [3, ["wednesday", "wed"]],
  [4, ["thursday", "thurs", "thur", "thu"]],
  [5, ["friday", "fri"]],
  [6, ["saturday", "sat"]],
];
const FULL_DAY = "(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?";
const ANY_DAY = "(?:sundays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|tues|thurs|thur|sun|mon|tue|wed|thu|fri|sat)";
const PLURAL_DAY = /^(?:sun|mon|tues|wednes|thurs|fri|satur)days$/;
const LIST_JOIN = "\\s*(?:,\\s*(?:and\\s+|or\\s+)?|\\s+and\\s+|\\s+or\\s+|\\s*&\\s*)\\s*";

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, fifteen: 15, twenty: 20, thirty: 30, "forty-five": 45, "forty five": 45 };

const PART_HOUR: Record<string, number> = { morning: 8, afternoon: 14, evening: 18, night: 20, tonight: 20 };

function dayOf(word: string): number | null {
  const w = word.toLowerCase().replace(/s$/, "");
  for (const [day, names] of DAY_WORDS) if (names.includes(w) || names.includes(word.toLowerCase())) return day;
  return null;
}

function numberOf(word: string | undefined): number | null {
  if (word === undefined || word === "") return 1;
  if (/^\d+$/.test(word)) return Number(word);
  return NUMBER_WORDS[word.toLowerCase()] ?? null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The sentence's working copy: matched When words are cut out as they are read. */
class Words {
  text: string;
  constructor(text: string) { this.text = ` ${text} `; }
  take(re: RegExp): RegExpExecArray | null {
    const match = re.exec(this.text);
    if (!match) return null;
    // Blanked, not cut, so every position still lines up with the sentence.
    this.text = this.text.slice(0, match.index) + " ".repeat(match[0].length) + this.text.slice(match.index + match[0].length);
    return match;
  }
}

function cleanTask(text: string): string {
  let rest = text.replace(/\s+/g, " ").trim();
  const edge = /^(?:[,;:.\-–]+|and|then|to|please|at|on|every|each|starting|from)(?=\s|$|[,;:.])\s*/i;
  const tail = /\s*(?:[,;:\-–]+|\band|\bthen|\bat|\bon|\bevery|\beach|\bstarting|\bfrom|\bplease)$/i;
  for (let i = 0; i < 8; i += 1) {
    const before = rest;
    rest = rest.replace(edge, "").replace(tail, "").trim();
    if (rest === before) break;
  }
  rest = rest.replace(/\s+([,.;:!?])/g, "$1").replace(/,{2,}/g, ",");
  return rest ? rest[0]!.toUpperCase() + rest.slice(1) : "";
}

/** Next whole five minutes strictly after `now`. */
function nextFiveMinutes(now: number): number {
  const step = 5 * MINUTE;
  return Math.floor(now / step) * step + step;
}

// The rule for every check below: when in doubt, the sheet shows "Pick a time".
//
// A time zone the parser would ignore ("8 UTC", "9 PST", "eastern time").
const TIME_ZONE = /\b(?:utc|gmt|zulu|est|edt|cst|cdt|mst|mdt|pst|pdt|akst|akdt|hst|ast|adt|bst|cet|cest|eet|eest|ist|jst|kst|sgt|hkt|aest|aedt|acst|awst|nzst|nzdt|msk|tz)\b|\btime\s*zones?\b|\btimezones?\b|\b(?:eastern|pacific|central|mountain|atlantic|local|server|standard|daylight|summer|winter)\s+time\b|\b\d{1,2}(?::?\d{2})?\s*z\b|(?:^|\s)[+-]\d{1,2}:\d{2}\b/;
// Timing words still in the task once the When is read: two Whens, or one the
// parser only half read ("starting tomorrow", "every other week", "at 5").
const TIMING_LEFT = new RegExp([
  "\\b(?:every|each|mornings?|afternoons?|evenings?|nights?|tonight|noon|midday|midnight|tomorrow|today|week\\s?days?|weekends?|daily|weekly|hourly|starting|beginning|o'clock)\\b",
  `\\b${FULL_DAY}\\b`,
  "\\b\\d{1,2}(?:[:.]\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)(?![a-z])",
  "\\b\\d{1,2}:\\d{2}\\b",
  "\\b(?:at|by|around|before|after|until|till|from)\\s+\\d",
  "\\bin\\s+(?:\\d+|an?|one|two|three|four|five|six|ten|fifteen|twenty|thirty)\\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?)\\b",
  "\\b(?:next|this)\\s+(?:week|month|year)\\b",
].join("|"));
// Words that may sit inside a When clause without being part of the task.
const CONNECTORS = new Set(["at", "on", "in", "the", "and", "or", "every", "each", "from", "starting", "by", "around", "then", "please"]);

/** True when a word read as the When sits inside the task ("send me an evening
 * recap every day at 8"): task words never set the time. A When clause is only
 * read at the start or the end of the sentence. */
function whenInsideTask(original: string, remaining: string): boolean {
  const kinds: Array<"when" | "joint" | "task"> = [];
  for (const m of original.matchAll(/[^\s,;:!?]+/g)) {
    const start = m.index!;
    const end = start + m[0].length;
    let taken = false;
    for (let i = start; i < end; i += 1) if (remaining[i] === " ") { taken = true; break; }
    const bare = m[0].replace(/\.+$/, "");
    kinds.push(taken ? "when" : CONNECTORS.has(bare) || /^[-–—.&]+$/.test(m[0]) ? "joint" : "task");
  }
  let lead = 0;
  while (lead < kinds.length && kinds[lead] !== "task") lead += 1;
  let tail = kinds.length;
  while (tail > lead && kinds[tail - 1] !== "task") tail -= 1;
  for (let i = lead; i < tail; i += 1) if (kinds[i] === "when") return true;
  return false;
}

export function parseScheduleWords(sentence: string, now: number): ScheduleWords {
  const words = new Words(sentence.toLowerCase().replace(/[’']/g, "'"));
  const original = words.text;
  const done = (when: ScheduleWhen | null): ScheduleWords => {
    // A word read inside the task belongs to the task: keep the sentence whole.
    if (whenInsideTask(original, words.text)) return { when: null, task: cleanTask(sentence) };
    const doubt = TIME_ZONE.test(original) || TIMING_LEFT.test(words.text);
    return { when: doubt ? null : when, task: cleanTask(sliceLike(sentence, original, words.text)) };
  };

  // 1. A repeat by the clock: every 15 minutes, every 2 hours, hourly, every half hour.
  if (words.take(/\bevery\s+half(?:\s+an)?\s+hour\b/)) return done(intervalWhen(30, now));
  if (words.take(/\b(?:hourly|every\s+hour)\b/)) return done(intervalWhen(60, now));
  const every = words.take(/\bevery\s+(\d+|an?|one|two|three|four|five|six|ten|fifteen|twenty|thirty|forty[- ]five)?\s*(minutes?|mins?|hours?|hrs?)\b/);
  if (every) {
    const n = numberOf(every[1]);
    const minutes = n === null ? null : /^h/.test(every[2]!) ? n * 60 : n;
    return done(minutes !== null && minutes >= 5 && minutes <= 1440 ? intervalWhen(minutes, now) : null);
  }

  // 2. In N minutes or hours: once.
  const inRel = words.take(/\bin\s+(\d+|an?|one|two|three|four|five|six|ten|fifteen|twenty|thirty|forty[- ]five)\s*(minutes?|mins?|hours?|hrs?)\b/);
  if (inRel) {
    const n = numberOf(inRel[1]);
    if (n === null || n <= 0) return done(null);
    const ms = (/^h/.test(inRel[2]!) ? n * 60 : n) * MINUTE;
    const at = Math.ceil((now + ms) / MINUTE) * MINUTE;
    return done({ type: "once", at });
  }

  // 3. The days.
  let days: number[] | null = null;
  let repeats = false;
  let onceDay: number | null = null; // a day offset from today (0 today, 1 tomorrow, ...)

  const range = words.take(new RegExp(`\\b(?:every\\s+|each\\s+|from\\s+)?(${ANY_DAY})\\s*(?:-|to|through|thru|till|until)\\s*(${ANY_DAY})\\b`));
  if (range) {
    const from = dayOf(range[1]!);
    const to = dayOf(range[2]!);
    if (from !== null && to !== null) {
      days = [];
      for (let d = from, guard = 0; guard < 7; d = (d + 1) % 7, guard += 1) {
        days.push(d);
        if (d === to) break;
      }
      days.sort();
      repeats = true;
    }
  }
  if (!days && words.take(/\b(?:every|each|on)\s+(?:week\s?days?|working\s+days?|work\s?days?|business\s+days?)\b|\bweekdays\b/)) { days = WEEKDAYS; repeats = true; }
  if (!days && words.take(/\b(?:every|each|on)\s+weekends?\b|\bweekends\b/)) { days = WEEKEND; repeats = true; }
  if (!days && words.take(/\b(?:every\s?day|each\s+day|daily)\b/)) { days = ALL_DAYS; repeats = true; }
  if (!days) {
    const list = words.take(new RegExp(`\\b(every|each|on)\\s+(${ANY_DAY}(?:${LIST_JOIN}${ANY_DAY})*)\\b`));
    if (list) {
      const names = list[2]!.split(new RegExp(LIST_JOIN)).map((w) => w.trim()).filter(Boolean);
      const picked = [...new Set(names.map(dayOf).filter((d): d is number => d !== null))].sort();
      const plural = names.some((w) => PLURAL_DAY.test(w));
      if (picked.length) {
        if (list[1] === "on" && !plural && picked.length === 1) onceDay = daysUntil(now, picked[0]!);
        else { days = picked; repeats = true; }
      }
    }
  }
  if (!days && onceDay === null) {
    const plurals = words.take(new RegExp(`\\b(${FULL_DAY.replace("s?", "s")}(?:${LIST_JOIN}${FULL_DAY})*)\\b`));
    if (plurals) {
      days = [...new Set(plurals[1]!.split(new RegExp(LIST_JOIN)).map(dayOf).filter((d): d is number => d !== null))].sort();
      repeats = days.length > 0;
      if (!repeats) days = null;
    }
  }
  if (!days && onceDay === null) {
    const single = words.take(new RegExp(`\\b(?:next\\s+|this\\s+|on\\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\\b`));
    if (single) onceDay = daysUntil(now, dayOf(single[1]!)!);
  }
  const weekly = words.take(/\b(?:every\s+week|each\s+week|weekly)\b/);
  if (weekly) {
    repeats = true;
    if (!days) days = onceDay !== null ? [new Date(addDays(startOfDay(now), onceDay)).getDay()] : [new Date(now).getDay()];
    onceDay = null;
  }
  if (!days && onceDay === null) {
    if (words.take(/\btomorrow\b/)) onceDay = 1;
    else if (words.take(/\btoday\b/)) onceDay = 0;
  }

  // 4. The part of the day, and "every morning" as a daily repeat.
  let part: string | null = null;
  const everyPart = words.take(/\b(?:every|each)\s+(morning|afternoon|evening|night)\b/);
  if (everyPart) {
    part = everyPart[1]!;
    if (!days) { days = ALL_DAYS; repeats = true; }
  } else {
    const partMatch = words.take(/\b(?:in\s+the\s+|this\s+)?(morning|afternoon|evening|tonight|night)s?\b/);
    if (partMatch) {
      part = partMatch[1]!;
      // "tonight" and "this morning" are today; one that has passed is not rolled to tomorrow.
      if ((part === "tonight" || /^\s*this\s/.test(partMatch[0])) && !days && onceDay === null) onceDay = 0;
      if (partMatch[0].trim().endsWith("s") && !days && onceDay === null) { days = ALL_DAYS; repeats = true; }
    }
  }

  // 5. The time.
  let hour: number | null = null;
  let minute = 0;
  const named = words.take(/\b(?:at\s+)?(noon|midday|midnight)\b/);
  if (named) hour = named[1] === "midnight" ? 0 : 12;
  if (hour === null) {
    const clock = words.take(/\b(?:at\s+|by\s+|around\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=[^a-z]|$)/)
      ?? words.take(/\b(?:at|by|around)\s+(\d{1,2})(?:[:.](\d{2}))?(?![\d:])\b/)
      ?? words.take(/\b(\d{1,2}):(\d{2})\b/);
    if (clock) {
      let h = Number(clock[1]);
      const m = clock[2] ? Number(clock[2]) : 0;
      const suffix = clock[3]?.replace(/\./g, "");
      if (m > 59) return done(null);
      if (suffix) {
        if (h < 1 || h > 12) return done(null);
        if (suffix === "pm" && h < 12) h += 12;
        if (suffix === "am" && h === 12) h = 0;
      } else if (h > 23) {
        return done(null);
      } else if (h >= 1 && h <= 11) {
        if (part && part !== "morning") h += 12;
        else if (!part && h <= 6) h += 12;
      }
      hour = h;
      minute = m;
    }
  }
  if (hour === null && part) hour = PART_HOUR[part]!;

  // A repeat word with nothing it could read (every month, every other week) is
  // left in the task, and done() then asks for a time.
  if (hour === null) return done(null);
  const time = `${pad(hour)}:${pad(minute)}`;
  if (days && repeats) return done({ type: "daily", time, weekdays: days });
  const day = onceDay ?? 0;
  let at = atLocalTime(addDays(startOfDay(now), day), time);
  if (at <= now) {
    if (onceDay !== null) return done(null); // "today at 8" at 10: never a start in the past
    at = atLocalTime(addDays(startOfDay(now), 1), time);
  }
  return done({ type: "once", at });
}

/** Days from today to the next `weekday`; today itself counts as 0. */
function daysUntil(now: number, weekday: number): number {
  return (weekday - new Date(now).getDay() + 7) % 7;
}

function intervalWhen(everyMinutes: number, now: number): ScheduleWhen {
  return { type: "interval", everyMinutes, anchorAt: nextFiveMinutes(now) };
}

/** The original casing of what is left: When words were blanked in place, so
 * the same positions are blanked in the sentence. (A sentence whose lowercase
 * form changes length falls back to the lowercase words.) */
function sliceLike(sentence: string, original: string, remaining: string): string {
  const source = ` ${sentence} `;
  if (source.length !== original.length || remaining.length !== original.length) return remaining;
  let out = "";
  for (let i = 0; i < source.length; i += 1) out += remaining[i] === " " && original[i] !== " " ? " " : source[i];
  return out;
}

export function scheduleFromWhen(when: ScheduleWhen): RoutineSchedule {
  if (when.type === "daily") return { type: "daily", time: when.time, weekdays: [...when.weekdays] };
  if (when.type === "interval") return { type: "interval", everyMinutes: when.everyMinutes, anchorAt: when.anchorAt };
  return { type: "once", at: when.at };
}

/** When a schedule next runs, strictly after `now`; null for one in the past or one no clock starts. */
export function nextOccurrence(schedule: RoutineSchedule, now: number): number | null {
  if (schedule.type === "once") return schedule.at > now ? schedule.at : null;
  if (schedule.type === "interval") {
    if (schedule.anchorAt > now) return schedule.anchorAt;
    const step = schedule.everyMinutes * MINUTE;
    return schedule.anchorAt + (Math.floor((now - schedule.anchorAt) / step) + 1) * step;
  }
  if (schedule.type !== "daily" || schedule.weekdays.length === 0) return null;
  for (let step = 0; step < 8; step += 1) {
    const day = addDays(startOfDay(now), step);
    if (!schedule.weekdays.includes(new Date(day).getDay())) continue;
    const at = atLocalTime(day, schedule.time);
    if (at > now) return at;
  }
  return null;
}
