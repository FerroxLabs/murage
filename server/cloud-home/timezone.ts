import { cloudHomeCopy } from "./copy.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.ts";

export function validateOwnerTimeZone(zone: unknown): string {
  if (typeof zone !== "string" || !zone || zone.length > 100) throw new Error(cloudHomeCopy.chooseAnIANATimeZone);
  try { return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone; }
  catch { throw new Error(cloudHomeCopy.chooseAnIANATimeZone); }
}

export function readOwnerTimeZone(dataDir: string): string {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, "owner.json"), "utf8")) as { owner?: { timeZone?: unknown } };
    return validateOwnerTimeZone(value.owner?.timeZone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "UTC";
    throw new Error(cloudHomeCopy.cloudOwnerTimeZoneCouldNotBeRead);
  }
}

/** Explicit owner intent only. A travelling client's zone is never adopted. */
export function writeOwnerTimeZone(dataDir: string, zone: string): void {
  writeFileAtomic(join(dataDir, "owner.json"), JSON.stringify({ owner: { timeZone: validateOwnerTimeZone(zone) } }), { mode: 0o600 });
}

export function nextOwnerDailyOccurrence(time: string, weekdays: readonly number[], after: number, timeZone: string): number | null {
  const zone = validateOwnerTimeZone(timeZone);
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const wall = (at: number) => {
    const values: Record<string, number> = {};
    for (const part of format.formatToParts(at)) if (part.type !== "literal") values[part.type] = Number(part.value);
    return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
  };
  const today = new Date(wall(after));
  const [hour, minute] = time.split(":").map(Number);
  for (let day = 0; day <= 8; day++) {
    const requested = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + day, hour, minute);
    if (!weekdays.includes(new Date(requested).getUTCDay())) continue;
    const candidates = new Set<number>();
    // Sample both sides of transitions. Resolve a local wall clock against
    // each observed offset, then verify it instead of guessing through DST.
    for (let hours = -36; hours <= 36; hours += 6) {
      const sample = requested + hours * 3_600_000;
      const candidate = requested - (wall(sample) - sample);
      if (wall(candidate) === requested) candidates.add(candidate);
    }
    // A gap is skipped; a folded hour fires only at its first occurrence.
    const first = Math.min(...candidates);
    if (Number.isFinite(first) && first > after) return first;
  }
  return null;
}
