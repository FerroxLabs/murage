// 1.0.20 owner report: an owner whose HighLevel works was asked to "Sign in to HighLevel again" (the band and a Needs
// you row) with no HighLevel line in the server log: no call had failed. The connected-apps inventory held a stale
// HighLevel row that was not active, and the inventory read alone opened the incident. For HighLevel only a real call
// proves a lapse: a 401 on the call, or a failed call while the row says it is no longer active. A call that succeeds
// ends it. Other apps keep the inventory rule (asserted last).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as composio from "./composio.ts";
import { connectorHealthStore } from "./connected-app-health.ts";
import type { AppConfig } from "./config.ts";

const cfg = {} as AppConfig;
let accounts: Record<string, Array<{ id: string; alias?: string; status: string }>>;
let calls: any[], probe: string, reply: any;
let clock = 50_000_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
beforeEach(async () => {
  composio.resetManagedBrokerState(); connectorHealthStore().clearAll();
  clock += 4_000_000; vi.spyOn(Date, "now").mockImplementation(() => clock);
  accounts = { highlevel: [{ id: "H", alias: "agency", status: "ACTIVE" }], gmail: [{ id: "G", alias: "work", status: "ACTIVE" }] };
  calls = []; probe = "ok"; reply = undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) return json({ ready: true });
    if (url.endsWith("/connected")) return json({ services: Object.fromEntries(Object.entries(accounts).map(([slug, list]) => [slug, { connected: true, status: "ACTIVE", accounts: list }])) });
    const body = JSON.parse(String(init?.body)); calls.push(body);
    const value = reply ?? (probe === "upstreamAuth" ? { status: 401 } : probe === "toolError" ? { successful: false, error: "fixture tool failure" } : { successful: true });
    return json({ jsonrpc: "2.0", id: body.id, result: { isError: probe !== "ok", content: [{ type: "text", text: JSON.stringify(value) }] } });
  }));
  composio.applyManagedBrokerMessage({ type: "murage:managed-composio", access: null, fluxBrokerUrl: "http://127.0.0.1:49322/composio", fluxAccess: { url: "http://127.0.0.1:49322/composio", token: "c".repeat(64) }, legacyUntil: "", legacyClaim: { state: "none" }, accountKind: null, tokenError: null });
  await composio.primeBrokerReadiness(); await composio.connectedInventory(cfg, { force: true, fresh: true });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); composio.resetManagedBrokerState(); connectorHealthStore().clearAll(); });

let id = 0;
const callHighLevel = () => composio.relayConnectedAppCall(cfg, { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "HIGHLEVEL_SEARCH_CONTACTS", arguments: { account: "H", query: `fixture ${id}` } } }, undefined, undefined, { botId: "hl-fixture" });
const read = () => composio.connectedInventory(cfg, { force: true, fresh: true });
const askingFor = (slug: string) => composio.reconnectIncidents(cfg).filter(incident => incident.slug === slug).flatMap(incident => incident.accounts.map(account => account.id));

it("HL1 a HighLevel row that is not active, with no call at all, asks nothing (no band, no Needs you row)", async () => {
  accounts.highlevel![0]!.status = "EXPIRED";
  await read(); await read();
  expect(calls).toHaveLength(0);
  expect(askingFor("highlevel")).toEqual([]);
  expect(composio.appsNeedingReconnect(cfg).map(app => app.slug)).not.toContain("highlevel");
});

it("HL2 an incident an earlier inventory read opened from the row alone ends on the next read", async () => {
  // The owner's stored state: the 1.0.19/1.0.20 inventory read marked HighLevel with no failed call.
  accounts.gmail![0]!.status = "EXPIRED";
  accounts.highlevel![0]!.status = "EXPIRED";
  await read();
  const owner = composio.reconnectIncidents(cfg)[0]!.owner;
  connectorHealthStore().mark(owner, "highlevel", "sign-in no longer accepted", "");
  connectorHealthStore().update(owner, "highlevel", { accounts: [{ id: "H", alias: "agency" }] });
  expect(askingFor("highlevel")).toEqual(["H"]);
  await read();
  expect(askingFor("highlevel")).toEqual([]);
  expect(askingFor("gmail")).toEqual(["G"]);
});

it("HL3 a real 401 on a HighLevel call asks for that account; a quiet read keeps it; a finished Reconnect ends it", async () => {
  probe = "upstreamAuth";
  await callHighLevel();
  expect(calls).toHaveLength(1);
  expect(askingFor("highlevel")).toEqual(["H"]);
  await read();
  expect(askingFor("highlevel")).toEqual(["H"]);
  // The relay sends nothing more to an account that answered 401 (it is not retried until it is reconnected).
  probe = "ok";
  await callHighLevel();
  expect(calls).toHaveLength(1);
  expect(askingFor("highlevel")).toEqual(["H"]);
  // The owner's Reconnect finishes: a new active account replaces the old one.
  accounts.highlevel = [{ id: "H2", alias: "agency", status: "ACTIVE" }];
  await read();
  expect(askingFor("highlevel")).toEqual([]);
});

it("HL4 a failed HighLevel call while its row says it is no longer active asks; a quiet read keeps it; signing in again ends it", async () => {
  accounts.highlevel![0]!.status = "EXPIRED";
  probe = "toolError";
  await callHighLevel();
  expect(calls).toHaveLength(1);
  expect(askingFor("highlevel")).toEqual(["H"]);
  clock += 10 * 60_000;
  await read();
  expect(askingFor("highlevel")).toEqual(["H"]);
  // The owner signs the account in again: the inventory shows it active, and the next read ends the incident.
  accounts.highlevel![0]!.status = "ACTIVE";
  await read();
  expect(askingFor("highlevel")).toEqual([]);
});

it("HL5 other apps are unchanged: a Gmail row that is not active still asks from the inventory", async () => {
  accounts.gmail![0]!.status = "EXPIRED";
  await read();
  expect(askingFor("gmail")).toEqual(["G"]);
});

// 1.0.20 hlstrip (Murage's own HighLevel removed): an incident an older build saved from the row alone ends once at start,
// with no network read; a HighLevel mark a failed call opened, and every other app's mark, stay.
it("HLS1 start retires a saved row-only HighLevel prompt and nothing else", () => {
  const store = connectorHealthStore(); store.clearAll();
  store.mark("owner-a", "highlevel", "sign-in no longer accepted", "");
  store.mark("owner-a", "gmail", "sign-in no longer accepted", "");
  store.mark("owner-b", "highlevel", "sign-in no longer accepted after a failed call", "");
  expect(composio.retireRowOnlyHighLevelMarks()).toBe(1);
  expect(store.get("owner-a", "highlevel")).toBeUndefined();
  expect(store.get("owner-a", "gmail")?.cause).toBe("sign-in no longer accepted");
  expect(store.get("owner-b", "highlevel")?.cause).toBe("sign-in no longer accepted after a failed call");
  expect(composio.retireRowOnlyHighLevelMarks()).toBe(0);
});
