export interface TransactionalEmailSender {
  send(message: {
    to: string;
    from: { email: string; name: string };
    subject: string;
    html: string;
    text: string;
  }): Promise<void>;
}

// ---- The ONE way out for transactional mail (TRUST-FIRST-FACTOR.md revision 2, part C; Astra TRUST-1 #8, TRUST-2 F2-F5) ----------
// Every sender in src/ resolves its default through transactionalSender(env); nothing else touches the EMAIL binding (a source test,
// test/mail-sink.test.ts, fails on any `EMAIL` binding access, alias or destructuring outside this file: Astra TRUST-2 F5).
//
// Staging cannot send real mail (the send_email binding needs the sender's zone on the Worker's own Cloudflare account). There, and
// only there, mail can be written to a sink database instead. The sink engages iff BOTH hold at runtime:
//   - env.MAIL_SINK is a D1 binding. It is declared ONLY in wrangler.jsonc env.staging (database murage-cloud-staging-mailsink); the
//     production Worker has no such binding, so the sink cannot engage there whatever its vars say. scripts/check-deploy.mjs refuses
//     a configuration that declares MAIL_SINK or STAGING_MAIL_SINK anywhere but env.staging, or with another database id (F2).
//   - env.STAGING_MAIL_SINK === "1" (set by the operator on staging only).
// Otherwise the real EMAIL binding is used. With the sink engaged, ONLY recipients on MAIL_SINK_ALLOWLIST are written (below); every other
// recipient is rejected (the send throws, the same failure every caller already handles, e.g. the trust code's 503 email_unavailable)
// and never falls through to the real EMAIL binding. Sink rows hold (to_addr, subject, text) only, never the HTML, and the sink logs nothing
// about a message. sweepMailSink (cron) deletes rows older than 24 h; the only documented read path is the operator's manual,
// read-only `SELECT ... WHERE created_at > now - 24 h` (README "Staging mail sink"). No route reads the sink.

/** Rows older than this are deleted by the cron sweep, and the documented read path never shows them (F4). */
export const MAIL_SINK_RETENTION_MS = 24 * 60 * 60_000;
const isD1 = (v: unknown): v is D1Database =>
  typeof v === "object" && v !== null && typeof (v as D1Database).prepare === "function" && typeof (v as D1Database).batch === "function";
const sinkBinding = (env: Env): D1Database | null => {
  const b = (env as unknown as { MAIL_SINK?: unknown }).MAIL_SINK;
  return isD1(b) ? b : null;
};

/** The staging sink database, iff the sink is engaged (the binding AND the var); null everywhere else. */
export function mailSink(env: Env): D1Database | null {
  const db = sinkBinding(env);
  return db && (env as unknown as { STAGING_MAIL_SINK?: unknown }).STAGING_MAIL_SINK === "1" ? db : null;
}

/**
 * MAIL_SINK_ALLOWLIST: comma-separated exact addresses and/or "@domain" entries (an "@domain" entry matches exactly that domain, never a
 * subdomain). Case-insensitive. Missing, empty or not a string: nothing is allowed.
 */
export function sinkRecipientAllowed(env: Env, recipient: string): boolean {
  const raw = (env as unknown as { MAIL_SINK_ALLOWLIST?: unknown }).MAIL_SINK_ALLOWLIST;
  if (typeof raw !== "string" || typeof recipient !== "string") return false;
  const to = recipient.trim().toLowerCase();
  const at = to.indexOf("@");
  if (at < 1 || at !== to.lastIndexOf("@") || at === to.length - 1 || /[\s,;<>"']/.test(to)) return false;
  for (const entry of raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)) {
    if (entry.startsWith("@") ? entry.length > 1 && to.slice(at) === entry : to === entry) return true;
  }
  return false;
}

/** The sender every module uses by default: the staging sink when engaged, else the EMAIL binding; null when neither exists. */
export function transactionalSender(env: Env): TransactionalEmailSender | null {
  const sink = mailSink(env);
  if (sink) {
    return {
      async send(message) {
        // Not on the allowlist: refuse. Never the real provider, never a sink row, and nothing logged about the message.
        if (!sinkRecipientAllowed(env, message.to)) throw new Error("mail_sink_recipient_rejected");
        await sink.prepare("INSERT INTO staging_mail_sink (id,to_addr,subject,text,created_at) VALUES (?,?,?,?,?)")
          .bind(crypto.randomUUID(), message.to, message.subject, message.text, Date.now()).run();
      },
    };
  }
  const binding = (env as unknown as { EMAIL?: { send(message: unknown): Promise<unknown> } }).EMAIL;
  if (!binding) return null;
  return { async send(message) { await binding.send(message); } };
}

/** transactionalSender for callers that treat a missing sender as a failed send (the send throws). */
export function senderOrFail(env: Env): TransactionalEmailSender {
  return transactionalSender(env) ?? { async send() { throw new Error("email_unavailable"); } };
}

/** Cron: delete sink rows older than 24 h whenever the binding exists (engaged or not). Production has no binding: a no-op. */
export async function sweepMailSink(env: Env, nowMs = Date.now()): Promise<void> {
  const db = sinkBinding(env);
  if (!db) return;
  await db.prepare("DELETE FROM staging_mail_sink WHERE created_at<=?").bind(nowMs - MAIL_SINK_RETENTION_MS).run();
}

export interface OTPEmailInput {
  email: string;
  otp: string;
  type: "sign-in" | "email-verification" | "forget-password" | "change-email" | "device-pairing";
}

const SUBJECTS = {
  "sign-in": "Your Murage sign-in code",
  "email-verification": "Verify your Murage email",
  "forget-password": "Reset your Murage password",
  "change-email": "Confirm your Murage email change",
  "device-pairing": "Your Murage cloud pairing code",
} as const satisfies Record<OTPEmailInput["type"], string>;

export function buildOTPEmail(from: string, input: OTPEmailInput) {
  const subject = SUBJECTS[input.type];
  const text = `${subject}\n\nYour one-time code is: ${input.otp}\n\nIt expires in 10 minutes. If you did not request this code, you can ignore this email.`;
  const html = `<!doctype html><html><body><h1>${subject}</h1><p>Your one-time code is:</p><p style="font-size:32px;font-weight:700;letter-spacing:0.15em">${input.otp}</p><p>It expires in 10 minutes. If you did not request this code, you can ignore this email.</p></body></html>`;
  return {
    to: input.email,
    from: { email: from, name: "Murage" },
    subject,
    html,
    text,
  };
}

/** Like sendOTPEmail, but reports whether the provider accepted the message. */
export async function sendOTPEmailChecked(
  sender: TransactionalEmailSender,
  from: string,
  input: OTPEmailInput,
  requestId: string,
): Promise<boolean> {
  try {
    await sender.send(buildOTPEmail(from, input));
    return true;
  } catch {
    // Same log discipline as sendOTPEmail: no address, code or provider error.
    console.error(JSON.stringify({ message: "transactional email send failed", requestId }));
    return false;
  }
}

export async function sendOTPEmail(
  sender: TransactionalEmailSender,
  from: string,
  input: OTPEmailInput,
  requestId: string,
): Promise<void> {
  // Authentication responses stay enumeration-safe: the failure is logged, never surfaced.
  await sendOTPEmailChecked(sender, from, input, requestId);
}
