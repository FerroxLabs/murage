// WHERE THE TIME GOES BETWEEN A FIRST-RUN PRESS AND ITS ANSWER.
//
// A press on the name card or the jobs card used to sit for seconds on Cloud
// and nothing said why. This measures the client half of one press and logs
// it as one `[first-run-timing]` line: how long until the working line was on
// screen, each request's round trip, and, from the answer's Server-Timing
// header, how much of that round trip the home itself spent. What is left
// over is the network: on Cloud that is the tunnel and the home proxy.
//
// The server logs its own half (`[setup-timing]`, server/setup-timing.ts)
// with the press-to-send wait this sends along, so the two lines join up.
// Numbers and step names only: never a name, an email or an answer.

export interface FirstRunTiming {
  /** Header for the answer request: how long after the press it was sent. */
  headers(): Record<string, string>;
  /** Run one request and remember its round trip under `label`. */
  time<T>(label: string, run: () => Promise<T>): Promise<T>;
  /** The press is over: log the line once. */
  done(): void;
}

export const FIRST_RUN_PRESS_HEADER = "x-murage-press-ms";

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/**
 * Let the browser paint what the press just set, then go on.
 *
 * React commits the press's state at once, but a request started in the same
 * task goes out before the frame that shows it. One frame and a task later,
 * the Chief working is on screen, and only then does anything leave.
 */
export function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") { resolve(); return; }
    // A hidden tab never runs the frame; it must not hold the press for ever.
    const fallback = setTimeout(resolve, 100);
    requestAnimationFrame(() => setTimeout(() => { clearTimeout(fallback); resolve(); }, 0));
  });
}

/** The home's own time for THIS press's request to `path` (one started at or
 *  after `since`, in performance time), from its Server-Timing header. */
export function serverMsFor(path: string, since = 0): number | null {
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return null;
  const entries = performance.getEntriesByType("resource") as Array<PerformanceResourceTiming & { serverTiming?: Array<{ name: string; duration: number }> }>;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry.name.endsWith(path) || entry.startTime + 1 < since) continue;
    const total = entry.serverTiming?.find((item) => item.name === "total");
    return total ? Math.round(total.duration) : null;
  }
  return null;
}

export function firstRunTimingLine(action: string, marks: Record<string, number>): string {
  const parts = Object.entries(marks).map(([name, ms]) => `${name}=${Math.max(0, Math.round(ms))}ms`);
  return `[first-run-timing] ${action} ${parts.join(" ")}`;
}

export function startFirstRunTiming(action: string, log: (line: string) => void = (line) => console.info(line)): FirstRunTiming {
  const pressed = now();
  const marks: Record<string, number> = {};
  let finished = false;
  let answerSentAt = pressed;
  // The setup request this press makes: an answer, or a skip.
  let answerLabel: "answer" | "skip" | null = null;
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => { marks.paint = now() - pressed; });
  }
  return {
    headers: () => ({ [FIRST_RUN_PRESS_HEADER]: String(Math.max(0, Math.round(now() - pressed))) }),
    async time(label, run) {
      const start = now();
      if (label === "answer" || label === "skip") { answerSentAt = start; answerLabel = label; }
      try {
        return await run();
      } finally {
        if (!finished) marks[label] = now() - start;
      }
    },
    done() {
      if (finished) return;
      finished = true;
      const sent = answerLabel === null ? undefined : marks[answerLabel];
      const server = answerLabel === null || sent === undefined ? null : serverMsFor(`/api/setup/${answerLabel}`, answerSentAt);
      if (server !== null && sent !== undefined) {
        marks.server = server;
        marks.network = sent - server;
      }
      marks.total = now() - pressed;
      try { log(firstRunTimingLine(action, marks)); } catch { /* a log is never the job */ }
    },
  };
}
