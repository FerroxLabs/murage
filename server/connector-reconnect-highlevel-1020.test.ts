// 1.0.20 owner report: an owner whose HighLevel works was asked to "Sign in to HighLevel again" (the band and a Needs
// you row) with no HighLevel line in the server log: no call had failed. The connected-apps inventory held a stale
// HighLevel row that was not active, and the inventory read alone opened the incident. For HighLevel only a real call
// proves a lapse: a 401 on the call, or a failed call while the row says it is no longer active. A call that succeeds
// ends it. Other apps keep the inventory rule (asserted last). 1.0.20 hlstrip (MAIN 12:40Z): HighLevel now never asks,
// even after a refused call (HL3, HL4, HLN1).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as composio from "./composio.ts";
import { connectorHealthStore } from "./connected-app-health.ts";
import type { AppConfig } from "./config.ts";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconnectApps } from "./reconnect-apps.ts";
import { HIGHLEVEL_MOVED_LINE, takeHighLevelMovedLine } from "./highlevel-moved-notice.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

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

// MAIN 12:40Z (Sean, 1.0.20): HL3/HL4 used to expect a HighLevel prompt after a refused or failed call (hlbanner part B,
// reverted on final3 at 7fdbfb468e). Murage's own HighLevel is gone and HighLevel never asks to sign in again: the call
// fails as itself, and nothing asks, now or on the next read.
it("HL3 a real 401 on a HighLevel call asks nothing; a quiet read asks nothing; the next call still goes out", async () => {
  probe = "upstreamAuth";
  await callHighLevel();
  expect(calls).toHaveLength(1);
  expect(askingFor("highlevel")).toEqual([]);
  await read();
  expect(askingFor("highlevel")).toEqual([]);
  probe = "ok";
  await callHighLevel();
  expect(calls).toHaveLength(2);
  expect(askingFor("highlevel")).toEqual([]);
});

it("HL4 a failed HighLevel call while its row says it is no longer active asks nothing, then or on a later read", async () => {
  accounts.highlevel![0]!.status = "EXPIRED";
  probe = "toolError";
  await callHighLevel();
  expect(calls).toHaveLength(1);
  expect(askingFor("highlevel")).toEqual([]);
  clock += 10 * 60_000;
  await read();
  expect(askingFor("highlevel")).toEqual([]);
  expect(composio.reconnectSystemPrompt(cfg)).not.toMatch(/highlevel/i);
});

it("HL5 other apps are unchanged: a Gmail row that is not active still asks from the inventory", async () => {
  accounts.gmail![0]!.status = "EXPIRED";
  await read();
  expect(askingFor("gmail")).toEqual(["G"]);
});

// 1.0.20 hlstrip (Murage's own HighLevel removed; MAIN 12:40Z): every HighLevel incident an older build saved ends once
// at start, with no network read, whatever opened it; every other app's mark stays.
it("HLS1 start retires every saved HighLevel prompt and nothing else", () => {
  const store = connectorHealthStore(); store.clearAll();
  store.mark("owner-a", "highlevel", "sign-in no longer accepted", "");
  store.mark("owner-a", "gmail", "sign-in no longer accepted", "");
  store.mark("owner-b", "highlevel", "sign-in no longer accepted after a failed call", "");
  store.mark("owner-b", "mcp-highlevel", "sign-in no longer accepted", "");
  expect(composio.retireHighLevelSignInMarks()).toBe(2);
  expect(store.get("owner-a", "highlevel")).toBeUndefined();
  expect(store.get("owner-b", "highlevel")).toBeUndefined();
  expect(store.get("owner-a", "gmail")?.cause).toBe("sign-in no longer accepted");
  // An owner's own MCP server (the path the moved line points to) keeps its own sign-in.
  expect(store.get("owner-b", "mcp-highlevel")?.cause).toBe("sign-in no longer accepted");
  expect(composio.retireHighLevelSignInMarks()).toBe(0);
});

// 1.0.20 (MAIN 12:40Z, Sean's Mac on a pre-strip build showed the band "HighLevel needs you to sign in again / Reconnect
// / Later" AND the Needs you row "Sign in to HighLevel again"): with Murage's own HighLevel removed, an expired stored
// HighLevel token asks nothing anywhere. Every surface (band, Needs you, tray, push, the bot's reconnect line) reads the
// same incidents, so the witness drives the real store, the real inventory read and the real relay, then reads the
// incidents and the band's rows (server/reconnect-apps.ts), the only inputs of the Needs you lines. The one moved line still
// shows once. Gmail is the control: the same inputs still ask for it.
it("HLN1 an expired stored HighLevel token: no band, no Needs you row, no sign-in card; the moved line shows once", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hl-expired-"));
  try {
    // Sean's stored state: the native token is still saved (expired) and its folder is there; the connected-apps
    // rows are expired; an older build saved HighLevel marks of both kinds.
    mkdirSync(join(dataDir, "highlevel")); writeFileSync(join(dataDir, "highlevel", "token.json"), JSON.stringify({ expiresAt: 1 }));
    const notice = { dataDir, privateToken: "pit-fixture-expired", bots: [] };
    accounts.highlevel = [{ id: "H", alias: "agency", status: "EXPIRED" }, { id: "H3", alias: "second", status: "EXPIRED" }];
    accounts.gmail![0]!.status = "EXPIRED";
    await read();
    const owner = composio.reconnectIncidents(cfg).find(incident => incident.slug === "gmail")!.owner;
    const store = connectorHealthStore();
    store.mark(owner, "highlevel", "sign-in no longer accepted after a failed call", "");
    store.update(owner, "highlevel", { accounts: [{ id: "H", alias: "agency" }] });
    // Start, then a bot calls HighLevel through connected apps and the call is refused (401), then a failed call.
    composio.retireHighLevelSignInMarks();
    probe = "upstreamAuth"; await callHighLevel();
    probe = "toolError"; clock += 10 * 60_000; await callHighLevel();
    await read();
    const incidents = composio.reconnectIncidents(cfg);
    const band = reconnectApps(incidents);
    expect(band.map(app => app.slug)).toEqual(["gmail"]);
    expect(composio.appsNeedingReconnect(cfg).map(app => app.slug)).toEqual(["gmail"]);
    expect(composio.reconnectSystemPrompt(cfg)).not.toMatch(/highlevel/i);
    // The Needs you reconnect lines are built one per band row (src/lib/today-needs.ts), and the tray, push and Needs
    // you connection rows one per incident app (server/index.ts onePerApp(connectorIncidents())): none names HighLevel.
    expect([...new Set(incidents.map(incident => incident.slug))]).toEqual(["gmail"]);
    expect(JSON.stringify({ incidents, band })).not.toMatch(/highlevel/i);
    expect(takeHighLevelMovedLine(notice)).toBe(HIGHLEVEL_MOVED_LINE);
    expect(takeHighLevelMovedLine(notice)).toBeNull();
    expect(readFileSync(join(dataDir, "highlevel", "token.json"), "utf8")).toBe(JSON.stringify({ expiresAt: 1 }));
    // The calls really went out (the refusal came from HighLevel, not from a relay that never sent them).
    expect(calls).toHaveLength(2);
  } finally { removeTempDirSync(dataDir); }
});
