// K17 S2 (#29): a stale reconnect mark never refuses an email read the owner has already fixed, and a refresh
// that cannot be done is told plainly, never as "sign in again". Entry point: the real relayConnectedAppCall.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as composio from "./composio.ts";
import { connectorHealthStore } from "./connected-app-health.ts";
import { invalidateInventory } from "./connected-inventory.ts";
import type { AppConfig } from "./config.ts";

const cfg = {} as AppConfig;
let accounts: Record<string, Array<{ id: string; alias?: string; status: string }>>;
let calls: any[], reads: number, inventoryStatus: number, hangInventory: boolean, onRead: (() => void) | undefined, hangFrom: number;
let clock = 20_000_000;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const never = () => new Promise<Response>(() => {});

beforeEach(async () => {
  composio.resetManagedBrokerState(); connectorHealthStore().clearAll();
  clock += 4_000_000; vi.spyOn(Date, "now").mockImplementation(() => clock);
  accounts = { gmail: [{ id: "A", alias: "work", status: "ACTIVE" }, { id: "B", alias: "home", status: "ACTIVE" }] };
  calls = []; reads = 0; inventoryStatus = 200; hangInventory = false; onRead = undefined; hangFrom = Infinity;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) return json({ ready: true });
    if (url.endsWith("/connected")) {
      reads++;
      onRead?.();
      if (hangInventory || reads >= hangFrom) return never();
      if (inventoryStatus !== 200) return json({ error: "fixture" }, inventoryStatus, inventoryStatus === 502 ? { "retry-after": "600" } : {});
      return json({ services: { gmail: { connected: true, status: "ACTIVE", accounts: structuredClone(accounts.gmail) } } });
    }
    const body = JSON.parse(String(init?.body)); calls.push(body);
    return json({ jsonrpc: "2.0", id: body.id, result: { isError: false, content: [{ type: "text", text: JSON.stringify({ successful: true }) }] } });
  }));
  composio.applyManagedBrokerMessage({ type: "murage:managed-composio", access: null, fluxBrokerUrl: "http://127.0.0.1:49321/composio", fluxAccess: { url: "http://127.0.0.1:49321/composio", token: "c".repeat(64) }, legacyUntil: "", legacyClaim: { state: "none" }, accountKind: null, tokenError: null });
  await composio.primeBrokerReadiness();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); composio.resetManagedBrokerState(); });

let id = 0;
const tool = (account: string) => ({ tool_slug: "GMAIL_FETCH_EMAILS", account });
const dispatch = (accountIds: string[], options: Record<string, unknown> = {}) => composio.relayConnectedAppCall(cfg, {
  jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: accountIds.map(tool) } },
}, undefined, undefined, { botId: "k17s2", ...options });
const text = (reply: { bytes: Uint8Array }) => new TextDecoder().decode(reply.bytes);
const marked = () => composio.appsNeedingReconnect(cfg).flatMap(app => app.accounts.map(a => a.id)).sort();
/** The inventory lists these accounts as lapsed: one forced read opens the mark. */
async function lapse(ids: string[]) {
  for (const account of accounts.gmail!) if (ids.includes(account.id)) account.status = "EXPIRED";
  await composio.connectedInventory(cfg, { force: true, fresh: true });
  expect(marked()).toEqual([...ids].sort());
  reads = 0;
}
/** The relay's answer, or "hung" when it has not answered inside 3 s + 1 s: a hang is an assertion failure, not a test timeout. */
const answered = (call: Promise<Awaited<ReturnType<typeof dispatch>>>) =>
  Promise.race([call, new Promise<"hung">(resolve => setTimeout(() => resolve("hung"), 4_000))]);
const age = () => { clock += 61_000; };
const UNAVAILABLE = /connected-apps service/;
const RECONNECT = /reconnect|sign in again|signed out/i;

it.each([1, 10, 1000])("G29-W4 [N=%i] a stale mark, reconnected elsewhere, aged snapshot: one fetch, one broker call, no refusal", async (n) => {
  for (let i = 0; i < n - 2; i++) accounts.gmail!.push({ id: `X${i}`, status: "ACTIVE" });
  await lapse(["A"]);
  accounts.gmail![0]!.status = "ACTIVE"; // the owner reconnected it on the Flux site
  age();
  const onReconnect = vi.fn();
  const reply = await dispatch(["A"], { onReconnect });
  expect(reads, `N=${n}`).toBe(1);
  expect(calls, `N=${n}`).toHaveLength(1);
  expect(reply.delivery, `N=${n}`).not.toBe("not-sent");
  expect(text(reply), `N=${n}`).not.toMatch(RECONNECT);
  expect(onReconnect).not.toHaveBeenCalled();
  expect(marked()).toEqual([]);
});

it("G29-W5 no mark and a mark on a fresh snapshot ask nothing; only a mark on an aged snapshot asks, once", async () => {
  age();
  await dispatch(["A"]);
  expect(reads).toBe(0);
  expect(calls).toHaveLength(1);
  await lapse(["A"]); // snapshot is fresh now
  const onReconnect = vi.fn();
  const refused = await dispatch(["A"], { onReconnect });
  expect(reads).toBe(0);
  expect(refused.delivery).toBe("not-sent");
  expect(text(refused)).toMatch(RECONNECT);
  expect(onReconnect).toHaveBeenCalledTimes(1);
  expect(calls).toHaveLength(1);
  accounts.gmail![0]!.status = "ACTIVE"; // reconnected elsewhere; the snapshot ages
  age();
  const reply = await dispatch(["A"]);
  expect(reads).toBe(1);
  expect(calls).toHaveLength(2);
  expect(reply.delivery).not.toBe("not-sent");
});

it("G29-W6 the refresh throws (503): unavailable line, not-sent, no card, never the reconnect text", async () => {
  await lapse(["A"]);
  age();
  inventoryStatus = 503;
  const onReconnect = vi.fn();
  const reply = await dispatch(["A"], { onReconnect });
  expect(reads).toBe(1);
  expect(reply.delivery).toBe("not-sent");
  expect(text(reply)).toMatch(UNAVAILABLE);
  expect(text(reply)).not.toMatch(RECONNECT);
  expect(onReconnect).not.toHaveBeenCalled();
  expect(calls).toHaveLength(0);
});

it("G29-W6b(i) the refresh is under backoff (a prior 502 with Retry-After): unavailable line, no reconnect text, no broker call", async () => {
  await lapse(["A"]);
  inventoryStatus = 502; // a service fault with Retry-After: the inventory backs off, the broker itself is not refused
  await composio.connectedInventory(cfg, { force: true, fresh: true }).catch(() => undefined);
  reads = 0; age(); // aged snapshot, retry-after 600 s still ahead
  const reply = await dispatch(["A"]);
  expect(reads).toBe(0);
  expect(reply.delivery).toBe("not-sent");
  expect(text(reply)).toMatch(UNAVAILABLE);
  expect(text(reply)).not.toMatch(RECONNECT);
  expect(calls).toHaveLength(0);
});

it("G29-W6b(ii) an aged snapshot and a broker that never answers: the relay answers inside 3 s + 1 s", async () => {
  await lapse(["A"]);
  age();
  hangInventory = true;
  const reply = await answered(dispatch(["A"]));
  if (reply === "hung") expect.fail("the relay waited on a hung inventory past 3 s + 1 s");
  expect(reads).toBe(1);
  expect(reply.delivery).toBe("not-sent");
  expect(text(reply)).toMatch(UNAVAILABLE);
  expect(text(reply)).not.toMatch(RECONNECT);
  expect(calls).toHaveLength(0);
}, 12_000);

it("G29-W6b(iii) an invalidation lands during the refresh and the second fetch hangs: still inside the one deadline", async () => {
  await lapse(["A"]);
  age();
  onRead = () => { if (reads === 1) { invalidateInventory(null); hangFrom = 2; } };
  const reply = await answered(dispatch(["A"]));
  if (reply === "hung") expect.fail("the relay waited on a hung settle re-fetch past 3 s + 1 s");
  expect(reads).toBe(2);
  expect(reply.delivery).toBe("not-sent");
  expect(text(reply)).toMatch(UNAVAILABLE);
  expect(calls).toHaveLength(0);
}, 12_000);

it("G29-W7 No limits, two accounts, both regained: one fetch, both rows reach the broker", async () => {
  await lapse(["A", "B"]);
  for (const account of accounts.gmail!) account.status = "ACTIVE";
  age();
  const reply = await dispatch(["A", "B"], { noLimits: true });
  expect(reads).toBe(1);
  expect(calls).toHaveLength(1);
  expect(calls[0].params.arguments.tools).toHaveLength(2);
  expect(text(reply)).not.toMatch(RECONNECT);
});

it("G29-W7b No limits, one account marked and the refresh fails: the healthy account's read goes through, the marked one says unavailable", async () => {
  await lapse(["A"]);
  inventoryStatus = 502; // a service fault with Retry-After: the inventory backs off, the broker itself is not refused
  await composio.connectedInventory(cfg, { force: true, fresh: true }).catch(() => undefined);
  reads = 0; age();
  const started = performance.now();
  const reply = await dispatch(["A", "B"], { noLimits: true });
  expect(performance.now() - started).toBeLessThan(4_000);
  expect(reads).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0].params.arguments.tools).toEqual([tool("B")]);
  expect(text(reply)).toMatch(UNAVAILABLE);
  expect(text(reply)).not.toMatch(RECONNECT);
});
