// WHERE A FIRST-RUN ANSWER SPENDS ITS TIME, ON THE HOME.
//
// The owner pressed Continue on a fresh Cloud home and waited seconds with
// nothing on screen. The renderer now answers the press at once
// (src/components/FirstRunWorking.tsx), and this is the other half: every
// setup answer, skip and reopen is timed phase by phase and logged as one
// `[setup-timing]` line, and the same phases go back on a Server-Timing
// header so the renderer can tell the home's time from the network's (on
// Cloud, the tunnel and the home proxy). See src/lib/first-run-timing.ts.
//
// Numbers, the route and the step id only. Never the answer: it is a name
// and an email on the hello step.

export interface SetupTiming {
  /** Run `work` and keep its duration under `name`. */
  phase<T>(name: string, work: () => Promise<T> | T): Promise<T>;
  /** Keep a duration measured elsewhere (the live reads time themselves). */
  note(name: string, ms: number): void;
  /** The Server-Timing header value, `total` last. */
  header(): string;
  /** One log line. `pressMs` is the renderer's press-to-send wait, when it sent one. */
  line(route: string, step: string, pressMs: number | null): string;
}

export function createSetupTiming(clock: () => number = () => performance.now()): SetupTiming {
  const started = clock();
  const phases: Array<[string, number]> = [];
  const total = () => Math.round(clock() - started);
  return {
    async phase(name, work) {
      const at = clock();
      try {
        return await work();
      } finally {
        phases.push([name, Math.round(clock() - at)]);
      }
    },
    note(name, ms) {
      phases.push([name, Math.round(ms)]);
    },
    header() {
      return [...phases, ["total", total()] as [string, number]].map(([name, ms]) => `${name};dur=${ms}`).join(", ");
    },
    line(route, step, pressMs) {
      const parts = phases.map(([name, ms]) => `${name}=${ms}ms`).join(" ");
      const press = pressMs === null ? "" : ` press-to-send=${pressMs}ms`;
      return `[setup-timing] ${route} step=${step}${press} ${parts} total=${total()}ms`;
    },
  };
}

/** The renderer's press-to-send wait, or null for a missing or junk header. */
export function pressWaitOf(header: string | string[] | undefined): number | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string" || !/^\d{1,7}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/**
 * The connected apps and the engines, read side by side.
 *
 * They were read one after the other, so a setup answer waited for the
 * connected-app broker (a network round trip on a home whose list is not
 * remembered yet) and THEN for a describe of every engine. Neither reads the
 * other, so the answer now waits for the slower of the two, not their sum.
 */
export async function readSideBySide<A, E>(
  apps: () => Promise<A>,
  engines: () => Promise<E>,
  timing?: Pick<SetupTiming, "note">,
  clock: () => number = () => performance.now(),
): Promise<[A, E]> {
  const timed = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const at = clock();
    try {
      return await work();
    } finally {
      timing?.note(name, clock() - at);
    }
  };
  return Promise.all([timed("apps", apps), timed("engines", engines)]);
}
