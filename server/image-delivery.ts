// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
/**
 * How a rendered image comes back (image generation v2, "Timeouts and
 * delivery"). A render is never cut while the provider is still working:
 *
 * - Streaming (Server-Sent Events, contract section 3): any bytes at all
 *   reset an idle timer (120 s, or 4 x the router's keepalive); a 30 minute
 *   ceiling bounds the whole render. Partial frames are activity only.
 * - Jobs (contract section 4): submit once, keep the job id, poll it.
 * - Buffered: one JSON answer, 10 minutes after approval.
 *
 * Pure transport helpers: no key, no store. Errors carry the attempt
 * outcome so the caller records it exactly as a 4xx or a timeout today.
 */
import { redactSecretsInText } from "./redact.ts";

export type DeliveryOutcome = "failed" | "uncertain";
export class ImageDeliveryError extends Error {
  readonly code: string;
  readonly outcome: DeliveryOutcome;
  constructor(code: string, message: string, outcome: DeliveryOutcome) { super(message); this.code = code; this.outcome = outcome; }
}

export const STREAM_IDLE_MS = 120_000;
export const RENDER_CEILING_MS = 30 * 60_000;
export const BUFFERED_DEADLINE_MS = 10 * 60_000;
export const JOB_POLL_TIMEOUT_MS = 30_000;
export const JOB_TRANSPORT_RETRY_MS = 5 * 60_000;
/** A render expected past this many seconds is streamed with a preview frame
 * (no router keepalive) or run as a job (when the router offers jobs), so the
 * edge's ~100 s cut never sees a silent connection. */
export const LONG_RENDER_SECONDS = 80;

export const idleTimeoutMs = (keepaliveSeconds?: number) => Math.max(STREAM_IDLE_MS, keepaliveSeconds ? 4 * keepaliveSeconds * 1000 : 0);

/** An abort signal that fires after `ms` with no `touch()`. With `armed`
 * false the clock starts at the first `touch()` (the response headers). */
export function idleWatch(ms: number, armed = true): { signal: AbortSignal; touch: () => void; stop: () => void; fired: () => boolean } {
  const controller = new AbortController();
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { fired = true; controller.abort(new DOMException("idle", "TimeoutError")); }, ms); timer.unref?.(); };
  if (armed) arm();
  return { signal: controller.signal, touch: () => { if (!fired) arm(); }, stop: () => { if (timer) clearTimeout(timer); }, fired: () => fired };
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** Provider text shown to the bot and the owner: one line, bounded, and any
 * key-shaped value masked (an upstream error can echo a credential). */
const clean = (value: unknown, max: number) => typeof value === "string" && value.trim() ? redactSecretsInText(value.replace(/\s+/g, " ").trim()).slice(0, max) : "";

/** One image result in the JSON body shape every adapter already reads:
 * `{ data: [{ b64_json }], usage?, model? }`. */
export interface ImageResultBody { data: Array<{ b64_json: string; size?: string }>; usage?: unknown; model?: string }

/**
 * Reads an image event stream to its end. Flux sends
 * `{type:"image_generation.completed", data:[{b64_json}]}`; OpenAI sends
 * `{type:"image_generation.completed", b64_json}` (and `image_edit.*` for
 * edits). With n > 1 either one completed frame holds every image or one
 * frame arrives per image (`image_index`); both are accepted. `: keepalive`
 * comments and partial frames only count as activity. An event larger than
 * `maxEventBytes` is refused rather than held, and so is a whole stream past
 * `maxTotalBytes` (default: the event cap) or an image past `expected`.
 */
export async function readImageEventStream(body: ReadableStream<Uint8Array>, options: { onActivity?: () => void; maxEventBytes: number; maxTotalBytes?: number; expected: number }): Promise<ImageResultBody> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const images = new Map<number, { b64_json: string; size?: string }>();
  const maxTotal = options.maxTotalBytes ?? options.maxEventBytes;
  let buffer = "", usage: unknown, model: string | undefined, done = false, completed = false, total = 0;
  const handle = (event: string) => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return; // a comment (": keepalive") or an empty event
    if (data.trim() === "[DONE]") { done = true; return; }
    let frame: unknown;
    try { frame = JSON.parse(data); } catch { throw new ImageDeliveryError("invalid-response", "The image provider sent an unreadable stream.", "uncertain"); }
    if (!record(frame)) return;
    const type = typeof frame.type === "string" ? frame.type : "";
    if (type === "error" || record(frame.error)) {
      const error = record(frame.error) ? frame.error : frame;
      const detail = [clean(error.code, 80), clean(error.message, 300)].filter(Boolean).join(": ");
      throw new ImageDeliveryError("provider-error", `The selected image provider stopped the render${detail ? `: ${detail}` : ""}. No fallback or automatic retry was attempted.`, "failed");
    }
    if (type.endsWith(".partial_image")) return;
    if (!type.endsWith(".completed")) return;
    completed = true;
    if (frame.usage !== undefined) usage = frame.usage;
    if (typeof frame.model === "string") model = frame.model;
    const rows = Array.isArray(frame.data) ? frame.data : typeof frame.b64_json === "string" ? [{ b64_json: frame.b64_json, ...(typeof frame.size === "string" ? { size: frame.size } : {}) }] : [];
    const start = typeof frame.image_index === "number" && Number.isInteger(frame.image_index) && frame.image_index >= 0 ? frame.image_index : images.size;
    // An image past the count asked for is not held: the render is not the one approved.
    if (start + rows.length > options.expected) throw new ImageDeliveryError("invalid-response", `The image provider sent more images than the ${options.expected} asked for.`, "uncertain");
    rows.forEach((row, offset) => { if (record(row) && typeof row.b64_json === "string") images.set(start + offset, { b64_json: row.b64_json, ...(typeof row.size === "string" ? { size: row.size } : {}) }); });
  };
  try {
    while (!done) {
      const next = await reader.read();
      if (next.done) break;
      options.onActivity?.();
      total += next.value.byteLength;
      if (total > maxTotal) throw new ImageDeliveryError("oversized-response", "The image provider response was too large.", "uncertain");
      buffer += decoder.decode(next.value, { stream: true });
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const event = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        handle(event);
        if (done) break;
      }
      if (buffer.length > options.maxEventBytes) throw new ImageDeliveryError("oversized-response", "The image provider response was too large.", "uncertain");
    }
    if (!done && buffer.trim()) handle(buffer);
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
    reader.releaseLock();
  }
  if (!completed || !images.size) throw new ImageDeliveryError("invalid-image", "The image stream ended before an image arrived.", "uncertain");
  // Every image is returned; the caller refuses more than it asked for.
  const data = [...images.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
  return { data, ...(usage !== undefined ? { usage } : {}), ...(model ? { model } : {}) };
}

/** A 202 job answer (contract section 4), or null when the body is not one. */
export function parseImageJob(body: unknown): { id: string; status: string; pollAfterSeconds?: number } | null {
  if (!record(body) || body.contract !== 1 || body.kind !== "image-job" || typeof body.id !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}$/.test(body.id)) return null;
  const status = typeof body.status === "string" ? body.status : "queued";
  return { id: body.id, status, ...(typeof body.poll_after_s === "number" && Number.isFinite(body.poll_after_s) ? { pollAfterSeconds: body.poll_after_s } : {}) };
}
export const clampPollSeconds = (seconds: number | undefined) => Math.min(30, Math.max(2, seconds ?? 5));

export interface PollJobOptions {
  id: string;
  firstDelaySeconds?: number;
  /** One GET of the job; resolves the parsed JSON body and HTTP status. */
  get: (signal: AbortSignal) => Promise<{ status: number; body: unknown }>;
  signal: AbortSignal;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  ceilingMs?: number;
  /** An error from `get` that must stop polling at once (not a transport
   * failure to retry), such as the connection changing. */
  fatal?: (error: unknown) => boolean;
}
/**
 * Polls one job until it succeeds, fails or expires. Never submits a render.
 * A poll that fails at the transport level is retried with backoff for up to
 * five minutes; after that the attempt is uncertain and the job id is named
 * so the same request_id can resume it.
 */
export async function pollImageJob(options: PollJobOptions): Promise<ImageResultBody> {
  const started = options.now(), ceiling = options.ceilingMs ?? RENDER_CEILING_MS;
  let delay = clampPollSeconds(options.firstDelaySeconds) * 1000, failingSince: number | undefined, backoff = 2_000;
  const uncertain = (why: string) => new ImageDeliveryError("job-uncertain", `${why} The render may still finish on the provider's side. Call generate_image again with the same request_id to check job ${options.id}; no new render will be sent.`, "uncertain");
  // The render's own 30 minute clock can fire mid-sleep: the job id and the
  // way back are still named.
  const timedOut = () => options.signal.aborted && (options.signal.reason as { name?: string } | undefined)?.name === "TimeoutError";
  for (;;) {
    if (options.now() - started > ceiling) throw uncertain("The image job ran past 30 minutes, so Murage stopped checking.");
    try { await options.sleep(delay, options.signal); }
    catch (error) { if (timedOut()) throw uncertain("The image job ran past 30 minutes, so Murage stopped checking."); throw error; }
    let answer: { status: number; body: unknown };
    try { answer = await options.get(AbortSignal.any([options.signal, AbortSignal.timeout(JOB_POLL_TIMEOUT_MS)])); }
    catch (error) {
      if (timedOut()) throw uncertain("The image job ran past 30 minutes, so Murage stopped checking.");
      if (options.signal.aborted || options.fatal?.(error)) throw error;
      failingSince ??= options.now();
      if (options.now() - failingSince > JOB_TRANSPORT_RETRY_MS) throw uncertain("The image job could not be checked for 5 minutes.");
      delay = backoff; backoff = Math.min(backoff * 2, 30_000);
      continue;
    }
    failingSince = undefined; backoff = 2_000;
    if (answer.status === 404 || answer.status === 410) throw uncertain(`The provider no longer knows job ${options.id}.`);
    if (answer.status >= 500) { delay = clampPollSeconds(undefined) * 1000; continue; }
    if (answer.status >= 400) throw new ImageDeliveryError("provider-error", `The selected image provider refused to report job ${options.id} (HTTP ${answer.status}).`, "uncertain");
    const body = answer.body;
    if (!record(body) || body.kind !== "image-job") throw new ImageDeliveryError("invalid-response", "The image provider returned an unreadable job.", "uncertain");
    const status = typeof body.status === "string" ? body.status : "";
    if (status === "succeeded") {
      const data = Array.isArray(body.data) ? body.data.filter((row): row is { b64_json: string } => record(row) && typeof row.b64_json === "string") : [];
      if (!data.length) throw new ImageDeliveryError("invalid-image", "The image job finished without an image.", "uncertain");
      return { data, ...(body.usage !== undefined ? { usage: body.usage } : {}), ...(typeof body.model === "string" ? { model: body.model } : {}) };
    }
    if (status === "failed") {
      const error = record(body.error) ? body.error : {};
      const detail = [clean(error.code, 80), clean(error.message, 300)].filter(Boolean).join(": ");
      throw new ImageDeliveryError("provider-error", `The selected image provider could not finish the render${detail ? `: ${detail}` : ""}. No fallback or automatic retry was attempted.`, "failed");
    }
    if (status === "expired") throw uncertain(`Job ${options.id} expired before its image was collected.`);
    delay = clampPollSeconds(typeof body.poll_after_s === "number" ? body.poll_after_s : undefined) * 1000;
  }
}

export const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener("abort", onAbort, { once: true });
});
