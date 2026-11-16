// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { EngineBashBindings, type BashInvocationFacts } from "./engine-bash-binding.ts";
import { EngineBashLeases } from "./engine-bash-trust.ts";
import { engineBashReference } from "./engine-bash-artifacts.ts";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const identity = { kind: "fuigo" as const, instanceId: "engine", pid: 41, creationTime: "created-41", imageId: "pinned-image", connectionEpoch: 1 };
const facts = (): BashInvocationFacts => ({ threadId: "thread", turnId: "turn", generation: "generation", callId: "call", revision: 1,
  input: { command: "bash ./hello.sh", cwd: "C:\\work" }, occurrence: { dialect: "bash", treePath: [0], startByte: 0, endByte: 4, role: "program" },
  nativePath: "C:\\Git\\usr\\bin\\bash.exe", volumeId: "volume", fileId: "file", cwdNative: "C:\\work", cwdId: "cwd",
  envGeneration: "env-1", environment: { PATH: "C:\\Git\\usr\\bin", SECRET: "private-value" }, referenceId: engineBashReference.referenceId });
async function fixture() {
  const drain = deferred<void>(), ticketDrain = deferred<void>();
  const native = { revoke: vi.fn(), release: vi.fn(), drained: drain.promise };
  const leases = new EngineBashLeases({ acquire: async () => native });
  const lease = (await leases.acquire())!;
  const ticket = { revoke: vi.fn(), drained: ticketDrain.promise };
  const supervisor = { revalidate: vi.fn(() => true), commit: vi.fn(async () => ticket) };
  const registry = new EngineBashBindings({ leases, supervisor }), engine = registry.connect(identity);
  const cleanup = async () => { registry.stop(engine); ticketDrain.resolve(); drain.resolve(); await leases.revoke(lease); };
  return { registry, engine, lease, leases, native, supervisor, ticket, ticketDrain, drain, cleanup };
}
describe("GB08/14/23 private invocation binding", () => {
  it("admits only the exact prepared occurrence and the registered event object", async () => {
    const f = await fixture();
    try {
      const call = facts(), context = f.registry.prepare(f.engine, f.lease, call)!;
      expect(context).not.toBeNull(); expect(JSON.stringify(context)).toBe("{}");
      const event = {}; expect(f.registry.bindEvent(context, event)).toBe(true);
      expect(f.registry.decision(f.engine, event, call)).toBe(true);
      expect(f.registry.decision(f.engine, { ...event }, call)).toBe(false);
      expect(f.registry.bindEvent({ ...context }, {})).toBe(false);
      expect(f.registry.decision({ ...f.engine }, event, call)).toBe(false);
    } finally { await f.cleanup(); }
  });
  it.each(["threadId", "turnId", "generation", "callId", "revision", "nativePath", "volumeId", "fileId", "cwdNative", "cwdId", "envGeneration", "referenceId"] as const)("a changed %s never consumes the prepared occurrence", async key => {
    const f = await fixture();
    try {
      const call = facts(), context = f.registry.prepare(f.engine, f.lease, call)!, event = {};
      expect(f.registry.bindEvent(context, event)).toBe(true);
      expect(f.registry.decision(f.engine, event, { ...call, [key]: key === "revision" ? 2 : "changed" })).toBe(false);
      expect(f.supervisor.commit).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
  it.each([
    (call: BashInvocationFacts) => { call.input = { command: "bash ./other.sh" }; },
    (call: BashInvocationFacts) => { call.environment = { ...call.environment, PATH: "C:\\other" }; },
    (call: BashInvocationFacts) => { call.occurrence.treePath = [0, 1]; },
    (call: BashInvocationFacts) => { call.occurrence.startByte = 1; },
    (call: BashInvocationFacts) => { call.occurrence.dialect = "pwsh"; },
  ])("full merged inputs, environment and parser positions are bound %#", async mutate => {
    const f = await fixture();
    try {
      const call = facts(), context = f.registry.prepare(f.engine, f.lease, call)!, event = {};
      expect(f.registry.bindEvent(context, event)).toBe(true); mutate(call);
      expect(f.registry.decision(f.engine, event, call)).toBe(false);
    } finally { await f.cleanup(); }
  });
  it("duplicates share a reservation; a newer revision revokes the old occurrence", async () => {
    const f = await fixture();
    try {
      const call = facts(), context = f.registry.prepare(f.engine, f.lease, call)!, event = {};
      expect(f.registry.prepare(f.engine, f.lease, facts())).toBe(context);
      expect(f.registry.bindEvent(context, event)).toBe(true);
      const next = { ...facts(), revision: 2, input: { command: "bash ./new.sh" } };
      const replacement = f.registry.prepare(f.engine, f.lease, next);
      expect(replacement).not.toBeNull(); expect(replacement).not.toBe(context);
      expect(f.registry.decision(f.engine, event, call)).toBe(false);
      expect(f.registry.prepare(f.engine, f.lease, call)).toBeNull();
      expect(f.registry.prepare(f.engine, f.lease, { ...next, input: {} })).toBeNull();
    } finally { await f.cleanup(); }
  });
  it("reconnect and PID reuse invalidate old private engine capabilities", async () => {
    const f = await fixture();
    try {
      const call = facts(), context = f.registry.prepare(f.engine, f.lease, call)!, event = {};
      expect(f.registry.bindEvent(context, event)).toBe(true);
      const next = f.registry.connect({ ...identity, creationTime: "reused-pid", connectionEpoch: 2 });
      expect(f.registry.decision(f.engine, event, call)).toBe(false);
      expect(f.registry.decision(next, event, call)).toBe(false);
      expect(f.registry.prepare(f.engine, f.lease, call)).toBeNull();
    } finally { await f.cleanup(); }
  });
  it("commit is single-use and holds ticket capacity through descendant drain", async () => {
    const f = await fixture();
    try {
      const call = facts(), context = f.registry.prepare(f.engine, f.lease, call)!;
      expect(await f.registry.commit(context)).toBe(true); expect(await f.registry.commit(context)).toBe(false);
      expect(f.supervisor.commit).toHaveBeenCalledOnce(); expect(f.registry.activeTickets).toBe(1);
      f.registry.stop(f.engine); expect(f.ticket.revoke).toHaveBeenCalledOnce();
      expect(f.registry.activeTickets).toBe(1); expect(f.native.release).not.toHaveBeenCalled();
      f.ticketDrain.resolve(); await vi.waitFor(() => expect(f.registry.activeTickets).toBe(0));
    } finally { await f.cleanup(); }
  });
  it("Stop during commit revokes late native success and retains its slot until drain", async () => {
    const f = await fixture();
    try {
      const pending = deferred<typeof f.ticket>(); f.supervisor.commit.mockImplementation(() => pending.promise);
      const context = f.registry.prepare(f.engine, f.lease, facts())!;
      const commit = f.registry.commit(context); expect(f.registry.activeTickets).toBe(1);
      f.registry.stop(f.engine); expect(f.registry.activeTickets).toBe(1);
      pending.resolve(f.ticket); expect(await commit).toBe(false);
      expect(f.ticket.revoke).toHaveBeenCalledOnce(); expect(f.registry.activeTickets).toBe(1);
      f.ticketDrain.resolve(); await vi.waitFor(() => expect(f.registry.activeTickets).toBe(0));
    } finally { await f.cleanup(); }
  });
  it("a changed or unavailable native lease cannot grant scan relief or launch", async () => {
    const f = await fixture();
    try {
      const context = f.registry.prepare(f.engine, f.lease, facts())!, event = {};
      expect(f.registry.bindEvent(context, event)).toBe(true);
      f.supervisor.revalidate.mockReturnValue(false);
      expect(f.registry.decision(f.engine, event, facts())).toBe(false);
      expect(await f.registry.commit(context)).toBe(false); expect(f.supervisor.commit).not.toHaveBeenCalled();
      expect(f.registry.prepare(f.engine, {}, facts())).toBeNull();
    } finally { await f.cleanup(); }
  });
  it("oversized or accessor-backed facts are refused before a native call", async () => {
    const f = await fixture();
    try {
      const read = vi.fn(() => "command"), call = facts();
      Object.defineProperty(call.input, "command", { get: read, enumerable: true });
      expect(f.registry.prepare(f.engine, f.lease, call)).toBeNull(); expect(read).not.toHaveBeenCalled();
      expect(f.registry.prepare(f.engine, f.lease, { ...facts(), input: "a".repeat(1024 * 1024 + 1) })).toBeNull();
      expect(f.supervisor.revalidate).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
});
it("GB08: another live engine cannot borrow the selected dependency lease", async () => {
  const f = await fixture();
  try {
    expect(f.registry.prepare(f.engine, f.lease, facts())).not.toBeNull();
    const other = f.registry.connect({ ...identity, instanceId: "another", pid: 42 });
    expect(f.registry.prepare(other, f.lease, facts())).toBeNull();
    f.registry.stop(other);
  } finally { await f.cleanup(); }
});
it("GB23: changed merged facts with a reused revision revoke the old reservation", async () => {
  const f = await fixture();
  try {
    const context = f.registry.prepare(f.engine, f.lease, facts())!, event = {};
    expect(f.registry.bindEvent(context, event)).toBe(true);
    expect(f.registry.prepare(f.engine, f.lease, { ...facts(), input: { command: "different" } })).toBeNull();
    expect(f.registry.decision(f.engine, event, facts())).toBe(false);
    expect(await f.registry.commit(context)).toBe(false);
    expect(f.supervisor.commit).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});
it.each(["rejected", "missing-lifetime", "throwing-lifetime"])("GB14: %s commit cannot free an uncertain native use", async kind => {
  const f = await fixture();
  try {
    if (kind === "rejected") f.supervisor.commit.mockRejectedValueOnce(Error("lost commit reply"));
    else if (kind === "missing-lifetime") f.supervisor.commit.mockResolvedValueOnce({ revoke: vi.fn(), drained: undefined } as any);
    else f.supervisor.commit.mockResolvedValueOnce(Object.defineProperty({ revoke: vi.fn() }, "drained", { get() { throw Error("bad native shape"); } }) as any);
    const context = f.registry.prepare(f.engine, f.lease, facts())!;
    expect(await f.registry.commit(context)).toBe(false);
    expect(f.registry.activeTickets).toBe(1); expect(f.native.revoke).toHaveBeenCalledOnce();
    expect(f.native.release).not.toHaveBeenCalled(); expect(f.leases.live(f.lease)).toBe(false);
    f.drain.resolve(); await vi.waitFor(() => expect(f.registry.activeTickets).toBe(0));
  } finally { await f.cleanup(); }
});
