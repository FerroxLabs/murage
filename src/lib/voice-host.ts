// The call screen's side of the voice host (server/voice/voice-host.ts).
//
// The host only ever TALKS. When it decides work is needed it says so as a
// `hand_down` event, and the call screen sends that request through the
// ordinary send path, so the engine turn, the approvals and the transcript
// are the same ones a typed message gets. This file just carries the events.
import { desktopSurfaceHeaders } from "@/lib/live-events";

/** The call routes read the owner's thread and inbox, so the harness serves
 *  them to the desktop app only: every request carries its per-launch proof. */
export function callRouteHeaders(): Record<string, string> {
  return { "content-type": "application/json", "x-murage-surface": "desktop", ...desktopSurfaceHeaders() };
}

export type HostEvent =
  | { type: "sentence"; text: string }
  | { type: "hand_down"; request: string }
  /** A web lookup started; its answer follows as sentences. */
  | { type: "lookup"; query: string }
  | { type: "cancel" }
  | { type: "done" }
  | { type: "error"; reason: string; message: string };

export interface HostTurnInput {
  text: string;
  threadId?: string;
  history: Array<{ role: "owner" | "host"; text: string }>;
  /** The approval card open right now, as it would be read aloud. */
  approval?: string;
  /** `text` is a finished answer to tell in a few sentences, not speech. */
  brief?: boolean;
}

/** A finished answer longer than this is told as a brief on a call rather
 *  than read out: about sixty spoken words. */
export const BRIEF_OVER_CHARS = 450;

/** The host failures that will not fix themselves during this call: stop
 *  asking the host and let the engine take every turn, as calls did before. */
export const HOST_OFF_FOR_CALL = new Set(["key", "auth", "premium", "unavailable"]);

/** Wake the model when a call starts. Fire and forget. */
export function warmHost(botId: string): void {
  void fetch(`/api/bots/${botId}/voice-host`, {
    method: "POST",
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
    onEvent({ type: "error", reason: "upstream", message: body?.error ?? `the harness returned ${res.status}` });
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
        try {
          onEvent(JSON.parse(data) as HostEvent);
        } catch {
          // a malformed frame is skipped, not fatal
        }
      }
    }
  } catch {
    if (!signal?.aborted) onEvent({ type: "error", reason: "upstream", message: "The reply was cut off." });
  }
}
