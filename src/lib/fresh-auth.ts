// SEC-006 on the page: a high-risk Allow from the phone app is answered with
// a challenge. Check it names the card on screen, ask native for Face ID,
// Touch ID or the passcode, and send the signature back. One signed retry,
// never a loop: a second challenge goes to the caller.
import { approvalDigest, type DigestCard } from "../../shared/approval-digest";
import { skillPreviewMatchesHash } from "../../shared/skill-request";
import { markComputerOnly } from "./approval-surface";
import { t } from "./i18n";
import { callNative, nativeAvailable } from "./native-shell";

export type FreshAuthCode = "changed" | "failed" | "noLock" | "noKey" | "update" | "pairAgain" | "computerOnly" | "answerOnComputer" | "cancelled" | "gone";

/** The line for a refusal, in the reader's language. A cancel has no line:
 * the card simply stays pending. */
export function freshAuthCopy(code: FreshAuthCode): string {
  return code === "cancelled" ? "" : t(`freshAuth.${code}`);
}

/** What a call says aloud when a spoken yes could not be completed. Short and
 * plain, and each line leaves the owner a way out. A cancel is a kind line
 * too: the card stays pending and the call goes on. */
export function freshAuthSpoken(code: FreshAuthCode): string {
  return t(`freshAuth.spoken.${code}`);
}

export class FreshAuthError extends Error {
  readonly code: FreshAuthCode;
  constructor(code: FreshAuthCode) {
    super(freshAuthCopy(code));
    this.code = code;
  }
}

interface Challenge { v: 1; nonce: string; digest: string; decision: "allow" | "allow-task"; expiresAt: number }
function parseChallenge(value: unknown): Challenge | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  return c.v === 1 && typeof c.nonce === "string" && /^[A-Za-z0-9_-]{43}$/.test(c.nonce) && typeof c.digest === "string" && /^[0-9a-f]{64}$/.test(c.digest)
    && (c.decision === "allow" || c.decision === "allow-task") && Number.isInteger(c.expiresAt)
    ? { v: 1, nonce: c.nonce, digest: c.digest, decision: c.decision, expiresAt: c.expiresAt as number } : null;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
// Bidi controls and zero-width or other invisible format characters: removed, not spaced, so they can
// neither reorder the line native renders under Face ID nor hide inside it.
const FORMAT = /\p{Cf}/gu;
const clean = (value: unknown): string => (typeof value === "string" ? value.replace(FORMAT, "").replace(CONTROL, " ").trim() : "");

/** The words under the Face ID prompt. Permission cards all carry the fixed
 * title "Approval needed", so lead with the tool and the start of what it will
 * do, and fall back to the title. */
export function freshAuthReason(card: DigestCard | undefined, botName: string | undefined): string {
  const tool = clean(card?.tool);
  const detail = (clean(card?.summary) || clean(card?.subtitle)).slice(0, 60).trim();
  const bot = clean(botName).slice(0, 40).trim();
  const what = tool && detail ? `${tool}: ${detail}` : tool || detail || clean(card?.title);
  if (!what) return t("freshAuth.reasonFallback");
  return t("freshAuth.reason", { bot: bot || t("freshAuth.reasonBot"), what }).slice(0, 120);
}

const NATIVE_CODES: Record<string, FreshAuthCode> = { cancelled: "cancelled", no_lock: "noLock", no_key: "noKey" };
/** Server refusals that end an Allow, with the status each arrives on. */
const SERVER_CODES: Record<string, { status: number; code: FreshAuthCode }> = {
  approve_on_computer: { status: 403, code: "computerOnly" },
  answer_on_computer: { status: 403, code: "answerOnComputer" },
  fresh_auth_unattested: { status: 403, code: "pairAgain" },
  fresh_auth_failed: { status: 403, code: "failed" },
  fresh_auth_unavailable: { status: 403, code: "noKey" },
  fresh_auth_gone: { status: 409, code: "gone" },
};

export async function respondWithFreshAuth<T>(
  post: (extra?: Record<string, unknown>) => Promise<T>,
  context: { threadId: string; requestId: string; /** What the owner chose. Absent for anything that is not an Allow: no proof is ever signed for it. */ decision?: Challenge["decision"]; card?: DigestCard; reason: string; /** The device prompt opened (true) and closed (false), so a card can say so. */ onDevicePrompt?: (up: boolean) => void },
): Promise<T> {
  try {
    return await post();
  } catch (error) {
    const { status, body } = (error ?? {}) as { status?: number; body?: { code?: unknown; challenge?: unknown } };
    const code = typeof body?.code === "string" ? body.code : "";
    if (status === 409 && code === "fresh_auth_changed") throw new FreshAuthError("changed");
    if (Object.hasOwn(SERVER_CODES, code) && SERVER_CODES[code].status === status) throw new FreshAuthError(SERVER_CODES[code].code);
    if (status !== 403 || code !== "fresh_auth") throw error;
    const challenge = parseChallenge(body?.challenge);
    if (!challenge) throw error;
    // The proof signs the server's decision word. It must be the choice the owner
    // made: a Face ID for "allow once" can never sign "allow for this task".
    if (challenge.decision !== context.decision) throw new FreshAuthError("changed");
    // No WebCrypto on a plain-http origin: the page cannot check the card.
    if (!globalThis.crypto?.subtle) throw new FreshAuthError("update");
    if (!context.card || (await approvalDigest(context.threadId, context.requestId, context.card)) !== challenge.digest) throw new FreshAuthError("changed");
    // A skill request signs only if the preview on screen is the preview its hash names.
    if (!(await skillPreviewMatchesHash(context.card))) throw new FreshAuthError("changed");
    if (!(await nativeAvailable("approveWithDevice"))) throw new FreshAuthError("update");
    let signed: unknown;
    context.onDevicePrompt?.(true);
    try {
      signed = await callNative("approveWithDevice", { ...challenge, threadId: context.threadId, requestId: context.requestId, reason: context.reason });
    } catch (cause) {
      throw new FreshAuthError(NATIVE_CODES[cause instanceof Error ? cause.message : ""] ?? "failed");
    } finally {
      context.onDevicePrompt?.(false);
    }
    const signature = (signed as { signature?: unknown } | null)?.signature;
    if (typeof signature !== "string") throw new FreshAuthError("failed");
    return post({ freshAuth: { nonce: challenge.nonce, signature } });
  }
}

export interface DecideContext { threadId: string; requestId: string; decision?: "allow" | "allow-task"; card?: DigestCard; botName?: string; /** The device prompt opened (true) and closed (false). Local UI only. */ onDevicePrompt?: (up: boolean) => void }

/** Allows in flight, by card, each holding what became of it. A second Allow for the same card (a tap
 * and then a spoken yes) joins the first: starting a second challenge would cancel the Face ID prompt the
 * owner is already looking at, and the joined caller must still hear how the first one ended. The join is
 * never an approval by itself. A Deny is never held. */
const pendingAllows = new Map<string, Promise<{ failed: boolean; error?: unknown }>>();

/** What a call site runs for an Allow: respond with fresh auth, and sort the
 * outcome. A Face ID cancel is not an error (the card stays pending); every
 * other failure is shown and handed to the caller with its code. */
export async function decideWithFreshAuth(
  post: (extra?: Record<string, unknown>) => Promise<unknown>,
  context: DecideContext,
  report: { onError?: (message: string, code?: FreshAuthCode) => void; /** The answer was posted (after a signed retry too). */ onSuccess?: () => void; showError: (error: unknown) => void },
): Promise<void> {
  const key = context.decision ? `${context.threadId}\n${context.requestId}` : "";
  const sort = (error: unknown, shown: boolean) => {
    if (error instanceof FreshAuthError && error.code === "cancelled") { report.onError?.("", "cancelled"); return; }
    if (!shown) {
      if (error instanceof FreshAuthError && error.code === "computerOnly") markComputerOnly(context.threadId, context.requestId);
      report.showError(error);
    }
    report.onError?.(error instanceof Error ? error.message : String(error), error instanceof FreshAuthError ? error.code : undefined);
  };
  const joined = key ? pendingAllows.get(key) : undefined;
  if (joined) {
    const outcome = await joined;
    if (outcome.failed) sort(outcome.error, true);
    else report.onSuccess?.();
    return;
  }
  const run = (async (): Promise<{ failed: boolean; error?: unknown }> => {
    try {
      await respondWithFreshAuth(post, { threadId: context.threadId, requestId: context.requestId, card: context.card, decision: context.decision, reason: freshAuthReason(context.card, context.botName), onDevicePrompt: context.onDevicePrompt });
      return { failed: false };
    } catch (error) {
      return { failed: true, error };
    } finally {
      if (key) pendingAllows.delete(key);
    }
  })();
  if (key) pendingAllows.set(key, run);
  const outcome = await run;
  if (outcome.failed) sort(outcome.error, false);
  else report.onSuccess?.();
}
