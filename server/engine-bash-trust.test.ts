import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineBashLeases } from "./engine-bash-trust.ts";
import { engineBashReference, parseEngineBashManifest } from "./engine-bash-artifacts.ts";

const manifest = () => structuredClone(engineBashReference);
afterEach(() => vi.useRealTimers());
describe("Git Bash authenticated reference", () => {
  it("accepts both reviewed entry layouts and copies the complete immutable reference", () => {
    const source = manifest(), parsed = parseEngineBashManifest(source);
    expect(parsed?.layouts.map(x => x.entry)).toEqual(["bin/bash.exe", "usr/bin/bash.exe"]);
    source.members[0]!.sha256 = "a".repeat(64);
    expect(parsed?.members[0]!.sha256).toBe(engineBashReference.members[0]!.sha256);
  });
  it.each([
    (m: any) => { m.extra = true; }, (m: any) => { m.machine = 0xaa64; },
    (m: any) => { m.members[0].sha256 = "0".repeat(64); },
    (m: any) => { m.members[0].sha256 = "a".repeat(64); },
    (m: any) => { m.members[0].relative = "../bash.exe"; },
    (m: any) => { m.members[0].relative = "C:/bash.exe"; },
    (m: any) => { m.members[0].relative = "usr/bin/bash.exe:stream"; },
    (m: any) => { m.members[0].relative = "bin/BASH.exe"; },
    (m: any) => { m.members.push({ ...m.members[0] }); },
    (m: any) => { m.members.pop(); }, (m: any) => { m.members[0].bytes = 64 * 1024 * 1024 + 1; },
    (m: any) => { m.layouts[0].entry = "usr/bin/sh.exe"; },
    (m: any) => { m.launchProtocol = 2; }, (m: any) => { m.referenceId = "local-first-seen"; },
  ])("rejects an unreviewed reference mutation %#", mutate => {
    const m = manifest(); mutate(m); expect(parseEngineBashManifest(m)).toBeNull();
  });
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function native() {
  const drain = deferred<void>();
  return { revoke: vi.fn(), drained: drain.promise, release: vi.fn(), drain };
}
function coordinator(options = {}) {
  const acquire = vi.fn(async () => native());
  return { acquire, leases: new EngineBashLeases({ acquire, ...options }) };
}
describe("Git Bash lease accounting before native qualification", () => {
  it("reserves capacity before asynchronous opens and retains it until native drain", async () => {
    const { leases, acquire } = coordinator({ slots: 1 });
    const lease = await leases.acquire(); expect(lease).not.toBeNull();
    expect(await leases.acquire()).toBeNull(); expect(acquire).toHaveBeenCalledTimes(1);
    const close = leases.revoke(lease!); expect(leases.size).toBe(1);
    const resource = await acquire.mock.results[0]!.value;
    expect(resource.revoke).toHaveBeenCalledOnce(); expect(resource.release).not.toHaveBeenCalled();
    resource.drain.resolve(); await close;
    expect(resource.release).toHaveBeenCalledOnce(); expect(leases.size).toBe(0);
    await leases.revoke(lease!); expect(resource.release).toHaveBeenCalledOnce();
  });
  it("late success after cancel never grants a lease and cannot free capacity early", async () => {
    const pending = deferred<ReturnType<typeof native>>();
    const { leases } = coordinator({ acquire: () => pending.promise, slots: 1 });
    const cancel = new AbortController(), acquired = leases.acquire(cancel.signal);
    cancel.abort(); expect(await acquired).toBeNull(); expect(leases.size).toBe(1);
    expect(await leases.acquire()).toBeNull();
    const resource = native(); pending.resolve(resource); await Promise.resolve(); await Promise.resolve();
    await vi.waitFor(() => expect(resource.revoke).toHaveBeenCalledOnce()); expect(leases.size).toBe(1);
    resource.drain.resolve(); await vi.waitFor(() => expect(leases.size).toBe(0));
    expect(resource.release).toHaveBeenCalledOnce();
  });
  it("a native failure relinquishes its reservation once and does not retry", async () => {
    const acquire = vi.fn(async () => { throw Error("native unavailable"); });
    const { leases } = coordinator({ acquire });
    expect(await leases.acquire()).toBeNull(); expect(leases.size).toBe(0);
    expect(acquire).toHaveBeenCalledOnce();
  });
  it("times out admission while retaining an acquiring worker until late drain", async () => {
    vi.useFakeTimers();
    const pending = deferred<ReturnType<typeof native>>();
    const { leases } = coordinator({ acquire: () => pending.promise });
    const acquired = leases.acquire(); await vi.advanceTimersByTimeAsync(2000);
    expect(await acquired).toBeNull(); expect(leases.size).toBe(1);
    const resource = native(); pending.resolve(resource); await vi.advanceTimersByTimeAsync(0);
    expect(resource.revoke).toHaveBeenCalledOnce(); resource.drain.resolve();
    await vi.advanceTimersByTimeAsync(0); expect(leases.size).toBe(0);
  });
  it("does not treat a copied or fabricated public object as authority", async () => {
    const { leases, acquire } = coordinator();
    const lease = await leases.acquire(); expect(lease).not.toBeNull();
    expect(leases.live(lease!)).toBe(true);
    expect(leases.live({ ...lease! })).toBe(false);
    expect(leases.live({})).toBe(false);
    const close = leases.revoke(lease!); expect(leases.live(lease!)).toBe(false);
    (await acquire.mock.results[0]!.value).drain.resolve(); await close;
  });
  it("invalidates live authority if the native supervisor drains unexpectedly", async () => {
    const { leases, acquire } = coordinator();
    const lease = await leases.acquire(), resource = await acquire.mock.results[0]!.value;
    resource.drain.resolve();
    await vi.waitFor(() => expect(leases.live(lease!)).toBe(false));
    expect(resource.release).toHaveBeenCalledOnce(); expect(leases.size).toBe(0);
  });
  it("refuses an already canceled call without reserving a worker", async () => {
    const { leases, acquire } = coordinator(), cancel = new AbortController(); cancel.abort();
    expect(await leases.acquire(cancel.signal)).toBeNull(); expect(leases.size).toBe(0);
    expect(acquire).not.toHaveBeenCalled();
  });
});
it("GB14: a malformed native lifetime never publishes a lease or frees unknown protection", async () => {
  const revoke = vi.fn(), release = vi.fn();
  const leases = new EngineBashLeases({ acquire: async () => ({ revoke, release, drained: undefined }) as any });
  expect(await leases.acquire()).toBeNull();
  expect(revoke).toHaveBeenCalledOnce(); expect(release).not.toHaveBeenCalled();
  expect(leases.size).toBe(1);
});
it("GB14: a dependency that already drained is not live when the caller receives its token", async () => {
  const leases = new EngineBashLeases({ acquire: async () => ({ revoke() {}, release() {}, drained: Promise.resolve() }) });
  const lease = await leases.acquire();
  expect(lease === null || !leases.live(lease)).toBe(true);
});
