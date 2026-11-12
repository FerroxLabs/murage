// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RemovalGate: the single authorization point for every remote removal (restore-park r3.1 section 2). Binding state `removing` is an OUTPUT of
// authorize(), never an input a caller can set; deleteInbox and revokeKey re-validate the authority in a transaction on fresh rows before the transport
// is touched. A removal a restore parked is refused here whatever a stale caller thinks it holds (a park row, and a `removal_parked` binding as the second
// durable witness), except with the owner's own `park` authority or the orphan Keep's `orphan-key`.
import type { EmailSecretStore } from "./email-secrets.ts";
import type { BindingRow, EmailStore, ParkRow } from "./email-store.ts";
import type { FluxOutcome } from "./flux-email-client.ts";
import { createRemovalTransport, type RemovalTransport } from "./removal-transport.ts";

export type Authority =
  | { kind: "intent"; botId: string; inboxId: string; intentRev: number }
  | { kind: "owner"; botId: string; gen: { inboxId: string | null; opId: string | null; keyRef: string | null } }
  | { kind: "park"; botId: string; parkId: string; parkRev: number }
  | { kind: "orphan-key"; botId: string; parkId: string; parkRev: number; keyId: string }
  | { kind: "rotate"; botId: string; oldKeyId: string; rotateOp: string }
  /** r3.2i on int2: Reconnect's delete of a stray live key this home minted (409 bot_key_exists); holds only while that Reconnect op is current on a restored binding. */
  | { kind: "stray"; botId: string; keyId: string; reconnectOp: string }
  | { kind: "foreign"; inboxId: string };

export type AuthorizeRequest =
  | { kind: "intent"; botId: string; inboxId: string; intentRev: number }
  | { kind: "owner"; botId: string }
  | { kind: "park"; botId: string; parkId?: string; parkRev?: number; by: "bot_section" | "orphan" | "bot_delete" }
  /** The resumer: the owner already chose Remove after the restore; the authority comes from the fresh row. */
  | { kind: "park-resume"; botId: string };

export type GateRefusalCode = "removal_parked" | "authority_gone" | "keep_pending" | "confirm_expired" | "removing_unrecorded" | "restore_finishing";
export interface GateRefusal { kind: "gate_refused"; code: GateRefusalCode }
export type GateAnswer = FluxOutcome<Record<string, unknown>> | GateRefusal;
export type Authorized = { authority: Authority; start: BindingRow | null; changed: boolean } | GateRefusal;
export const isGateRefusal = (value: unknown): value is GateRefusal => Boolean(value) && typeof value === "object" && (value as { kind?: unknown }).kind === "gate_refused";

export interface RemovalGateOptions {
  store: EmailStore;
  client?: Parameters<typeof createRemovalTransport>[0];
  transport?: RemovalTransport;
  secrets: EmailSecretStore;
  /** True while the bot is on this install (an orphan Keep's key release needs it gone). */
  botExists?: (botId: string) => boolean;
  now?: () => number;
  /** True while a restore job is open (restore-job.ts): no removal is authorized or run, whatever authority a caller holds. */
  restoreWindow?: () => boolean;
}

const refused = (code: GateRefusalCode): GateRefusal => ({ kind: "gate_refused", code });
const REMOVING = new Set(["removing", "remove_requested"]);
const sameGen = (row: BindingRow, gen: { inboxId: string | null; opId: string | null; keyRef: string | null }) => row.inboxId === gen.inboxId && row.opId === gen.opId && row.emailKeyRef === gen.keyRef;
/** A park row's generation: the binding it parked (setup op and inbox), when a binding is still there. */
const parkOwnsBinding = (park: ParkRow, row: BindingRow) => (park.bindingOpId === null || row.opId === park.bindingOpId) && (park.inboxId === null || row.inboxId === park.inboxId);

export class RemovalGate {
  private readonly transport: RemovalTransport;
  private readonly now: () => number;
  private readonly options: RemovalGateOptions;
  constructor(options: RemovalGateOptions) {
    this.options = options;
    this.transport = options.transport ?? createRemovalTransport(options.client!);
    this.now = options.now ?? Date.now;
  }
  private get store() { return this.options.store; }
  private parkNaming(botId: string, inboxId: string | null): ParkRow | null { return this.store.getPark(botId) ?? (inboxId ? this.store.parkByInbox(inboxId) : null); }

  /** The only code that writes binding state 'removing', and the only code that moves a park to remove_authorized. Validates and transitions in one transaction. */
  authorize(request: AuthorizeRequest): Authorized {
    return this.store.tx((): Authorized => {
      if (this.options.restoreWindow?.()) return refused("restore_finishing");
      const now = this.now();
      const binding = this.store.getBinding(request.botId);
      if (request.kind === "intent") {
        const code = this.check({ kind: "intent", botId: request.botId, inboxId: request.inboxId, intentRev: request.intentRev }, "authorize");
        if (code) return refused(code);
        return this.toRemoving({ kind: "intent", botId: request.botId, inboxId: request.inboxId, intentRev: request.intentRev }, binding, now);
      }
      if (request.kind === "owner") {
        if (!binding) return refused("authority_gone");
        if (this.store.getKeepClaim(binding.inboxId)) return refused("keep_pending"); // r3.4d (reducer ownerRemove line 225): a Keep in flight on the target wins
        const authority: Authority = { kind: "owner", botId: request.botId, gen: { inboxId: binding.inboxId, opId: binding.opId, keyRef: binding.emailKeyRef } };
        const code = this.check(authority, "authorize");
        return code ? refused(code) : this.toRemoving(authority, binding, now);
      }
      // park / park-resume: the owner's Remove after a restore
      const park = this.store.getPark(request.botId);
      if (!park) return refused("authority_gone");
      if (park.state === "keep_pending") return refused("keep_pending");
      if (request.kind === "park") {
        // r3.4d: the owner's token names a park_rev; a stale one is expired (reducer tokenInfo, restore-reducer.ts line 66: kind p with a different parkRev -> "expired" -> confirm_expired)
        if (request.parkRev !== undefined && request.parkRev !== park.parkRev) return refused("confirm_expired");
        if ((park.state !== "parked" && park.state !== "parked_evidence") || (request.parkId !== undefined && request.parkId !== park.parkId)) return refused("authority_gone");
        const authorized = this.store.casPark(park.botId, park.parkRev, { state: "remove_authorized", authorizedBy: request.by, authorizedAt: now });
        if (!authorized) return refused("authority_gone");
        // the owner chose Remove: the bot's non-removed intents are committed, the binding of the park's generation is removing
        for (const tomb of this.store.tombstones()) if (tomb.botId === park.botId && tomb.state !== "removed" && !tomb.committed) this.store.casTombstone(tomb.botId, tomb.inboxId, tomb.revision, { committed: true });
        const start = binding && binding.state === "removal_parked" && parkOwnsBinding(park, binding) ? this.store.casBinding(binding.botId, binding.revision, { state: "removing" }, now) : binding;
        this.store.recordRemovingAuthority(park.botId, "park", now);
        return { authority: { kind: "park", botId: park.botId, parkId: park.parkId, parkRev: authorized.parkRev }, start: start ?? null, changed: true };
      }
      if (park.state !== "remove_authorized") return refused("authority_gone");
      return { authority: { kind: "park", botId: park.botId, parkId: park.parkId, parkRev: park.parkRev }, start: binding, changed: false };
    });
  }

  private toRemoving(authority: Authority, binding: BindingRow | null, now: number): Authorized {
    if (!binding) return { authority, start: null, changed: false };
    // r3.4d (reducer ownerRemove line 250, parkUnauthorized line 118): `removing` exists only with the record an authorize wrote; an unrecorded one (legacy, foreign) is parked, never continued
    if (REMOVING.has(binding.state)) return this.store.removingAuthority(binding.botId) ? { authority, start: binding, changed: false } : refused("removing_unrecorded");
    const next = this.store.casBinding(binding.botId, binding.revision, { state: "removing" }, now);
    if (next) this.store.recordRemovingAuthority(binding.botId, authority.kind, now);
    return next ? { authority, start: next, changed: true } : refused("authority_gone");
  }

  /** Validation rules of section 2.2, from fresh rows. `phase` authorize: the binding may still be in its pre-removal state. */
  private check(authority: Authority, phase: "authorize" | "act"): GateRefusalCode | null {
    if (this.options.restoreWindow?.()) return "restore_finishing";
    const store = this.store;
    const binding = authority.kind === "foreign" ? null : store.getBinding(authority.botId);
    if (authority.kind !== "park" && authority.kind !== "orphan-key" && binding?.state === "removal_parked") return "removal_parked";
    if (phase === "act" && binding && REMOVING.has(binding.state) && (authority.kind === "intent" || authority.kind === "owner" || authority.kind === "park") && !store.removingAuthority(binding.botId)) return "removing_unrecorded";
    switch (authority.kind) {
      case "intent": {
        const tomb = store.getTombstone(authority.botId, authority.inboxId);
        if (!tomb || !tomb.committed || !REMOVING.has(tomb.state) || tomb.revision !== authority.intentRev) return "authority_gone";
        if (this.parkNaming(authority.botId, authority.inboxId)) return "removal_parked";
        if (binding && (binding.inboxId ?? "") !== authority.inboxId) return "authority_gone";
        return null;
      }
      case "owner": {
        if (this.parkNaming(authority.botId, binding?.inboxId ?? null)) return "removal_parked";
        if (!binding || !sameGen(binding, authority.gen)) return "authority_gone";
        return phase === "act" && !REMOVING.has(binding.state) ? "authority_gone" : null;
      }
      case "park": {
        const park = store.getPark(authority.botId);
        if (!park || park.parkId !== authority.parkId || park.parkRev !== authority.parkRev || park.state !== "remove_authorized") return "authority_gone"; // r3.4d: park_rev, not only park_id and state
        if (binding && !REMOVING.has(binding.state) && binding.state !== "removal_parked") return "authority_gone";
        if (binding && !parkOwnsBinding(park, binding)) return "authority_gone";
        return null;
      }
      case "orphan-key": {
        const park = store.getPark(authority.botId);
        if (!park || park.parkId !== authority.parkId || park.state !== "key_release" || park.keyId !== authority.keyId) return "authority_gone";
        if (binding || this.options.botExists?.(authority.botId)) return "authority_gone";
        return null;
      }
      case "rotate": {
        if (store.getPark(authority.botId)) return "removal_parked";
        const raw = store.getCursor(`rotate:${authority.botId}`);
        let cursor: { oldKeyId?: unknown; opId?: unknown } | null = null;
        try { cursor = raw ? JSON.parse(raw) : null; } catch { cursor = null; }
        if (!cursor || cursor.opId !== authority.rotateOp || cursor.oldKeyId !== authority.oldKeyId) return "authority_gone";
        if (this.options.secrets.botKey(authority.botId)?.keyId === authority.oldKeyId) return "authority_gone";
        return binding && (["active", "paused", "billing_hold", "grace", "closing"] as string[]).includes(binding.state) ? null : "authority_gone";
      }
      case "stray": {
        if (store.getPark(authority.botId)) return "removal_parked";
        const raw = store.getCursor(`reconnect-op:${authority.botId}`);
        let cursor: { opId?: unknown } | null = null;
        try { cursor = raw ? JSON.parse(raw) : null; } catch { cursor = null; }
        if (!cursor || cursor.opId !== authority.reconnectOp) return "authority_gone";
        if (this.options.secrets.botKey(authority.botId)?.keyId === authority.keyId) return "authority_gone"; // holding never destroys the held key
        return binding?.state === "restored_unverified" ? null : "authority_gone";
      }
      case "foreign":
        return store.bindingByInbox(authority.inboxId) || store.parkByInbox(authority.inboxId) || store.tombstones().some(tomb => tomb.inboxId === authority.inboxId) ? "removal_parked" : null;
    }
  }

  /** DELETE the inbox, only while `authority` still holds. `inboxId` defaults to the binding's, else the park's. */
  async deleteInbox(authority: Authority, start: BindingRow | null, inboxId?: string | null): Promise<GateAnswer> {
    const target = this.store.tx(() => {
      const code = this.check(authority, "act");
      if (code) return refused(code);
      const id = inboxId ?? start?.inboxId ?? (authority.kind === "park" ? this.store.getPark(authority.botId)?.inboxId : authority.kind === "foreign" ? authority.inboxId : null);
      return id ? { id } : refused("authority_gone");
    });
    if (isGateRefusal(target)) return target;
    return this.transport.deleteInbox(target.id);
  }

  /** Revoke a bot key, only while `authority` still holds. */
  async revokeKey(authority: Authority, keyId: string): Promise<GateAnswer> {
    const code = this.store.tx(() => this.check(authority, "act"));
    if (code) return refused(code);
    return this.transport.revokeBotKey(keyId);
  }
}
