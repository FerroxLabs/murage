// The call screen's side of the voice host (server/voice/voice-host.ts).
//
// The host only ever TALKS. When it decides work is needed it says so as a
// `hand_down` event, and the call screen sends that request through the
// ordinary send path, so the engine turn, the approvals and the transcript
// are the same ones a typed message gets. This file just carries the events.
import { desktopSurfaceHeaders } from "@/lib/live-events";
import { botCallHeaders } from "@/lib/bot-call-session";

/** The call routes read the owner's thread and inbox, so the harness serves
 *  them to the desktop app only: every request carries its per-launch proof. */
export function callRouteHeaders(): Record<string, string> {
  // an answered bot call: every call request carries its call id (design 5.7), which is also traffic for the session
  return { "content-type": "application/json", "x-murage-surface": "desktop", ...desktopSurfaceHeaders(), ...botCallHeaders() };
}

export type HostEvent =
  | { type: "audio"; callSessionId: string; threadId: string; replyId: string }
  | { type: "sentence"; text: string; /** first piece cut at a clause; for the timing line only */ clause?: true }
  | { type: "hand_down"; request: string; id: string }
  /** A web lookup started; its answer follows as sentences. */
  | { type: "lookup"; query: string }
  | { type: "cancel" }
  | { type: "done" }
  | { type: "error"; reason: string; message: string };

/** Work handed down on this call, as far as the call screen knows. The
 *  harness reads the rest (running, failed, done) from the thread. */
export interface CallHandDown {
  id: string;
  request: string;
  at: number;
  /** "failed" and "dropped" are read from the harness's receipt for the send. */
  state: "sending" | "accepted" | "refused" | "cancelled" | "failed" | "dropped";
  reason?: string;
  /** The send's id: the harness finds the owner's message again by it. */
  sendId?: string;
  /** The queue row (or root request) the send became. */
  requestId?: string;
  /** True when the send waited in the room's queue (requestId is then a queue row a cancel can reach). */
  queued?: boolean;
}

export interface HostTurnInput {
  text: string;
  threadId?: string;
  history: Array<{ role: "owner" | "host"; text: string; handDown?: { id: string; request: string } }>;
  handDowns?: CallHandDown[];
  /** The approval card open right now, as it would be read aloud. */
  approval?: string;
  /** `text` is a finished answer to tell in a few sentences, not speech. */
  brief?: boolean;
  replyId?: string;
  /** A room call: the channel this member is answering in (server builds a
   *  room snapshot). */
  groupId?: string;
  /** A room call: what the owner said to the other members' voices on this
   *  call, and what they answered. */
  roomHeard?: RoomHeard[];
}

export interface RoomHeard {
  member: string;
  owner: string;
  reply: string;
}

/** A finished answer longer than this is told as a brief on a call rather
 *  than read out: about sixty spoken words. */
export const BRIEF_OVER_CHARS = 450;

/** The host failures that will not fix themselves during this call: stop
 *  asking the host and let the engine take every turn, as calls did before. */
export const HOST_OFF_FOR_CALL = new Set(["key", "auth", "premium", "unavailable"]);

/** L-COPY call.budgetStop: said once when a turn on a call fails because the
 *  key's budget or balance is used up; the call then ends (VOICE-402-STOP). */
export const CALL_BUDGET_STOP = "The call ended because this Flux key has reached its budget. You can start another call when the budget resets or changes.";

/** Only a typed refusal from a known Flux adapter ends a call for budget.
 * Owner billing failures, premium access and ordinary prose are not this signal. */
export function isBudgetFailure(info: unknown): boolean {
  if (!info || typeof info !== "object") return false;
  const value = info as { fluxBudget?: unknown; provider?: unknown };
  return value.fluxBudget === true && value.provider === "flux-router";
}

/** Wake the model when a call starts. Fire and forget. */
export function warmHost(botId: string): void {
  void fetch(`/api/bots/${botId}/voice-host`, {
    method: "POST",
    redirect: "error",
    headers: callRouteHeaders(),
    body: JSON.stringify({ warm: true }),
  }).catch(() => undefined);
}

/**
 * One host turn. Calls `onEvent` for each event as it arrives and resolves
 * when the stream ends. Never rejects: a transport failure becomes an
 * `error` event so the caller has one fallback path.
 */
export async function hostTurn(
  botId: string,
  input: HostTurnInput,
  onEvent: (event: HostEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/bots/${botId}/voice-host`, {
      method: "POST",
      redirect: "error",
      headers: callRouteHeaders(),
      body: JSON.stringify(input),
      signal,
    });
  } catch {
    if (!signal?.aborted) onEvent({ type: "error", reason: "upstream", message: "Couldn't reach the harness." });
    return;
  }
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    const code = body?.error?.code ?? body?.code ?? body?.error;
    const message = typeof body?.error === "string" ? body.error : body?.error?.message ?? body?.message;
    const reason = res.status === 402 ? (code === "premium_locked" ? "premium" : "budget") : "upstream";
    onEvent({ type: "error", reason, message: typeof message === "string" ? message : `the harness returned ${res.status}` });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.startsWith("data:") ? frame.slice(5).trim() : "";
        if (!data) continue;
        let event: HostEvent;
        try {
          event = JSON.parse(data) as HostEvent;
        } catch {
          // a malformed frame is skipped, not fatal
          continue;
        }
        // A terminal refusal must retire the reader even if the UI callback throws.
        if (event?.type === "error" && event.reason === "budget") {
          try { onEvent(event); } finally { return; }
        }
        onEvent(event);
      }
    }
  } catch {
    if (!signal?.aborted) onEvent({ type: "error", reason: "upstream", message: "The reply was cut off." });
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * An engine's failure, as something to say. Engines report failures for a
 * log: "API error (status 429 Too Many Requests): subscription:free-usage-
 * exhausted: You've used all the included free usage...". The status line
 * and the machine code are dropped and only the first sentence is kept.
 */
export function plainFailure(details: string): string {
  let text = details.replace(/^error:\s*/i, "").split("\n")[0] ?? "";
  text = text.replace(/^[\w ]*error\s*\(status \d{3}[^)]*\)\s*:?\s*/i, "");
  // leading machine codes such as "subscription:free-usage-exhausted:"
  text = text.replace(/^(?:[a-z][\w.-]*:)+(?:[a-z][\w.-]*)?:\s*/i, "");
  text = text.replace(/`/g, "").replace(/\s+/g, " ").trim();
  const first = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  const clipped = first.replace(/…$/, "").trim();
  return clipped.length > 220 ? `${clipped.slice(0, 217).replace(/\s+\S*$/, "")}.` : clipped || "The engine reported an error.";
}
