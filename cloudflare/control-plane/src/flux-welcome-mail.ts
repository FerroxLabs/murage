// SPDX-License-Identifier: AGPL-3.0-or-later
// The one Flux welcome email per Murage account (Sean 2026-11-03). flux-link.ts ensureOwnerLinked queues it (flux_welcome_mail, migration
// 0140) in the same batch as the owner's first link row; the cron sweep below sends it. A send is claimed first with an attempt token (so
// two sweeps never send it together, and only the claim that sent it records sent_at), a failure backs off and is tried again up to
// FLUX_WELCOME_MAX_ATTEMPTS times, and nothing here ever blocks a key mint or a grant. Logs name no address.
// Residual: the provider accepts the message and the worker dies (or sent_at is never written). The claim lease then holds the row for
// 24 h, and the claim that finds that leftover token is the final one (attempts goes to the cap in the same statement): the email goes
// out once more, and if that result is lost too the row ends 'gave_up' with no further send. At most one extra copy, ever.
import { mailSink, senderOrFail, type TransactionalEmailSender } from "./email";
import { fluxWelcomeEmail, ownerEmailOf } from "./flux-link";

/** A claimed send that never recorded its result may be tried again after this (a lost ack resends after a day, not minutes). */
export const FLUX_WELCOME_CLAIM_MS = 24 * 3_600_000;
/** After this many failed tries the row is terminal ('gave_up'): never due again, never requeued. */
export const FLUX_WELCOME_MAX_ATTEMPTS = 8;
const BATCH = 20;
/** The gap after the n-th failed try: 5 minutes doubling, at most 6 hours. */
export const fluxWelcomeBackoff = (attempts: number) => Math.min(6 * 3_600_000, 5 * 60_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 10));

/** Sends one owner's welcome email if it is due and unsent. True when it went out on this call. */
export async function sendFluxWelcome(env: Env, ownerId: string, now = Date.now(), sender: TransactionalEmailSender = senderOrFail(env)): Promise<boolean> {
  const token = crypto.randomUUID();
  // A token still set means an earlier claim never recorded its result (it may have been sent): this claim is the final one.
  const claim = await env.DB.prepare(`UPDATE flux_welcome_mail SET attempts=CASE WHEN attempt_token IS NULL THEN attempts+1 ELSE ? END,
    next_attempt_at=?,attempt_token=? WHERE owner_user_id=? AND sent_at IS NULL AND terminal IS NULL AND next_attempt_at<=? AND attempts<?`)
    .bind(FLUX_WELCOME_MAX_ATTEMPTS, now + FLUX_WELCOME_CLAIM_MS, token, ownerId, now, FLUX_WELCOME_MAX_ATTEMPTS).run();
  if (claim.meta.changes !== 1) {
    // At the cap (the last try's lease ran out without a result): finish the row so the sweep stops reading it.
    await env.DB.prepare(`UPDATE flux_welcome_mail SET terminal='gave_up',attempt_token=NULL
      WHERE owner_user_id=? AND sent_at IS NULL AND terminal IS NULL AND next_attempt_at<=? AND attempts>=?`)
      .bind(ownerId, now, FLUX_WELCOME_MAX_ATTEMPTS).run();
    return false;
  }
  const row = await env.DB.prepare("SELECT created,attempts FROM flux_welcome_mail WHERE owner_user_id=?").bind(ownerId)
    .first<{ created: number; attempts: number }>();
  try {
    // Staging mails only the sink, never the real provider, whatever sender was resolved.
    if ((env as { MURAGE_ENV?: string }).MURAGE_ENV === "staging" && !mailSink(env)) throw new Error("flux_welcome_staging_sink_off");
    const to = await ownerEmailOf(env, ownerId);
    if (!to || !row) throw new Error("flux_welcome_undeliverable");
    const m = fluxWelcomeEmail(env, row.created === 1);
    await sender.send({ to, from: { email: env.EMAIL_FROM ?? "noreply@murage.ai", name: "Murage" }, subject: m.emailSubject, html: m.emailHtml, text: m.emailText });
  } catch {
    const attempts = row?.attempts ?? FLUX_WELCOME_MAX_ATTEMPTS;
    await env.DB.prepare(`UPDATE flux_welcome_mail SET next_attempt_at=?,attempt_token=NULL,terminal=CASE WHEN attempts>=? THEN 'gave_up' ELSE NULL END
      WHERE owner_user_id=? AND sent_at IS NULL AND attempt_token=?`)
      .bind(now + fluxWelcomeBackoff(attempts), FLUX_WELCOME_MAX_ATTEMPTS, ownerId, token).run();
    console.error(JSON.stringify({ message: "flux welcome email send failed", attempts: row?.attempts ?? null }));
    return false;
  }
  // Sent. Record it under this claim only; a failed write (or one that changed no row) is retried here, and if it never lands the 24 h
  // lease holds the row and the next claim is the final one.
  for (let i = 0; i < 3; i++) {
    try {
      const done = await env.DB.prepare("UPDATE flux_welcome_mail SET sent_at=?,attempt_token=NULL WHERE owner_user_id=? AND attempt_token=? AND sent_at IS NULL")
        .bind(now, ownerId, token).run();
      if (done.meta.changes === 1) return true;
    } catch { /* tried again */ }
  }
  console.error(JSON.stringify({ message: "flux welcome email sent but not recorded", attempts: row?.attempts ?? null }));
  return true;
}

/** Cron: every due, unsent welcome email (bounded). One owner's failure never stops the others. Returns how many went out. */
export async function sweepFluxWelcome(env: Env, now = Date.now(), sender?: TransactionalEmailSender): Promise<number> {
  const due = await env.DB.prepare(`SELECT owner_user_id FROM flux_welcome_mail WHERE sent_at IS NULL AND terminal IS NULL AND next_attempt_at<=?
    ORDER BY next_attempt_at LIMIT ?`).bind(now, BATCH).all<{ owner_user_id: string }>();
  let sent = 0;
  for (const r of due.results) {
    try { if (await sendFluxWelcome(env, r.owner_user_id, now, sender)) sent++; } catch { /* retried next sweep */ }
  }
  return sent;
}
