// Owners: composio-429-d owns inventory/token producers and these regression consumers.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearInventory, invalidateInventory, readInventory, type InventoryServices } from "./connected-inventory.ts";
import { ensureDevFluxBrokerToken, resetDevFluxTokenState, clearDevFluxTokenDocument } from "./flux-composio-dev-token.ts";
import { setBackoffRandomForTests } from "./upstream-backoff.ts";

const owner = "fixture-inventory-owner";
const services: InventoryServices = { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [] } };
const refusal = (retryAfter: string) => Object.assign(new Error("refused"), { status: 429, retryAfter });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-01T00:00:00Z")); vi.spyOn(Math, "random").mockReturnValue(1); setBackoffRandomForTests(() => 1); clearInventory(); resetDevFluxTokenState(); clearDevFluxTokenDocument(); });
afterEach(() => { clearInventory(); clearDevFluxTokenDocument(); resetDevFluxTokenState(); setBackoffRandomForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("R1 an old successful inventory generation cannot erase a newer refusal or dispatch via settle", async () => {
  const old = deferred<InventoryServices>();
  const load = vi.fn().mockImplementationOnce(() => old.promise).mockRejectedValueOnce(refusal("600")).mockResolvedValue(services);
  const first = readInventory(owner, load, { fresh: true }).catch(error => error);
  invalidateInventory(owner);
  await expect(readInventory(owner, load, { fresh: true })).rejects.toMatchObject({ status: 429 });
  old.resolve(services);
  await first;
  await expect(readInventory(owner, load, { fresh: true })).rejects.toMatchObject({ status: 429 });
  await vi.advanceTimersByTimeAsync(599_000);
  await expect(readInventory(owner, load, { fresh: true })).rejects.toMatchObject({ status: 429 });
  expect(load).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await readInventory(owner, load, { fresh: true })).services).toEqual(services);
  expect(load).toHaveBeenCalledTimes(3);
});

it.each([true, false])("R1 overlapping inventory refusals retain the longest deadline (long first: %s)", async longFirst => {
  const a = deferred<InventoryServices>(), b = deferred<InventoryServices>();
  const load = vi.fn().mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise).mockResolvedValue(services);
  const first = readInventory(owner, load, { fresh: true }).catch(error => error);
  invalidateInventory(owner);
  const second = readInventory(owner, load, { fresh: true }).catch(error => error);
  const long = longFirst ? a : b, short = longFirst ? b : a;
  long.reject(refusal("600")); await Promise.resolve(); await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1000);
  short.reject(refusal("30")); await Promise.all([first, second]);
  await vi.advanceTimersByTimeAsync(598_000);
  await expect(readInventory(owner, load, { fresh: true })).rejects.toMatchObject({ status: 429 });
  expect(load).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await readInventory(owner, load, { fresh: true })).services).toEqual(services);
});

it("R1 a current success also preserves a slower older refusal", async () => {
  const a = deferred<InventoryServices>(), b = deferred<InventoryServices>();
  const load = vi.fn().mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise).mockResolvedValue(services);
  const first = readInventory(owner, load).catch(error => error);
  invalidateInventory(owner);
  const second = readInventory(owner, load, { fresh: true });
  a.reject(refusal("600")); await first;
  b.resolve(services); await second;
  invalidateInventory(owner);
  await vi.advanceTimersByTimeAsync(599_000);
  expect((await readInventory(owner, load, { fresh: true })).services).toEqual(services);
  expect(load).toHaveBeenCalledTimes(2);
});

const options = { fluxBrokerUrl: "https://flux.example.test/composio", env: { FLUX_API_KEY: "sk-flux-fixture" } };
it.each([429, 503])("R5 dev token HTTP %s honors Retry-After for forced and ordinary reads and shares concurrent work", async status => {
  const fetchImpl = vi.fn(async () => Response.json({}, { status, headers: { "retry-after": new Date(Date.now() + 6 * 3600_000).toUTCString() } }));
  await Promise.all(Array.from({ length: 10 }, () => ensureDevFluxBrokerToken({ ...options, fetchImpl })));
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const deadline = Date.now() + 6 * 3600_000;
  for (let minute = 0; minute < 359; minute++) {
    await ensureDevFluxBrokerToken({ ...options, fetchImpl, force: minute % 2 === 0 });
    await vi.advanceTimersByTimeAsync(60_000);
  }
  await vi.advanceTimersByTimeAsync(deadline - Date.now() - 1);
  await Promise.all([false, true].map(force => ensureDevFluxBrokerToken({ ...options, fetchImpl, force })));
  expect(fetchImpl).toHaveBeenCalledTimes(1); // MAIN RULING 1115-COMPOSIO-A2: strictly before the durable floor.
  await vi.advanceTimersByTimeAsync(1);
  expect(fetchImpl).toHaveBeenCalledTimes(2); // MAIN RULING 1115-COMPOSIO-A2: one automatic mint at the exact floor.
  await ensureDevFluxBrokerToken({ ...options, fetchImpl });
  expect(fetchImpl).toHaveBeenCalledTimes(2); // MAIN RULING 1115-COMPOSIO-A2: explicit caller joins the new hold.
});
it.each([429, 503])("R5 dev token HTTP %s backs off exponentially with jitter and a cap", async status => {
  const fetchImpl = vi.fn(async () => Response.json({}, { status }));
  const nominal = status === 429 ? [3600_000, 7200_000, 14400_000, 14400_000] : [60_000, 120_000, 240_000, 480_000, 960_000, 1920_000, 3600_000, 3600_000];
  for (const delay of nominal) {
    await ensureDevFluxBrokerToken({ ...options, fetchImpl });
    const calls = fetchImpl.mock.calls.length;
    await vi.advanceTimersByTimeAsync(delay - 1);
    await ensureDevFluxBrokerToken({ ...options, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(1);
  }
  clearDevFluxTokenDocument(); resetDevFluxTokenState(); vi.mocked(Math.random).mockReturnValue(0);
  await ensureDevFluxBrokerToken({ ...options, fetchImpl });
  const calls = fetchImpl.mock.calls.length;
  await vi.advanceTimersByTimeAsync(nominal[0]! / 2);
  await ensureDevFluxBrokerToken({ ...options, fetchImpl });
  expect(fetchImpl).toHaveBeenCalledTimes(calls + 1);
});

it.each([429, 503])("R5 dev token HTTP %s starts a delta Retry-After at receipt after request latency", async status => {
  let delayed = true;
  const fetchImpl = vi.fn(async () => {
    if (delayed) { await new Promise(resolve => setTimeout(resolve, 20_000)); delayed = false; }
    return Response.json({}, { status, headers: { "retry-after": "21600" } });
  });
  const first = ensureDevFluxBrokerToken({ ...options, fetchImpl });
  await vi.advanceTimersByTimeAsync(20_000); await first;
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(21600_000 - 1);
  await ensureDevFluxBrokerToken({ ...options, fetchImpl });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await ensureDevFluxBrokerToken({ ...options, fetchImpl });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("V01 expired-token refresh retains the same authority hold as startup and turn", async () => {
  let refused = false;
  const fetchImpl = vi.fn(async () => refused ? Response.json({}, { status: 429, headers: { "retry-after": "7200" } })
    : Response.json({ token: "a".repeat(64), expiresAt: new Date(Date.now() + 10_000).toISOString() }));
  await ensureDevFluxBrokerToken({ ...options, fetchImpl });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(11_000); refused = true;
  await ensureDevFluxBrokerToken({ ...options, fetchImpl });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const start = Date.now();
  for (const elapsed of [15_001, 60_000, 3600_000, 7199_999]) {
    await vi.advanceTimersByTimeAsync(start + elapsed - Date.now());
    await ensureDevFluxBrokerToken({ ...options, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }
  refused = false;
  await vi.advanceTimersByTimeAsync(1);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});
