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
import { GUARD_POLL_MS, GUARD_POLL_WINDOW_MS, LIVE_BINDING_STATES, type BindingRow, type BindingState, type KeepClaim, type EmailStore, type TombstoneRow } from "./email-store.ts";
import { botKeysDark, type FluxEmailClient } from "./flux-email-client.ts";
import { RemovalGate, isGateRefusal, type Authority } from "./removal-gate.ts";

export const KEY_IDEMPOTENCY_WINDOW_MS = 24 * 3_600_000;
export const TOMBSTONE_KEEP_MS = 30 * 86_400_000;
/** r3.2j: a minted record is dropped only when older than the 24 h replay window plus a margin (30 days), never by count. */
export const MINTED_KEEP_MS = 30 * 86_400_000;
const ROTATE_SCOPE = "rotate:";
/** A key revoke that answered 404 is not proof the key is gone (a misrouted or transient 404 would drop the kept mark while a live Flux key can
 *  still spend money): one confirming read of the key must also show it absent. A read that errors is tried KEY_CONFIRM_TRIES times in all, with
 *  the waits below between tries; when they run out the mark stays and one ops line (onOps, kind key_release_unconfirmed) is raised per key. */
export const KEY_CONFIRM_TRIES = 3;
export const KEY_CONFIRM_WAIT_MS = [2_000, 10_000] as const;
/** r3.2i: the key ids this home itself minted for a bot, with the time (an op/key record of this database; a restore starts without it). */
const MINTED_SCOPE = "minted:";
/** r3.2i: the op a Reconnect press mints with, saved as {opId, at}. A cursor, not the binding's setup op: a restored binding keeps the SOURCE home's opId, which must never be replayed (R3). */
const RECONNECT_OP_SCOPE = "reconnect-op:";
export const REMOVAL_RETRY_MS = [60_000, 300_000, 1_800_000, 7_200_000] as const;
/** A setup step that got no answer runs again on the tick after this wait (the last one repeats), with the same op_id. */
export const SETUP_RETRY_MS = [30_000, 60_000, 120_000, 300_000] as const;
/** A setup with no answer this many runs in a row, or for this long, shows as failed with a Retry. */
export const SETUP_GIVE_UP_TRIES = 5;
export const SETUP_GIVE_UP_MS = 15 * 60_000;
/** The failure of a setup that stopped on no answer; its Retry replays the same op_id inside Flux's 24 h window. */
export const SETUP_NO_ANSWER = "setup_no_answer";
/** Cursor row per bot: the unanswered-run budget of the current setup op ({opId, attempt, since}), so a restart does not reset it. */
const SETUP_BUDGET_SCOPE = "setup-retry:";

function readBudget(raw: string | null): { opId: string; attempt: number; since: number } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { opId?: unknown; attempt?: unknown; since?: unknown } | null;
    return value && typeof value.opId === "string" && typeof value.attempt === "number" && typeof value.since === "number" ? { opId: value.opId, attempt: value.attempt, since: value.since } : null;
  } catch { return null; }
}

/** The client without the two removal calls: DELETE inbox and revoke key exist only behind the RemovalGate, which is built from `request`. */
export type BindingClient = Pick<FluxEmailClient, "request" | "getBotKey" | "mintBotKey" | "createInbox" | "getInbox" | "restoreInbox" | "setSendPolicy" | "patchInbox" | "resumeInbox" | "listInboxes">;

/** An ops alert line (invariants.current.ts OpsLine). Ops lines are not customer copy; they follow the wording rules all the same. */
export interface OpsLine {
  kind: "guard_restore" | "guard_refused" | "key_release_unconfirmed"; botId: string; gen: { inboxId: string; keyRef: string | null }; text: string;
  window: { closingSinceMs: number; restoredAtMs: number | null };
}

export interface BindingServiceOptions {
  store: EmailStore;
  client: BindingClient;
  secrets: EmailSecretStore;
  installId: string;
  /** The single authorization point for remote removals; built from `client` when not given. */
  gate?: RemovalGate;
  /** True while the bot is on this install: an orphan Keep (a park whose bot is gone) releases the dead bot's key. */
  botExists?: (botId: string) => boolean;
  /** True while a restore job is open: handed to the RemovalGate. */
  restoreWindow?: () => boolean;
  now?: () => number;
  /** The wait between confirming key reads (KEY_CONFIRM_WAIT_MS); tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  /** Withdraws every open send of the bot (send-service withdrawAllForBot). */
  withdrawSends?: (botId: string, reason: "inbox_removed" | "bot_deleted" | "account_off") => void;
  onRefusal?: (code: string) => void;
  /** r3.4d ops alert line (invariant opsLinesNameNoAddress): never an address, always the binding id and the inbox generation. */
  onOps?: (line: OpsLine) => void;
  /** Adopts the removal_parked bindings that have no park row (the runtime lifts its INSERT fence for exactly this call). */
  adoptParks?: () => void;
  /** A binding moved between active, paused, billing_hold or account_off (the `email-status` notice, section 6). */
  onStateChange?: (row: BindingRow) => void;
  /** Crash harness only (server/testing/email-crash-child.ts): called at the named durable boundaries C4..C14. A no-op in production. */
  checkpoint?: (name: string) => void;
}

/** An owner act's answer: the row, or the Flux code that refused it. */
export type OwnerActResult = { ok: true; row: BindingRow | null } | { ok: false; code: string; status: number; detail?: string };
export const ROTATION_LIVE_CONFLICT = "rotation_live_conflict";
/** The owner lines for rotation_live_conflict. KEY is always the key_id Flux named (never key material). Plain words, no dashes. Sol copy check: both passed. */
/** A live key this bot does not hold now (a key this home never minted, or minted less than 24 h ago). */
export function rotationOtherKeyDetail(keyId: string): string {
  return `This bot already has another email key, ${keyId}. Revoke it in your Flux account, then press Reconnect.`;
}
/** The live key is the one the bot holds now. */
export function rotationHeldKeyDetail(keyId: string): string {
  return `Email key ${keyId} is this bot's current key. Revoke it in your Flux account, then press Reconnect. The bot gets a fresh key, and its email pauses for a moment while it switches.`;
}
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

/** An owner Remove refused because a Keep is waiting on Flux (park state keep_pending): the route answers 409 keep_pending. */
export class RemovalRefused extends Error {
  readonly code: "keep_pending" | "confirm_expired";
  constructor(code: "keep_pending" | "confirm_expired") { super(`EMAIL_REMOVAL_REFUSED:${code}`); this.code = code; }
}

export class EmailBindingService {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly options: BindingServiceOptions;
  /** One setup run per bot at a time: a second caller (owner, tick, boot) shares the running one. */
  readonly gate: RemovalGate;
  /** Keeps whose network half is running in this process: the resumer leaves them alone (a second runner would roll a live claim back on a transient failure). */
  private readonly keepRuns = new Set<string>();
  private readonly setupRuns = new Map<string, Promise<BindingRow | null>>();
  /** When the tick runs a stalled setup next (in memory: boot runs every provisioning binding anyway). */
  private readonly setupRetries = new Map<string, number>();
  constructor(options: BindingServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => uuidv7(this.now()));
    this.gate = options.gate ?? new RemovalGate({ store: options.store, client: options.client, secrets: options.secrets, botExists: options.botExists, restoreWindow: options.restoreWindow, now: this.now });
  }
  private get store() { return this.options.store; }
  private cp(name: string): void { this.options.checkpoint?.(name); }

  /** Owner act: give this bot an address. A new binding, or a failed one retried, starts at step `key` with a new op_id. */
  async enable(botId: string, input: { username?: string; displayName?: string }): Promise<BindingRow | null> {
    const running = this.setupRuns.get(botId);
    if (running) return running;
    const now = this.now();
    const existing = this.store.getBinding(botId);
    if (!existing) {
      // r3.2k (Astra H1): a new setup is a new binding generation: no Reconnect or rotation op of an earlier generation is current any more
      this.store.clearCursor(RECONNECT_OP_SCOPE + botId);
      this.store.clearCursor(ROTATE_SCOPE + botId);
      this.store.insertBinding({ botId, inboxId: null, address: null, username: input.username ?? null, displayName: input.displayName ?? null, emailKeyRef: null, fluxAccountId: null, state: "provisioning", step: "key", opId: this.newId(), opStartedAt: now, policy: "auto", failure: null, updatedAt: now });
    } else if (existing.state === "failed") {
      // a setup that stopped on no answer replays its op_id inside Flux's 24 h window, so Flux returns what it made, and gets a fresh budget
      const replay = existing.failure === SETUP_NO_ANSWER && existing.opId !== null && existing.opStartedAt !== null && now - existing.opStartedAt < KEY_IDEMPOTENCY_WINDOW_MS;
      this.store.clearCursor(`${SETUP_BUDGET_SCOPE}${botId}`);
      this.store.casBinding(botId, existing.revision, { state: "provisioning", step: this.options.secrets.botKey(botId) ? "inbox" : "key", ...(replay ? {} : { opId: this.newId(), opStartedAt: now }), failure: null, username: input.username ?? existing.username, displayName: input.displayName ?? existing.displayName }, now);
    }
    return this.advance(botId);
  }

  /** Runs the next setup step of a provisioning binding (also from boot). */
  advance(botId: string): Promise<BindingRow | null> {
    const running = this.setupRuns.get(botId);
    if (running) return running;
    const run = (async () => {
      try { return this.noteSetupResult(botId, await this.advanceSetup(botId)); }
      finally { this.setupRuns.delete(botId); }
    })();
    this.setupRuns.set(botId, run);
    return run;
  }

  /** The tick: every provisioning binding whose wait is over runs its step again. Never throws. */
  async retryStalledSetups(): Promise<void> {
    for (const row of this.store.bindings()) {
      if (row.state !== "provisioning" || this.setupRuns.has(row.botId) || this.now() < (this.setupRetries.get(row.botId) ?? 0)) continue;
      await this.advance(row.botId).catch(() => undefined);
    }
  }

  /** After a run: a settled binding forgets its waits. One still provisioning got no answer: it waits for its next try, and after
   *  SETUP_GIVE_UP_TRIES runs or SETUP_GIVE_UP_MS it shows as failed with Retry, so setup never sits on "Setting up email" with no button. */
  private noteSetupResult(botId: string, row: BindingRow | null): BindingRow | null {
    const scope = `${SETUP_BUDGET_SCOPE}${botId}`;
    if (!row || row.state !== "provisioning") { this.setupRetries.delete(botId); this.store.clearCursor(scope); return row; }
    const saved = readBudget(this.store.getCursor(scope));
    const same = saved?.opId === row.opId;
    const attempt = (same ? saved!.attempt : 0) + 1;
    const since = same ? saved!.since : this.now();
    if (attempt >= SETUP_GIVE_UP_TRIES || this.now() - since >= SETUP_GIVE_UP_MS) {
      this.setupRetries.delete(botId);
      this.store.clearCursor(scope);
      return this.store.casBinding(botId, row.revision, { state: "failed", failure: SETUP_NO_ANSWER }, this.now()) ?? this.store.getBinding(botId);
    }
    this.store.setCursor(scope, JSON.stringify({ opId: row.opId, attempt, since }), this.now());
    this.setupRetries.set(botId, this.now() + SETUP_RETRY_MS[Math.min(attempt, SETUP_RETRY_MS.length) - 1]!);
    return row;
  }

  private async advanceSetup(botId: string): Promise<BindingRow | null> {
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
        this.noteMinted(botId, minted.body.key_id);
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
    const data = event.data ?? {};
    // r3.4d keep guard: Flux re-closes a kept inbox for the owner or a bot deletion; RESTORE again, the Keep stays Kept (reducer applyEvent closing, line 445)
    if (event.type === "email.inbox.closing" && event.inbox_id) {
      const guard = this.store.getKeepGuard(event.inbox_id);
      if (guard && (data.reason === "owner" || data.reason === "bot_deleted")) { await this.guardRepair(event.inbox_id, guard.botId).catch(() => false); return row; }
    }
    if (!row) return null;
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

  /** The op a Reconnect press mints with: the saved one inside the 24 h window, else a new one saved on the binding first. Null: the binding is gone. */
  private reconnectOp(botId: string, fresh = false): string | null {
    if (!this.store.getBinding(botId)) return null;
    if (!fresh) {
      try {
        const saved = JSON.parse(this.store.getCursor(RECONNECT_OP_SCOPE + botId) ?? "null") as { opId?: unknown; at?: unknown } | null;
        if (saved && typeof saved.opId === "string" && typeof saved.at === "number" && this.now() - saved.at < KEY_IDEMPOTENCY_WINDOW_MS) return saved.opId;
      } catch { /* an unreadable record is a new op */ }
    }
    const opId = this.newId();
    this.store.setCursor(RECONNECT_OP_SCOPE + botId, JSON.stringify({ opId, at: this.now() }), this.now());
    return opId;
  }

  /** Records a key id this home minted (setup, rotation, Reconnect), before the key is saved: the only ids Reconnect may ever delete as strays. */
  private noteMinted(botId: string, keyId: string): void {
    const now = this.now();
    const list = this.mintedKeys(botId);
    // r3.2j: a key noted again keeps its FIRST time (the spec's logMint); records leave by AGE only (never by count), so a real stray can not be
    // pushed out by later mints before the Reconnect that deletes it: it stays for the 24 h window plus the margin MINTED_KEEP_MS.
    if (list.find(item => item.keyId === keyId) === undefined) list.push({ keyId, at: now });
    const kept = list.filter(item => now - item.at < MINTED_KEEP_MS);
    this.store.setCursor(MINTED_SCOPE + botId, JSON.stringify(kept), now);
  }

  private mintedKeys(botId: string): { keyId: string; at: number }[] {
    const raw = this.store.getCursor(MINTED_SCOPE + botId);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw) as unknown;
      return Array.isArray(value) ? value.filter((item): item is { keyId: string; at: number } => !!item && typeof item.keyId === "string" && typeof item.at === "number") : [];
    } catch { return []; }
  }

  /** Deletes a stray live key id from Reconnect's 409 (404 = already gone). True when it is gone. Called only for a key this home minted, past 24 h. */
  private async revokeStray(botId: string, keyId: string, reconnectOp: string): Promise<boolean> {
    const answer = await this.gate.revokeKey({ kind: "stray", botId, keyId, reconnectOp }, keyId); // int2: every revoke goes through the park gate
    if (isGateRefusal(answer)) return false;
    return answer.kind === "ok" || (answer.kind === "refused" && answer.status === 404 && !botKeysDark(answer));
  }

  /** Reconnect (section 7 restore): the owner lists #4, the inbox whose bot_id is this bot is adopted, a new email key is minted for it. */
  reconnect(botId: string): Promise<OwnerActResult> {
    // r3.2j (Astra 1): one Reconnect in flight per bot; a second press waits for the first to finish, then judges the binding as it is then.
    return this.serial(botId, () => this.reconnectOnce(botId));
  }
  /** r3.2k (Astra M1): ONE key operation in flight per bot, shared by every entry point that mints and saves a bot key: Reconnect on a restored
   *  binding, rotateKey (the owner's Reconnect on a rejected key) and boot's finishRotation. A later caller waits for the earlier one. */
  private serial<T>(botId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.keyOpsTail.get(botId) ?? Promise.resolve()).then(fn);
    const tail = run.then(() => undefined, () => undefined);
    this.keyOpsTail.set(botId, tail);
    void tail.then(() => { if (this.keyOpsTail.get(botId) === tail) this.keyOpsTail.delete(botId); });
    return run;
  }
  private readonly keyOpsTail = new Map<string, Promise<void>>();
  /** A Reconnect the owner pressed inside the last 24 h that did not finish (its op is saved; it is cleared when the binding commits). */
  private reconnectPending(botId: string): boolean {
    try {
      const saved = JSON.parse(this.store.getCursor(RECONNECT_OP_SCOPE + botId) ?? "null") as { opId?: unknown; at?: unknown } | null;
      return !!saved && typeof saved.opId === "string" && typeof saved.at === "number" && this.now() - saved.at < KEY_IDEMPOTENCY_WINDOW_MS;
    } catch { return false; }
  }
  /** r3.2k (Astra H1): this press may still save and commit: its op is the current one AND the saved binding is the generation it started from, still restored. */
  private reconnectMaySave(botId: string, opId: string, start: BindingRow): boolean {
    if (!this.reconnectOpIsCurrent(botId, opId)) return false;
    const current = this.store.getBinding(botId);
    return !!current && sameBinding(current, start) && current.state === "restored_unverified";
  }
  private reconnectOpIsCurrent(botId: string, opId: string): boolean {
    try { return (JSON.parse(this.store.getCursor(RECONNECT_OP_SCOPE + botId) ?? "null") as { opId?: unknown } | null)?.opId === opId; } catch { return false; }
  }
  private async reconnectOnce(botId: string): Promise<OwnerActResult> {
    const row = this.store.getBinding(botId);
    if (!row || row.state !== "restored_unverified") return { ok: false, code: "not_restored", status: 409 };
    const listed = await this.options.client.listInboxes({ kind: "owner" });
    if (listed.kind !== "ok") return ownerActFailure(listed);
    const inbox = (listed.body.data ?? []).find(item => item.bot_id === botId && item.state !== "deleted");
    if (!inbox) return { ok: false, code: "inbox_not_found", status: 404 };
    // r3.2h: the press saves its op (a cursor of this database) before the mint and replays it inside Flux's 24 h window exactly as setup
    // does (:160-166): a press after a crash between the mint and the key save replays the same op, so Flux makes one key. Past the window a new op.
    const opId = this.reconnectOp(botId);
    if (!opId) return { ok: true, row: null };
    let usedOp = opId;
    let minted = await this.options.client.mintBotKey({ botId }, keyIdempotencyKey(this.options.installId, usedOp));
    // r3.2j (Astra 4): EVERY 409 bot_key_exists {X} of this press, the second mint after a stray delete included, goes through the same rule.
    for (let attempt = 0; minted.kind === "refused" && minted.code === "bot_key_exists"; attempt++) {
      // 409 bot_key_exists {X}: a live key this op did not make. r3.2i: X is deleted as a stray ONLY when this home's own record shows it minted X
      // and 24 h have passed since (the spec's mintLog rule; it may be the key of another install on the same Flux account). The key this bot holds
      // now, a key this home never minted, and a key minted inside the window all hold with the owner line naming the key; nothing is revoked.
      const live = typeof minted.error.fields.key_id === "string" ? minted.error.fields.key_id : null;
      if (!live) return ownerActFailure(minted);
      const own = this.mintedKeys(botId).find(item => item.keyId === live);
      // r3.2k (Opus L1): a key a rotation intent still protects (its old key) holds like the held key, as in the spec's isProtected: boot never runs a
      // restored binding's rotation, so nothing else would revoke it, and holding never destroys. r3.2k (Astra M4): the 4th answer of one press (after 3
      // stray deletes) is judged by the same rule and holds with the owner line, never the raw code.
      const heldId = this.options.secrets.botKey(botId)?.keyId;
      const strayOk = attempt < 3 && live !== heldId && live !== this.rotation(botId)?.oldKeyId && own !== undefined && this.now() - own.at >= KEY_IDEMPOTENCY_WINDOW_MS;
      if (!strayOk) return { ok: false, code: ROTATION_LIVE_CONFLICT, status: 409, detail: live === heldId ? rotationHeldKeyDetail(live) : rotationOtherKeyDetail(live) };
      if (!(await this.revokeStray(botId, live, usedOp))) return { ok: false, code: "unavailable", status: 503 };
      const next = this.reconnectOp(botId, true);
      if (!next) return { ok: true, row: null };
      usedOp = next;
      minted = await this.options.client.mintBotKey({ botId }, keyIdempotencyKey(this.options.installId, usedOp));
    }
    if (minted.kind !== "ok") return ownerActFailure(minted);
    if (!minted.body.key || !minted.body.key_id) return { ok: false, code: "unavailable", status: 503 };
    this.noteMinted(botId, minted.body.key_id);
    // r3.2j (Astra 1) + r3.2k (Astra H1): the key is saved only if this press is still the current reconnect op AND the binding is still the generation it
    // started from (a removal, or a removal and a new setup, ends the op): a late answer never reinstalls a revoked key or overwrites a replacement's key.
    // No await sits between this check and setBotKey.
    if (!this.reconnectMaySave(botId, usedOp, row)) return { ok: false, code: "unavailable", status: 503 };
    this.options.secrets.setBotKey(botId, { token: minted.body.key, keyId: minted.body.key_id });
    // r3.2k (Astra H2): the key is durably acknowledged BEFORE the binding goes active on it. A crash anywhere in this sequence leaves the binding
    // restored with its op saved, and boot (reconcileBindings) or the next press replays the same op: Flux returns the same key, which is saved again.
    if (!(await this.options.secrets.durable())) return { ok: false, code: "save_pending", status: 503 };
    if (!this.reconnectMaySave(botId, usedOp, row)) return { ok: false, code: "unavailable", status: 503 };
    const latest = this.store.getBinding(botId)!;
    const state: BindingState = inbox.state && inbox.state !== "active" && LIVE_BINDING_STATES.has(inbox.state as BindingState) ? inbox.state as BindingState : "active";
    const next = this.store.casBinding(botId, latest.revision, { state, inboxId: inbox.id, address: inbox.address ?? latest.address, emailKeyRef: minted.body.key_id, failure: null, step: null }, this.now());
    if (next) this.store.clearCursor(RECONNECT_OP_SCOPE + botId); // committed: nothing left for boot to resume
    return { ok: true, row: this.changed(next) };
  }

  // ---- removal (2.6; restore-park r3.1 section 2) ----

  /** Owner Remove on the bot's section: a live binding is authorized `owner` (removing at once: sends refused, open cards withdrawn, then DELETE #7); a binding or
   *  intent a restore parked is authorized with the `park` authority, which keeps the park's provenance. Keep always wins: a Keep in flight answers keep_pending. */
  async remove(botId: string, parkRev?: number): Promise<BindingRow | TombstoneRow | null> {
    const park = this.store.getPark(botId);
    const auth = this.gate.authorize(park ? { kind: "park", botId, by: "bot_section", ...(parkRev !== undefined ? { parkRev } : {}) } : { kind: "owner", botId });
    if (isGateRefusal(auth)) { if (auth.code === "keep_pending" || auth.code === "confirm_expired") throw new RemovalRefused(auth.code); return this.store.getBinding(botId); }
    // r3.4d guardDiesOnFreshRemove (reducer ownerRemove line 238): the owner's fresh Remove ends the keep guard in the same step as the authority
    const guardInbox = auth.start?.inboxId ?? park?.inboxId; if (guardInbox) this.store.deleteKeepGuard(guardInbox);
    if (auth.changed) this.options.withdrawSends?.(botId, "inbox_removed");
    return this.continueRemoval(auth.start, auth.authority);
  }

  /** One removal is one binding generation: the row read here (inbox, setup op, key ref) is carried across every network await, and each step after an await goes
   * on only while the saved binding is still that generation (Astra r2 High #4). Every DELETE and revoke goes through the gate with the authority. */
  async continueRemoval(start: BindingRow | null, authority: Authority): Promise<BindingRow | TombstoneRow | null> {
    if (!start) return this.finishParkOnly(authority);
    if (start.state === "removal_parked") return start;
    if (!start.inboxId) return this.tombstone(start, authority); // nothing was ever created at Flux; a key minted at step 2 is still revoked
    let row: BindingRow = start;
    if (row.state === "removing") {
      this.cp("C7");
      const answer = await this.gate.deleteInbox(authority, start);
      this.cp("C8");
      const current = this.sameGeneration(start);
      if (!current || current.state !== "removing") return current ?? this.store.getBinding(start.botId);
      if (isGateRefusal(answer)) return current;
      // r2.5: 202 state "closing" with closing_until: the address can still be kept until then (Keep address, #37)
      if (answer.kind === "held" || answer.kind === "ok") {
        const moved = this.store.casBinding(start.botId, current.revision, { state: "remove_requested", closingUntil: typeof answer.body.closing_until === "string" ? answer.body.closing_until : null }, this.now()) ?? this.sameGeneration(start);
        if (!moved) return this.store.getBinding(start.botId);
        row = moved;
      } else if (answer.kind === "refused" && (answer.status === 404 || answer.code === "inbox_not_found")) return this.tombstone(start, authority);
      else return current; // retried with backoff by the reaper
    }
    if (row.state === "remove_requested") {
      const read = await this.options.client.getInbox({ kind: "owner" }, start.inboxId);
      const latest = this.sameGeneration(start);
      if (!latest) return this.store.getBinding(start.botId);
      if (read.kind === "refused" && (read.status === 404 || read.code === "inbox_not_found")) return this.tombstone(start, authority);
      if (read.kind === "ok" && read.body.state === "deleted") return this.tombstone(start, authority);
      if (read.kind === "ok" && typeof read.body.closing_until === "string" && read.body.closing_until !== latest.closingUntil) return this.store.casBinding(start.botId, latest.revision, { closingUntil: read.body.closing_until }, this.now()) ?? this.store.getBinding(start.botId);
      return latest;
    }
    return row;
  }

  /** Resumes one removing or remove_requested binding that no park names (boot, tick): the owner authority is read from the row itself. */
  async resumeRemoval(botId: string): Promise<BindingRow | TombstoneRow | null> {
    const auth = this.gate.authorize({ kind: "owner", botId });
    return isGateRefusal(auth) ? this.store.getBinding(botId) : this.continueRemoval(auth.start, auth.authority);
  }

  private readonly unconfirmedKeys = new Set<string>();

  /** Whether a key revoke left the key gone. ok is gone. A 404 is only a claim: one confirming read of the key must also answer key_not_found
   *  (a 404 with a body); a read that shows the key (ok) is "live", a read that errors is retried (KEY_CONFIRM_TRIES) and then "unknown" with one
   *  ops line. Any other revoke answer is "unknown" and changes nothing. The kept mark leaves only on "gone". */
  private async keyGone(botId: string, inboxId: string, keyId: string, revoked: { kind: string; status?: number }): Promise<"gone" | "live" | "unknown"> {
    if (revoked.kind === "ok") return "gone";
    if (!(revoked.kind === "refused" && revoked.status === 404)) return "unknown";
    const sleep = this.options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < KEY_CONFIRM_TRIES; attempt++) {
      if (attempt > 0) await sleep(KEY_CONFIRM_WAIT_MS[Math.min(attempt - 1, KEY_CONFIRM_WAIT_MS.length - 1)]!);
      const read = await this.options.client.getBotKey(keyId);
      if (read.kind === "ok") return "live";
      if (read.kind === "refused" && read.status === 404 && read.code === "key_not_found") return "gone";
    }
    if (!this.unconfirmedKeys.has(keyId)) {
      this.unconfirmedKeys.add(keyId);
      const line: OpsLine = { kind: "key_release_unconfirmed", botId, gen: { inboxId, keyRef: keyId }, text: "Flux said a bot key was not found, but a second read could not confirm it. The kept mark stays until it can.", window: { closingSinceMs: this.now(), restoredAtMs: null } };
      try { this.options.onOps?.(line); } catch { /* an alert never decides a removal */ }
    }
    return "unknown";
  }

  /** A park with no binding (intent-only, or the binding already gone): DELETE the park's inbox, then revoke its key and end the removal. */
  private async finishParkOnly(authority: Authority): Promise<TombstoneRow | null> {
    if (authority.kind !== "park") return null;
    const park = this.store.getPark(authority.botId);
    if (!park || park.parkId !== authority.parkId || park.state !== "remove_authorized") return null;
    if (park.inboxId) {
      this.cp("C10");
      const answer = await this.gate.deleteInbox(authority, null, park.inboxId);
      if (isGateRefusal(answer)) return null;
      if (!(answer.kind === "held" || answer.kind === "ok" || (answer.kind === "refused" && (answer.status === 404 || answer.code === "inbox_not_found")))) return null;
      const read = answer.kind === "refused" ? null : await this.options.client.getInbox({ kind: "owner" }, park.inboxId);
      if (read && !(read.kind === "ok" && read.body.state === "deleted") && !(read.kind === "refused" && read.status === 404)) return null; // closing at Flux: the resumer finishes it
    }
    const key = park.keyId ?? this.options.secrets.botKey(park.botId)?.keyId ?? null;
    if (key) {
      const revoked = await this.gate.revokeKey(authority, key);
      if (isGateRefusal(revoked)) return null;
      if (await this.keyGone(park.botId, park.inboxId ?? "", key, revoked) !== "gone") return null; // the park stays and the resumer tries again
      if (this.options.secrets.botKey(park.botId)?.keyId === key) this.options.secrets.clearBotKey(park.botId);
    }
    this.store.tx(() => this.completeRemoval(park.botId, park.inboxId ?? "", null, this.now(), [key]));
    return park.inboxId ? this.store.getTombstone(park.botId, park.inboxId) : null;
  }

  /** The completion tx (4.2): the bot's non-removed intents end `removed` and the park row goes, with the tombstone, in one transaction. */
  private completeRemoval(botId: string, inboxId: string, addressHash: string | null, now: number, endedKeys: Array<string | null | undefined> = []): void {
    for (const keyId of endedKeys) this.store.releaseKeptKey(keyId); // the completed Remove ends the mark of exactly the keys it removed (r3.3i C)
    const existing = this.store.getTombstone(botId, inboxId);
    for (const tomb of this.store.tombstones()) if (tomb.botId === botId && tomb.state !== "removed" && tomb.inboxId !== inboxId) this.store.casTombstone(botId, tomb.inboxId, tomb.revision, { state: "removed", committed: true, removedAt: now, nextTryAt: null });
    if (inboxId) this.store.upsertTombstone({ botId, inboxId, addressHash: addressHash ?? existing?.addressHash ?? null, state: "removed", committed: true, reason: existing?.reason ?? "owner", keyId: existing?.keyId ?? null, createdAt: existing?.createdAt ?? now, removedAt: now, nextTryAt: null });
    const park = this.store.getPark(botId);
    if (park) this.store.deletePark(botId, park.parkId, park.parkRev);
  }

  /** The saved binding, only while it is still the generation `start` (same inbox, setup op and key ref); null once it is gone or replaced. */
  private sameGeneration(start: BindingRow): BindingRow | null {
    const current = this.store.getBinding(start.botId);
    return current && sameBinding(current, start) ? current : null;
  }

  /** Keep address (activation #37, design 3.2 "Removing: undo until [date]"): a closing inbox, from the owner's Remove or from Flux (billing,
   *  account), comes back with the same address and bot. A park (a restore parked the removal) is Keep'd durably first (4.1, 4.2). */
  async keep(botId: string): Promise<OwnerActResult> {
    if (this.store.getPark(botId)) return this.keepPark(botId);
    const row = this.store.getBinding(botId);
    // a removal that completed: the tombstone says removed, the park and binding are gone (approved string "inbox_gone")
    if (!row && this.store.tombstones().some(tomb => tomb.botId === botId && tomb.state === "removed")) return { ok: false, code: "inbox_gone", status: 409 };
    if (!row?.inboxId || !(row.state === "remove_requested" || row.state === "closing")) return { ok: false, code: "not_closing", status: 409 };
    const answer = await this.options.client.restoreInbox(row.inboxId, botId);
    if (answer.kind !== "ok") return ownerActFailure(answer);
    const latest = this.store.getBinding(botId);
    if (!latest) return { ok: true, row: null };
    // M4: a binding the restore touched keeps that provenance (step "restored") through Remove and Keep: it returns to Reconnect, never to active
    const state: BindingState = latest.step === "restored" ? "restored_unverified" : answer.body.state === "paused" ? "paused" : "active";
    return { ok: true, row: this.changed(this.store.tx(() => {
      this.recordKept(botId, row.inboxId as string, latest.emailKeyRef);
      const next = this.store.casBinding(botId, latest.revision, { state, closingUntil: null, failure: null }, this.now());
      if (next && state === "restored_unverified") this.dropRemovalIntents(botId);
      return next;
    })) };
  }

  /** r3.4d: a successful Keep marks its key kept (keptKeysProtected) and arms the keep guard (reducer onAnswer kget success, restore-reducer.ts lines 286-295). */
  private recordKept(botId: string, inboxId: string, keyId: string | null): void {
    const now = this.now();
    if (keyId) this.store.markKeptKey(keyId, `keep:${botId}`, now);
    this.store.clearRemovingAuthority(botId);
    this.store.putKeepGuard({ inboxId, botId, keepOp: `keep:${botId}`, keptAt: now, pollUntil: now + GUARD_POLL_WINDOW_MS, lastCheckedAt: null }, now);
  }

  /** r3.4d keep guard (reducer startGuardRestore line 156 / sendGuardGet line 149 / applyEvent closing line 445): Flux re-closed a kept inbox, so the RESTORE is sent again and the Keep stays Kept.
   *  The repair runs under a keep op claim (keepOps): it is skipped while a claim, a park or a removal already holds the inbox, the claim and the ops alert line are written in one step
   *  before the RESTORE, and the claim is released when Flux answers (an unanswered RESTORE keeps it, and the tick sends it again). */
  async guardRepair(inboxId: string, botId: string): Promise<boolean> {
    const claim = this.store.tx((): KeepClaim | null => {
      if (this.store.getKeepClaim(inboxId) || this.store.parkByInbox(inboxId)) return null;
      if (this.store.bindings().some(b => b.inboxId === inboxId && (b.state === "removing" || b.state === "remove_requested" || b.state === "removal_parked"))) return null;
      const now = this.now();
      const next: KeepClaim = { keepOp: this.newId(), botId, inboxId, authorityId: `keep:${botId}`, claimedAt: now };
      this.store.putKeepClaim(next, now);
      return next;
    });
    if (!claim) return false;
    this.ops("guard_restore", claim, "Flux closed a kept inbox again. Murage asked Flux to restore it and the Keep stands.", null);
    return this.sendGuardRestore(claim);
  }

  private async sendGuardRestore(claim: KeepClaim): Promise<boolean> {
    const answer = await this.options.client.restoreInbox(claim.inboxId, claim.botId);
    if (answer.kind === "uncertain") return false; // no answer: the claim stays and the tick sends the RESTORE again
    this.store.deleteKeepClaim(claim.inboxId);
    if (answer.kind === "refused") { this.ops("guard_refused", claim, `Flux refused the guard restore (${String(answer.code).replace(/[^\w.]/g, "").slice(0, 40)}).`, null); return false; }
    return true;
  }

  private ops(kind: OpsLine["kind"], claim: KeepClaim, text: string, restoredAtMs: number | null): void {
    const line: OpsLine = { kind, botId: claim.botId, gen: { inboxId: claim.inboxId, keyRef: this.store.getBinding(claim.botId)?.emailKeyRef ?? null }, text, window: { closingSinceMs: claim.claimedAt, restoredAtMs } };
    try { this.options.onOps?.(line); } catch { /* an alert never decides a restore */ }
  }

  /** Tick: each live guard reads its inbox at most once per GUARD_POLL_MS; a closing inbox is restored. Expired guards go. */
  async pollKeepGuards(): Promise<void> {
    for (const claim of this.store.keepClaims()) await this.sendGuardRestore(claim).catch(() => false); // a claim left by an unanswered RESTORE (or a crash) is finished first
    for (const guard of this.store.keepGuards()) {
      const now = this.now();
      if (now >= guard.pollUntil) { this.store.deleteKeepGuard(guard.inboxId); continue; }
      if (guard.lastCheckedAt !== null && now - guard.lastCheckedAt < GUARD_POLL_MS) continue;
      if (this.store.parks().some(p => p.inboxId === guard.inboxId) || this.store.getKeepClaim(guard.inboxId)) continue;
      this.store.putKeepGuard({ ...guard, lastCheckedAt: now }, now);
      const read = await this.options.client.getInbox({ kind: "owner" }, guard.inboxId).catch(() => null);
      if (read && read.kind === "ok" && read.body.state === "closing") await this.guardRepair(guard.inboxId, guard.botId).catch(() => false);
    }
  }

  /** A bot-deletion intent for this bot, gone: Keep decided, so nothing may remove the inbox later. */
  private dropRemovalIntents(botId: string): void {
    for (const tomb of this.store.tombstones()) if (tomb.botId === botId && tomb.state !== "removed") this.store.deleteTombstone(tomb.botId, tomb.inboxId, tomb.revision);
  }

  /** Durable Keep (4.1/4.2): the claim is one transaction before any network call; the done tx compares the intents to what the claim covered. */
  private async keepPark(botId: string): Promise<OwnerActResult> {
    const claimed = this.store.tx((): OwnerActResult | { keepOp: string } => {
      const park = this.store.getPark(botId);
      if (!park || park.state === "key_release") return { ok: false, code: "not_closing", status: 409 };
      if (park.state === "keep_pending") return { ok: false, code: "keep_pending", status: 409 };
      if (park.remoteDeletedAt !== null) return { ok: false, code: "inbox_gone", status: 409 };
      const binding = this.store.getBinding(botId);
      if (park.state === "remove_authorized") {
        if (!binding) return { ok: false, code: "inbox_gone", status: 409 };
        if (binding.state === "removing") return { ok: false, code: "removal_sending", status: 409 };
        if (binding.state !== "remove_requested") return { ok: false, code: "not_closing", status: 409 };
      }
      const keepOp = this.newId();
      const covers = this.store.tombstones().filter(tomb => tomb.botId === botId && tomb.state !== "removed").map(tomb => ({ inboxId: tomb.inboxId, revision: tomb.revision }));
      return this.store.casPark(botId, park.parkRev, { state: "keep_pending", keepOp, keepCovers: covers, keepFailure: null }) ? { keepOp } : { ok: false, code: "keep_pending", status: 409 };
    });
    if (!("keepOp" in claimed)) return claimed;
    return this.runKeep(botId, claimed.keepOp);
  }

  /** The network half of Keep, repeatable (the resumer runs it again after a crash): GET, restore if closing, then the done tx. */
  private async runKeep(botId: string, keepOp: string): Promise<OwnerActResult> {
    this.keepRuns.add(botId);
    try { return await this.runKeepInner(botId, keepOp); } finally { this.keepRuns.delete(botId); }
  }

  private async runKeepInner(botId: string, keepOp: string): Promise<OwnerActResult> {
    const park = this.store.getPark(botId);
    if (!park || park.keepOp !== keepOp) return { ok: true, row: this.store.getBinding(botId) };
    this.cp("C4");
    const back = (code: string | null, status: number): OwnerActResult => {
      // rollback: CAS on keep_op only, so an unrelated binding bump never blocks it
      this.store.tx(() => { const fresh = this.store.getPark(botId); if (fresh?.keepOp === keepOp) this.store.casPark(botId, fresh.parkRev, { state: fresh.authorizedBy ? "remove_authorized" : fresh.remoteDeletedAt !== null ? "parked_evidence" : "parked", keepOp: null, keepCovers: null, keepFailure: code }); });
      return { ok: false, code: code ?? "unavailable", status };
    };
    const gone = (): OwnerActResult => {
      this.store.tx(() => { const fresh = this.store.getPark(botId); if (fresh?.keepOp === keepOp) this.store.casPark(botId, fresh.parkRev, { state: fresh.authorizedBy ? "remove_authorized" : "parked_evidence", keepOp: null, keepCovers: null, remoteDeletedAt: fresh.remoteDeletedAt ?? this.now() }); });
      return { ok: false, code: "inbox_gone", status: 409 };
    };
    if (park.inboxId) {
      let read = await this.options.client.getInbox({ kind: "owner" }, park.inboxId);
      if (read.kind === "refused" && (read.status === 404 || read.code === "inbox_not_found")) return gone();
      if (read.kind !== "ok") { const f = ownerActFailure(read); return back(f.code, f.status); }
      if (read.body.state === "deleted") return gone();
      if (read.body.state === "closing") {
        const restored = await this.options.client.restoreInbox(park.inboxId, botId);
        if (restored.kind === "refused" && restored.code === "not_closing") { read = await this.options.client.getInbox({ kind: "owner" }, park.inboxId); if (read.kind !== "ok" || read.body.state === "closing") return back("unavailable", 503); }
        else if (restored.kind !== "ok") { const f = ownerActFailure(restored); return back(f.code, f.status); }
      }
    }
    this.cp("C5");
    return this.keepDone(botId, keepOp);
  }

  private keepDone(botId: string, keepOp: string): OwnerActResult {
    const out = this.store.tx((): OwnerActResult & { orphanKey?: boolean } => {
      const park = this.store.getPark(botId);
      if (!park || park.keepOp !== keepOp) return { ok: true, row: this.store.getBinding(botId) }; // another resume already applied it
      const now = this.now();
      if (park.remoteDeletedAt !== null) {
        this.store.casPark(botId, park.parkRev, { state: park.authorizedBy ? "remove_authorized" : "parked_evidence", keepOp: null, keepCovers: null }); // remoteDeletedAt is set on this branch
        return { ok: false, code: "inbox_gone", status: 409 };
      }
      const open = this.store.tombstones().filter(tomb => tomb.botId === botId && tomb.state !== "removed");
      const covers = park.keepCovers ?? [];
      const covered = open.length === covers.length && open.every(tomb => covers.some(c => c.inboxId === tomb.inboxId && c.revision === tomb.revision));
      if (!covered) {
        // H3: a bot deleted, or an intent moved, during Keep: the address is open, the park stays and the owner sees it again
        this.store.casPark(botId, park.parkRev, { state: park.remoteDeletedAt !== null ? "parked_evidence" : "parked", keepOp: null, keepCovers: null, authorizedBy: null, authorizedAt: null });
        return { ok: true, row: this.store.getBinding(botId) };
      }
      for (const tomb of open) this.store.deleteTombstone(tomb.botId, tomb.inboxId, tomb.revision);
      const binding = this.store.getBinding(botId);
      if (this.options.botExists && !this.options.botExists(botId)) {
        // orphan Keep (7.3): the binding goes, the dead bot's key is released durably
        const keyId = binding?.emailKeyRef ?? this.options.secrets.botKey(botId)?.keyId ?? park.keyId;
        if (binding) this.store.deleteBindingGeneration(binding);
        if (keyId) { this.store.casPark(botId, park.parkRev, { state: "key_release", keyId, keepOp: null, keepCovers: null }); return { ok: true, row: null, orphanKey: true }; }
        this.store.deletePark(botId, park.parkId, park.parkRev);
        return { ok: true, row: null };
      }
      this.store.deletePark(botId, park.parkId, park.parkRev);
      if (park.inboxId) this.recordKept(botId, park.inboxId, park.keyId ?? binding?.emailKeyRef ?? null);
      const next = binding ? this.store.casBinding(botId, binding.revision, { state: "restored_unverified", step: "restored", closingUntil: null, failure: null }, now) : null;
      return { ok: true, row: next };
    });
    this.cp("C6");
    if ("orphanKey" in out && out.orphanKey) void this.releaseOrphanKey(botId).catch(() => undefined);
    return out.ok ? { ok: true, row: this.changed(out.row) } : out;
  }

  /** 7.3: revoke the dead bot's key through the gate; a 404 that is not the dark switch counts as done. Then the secret is cleared and the park row goes. */
  async releaseOrphanKey(botId: string): Promise<void> {
    const park = this.store.getPark(botId);
    if (!park || park.state !== "key_release") return;
    if (!park.keyId) { this.store.deletePark(botId, park.parkId, park.parkRev); return; }
    const authority: Authority = { kind: "orphan-key", botId, parkId: park.parkId, parkRev: park.parkRev, keyId: park.keyId };
    this.cp("C12");
    const revoked = await this.gate.revokeKey(authority, park.keyId);
    if (isGateRefusal(revoked)) return;
    if (!(revoked.kind === "ok" || (revoked.kind === "refused" && revoked.status === 404 && !botKeysDark(revoked)))) return;
    this.cp("C13");
    if (this.options.secrets.botKey(botId)?.keyId === park.keyId) this.options.secrets.clearBotKey(botId);
    this.cp("C14");
    this.store.releaseKeptKey(park.keyId); // the revoke answered: the kept mark leaves with the key (r3.3i C)
    const fresh = this.store.getPark(botId);
    if (fresh) this.store.deletePark(botId, fresh.parkId, fresh.parkRev);
  }

  /** email.inbox.deleted: a park only writes the evidence down (a parked or Keep-pending removal is the owner's to decide); an owner-authorized removal completes. */
  async inboxDeleted(inboxId: string): Promise<TombstoneRow | null> {
    this.store.deleteKeepGuard(inboxId); // the inbox is deleted: the guard has nothing left to guard (reducer applyEvent deleted, line 450)
    const park = this.store.parkByInbox(inboxId);
    if (park) {
      if (park.state === "parked" || park.state === "parked_evidence" || park.state === "keep_pending") {
        // r3.4d: evidence turns a parked row into parked_evidence (reducer parkBinding line 112: parked -> parked_evidence, park_rev + 1)
        this.store.tx(() => { const fresh = this.store.getPark(park.botId); if (fresh && fresh.remoteDeletedAt === null) this.store.casPark(park.botId, fresh.parkRev, fresh.state === "parked" ? { remoteDeletedAt: this.now(), state: "parked_evidence" } : { remoteDeletedAt: this.now() }); });
        return null;
      }
      if (park.state === "remove_authorized") {
        const auth = this.gate.authorize({ kind: "park-resume", botId: park.botId });
        if (isGateRefusal(auth)) return null;
        const binding = auth.start;
        if (binding) return this.tombstone(binding, auth.authority);
        await this.finishParkOnly(auth.authority);
        return this.store.getTombstone(park.botId, inboxId);
      }
      return null;
    }
    const row = this.store.bindingByInbox(inboxId);
    // a Flux-initiated closing (billing, account) ends in deletion too (Astra r1 Medium)
    if (!row || (row.state !== "removing" && row.state !== "remove_requested" && row.state !== "closing")) return null;
    const auth = this.gate.authorize({ kind: "owner", botId: row.botId });
    return isGateRefusal(auth) || !auth.start ? null : this.tombstone(auth.start, auth.authority);
  }

  /** The key is revoked, then the binding is replaced by a tombstone kept 30 days. `start` is the generation the removal began from, carried
   * across every await (Astra r2 High #4); every step after an await re-checks it, and the revoke goes through the gate. */
  private async tombstone(start: BindingRow, authority: Authority): Promise<TombstoneRow | null> {
    const inboxId = start.inboxId ?? "";
    if (!this.sameGeneration(start)) return this.store.getTombstone(start.botId, inboxId);
    // the binding is still `start`, so the saved key is this generation's, whatever its ref says (a rotation a crash cut short saves the new key before the binding records it: Astra r3)
    const ours = this.options.secrets.botKey(start.botId);
    let keyEnded = true;
    if (ours) {
      const revoked = await this.gate.revokeKey(authority, ours.keyId);
      if (isGateRefusal(revoked)) return this.store.getTombstone(start.botId, inboxId);
      this.cp("C9");
      // a 404 is not proof (a bodiless one is the dark switch, r2.5): the key is gone only when a second read also shows it absent, otherwise it stays saved and marked
      keyEnded = await this.keyGone(start.botId, inboxId, ours.keyId, revoked) === "gone";
      if (keyEnded && this.options.secrets.botKey(start.botId)?.keyId === ours.keyId) this.options.secrets.clearBotKey(start.botId);
    }
    this.store.tx(() => {
      if (!this.store.deleteBindingGeneration(start)) return;
      // r3.2k (Astra H1): the removal ends every Reconnect and rotation op of this generation, in the same transaction as the completion and the tombstone key
      this.store.clearCursor(RECONNECT_OP_SCOPE + start.botId);
      this.store.clearCursor(ROTATE_SCOPE + start.botId);
      this.completeRemoval(start.botId, inboxId, start.address ? sha256Hex(start.address.toLowerCase()) : null, this.now(), keyEnded ? [start.emailKeyRef, ours?.keyId] : []);
      const tomb = this.store.getTombstone(start.botId, inboxId);
      if (tomb) this.store.casTombstone(start.botId, inboxId, tomb.revision, { keyId: ours?.keyId ?? tomb.keyId });
    });
    return this.store.getTombstone(start.botId, inboxId);
  }

  // ---- bot deletion intents (2.6, Astra R4, L2) ----

  /** In the same transaction as the bot's deletion proof: a removal intent with committed: false. */
  recordDeletionIntent(botId: string): void { recordDeletionIntent(this.store, botId, this.now()); }
  /** saveBots returned: the reaper may act. The intent authority moves the binding to `removing` at once (tools unlisted, sends refused, open rows
   * withdrawn(bot_deleted)); a bot with a park is never moved (the gate refuses). The remote removal is the reaper's. */
  commitDeletionIntent(botId: string): void {
    commitDeletionIntent(this.store, botId);
    for (const tomb of this.store.tombstones()) {
      if (tomb.botId !== botId || tomb.state !== "removing" || !tomb.committed) continue;
      const auth = this.gate.authorize({ kind: "intent", botId, inboxId: tomb.inboxId, intentRev: tomb.revision });
      if (!isGateRefusal(auth) && auth.changed) this.options.withdrawSends?.(botId, "bot_deleted");
    }
  }
  /** saveBots failed: withdrawn in the same rollback that withdraws the proof. */
  withdrawDeletionIntent(botId: string): void { withdrawDeletionIntent(this.store, botId); }

  /** Boot: an uncommitted intent whose bot still exists is dropped; one whose bot is absent with its deletion proof is committed; one whose
   * bot is absent without proof is kept untouched and looked at again next boot (absence without proof is not deletion, L2). A parked bot is never touched (3.4). */
  settleDeletionIntents(botExists: (botId: string) => boolean, deletionProof: (botId: string) => boolean): void {
    for (const tomb of this.store.tombstones()) {
      if (tomb.state !== "removing" || tomb.committed) continue;
      if (this.store.getPark(tomb.botId) || this.store.getBinding(tomb.botId)?.state === "removal_parked") continue; // parked: the owner's Remove decides, not boot
      if (botExists(tomb.botId)) this.store.deleteTombstone(tomb.botId, tomb.inboxId, tomb.revision);
      else if (deletionProof(tomb.botId)) this.commitDeletionIntent(tomb.botId);
    }
  }

  /** The reaper: committed bot-deletion intents run the remote removal with backoff; deleting a bot never waits on the network. A stale or parked
   *  intent fails the gate's revision or park check and is skipped. */
  async reap(): Promise<void> {
    for (const tomb of this.store.tombstones()) {
      if (tomb.state === "removed" || !tomb.committed || (tomb.nextTryAt !== null && tomb.nextTryAt > this.now())) continue;
      if (this.store.getPark(tomb.botId)) continue; // parked by a restore: only the owner's Remove re-arms it
      const binding = this.store.getBinding(tomb.botId);
      if (binding) {
        const auth = this.gate.authorize({ kind: "intent", botId: tomb.botId, inboxId: tomb.inboxId, intentRev: tomb.revision });
        if (isGateRefusal(auth)) continue;
        if (auth.changed) this.options.withdrawSends?.(tomb.botId, "bot_deleted");
        const result = await this.continueRemoval(auth.start, auth.authority);
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

  /** 2.4: every move toward an owner decision already made after the restore, or toward a removal no restore touched. Never changes a `parked` row.
   *  Runs at boot (after settle) and on every tick. The committed intents (step 5) are the reaper's. */
  async resumeRemovals(): Promise<void> {
    for (const park of this.store.parks()) {
      if (park.state === "keep_pending") {
        if (park.remoteDeletedAt !== null) { this.store.tx(() => { const fresh = this.store.getPark(park.botId); if (fresh?.state === "keep_pending") this.store.casPark(park.botId, fresh.parkRev, { state: fresh.authorizedBy ? "remove_authorized" : "parked_evidence", keepOp: null, keepCovers: null }); }); continue; }
        if (park.keepOp && !this.keepRuns.has(park.botId)) await this.runKeep(park.botId, park.keepOp).catch(() => undefined);
      } else if (park.state === "key_release") await this.releaseOrphanKey(park.botId).catch(() => undefined);
    }
    for (const park of this.store.parks()) {
      if (park.state !== "remove_authorized") continue;
      const auth = this.gate.authorize({ kind: "park-resume", botId: park.botId });
      if (!isGateRefusal(auth)) await this.continueRemoval(auth.start, auth.authority).catch(() => undefined);
    }
    await this.pollKeepGuards().catch(() => undefined);
    for (const row of this.store.bindings()) {
      if ((row.state !== "removing" && row.state !== "remove_requested") || this.store.getPark(row.botId)) continue;
      if (this.store.getKeepClaim(row.inboxId)) continue; // r3.4d (reducer parkBinding line 125): a Keep in flight on the target wins; nothing parks it
      // r3.4d parkUnauthorized (reducer line 118): a removing binding no authorize recorded is parked for the owner, never continued; a kept key is REFUSED parking (line 108)
      if (!this.store.removingAuthority(row.botId)) {
        if (this.store.isKeptKey(row.emailKeyRef)) { this.options.onRefusal?.("park_refused_kept"); continue; }
        this.store.casBinding(row.botId, row.revision, { state: "removal_parked" }, this.now());
        this.options.adoptParks?.();
        continue;
      }
      await this.resumeRemoval(row.botId).catch(() => undefined);
    }
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
  rotateKey(botId: string, canRotate: (botId: string) => boolean): Promise<{ ok: true } | { ok: false; code: string }> {
    return this.serial(botId, () => this.rotateKeyOnce(botId, canRotate)); // r3.2k (Astra M1): one key operation per bot
  }
  private async rotateKeyOnce(botId: string, canRotate: (botId: string) => boolean): Promise<{ ok: true } | { ok: false; code: string }> {
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
    const start = this.store.getBinding(botId);
    const stored = this.options.secrets.botKey(botId);
    if (!stored || stored.keyId === intent.oldKeyId) {
      // the new key is not saved yet: the same op id returns the same key inside Flux's 24 h window
      if (this.now() - intent.at >= KEY_IDEMPOTENCY_WINDOW_MS) { this.store.clearCursor(ROTATE_SCOPE + botId); return { ok: false, code: "rotation_expired" }; }
      const minted = await this.options.client.mintBotKey({ botId }, keyIdempotencyKey(this.options.installId, intent.opId));
      if (botKeysDark(minted)) return { ok: false, code: "email_dark" };
      if (minted.kind !== "ok" || !minted.body.key || !minted.body.key_id) return { ok: false, code: minted.kind === "refused" ? minted.code : "unavailable" };
      const row = this.store.getBinding(botId);
      if (!row?.inboxId) return { ok: false, code: "not_active" };
      this.noteMinted(botId, minted.body.key_id);
      const check = await this.options.client.getInbox({ kind: "candidate", credential: { token: minted.body.key, keyId: minted.body.key_id } }, row.inboxId);
      if (check.kind !== "ok") return { ok: false, code: check.kind === "refused" ? check.code : "unavailable" };
      // r3.2k (Astra M1): the same current-op check as Reconnect: the intent is still this one and the binding is still the generation this run began
      // from; else the minted key is not saved (a removal, or a removal and a new setup, happened while the network answered). No await before the save.
      const now = this.store.getBinding(botId);
      // r3.2m (Astra M1): and the binding is still live (a Remove that began during the network await keeps the generation fields but sets state removing).
      if (!start || !now || !LIVE_BINDING_STATES.has(now.state) || !sameBinding(now, start) || this.rotation(botId)?.opId !== intent.opId) return { ok: false, code: "not_active" };
      this.options.secrets.setBotKey(botId, { token: minted.body.key, keyId: minted.body.key_id });
    }
    // H1: the new key must be durably acknowledged before the binding points at it, the old key is revoked or the intent is dropped. A refused or
    // failed save leaves all three as they were (the saver resends; the intent keeps the next call or boot going).
    const saved = this.options.secrets.botKey(botId);
    if (saved && saved.keyId !== intent.oldKeyId) {
      if (!(await this.options.secrets.durable())) return { ok: false, code: "save_pending" };
      // r3.2l (Fable M4): the same generation + current-op check after the await as before the save: a removal (and a new setup) during durable() must not
      // write the removed generation's key id onto a replacement binding or clear its rotate cursor.
      const latest = this.store.getBinding(botId);
      // r3.2m (Astra M1): and still live: a Remove that began during durable() has set state removing but kept opId, inbox and key ref, so the generation test alone passes;
      // an emailKeyRef write now would make the removal's sameGeneration fail and abandon its work.
      if (!start || !latest || !LIVE_BINDING_STATES.has(latest.state) || !sameBinding(latest, start) || this.rotation(botId)?.opId !== intent.opId) return { ok: false, code: "not_active" };
      if (latest.emailKeyRef !== saved.keyId) this.store.casBinding(botId, latest.revision, { emailKeyRef: saved.keyId }, this.now());
    }
    // the new key is saved: the old one is revoked (404 = already gone); until then the intent stays for the next boot
    // r2 rule 4 (r4 wording): only a key id from this home's own rotation intent is revoked; the intent is a row of this database, and a restore deletes every one
    if (intent.oldKeyId && intent.oldKeyId !== this.options.secrets.botKey(botId)?.keyId) {
      const revoked = await this.gate.revokeKey({ kind: "rotate", botId, oldKeyId: intent.oldKeyId, rotateOp: intent.opId }, intent.oldKeyId);
      if (isGateRefusal(revoked)) return { ok: false, code: "revoke_pending" };
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
      if (row.state === "removing" || row.state === "remove_requested" || row.state === "removal_parked" || row.state === "restored_unverified") continue;
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
    }
    // Removals first (park-gated, authority carried): a removal that completes clears the Reconnect and rotation ops of its generation and deletes the binding,
    // so the Reconnect resumption below never replays an op for a binding whose removal is pending or just finished.
    await this.resumeRemovals();
    // r3.2k (Astra H2): a Reconnect a crash cut short (op saved inside 24 h, binding still restored) is finished: the same op returns the same key,
    // which is saved, made durable and only then committed. Without the saved op nothing is resumed (a restored binding stays unverified).
    for (const row of this.store.bindings()) {
      if (row.state === "restored_unverified" && this.reconnectPending(row.botId)) await this.reconnect(row.botId).catch(() => undefined);
    }
    for (const intent of this.store.pendingPolicyIntents()) await this.syncPolicy(intent.botId, intent.revision);
    // 2.3: a rotation a crash cut short ends with one key: the saved one; the other is revoked
    // A restored binding is unverified (BOT-EMAIL-MURAGE-109 section 7): its old key may still be the live key of the home it was copied from
    // (restore-to-new while the source runs), so boot never revokes for it. The intent stays until the owner reconnects.
    for (const row of this.store.bindings()) {
      if (row.state === "restored_unverified") continue;
      await this.serial(row.botId, async () => { const intent = this.rotation(row.botId); if (intent) await this.finishRotation(row.botId, intent); });
    }
  }
}
