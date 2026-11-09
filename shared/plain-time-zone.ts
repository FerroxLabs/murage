// 1.0.18 U6 E32 (upstream 698cef40c): a time zone said the way a person says it.
// Wording only. Stored values and machine fields keep the IANA id.

/** Zones whose generic name reads oddly in a sentence ("United Kingdom Time"), said the way people say them. */
const SAID: Record<string, string> = {
  "Europe/London": "UK time", "Europe/Belfast": "UK time", "America/Phoenix": "Arizona time", "Asia/Dubai": "UAE time",
};
const UNIVERSAL = /^(?:Etc\/)?(?:UTC|UCT|GMT|Universal|Zulu|Greenwich)(?:[+-]0)?$/i;
const ABBREVIATION = /^(?:[A-Z]{1,5}|GMT.*|UTC.*)$/;

function zoneName(zone: string, locale: string, style: "shortGeneric" | "longGeneric"): string | null {
  try {
    const name = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: style })
      .formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value;
    return name && !ABBREVIATION.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** "India time", "Pacific time", "UK time", "UTC". Never the IANA id ("Asia/Calcutta"), an abbreviation
 * ("PT") or an offset ("GMT+5:30"). Falls back to the last part of the id ("Kolkata time"), then the id.
 * Never throws. */
export function plainTimeZone(zone: string, locale = "en"): string {
  try {
    const trimmed = typeof zone === "string" ? zone.trim() : "";
    if (!trimmed) return "UTC";
    const english = locale.toLowerCase().startsWith("en");
    if (UNIVERSAL.test(trimmed)) return "UTC";
    if (english && SAID[trimmed]) return SAID[trimmed]!;
    const name = zoneName(trimmed, locale, "shortGeneric") ?? zoneName(trimmed, locale, "longGeneric");
    if (name) return english ? name.replace(/ Time$/, " time") : name;
    const city = trimmed.split("/").at(-1)?.replaceAll("_", " ").trim();
    return city ? `${city} time` : trimmed;
  } catch {
    return String(zone);
  }
}

/** "09:00" as people write it: "9:00". */
export const plainClock = (time: string) => time.replace(/^0(\d):/, "$1:");

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Local weekdays (Sunday = 0) as people say them: "every day", "weekdays", "Monday, Wednesday". */
export function plainWeekdays(weekdays: readonly number[]): string {
  const sorted = [...weekdays].sort((a, b) => a - b);
  const days = sorted.join(",");
  return days === "0,1,2,3,4,5,6" ? "every day" : days === "1,2,3,4,5" ? "weekdays" : sorted.map((day) => WEEKDAYS[day]).join(", ");
}
