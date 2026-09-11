// The proxy-side half of computer control. The harness keeps the record of
// who is driving (server/computer-control.ts); the per-turn computer
// processes consult it through this client before acting, because the
// action paths themselves never traverse the harness — a box click goes
// straight to the box's REST API, and a Local VM / VPS click rides a
// transparent stdio bridge into Cua Driver.
//
// Failure posture: the client never guesses. A timeout, a non-2xx answer or
// a malformed body is reported as `available: false` (with `held: false`),
// so each caller decides explicitly. Control is still cooperation between the
// person and their own bot, not a security boundary against a hostile agent.
//
// - The bridge-gated Local VM / VPS computers (mcp-bridge.ts) fail CLOSED
//   while a configured endpoint is unavailable (0.1.52 decision U-11, audit
//   A5): a person who took the wheel was promised exclusive control, so an
//   unknown hold refuses the tool call with reconnect guidance.
// - An unconfigured client (no URL or token: the legacy, ungated setup)
//   reports a known, disengaged state and changes nothing.
// - Callers that only read `held` keep their previous behaviour.
//
// A known state is cached briefly so a computer_batch of two dozen actions
// doesn't turn into two dozen loopback round trips. An unavailable reading
// is never cached: the next call asks again.

export interface ControlState {
  /** The person is driving; actions must be refused, not queued. */
  held: boolean;
  /** A help request the person has neither answered nor dismissed. */
  helpOpen: boolean;
  /** False when a configured control endpoint could not give a well-formed
   * answer (timeout, non-2xx, malformed body). `held` is then unknown, not
   * false; gates that promise exclusive control must refuse. Always true for
   * an unconfigured client. */
  available: boolean;
}

export interface ControlClient {
  /** Current state, cached for `cacheMs`. `fresh` bypasses the cache —
   * the wait loop in request-help polls with it so a hand-back is seen
   * within one poll interval, not one poll interval plus the cache. */
  state(fresh?: boolean): Promise<ControlState>;
  /** Surface the bot's plea in the app. Returns its expiry id, or null when
   * the harness could not be told. */
  requestHelp(reason: string): Promise<string | null>;
  /** Close only the unanswered plea opened by this client. */
  expireHelp(requestId: string): Promise<void>;
  readonly configured: boolean;
}

const DISENGAGED: ControlState = Object.freeze({ held: false, helpOpen: false, available: true });
const UNAVAILABLE: ControlState = Object.freeze({ held: false, helpOpen: false, available: false });

export function createControlClient(options?: {
  url?: string;
  token?: string;
  cacheMs?: number;
  /** Per-request deadline for the loopback read; defaults to 2 s. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): ControlClient {
  const url = options?.url ?? process.env.MURAGE_CONTROL_URL ?? "";
  const token = options?.token ?? process.env.MURAGE_CONTROL_TOKEN ?? "";
  const cacheMs = options?.cacheMs ?? 750;
  const timeoutMs = options?.timeoutMs ?? 2_000;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const configured = Boolean(url && token);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  let cachedAt = 0;
  let cached: ControlState = DISENGAGED;

  async function read(): Promise<ControlState> {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return UNAVAILABLE;
      const body: unknown = await res.json().catch(() => null);
      // The harness always answers {held: boolean, helpOpen: boolean}. Any
      // other shape is not evidence that nobody is driving.
      if (!body || typeof body !== "object") return UNAVAILABLE;
      const { held, helpOpen } = body as { held?: unknown; helpOpen?: unknown };
      if (typeof held !== "boolean" || typeof helpOpen !== "boolean") return UNAVAILABLE;
      return { held, helpOpen, available: true };
    } catch {
      return UNAVAILABLE;
    }
  }

  return {
    configured,
    async state(fresh = false): Promise<ControlState> {
      if (!configured) return DISENGAGED;
      const now = Date.now();
      if (!fresh && cachedAt !== 0 && now - cachedAt < cacheMs) return cached;
      const reading = await read();
      if (reading.available) {
        cached = reading;
        cachedAt = Date.now();
      } else {
        cachedAt = 0;
      }
      return reading;
    },
    async requestHelp(reason: string): Promise<string | null> {
      if (!configured) return null;
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ reason }),
          signal: AbortSignal.timeout(2_000),
        });
        if (!res.ok) return null;
        const body: any = await res.json().catch(() => null);
        return typeof body?.requestId === "string" && body.requestId ? body.requestId : null;
      } catch {
        return null;
      }
    },
    async expireHelp(requestId: string): Promise<void> {
      if (!configured || !requestId) return;
      try {
        await fetchImpl(url, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ requestId }),
          signal: AbortSignal.timeout(2_000),
        });
      } catch {
        // Best effort: the harness also clears the in-memory request on
        // release/restart, and an unavailable harness cannot show the card.
      }
    },
  };
}

/** The one sentence every refused action gets. Deliberately does not vary
 * per tool: the model needs the same three facts every time — nothing
 * happened, don't retry blindly, and how to wait properly. */
export const CONTROL_REFUSAL =
  "A person has taken control of this computer, so this call was NOT performed. " +
  "Do not retry it — the screen is changing under their hands. " +
  "Call computer_request_help (no reason needed) to wait for them to finish, " +
  "then take a fresh screenshot before your next action.";

/** The bridge-gated computers (Local VM, VPS) speak Cua Driver's own tool
 * surface, which has no wait tool to point at — so the guidance is to
 * pause, not to call anything. */
export const CONTROL_REFUSAL_PLAIN =
  "A person has taken control of this computer, so this call was NOT performed. " +
  "Do not retry it — the screen is changing under their hands. " +
  "Pause this task, tell the person you are waiting for them to hand control back, " +
  "and take a fresh screenshot before your next action once they have.";

/** What a bridge-gated computer (Local VM, VPS) answers while its configured
 * control endpoint cannot say whether a person is driving. Fail closed: the
 * call did not run, retrying in a loop will not help, and the person has to
 * reconnect before the bot can act again. */
export const CONTROL_UNAVAILABLE_PLAIN =
  "Murage could not confirm whether a person is controlling this computer, so this call was NOT performed. " +
  "Do not retry it in a loop. " +
  "Pause this task and tell the person that the computer's control connection needs to reconnect: " +
  "keep Murage open, reopen this computer in Murage (or restart the task), " +
  "then take a fresh screenshot before your next action once it is back.";

/** Thrown by a gate's held-check when the configured control endpoint is
 * unavailable, so the gate refuses with reconnect guidance. */
export class ControlUnavailableError extends Error {
  constructor() {
    super("computer control state unavailable");
    this.name = "ControlUnavailableError";
  }
}
