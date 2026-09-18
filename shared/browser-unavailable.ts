// A turn that could not bind the built-in browser runs without it. The
// conversation says so with one activity message whose tool name carries this
// prefix — the same convention as a host stop ("stopped:", shared/host-stop.ts)
// and a folder-trust notice. The prefix is the whole contract between the
// server and the transcripts: it is a neutral note, visible with Settings →
// Tool calls off, and never an error card (no Retry, no Provider settings).
export const BROWSER_UNAVAILABLE_PREFIX = "browser unavailable:";

/** The activity tool name for a turn that ran without its browser. */
export function browserUnavailableActivityName(reason: string): string {
  return `${BROWSER_UNAVAILABLE_PREFIX} ${reason.trim() || "the browser engine did not start"}`;
}

/** The short reason a browser-unavailable note carries, or undefined for any
 * other activity name (a tool run, an "error:" or "stopped:" chip). */
export function browserUnavailableReason(name: string | undefined | null): string | undefined {
  if (typeof name !== "string" || !name.startsWith(BROWSER_UNAVAILABLE_PREFIX)) return undefined;
  const reason = name.slice(BROWSER_UNAVAILABLE_PREFIX.length).trim();
  return reason || undefined;
}

/** "Browser unavailable this turn — <reason>" for surfaces without a renderer
 * locale (the Markdown export, the task timeline). */
export function browserUnavailableDisplayName(name: string | undefined | null): string | undefined {
  const reason = browserUnavailableReason(name);
  return reason ? `Browser unavailable this turn — ${reason}` : undefined;
}
