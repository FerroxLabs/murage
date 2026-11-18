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
import { emailOwnerRef, type EmailSecretStore } from "./email-secrets.ts";
import { GUARD_POLL_MS, GUARD_POLL_WINDOW_MS, LIVE_BINDING_STATES, OPEN_SEND_STATES, type BindingRow, type BindingState, type KeepClaim, type EmailStore, type TombstoneRow } from "./email-store.ts";
import { botKeysDark, type FluxCredential, type FluxEmailClient } from "./flux-email-client.ts";
import { RemovalGate, isGateRefusal, type Authority } from "./removal-gate.ts";
import { retiredRefs, writeRetiredRefs } from "./retired-keys.ts";

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
/** EMAIL-ACCOUNT-CHANGE: the failure of a binding the Flux account change left behind (its inbox is not on the account signed in now). */
export const ACCOUNT_CHANGED = "account_changed";
/** The bindings whose inbox the account check reads (#5): every state with an inbox Flux still holds for this install. */
const ACCOUNT_CHECKED_STATES: ReadonlySet<BindingState> = new Set<BindingState>(["active", "paused", "billing_hold", "grace", "closing", "account_off"]);
/** Cursor row per bot: a rekey ({opId, at}) written before its mint, so a crash replays the same op inside Flux's 24 h window. */
const REKEY_SCOPE = "rekey:";
/** The binding states a key heal runs for (an inbox this account holds and the bot may use). */
const HEAL_STATES: ReadonlySet<BindingState> = new Set<BindingState>(["active", "paused", "billing_hold", "grace", "closing"]);
/** EMAIL-ACCOUNT-CHANGE r4 section 4 / r5: cursor row per bot, `{ownerRef}`: the owner ref the current setup run started on. A setup row with no
 *  valid record has an UNPROVEN owner: it is cancelled before any paid call and never takes the present ref. */
export const SETUP_ACCOUNT_SCOPE = "setup-account:";
/** r5 U1 cancel: cursor row per bot, the key ids of the run that was cancelled (a saved bot key, an emailKeyRef). Never committed by anything. */
export const STALE_KEY_SCOPE = "setup-stale-key:";
/** r6 4b: cursor row per bot, `{ownerRef, inboxId, at}`: the owner credential that PROVED this inbox (a setup or adoption commit, or a passing
 *  owner #5 read). Never written from a #28 account id, never from ownerRef() as a fallback. A row with an inbox and no valid record is HELD. */
export const INBOX_OWNER_SCOPE = "inbox-owner:";
/** r6 4b: the proof read waits from 30 s, doubling up to 15 min, between tries; it never times out into sending. */
export const PROVE_RETRY_MS = [30_000, 60_000, 120_000, 300_000, 900_000] as const;
/** What a binding-scoped owner call answers while the owner is unproven: nothing was sent (read as try later). */
const HELD_OUTCOME = { kind: "uncertain", reason: "owner_changed" } as const;
/** How long a setup or a heal waits for the shell to say a new key is on disk before it tries again on the next tick. */
export const KEY_DURABLE_WAIT_MS = 5_000;

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
  kind: "guard_restore" | "guard_refused" | "key_release_unconfirmed" | "park_refused_kept"; botId: string; gen: { inboxId: string; keyRef: string | null }; text: string;
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
  /** EMAIL-ACCOUNT-CHANGE: withdraws only the bot's sends that never reached Flux (send-service withdrawUndispatchedForBot); a send that
   *  may be in flight on the old account keeps its row, so a late delivery still lands and no duplicate can be sent. */
  withdrawUndispatched?: (botId: string) => void;
  onRefusal?: (code: string) => void;
  /** r3.4d ops alert line (invariant opsLinesNameNoAddress): never an address, always the binding id and the inbox generation. */
  onOps?: (line: OpsLine) => void;
  /** Adopts the removal_parked bindings that have no park row (the runtime lifts its INSERT fence for exactly this call). */
  adoptParks?: () => void;
  /** r4 section 4: the ref of the owner credential an owner call would use now (`owner:<fp>`). Read only where a new run starts (r5 F1).
   *  Defaults to the secret store's email:owner token. */
  ownerRef?: () => string | null;
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
  if (answer.kind === "uncertain" && answer.reason === "owner_changed") return { ok: false, code: "try_later", status: 409 };
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
  private readonly reconnectRuns = new Map<string, Promise<OwnerActResult>>();
  /** When the tick runs a stalled setup next (in memory: boot runs every provisioning binding anyway). */
  private readonly setupRetries = new Map<string, number>();
  /** When the tick runs a key heal next, per bot (in memory: boot runs every heal anyway). */
  private readonly healRetries = new Map<string, { tries: number; at: number }>();
  constructor(options: BindingServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => uuidv7(this.now()));
    this.gate = options.gate ?? new RemovalGate({ store: options.store, client: options.client, secrets: options.secrets, botExists: options.botExists, restoreWindow: options.restoreWindow, now: this.now });
  }
  private get store() { return this.options.store; }
  private cp(name: string): void { this.options.checkpoint?.(name); }
  /** r5 F1: read at the start of a new run only (enable on a new binding, Reconnect or Retry press, an adoption, a rotation, a heal). */
  private ownerRef(): string | null { return this.options.ownerRef ? this.options.ownerRef() : emailOwnerRef(this.options.secrets); }
  /** The same ref after an await: an awaited result is committed only while the run's ref is still the current one. */
  private sameOwner(outcome: { usedOwnerRef?: string }, ref: string): boolean { return outcome.usedOwnerRef === ref && this.ownerRef() === ref; }

  /** The setup row's recorded owner ref, or null when there is no valid record (r5 U1). */
  private setupRecord(botId: string): string | null {
    const raw = this.store.getCursor(`${SETUP_ACCOUNT_SCOPE}${botId}`);
    if (!raw) return null;
    try { const value = JSON.parse(raw) as { ownerRef?: unknown } | null; return value && typeof value.ownerRef === "string" && value.ownerRef ? value.ownerRef : null; } catch { return null; }
  }
  private staleKeys(botId: string): string[] {
    try { const value = JSON.parse(this.store.getCursor(`${STALE_KEY_SCOPE}${botId}`) ?? "null") as unknown; return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []; } catch { return []; }
  }

  /** r5 U1: a setup or failed row with no inbox whose run has no valid owner record, or whose record is not the owner signed in now. */
  private unprovenSetup(row: BindingRow): boolean {
    if (row.inboxId !== null || (row.state !== "provisioning" && row.state !== "failed")) return false;
    const record = this.setupRecord(row.botId);
    if (!record) return true;
    const current = this.ownerRef();
    return current !== null && current !== record;
  }

  // ---- r6 4b: the inbox owner record, U3, and the proof ----

  private inboxRecord(botId: string): { ownerRef: string; inboxId: string } | null {
    const raw = this.store.getCursor(`${INBOX_OWNER_SCOPE}${botId}`);
    if (!raw) return null;
    try { const value = JSON.parse(raw) as { ownerRef?: unknown; inboxId?: unknown } | null; return value && typeof value.ownerRef === "string" && value.ownerRef && typeof value.inboxId === "string" ? { ownerRef: value.ownerRef, inboxId: value.inboxId } : null; } catch { return null; }
  }
  /** In the caller's transaction. */
  private writeInboxOwner(botId: string, inboxId: string, ownerRef: string): void { this.store.setCursor(`${INBOX_OWNER_SCOPE}${botId}`, JSON.stringify({ ownerRef, inboxId, at: this.now() }), this.now()); }
  private clearInboxOwner(botId: string): void { this.store.clearCursor(`${INBOX_OWNER_SCOPE}${botId}`); }
  /** The record's ref when it is valid for this row's inbox and equals the owner credential now; otherwise null. Derived from local state each time. */
  private provenRef(row: BindingRow): string | null {
    if (!row.inboxId) return null;
    const record = this.inboxRecord(row.botId);
    const now = this.ownerRef();
    return record && record.inboxId === row.inboxId && now !== null && record.ownerRef === now ? record.ownerRef : null;
  }
  /** U3: a row with an inbox in a checked state and no valid record for the owner signed in now. */
  private unprovenInbox(row: BindingRow): boolean { return row.inboxId !== null && ACCOUNT_CHECKED_STATES.has(row.state) && this.provenRef(row) === null; }
  /** Synchronous, local: may a bot send or reply (charge) on this bot's inbox? False while the owner is unproven (F1b, and the send fence). */
  ownerProven(botId: string): boolean { const row = this.store.getBinding(botId); return !row || !this.unprovenInbox(row); }
  /** The owner ref a binding-scoped owner call carries: the record's ref only while it is current; null means try later, no Flux call. */
  ownerRefFor(botId: string): string | null { const row = this.store.getBinding(botId); return row ? this.provenRef(row) : null; }
  /** True while the bot's sends wait: an unproven inbox, or a key rotation in progress (the r4 handover pause). */
  holdsSends(botId: string): boolean { return !this.ownerProven(botId) || this.rotation(botId) !== null; }
  /** The bots whose inbox is held for a proof (the plain line the owner reads). */
  heldBots(): string[] { return this.store.bindings().filter(row => this.unprovenInbox(row)).map(row => row.botId); }

  private readonly proveRuns = new Map<string, Promise<"proven" | "held" | "moved">>();
  private readonly proveRetries = new Map<string, { tries: number; at: number }>();
  /** r6 4b: one owner #5 read on the row's inbox with the owner credential signed in now (run-start site 5). ok writes the record (only while the
   *  credential, the used ref and the binding's inbox are all unchanged after the await); 404 inbox_not_found is the account change; any other
   *  answer leaves the row held. */
  proveOwner(botId: string, force = false): Promise<"proven" | "held" | "moved"> {
    const running = this.proveRuns.get(botId);
    if (running) return running;
    const run = (async (): Promise<"proven" | "held" | "moved"> => {
      const row = this.store.getBinding(botId);
      // `force`: the owner key or cursor changed (checkAccount): read #5 even for a row the record already proves
      if (!row?.inboxId || (!ACCOUNT_CHECKED_STATES.has(row.state) && !(force && ["removal_parked", "removing", "remove_requested"].includes(row.state))) || (!force && !this.unprovenInbox(row))) return "proven";
      const gen = this.ownerRef();
      if (!gen) return "held";
      const read = await this.options.client.getInbox({ kind: "owner", expectOwnerRef: gen }, row.inboxId);
      const latest = this.store.getBinding(botId);
      if (!latest || latest.inboxId !== row.inboxId) return "held";
      if (read.kind === "ok") {
        if (read.usedOwnerRef !== gen || this.ownerRef() !== gen) return "held";
        this.store.tx(() => {
          this.writeInboxOwner(botId, row.inboxId!, gen);
          // r7 G1: this bot's held `prepared` sends go out on the next tick, not after the 30 s / backoff wait
          for (const held of this.store.sendsOfBot(botId, ["prepared"])) if (held.dueAt !== null) this.store.casSend(held.sendId, held.revision, { dueAt: this.now() }, this.now());
        });
        this.proveRetries.delete(botId);
        return "proven";
      }
      if (read.kind === "refused" && read.status === 404 && read.code === "inbox_not_found" && ACCOUNT_CHECKED_STATES.has(latest.state)) {
        const next = this.store.tx(() => { const moved = this.store.casBinding(botId, latest.revision, { state: "restored_unverified", failure: ACCOUNT_CHANGED, fluxAccountId: null }, this.now()); if (moved) { this.freeze(latest); this.clearInboxOwner(botId); } return moved; });
        if (next) { this.options.withdrawUndispatched?.(botId); this.changed(next); this.proveRetries.delete(botId); return "moved"; }
      }
      return "held";
    })().finally(() => { this.proveRuns.delete(botId); });
    this.proveRuns.set(botId, run);
    return run;
  }
  /** Boot (after reconcileBindings, before the reader), the tick and an owner-token change: every held row is proved. `force` ignores the backoff. */
  async proveOwners(force = false): Promise<void> {
    let moved = false;
    for (const row of this.store.bindings()) {
      if (!this.unprovenInbox(row)) continue;
      const wait = this.proveRetries.get(row.botId);
      if (!force && wait && this.now() < wait.at) continue;
      const result = await this.proveOwner(row.botId).catch(() => "held" as const);
      if (result === "held") { const tries = (wait?.tries ?? 0) + 1; this.proveRetries.set(row.botId, { tries, at: this.now() + PROVE_RETRY_MS[Math.min(tries, PROVE_RETRY_MS.length) - 1]! }); }
      if (result === "moved") moved = true;
    }
    if (moved) await this.adoptAccountChanged().catch(() => false);
  }

  /** r5 U1 step 1: cancel. One local transaction, no Flux call. Never assigns an owner. The saved key is dropped by the one slot writer after
   *  the commit; its id is stale-listed in the same transaction so a crash in between cannot bring it back. */
  private cancelUnproven(row: BindingRow): BindingRow | null {
    const stale = [...new Set([...this.staleKeys(row.botId), this.options.secrets.botKey(row.botId)?.keyId, row.emailKeyRef].filter((id): id is string => typeof id === "string" && id.length > 0))];
    const next = this.store.tx(() => {
      const moved = this.store.casBinding(row.botId, row.revision, { state: "restored_unverified", failure: ACCOUNT_CHANGED, step: null, opId: null, opStartedAt: null, inboxId: null, emailKeyRef: null, fluxAccountId: null, address: null, closingUntil: null }, this.now());
      if (!moved) return null;
      this.store.clearCursor(`${SETUP_ACCOUNT_SCOPE}${row.botId}`);
      this.store.clearCursor(`${SETUP_BUDGET_SCOPE}${row.botId}`);
      this.clearInboxOwner(row.botId);
      if (stale.length) this.store.setCursor(`${STALE_KEY_SCOPE}${row.botId}`, JSON.stringify(stale), this.now());
      return moved;
    });
    this.setupRetries.delete(row.botId);
    if (!next) return this.store.getBinding(row.botId);
    if (this.options.secrets.botKey(row.botId)) this.saveBotKey(row.botId, null);
    this.cancelled.add(row.botId);
    return next;
  }
  /** Bots whose setup was just cancelled by U1: their adoption runs as a new act right after the run. */
  private readonly cancelled = new Set<string>();

  /** Owner act: give this bot an address. A new binding, or a failed one retried, starts at step `key` with a new op_id. */
  async enable(botId: string, input: { username?: string; displayName?: string }): Promise<BindingRow | null> {
    const running = this.setupRuns.get(botId);
    if (running) return running;
    // r4 section 1: no durable key store this run: nothing starts, no Flux call
    if (!this.options.secrets.available) return this.store.getBinding(botId);
    const now = this.now();
    const existing = this.store.getBinding(botId);
    if (!existing) {
      // r5 F1: the run starts on the owner credential signed in now, and records it
      const ref = this.ownerRef();
      if (!ref) return null;
      this.store.tx(() => {
        this.store.clearCursor(RECONNECT_OP_SCOPE + botId);
        this.store.clearCursor(ROTATE_SCOPE + botId);
        this.store.insertBinding({ botId, inboxId: null, address: null, username: input.username ?? null, displayName: input.displayName ?? null, emailKeyRef: null, fluxAccountId: null, state: "provisioning", step: "key", opId: this.newId(), opStartedAt: now, policy: "auto", failure: null, updatedAt: now });
        this.store.setCursor(`${SETUP_ACCOUNT_SCOPE}${botId}`, JSON.stringify({ ownerRef: ref }), now);
      });
    } else if (existing.state === "failed" && this.unprovenSetup(existing)) {
      // r5 U1 step 4: Retry on a row of unproven ownership cancels, then acts as a Reconnect press (adopt, else a fresh setup stamped now)
      this.cancelUnproven(existing);
      this.cancelled.delete(botId);
      const pressed = await this.reconnect(botId);
      return pressed.ok ? pressed.row : this.store.getBinding(botId);
    } else if (existing.state === "failed") {
      // a setup that stopped on no answer replays its op_id inside Flux's 24 h window, so Flux returns what it made, and gets a fresh budget
      const replay = existing.failure === SETUP_NO_ANSWER && existing.opId !== null && existing.opStartedAt !== null && now - existing.opStartedAt < KEY_IDEMPOTENCY_WINDOW_MS;
      this.store.clearCursor(`${SETUP_BUDGET_SCOPE}${botId}`);
      this.store.casBinding(botId, existing.revision, { state: "provisioning", step: this.heldKey(existing) ? "inbox" : "key", ...(replay ? {} : { opId: this.newId(), opStartedAt: now }), failure: null, username: input.username ?? existing.username, displayName: input.displayName ?? existing.displayName }, now);
    }
    return this.advance(botId);
  }

  /** Runs the next setup step of a provisioning binding (also from boot). */
  advance(botId: string): Promise<BindingRow | null> {
    const running = this.setupRuns.get(botId);
    if (running) return running;
    const run = (async () => {
      try {
        const row = this.noteSetupResult(botId, await this.advanceSetup(botId));
        // r5 U1 step 2: a cancelled run adopts the bot's inbox on the current account when there is one (free), as a new act
        if (this.cancelled.delete(botId)) await this.adoptAccountChanged().catch(() => false);
        return this.store.getBinding(botId) ?? row;
      } finally { this.setupRuns.delete(botId); }
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
    if (!this.options.secrets.available) return row;
    // r5 F2: the first statement, before the step-key skip and before any await. Boot, the tick and enable all come through here.
    if (this.unprovenSetup(row)) return this.cancelUnproven(row);
    const recorded = this.setupRecord(botId)!;
    // EMAIL-ACCOUNT-CHANGE r3: the database names the key (emailKeyRef), the secret file only holds it. Step inbox goes on only while the
    // named key is held; a crash that lost its save (the file may even hold an old account's key) goes back to step key, whose replay of
    // the same op id returns the same key inside Flux's 24 h window.
    if (row.step === "inbox" && !this.heldKey(row)) row = this.store.casBinding(botId, row.revision, { step: "key" }, this.now()) ?? this.store.getBinding(botId)!;
    // step 1: the key. A saved key is never trusted here (emailKeyRef is null, nothing names it): the mint replays the op's Idempotency-Key.
    if (row.step === "key") {
      // past Flux's 24 h idempotency window the old op cannot be replayed: a new op_id (a key the first op minted and never saved is not
      // listable through bot-keys yet; Flux revokes unlabelled strays on its side, open item in BUILD-LOG)
      if (row.opStartedAt !== null && this.now() - row.opStartedAt >= KEY_IDEMPOTENCY_WINDOW_MS) row = this.store.casBinding(botId, row.revision, { opId: this.newId(), opStartedAt: this.now() }, this.now()) ?? this.store.getBinding(botId)!;
      const minted = await this.options.client.mintBotKey({ botId }, keyIdempotencyKey(this.options.installId, row.opId!), recorded);
      row = this.store.getBinding(botId)!;
      if (row.state !== "provisioning" || row.step !== "key") return row;
      // r5 F1: an answer from another owner credential than the run's record is not committed
      if (minted.kind === "ok" && !this.sameOwner(minted, recorded)) return row;
      if (botKeysDark(minted)) {
        // r2.5: Flux's bot key switch is off. Nothing was made at Flux; the row goes, the launch switch is read again, no failure shows.
        if (!row.inboxId) this.store.deleteBinding(botId, row.revision);
        this.options.onRefusal?.("email_not_enabled");
        return this.store.getBinding(botId);
      }
      if (minted.kind === "ok" && minted.body.key && minted.body.key_id) {
        this.noteMinted(botId, minted.body.key_id);
        const keyId = minted.body.key_id;
        const revision = row.revision;
        this.saveBotKey(botId, { token: minted.body.key, keyId });
        if (!await this.options.secrets.whenDurable(keyId, KEY_DURABLE_WAIT_MS) || !await this.options.secrets.durable()) return this.store.getBinding(botId);
        const current = this.store.getBinding(botId);
        if (!current || current.state !== "provisioning" || current.revision !== revision) return current;
        if (this.ownerRef() !== recorded) return this.cancelUnproven(current);
        row = this.store.tx(() => { const next = this.store.casBinding(botId, revision, { step: "inbox", emailKeyRef: keyId }, this.now()); if (next) this.store.clearCursor(`${STALE_KEY_SCOPE}${botId}`); return next; }) ?? this.store.getBinding(botId)!;
      } else if (minted.kind === "refused") {
        this.options.onRefusal?.(minted.code);
        return this.store.casBinding(botId, row.revision, { state: "failed", failure: minted.code }, this.now()) ?? this.store.getBinding(botId)!;
      } else return row; // no answer: the same op_id is replayed on the next advance (Flux returns the same key inside 24 h)
    }
    if (row.step === "inbox") {
      // r3: the paid inbox is made only once its key is on disk (the shell's ack), so a crash never leaves it with no key that survived
      const key = this.heldKey(row);
      if (!key || !await this.options.secrets.whenDurable(key.keyId, KEY_DURABLE_WAIT_MS) || !await this.options.secrets.durable()) return this.store.getBinding(botId);
      row = this.store.getBinding(botId)!;
      if (row.state !== "provisioning" || row.step !== "inbox") return row;
      const created = await this.options.client.createInbox({ botId, username: row.username ?? undefined, displayName: row.displayName ?? undefined }, inboxIdempotencyKey(this.options.installId, row.opId!), recorded);
      row = this.store.getBinding(botId)!;
      if (row.state !== "provisioning" || row.step !== "inbox") return row;
      if (created.kind === "ok" && !this.sameOwner(created, recorded)) return row;
      if (created.kind === "ok" && created.body.id) return this.activate(row, created.body.id, created.body.address ?? null, created.body.send_policy, recorded);
      if (created.kind === "refused" && created.code === "inbox_exists" && typeof created.error.fields.inbox_id === "string") {
        // adopted: this bot's inbox already exists (an earlier run, or a reinstall); read it for the address
        const inboxId = created.error.fields.inbox_id;
        const read = await this.options.client.getInbox({ kind: "owner", expectOwnerRef: recorded }, inboxId);
        const latest = this.store.getBinding(botId)!;
        if (read.kind === "ok" && this.sameOwner(read, recorded)) return this.activate(latest, inboxId, read.body.address ?? null, read.body.send_policy, recorded);
        return latest;
      }
      if (created.kind === "refused") { this.options.onRefusal?.(created.code); return this.store.casBinding(botId, row.revision, { state: "failed", failure: created.code }, this.now()) ?? this.store.getBinding(botId)!; }
      return row;
    }
    return row;
  }

  private activate(row: BindingRow, inboxId: string, address: string | null, policy: unknown, ownerRef: string): BindingRow {
    // r6 4b: the owner record is written only from proof, in the commit's own transaction: here the setup's record (the credential that made or read the inbox)
    return this.store.tx(() => {
      const moved = this.store.casBinding(row.botId, row.revision, { state: "active", step: null, inboxId, address, failure: null, ...(policy === "ask" || policy === "auto" ? { policy } : {}) }, this.now());
      if (moved) this.writeInboxOwner(row.botId, inboxId, ownerRef);
      return moved;
    }) ?? this.store.getBinding(row.botId)!;
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
    const ref = this.provenRef(row);
    if (!ref) return { row, pause: null };
    const read = await this.options.client.getInbox({ kind: "owner", expectOwnerRef: ref }, row.inboxId);
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
    const ref = this.provenRef(row);
    const answer = ref ? await this.options.client.patchInbox(row.inboxId, { paused: true }, ref) : HELD_OUTCOME;
    if (answer.kind !== "ok") return ownerActFailure(answer);
    return { ok: true, row: this.changed(this.mirror(botId, "paused")) };
  }

  /** Owner Resume (#8): `acknowledge` is the pause reason Flux gave; the owner's note is required by the panel before this runs. */
  async resume(botId: string): Promise<OwnerActResult> {
    const row = this.store.getBinding(botId);
    if (!row?.inboxId || row.state !== "paused") return { ok: false, code: "not_paused", status: 409 };
    const ref = this.provenRef(row);
    const read = ref ? await this.options.client.getInbox({ kind: "owner", expectOwnerRef: ref }, row.inboxId) : HELD_OUTCOME;
    if (read.kind !== "ok") return ownerActFailure(read);
    const reason = read.body.pause && typeof read.body.pause === "object" ? String((read.body.pause as { reason?: unknown }).reason ?? "") : "";
    if (!reason) return { ok: true, row: this.changed(this.mirror(botId, String(read.body.state ?? "active"))) };
    const answer = await this.options.client.resumeInbox(row.inboxId, reason, ref!);
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
  private reconnectOp(botId: string, fresh = false, ownerRef = this.ownerRef()): string | null {
    if (!this.store.getBinding(botId)) return null;
    if (!fresh) {
      try {
        const saved = JSON.parse(this.store.getCursor(RECONNECT_OP_SCOPE + botId) ?? "null") as { opId?: unknown; at?: unknown; ownerRef?: unknown } | null;
        if (saved && saved.ownerRef === ownerRef && typeof saved.opId === "string" && typeof saved.at === "number" && this.now() - saved.at < KEY_IDEMPOTENCY_WINDOW_MS) return saved.opId;
      } catch { /* an unreadable record is a new op */ }
    }
    const opId = this.newId();
    this.store.setCursor(RECONNECT_OP_SCOPE + botId, JSON.stringify({ opId, at: this.now(), ownerRef }), this.now());
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
  private async revokeStray(botId: string, keyId: string, reconnectOp: string, ownerRef: string): Promise<boolean> {
    if (this.ownerRef() !== ownerRef) return false;
    const answer = await this.gate.revokeKey({ kind: "stray", botId, keyId, reconnectOp }, keyId); // int2: every revoke goes through the park gate
    if (isGateRefusal(answer)) return false;
    return answer.kind === "ok" || (answer.kind === "refused" && answer.status === 404 && !botKeysDark(answer));
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
  /** Reconnect (section 7 restore): the owner lists #4, the inbox whose bot_id is this bot is adopted, a new email key is minted for it.
   *  EMAIL-ACCOUNT-CHANGE: a binding the account change left behind (failure account_changed) whose bot has no inbox on this account is
   *  set up again on it (same username and display name); that inbox is paid, so only the owner's press makes it. */
  async reconnect(botId: string): Promise<OwnerActResult> {
    return this.serial(botId, async () => {
      const row = this.store.getBinding(botId);
      if (!this.options.secrets.available) return { ok: false, code: "email_store_unavailable", status: 503 };
      if (!row || row.state !== "restored_unverified") return { ok: false, code: "not_restored", status: 409 };
      // r5: the press is a run start; it records the owner ref signed in now, and every call of this run carries it
      const ref = this.ownerRef();
      if (!ref) return { ok: false, code: "owner_required", status: 403 };
      const listed = await this.options.client.listInboxes({ kind: "owner", expectOwnerRef: ref });
      if (listed.kind !== "ok") return ownerActFailure(listed);
      if (!this.sameOwner(listed, ref)) return { ok: false, code: "owner_changed", status: 409 };
      const inbox = (listed.body.data ?? []).find(item => item.bot_id === botId && item.state !== "deleted");
      if (inbox) return this.adoptInbox(botId, inbox, ref);
      const latest = this.store.getBinding(botId);
      if (latest?.state !== "restored_unverified" || latest.failure !== ACCOUNT_CHANGED) return { ok: false, code: "inbox_not_found", status: 404 };
      return { ok: true, row: await this.setUpAgain(latest, ref) };
    });
  }

  /** One reconnect or adoption per bot at a time (an owner press and the reader's adoption never mint two keys). */
  private oneReconnect(botId: string, run: () => Promise<OwnerActResult>): Promise<OwnerActResult> {
    const running = this.reconnectRuns.get(botId);
    if (running) return running;
    const next = this.serial(botId, run).finally(() => { this.reconnectRuns.delete(botId); });
    this.reconnectRuns.set(botId, next);
    return next;
  }

  /** Adopts `inbox` (this account's inbox for the bot): a new email key is minted for the bot, then the binding takes the inbox's state.
   *  EMAIL-ACCOUNT-CHANGE r3: the old account's key is never overwritten: its retired ref (written when the binding froze) moves it to its
   *  retired slot in the same save. The adopted inbox is the bot's own again, so a ref left for that inbox goes with the commit. */
  private async adoptInbox(botId: string, inbox: { id: string; address?: string | null; state?: string }, ref: string): Promise<OwnerActResult> {
    const start = this.store.getBinding(botId);
    if (!start || start.state !== "restored_unverified") return { ok: true, row: start };
    const opId = this.reconnectOp(botId, false, ref);
    if (!opId) return { ok: true, row: null };
    let usedOp = opId;
    let minted = await this.options.client.mintBotKey({ botId }, keyIdempotencyKey(this.options.installId, usedOp), ref);
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
      if (!(await this.revokeStray(botId, live, usedOp, ref))) return { ok: false, code: "unavailable", status: 503 };
      const next = this.reconnectOp(botId, true, ref);
      if (!next) return { ok: true, row: null };
      usedOp = next;
      minted = await this.options.client.mintBotKey({ botId }, keyIdempotencyKey(this.options.installId, usedOp), ref);
    }
    if (minted.kind !== "ok") return ownerActFailure(minted);
    // r5 F1: the key is kept only if the credential that made it is still the one this adoption started on
    if (!this.sameOwner(minted, ref)) return { ok: false, code: "owner_changed", status: 409 };
    if (!minted.body.key || !minted.body.key_id) return { ok: false, code: "unavailable", status: 503 };
    // Even an op replaced during the mint owns its minted-key history; it
    // cannot save the key, but a later stray cleanup still needs this witness.
    this.noteMinted(botId, minted.body.key_id);
    let latest = this.store.getBinding(botId);
    // the binding moved on while the key was minted (removed, or set up again): the new key is not saved, Flux revokes unsaved keys
    if (!latest || !this.reconnectMaySave(botId, usedOp, start)) return { ok: false, code: "unavailable", status: 503 };
    const keyId = minted.body.key_id;
    this.options.secrets.rotateInto(botId, { token: minted.body.key, keyId }, this.heldKey(start), retiredRefs(this.store, botId));
    if (!await this.options.secrets.whenDurable(keyId, KEY_DURABLE_WAIT_MS) || !await this.options.secrets.durable()) return { ok: false, code: "save_pending", status: 503 };
    if (!this.reconnectMaySave(botId, usedOp, start) || this.ownerRef() !== ref) return { ok: false, code: "unavailable", status: 503 };
    latest = this.store.getBinding(botId)!;
    const revision = latest.revision, address = inbox.address ?? latest.address;
    const state: BindingState = inbox.state && inbox.state !== "active" && LIVE_BINDING_STATES.has(inbox.state as BindingState) ? inbox.state as BindingState : "active";
    const next = this.store.tx(() => {
      const moved = this.store.casBinding(botId, revision, { state, inboxId: inbox.id, address, emailKeyRef: keyId, failure: null, step: null }, this.now());
      if (moved) { this.writeInboxOwner(botId, inbox.id, ref); this.store.clearCursor(RECONNECT_OP_SCOPE + botId); }
      if (moved) { const refs = retiredRefs(this.store); const kept = refs.filter(ref => !(ref.botId === botId && ref.inboxId === inbox.id)); if (kept.length !== refs.length) writeRetiredRefs(this.store, kept, this.now()); }
      return moved;
    });
    return { ok: true, row: this.changed(next) };
  }

  /** EMAIL-ACCOUNT-CHANGE: the binding becomes a setup on the account signed in now (step key, a new op id, emailKeyRef null), keeping its
   *  username and display name; a 409 inbox_exists is still adopted by the setup step. r3: no saved key is usable at step key (nothing names
   *  it), and the old account's key moves to its retired slot while its retired ref says open sends still need it. */
  private async setUpAgain(row: BindingRow, ref: string): Promise<BindingRow | null> {
    const next = this.store.tx(() => {
      const moved = this.store.casBinding(row.botId, row.revision, { state: "provisioning", step: "key", opId: this.newId(), opStartedAt: this.now(), inboxId: null, address: null, emailKeyRef: null, fluxAccountId: null, failure: null, closingUntil: null }, this.now());
      if (!moved) return null;
      this.store.clearCursor(`${SETUP_BUDGET_SCOPE}${row.botId}`);
      this.store.setCursor(`${SETUP_ACCOUNT_SCOPE}${row.botId}`, JSON.stringify({ ownerRef: ref }), this.now());
      this.clearInboxOwner(row.botId);
      return moved;
    });
    if (!next) return this.store.getBinding(row.botId);
    this.saveBotKey(row.botId, null);
    return this.advance(row.botId);
  }

  // ---- EMAIL-ACCOUNT-CHANGE r3: key truth (designs/EMAIL-ACCOUNT-CHANGE-r3.md) ----

  /** The key the database names for the binding's own inbox (emailKeyRef), when the secret file holds it in either slot; null otherwise. */
  private heldKey(row: BindingRow): FluxCredential | null {
    return row.emailKeyRef ? this.options.secrets.findBotKey(row.botId, row.emailKeyRef, row.inboxId) : null;
  }

  /** Every bot-slot write: a key there that a retired ref names moves to that inbox's retired slot first, in the same save. */
  private saveBotKey(botId: string, cred: FluxCredential | null): void {
    this.options.secrets.replaceBotKey(botId, cred, retiredRefs(this.store, botId));
  }

  /** The freeze, in the caller's transaction: the binding's inbox is on an account the owner left, so its key becomes the retired ref for
   *  that inbox. Its open sends are read with that key from now on and nothing more goes out on them (retired-keys.ts isFrozen). */
  private freeze(row: BindingRow): void {
    if (!row.inboxId || !row.emailKeyRef) return;
    const refs = retiredRefs(this.store);
    if (refs.some(ref => ref.botId === row.botId && ref.inboxId === row.inboxId)) return;
    writeRetiredRefs(this.store, [...refs, { botId: row.botId, inboxId: row.inboxId, keyId: row.emailKeyRef }], this.now());
  }

  /** The settle (boot and the tick): a retired ref goes once no open send is left on its inbox, then its retired slot; a retired slot no
   *  ref names is dropped (refs are written before slots, so that is only a crash leftover). Never throws. */
  settleRetiredKeys(): void {
    try {
      const refs = retiredRefs(this.store);
      const kept = refs.filter(ref => this.store.sendsOfBot(ref.botId, OPEN_SEND_STATES).some(send => send.inboxId === ref.inboxId));
      if (kept.length !== refs.length) this.store.tx(() => writeRetiredRefs(this.store, kept, this.now()));
      for (const botId of this.options.secrets.prevBotIds()) this.settlePrev(botId);
      for (const inboxId of this.options.secrets.retiredInboxes()) {
        const held = this.options.secrets.retiredKey(inboxId);
        if (held && !kept.some(ref => ref.inboxId === inboxId && ref.botId === held.botId && ref.keyId === held.keyId)) this.options.secrets.dropRetired(inboxId, held.keyId);
      }
    } catch { /* the next tick settles it */ }
  }

  /** r4 section 2: a prev slot with no rotation intent goes once no ref names its key (a retired ref's key moves to its retired slot first). */
  private settlePrev(botId: string): void {
    const prev = this.options.secrets.prevKey(botId);
    if (!prev || this.rotation(botId)) return;
    if (this.store.getBinding(botId)?.emailKeyRef === prev.keyId) return;
    this.options.secrets.dropPrev(botId, prev.keyId, retiredRefs(this.store, botId));
  }

  /** The heal (boot and the tick): a live binding whose saved key is not the one the database names (a crash lost a save, or a commit).
   *  First the saved key itself: when Flux accepts it for this inbox (#5) it is this bot's key on this account, and the ref takes its id.
   *  Otherwise a fresh key: the intent first (a crash replays the same op inside 24 h), #5 checks it, save, then the ref. Paced per bot. */
  async healKeys(): Promise<void> {
    for (const row of this.store.bindings()) {
      if (!row.inboxId || !HEAL_STATES.has(row.state) || this.rotation(row.botId) || this.now() < (this.healRetries.get(row.botId)?.at ?? 0)) continue;
      const saved = this.options.secrets.botKey(row.botId);
      if (!saved || this.heldKey(row)) { this.healRetries.delete(row.botId); continue; }
      const healed = await this.healKey(row, saved).catch(() => false);
      if (healed) { this.healRetries.delete(row.botId); continue; }
      const tries = (this.healRetries.get(row.botId)?.tries ?? 0) + 1;
      this.healRetries.set(row.botId, { tries, at: this.now() + SETUP_RETRY_MS[Math.min(tries, SETUP_RETRY_MS.length) - 1]! });
    }
  }

  private async healKey(row: BindingRow, saved: FluxCredential): Promise<boolean> {
    const inboxId = row.inboxId!;
    const retired = new Set(retiredRefs(this.store, row.botId).map(ref => ref.keyId));
    if (!retired.has(saved.keyId) && !this.staleKeys(row.botId).includes(saved.keyId)) {
      const asIs = await this.options.client.getInbox({ kind: "candidate", credential: { token: saved.token, keyId: saved.keyId } }, inboxId);
      if (asIs.kind === "ok") return this.commitHealed(row, saved.keyId);
    }
    const scope = REKEY_SCOPE + row.botId;
    let intent: { opId: string; at: number; ownerRef: string } | null = null;
    try { const value = JSON.parse(this.store.getCursor(scope) ?? "null") as { opId?: unknown; at?: unknown; ownerRef?: unknown } | null; if (value && typeof value.opId === "string" && typeof value.at === "number" && typeof value.ownerRef === "string" && value.ownerRef) intent = { opId: value.opId, at: value.at, ownerRef: value.ownerRef }; } catch { intent = null; }
    // r4 section 4: a heal is a run start; an intent with no owner record (or one the owner has since left) is replaced, never reused
    const current = this.ownerRef();
    if (!current) return false;
    if (!intent || intent.ownerRef !== current || this.now() - intent.at >= KEY_IDEMPOTENCY_WINDOW_MS) { intent = { opId: this.newId(), at: this.now(), ownerRef: current }; this.store.setCursor(scope, JSON.stringify(intent), this.now()); }
    const minted = await this.options.client.mintBotKey({ botId: row.botId }, keyIdempotencyKey(this.options.installId, intent.opId), intent.ownerRef);
    if (minted.kind !== "ok" || !minted.body.key || !minted.body.key_id || !this.sameOwner(minted, intent.ownerRef)) return false;
    const fresh = { token: minted.body.key, keyId: minted.body.key_id };
    const check = await this.options.client.getInbox({ kind: "candidate", credential: fresh }, inboxId);
    if (check.kind !== "ok") return false;
    const latest = this.store.getBinding(row.botId);
    if (!latest || latest.inboxId !== inboxId || !HEAL_STATES.has(latest.state)) return false;
    this.saveBotKey(row.botId, fresh);
    return this.commitHealed(latest, fresh.keyId);
  }

  private async commitHealed(row: BindingRow, keyId: string): Promise<boolean> {
    const owner = this.ownerRef();
    if (!await this.options.secrets.whenDurable(keyId, KEY_DURABLE_WAIT_MS) || !await this.options.secrets.durable() || this.ownerRef() !== owner) return false;
    return this.store.tx(() => {
      const latest = this.store.getBinding(row.botId);
      if (!latest || latest.inboxId !== row.inboxId) return false;
      if (!this.store.casBinding(row.botId, latest.revision, { emailKeyRef: keyId }, this.now())) return false;
      this.store.clearCursor(REKEY_SCOPE + row.botId);
      return true;
    });
  }

  /** EMAIL-ACCOUNT-CHANGE: the owner key changed (Flux refused the event cursor for it). Each binding with an inbox reads #5 with the new
   *  owner token; an inbox this account does not hold (404 inbox_not_found, nothing less) moves the binding to restored_unverified
   *  (account_changed) and withdraws its sends that never reached Flux. Then adoptAccountChanged runs. False when a #5 read got no clear
   *  answer or the adoption did not finish, so the caller keeps its cursor and its pending mark and tries again. */
  async checkAccount(): Promise<boolean> {
    let complete = true;
    for (const row of this.store.bindings()) {
      if (!row.inboxId || !ACCOUNT_CHECKED_STATES.has(row.state)) continue;
      // r6: the owner #5 read is proveOwner (a proven row costs no call here: its record already names this owner and inbox)
      if ((await this.proveOwner(row.botId, true).catch(() => "held" as const)) === "held") complete = false;
    }
    const adopted = await this.adoptAccountChanged().catch(() => false);
    return complete && adopted;
  }

  /** EMAIL-ACCOUNT-CHANGE: every binding the account change left behind adopts its bot's inbox on this account, when there is one (no
   *  charge). One without stays on Reconnect, which sets it up again. False when the list or a key mint got no answer: the reader's
   *  pending mark (event-reader ACCOUNT_RECONCILE_SCOPE) keeps it, and the tick and the next boot run it again. */
  async adoptAccountChanged(): Promise<boolean> {
    const waiting = this.store.bindings().filter(row => row.state === "restored_unverified" && row.failure === ACCOUNT_CHANGED);
    if (!waiting.length) return true;
    // r5: a new act; it records the owner ref at its own start and carries it on every call
    const ref = this.ownerRef();
    if (!ref) return false;
    const listed = await this.options.client.listInboxes({ kind: "owner", expectOwnerRef: ref });
    if (listed.kind !== "ok" || !this.sameOwner(listed, ref)) return false;
    let complete = true;
    for (const row of waiting) {
      const inbox = (listed.body.data ?? []).find(item => item.bot_id === row.botId && item.state !== "deleted");
      if (!inbox) continue;
      const adopted = await this.oneReconnect(row.botId, () => {
        const latest = this.store.getBinding(row.botId);
        return latest?.state === "restored_unverified" && latest.failure === ACCOUNT_CHANGED ? this.adoptInbox(row.botId, inbox, ref) : Promise.resolve({ ok: true as const, row: latest });
      });
      if (!adopted.ok) complete = false;
    }
    return complete;
  }

  // ---- removal (2.6; restore-park r3.1 section 2) ----

  /** Owner Remove on the bot's section: a live binding is authorized `owner` (removing at once: sends refused, open cards withdrawn, then DELETE #7); a binding or
   *  intent a restore parked is authorized with the `park` authority, which keeps the park's provenance. Keep always wins: a Keep in flight answers keep_pending. */
  async remove(botId: string, parkRev?: number): Promise<BindingRow | TombstoneRow | null> {
    const park = this.store.getPark(botId);
    const auth = this.gate.authorize(park ? { kind: "park", botId, by: "bot_section", ...(parkRev !== undefined ? { parkRev } : {}) } : { kind: "owner", botId });
    if (isGateRefusal(auth)) { if (auth.code === "keep_pending" || auth.code === "confirm_expired") throw new RemovalRefused(auth.code); return this.store.getBinding(botId); }
    const before = this.store.getBinding(botId);
    if (park && before?.inboxId && !this.provenRef(before)) {
      await this.proveOwner(botId, true);
      const checked = this.store.getBinding(botId);
      if (!checked || !this.provenRef(checked)) return checked;
    }
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
      const ref = this.provenRef(start);
      const read = ref ? await this.options.client.getInbox({ kind: "owner", expectOwnerRef: ref }, start.inboxId) : HELD_OUTCOME;
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
      const read = answer.kind === "refused" ? null : await this.options.client.getInbox({ kind: "owner", expectOwnerRef: this.ownerRef() ?? "" }, park.inboxId);
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
    if (!this.provenRef(row)) await this.proveOwner(botId, true);
    const currentRow = this.store.getBinding(botId);
    const ref = currentRow && sameBinding(currentRow, row) ? this.provenRef(currentRow) : null;
    // The operation id is durable while its result is uncertain. Revisions can repeat after an archive restore,
    // so a new owner operation must mint a new id rather than derive it from the binding revision.
    const scope = `live-keep-restore:${JSON.stringify([botId, row.inboxId, row.opId])}`;
    const restoreId = this.store.tx(() => {
      const pending = this.store.getCursor(scope);
      if (pending) return pending;
      const id = `keep:${this.options.installId}:${this.newId()}`;
      this.store.setCursor(scope, id, this.now());
      return id;
    });
    const answer = await this.options.client.restoreInbox(row.inboxId, botId, restoreId, ref ?? "");
    if (answer.kind !== "ok") {
      if (answer.kind !== "uncertain") this.store.setCursor(scope, "", this.now());
      return ownerActFailure(answer);
    }
    const latest = this.store.getBinding(botId);
    if (!latest) { this.store.setCursor(scope, "", this.now()); return { ok: true, row: null }; }
    // M4: a binding the restore touched keeps that provenance (step "restored") through Remove and Keep: it returns to Reconnect, never to active
    const state: BindingState = latest.step === "restored" ? "restored_unverified" : answer.body.state === "paused" ? "paused" : "active";
    return { ok: true, row: this.changed(this.store.tx(() => {
      this.store.setCursor(scope, "", this.now());
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
    const answer = await this.options.client.restoreInbox(claim.inboxId, claim.botId, `guard:${this.options.installId}:${claim.keepOp}`, this.ownerRef() ?? "");
    if (answer.kind === "uncertain") return false; // no answer: the claim stays and the tick sends the RESTORE again
    this.store.deleteKeepClaim(claim.inboxId);
    if (answer.kind === "refused") { this.ops("guard_refused", claim, `Flux refused the guard restore (${String(answer.code).replace(/[^\w.]/g, "").slice(0, 40)}).`, null); return false; }
    return true;
  }

  /** r3.4d runtime invariant (park.refused_kept, reducer parkBinding line 108): judged unreachable, so if it is ever reached it is never silent. One ops line per binding and process; data is kept and nothing changes. */
  private readonly refusedKeptSeen = new Set<string>();
  private opsRefusedKept(row: BindingRow): void {
    const id = row.inboxId ?? "";
    const seen = `${row.botId}:${id}:${row.emailKeyRef ?? ""}`;
    if (this.refusedKeptSeen.has(seen)) return;
    this.refusedKeptSeen.add(seen);
    const line: OpsLine = { kind: "park_refused_kept", botId: row.botId, gen: { inboxId: id, keyRef: row.emailKeyRef ?? null }, text: "A removing binding has no recorded authority and its key was kept. Murage did not park it and kept all data.", window: { closingSinceMs: this.now(), restoredAtMs: null } };
    try { this.options.onOps?.(line); } catch { /* an alert never decides a restore */ }
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
      const read = await this.options.client.getInbox({ kind: "owner", expectOwnerRef: this.ownerRef() ?? "" }, guard.inboxId).catch(() => null);
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
      const ownerRef = this.ownerRef();
      if (!ownerRef) return back("owner_required", 403);
      let read = await this.options.client.getInbox({ kind: "owner", expectOwnerRef: ownerRef }, park.inboxId);
      if (read.kind === "ok") {
        if (!this.sameOwner(read, ownerRef)) return back("owner_changed", 409);
        const binding = this.store.getBinding(botId);
        if (binding?.inboxId === park.inboxId) this.writeInboxOwner(botId, park.inboxId, ownerRef);
      }
      if (read.kind === "refused" && (read.status === 404 || read.code === "inbox_not_found")) return gone();
      if (read.kind !== "ok") { const f = ownerActFailure(read); return back(f.code, f.status); }
      if (read.body.state === "deleted") return gone();
      if (read.body.state === "closing") {
        const restored = await this.options.client.restoreInbox(park.inboxId, botId, `keep:${this.options.installId}:${keepOp}`, ownerRef);
        if (!(restored.kind === "refused" && restored.code === "not_closing") && restored.kind !== "ok") { const f = ownerActFailure(restored); return back(f.code, f.status); }
        // A replayed restore outcome describes its original commit, not the inbox now.
        // Confirm after both success and not_closing before consuming the durable Keep claim.
        read = await this.options.client.getInbox({ kind: "owner", expectOwnerRef: ownerRef }, park.inboxId);
        if (read.kind === "refused" && (read.status === 404 || read.code === "inbox_not_found")) return gone();
        if (read.kind !== "ok") { const f = ownerActFailure(read); return back(f.code, f.status); }
        if (read.body.state === "deleted") return gone();
        if (read.body.state !== "active" && read.body.state !== "paused") return back("unavailable", 503);
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
    if (ours && retiredRefs(this.store, start.botId).some(ref => ref.keyId === ours.keyId)) { this.saveBotKey(start.botId, null); keyEnded = false; }
    else if (ours) {
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
      this.clearInboxOwner(start.botId);
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
        if (this.store.isKeptKey(row.emailKeyRef)) { this.options.onRefusal?.("park_refused_kept"); this.opsRefusedKept(row); continue; }
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
    const ref = this.provenRef(row);
    if (!ref) return this.store.getBinding(botId);
    const answer = await this.options.client.setSendPolicy(row.inboxId, intent.policy, ref);
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
    // r5 U2: an intent from before the upgrade (no owner record) is settled from local state first; it never mints or revokes
    const legacy = this.rotation(botId);
    if (legacy && !legacy.ownerRef) { const settled = await this.settleLegacyRotation(botId); if (!settled.ok) return settled; }
    // r4 section 2: no rotation starts while the prev slot holds a key (settle drops one no ref names; a live-named one blocks)
    if (!this.rotation(botId)) { this.settlePrev(botId); if (this.options.secrets.prevKey(botId)) return { ok: false, code: "unavailable" }; }
    // r4 section 4: a rotation is a run start; it records the owner ref signed in now
    const ref = this.ownerRef();
    if (!ref) return { ok: false, code: "owner_required" };
    const old = this.options.secrets.botKey(botId);
    const intent = this.rotation(botId) ?? { oldKeyId: old?.keyId ?? null, opId: this.newId(), at: this.now(), ownerRef: ref };
    this.store.setCursor(ROTATE_SCOPE + botId, JSON.stringify(intent), this.now());
    return this.finishRotation(botId, intent);
  }

  private rotation(botId: string): { oldKeyId: string | null; opId: string; at: number; ownerRef?: string } | null {
    const raw = this.store.getCursor(ROTATE_SCOPE + botId);
    if (!raw) return null;
    try { const value = JSON.parse(raw) as { oldKeyId?: unknown; opId?: unknown; at?: unknown; ownerRef?: unknown }; return typeof value.opId === "string" ? { oldKeyId: typeof value.oldKeyId === "string" ? value.oldKeyId : null, opId: value.opId, at: typeof value.at === "number" ? value.at : 0, ...(typeof value.ownerRef === "string" && value.ownerRef ? { ownerRef: value.ownerRef } : {}) } : null; } catch { return null; }
  }

  /** r5 U2: a rotation intent with no owner record (the int/1019 shape) settles from local state plus one bot-kind proof. No owner-kind call:
   *  it never mints and never revokes (a key the old run minted and never saved is a stray). */
  private async settleLegacyRotation(botId: string): Promise<{ ok: true } | { ok: false; code: string }> {
    const stored = this.options.secrets.botKey(botId);
    const bound = this.store.getBinding(botId);
    const clear = (): { ok: true } => { this.store.clearCursor(ROTATE_SCOPE + botId); return { ok: true }; };
    if (!stored || !bound?.inboxId || stored.keyId === bound.emailKeyRef) return clear();
    // the slot holds a key the binding does not name (K2) and the named key (K1) is not on disk: K2 is proved by the inbox itself (#5, a
    // candidate credential, no charge). An old account's key a cancel stale-listed is never proved this way.
    if (this.staleKeys(botId).includes(stored.keyId)) return clear();
    if (this.heldKey(bound)) return clear();
    const check = await this.options.client.getInbox({ kind: "candidate", credential: { token: stored.token, keyId: stored.keyId } }, bound.inboxId);
    if (check.kind === "ok") {
      const latest = this.store.getBinding(botId);
      if (latest && latest.inboxId === bound.inboxId) this.store.casBinding(botId, latest.revision, { emailKeyRef: stored.keyId }, this.now());
      return clear();
    }
    if (check.kind === "refused" && check.status === 404) return clear();
    return { ok: false, code: "unavailable" };
  }

  private async finishRotation(botId: string, intent: { oldKeyId: string | null; opId: string; at: number; ownerRef?: string }): Promise<{ ok: true } | { ok: false; code: string }> {
    // r5 F2: the first statement. No owner record: local settle only.
    if (!intent.ownerRef) return this.settleLegacyRotation(botId);
    const ownerRef = intent.ownerRef;
    // r4 section 4: the owner credential is no longer the one this rotation started on: the intent ends and no key is touched
    const nowRef = this.ownerRef();
    if (nowRef !== null && nowRef !== ownerRef) { this.store.clearCursor(ROTATE_SCOPE + botId); return { ok: false, code: ACCOUNT_CHANGED }; }
    const stored = this.options.secrets.botKey(botId);
    const bound = this.store.getBinding(botId);
    let generation = bound;
    const current = (): boolean => {
      const latest = this.store.getBinding(botId);
      return !!generation && !!latest && LIVE_BINDING_STATES.has(latest.state) && sameBinding(latest, generation)
        && this.rotation(botId)?.opId === intent.opId;
    };
    if (!current()) return { ok: false, code: "not_active" };
    // EMAIL-ACCOUNT-CHANGE r3: a saved new key the binding does not name yet (a crash after the save, before the commit) is checked with #5
    // as a candidate; accepted, the ref takes its id, at any age (past 24 h a replay could not return it)
    if (stored && stored.keyId !== intent.oldKeyId && bound?.inboxId && stored.keyId !== bound.emailKeyRef && !this.staleKeys(botId).includes(stored.keyId)) {
      const check = await this.options.client.getInbox({ kind: "candidate", credential: { token: stored.token, keyId: stored.keyId } }, bound.inboxId);
      if (!current()) return { ok: false, code: "not_active" };
      if (check.kind !== "ok") return { ok: false, code: check.kind === "refused" ? check.code : "unavailable" };
      // r4 section 2: the ref names a key only once the shell has acked it by key id; the old key is still on disk in the prev slot
      if (!await this.options.secrets.whenDurable(stored.keyId, KEY_DURABLE_WAIT_MS)) return { ok: false, code: "unavailable" };
      if (!await this.options.secrets.durable()) return { ok: false, code: "save_pending" };
      if (!current()) return { ok: false, code: "not_active" };
      const latest = this.store.getBinding(botId)!;
      generation = this.store.casBinding(botId, latest.revision, { emailKeyRef: stored.keyId }, this.now());
      if (!generation) return { ok: false, code: "not_active" };
    }
    if (!stored || stored.keyId === intent.oldKeyId) {
      // the new key is not saved yet: the same op id returns the same key inside Flux's 24 h window
      if (this.now() - intent.at >= KEY_IDEMPOTENCY_WINDOW_MS) { this.store.clearCursor(ROTATE_SCOPE + botId); return { ok: false, code: "rotation_expired" }; }
      const minted = await this.options.client.mintBotKey({ botId }, keyIdempotencyKey(this.options.installId, intent.opId), ownerRef);
      if (botKeysDark(minted)) return { ok: false, code: "email_dark" };
      if (minted.kind !== "ok" || !minted.body.key || !minted.body.key_id) return { ok: false, code: minted.kind === "refused" ? minted.code : "unavailable" };
      if (!this.sameOwner(minted, ownerRef)) { this.store.clearCursor(ROTATE_SCOPE + botId); return { ok: false, code: ACCOUNT_CHANGED }; }
      if (!current()) return { ok: false, code: "not_active" };
      const row = this.store.getBinding(botId);
      if (!row?.inboxId) return { ok: false, code: "not_active" };
      this.noteMinted(botId, minted.body.key_id);
      const check = await this.options.client.getInbox({ kind: "candidate", credential: { token: minted.body.key, keyId: minted.body.key_id } }, row.inboxId);
      if (!current()) return { ok: false, code: "not_active" };
      if (check.kind !== "ok") return { ok: false, code: check.kind === "refused" ? check.code : "unavailable" };
      // r4 section 2: one save puts K2 in the bot slot and K1 in the prev slot (the ref still names K1, which stays on disk); wait for K2's ack
      const oldCred = intent.oldKeyId ? this.options.secrets.findBotKey(botId, intent.oldKeyId, row.inboxId) : null;
      this.options.secrets.rotateInto(botId, { token: minted.body.key, keyId: minted.body.key_id }, oldCred, retiredRefs(this.store, botId));
      if (!await this.options.secrets.whenDurable(minted.body.key_id, KEY_DURABLE_WAIT_MS)) return { ok: false, code: "unavailable" };
      if (!await this.options.secrets.durable()) return { ok: false, code: "save_pending" };
      // step 5 re-check: binding live, owner unchanged, the binding still names K1. Otherwise the intent ends and no key is touched.
      if (!current()) return { ok: false, code: "not_active" };
      const latest = this.store.getBinding(botId);
      const ref5 = this.ownerRef();
      if (!latest?.inboxId || !LIVE_BINDING_STATES.has(latest.state) || (ref5 !== null && ref5 !== ownerRef) || (intent.oldKeyId !== null && latest.emailKeyRef !== intent.oldKeyId)) { this.store.clearCursor(ROTATE_SCOPE + botId); return { ok: false, code: ACCOUNT_CHANGED }; }
      generation = this.store.casBinding(botId, latest.revision, { emailKeyRef: minted.body.key_id }, this.now());
      if (!generation) return { ok: false, code: "not_active" };
    }
    // the new key is saved: the old one is revoked (404 = already gone); until then the intent stays for the next boot. r3: only once the
    // binding names the new key and the shell has it on disk, so a crash can never leave only a revoked key
    const kept = this.options.secrets.botKey(botId);
    if (intent.oldKeyId && intent.oldKeyId !== kept?.keyId) {
      if (!kept || this.store.getBinding(botId)?.emailKeyRef !== kept.keyId || !await this.options.secrets.whenDurable(kept.keyId, KEY_DURABLE_WAIT_MS) || !await this.options.secrets.durable()) return { ok: false, code: "revoke_pending" };
      if (!current()) return { ok: false, code: "not_active" };
      const revoked = await this.gate.revokeKey({ kind: "rotate", botId, oldKeyId: intent.oldKeyId, rotateOp: intent.opId }, intent.oldKeyId);
      if (isGateRefusal(revoked)) return { ok: false, code: "revoke_pending" };
      if (!(revoked.kind === "ok" || (revoked.kind === "refused" && revoked.status === 404 && !botKeysDark(revoked)))) return { ok: false, code: "revoke_pending" };
    }
    if (!current()) return { ok: false, code: "not_active" };
    // the old key is gone: one save drops the prev slot, then the intent ends
    this.options.secrets.dropPrev(botId, undefined, retiredRefs(this.store, botId));
    this.store.clearCursor(ROTATE_SCOPE + botId);
    return { ok: true };
  }

  // ---- account change (section 8) ----

  /** The account a #28 event names. A binding made under another account moves to restored_unverified (no polling, tools or sends) with
   * failure account_changed, its sends that never reached Flux withdrawn (in-flight ones keep their rows); adoptAccountChanged then
   * adopts this account's inbox for the bot, or leaves it on Reconnect. A binding without an account records it. */
  noteAccount(accountId: string, usedOwnerRef?: string): BindingRow[] {
    const moved: BindingRow[] = [];
    for (const row of this.store.bindings()) {
      if (row.fluxAccountId === accountId) continue;
      // r5 F3: ownership is never filled in from the present on a row with no inbox (a setup or failed row): only a row with an inbox proves it
      // r6 F3: a null account id is stamped only on a row whose owner record is the credential that read this batch; provisioning, failed and held rows are skipped
      if (row.fluxAccountId === null) { if (row.inboxId && usedOwnerRef && this.inboxRecord(row.botId)?.ownerRef === usedOwnerRef && this.inboxRecord(row.botId)?.inboxId === row.inboxId) this.store.casBinding(row.botId, row.revision, { fluxAccountId: accountId }, this.now()); continue; }
      if (row.state === "removing" || row.state === "remove_requested" || row.state === "removal_parked" || row.state === "restored_unverified") continue;
      // r3: the freeze is written with the move (the caller's transaction, event-reader pollOnce)
      const next = this.store.casBinding(row.botId, row.revision, { state: "restored_unverified", failure: ACCOUNT_CHANGED, fluxAccountId: accountId }, this.now());
      if (next) { this.freeze(row); this.clearInboxOwner(row.botId); }
      if (next) { this.options.withdrawUndispatched?.(row.botId); moved.push(next); this.changed(next); }
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
