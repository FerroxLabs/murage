// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import "../shared/win-hide-child-process.mjs";
import { createHash, randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import { checkedOpenTurns, proposeTurnParents } from "./memory/lineage-write.ts";
import type { LineageRef } from "./memory/lineage-types.ts";
import { RELEASE_CHUNK_MAX, checkReleaseAvailable, reserveRelease, withReleaseBudgets, type ReleaseBudget } from "./memory/release-budget.ts";
import { assertRetainedFence, deferringPendingFence, isPendingFenceDeferral } from "./memory/send-fence.ts";
import { awaitExactPendingCheck, PENDING_FENCE_WAIT_MS } from "./memory/fence-pending.ts";
import { logSwallowedConsumingError } from "./consuming-error-log.ts";
import { TURN_RELEASE_WAIT_MS } from "./turn-release-wait.ts";
import { assertConsumingBinding, assertConsumingDescriptor, emitConsumingTurnResponse, type ConsumingDescriptor, type ConsumingTurnBinding } from "./consuming-turn-response.ts";

export type ProtocolId = string | number;
export const frameDigest = (frame: string) => createHash("sha256").update(frame, "utf8").digest("hex");
export function validProtocolId(id: unknown): id is ProtocolId {
  return typeof id === "string" && id.length > 0 && Buffer.byteLength(id) <= 128 || typeof id === "number" && Number.isSafeInteger(id);
}
export interface RpcFrame { jsonrpc: "2.0"; id?: ProtocolId; method?: string; result?: unknown; error?: unknown; params?: unknown }
/** cause22 caps: the owner's own turn, asked live where a size cap is about to apply (owner-turn-caps.ts). True only when the binding
 * is live and EVERY open turn of it holds an owner-kept release budget (release-budget.ts keepOwner, bound by the two binders in
 * index.ts). Any doubt answers false: the caps of every other turn. */
export function ownerTurnBinding(binding: ConsumingTurnBinding | undefined): boolean {
  if (!binding) return false;
  try {
    const members = checkedOpenTurns(binding.turn);
    return members.length > 0 && members.every(member => member.budget?.ownerKept === true);
  } catch { return false; }
}
/** cause22 caps: upstream bytes of an owner turn are charged in pieces no larger than one release chunk, so a large read is many
 * ordinary charges; every other turn is charged at once, as before. One work unit per raw byte and one per charge. */
function reserveUpstreamBytes(budgets: readonly ReleaseBudget[], bytes: number, owner: boolean): void {
  if (!owner || bytes <= RELEASE_CHUNK_MAX) { reserveRelease(budgets, { bytes, work: bytes + 1 }); return; }
  for (let offset = 0; offset < bytes; offset += RELEASE_CHUNK_MAX) {
    const piece = Math.min(RELEASE_CHUNK_MAX, bytes - offset);
    reserveRelease(budgets, { bytes: piece, work: piece + 1 });
  }
}
/** cause22 caps: the one call of an owner turn that cannot be forwarded (over the 64 MiB ceiling, or too many calls in flight). It is
 * never a seal or a refusal of the turn: the relay answers that call with `line` and carries on. */
export function itemRefusal(line: string, id?: ProtocolId): Error & { code: "OWNER_ITEM_REFUSED"; line: string; id?: ProtocolId } {
  return Object.assign(new Error("OWNER_ITEM_REFUSED"), { code: "OWNER_ITEM_REFUSED" as const, line, ...(id === undefined ? {} : { id }) });
}
export function isItemRefusal(error: unknown): error is Error & { code: "OWNER_ITEM_REFUSED"; line: string; id?: ProtocolId } {
  return (error as { code?: unknown } | null | undefined)?.code === "OWNER_ITEM_REFUSED" && typeof (error as { line?: unknown }).line === "string";
}
/** One complete, bounded frame. No batch, trailing newline, coercion or partial JSON. `max`: 8 MiB, or the owner turn's ceiling. */
export function decodeProxyFrame(text: string): RpcFrame {
  // MAIN-RULING cause22-no-transport-caps: a frame of any size is decoded; only its shape is checked.
  if (typeof text !== "string" || !text || /[\r\n]/.test(text)) throw new Error("MEMORY_CONTEXT_REVOKED");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value) || value.jsonrpc !== "2.0"
    || ("id" in value && !validProtocolId(value.id))) throw new Error("MEMORY_CONTEXT_REVOKED");
  const request = typeof value.method === "string" && value.method.length > 0 && value.method.length <= 256;
  if (request ? "result" in value || "error" in value : !("id" in value) || ("result" in value) === ("error" in value) || "method" in value) throw new Error("MEMORY_CONTEXT_REVOKED");
  return value;
}
export interface ProxyFrame {
  readonly instanceId: string;
  readonly sequence: number;
  readonly frame: string;
  readonly descriptor: ConsumingDescriptor;
  readonly refs: readonly LineageRef[];
}
export interface ReleaseEnvelope { readonly permit: string; readonly instanceId: string; readonly sequence: number; readonly frame: string }
export interface IngressDestination {
  /** Called before the gate. Resolves only when synchronous acceptance is possible. */
  capacity(): Promise<void>;
  write(frame: string): void;
}

/** One server-owned instance, one outstanding permit. Neither stdout nor a verdict
 * is engine authority. All errors permanently seal, even when a caller catches. */
/** `ownerToolExchange` (1.0.22 userbug-sealed): this instance carries the turn's tool exchange through the release door and the relay
 * (createProxyReleaseAuthority().register). Its requests, permits and replies may take the owner rule for held context still
 * checking:pending (send-fence.ts ownerHeldPendingProposal); any other ingress (the own-server VPS relay) keeps the refusal. */
export function createConsumingIngress(binding: ConsumingTurnBinding, instanceId: string, ownerToolExchange = false) {
  let issued = 0, delivered = 0, sealed = false, retired = false, ledgerRefused = false;
  const requests = new Set<string>();
  const serverRequests = new Set<string>();
  const key = (id: ProtocolId) => JSON.stringify([typeof id, id]);
  const owner = () => ownerTurnBinding(binding);
  let pending: { permit: string; sequence: number; digest: string; revisions: readonly number[]; refs: readonly LineageRef[]; descriptor: ConsumingDescriptor; rpc: RpcFrame; deadline: ReturnType<typeof setTimeout> } | undefined;
  const seal = (memoryRefusal = true) => {
    if (sealed || retired) return;
    sealed = true; ledgerRefused = memoryRefusal;
    if (pending) clearTimeout(pending.deadline);
    pending = undefined; requests.clear(); serverRequests.clear();
    if (memoryRefusal) {
      try { binding.onLedgerRefused({ state: "checking", reason: "not-built" }); } catch { /* sealed before teardown; no fallback */ }
    }
  };
  // cause22 r2: when the check that failed was the turn's own release budget, its fixed verdict travels with the rejection (and only that
  // verdict), so the door answers with the budget line instead of "context is no longer available".
  const budgetFence = (error: unknown) => {
    const fence = (error as { fence?: { state?: unknown; reason?: unknown } } | null | undefined)?.fence;
    return fence?.state === "checking" && fence.reason === "retained-budget" ? { fence: { state: "checking", reason: "retained-budget" } as const } : {};
  };
  const reject = (cause?: unknown): never => { seal(); throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" }, budgetFence(cause)); };
  const guarded = <T>(work: () => T, entered: () => boolean = () => false, site = "ingress"): T => {
    const open = !sealed && !retired;
    try { if (sealed || retired) reject(); assertConsumingBinding(binding); return work(); }
    catch (error) {
      // 1.0.20 revkill: a request still being checked released nothing; it neither seals this instance nor refuses the turn.
      if (!entered() && isPendingFenceDeferral(error)) throw error;
      // cause22 caps: one call of an owner turn that cannot be forwarded is answered by the relay; nothing is sealed or refused.
      if (!entered() && isItemRefusal(error)) throw error;
      // The first error that seals this instance is the only evidence of why a turn sealed.
      if (open) logSwallowedConsumingError(`${site}${entered() ? ":entered" : ""}`, error);
      if (entered()) { seal(false); throw error; }
      return reject(error);
    }
  };
  const api = Object.freeze({
    identity: Object.freeze({ ...binding.identity, lineageTurnIds: Object.freeze([...binding.identity.lineageTurnIds]), proxyInstanceId: instanceId }),
    get sealed() { return sealed; },
    get ledgerRefused() { return ledgerRefused; },
    get retired() { return retired; },
    retire(): void {
      retired = true;
      if (pending) clearTimeout(pending.deadline);
      pending = undefined; requests.clear(); serverRequests.clear();
    },
    /** MAIN-RULING cause22-no-transport-caps: whether `id` is a call of this instance still waiting for its reply, so a relay can answer a
     * malformed reply to it with a JSON-RPC error instead of leaving it pending. Read-only; never authority (issue() still checks). */
    pendingCall(id: unknown): boolean { return !sealed && !retired && validProtocolId(id) && requests.has(key(id)); },
    /** cause22 caps: this instance serves the owner's own turn (asked live; see ownerTurnBinding). */
    get ownerTurn() { return owner(); },
    upstream(bytes: number): void {
      guarded(() => reserveUpstreamBytes(checkedOpenTurns(binding.turn).map(member => member.budget!), bytes, owner()), undefined, "ingress.upstream");
    },
    /** cause22 caps: the relay cut one oversized reply line of an owner turn before it was ever a frame. Names the call it answered
     * (`id` as read from the line's first or last bytes, when it is a call in flight; else, unless `orOnlyCall` is false, the only
     * call in flight) and closes it here, so the relay can answer it with the fixed line. Undefined when no call can be named.
     * Never authority for anything else. */
    cutCall(id?: ProtocolId, orOnlyCall = true): ProtocolId | undefined {
      if (sealed || retired || !owner()) return undefined;
      if (id !== undefined && validProtocolId(id) && requests.delete(key(id))) return id;
      if (!orOnlyCall || requests.size !== 1) return undefined;
      const [only] = requests;
      requests.clear();
      try { return (JSON.parse(only!) as [string, ProtocolId])[1]; } catch { return undefined; }
    },
    /** The sole application-level bypass: seal first, then name only a request
     * this exact instance already owns. No reason, input, approval or success. */
    cancel(id: ProtocolId, write: (frame: string) => void): void {
      if (!validProtocolId(id) || !requests.has(key(id))) reject();
      seal();
      write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }));
    },
    /** Observe the actual engine request before forwarding it to the child. */
    request(text: string, write: () => void, delimiter: "" | "\n" = ""): void {
      let entered = false, undo: (() => void) | undefined;
      try {
        guarded(() => {
          if (delimiter !== "" && delimiter !== "\n") reject();
          const rpc = decodeProxyFrame(text);
          if (!rpc.method) {
            const id = key(rpc.id!);
            if (!serverRequests.delete(id)) reject();
            undo = () => serverRequests.add(id);
          } else if (rpc.id !== undefined) {
            const id = key(rpc.id);
            // MAIN-RULING cause22-no-transport-caps: no count of calls in flight; a repeated id is still a protocol fault.
            if (requests.has(id)) reject();
            requests.add(id);
            undo = () => requests.delete(id);
          }
          // The request destination has its own concrete descriptor; this check
          // never authorizes the eventual reply or a queued write. A request carries
          // no remembered context, so held context still checking:pending defers it.
          deferringPendingFence(() => emitConsumingTurnResponse(binding, requestDescriptor, { bytes: Buffer.byteLength(text + delimiter), refs: [], ownerProposal: ownerToolExchange, write: () => { entered = true; return write(); } }));
        }, () => entered, "ingress.request");
      } catch (error) {
        // Not forwarded: the same request may be offered again once its check clears.
        if (!entered && isPendingFenceDeferral(error) && !sealed && !retired) undo?.();
        throw error;
      }
    },
    /** 1.0.20 revkill: wait for the exact check a deferred request met (bounded). True only when it settled (shown or withheld);
     * the caller then offers the request again and the full fence decides. Never authorizes a write by itself. */
    waitPending(error: unknown, cancelled: () => boolean, maxMs = PENDING_FENCE_WAIT_MS): Promise<boolean> {
      if (!isPendingFenceDeferral(error) || !binding.db) return Promise.resolve(false);
      return awaitExactPendingCheck(binding.db, error, () => cancelled() || sealed || retired, maxMs);
    },
    issue(frame: ProxyFrame): ReleaseEnvelope {
      return guarded(() => {
        if (!instanceId || frame.instanceId !== instanceId || pending || frame.sequence !== issued + 1
          || !Number.isSafeInteger(frame.sequence) || !Array.isArray(frame.refs)) reject();
        const rpc = decodeProxyFrame(frame.frame);
        if (rpc.method && !(rpc.id === undefined
          ? ["notifications/tools/list_changed", "notifications/resources/list_changed", "notifications/resources/updated", "notifications/prompts/list_changed", "notifications/message", "notifications/progress", "notifications/cancelled"]
          : ["ping", "roots/list", "sampling/createMessage", "elicitation/create"]).includes(rpc.method)) reject();
        if (!rpc.method && !requests.has(key(rpc.id!))) reject();
        // MAIN-RULING cause22-no-transport-caps: no count of server requests in flight; a repeated id is still a protocol fault.
        if (rpc.method && rpc.id !== undefined && serverRequests.has(key(rpc.id))) reject();
        // A permit is preparation, never released engine content. Validate and
        // snapshot provenance now; final acceptance rechecks and commits it.
        const budgets = checkedOpenTurns(binding.turn).map(member => member.budget!);
        return withReleaseBudgets(budgets, () => {
          assertConsumingDescriptor(binding, frame.descriptor);
          checkReleaseAvailable(budgets, { attempts: 1, bytes: Buffer.byteLength(frame.frame) });
          const proposal = proposeTurnParents(binding.turn, frame.refs, ownerToolExchange);
          for (const entry of proposal.entries) assertRetainedFence(entry.open, binding.db, 0, entry.parents, "check-only", ownerToolExchange);
          const refs = structuredClone(frame.refs);
          const permit = randomBytes(32).toString("base64url");
          issued = frame.sequence;
          // The acknowledgement crosses the child and this loop again; a busy loop delays it (TURN_RELEASE_WAIT_MS), a lost child never sends it.
          const deadline = setTimeout(() => seal(), TURN_RELEASE_WAIT_MS); deadline.unref?.();
          pending = { permit, sequence: issued, digest: frameDigest(frame.frame), descriptor: frame.descriptor, rpc, deadline,
            refs, revisions: checkedOpenTurns(binding.turn).map(member => member.revision) };
          return Object.freeze({ permit, instanceId, sequence: issued, frame: frame.frame });
        });
      }, undefined, "ingress.issue");
    },
    /** No await, capacity wait or queue may occur inside write. */
    deliver(envelope: ReleaseEnvelope, write: (frame: string) => void, delimiter: "" | "\n" = ""): void {
      let entered = false;
      guarded(() => {
        if (delimiter !== "" && delimiter !== "\n") reject();
        const permit = pending;
        if (!permit || !envelope || envelope.instanceId !== instanceId || envelope.permit !== permit.permit
          || envelope.sequence !== delivered + 1 || envelope.sequence !== permit.sequence
          || typeof envelope.frame !== "string" || frameDigest(envelope.frame) !== permit.digest) reject();
        const accepted = permit!;
        const members = checkedOpenTurns(binding.turn);
        if (members.length !== accepted.revisions.length || members.some((member, i) => member.revision !== accepted.revisions[i])) reject();
        clearTimeout(accepted.deadline);
        pending = undefined;
        try {
          emitConsumingTurnResponse(binding, accepted.descriptor, { bytes: Buffer.byteLength(envelope.frame + delimiter), refs: accepted.refs, ownerProposal: ownerToolExchange, write: () => {
            entered = true;
            delivered = envelope.sequence;
            if (!accepted.rpc.method) requests.delete(key(accepted.rpc.id!));
            else if (accepted.rpc.id !== undefined) serverRequests.add(key(accepted.rpc.id));
            return write(envelope.frame + delimiter);
          } });
        } catch (error) {
          // 1.0.20 revkill2: a reply still being checked was not released. Its permit stays for the one retry after the check (bounded);
          // drop() voids it. The permit deadline covers the whole wait, and still seals if nobody retries or drops.
          if (!entered && isPendingFenceDeferral(error)) {
            const deadline = setTimeout(() => seal(), PENDING_FENCE_WAIT_MS + 5000); deadline.unref?.();
            pending = { ...accepted, deadline };
          }
          throw error;
        }
      }, () => entered, "ingress.deliver");
    },
    /** 1.0.20 revkill2: void the permit of a reply whose check did not clear in time. Nothing of it is released; a call it answered is closed. */
    drop(): void {
      if (!pending || sealed || retired) return;
      clearTimeout(pending.deadline);
      delivered = pending.sequence;
      if (!pending.rpc.method) requests.delete(key(pending.rpc.id!));
      pending = undefined;
    },
    async accept(envelope: ReleaseEnvelope, destination: IngressDestination): Promise<void> {
      try { await destination.capacity(); }
      catch (error) { seal(false); throw error; }
      api.deliver(envelope, destination.write);
    },
    /** Transport loss/EOF needs no working HTTP channel to seal the bound lease. */
    supervise(source: Pick<EventEmitter, "once">): void {
      for (const event of ["error", "exit", "close", "end", "disconnect"]) source.once(event, () => {
        if (sealed || retired) return;
        // A displaced generation is still a real refusal. A valid generation's
        // native transport loss only invalidates this channel's pending authority.
        try { assertConsumingBinding(binding); } catch (error) { logSwallowedConsumingError("ingress.supervise", error); seal(false); return; }
        seal(false);
      });
    },
    seal: () => seal(),
    close(): void { reject(); },
  });
  const requestDescriptor = registerConsumingDescriptor("proxy:child-request", "request");
  return api;
}
import { registerConsumingDescriptor } from "./consuming-turn-response.ts";

/** Decode envelopes at the trusted ingress, never in a CLI-owned wrapper. */
export function decodeReleaseEnvelope(text: string, _owner = false): ReleaseEnvelope {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "frame,instanceId,permit,sequence"
    || typeof value.permit !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.permit)
    || typeof value.instanceId !== "string" || value.instanceId.length > 128 || !Number.isSafeInteger(value.sequence) || value.sequence < 1) throw new Error("MEMORY_CONTEXT_REVOKED");
  decodeProxyFrame(value.frame);
  return Object.freeze(value);
}

import type { InternalCapabilities, InternalCapability } from "./internal-capabilities.ts";
/** Server-owned issuance table. A JSON descriptor/refs object is never authority. */
export function createProxyReleaseAuthority(capabilities: InternalCapabilities) {
  const instances = new Map<string, { binding: ConsumingTurnBinding; ingress: ReturnType<typeof createConsumingIngress>;
    descriptor: ConsumingDescriptor; provenance: (frame: RpcFrame) => readonly LineageRef[] }>();
  return Object.freeze({
    /** cause22 caps: the release door asks whose turn this claim serves, to size its body limit and to tell the child (one header). */
    ownerTurn(claim: InternalCapability): boolean {
      const control = capabilities.releaseControl(claim);
      const instance = control && instances.get(control.instanceId);
      return Boolean(control && instance && instance.binding === control.binding && !instance.ingress.retired && !instance.ingress.sealed
        && ownerTurnBinding(instance.binding));
    },
    /** Dedicated control operation; never a permit or engine-visible frame. */
    reserveUpstream(claim: InternalCapability, body: unknown): void {
      const control = capabilities.releaseControl(claim);
      const instance = control && instances.get(control.instanceId);
      if (!control || !instance || instance.binding !== control.binding || instance.ingress.retired) throw new Error("MEMORY_CONTEXT_REVOKED");
      try {
        assertConsumingBinding(instance.binding);
        const value = body as { operation?: unknown; instanceId?: unknown; bytes?: unknown };
        if (!value || Object.keys(value).sort().join() !== "bytes,instanceId,operation" || value.operation !== "upstream"
          || value.instanceId !== control.instanceId || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0
          ) throw new Error("MEMORY_CONTEXT_REVOKED");
        // One unit per raw byte pays for delimiter scanning as well as every
        // possible parsed event, before the child examines buffered bytes.
        reserveUpstreamBytes(checkedOpenTurns(instance.binding.turn).map(member => member.budget!), value.bytes as number, instance.ingress.ownerTurn);
      } catch (error) {
        if (!instance.ingress.sealed) logSwallowedConsumingError("release.reserveUpstream", error);
        // cause22: the fixed verdict of the refusing check travels with the denial, so the door logs the real cause (never free text)
        const fence = (error as { fence?: { state?: unknown; reason?: unknown } } | null)?.fence;
        instance.ingress.seal();
        throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), fence ? { fence } : {});
      }
    },
    seal(claim: InternalCapability): void {
      const control = capabilities.releaseControl(claim);
      if (!control) return;
      const instance = instances.get(control.instanceId);
      if (instance && instance.binding === control.binding) instance.ingress.seal();
      // A deleted generation has no authority left, including refusal authority.
    },
    register(binding: ConsumingTurnBinding, descriptor: ConsumingDescriptor, provenance: (frame: RpcFrame) => readonly LineageRef[]) {
      assertConsumingBinding(binding);
      const instanceId = randomBytes(24).toString("base64url");
      // the turn's tool exchange (the release door and the relay's mounts): 1.0.22 userbug-sealed owner rule, see createConsumingIngress
      const ingress = createConsumingIngress(binding, instanceId, true);
      const token = capabilities.mintReleaseControl(binding, instanceId);
      instances.set(instanceId, { binding, ingress, descriptor, provenance });
      return Object.freeze({ instanceId, token, identity: ingress.identity, ingress,
        dispose() { ingress.seal(); instances.delete(instanceId); } });
    },
    verdict(claim: InternalCapability, body: unknown): ReleaseEnvelope {
      const control = capabilities.releaseControl(claim);
      const instance = control && instances.get(control.instanceId);
      if (!control || !instance || instance.binding !== control.binding || instance.ingress.retired) {
        throw new Error("MEMORY_CONTEXT_REVOKED");
      }
      try {
        const value = body as Record<string, unknown>;
        if (!value || typeof value !== "object" || Array.isArray(value)
          || Object.keys(value).sort().join() !== "bytes,descriptor,digest,frame,instanceId,requestId,sequence"
          || value.instanceId !== control.instanceId || value.descriptor !== instance.descriptor.id
          || typeof value.frame !== "string" || value.bytes !== Buffer.byteLength(value.frame)
          || value.digest !== frameDigest(value.frame) || !Number.isSafeInteger(value.sequence)) throw new Error("MEMORY_CONTEXT_REVOKED");
        const rpc = decodeProxyFrame(value.frame);
        if (value.requestId !== (rpc.id ?? null)) throw new Error("MEMORY_CONTEXT_REVOKED");
        return instance.ingress.issue({ instanceId: control.instanceId, sequence: value.sequence as number,
          frame: value.frame, descriptor: instance.descriptor, refs: instance.provenance(rpc) });
      } catch (error) {
        if (!instance.ingress.sealed) logSwallowedConsumingError("release.verdict", error);
        const fence = (error as { fence?: { state?: unknown; reason?: unknown } } | null)?.fence;
        instance.ingress.seal(); throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), fence ? { fence } : {});
      }
    },
  });
}
