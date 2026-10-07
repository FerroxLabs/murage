/**
 * Which streamed assistant text the chat may show while a turn is running.
 *
 * The stored message stays the source of truth. The settled message goes
 * through the server's checks (foldRuntimeEvent in server/index.ts) that the
 * delta frames never pass through, so the live bubble must not show anything
 * those checks would drop or rewrite:
 *
 * - A reply that is nothing but memory provenance JSON (isMemoryProvenanceEcho,
 *   server/memory/provenance-echo.ts) is dropped from the conversation. Its
 *   deltas still stream, so every text that could still turn into one is held
 *   back, prefix by prefix.
 * - A goal control envelope (`<murage-goal>`, SPEC-P 9) is private protocol.
 *   Any text holding the opening marker is held back.
 * - Whitespace-only text never becomes a message.
 * - Replayed transcript text, goal coordinator turns, speaker-guarded room
 *   lines and tool activity never reach the stream: the server drops them
 *   before the delta frame is sent (ACP replay filter, coordinator buffer,
 *   replySpeakerTurns.delta, activity rows are not assistant_text).
 *
 * Everything else is shown as is, so a shown stream equals the settled text.
 */

/** Same literal as GROUP_GOAL_CONTROL_OPEN in server/group-goal-run.ts (a test pins them together). */
export const GOAL_ENVELOPE_OPEN = "<murage-goal>";

/** Union of the key sets in server/memory/provenance-echo.ts (a test pins the behaviour). */
const PROVENANCE_KEYS = ["sourceId", "revision", "startByte", "endByte", "id", "version", "scopeId", "text", "assertion", "pinned", "kind", "evidence"];

/** Could `text` still grow into one JSON object of provenance keys? */
function objectCouldBeProvenance(text: string): boolean {
  const body = text.trimStart();
  if (!body.startsWith("{")) return false;
  const afterBrace = body.slice(1).trimStart();
  if (afterBrace === "") return true;
  if (!afterBrace.startsWith('"')) return false;
  const rest = afterBrace.slice(1);
  const close = rest.indexOf('"');
  if (close < 0) return PROVENANCE_KEYS.some((key) => key.startsWith(rest));
  return PROVENANCE_KEYS.includes(rest.slice(0, close));
}

/** Could `text` still turn into a reply the server treats as a provenance echo? */
export function couldBeProvenanceEcho(text: string): boolean {
  let body = text.trimStart();
  if (body === "`" || body === "``") return true; // the start of a fence
  if (body.startsWith("```")) {
    const after = body.slice(3);
    const newline = after.indexOf("\n");
    if (newline < 0) return "json".startsWith(after.trim().toLowerCase());
    const lang = after.slice(0, newline).trim().toLowerCase();
    if (lang !== "" && lang !== "json") return false;
    body = after.slice(newline + 1).trimStart();
    if (body === "") return true;
  }
  if (body.startsWith("{")) return objectCouldBeProvenance(body);
  if (body.startsWith("[")) {
    const inner = body.slice(1).trimStart();
    return inner === "" || objectCouldBeProvenance(inner);
  }
  return false;
}

/** The stream text to paint, or "" when nothing may be shown yet. */
export function streamPaintText(raw: string | undefined, opts: { busy: boolean }): string {
  if (!opts.busy || !raw || !raw.trim()) return "";
  if (raw.includes(GOAL_ENVELOPE_OPEN)) return "";
  if (couldBeProvenanceEcho(raw)) return "";
  return raw;
}

/** About 30 paints a second: the markdown tree is re-parsed per paint. */
export const STREAM_PAINT_INTERVAL_MS = 33;

/** Milliseconds to wait before the next paint; 0 means paint now. */
export function paintDelay(lastPaintAt: number | null, now: number, interval = STREAM_PAINT_INTERVAL_MS): number {
  if (lastPaintAt === null) return 0;
  return Math.max(0, Math.min(interval, lastPaintAt + interval - now));
}

/**
 * The text a render shows: the last painted text while it is still the start
 * of the live text, otherwise the live text itself. A cleared stream, or the
 * first text of a new turn, therefore never shows a stale bubble for a frame.
 */
export function paintedText(live: string, painted: string): string {
  if (!live) return "";
  if (!painted || !live.startsWith(painted)) return live;
  return painted;
}
