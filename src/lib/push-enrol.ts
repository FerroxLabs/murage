// Spec §3.5 "Enrolment" steps 2 and 3, from the page's side. Only inside the
// phone app, only when hello() listed the methods. Every open reissues the
// tokens (Plan 3a Decision 2); a host that lost the binding gets a fresh one.
import { parseIssueTokens } from "../../shared/mobile-push";
import { callNative, nativeHas, type NativeMethod } from "./native-shell";

export interface PushDeps {
  has(method: NativeMethod): boolean;
  call(method: NativeMethod, ...args: unknown[]): Promise<unknown>;
  post(path: string, body: unknown): Promise<{ status: number; body: unknown }>;
  get(path: string): Promise<{ status: number; body: unknown }>;
}
/** "hostOff": this computer has push turned off (MURAGE_PUSH_RELAY_URL=off). */
export type PushState = "off" | "hostOff" | "denied" | "unsupported" | "enrolled" | "failed";

/** What the shell's pushStatus says. `expiresAt` (ms) is when the phone's
 * tokens stop working; a shell that predates it sends none. */
export interface PushStatus { permission: string; enrolled: boolean; expiresAt?: number }

/** "On" means granted, enrolled and not past the token expiry. A token the
 * host no longer accepts is not a working one, so an expired status reads as
 * off and the row offers Turn on, which enrols again. */
export function pushStatusCurrent(status: PushStatus, now: number): boolean {
  if (status.permission !== "granted" || !status.enrolled) return false;
  return typeof status.expiresAt === "number" ? status.expiresAt > now : true;
}

/** Bound retries so an off host does not repeatedly mint grants: each one is
 * a relay binding counted against this phone's per-device relay limits,
 * which every paired computer shares (final review I1, N3). A resume waits
 * out the timer like an automatic run; an explicit "Turn on" or a changed
 * permission rechecks immediately. */
const hostOff = new WeakMap<PushDeps, number>();
export const HOST_OFF_WAIT_MS = 10 * 60_000;
const permissions = new WeakMap<PushDeps, string>();
function saysOff(deps: PushDeps, answer: { status: number; body: unknown }): boolean {
  if (answer.status !== 503 || (answer.body as { code?: unknown } | null)?.code !== "push_off") return false;
  hostOff.set(deps, Date.now() + HOST_OFF_WAIT_MS);
  return true;
}

/** The pages whose host could not reach the relay to redeem a grant, and
 *  until when they wait (final re-review N3): each new grant is a relay
 *  binding, and one per resume would reach the relay's per-device limit. */
const relayDown = new WeakMap<PushDeps, number>();
export const RELAY_DOWN_WAIT_MS = 10 * 60_000;
function saysRelayDown(deps: PushDeps, answer: { status: number; body: unknown }): boolean {
  if (answer.status !== 503 || (answer.body as { code?: unknown } | null)?.code !== "relay_unavailable") return false;
  relayDown.set(deps, Date.now() + RELAY_DOWN_WAIT_MS);
  return true;
}

type Tokens = NonNullable<ReturnType<typeof parseIssueTokens>>;

/** Native refuses (rejects) while the phone is locked or the app is leaving:
 *  that is "failed", to try again on the next resume, never a reason to replace. */
async function issue(deps: PushDeps, tokens: Tokens): Promise<PushState> {
  return (await deps.call("issuePushTokens", tokens).catch(() => false)) === true ? "enrolled" : "failed";
}

async function hand(deps: PushDeps, answer: { status: number; body: unknown }): Promise<PushState> {
  const tokens = answer.status === 200 ? parseIssueTokens(answer.body) : null;
  return tokens ? issue(deps, tokens) : "failed";
}

/** One sync at a time per page (final review M7): the hydration run and a
 *  "Turn on" click would each mint a token pair, and the host kills the first
 *  when it mints the second, so the pair that lands last could be dead. */
const inFlight = new WeakMap<PushDeps, Promise<PushState>>();
export function syncPush(deps: PushDeps, reason: "automatic" | "foreground" | "manual" = "automatic"): Promise<PushState> {
  const running = inFlight.get(deps);
  if (running) return running;
  const run = prepareSync(deps, reason).finally(() => inFlight.delete(deps));
  inFlight.set(deps, run);
  return run;
}

async function prepareSync(deps: PushDeps, reason: "automatic" | "foreground" | "manual"): Promise<PushState> {
  if (reason === "manual") hostOff.delete(deps);
  if (deps.has("pushStatus")) {
    try {
      const status = await deps.call("pushStatus") as { permission?: unknown } | null;
      if (typeof status?.permission === "string") {
        const previous = permissions.get(deps);
        if (previous !== undefined && previous !== status.permission) hostOff.delete(deps);
        permissions.set(deps, status.permission);
      }
    } catch { /* A locked phone can be checked again on foreground. */ }
  }
  return sync(deps, false);
}

async function sync(deps: PushDeps, fresh: boolean): Promise<PushState> {
  if (!deps.has("registerPush") || !deps.has("issuePushTokens")) return "off";
  if ((hostOff.get(deps) ?? 0) > Date.now()) return "hostOff";
  if ((relayDown.get(deps) ?? 0) > Date.now()) return "failed";
  let result: { status?: unknown; grant?: unknown; bindingId?: unknown };
  try { result = ((await deps.call("registerPush", { fresh })) ?? {}) as typeof result; } catch { return "failed"; }
  if (result.status === "denied" || result.status === "unsupported") return result.status;
  if (result.status === "granted" && typeof result.grant === "string") {
    const answer = await deps.post("/api/mobile/push/enrol", { grant: result.grant });
    if (saysOff(deps, answer)) return "hostOff";
    if (saysRelayDown(deps, answer)) return "failed";
    return hand(deps, answer);
  }
  if (result.status === "enrolled") {
    const answer = await deps.post("/api/mobile/push/tokens", {});
    if (saysOff(deps, answer)) return "hostOff";
    // Enrol afresh (a replace) only when the host really has no binding for
    // this phone, or holds another one; never on an outage or a refusal.
    const notEnrolled = answer.status === 404 && (answer.body as { code?: unknown } | null)?.code === "not_enrolled";
    if (notEnrolled) return fresh ? "failed" : sync(deps, true);
    const tokens = answer.status === 200 ? parseIssueTokens(answer.body) : null;
    if (tokens && typeof result.bindingId === "string" && tokens.bindingId !== result.bindingId) {
      // The host took a replace this phone has not committed yet: native
      // adopts it if that replace is still waiting, and otherwise (the app
      // restarted in between) refuses, and a fresh binding follows, once.
      const adopted = await issue(deps, tokens);
      return adopted === "enrolled" || fresh ? adopted : sync(deps, true);
    }
    return hand(deps, answer);
  }
  return "failed";
}

export async function reportBadge(deps: PushDeps): Promise<void> {
  if (!deps.has("setBadgeCount")) return;
  const answer = await deps.get("/api/inbox?view=decisions&page=0&pageSize=1");
  const decisions = (answer.body as { decisions?: unknown } | null)?.decisions;
  if (answer.status === 200 && typeof decisions === "number" && Number.isInteger(decisions) && decisions >= 0) {
    await deps.call("setBadgeCount", decisions).catch(() => undefined);
  }
}

const json = async (res: Response) => ({ status: res.status, body: await res.json().catch(() => null) });
export const browserPushDeps: PushDeps = {
  has: nativeHas,
  call: callNative,
  post: async (path, body) => json(await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })),
  get: async (path) => json(await fetch(path, { credentials: "same-origin" })),
};
