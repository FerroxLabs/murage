// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { engineBashReference } from "./engine-bash-artifacts.ts";
import type { EngineBashLease, EngineBashLeases } from "./engine-bash-trust.ts";

export interface BashEngineIdentity {
  kind: "claude" | "pi" | "fuigo";
  instanceId: string; pid: number; creationTime: string; imageId: string; connectionEpoch: number;
}
export interface BashInvocationFacts {
  threadId: string; turnId: string; generation: string; callId: string; revision: number;
  input: unknown;
  occurrence: { dialect: "bash" | "pwsh"; treePath: number[]; startByte: number; endByte: number; role: string };
  nativePath: string; volumeId: string; fileId: string; cwdNative: string; cwdId: string;
  envGeneration: string; environment: Readonly<Record<string, string>>; referenceId: string;
}
export interface BashExecutionTicket { drained: Promise<void>; revoke(): void }
export interface BashBindingSupervisor {
  revalidate(lease: EngineBashLease, engine: Readonly<BashEngineIdentity>, facts: Readonly<BashInvocationFacts>): boolean;
  commit(lease: EngineBashLease, engine: Readonly<BashEngineIdentity>, facts: Readonly<BashInvocationFacts>): Promise<BashExecutionTicket>;
}
type State = "prepared" | "committing" | "running" | "draining" | "terminal";
type EngineRecord = { token: object; identity: Readonly<BashEngineIdentity>; live: boolean;
  generations: Map<string, string>; calls: Map<string, { revision: number; digest: string; records: Map<string, Invocation> }>; records: Set<Invocation> };
type Invocation = { token: object; engine: EngineRecord; lease: EngineBashLease; facts: Readonly<BashInvocationFacts> | null;
  digest: string; state: State; ticket?: BashExecutionTicket; revoked?: boolean; counted: boolean; running: boolean };
// Prepared reservations and late/draining native tickets share one finite budget.
const uses = { total: 0, leases: new WeakMap<object, number>() };
const text = (value: unknown, limit = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= limit && !value.includes("\0");
const ordinal = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

/** Canonicalize data without invoking a getter/toJSON or accepting prototypes,
 * cycles, sparse arrays, undefined values, non-finite numbers or unbounded input. */
function snapshot<T>(input: T): { value: T; digest: string } {
  const seen = new Set<object>(); let bytes = 0, nodes = 0;
  function copy(value: unknown, depth: number): unknown {
    if (depth > 32 || ++nodes > 65536) throw Error("depth");
    if (typeof value === "string") { bytes += Buffer.byteLength(value); if (bytes > 1024 * 1024) throw Error("size"); return value; }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || seen.has(value)) throw Error("data");
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length) throw Error("symbol");
    let out: unknown;
    if (Array.isArray(value)) {
      if (value.length > 4096 || Object.keys(descriptors).length !== value.length + 1) throw Error("array");
      out = Array.from({ length: value.length }, (_, i) => {
        const item = descriptors[String(i)]; if (!item || !("value" in item)) throw Error("accessor");
        return copy(item.value, depth + 1);
      });
    } else {
      const proto = Object.getPrototypeOf(value); if (proto !== null && proto !== Object.prototype) throw Error("prototype");
      const keys = Object.keys(descriptors).sort(); if (keys.length > 4096) throw Error("keys");
      const result: Record<string, unknown> = Object.create(null);
      for (const key of keys) { bytes += Buffer.byteLength(key); if (bytes > 1024 * 1024 || !("value" in descriptors[key]!)) throw Error("accessor"); result[key] = copy(descriptors[key]!.value, depth + 1); }
      out = result;
    }
    seen.delete(value); return Object.freeze(out);
  }
  const value = copy(input, 0) as T, serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 1024 * 1024) throw Error("size");
  return { value, digest: createHash("sha256").update(serialized).digest("hex") };
}
function validFacts(f: BashInvocationFacts): boolean {
  const occurrence = f.occurrence;
  return [f.threadId, f.turnId, f.generation, f.callId, f.nativePath, f.volumeId, f.fileId, f.cwdNative, f.cwdId, f.envGeneration].every(v => text(v, 32768))
    && ordinal(f.revision) && f.referenceId === engineBashReference.referenceId
    && !!occurrence && ["bash", "pwsh"].includes(occurrence.dialect) && text(occurrence.role, 64)
    && Array.isArray(occurrence.treePath) && occurrence.treePath.length <= 64 && occurrence.treePath.every(ordinal)
    && ordinal(occurrence.startByte) && ordinal(occurrence.endByte) && occurrence.endByte > occurrence.startByte
    && !!f.environment && typeof f.environment === "object" && !Array.isArray(f.environment)
    && Object.entries(f.environment).every(([key, value]) => text(key, 32768) && !key.includes("=") && typeof value === "string" && !value.includes("\0"));
}

/** Server-only invocation registry. It grants no executable identity on its
 * own: each prepared use and commit requires a live native lease and a current
 * supervisor revalidation. No production driver is exempt without that native
 * contract. Tokens and event associations never enter events or persistence. */
export class EngineBashBindings {
  #leases: EngineBashLeases;
  #supervisor: BashBindingSupervisor;
  #engines = new Map<string, EngineRecord>();
  #tokens = new WeakMap<object, EngineRecord>();
  #contexts = new WeakMap<object, Invocation>();
  #events = new WeakMap<object, Invocation>();
  #running = 0;
  #leaseOwners = new WeakMap<object, EngineRecord>();
  #preparing = new WeakSet<EngineRecord>();
  constructor(options: { leases: EngineBashLeases; supervisor: BashBindingSupervisor }) {
    this.#leases = options.leases; this.#supervisor = options.supervisor;
  }
  connect(identity: BashEngineIdentity): object {
    const captured = snapshot(identity).value;
    if (!["claude", "pi", "fuigo"].includes(captured.kind) || ![captured.instanceId, captured.creationTime, captured.imageId].every(v => text(v))
      || !Number.isSafeInteger(captured.pid) || captured.pid <= 0 || !ordinal(captured.connectionEpoch)) throw Error("Invalid Bash engine identity");
    const prior = this.#engines.get(captured.instanceId);
    if (prior) {
      if (snapshot(prior.identity).digest === snapshot(captured).digest) return prior.token;
      if (captured.connectionEpoch <= prior.identity.connectionEpoch) throw Error("Stale Bash engine connection");
      this.stop(prior.token);
    }
    if (this.#engines.size >= 128) throw Error("Bash engine capacity reached");
    const token = Object.freeze({}), engine: EngineRecord = { token, identity: captured, live: true, generations: new Map(), calls: new Map(), records: new Set() };
    this.#engines.set(captured.instanceId, engine); this.#tokens.set(token, engine); return token;
  }
  prepare(engineToken: object, lease: EngineBashLease, facts: BashInvocationFacts): object | null {
    const engine = this.#tokens.get(engineToken);
    if (!engine?.live || !this.#leases.live(lease) || this.#preparing.has(engine)
      || (this.#leaseOwners.has(lease) && this.#leaseOwners.get(lease) !== engine)) return null;
    let captured: ReturnType<typeof snapshot<BashInvocationFacts>>;
    try { captured = snapshot(facts); if (!validFacts(captured.value)) return null; } catch { return null; }
    const f = captured.value, priorGeneration = engine.generations.get(f.threadId);
    if (priorGeneration !== undefined && priorGeneration !== f.generation) {
      // A generation change needs a fresh engine/lease binding, never a reusable
      // public call id. The driver reconnects after native reacquisition.
      this.stop(engineToken); return null;
    }
    const callKey = JSON.stringify([f.threadId, f.turnId, f.callId]);
    const occurrenceKey = JSON.stringify([f.occurrence.dialect, f.occurrence.treePath, f.occurrence.startByte, f.occurrence.endByte, f.occurrence.role]);
    const callDigest = snapshot({ ...f, occurrence: null }).digest;
    let call = engine.calls.get(callKey);
    if (call) {
      if (f.revision < call.revision) return null;
      if (f.revision === call.revision) {
        if (call.digest !== callDigest) { for (const old of call.records.values()) this.#revoke(old); return null; }
        const same = call.records.get(occurrenceKey);
        if (same) return same.state === "prepared" && same.digest === captured.digest && same.lease === lease ? same.token : null;
      } else {
        for (const old of call.records.values()) this.#revoke(old);
        call = undefined;
      }
    }
    if (engine.records.size >= 1024 || uses.total >= 256 || (uses.leases.get(lease) ?? 0) >= 32) return null;
    this.#preparing.add(engine);
    try { if (this.#supervisor.revalidate(lease, engine.identity, f) !== true) return null; } catch { return null; }
    finally { this.#preparing.delete(engine); }
    if (!engine.live || !this.#leases.live(lease)) return null;
    const record: Invocation = { token: Object.freeze({}), engine, lease, facts: f, digest: captured.digest, state: "prepared", counted: true, running: false };
    this.#leaseOwners.set(lease, engine);
    uses.total++; uses.leases.set(lease, (uses.leases.get(lease) ?? 0) + 1);
    if (!call) { call = { revision: f.revision, digest: callDigest, records: new Map() }; engine.calls.set(callKey, call); }
    call.records.set(occurrenceKey, record); engine.records.add(record); engine.generations.set(f.threadId, f.generation);
    this.#contexts.set(record.token, record); return record.token;
  }
  bindEvent(context: object, event: object): boolean {
    const record = this.#contexts.get(context);
    if (!record || record.state !== "prepared" || !record.engine.live || !this.#leases.live(record.lease)) return false;
    const prior = this.#events.get(event); if (prior && prior !== record) return false;
    this.#events.set(event, record); return true;
  }
  decision(engine: object, event: object, facts: BashInvocationFacts): boolean {
    const record = this.#events.get(event);
    if (!record || record.engine.token !== engine || !this.#valid(record)) return false;
    try { if (snapshot(facts).digest === record.digest) return true; } catch { /* changed/unreadable facts revoke this use */ }
    this.#revoke(record); return false;
  }
  async commit(context: object): Promise<boolean> {
    const record = this.#contexts.get(context); if (!record || !this.#valid(record)) return false;
    record.state = "committing"; record.running = true; this.#running++;
    let nativeTicket: BashExecutionTicket;
    try { nativeTicket = await this.#supervisor.commit(record.lease, record.engine.identity, record.facts!); }
    catch { this.#uncertainCommit(record); return false; }
    let ticket: BashExecutionTicket | undefined;
    try {
      const { revoke, drained } = nativeTicket;
      if (typeof revoke === "function" && drained instanceof Promise) ticket = { revoke: () => revoke.call(nativeTicket), drained };
    } catch { /* no complete native lifetime proof */ }
    if (!ticket) { this.#uncertainCommit(record); return false; }
    record.ticket = ticket;
    // Rejection/unknown drain retains the reservation; only confirmed native
    // descendant drain releases it. A UI result never reaches this path.
    void ticket.drained.then(() => this.#release(record), () => { record.state = "draining"; this.#revokeTicket(record); });
    if (record.state !== "committing" || !record.engine.live || !this.#leases.live(record.lease)) {
      record.state = "draining"; this.#revokeTicket(record); return false;
    }
    record.state = "running"; return true;
  }
  #uncertainCommit(record: Invocation): void {
    // A lost/invalid commit reply is not proof no child was created. Revoke
    // the dependency lease and keep this ticket budget until its native owner
    // proves the entire lease drained, even if no usable ticket arrived.
    record.state = "draining"; this.#revokeTicket(record);
    void this.#leases.revoke(record.lease).then(() => this.#release(record), () => {});
  }
  #valid(record: Invocation): boolean {
    if (record.state !== "prepared" || !record.engine.live || !this.#leases.live(record.lease)) return false;
    try { if (this.#supervisor.revalidate(record.lease, record.engine.identity, record.facts!) === true
      && record.state === "prepared" && record.engine.live && this.#leases.live(record.lease)) return true; } catch { /* no admission */ }
    this.#revoke(record); void this.#leases.revoke(record.lease).catch(() => {}); return false;
  }
  #revokeTicket(record: Invocation): void {
    if (!record.ticket || record.revoked) return;
    record.revoked = true; try { record.ticket.revoke(); } catch { /* protection stays until native drain */ }
  }
  #revoke(record: Invocation): void {
    if (record.state === "terminal") return;
    if (record.state === "prepared") { this.#release(record); return; }
    record.state = "draining"; this.#revokeTicket(record);
  }
  #release(record: Invocation): void {
    if (!record.counted) return;
    record.counted = false; record.state = "terminal"; record.facts = null;
    uses.total--; uses.leases.set(record.lease, (uses.leases.get(record.lease) ?? 1) - 1);
    if (record.running) { record.running = false; this.#running--; }
  }
  stop(token: object): void {
    const engine = this.#tokens.get(token); if (!engine?.live) return;
    engine.live = false;
    if (this.#engines.get(engine.identity.instanceId) === engine) this.#engines.delete(engine.identity.instanceId);
    const leases = new Set<EngineBashLease>();
    for (const record of engine.records) { this.#revoke(record); leases.add(record.lease); }
    for (const lease of leases) void this.#leases.revoke(lease).catch(() => {});
  }
  close(): void { for (const engine of [...this.#engines.values()]) this.stop(engine.token); }
  get activeTickets(): number { return this.#running; }
}
