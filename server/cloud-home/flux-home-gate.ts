// SPDX-License-Identifier: AGPL-3.0-or-later
// B4: the home's view of its own Flux key.
//
// A Cloud home never holds the owner's primary Flux key, only a key Flux issued
// for this one home (capped, expiring, bound to the home's address). Flux asks
// the home's key, not the control plane, whether it may work: the home polls
// GET /v1/cloud-home/status with that key. When Flux says the key is paused
// (monthly limit used, owner stopped it, replaced, or Flux unreachable) the
// engines that route through Flux refuse with a plain message BEFORE a turn is
// sent. Claude and ChatGPT sign-in engines do not go through Flux, so they are
// never touched. Flux's own gate stays the enforcer; this only makes the pause
// early and readable.
import { Agent, fetch as undiciFetch } from "undici";
import { z } from "zod";
import { cloudHomeCopy } from "./copy.ts";
import { creditsUsedMessage } from "./flux-credit-refusal.ts";
import { setFluxPauseSource, type FluxHomeState, type FluxPause } from "./flux-pause.ts";
import { fluxUsageHeaders } from "../flux-usage-tags.ts";

export { assertFluxNotPaused, fluxHomePause, type FluxHomeState, type FluxPause } from "./flux-pause.ts";

export const HOME_KEY_PREFIX = "sk-flux-home-";

/** Only a key shaped like one Flux issues for a home. The owner's primary key never matches. */
export function isHomeFluxKey(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(HOME_KEY_PREFIX)
    && value.length > HOME_KEY_PREFIX.length + 20 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

const statusBody = z.object({
  state: z.enum(["ok", "capped", "stopped", "revoked", "ip_refused", "unavailable", "invalid"]),
  paused: z.boolean(),
  message: z.string().max(600).nullable(),
  cap_microcents: z.number().int().nonnegative().nullable().optional(),
  spent_microcents: z.number().int().nonnegative().optional(),
  resets_at: z.string().max(64).optional(),
});

const OWN_MESSAGE: Record<Exclude<FluxHomeState, "unknown" | "no-key" | "ok" | "invalid">, string> = {
  capped: cloudHomeCopy.fluxPausedCapped,
  stopped: cloudHomeCopy.fluxPausedStopped,
  revoked: cloudHomeCopy.fluxPausedRevoked,
  ip_refused: cloudHomeCopy.fluxPausedAddress,
  unavailable: cloudHomeCopy.fluxPausedUnavailable,
};

export interface FluxHomeGateOptions {
  /** The home's Flux key, from fluxKey(). Null means nothing to ask. */
  key: () => string | null;
  base?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** Flux binds a home's key to the home's IPv4 address, so the status question is asked over IPv4 only (the egress proxy does the same for engines). */
let ipv4Agent: Agent | undefined;
const ipv4Fetch = ((url: string | URL, init?: RequestInit) => {
  ipv4Agent ??= new Agent({ connect: { family: 4 } });
  return undiciFetch(url, { ...(init as Record<string, unknown>), dispatcher: ipv4Agent }) as unknown as Promise<Response>;
}) as typeof fetch;

export function createFluxHomeGate(options: FluxHomeGateOptions) {
  const base = (options.base ?? "https://api.fluxrouter.ai").replace(/\/+$/, "");
  const doFetch = options.fetch ?? ipv4Fetch;
  const now = options.now ?? Date.now;
  let state: FluxPause = { paused: false, state: "unknown", message: null, checkedAt: null };
  let inflight: Promise<FluxPause> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const set = (next: Omit<FluxPause, "checkedAt">): FluxPause => (state = { ...next, checkedAt: now() });
  const down = () => set({ paused: true, state: "unavailable", message: cloudHomeCopy.fluxPausedUnavailable });

  async function ask(): Promise<FluxPause> {
    const key = options.key();
    if (!key) return set({ paused: false, state: "no-key", message: null });
    if (!isHomeFluxKey(key)) {
      // Some other key sits in the Flux slot. Never send it to Flux for this check.
      return set({ paused: true, state: "invalid", message: cloudHomeCopy.fluxOwnerKeyOnHome });
    }
    let response: Response;
    try {
      response = await doFetch(`${base}/v1/cloud-home/status`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
        headers: { authorization: `Bearer ${key}`, accept: "application/json", ...fluxUsageHeaders({ feature: "other" }) },
      });
    } catch {
      return down();
    }
    // An older Flux without this route has no per-home limit to report.
    if (response.status === 404) return set({ paused: false, state: "unknown", message: null });
    let parsed: z.infer<typeof statusBody> | null = null;
    try {
      const result = statusBody.safeParse(await response.json());
      parsed = result.success ? result.data : null;
    } catch { parsed = null; }
    if (parsed) {
      const known = parsed.state === "ok" || parsed.state === "invalid" ? null : OWN_MESSAGE[parsed.state];
      return set({
        paused: parsed.paused,
        state: parsed.state,
        // Only our own sentences ever reach the customer: the router's message text is never shown.
        message: parsed.paused
          ? (parsed.state === "capped" ? `${creditsUsedMessage({ resetsAt: parsed.resets_at ?? null })}` : known ?? cloudHomeCopy.fluxPausedUnavailable)
          : null,
        ...(parsed.cap_microcents != null ? { capMicrocents: parsed.cap_microcents } : {}),
        ...(parsed.spent_microcents !== undefined ? { spentMicrocents: parsed.spent_microcents } : {}),
        ...(parsed.resets_at ? { resetsAt: parsed.resets_at } : {}),
      });
    }
    // An auth refusal of the STATUS question (a revoked key, a refused address) is neither "not paused" (that is the 404 answer) nor a
    // customer error: the last known state stands, an operator alarm line (code and status only, never the answer) is logged, and a real
    // turn is still classified from the router's own answer to that turn.
    if (response.status === 401 || response.status === 403) {
      console.error(`Cloud model service status refusal errorCode=cloud_flux_status_auth_refused status=${response.status}`);
      return state;
    }
    return down();
  }

  /** Ask Flux now. One question at a time; callers share the answer. */
  function refresh(): Promise<FluxPause> {
    inflight ??= ask().finally(() => { inflight = null; });
    return inflight;
  }

  return {
    current: (): FluxPause => state,
    refresh,
    /** Poll every intervalMs, and retry sooner while Flux cannot be reached. */
    start(intervalMs = 60_000, retryMs = 15_000) {
      if (running) return;
      running = true;
      const loop = async () => {
        if (!running) return;
        const result = await refresh();
        if (!running) return;
        timer = setTimeout(loop, result.state === "unavailable" ? retryMs : intervalMs);
        timer.unref?.();
      };
      void loop();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    /** Something just got a refusal from Flux (401, 402, 403, 503): re-ask now. */
    noteRefusal(status: number) {
      if (status === 401 || status === 402 || status === 403 || status === 503) void refresh();
    },
  };
}

export type FluxHomeGate = ReturnType<typeof createFluxHomeGate>;

let active: FluxHomeGate | null = null;

/** Called once at home start. A desktop never calls it, so a desktop is never gated. */
export function startFluxHomeGate(options: FluxHomeGateOptions): FluxHomeGate {
  active?.stop();
  active = createFluxHomeGate(options);
  setFluxPauseSource(active.current);
  active.start();
  return active;
}

export function stopFluxHomeGate(): void {
  active?.stop();
  active = null;
  setFluxPauseSource(null);
}
