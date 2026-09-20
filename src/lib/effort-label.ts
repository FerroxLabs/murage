// One spelling for an engine's effort levels.
//
// The picker printed the raw wire values ("xhigh", "medium") while Bot
// settings printed "X-High" and "Medium" for the same three choices, so the
// two screens looked like two different settings.
export function effortLabel(level: string | undefined | null): string {
  const value = String(level ?? "").trim();
  if (!value) return "Default";
  if (value.toLowerCase() === "xhigh") return "X-High";
  return value.charAt(0).toUpperCase() + value.slice(1);
}
