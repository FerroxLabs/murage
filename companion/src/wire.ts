// What the harness says, minus what a device has no business holding.
//
// `resumeCursors` is the harness's own bookkeeping: the native session id to
// resume, per instance, per task. It goes out on every bot payload and every
// `bot` SSE frame. That is harmless noise while every client is the machine
// itself, and stops being harmless the moment a client is a phone on someone
// else's wifi.
//
// Upstream may fix this at source — there is a PR open for it — at which
// point this becomes a no-op rather than a lie, which is the right way for a
// sidecar to depend on someone else's API: assume nothing, and be correct
// either way.

/** Most an unterminated SSE frame may buffer before it is abandoned. Well
 * clear of any real event — the harness's largest are a few KB. */
const MAX_PENDING_BYTES = 1024 * 1024;

/** Recursively drop `resumeCursors`, wherever it appears. */
export function scrub<T>(value: T): T {
  if (Array.isArray(value)) return value.map(scrub) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === "resumeCursors") continue;
      out[key] = scrub(inner);
    }
    return out as T;
  }
  return value;
}

/** True when a body is worth parsing at all. Anything else passes through
 * untouched — an image endpoint must never be JSON.parsed. */
export const isJson = (contentType: string | undefined): boolean =>
  Boolean(contentType && contentType.split(";")[0].trim().toLowerCase() === "application/json");

/**
 * Rewrites an SSE byte stream, scrubbing each event's `data:` payload while
 * leaving everything else exactly as it arrived.
 *
 * Two properties this has to hold, both learned the hard way on the client
 * side of this same stream:
 *
 * - **It must not swallow blank lines.** The blank line *is* the event
 *   terminator; a transform that normalises whitespace produces a stream
 *   that parses to nothing and looks perfectly healthy at both ends.
 * - **It must not wait for more than one event.** Buffering to a frame
 *   boundary is bounded and fine. Buffering for a fixed size or a timer
 *   turns a live stream into a batch one, and the symptom is a phone that
 *   sits on "Connecting…" while the server logs a healthy connection.
 *
 * `id:` lines are preserved verbatim: they are the resume cursor, and
 * rewriting them would silently break `?since=`.
 */
export function createSseScrubber(): (chunk: string) => string {
  let pending = "";
  return (chunk: string): string => {
    pending += chunk;
    let out = "";
    for (;;) {
      const boundary = pending.indexOf("\n\n");
      if (boundary < 0) break;
      const event = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      out += scrubEvent(event) + "\n\n";
    }
    // Buffering to a frame boundary is bounded by the frame. Buffering for a
    // boundary that never comes is not, and there are two ways to get there:
    // a stream framed with CRLF, where `\n\n` simply never matches, and a
    // content-type that said event-stream over something that is not one.
    // Both end as this process growing until it is killed.
    //
    // Past the cap the buffer is dropped rather than trimmed. A partial
    // event is not recoverable — resuming mid-frame would emit a fragment
    // that parses as a different event — so the honest outcome is to lose
    // the frame and stay live for the next boundary.
    if (pending.length > MAX_PENDING_BYTES) pending = "";
    return out;
  };
}

/** One complete SSE event, `data:` payload scrubbed, everything else kept. */
function scrubEvent(event: string): string {
  return event
    .split("\n")
    .map((line) => {
      // `: keepalive` comments, `id:`, `event:`, `retry:` — not ours to touch
      if (!line.startsWith("data:")) return line;
      const raw = line.slice(5).trimStart();
      if (!raw) return line;
      try {
        return `data: ${JSON.stringify(scrub(JSON.parse(raw)))}`;
      } catch {
        // not JSON: pass it through rather than dropping it. A frame this
        // code does not understand is still the harness's to send.
        return line;
      }
    })
    .join("\n");
}
