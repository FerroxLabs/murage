// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import "../shared/win-hide-child-process.mjs";
import { createHash, randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import { checkedOpenTurns, proposeTurnParents } from "./memory/lineage-write.ts";
import type { LineageRef } from "./memory/lineage-types.ts";
import { UPSTREAM_COLLECTION_MAX, checkReleaseAvailable, reserveRelease, withReleaseBudgets } from "./memory/release-budget.ts";
import { assertRetainedFence, deferringPendingFence, isPendingFenceDeferral } from "./memory/send-fence.ts";
import { awaitExactPendingCheck, PENDING_FENCE_WAIT_MS } from "./memory/fence-pending.ts";
import { logSwallowedConsumingError } from "./consuming-error-log.ts";
import { assertConsumingBinding, assertConsumingDescriptor, emitConsumingTurnResponse, type ConsumingDescriptor, type ConsumingTurnBinding } from "./consuming-turn-response.ts";

export type ProtocolId = string | number;
export const frameDigest = (frame: string) => createHash("sha256").update(frame, "utf8").digest("hex");
export function validProtocolId(id: unknown): id is ProtocolId {
  return typeof id === "string" && id.length > 0 && Buffer.byteLength(id) <= 128 || typeof id === "number" && Number.isSafeInteger(id);
}
export interface RpcFrame { jsonrpc: "2.0"; id?: ProtocolId; method?: string; result?: unknown; error?: unknown; params?: unknown }
/** One complete, bounded frame. No batch, trailing newline, coercion or partial JSON. */
export function decodeProxyFrame(text: string): RpcFrame {
  if (typeof text !== "string" || !text || Buffer.byteLength(text) > UPSTREAM_COLLECTION_MAX || /[\r\n]/.test(text)) throw new Error("MEMORY_CONTEXT_REVOKED");
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
export function createConsumingIngress(binding: ConsumingTurnBinding, instanceId: string) {
  let issued = 0, delivered = 0, sealed = false, retired = false, ledgerRefused = false;
  const requests = new Set<string>();
  const serverRequests = new Set<string>();
  const key = (id: ProtocolId) => JSON.stringify([typeof id, id]);
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
  const reject = (): never => { seal(); throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" }); };
  const guarded = <T>(work: () => T, entered: () => boolean = () => false, site = "ingress"): T => {
    const open = !sealed && !retired;
    try { if (sealed || retired) reject(); assertConsumingBinding(binding); return work(); }
    catch (error) {
      // 1.0.20 revkill: a request still being checked released nothing; it neither seals this instance nor refuses the turn.
      if (!entered() && isPendingFenceDeferral(error)) throw error;
      // The first error that seals this instance is the only evidence of why a turn sealed.
      if (open) logSwallowedConsumingError(`${site}${entered() ? ":entered" : ""}`, error);
      if (entered()) { seal(false); throw error; }
      return reject();
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
    upstream(bytes: number): void {
      guarded(() => reserveRelease(checkedOpenTurns(binding.turn).map(member => member.budget!), { bytes, work: bytes + 1 }), undefined, "ingress.upstream");
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
            if (requests.size >= 4096 || requests.has(id)) reject();
            requests.add(id);
            undo = () => requests.delete(id);
          }
          // The request destination has its own concrete descriptor; this check
          // never authorizes the eventual reply or a queued write. A request carries
          // no remembered context, so held context still checking:pending defers it.
          deferringPendingFence(() => emitConsumingTurnResponse(binding, requestDescriptor, { bytes: Buffer.byteLength(text + delimiter), refs: [], write: () => { entered = true; return write(); } }));
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
        if (rpc.method && rpc.id !== undefined && (serverRequests.size >= 4096 || serverRequests.has(key(rpc.id)))) reject();
        // A permit is preparation, never released engine content. Validate and
        // snapshot provenance now; final acceptance rechecks and commits it.
        const budgets = checkedOpenTurns(binding.turn).map(member => member.budget!);
        return withReleaseBudgets(budgets, () => {
          assertConsumingDescriptor(binding, frame.descriptor);
          checkReleaseAvailable(budgets, { attempts: 1, bytes: Buffer.byteLength(frame.frame) });
          const proposal = proposeTurnParents(binding.turn, frame.refs);
          for (const entry of proposal.entries) assertRetainedFence(entry.open, binding.db, 0, entry.parents, "check-only");
          const refs = structuredClone(frame.refs);
          const permit = randomBytes(32).toString("base64url");
          issued = frame.sequence;
          const deadline = setTimeout(() => seal(), 5000); deadline.unref?.();
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
          || typeof envelope.frame !== "string" || Buffer.byteLength(envelope.frame) > UPSTREAM_COLLECTION_MAX || frameDigest(envelope.frame) !== permit.digest) reject();
        const accepted = permit!;
        const members = checkedOpenTurns(binding.turn);
        if (members.length !== accepted.revisions.length || members.some((member, i) => member.revision !== accepted.revisions[i])) reject();
        clearTimeout(accepted.deadline);
        pending = undefined;
        try {
          emitConsumingTurnResponse(binding, accepted.descriptor, { bytes: Buffer.byteLength(envelope.frame + delimiter), refs: accepted.refs, write: () => {
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
export function decodeReleaseEnvelope(text: string): ReleaseEnvelope {
  if (Buffer.byteLength(text) > UPSTREAM_COLLECTION_MAX * 2 + 1024) throw new Error("MEMORY_CONTEXT_REVOKED");
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
          || (value.bytes as number) > UPSTREAM_COLLECTION_MAX) throw new Error("MEMORY_CONTEXT_REVOKED");
        // One unit per raw byte pays for delimiter scanning as well as every
        // possible parsed event, before the child examines buffered bytes.
        reserveRelease(checkedOpenTurns(instance.binding.turn).map(member => member.budget!), { bytes: value.bytes as number, work: (value.bytes as number) + 1 });
      } catch (error) {
        if (!instance.ingress.sealed) logSwallowedConsumingError("release.reserveUpstream", error);
        instance.ingress.seal(); throw new Error("MEMORY_CONTEXT_REVOKED");
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
      const ingress = createConsumingIngress(binding, instanceId);
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
        instance.ingress.seal(); throw new Error("MEMORY_CONTEXT_REVOKED");
      }
    },
  });
}
