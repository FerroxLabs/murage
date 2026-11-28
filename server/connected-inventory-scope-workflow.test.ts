// K17 S2 (#29): the owner incarnation scope, end to end. Entry points: the real GET /api/connectors/connected of a
// booted server (owner changes through applyManagedBrokerMessage, restarts over the same data dir) and the
// renderer's preloadConnectedApps reading that route.
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { launchVerificationServer } from "../scripts/control-murage.ts";

const hoisted = vi.hoisted(() => ({ base: "", headers: {} as Record<string, string>, down: false }));
vi.mock("@/state/store", () => ({
  api: async (path: string) => {
    if (hoisted.down) throw new Error("service cannot be asked");
    const response = await fetch(`${hoisted.base}${path}`, { headers: hoisted.headers });
    if (!response.ok) throw new Error(`api ${response.status}`);
    return response.json();
  },
}));

const PROOF = "ab".repeat(32);
const OWNER_A = "a".repeat(16);
const OWNER_B = "b".repeat(16);
const gmailA = { gmail: { connected: true, status: "ACTIVE", accounts: [{ id: "acct-a1", alias: "alpha", status: "ACTIVE" }] } };
const notionB = { notion: { connected: true, status: "ACTIVE", accounts: [{ id: "acct-b1", alias: "beta", status: "ACTIVE" }] } };

let inventoryBody: Record<string, unknown> = gmailA;
let brokerReady = true;
let broker: ReturnType<typeof createServer>;
let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
let ctl: string;
let cmdSeq = 0;

class MemoryStorage {
  data = new Map<string, string>();
  failWrites = false;
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failWrites) throw new Error("quota"); this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
const storage = new MemoryStorage();
const SAVED = "murage-connected-apps";

beforeAll(async () => {
  broker = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/health")) return void res.end(JSON.stringify({ ready: brokerReady }));
    if (req.url?.endsWith("/v1/connectors/connected")) return void res.end(JSON.stringify({ services: inventoryBody }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>(resolve => broker.listen(0, "127.0.0.1", resolve));
  const port = (broker.address() as { port: number }).port;
  ctl = mkdtempSync(join(tmpdir(), "k17s2-ctl-"));
  writeFileSync(join(ctl, "owner.json"), JSON.stringify({ seq: 0, owner: OWNER_A, token: "c".repeat(64) }));
  const moduleUrl = new URL("./composio.ts", import.meta.url).href;
  fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: "c".repeat(64) }, instrumentationSource: `
    process.env.MURAGE_DEV_DESKTOP_SECRET = ${JSON.stringify(PROOF)};
    process.env.MURAGE_MCP_COMMIT_TOKEN = ${JSON.stringify(PROOF)};
    const { readFileSync } = await import("node:fs");
    const { applyManagedBrokerMessage, primeBrokerReadiness, noteConnectorUse, bumpAccessRevisionForTests } = await import(${JSON.stringify(moduleUrl)});
    const apply = (cmd) => applyManagedBrokerMessage({ type: "murage:managed-composio", access: null,
      fluxBrokerUrl: "http://127.0.0.1:${port}/composio", fluxAccess: { url: "http://127.0.0.1:${port}/composio", token: cmd.token },
      fluxOwner: cmd.owner, legacyUntil: "", legacyClaim: { state: "none" }, accountKind: null, tokenError: null });
    const read = () => JSON.parse(readFileSync(${JSON.stringify(join(ctl, "owner.json"))}, "utf8"));
    // A launch names its owner through the environment (no change message): what was held on disk is kept.
    const boot = read();
    process.env.MURAGE_FLUX_COMPOSIO_BROKER_URL = "http://127.0.0.1:${port}/composio";
    process.env.MURAGE_FLUX_COMPOSIO_BROKER_TOKEN = boot.token;
    process.env.MURAGE_FLUX_COMPOSIO_OWNER = boot.owner;
    let seen = boot.seq;
    const step = async () => { const cmd = read(); if (cmd.seq === seen) return; seen = cmd.seq; if (cmd.bump) bumpAccessRevisionForTests({}); else apply(cmd); await primeBrokerReadiness(); };
    await primeBrokerReadiness();
    noteConnectorUse();
    setInterval(() => { step().catch(() => {}); }, 40);
  ` });
  hoisted.base = fixture.info.url;
  hoisted.headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": PROOF };
}, 180_000);

afterAll(async () => {
  await fixture?.close();
  await new Promise<void>(resolve => broker?.close(() => resolve()));
});

/** Tell the running server what changed, through the same entry the desktop shell uses, and wait for it to apply. */
async function command(change: { owner: string; token: string } | { bump: true }) {
  const seq = ++cmdSeq;
  writeFileSync(join(ctl, "owner.json"), JSON.stringify({ seq, ...("bump" in change ? { bump: true, owner: "", token: "" } : change) }));
  await new Promise(resolve => setTimeout(resolve, 400));
}
const route = async (query = "") => {
  const response = await fetch(`${fixture.info.url}/api/connectors/connected${query}`, { headers: hoisted.headers });
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
};
const savedEntry = () => { const raw = storage.getItem(SAVED); return raw ? JSON.parse(raw) : null; };
async function newWindow() {
  vi.resetModules();
  vi.stubGlobal("localStorage", storage);
  // A computed specifier keeps the renderer module out of the server type-check program (it resolves "@/" through the frontend config).
  return import("../src/lib/" + "connected-apps-preload.ts");
}
const settled = async (answer: () => Promise<any>) => {
  const deadline = Date.now() + 8_000;
  let last: any;
  do { last = await answer(); if (last.revalidating !== true) return last; await new Promise(r => setTimeout(r, 200)); } while (Date.now() < deadline);
  return last;
};

it("G29-W2a/W2b/W1/W1b/W1-legacy: scope follows the owner incarnation; a foreign list never survives; null never drops", async () => {
  // owner A: first answer, scope present; stable; kept by an invalidation and by a same-owner rekey
  inventoryBody = gmailA;
  const first = await settled(() => route());
  expect(first.known).toBe(true);
  let scopeA = first.inventoryScope as string;
  expect(typeof scopeA).toBe("string");
  expect(scopeA).toMatch(/^[0-9a-f]{16}$/);
  expect((await route()).inventoryScope).toBe(scopeA);
  await command({ bump: true });
  expect((await settled(() => route("?force=1"))).inventoryScope).toBe(scopeA);
  await command({ owner: OWNER_A, token: "d".repeat(64) }); // same install, re-minted token: rekey
  expect((await settled(() => route("?force=1"))).inventoryScope).toBe(scopeA);

  // an owner change gives the new owner its own scope, and so does coming back: each incarnation is named once
  await command({ owner: OWNER_B, token: "e".repeat(64) });
  inventoryBody = notionB;
  const excursion = (await settled(() => route("?force=1"))).inventoryScope as string;
  expect(typeof excursion).toBe("string");
  expect(excursion).not.toBe(scopeA);
  await command({ owner: OWNER_A, token: "d".repeat(64) });
  inventoryBody = gmailA;
  const returned = (await settled(() => route("?force=1"))).inventoryScope as string;
  expect(typeof returned).toBe("string");
  expect(returned).not.toBe(scopeA);
  expect(returned).not.toBe(excursion);
  scopeA = returned;

  // the window remembers owner A's list with its scope (G29-W1 setup)
  let window1 = await newWindow();
  const seenA = await settled(() => window1.preloadConnectedApps(true));
  expect(Object.keys(seenA.services)).toEqual(["gmail"]);
  expect(seenA.confirmed).toBe(true);
  expect(savedEntry().scope).toBe(scopeA);

  // G29-W2b upgrade from 1.0.22: a v1 file loads, a new scope is minted, the list is served
  const inventoryFile = join(fixture.info.dataDir, "connected-apps-inventory.json");
  const v2 = JSON.parse(readFileSync(inventoryFile, "utf8"));
  expect(v2.v).toBe(2);
  expect(v2.scope).toBe(scopeA);
  await fixture.restart();
  const afterRestartV2 = await settled(() => route());
  expect(afterRestartV2.inventoryScope).toBe(scopeA); // restart with a v2 file: scope kept
  const { scope: _drop, ...legacyFile } = v2; // eslint-disable-line @typescript-eslint/no-unused-vars
  writeFileSync(inventoryFile, JSON.stringify({ ...legacyFile, v: 1 }));
  await fixture.restart();
  const afterRestartV1 = await settled(() => route());
  expect(afterRestartV1.known).toBe(true);
  expect(Object.keys(afterRestartV1.services)).toEqual(["gmail"]);
  expect(typeof afterRestartV1.inventoryScope).toBe("string");
  expect(afterRestartV1.inventoryScope).toMatch(/^[0-9a-f]{16}$/);
  expect(afterRestartV1.inventoryScope).not.toBe(scopeA); // v1 load mints a new scope

  // G29-W1: owner switch A -> B while the saved copy cannot be rewritten (full storage): A's list must still be gone
  await command({ owner: OWNER_B, token: "e".repeat(64) });
  inventoryBody = notionB;
  storage.failWrites = true;
  const viaB = await settled(() => window1.preloadConnectedApps(true));
  expect(Object.keys(viaB.services)).toEqual(["notion"]);
  expect(viaB.confirmed).toBe(true);
  const scopeB = (await route()).inventoryScope as string;
  expect(typeof scopeB).toBe("string");
  expect(scopeB).toMatch(/^[0-9a-f]{16}$/);
  expect(scopeB).not.toBe(scopeA); // owner change: new scope
  storage.failWrites = false;
  const window2 = await newWindow();
  hoisted.down = true;
  const cold = await window2.preloadConnectedApps(true); // the service cannot be asked: nothing of A may come back
  hoisted.down = false;
  expect(JSON.stringify(cold.services)).not.toContain("gmail");
  expect(storage.getItem(SAVED)).toBeNull();

  // G29-W1b: relaunch, same owner, first answer not ready (no held list, scope null): the remembered list stays, unconfirmed
  const window3 = await newWindow();
  const confirmedB = await settled(() => window3.preloadConnectedApps(true));
  expect(Object.keys(confirmedB.services)).toEqual(["notion"]);
  expect(savedEntry().scope).toBe(scopeB);
  rmInventoryFile(inventoryFile);
  brokerReady = false;
  await fixture.restart();
  const window4 = await newWindow();
  const notReady = await window4.preloadConnectedApps(true);
  expect(notReady.confirmed).toBe(false);
  expect(Object.keys(notReady.services)).toEqual(["notion"]);
  expect(savedEntry()?.scope).toBe(scopeB);
  expect(window4.isRememberedUnconfirmed()).toBe(true);
  brokerReady = true;

  // G29-W1-legacy: a 1.0.22 entry with no scope: shown, kept on a null answer, replaced on the first non-null one
  storage.setItem(SAVED, JSON.stringify({ at: 1, services: { gmail: { connected: true } } }));
  brokerReady = false;
  const window5 = await newWindow();
  const legacyNull = await window5.preloadConnectedApps(true);
  expect(legacyNull.confirmed).toBe(false);
  expect(Object.keys(legacyNull.services)).toEqual(["gmail"]);
  expect(savedEntry().scope ?? null).toBeNull();
  brokerReady = true;
  await fixture.restart(); // the server's readiness probe only recovers on a new launch
  let legacyAnswered: any;
  for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
    legacyAnswered = await window5.preloadConnectedApps(true);
    if (legacyAnswered.confirmed) break;
    await new Promise(r => setTimeout(r, 500));
  }
  expect(legacyAnswered.confirmed).toBe(true);
  expect(Object.keys(legacyAnswered.services)).toEqual(["notion"]);
  expect(savedEntry().scope).toMatch(/^[0-9a-f]{16}$/);
}, 240_000);

it("G29-W1c: an ordinary ask inside 30 s of an in-process owner switch goes to the server and never confirms the prior owner's list", async () => {
  await command({ owner: OWNER_A, token: "d".repeat(64) });
  inventoryBody = gmailA;
  const win = await newWindow();
  const heldA = await settled(() => win.preloadConnectedApps(true));
  expect(Object.keys(heldA.services)).toEqual(["gmail"]); // fresh inside the 30 s window
  await command({ owner: OWNER_B, token: "e".repeat(64) });
  inventoryBody = notionB;
  const firstAsk = await win.preloadConnectedApps(); // not forced: the 30 s window must not answer it
  expect(typeof firstAsk.confirmed).toBe("boolean"); // only an answer through the server carries it
  if (JSON.stringify(firstAsk.services).includes("gmail")) expect(firstAsk.confirmed).toBe(false);
  const afterSwitch = await settled(async () => { const r = await win.preloadConnectedApps(); return r.confirmed === true ? r : { ...r, revalidating: true }; });
  expect(afterSwitch.confirmed).toBe(true);
  expect(Object.keys(afterSwitch.services)).toEqual(["notion"]);
}, 120_000);

function rmInventoryFile(file: string) {
  if (existsSync(file)) writeFileSync(file, "not json"); // unreadable: the relaunch holds nothing, as after a wiped data dir
}
