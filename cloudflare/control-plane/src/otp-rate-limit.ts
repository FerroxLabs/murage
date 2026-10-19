import { z } from "zod";

import { HTTPError, json } from "./http";

// Every Better Auth route that stores a fresh OTP and emails it. The
// recipient is `email`, except email-change where it is `newEmail`.
const OTP_SEND_PATHS = new Map<string, "email" | "newEmail">([
  ["/api/auth/email-otp/send-verification-otp", "email"],
  ["/api/auth/email-otp/request-password-reset", "email"],
  ["/api/auth/forget-password/email-otp", "email"],
  ["/api/auth/email-otp/request-email-change", "newEmail"],
]);
const RECIPIENT_WINDOW_MS = 15 * 60 * 1_000;
const RECIPIENT_MAX_ATTEMPTS = 3;
const RETENTION_MS = 24 * 60 * 60 * 1_000;
const recipientSchema = z.string().trim().min(1).max(254).toLowerCase();

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function recipientKey(email: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email)));
}

/** Fails closed: anything unparseable is refused, never waved through. */
async function normalizedRecipient(request: Request, field: "email" | "newEmail"): Promise<string> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    throw new HTTPError(400, "invalid_request");
  }
  const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[field] : undefined;
  const parsed = recipientSchema.safeParse(value);
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  return parsed.data;
}

/**
 * Better Auth parses form, multipart and text bodies too, which would bypass
 * the JSON-only recipient limiter. Only JSON reaches it. A POST with no
 * content-type is tolerated solely when its body is empty (e.g. sign-out).
 */
export async function requireJSONAuthBody(request: Request): Promise<void> {
  if (request.method !== "POST" || !new URL(request.url).pathname.startsWith("/api/auth/")) return;
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type === "application/json") return;
  if (!type && (await request.clone().arrayBuffer()).byteLength === 0) return;
  throw new HTTPError(415, "unsupported_media_type");
}

export interface OTPReservation {
  /** Better Auth's generic success response, when the recipient budget is spent. */
  limited: Response | null;
  /** Gives back the charge. Call when Better Auth did not send an email. */
  refund(): Promise<void>;
}

const NO_RESERVATION: OTPReservation = { limited: null, refund: async () => {} };

/**
 * Reserves one send from the recipient's budget before Better Auth runs.
 * Better Auth validates the body (`type`, email format) and applies its own
 * per-IP limit only inside its handler, so the caller refunds the reservation
 * when the handler answers anything but a success: otherwise anyone could
 * burn a victim's budget with invalid or throttled requests, and the victim
 * would silently get no email. Unparseable requests are refused (400).
 */
export async function reserveOTPRecipient(request: Request, env: Env): Promise<OTPReservation> {
  const url = new URL(request.url);
  const field = OTP_SEND_PATHS.get(url.pathname);
  if (request.method !== "POST" || !field) return NO_RESERVATION;

  const email = await normalizedRecipient(request, field);

  const now = Date.now();
  const windowCutoff = now - RECIPIENT_WINDOW_MS;
  const key = await recipientKey(email, env.BETTER_AUTH_SECRET);
  const charged = await env.DB.prepare(
    `INSERT INTO otp_recipient_rate_limits
      (recipient_key, window_started_at, attempts, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(recipient_key) DO UPDATE SET
       window_started_at = CASE
         WHEN window_started_at <= ? THEN excluded.window_started_at
         ELSE window_started_at
       END,
       attempts = CASE
         WHEN window_started_at <= ? THEN 1
         ELSE attempts + 1
       END,
       updated_at = excluded.updated_at
     WHERE window_started_at <= ? OR attempts < ?
     RETURNING window_started_at`,
  ).bind(key, now, now, windowCutoff, windowCutoff, windowCutoff, RECIPIENT_MAX_ATTEMPTS)
    .first<{ window_started_at: number }>();

  await env.DB.prepare(
    "DELETE FROM otp_recipient_rate_limits WHERE updated_at < ?",
  ).bind(now - RETENTION_MS).run();

  if (!charged) return { limited: json({ success: true }), refund: async () => {} };
  const windowStart = charged.window_started_at;
  let refunded = false;
  return {
    limited: null,
    async refund() {
      if (refunded) return;
      refunded = true;
      // Only inside the window this charge landed in; a reset window is not ours.
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM otp_recipient_rate_limits WHERE recipient_key = ? AND window_started_at = ? AND attempts <= 1",
        ).bind(key, windowStart),
        env.DB.prepare(
          "UPDATE otp_recipient_rate_limits SET attempts = attempts - 1 WHERE recipient_key = ? AND window_started_at = ? AND attempts > 1",
        ).bind(key, windowStart),
      ]);
    },
  };
}
