// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Server side of the Cloud bot email keystore (CLOUD-EMAIL-KEYSTORE-1019 r2). The record comes in on the boot pipe (`emailSecrets`), never from env
// and never through the generic credential path; changes go to the supervisor as `murage:email-secrets-save {rev, epoch, gen, doc}` (doc has no
// owner slot: the supervisor is its only writer) and are acknowledged with key ids only. Inert unless the boot envelope advertised `emailStore: 1`.
import type { EmailSecretsDoc } from "../email/email-secrets.ts";

export const EMAIL_SECRETS_SAVED = "murage:email-secrets-saved";
export const EMAIL_SECRETS_REFUSED = "murage:email-secrets-refused";
export type CloudEmailBackend = "ack" | "none";

/** The persist backend a Cloud home answers: "ack" only when the supervisor advertised the keystore with a valid record, else "none". */
export function cloudEmailBackend(boot: { emailStore?: 1; emailSecrets?: unknown } | null | undefined): CloudEmailBackend { return boot?.emailStore === 1 && boot.emailSecrets ? "ack" : "none"; }

/** Refusals a resave can fix: the write was not confirmed, or an older rev was fenced. Everything else is permanent for this doc. */
const RETRYABLE = new Set(["not_durable", "write_failed", "stale_revision"]);
const RETRY_STEPS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000];

/** Counts saves in one server run; `epoch` tells the supervisor a new run started, `gen` the email generation this run booted with.
 * With `io.post` the saver also RESENDS the latest doc under a new rev until it is acknowledged (a refusal or a silence is never the end of a save),
 * and `wait()` lets a caller hold a step (a rotation's revoke) until the save it depends on is durably acknowledged. */
export function createCloudEmailSaver(gen: number, now: () => number = Date.now, io: { post?: (message: object) => void; retryStepsMs?: readonly number[] } = {}) {
  const epoch = now();
  let rev = 0, acked = 0, tries = 0, last: Omit<EmailSecretsDoc, "owner"> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waiters: Array<{ rev: number; settle: (ok: boolean) => void }> = [];
  const steps = io.retryStepsMs?.length ? io.retryStepsMs : RETRY_STEPS_MS;
  const settleUpTo = (limit: number, ok: boolean) => { for (const w of waiters.splice(0)) if (w.rev <= limit) w.settle(ok); else waiters.push(w); };
  const stop = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const arm = (delay: number) => {
    stop();
    if (!io.post) return;
    timer = setTimeout(() => { timer = undefined; resend(); }, delay);
    timer.unref?.();
  };
  const build = () => ({ type: "murage:email-secrets-save" as const, rev: ++rev, epoch, gen, doc: last! });
  const resend = () => {
    if (!last || acked >= rev || !io.post) return;
    tries++;
    try { io.post(build()); } catch { /* the next timer tries again */ }
    arm(steps[Math.min(tries, steps.length - 1)]!);
  };
  return {
    message(doc: EmailSecretsDoc): { type: "murage:email-secrets-save"; rev: number; epoch: number; gen: number; doc: Omit<EmailSecretsDoc, "owner"> } {
      const { owner: _owner, ...slots } = doc;
      last = slots; tries = 0;
      const out = build();
      arm(steps[0]!);
      return out;
    },
    /** Key ids only; a stale epoch or another generation is ignored. A retryable refusal resends the latest doc; a permanent one ends the wait (false). */
    ack(message: unknown): boolean {
      if (!message || typeof message !== "object") return false;
      const m = message as { type?: unknown; rev?: unknown; epoch?: unknown; gen?: unknown; keyIds?: unknown; reason?: unknown };
      if (m.type === EMAIL_SECRETS_REFUSED) {
        if (m.epoch !== epoch || typeof m.rev !== "number") return true;
        if (typeof m.reason === "string" && RETRYABLE.has(m.reason)) { if (m.reason === "stale_revision" || m.rev === rev) arm(m.reason === "stale_revision" ? 0 : steps[Math.min(tries, steps.length - 1)]!); }
        else if (m.rev === rev) { stop(); settleUpTo(rev, false); }
        return true;
      }
      if (m.type !== EMAIL_SECRETS_SAVED) return false;
      if (m.epoch !== epoch || m.gen !== gen || typeof m.rev !== "number" || !Array.isArray(m.keyIds)) return true;
      if (m.rev > acked) acked = m.rev;
      if (acked >= rev) { stop(); tries = 0; }
      settleUpTo(acked, true);
      return true;
    },
    /** True once the latest save is acknowledged (no save yet counts as saved). */
    saved: () => acked >= rev,
    /** Resolves true when every save made so far is acknowledged durably, false after `timeoutMs` or a permanent refusal. */
    wait(timeoutMs: number): Promise<boolean> {
      if (acked >= rev) return Promise.resolve(true);
      return new Promise<boolean>(resolve => {
        const target = rev;
        const timeout = setTimeout(() => { const at = waiters.findIndex(w => w.settle === done); if (at >= 0) waiters.splice(at, 1); resolve(false); }, timeoutMs);
        timeout.unref?.();
        const done = (ok: boolean) => { clearTimeout(timeout); resolve(ok); };
        waiters.push({ rev: target, settle: done });
      });
    },
  };
}
