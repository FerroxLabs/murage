// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bot's inbox binding (design 2.2, 2.5, 2.6, 3.3 policy sync, 9.2). Every remote step writes its intent first, so a crash at any point
// leaves a row that boot (reconcileBindings) carries on from:
//   none ─owner enable─> provisioning(key) ─> provisioning(inbox) ─> active | failed
//   failed ─Retry─> provisioning ; failed ─Remove─> removing
//   active | paused | billing_hold | failed ─Remove or bot deleted─> removing ─202─> remove_requested ─deleted event or 404─> tombstone
// Setup step 1 mints the email:bot key with Idempotency-Key murage-key:<install>:<op_id> (kept 24 h by Flux); step 2 creates the inbox
// with murage-inbox:<install>:<op_id> (owner token, bot_id), and a 409 inbox_exists is adopted. A bodiless 404 from bot-keys means Flux's
// key switch is off (r2.5): bot email is dark, so the setup row is dropped rather than shown as a failure. Removal: #7's 202 closing is
// remove_requested with closing_until, never done (Keep address restores it, #37); done is email.inbox.deleted or a 404 from #5, then the
// key is revoked and the binding becomes a tombstone (inbox id, address hash, removed_at).
import { inboxIdempotencyKey, keyIdempotencyKey, sha256Hex, uuidv7 } from "./canonical.ts";
import type { EmailSecretStore } from "./email-secrets.ts";
import { LIVE_BINDING_STATES, type BindingRow, type BindingState, type EmailStore, type TombstoneRow } from "./email-store.ts";
import { botKeysDark, type FluxEmailClient } from "./flux-email-client.ts";

export const KEY_IDEMPOTENCY_WINDOW_MS = 24 * 3_600_000;
export const TOMBSTONE_KEEP_MS = 30 * 86_400_000;
const ROTATE_SCOPE = "rotate:";
export const REMOVAL_RETRY_MS = [60_000, 300_000, 1_800_000, 7_200_000] as const;

export type BindingClient = Pick<FluxEmailClient, "mintBotKey" | "revokeBotKey" | "createInbox" | "getInbox" | "deleteInbox" | "restoreInbox" | "setSendPolicy" | "patchInbox" | "resumeInbox" | "listInboxes">;

export interface BindingServiceOptions {
  store: EmailStore;
  client: BindingClient;
  secrets: EmailSecretStore;
  installId: string;
  now?: () => number;
  newId?: () => string;
  /** Withdraws every open send of the bot (send-service withdrawAllForBot). */
  withdrawSends?: (botId: string, reason: "inbox_removed" | "bot_deleted" | "account_off") => void;
  onRefusal?: (code: string) => void;
  /** A binding moved between active, paused, billing_hold or account_off (the `email-status` notice, section 6). */
  onStateChange?: (row: BindingRow) => void;
}

/** An owner act's answer: the row, or the Flux code that refused it. */
export type OwnerActResult = { ok: true; row: BindingRow | null } | { ok: false; code: string; status: number };
/** A non-ok Flux answer as an owner-act refusal; no owner token is the owner's sign-in, never a silent failure. */
export function ownerActFailure(answer: { kind: string; code?: string; status?: number; reason?: string }): { ok: false; code: string; status: number } {
  if (answer.kind === "refused") return { ok: false, code: answer.code ?? "unavailable", status: answer.status ?? 400 };
  if (answer.kind === "uncertain" && answer.reason === "no_credential") return { ok: false, code: "owner_required", status: 403 };
  if (botKeysDark(answer)) return { ok: false, code: "email_dark", status: 404 };
  return { ok: false, code: "unavailable", status: 503 };
}

/** The bot-deletion intent writes (2.6), usable without the service: store.deleteBot calls them whenever the email tables exist, with
 * email on or off, inside its own transactions. */
export function recordDeletionIntent(store: EmailStore, botId: string, now: number): void {
  const binding = store.getBinding(botId);
  if (!binding) return;
  store.upsertTombstone({ botId, inboxId: binding.inboxId ?? "", addressHash: binding.address ? sha256Hex(binding.address.toLowerCase()) : null, state: "removing", committed: false, reason: "bot_deleted", keyId: binding.emailKeyRef, createdAt: now, removedAt: null, nextTryAt: null });
}
export function commitDeletionIntent(store: EmailStore, botId: string): void {
  for (const tomb of store.tombstones()) if (tomb.botId === botId && tomb.state === "removing" && !tomb.committed) store.casTombstone(botId, tomb.inboxId, tomb.revision, { committed: true });
}
export function withdrawDeletionIntent(store: EmailStore, botId: string): void {
  for (const tomb of store.tombstones()) if (tomb.botId === botId && tomb.state === "removing" && !tomb.committed) store.deleteTombstone(botId, tomb.inboxId, tomb.revision);
}

/** The same binding generation: one setup op made it, for one inbox, with one key. A new setup after a removal has a new op_id. */
function sameBinding(a: BindingRow, b: BindingRow): boolean {
  return a.botId === b.botId && a.inboxId === b.inboxId && a.opId === b.opId && a.emailKeyRef === b.emailKeyRef;
}

export class EmailBindingService {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly options: BindingServiceOptions;
  constructor(options: BindingServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => uuidv7(this.now()));
  }
  private get store() { return this.options.store; }

  /** Owner act: give this bot an address. A new binding, or a failed one retried, starts at step `key` with a new op_id. */
  async enable(botId: string, input: { username?: string; displayName?: string }): Promise<BindingRow | null> {
    const now = this.now();
    const existing = this.store.getBinding(botId);
    if (!existing) {
      this.store.insertBinding({ botId, inboxId: null, address: null, username: input.username ?? null, displayName: input.displayName ?? null, emailKeyRef: null, fluxAccountId: null, state: "provisioning", step: "key", opId: this.newId(), opStartedAt: now, policy: "auto", failure: null, updatedAt: now });
    } else if (existing.state === "failed") {
      this.store.casBinding(botId, existing.revision, { state: "provisioning", step: this.options.secrets.botKey(botId) ? "inbox" : "key", opId: this.newId(), opStartedAt: now, failure: null, username: input.username ?? existing.username, displayName: input.displayName ?? existing.displayName }, now);
    }
    return this.advance(botId);
  }

  /** Runs the next setup step of a provisioning binding (also from boot). */
  async advance(botId: string): Promise<BindingRow | null> {
    let row = this.store.getBinding(botId);
    if (!row || row.state !== "provisioning") return row!;
    // step 1: the key. A key already in the secret store moves the binding to step inbox (boot checks the store first).
    if (row.step === "key" && this.options.secrets.botKey(botId)) row = this.store.casBinding(botId, row.revision, { step: "inbox", emailKeyRef: this.options.secrets.botKey(botId)!.keyId }, this.now()) ?? this.store.getBinding(botId)!;
    if (row.step === "key") {
      // past Flux's 24 h idempotency window the old op cannot be replayed: a new op_id (a key the first op minted and never saved is not
      // listable through bot-keys yet; Flux revokes unlabelled strays on its side, open item in BUILD-LOG)
      if (row.opStartedAt !== null && this.now() - row.opStartedAt >= KEY_IDEMPOTENCY_WINDOW_MS) row = this.store.casBinding(botId, row.revision, { opId: this.newId(), opStartedAt: this.now() }, this.now()) ?? this.store.getBinding(botId)!;
      const minted = await this.options.client.mintBotKey({ botId }, keyIdempotencyKey(this.options.installId, row.opId!));
      row = this.store.getBinding(botId)!;
      if (row.state !== "provisioning" || row.step !== "key") return row;
      if (botKeysDark(minted)) {
        // r2.5: Flux's bot key switch is off. Nothing was made at Flux; the row goes, the launch switch is read again, no failure shows.
        if (!row.inboxId) this.store.deleteBinding(botId, row.revision);
        this.options.onRefusal?.("email_not_enabled");
        return this.store.getBinding(botId);
      }
      if (minted.kind === "ok" && minted.body.key && minted.body.key_id) {
        this.options.secrets.setBotKey(botId, { token: minted.body.key, keyId: minted.body.key_id });
        row = this.store.casBinding(botId, row.revision, { step: "inbox", emailKeyRef: minted.body.key_id }, this.now()) ?? this.store.getBinding(botId)!;
      } else if (minted.kind === "refused") {
        this.options.onRefusal?.(minted.code);
        return this.store.casBinding(botId, row.revision, { state: "failed", failure: minted.code }, this.now()) ?? this.store.getBinding(botId)!;
      } else return row; // no answer: the same op_id is replayed on the next advance (Flux returns the same key inside 24 h)
    }
    if (row.step === "inbox") {
      const created = await this.options.client.createInbox({ botId, username: row.username ?? undefined, displayName: row.displayName ?? undefined }, inboxIdempotencyKey(this.options.installId, row.opId!));
      row = this.store.getBinding(botId)!;
      if (row.state !== "provisioning" || row.step !== "inbox") return row;
      if (created.kind === "ok" && created.body.id) return this.activate(row, created.body.id, created.body.address ?? null, created.body.send_policy);
      if (created.kind === "refused" && created.code === "inbox_exists" && typeof created.error.fields.inbox_id === "string") {
        // adopted: this bot's inbox already exists (an earlier run, or a reinstall); read it for the address
        const inboxId = created.error.fields.inbox_id;
        const read = await this.options.client.getInbox({ kind: "owner" }, inboxId);
        const latest = this.store.getBinding(botId)!;
        if (read.kind === "ok") return this.activate(latest, inboxId, read.body.address ?? null, read.body.send_policy);
        return latest;
      }
      if (created.kind === "refused") { this.options.onRefusal?.(created.code); return this.store.casBinding(botId, row.revision, { state: "failed", failure: created.code }, this.now()) ?? this.store.getBinding(botId)!; }
      return row;
    }
    return row;
  }

  private activate(row: BindingRow, inboxId: string, address: string | null, policy: unknown): BindingRow {
    return this.store.casBinding(row.botId, row.revision, { state: "active", step: null, inboxId, address, failure: null, ...(policy === "ask" || policy === "auto" ? { policy } : {}) }, this.now()) ?? this.store.getBinding(row.botId)!;
  }

  /** Mirrors Flux's inbox state after a read or an event (pause, resume, billing hold). Only owner acts write provisioning or removing. */
  mirror(botId: string, fluxState: string, closingUntil?: string | null): BindingRow | null {
    const row = this.store.getBinding(botId);
    if (!row || !LIVE_BINDING_STATES.has(row.state)) return row;
    const state = LIVE_BINDING_STATES.has(fluxState as BindingState) ? fluxState as BindingState : null;
    if (!state) return row;
    const until = state === "closing" ? (closingUntil === undefined ? row.closingUntil : closingUntil) : null;
    if (state === row.state && until === row.closingUntil) return row;
    return this.store.casBinding(botId, row.revision, { state, closingUntil: until }, this.now());
  }

  /** A refusal that names the inbox's state (billing #518): 403 inbox_closing -> closing (closing_until kept for the panel), a credit
   *  code carrying inbox_state "grace" -> grace, 403 bot_paused -> paused. Reads only the code and those two fields, never the manage link. */
  noteRefusal(botId: string, code: string, fields: Record<string, unknown> | undefined): BindingRow | null {
    const target = code === "inbox_closing" ? "closing" : fields?.inbox_state === "grace" ? "grace" : code === "bot_paused" ? "paused" : null;
    if (!target) return null;
    const before = this.store.getBinding(botId);
    const next = this.mirror(botId, target, target === "closing" ? (typeof fields?.closing_until === "string" ? fields.closing_until : null) : undefined);
    if (next && next.state !== before?.state) this.changed(next);
    return next;
  }

  /** A #28 lifecycle event (billing #518) mirrored into the inbox's binding. A state the event does not name exactly (resumed, renewed,
   *  restored, credited) is re-read from #5; deleted ends the binding the way a 404 does. */
  async applyLifecycle(event: { type: string; inbox_id?: string; data?: Record<string, unknown> }): Promise<BindingRow | null> {
    // Flux #519/#520: the account switch arrives on #28 too (no inbox); renewal_due carries money only and changes no state
    if (event.type === "email.account.disabled" || event.type === "email.account.enabled") { this.accountState(event.type === "email.account.enabled"); return null; }
    if (event.type === "email.inbox.renewal_due") return null;
    const row = event.inbox_id ? this.store.bindingByInbox(event.inbox_id) : null;
    if (!row) return null;
    const data = event.data ?? {};
    switch (event.type) {
      case "email.bot.paused": { const next = this.mirror(row.botId, "paused"); if (next && next.state !== row.state) this.changed(next); return next; }
      case "email.inbox.grace": { const next = this.mirror(row.botId, "grace"); if (next && next.state !== row.state) this.changed(next); return next; }
      case "email.inbox.closing": {
        const until = typeof data.closing_until === "string" ? data.closing_until : typeof data.until === "string" ? data.until : null;
        const next = this.mirror(row.botId, "closing", until); if (next && next.state !== row.state) this.changed(next); return next;
      }
      case "email.bot.resumed": case "email.inbox.renewed": case "email.inbox.restored": case "email.inbox.credited": return (await this.refresh(row.botId)).row;
      case "email.inbox.deleted": { await this.inboxDeleted(event.inbox_id!); return this.store.getBinding(row.botId); }
      default: return row;
    }
  }

  private changed(row: BindingRow | null): BindingRow | null { if (row) { try { this.options.onStateChange?.(row); } catch { /* a notice never decides a state */ } } return row; }

  /** Reads #5 and mirrors its state (Settings open, the slow tick). The pause object comes back for the panel line. */
  async refresh(botId: string): Promise<{ row: BindingRow | null; pause: { reason?: string; resumable_by?: string } | null; sendsToday?: number; dailyCap?: number }> {
    const row = this.store.getBinding(botId);
    if (!row?.inboxId || !LIVE_BINDING_STATES.has(row.state)) return { row, pause: null };
    const read = await this.options.client.getInbox({ kind: "owner" }, row.inboxId);
    if (read.kind !== "ok") return { row: this.store.getBinding(botId), pause: null };
    const before = this.store.getBinding(botId)?.state;
    const next = this.mirror(botId, String(read.body.state ?? ""), typeof read.body.closing_until === "string" ? read.body.closing_until : undefined);
    if (next && next.state !== before) this.changed(next);
    const pause = read.body.pause && typeof read.body.pause === "object" ? read.body.pause as { reason?: string; resumable_by?: string } : null;
    return { row: next, pause, ...(typeof read.body.sends_today === "number" ? { sendsToday: read.body.sends_today } : {}), ...(typeof read.body.daily_send_cap === "number" ? { dailyCap: read.body.daily_send_cap } : {}) };
  }

  /** Owner Pause (2.6, "Pause sending"): PATCH #6 {paused: true}; the address and mail stay, inbound still arrives. */
  async pause(botId: string): Promise<OwnerActResult> {
    const row = this.store.getBinding(botId);
    if (!row?.inboxId || !(row.state === "active" || row.state === "billing_hold" || row.state === "grace")) return { ok: false, code: "not_active", status: 409 };
    const answer = await this.options.client.patchInbox(row.inboxId, { paused: true });
    if (answer.kind !== "ok") return ownerActFailure(answer);
    return { ok: true, row: this.changed(this.mirror(botId, "paused")) };
  }

  /** Owner Resume (#8): `acknowledge` is the pause reason Flux gave; the owner's note is required by the panel before this runs. */
  async resume(botId: string): Promise<OwnerActResult> {
    const row = this.store.getBinding(botId);
    if (!row?.inboxId || row.state !== "paused") return { ok: false, code: "not_paused", status: 409 };
    const read = await this.options.client.getInbox({ kind: "owner" }, row.inboxId);
    if (read.kind !== "ok") return ownerActFailure(read);
    const reason = read.body.pause && typeof read.body.pause === "object" ? String((read.body.pause as { reason?: unknown }).reason ?? "") : "";
    if (!reason) return { ok: true, row: this.changed(this.mirror(botId, String(read.body.state ?? "active"))) };
    const answer = await this.options.client.resumeInbox(row.inboxId, reason);
    if (answer.kind !== "ok") return ownerActFailure(answer);
    const next = this.changed(this.mirror(botId, String(answer.body.state ?? "active")));
    // Flux #520: an owner resume never clears a complaint or support pause; a binding still paused says why instead of "resumed"
    if (next?.state === "paused") return { ok: false, code: "still_paused", status: 409 };
    return { ok: true, row: next };
  }

  /** Account off (2.0): every live binding is account_off (tools unlisted, no sends, open cards withdrawn). Account on: back to active. */
  accountState(on: boolean): BindingRow[] {
    const moved: BindingRow[] = [];
    for (const row of this.store.bindings()) {
      if (!on && (["active", "paused", "billing_hold", "grace"] as string[]).includes(row.state)) {
        const next = this.store.casBinding(row.botId, row.revision, { state: "account_off" }, this.now());
        if (next) { this.options.withdrawSends?.(row.botId, "account_off"); moved.push(next); this.changed(next); }
      } else if (on && row.state === "account_off") {
        const next = this.store.casBinding(row.botId, row.revision, { state: "active" }, this.now());
        if (next) { moved.push(next); this.changed(next); }
      }
    }
    return moved;
  }

  /** Reconnect (section 7 restore): the owner lists #4, the inbox whose bot_id is this bot is adopted, a new email key is minted for it. */
  async reconnect(botId: string): Promise<OwnerActResult> {
    const row = this.store.getBinding(botId);
    if (!row || row.state !== "restored_unverified") return { ok: false, code: "not_restored", status: 409 };
    const listed = await this.options.client.listInboxes({ kind: "owner" });
    if (listed.kind !== "ok") return ownerActFailure(listed);
    const inbox = (listed.body.data ?? []).find(item => item.bot_id === botId && item.state !== "deleted");
    if (!inbox) return { ok: false, code: "inbox_not_found", status: 404 };
    const opId = this.newId();
    const minted = await this.options.client.mintBotKey({ botId }, keyIdempotencyKey(this.options.installId, opId));
    if (minted.kind !== "ok") return ownerActFailure(minted);
    if (!minted.body.key || !minted.body.key_id) return { ok: false, code: "unavailable", status: 503 };
    this.options.secrets.setBotKey(botId, { token: minted.body.key, keyId: minted.body.key_id });
    const latest = this.store.getBinding(botId);
    if (!latest) return { ok: true, row: null };
    const state: BindingState = inbox.state && inbox.state !== "active" && LIVE_BINDING_STATES.has(inbox.state as BindingState) ? inbox.state as BindingState : "active";
    return { ok: true, row: this.changed(this.store.casBinding(botId, latest.revision, { state, inboxId: inbox.id, address: inbox.address ?? latest.address, emailKeyRef: minted.body.key_id, failure: null }, this.now())) };
  }

  // ---- removal (2.6) ----

  /** Owner Remove: removing at once (sends refused, open cards withdrawn), then DELETE #7. */
  async remove(botId: string, reason: "owner" | "bot_deleted" = "owner"): Promise<BindingRow | TombstoneRow | null> {
    const row = this.store.getBinding(botId);
    if (!row) return null;
    if (row.state !== "removing" && row.state !== "remove_requested") {
      const next = this.store.casBinding(botId, row.revision, { state: "removing" }, this.now());
      if (!next) return this.store.getBinding(botId);
      this.options.withdrawSends?.(botId, reason === "bot_deleted" ? "bot_deleted" : "inbox_removed");
    }
    return this.continueRemoval(botId);
  }

  /** One removal is one binding generation: the row read here (inbox, setup op, key ref) is carried across every network await, and each
   * step after an await goes on only while the saved binding is still that generation. A removal that finished elsewhere meanwhile, and a
   * new setup after it, leave this one a no-op: the replacement binding and its key are never touched (Astra r2 High #4). */
  async continueRemoval(botId: string): Promise<BindingRow | TombstoneRow | null> {
    const start = this.store.getBinding(botId);
    if (!start) return null;
    if (!start.inboxId) return this.tombstone(start); // nothing was ever created at Flux; a key minted at step 2 is still revoked
    let row: BindingRow = start;
    if (row.state === "removing") {
      const answer = await this.options.client.deleteInbox(start.inboxId);
      const current = this.sameGeneration(start);
      if (!current || current.state !== "removing") return current ?? this.store.getBinding(botId);
      // r2.5: 202 state "closing" with closing_until: the address can still be kept until then (Keep address, #37)
      if (answer.kind === "held" || answer.kind === "ok") {
        const moved = this.store.casBinding(botId, current.revision, { state: "remove_requested", closingUntil: typeof answer.body.closing_until === "string" ? answer.body.closing_until : null }, this.now()) ?? this.sameGeneration(start);
        if (!moved) return this.store.getBinding(botId);
        row = moved;
      } else if (answer.kind === "refused" && (answer.status === 404 || answer.code === "inbox_not_found")) return this.tombstone(start);
      else return current; // retried with backoff by the reaper
    }
    if (row.state === "remove_requested") {
      const read = await this.options.client.getInbox({ kind: "owner" }, start.inboxId);
      const latest = this.sameGeneration(start);
      if (!latest) return this.store.getBinding(botId);
      if (read.kind === "refused" && (read.status === 404 || read.code === "inbox_not_found")) return this.tombstone(start);
      if (read.kind === "ok" && read.body.state === "deleted") return this.tombstone(start);
      if (read.kind === "ok" && typeof read.body.closing_until === "string" && read.body.closing_until !== latest.closingUntil) return this.store.casBinding(botId, latest.revision, { closingUntil: read.body.closing_until }, this.now()) ?? this.store.getBinding(botId);
      return latest;
    }
    return row;
  }

  /** The saved binding, only while it is still the generation `start` (same inbox, setup op and key ref); null once it is gone or replaced. */
  private sameGeneration(start: BindingRow): BindingRow | null {
    const current = this.store.getBinding(start.botId);
    return current && sameBinding(current, start) ? current : null;
  }

  /** Keep address (activation #37, design 3.2 "Removing: undo until [date]"): a closing inbox, from the owner's Remove or from Flux (billing,
   *  account), comes back with the same address and bot. Its email key was never revoked while closing, so the bot is ready at once. */
  async keep(botId: string): Promise<OwnerActResult> {
    const row = this.store.getBinding(botId);
    if (!row?.inboxId || !(row.state === "remove_requested" || row.state === "closing")) return { ok: false, code: "not_closing", status: 409 };
    const answer = await this.options.client.restoreInbox(row.inboxId, botId);
    if (answer.kind !== "ok") return ownerActFailure(answer);
    const latest = this.store.getBinding(botId);
    if (!latest) return { ok: true, row: null };
    const state: BindingState = answer.body.state === "paused" ? "paused" : "active";
    return { ok: true, row: this.changed(this.store.casBinding(botId, latest.revision, { state, closingUntil: null, failure: null }, this.now())) };
  }

  /** email.inbox.deleted: the removal is done. */
  async inboxDeleted(inboxId: string): Promise<TombstoneRow | null> {
    const row = this.store.bindingByInbox(inboxId);
    // a Flux-initiated closing (billing, account) ends in deletion too (Astra r1 Medium)
    if (!row || (row.state !== "removing" && row.state !== "remove_requested" && row.state !== "closing")) return null;
    return this.tombstone(row);
  }

  /** The key is revoked, then the binding is replaced by a tombstone kept 30 days. `start` is the generation the removal began from, carried
   * across every await (Astra r2 High #4). Nothing is done unless the saved binding is still that generation; the key saved then is revoked,
   * and cleared only while it is still the saved one; and the binding delete is one conditional statement on the same identity, so a replacement binding made while the
   * revoke awaited the network, and its key, are never touched. A removal whose binding is gone or replaced ends as a no-op. */
  private async tombstone(start: BindingRow): Promise<TombstoneRow | null> {
    const inboxId = start.inboxId ?? "";
    if (!this.sameGeneration(start)) return this.store.getTombstone(start.botId, inboxId);
    // the binding is still `start`, so the saved key is this generation's, whatever its ref says (a rotation a crash cut short saves the new
    // key before the binding records it: Astra r3). No new setup can begin while this binding exists, so no other generation's key is saved.
    const ours = this.options.secrets.botKey(start.botId);
    if (ours) {
      const revoked = await this.options.client.revokeBotKey(ours.keyId);
      // a bodiless 404 is the dark switch (r2.5), not a revoked key: the key stays saved and is revoked once bot keys answer again
      if ((revoked.kind === "ok" || (revoked.kind === "refused" && revoked.status === 404 && !botKeysDark(revoked))) && this.options.secrets.botKey(start.botId)?.keyId === ours.keyId) this.options.secrets.clearBotKey(start.botId);
    }
    this.store.tx(() => {
      if (!this.store.deleteBindingGeneration(start)) return;
      const existing = this.store.getTombstone(start.botId, inboxId);
      this.store.upsertTombstone({ botId: start.botId, inboxId, addressHash: start.address ? sha256Hex(start.address.toLowerCase()) : existing?.addressHash ?? null, state: "removed", committed: true, reason: existing?.reason ?? "owner", keyId: ours?.keyId ?? null, createdAt: existing?.createdAt ?? this.now(), removedAt: this.now(), nextTryAt: null });
    });
    return this.store.getTombstone(start.botId, inboxId);
  }

  // ---- bot deletion intents (2.6, Astra R4, L2) ----

  /** In the same transaction as the bot's deletion proof: a removal intent with committed: false. */
  recordDeletionIntent(botId: string): void { recordDeletionIntent(this.store, botId, this.now()); }
  /** saveBots returned: the reaper may act. The binding is `removing` at once (tools unlisted, sends refused, open rows
   * withdrawn(bot_deleted)); the remote removal is the reaper's, so deleting a bot never waits on the network. */
  commitDeletionIntent(botId: string): void {
    commitDeletionIntent(this.store, botId);
    const row = this.store.getBinding(botId);
    if (row && row.state !== "removing" && row.state !== "remove_requested" && this.store.tombstones().some(tomb => tomb.botId === botId && tomb.state === "removing" && tomb.committed)) {
      if (this.store.casBinding(botId, row.revision, { state: "removing" }, this.now())) this.options.withdrawSends?.(botId, "bot_deleted");
    }
  }
  /** saveBots failed: withdrawn in the same rollback that withdraws the proof. */
  withdrawDeletionIntent(botId: string): void { withdrawDeletionIntent(this.store, botId); }

  /** Boot: an uncommitted intent whose bot still exists is dropped; one whose bot is absent with its deletion proof is committed; one whose
   * bot is absent without proof is kept untouched and looked at again next boot (absence without proof is not deletion, L2). */
  settleDeletionIntents(botExists: (botId: string) => boolean, deletionProof: (botId: string) => boolean): void {
    for (const tomb of this.store.tombstones()) {
      if (tomb.state !== "removing" || tomb.committed) continue;
      if (botExists(tomb.botId)) this.store.deleteTombstone(tomb.botId, tomb.inboxId, tomb.revision);
      else if (deletionProof(tomb.botId)) this.commitDeletionIntent(tomb.botId);
    }
  }

  /** The reaper: committed bot-deletion intents run the remote removal with backoff; deleting a bot never waits on the network. */
  async reap(): Promise<void> {
    for (const tomb of this.store.tombstones()) {
      if (tomb.state === "removed" || !tomb.committed || (tomb.nextTryAt !== null && tomb.nextTryAt > this.now())) continue;
      const binding = this.store.getBinding(tomb.botId);
      if (binding) {
        const result = await this.remove(tomb.botId, "bot_deleted");
        if (result && "state" in result && (result.state === "removing" || result.state === "remove_requested")) this.backoff(tomb);
        continue;
      }
      // no binding left: the removal already finished under another path; the intent is closed
      this.store.casTombstone(tomb.botId, tomb.inboxId, tomb.revision, { state: "removed", removedAt: this.now(), nextTryAt: null });
    }
    this.store.pruneTombstones(this.now() - TOMBSTONE_KEEP_MS);
  }
  private backoff(tomb: TombstoneRow): void {
    const fresh = this.store.getTombstone(tomb.botId, tomb.inboxId);
    if (!fresh || fresh.state === "removed") return;
    const tries = Math.min(REMOVAL_RETRY_MS.length - 1, Math.max(0, Math.floor(Math.log2(Math.max(1, fresh.revision)))));
    this.store.casTombstone(fresh.botId, fresh.inboxId, fresh.revision, { nextTryAt: this.now() + REMOVAL_RETRY_MS[tries] });
  }

  // ---- policy sync (3.3) ----

  /** The owner's choice: the intent is written in the same transaction as the setting; ask applies at once, auto only once Flux confirms. */
  async setPolicy(botId: string, policy: "ask" | "auto"): Promise<BindingRow | null> {
    const revision = this.store.tx(() => {
      const row = this.store.getBinding(botId);
      if (!row) return null;
      if (policy === "ask" && row.policy !== "ask") this.store.casBinding(botId, row.revision, { policy: "ask" }, this.now());
      return this.store.putPolicyIntent(botId, policy, this.now());
    });
    if (revision === null) return null;
    return this.syncPolicy(botId, revision);
  }

  async syncPolicy(botId: string, revision: number): Promise<BindingRow | null> {
    const row = this.store.getBinding(botId);
    const intent = this.store.getPolicySync(botId);
    if (!row?.inboxId || !intent || intent.revision !== revision || intent.state !== "pending") return row;
    const answer = await this.options.client.setSendPolicy(row.inboxId, intent.policy);
    if (answer.kind !== "ok") { if (answer.kind === "refused") this.options.onRefusal?.(answer.code); return this.store.getBinding(botId); }
    return this.store.tx(() => {
      if (!this.store.confirmPolicyIntent(botId, revision, this.now())) return this.store.getBinding(botId);
      const latest = this.store.getBinding(botId);
      if (latest && latest.policy !== intent.policy) return this.store.casBinding(botId, latest.revision, { policy: intent.policy }, this.now());
      return latest;
    });
  }

  // ---- key rotation (2.3) ----

  /** Rotation: mint a new email key, check #5 answers with it, save it, then revoke the old one. Waits while any row of the bot is
   * dispatching or unknown (9.1). The intent (old key id, op id) is written first, so a crash between steps leaves two working keys and
   * boot revokes the one not in the secret store. */
  async rotateKey(botId: string, canRotate: (botId: string) => boolean): Promise<{ ok: true } | { ok: false; code: string }> {
    const row = this.store.getBinding(botId);
    if (!row?.inboxId || !LIVE_BINDING_STATES.has(row.state)) return { ok: false, code: "not_active" };
    if (!canRotate(botId)) return { ok: false, code: "sends_in_flight" };
    const old = this.options.secrets.botKey(botId);
    const intent = this.rotation(botId) ?? { oldKeyId: old?.keyId ?? null, opId: this.newId(), at: this.now() };
    this.store.setCursor(ROTATE_SCOPE + botId, JSON.stringify(intent), this.now());
    return this.finishRotation(botId, intent);
  }

  private rotation(botId: string): { oldKeyId: string | null; opId: string; at: number } | null {
    const raw = this.store.getCursor(ROTATE_SCOPE + botId);
    if (!raw) return null;
    try { const value = JSON.parse(raw) as { oldKeyId?: unknown; opId?: unknown; at?: unknown }; return typeof value.opId === "string" ? { oldKeyId: typeof value.oldKeyId === "string" ? value.oldKeyId : null, opId: value.opId, at: typeof value.at === "number" ? value.at : 0 } : null; } catch { return null; }
  }

  private async finishRotation(botId: string, intent: { oldKeyId: string | null; opId: string; at: number }): Promise<{ ok: true } | { ok: false; code: string }> {
    const stored = this.options.secrets.botKey(botId);
    if (!stored || stored.keyId === intent.oldKeyId) {
      // the new key is not saved yet: the same op id returns the same key inside Flux's 24 h window
      if (this.now() - intent.at >= KEY_IDEMPOTENCY_WINDOW_MS) { this.store.clearCursor(ROTATE_SCOPE + botId); return { ok: false, code: "rotation_expired" }; }
      const minted = await this.options.client.mintBotKey({ botId }, keyIdempotencyKey(this.options.installId, intent.opId));
      if (botKeysDark(minted)) return { ok: false, code: "email_dark" };
      if (minted.kind !== "ok" || !minted.body.key || !minted.body.key_id) return { ok: false, code: minted.kind === "refused" ? minted.code : "unavailable" };
      const row = this.store.getBinding(botId);
      if (!row?.inboxId) return { ok: false, code: "not_active" };
      const check = await this.options.client.getInbox({ kind: "candidate", credential: { token: minted.body.key, keyId: minted.body.key_id } }, row.inboxId);
      if (check.kind !== "ok") return { ok: false, code: check.kind === "refused" ? check.code : "unavailable" };
      this.options.secrets.setBotKey(botId, { token: minted.body.key, keyId: minted.body.key_id });
      const latest = this.store.getBinding(botId);
      if (latest) this.store.casBinding(botId, latest.revision, { emailKeyRef: minted.body.key_id }, this.now());
    }
    // the new key is saved: the old one is revoked (404 = already gone); until then the intent stays for the next boot
    if (intent.oldKeyId && intent.oldKeyId !== this.options.secrets.botKey(botId)?.keyId) {
      const revoked = await this.options.client.revokeBotKey(intent.oldKeyId);
      if (!(revoked.kind === "ok" || (revoked.kind === "refused" && revoked.status === 404 && !botKeysDark(revoked)))) return { ok: false, code: "revoke_pending" };
    }
    this.store.clearCursor(ROTATE_SCOPE + botId);
    return { ok: true };
  }

  // ---- account change (section 8) ----

  /** The account a #28 event names. A binding made under another account moves to restored_unverified (no polling, tools or sends) until
   * the owner reconnects; a binding without one records it. */
  noteAccount(accountId: string): BindingRow[] {
    const moved: BindingRow[] = [];
    for (const row of this.store.bindings()) {
      if (row.fluxAccountId === accountId) continue;
      if (row.fluxAccountId === null) { this.store.casBinding(row.botId, row.revision, { fluxAccountId: accountId }, this.now()); continue; }
      if (row.state === "removing" || row.state === "remove_requested" || row.state === "restored_unverified") continue;
      const next = this.store.casBinding(row.botId, row.revision, { state: "restored_unverified" }, this.now());
      if (next) { moved.push(next); this.changed(next); }
    }
    return moved;
  }

  // ---- boot ----

  /** Before the event reader starts: carry on every unfinished setup, removal and policy write. */
  async reconcileBindings(): Promise<void> {
    for (const row of this.store.bindings()) {
      if (row.state === "provisioning") await this.advance(row.botId);
      else if (row.state === "removing" || row.state === "remove_requested") await this.continueRemoval(row.botId);
    }
    for (const intent of this.store.pendingPolicyIntents()) await this.syncPolicy(intent.botId, intent.revision);
    // 2.3: a rotation a crash cut short ends with one key: the saved one; the other is revoked
    for (const row of this.store.bindings()) { const intent = this.rotation(row.botId); if (intent) await this.finishRotation(row.botId, intent); }
  }
}
