// 1.0.18 U6 F38 (upstream d40f17d7f, active-routines-context): what each of the bot's routines does and when,
// for the owner's own direct chat only. Everything else keeps the names-only "My routines" line (fail closed).
import { plainClock, plainTimeZone, plainWeekdays } from "../shared/plain-time-zone.ts";
import { redactSecretsInText } from "./redact.ts";
import type { RoutineSchedule } from "./routines.ts";

export const ROUTINE_DETAIL_MAX = 6;
export const ROUTINE_DETAIL_NAME_CHARS = 60;
export const ROUTINE_DETAIL_PREVIEW_CHARS = 200;
export const ROUTINE_DETAIL_SENTENCE =
  "Before saying work a routine covers is done, check it with list_routines; pause a monitor only when its goal is met.";

export interface RoutineDetail {
  name: string;
  botId: string;
  enabled: boolean;
  schedule: RoutineSchedule;
  nextRunAt: number | null;
  prompt: string;
  createdAt: number;
  /** A watch or other routine that stops on its own at this time. */
  expiresAt?: number;
}

/** The facts the host has about this turn. Every one must hold for the rich line; a missing fact means names only. */
export interface RoutineDetailAudience {
  /** isOwnUnsharedThread(bot, threadId): a task of the bot, not shared, home partition, the owner as its human. */
  ownUnsharedThread: boolean;
  /** The owner's words proved on an owner surface (directOwnerAudience). */
  directOwnerAudience: boolean;
  /** The turn came from the desktop app or the paired phone. */
  ownerOrigin: boolean;
  automationSource?: string;
  routineRun: boolean;
  channelTurn: boolean;
  roomTurn: boolean;
  /** An ask, delegation, card continuation, unattended or other inherited turn. */
  inherited: boolean;
}

export function richRoutineLineAllowed(facts: Partial<RoutineDetailAudience> | null | undefined): boolean {
  if (!facts) return false;
  return facts.ownUnsharedThread === true && facts.directOwnerAudience === true && facts.ownerOrigin === true
    && facts.automationSource === undefined && facts.routineRun === false && facts.channelTurn === false
    && facts.roomTurn === false && facts.inherited === false;
}

function oneLine(text: string, max: number): string {
  // angle brackets go, as working-context.ts does for names: routine text never closes or opens the block's tags (Astra r1 M3)
  const flat = text.replace(/\s+/g, " ").replace(/[<>]/g, "").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function at(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/** The schedule in plain words, with the zone said the way people say it (E32). */
export function plainRoutineSchedule(schedule: RoutineSchedule, timeZone: string): string {
  const zone = plainTimeZone(timeZone);
  switch (schedule.type) {
    case "once": return `once, ${at(schedule.at, timeZone)} ${zone}`;
    case "daily": return `${plainWeekdays(schedule.weekdays)} at ${plainClock(schedule.time)} ${zone}`;
    case "interval": return `every ${schedule.everyMinutes} minutes`;
    case "limit_reset": return "when an engine's usage limit resets";
    case "app_event": return "when a connected app sends an event";
    default: return "on its own schedule";
  }
}

/** At most six entries: one-time and expiring routines first, then the newest. Names, previews and all are redacted. */
export function routineDetailEntries(details: readonly RoutineDetail[], botId: string, timeZone: string): string[] {
  const own = details.filter((routine) => routine.botId === botId && routine.enabled);
  const ending = (routine: RoutineDetail) => routine.schedule.type === "once" || routine.expiresAt !== undefined;
  const ordered = [...own].sort((a, b) => Number(ending(b)) - Number(ending(a)) || b.createdAt - a.createdAt).slice(0, ROUTINE_DETAIL_MAX);
  return ordered.map((routine) => {
    const name = oneLine(redactSecretsInText(routine.name), ROUTINE_DETAIL_NAME_CHARS);
    const next = routine.nextRunAt === null ? "" : `; next run ${at(routine.nextRunAt, timeZone)} ${plainTimeZone(timeZone)}`;
    const ends = routine.expiresAt === undefined ? "" : `; ends ${at(routine.expiresAt, timeZone)}`;
    const preview = oneLine(redactSecretsInText(routine.prompt), ROUTINE_DETAIL_PREVIEW_CHARS);
    return `- ${name}: ${plainRoutineSchedule(routine.schedule, timeZone)}${next}${ends}. Does: ${preview}`;
  }).filter((entry) => entry.length > 4);
}
