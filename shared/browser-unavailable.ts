// A turn that could not bind the built-in browser runs without it. The
// conversation says so with one activity message whose tool name carries this
// prefix — the same convention as a host stop ("stopped:", shared/host-stop.ts)
// and a folder-trust notice. The prefix is the whole contract between the
// server and the transcripts: it is a neutral note, visible with Settings →
// Tool calls off, and never an error card (no Retry, no Provider settings).
export const BROWSER_UNAVAILABLE_PREFIX = "browser unavailable:";

/** The reason a "Use my Chrome" bot's turn records when the owner's Chrome
 * is closed or its remote debugging is off (server/user-chrome.ts). */
export const USER_CHROME_UNREACHABLE_REASON = "your Chrome is not reachable";

/** The reason a turn records when it went on without the browser because
 * another conversation of the same bot holds it while waiting for the
 * person's answer (D4, server/independent-thread-runs.ts ResourceYield). */
/** The reason a "Use my Chrome" turn records while Chrome is asking the owner
 * to Allow the connection (0.1.60 Linux D12). The turn is waiting, not
 * failing: the call goes on once they click Allow. */
export const USER_CHROME_ALLOW_REASON = "your Chrome is asking you to allow the connection";

export const BROWSER_HELD_FOR_ANSWER_REASON = "another conversation is using the browser while it waits for your answer";

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

/** Which plain-words sentence a reason gets: the owner's Chrome was not
 * reachable, the engine did not start in time, or it did not start at all. */
export type BrowserUnavailableKind = "user-chrome" | "user-chrome-allow" | "held" | "timed-out" | "failed";
export function browserUnavailableKind(reason: string): BrowserUnavailableKind {
  if (reason === USER_CHROME_UNREACHABLE_REASON) return "user-chrome";
  if (reason === USER_CHROME_ALLOW_REASON) return "user-chrome-allow";
  if (reason === BROWSER_HELD_FOR_ANSWER_REASON) return "held";
  return /timed out|timeout/i.test(reason) ? "timed-out" : "failed";
}

/** The English sentences, mirrored by the renderer's locale catalog
 * (browserUnavailable.userChrome / .timedOut / .failed). */
export const BROWSER_UNAVAILABLE_SUMMARY: Record<BrowserUnavailableKind, string> = {
  "user-chrome": "Your Chrome isn't reachable, so this turn ran without a browser. Open Chrome and turn on remote debugging at chrome://inspect/#remote-debugging.",
  "user-chrome-allow": "Chrome is asking you to allow this bot to use it. Click Allow on \"Allow remote debugging?\" in Chrome, and the bot carries on.",
  held: "Another conversation with this bot is using the browser while it waits for your answer, so this turn ran without it. Answering that request lets the next turn use it.",
  "timed-out": "The browser didn't start in time, so this turn ran without it. It'll try again next turn.",
  failed: "The browser couldn't start, so this turn ran without it. It'll try again next turn.",
};

/** The plain-words note for surfaces without a renderer locale (the Markdown
 * export, the task timeline). */
export function browserUnavailableDisplayName(name: string | undefined | null): string | undefined {
  const reason = browserUnavailableReason(name);
  return reason ? BROWSER_UNAVAILABLE_SUMMARY[browserUnavailableKind(reason)] : undefined;
}
