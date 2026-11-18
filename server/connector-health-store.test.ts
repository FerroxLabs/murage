import { mkdtempSync, statSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConnectorHealthStore, RECONNECT_COOLDOWN_MS } from "./connector-health-store.ts";
import { startConnectorHealthMonitor, CONNECTOR_HEALTH_INTERVAL_MS } from "./connector-health-monitor.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe("durable connector incident", () => {
  it("retains identity, failed accounts and cooldown across process restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "connector-health-"));
    try {
      let now = 1;
      const file = join(dir, "health.json");
      let store = new ConnectorHealthStore(file, () => now);
      expect(store.mark("owner", "buffer", "HTTP 401", "account-1")).toBe(true);
      store.update("owner", "buffer", { accounts: [{ id: "account-1", alias: "work" }] });
      const id = store.get("owner", "buffer")!.incidentId;
      store = new ConnectorHealthStore(file, () => now);
      expect(store.get("owner", "buffer")).toMatchObject({ incidentId: id, accounts: [{ id: "account-1", alias: "work" }] });
      expect(store.mark("owner", "buffer", "HTTP 401", "")).toBe(false);
      expect(store.get("owner", "buffer")!.accountKey).toBe("account-1");
      expect(store.due("owner", "buffer")).toBe(true);
      store.delivered("owner", "buffer");
      store = new ConnectorHealthStore(file, () => now);
      expect(store.due("owner", "buffer")).toBe(false);
      store.clear("owner", "buffer");
      store.mark("owner", "buffer", "HTTP 401", "account-2");
      expect(store.due("owner", "buffer")).toBe(false);
      now += RECONNECT_COOLDOWN_MS;
      expect(store.due("owner", "buffer")).toBe(true);
      expect(store.slugs("another-owner")).toEqual([]);
      store.rekey("owner", "renewed-credential");
      store = new ConnectorHealthStore(file, () => now);
      expect(store.slugs("owner")).toEqual([]);
      expect(store.slugs("renewed-credential")).toEqual(["buffer"]);
    } finally { removeTempDir(dir); }
  });
  it("ignores a terminal MCP failure delivered after a newer sign-in projection", () => {
    const dir = mkdtempSync(join(tmpdir(), "connector-order-"));
    try {
      const file = join(dir, "health.json");
      let store = new ConnectorHealthStore(file, () => 100);
      store.observeCredential("mcp-owner", "mcp-tools", true, 10);
      expect(store.slugs("mcp-owner")).toEqual(["mcp-tools"]);
      store.observeCredential("mcp-owner", "mcp-tools", false, 20, 101);
      expect(store.slugs("mcp-owner")).toEqual([]);
      store = new ConnectorHealthStore(file, () => 102);
      store.observeCredential("mcp-owner", "mcp-tools", true, 10);
      expect(store.slugs("mcp-owner")).toEqual([]);
    } finally { removeTempDir(dir); }
  });
  it("checks at boot and on a bounded schedule, without overlapping slow reads", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const check = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const stop = startConnectorHealthMonitor(check);
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(check).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(CONNECTOR_HEALTH_INTERVAL_MS * 3);
      expect(check).toHaveBeenCalledTimes(1);
      release(); await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(CONNECTOR_HEALTH_INTERVAL_MS);
      expect(check).toHaveBeenCalledTimes(2);
      stop(); release(); await vi.advanceTimersByTimeAsync(CONNECTOR_HEALTH_INTERVAL_MS * 2);
      expect(check).toHaveBeenCalledTimes(2);
    } finally { stop(); vi.useRealTimers(); }
  });
});

it("P2-5 journal bytes for one changed account are constant at 10 and 1000 incidents", () => {
  const costs: number[] = [];
  for (const count of [10, 1000]) {
    const dir = mkdtempSync(join(tmpdir(), "connector-cost-"));
    try {
      const file = join(dir, "health.json");
      let store = new ConnectorHealthStore(file, () => 1);
      store.batch(() => { for (let n = 0; n < count; n++) store.mark("owner", `app${n}`, "expired", `account${n}`); });
      const initial = statSync(`${file}.journal`).size;
      store.update("owner", "app0", { replaces: ["account0"] });
      const changed = statSync(`${file}.journal`).size;
      costs.push(changed - initial);
      store.update("owner", "app0", { replaces: ["account0"] });
      expect(statSync(`${file}.journal`).size).toBe(changed);
      appendFileSync(`${file}.journal`, "torn final record");
      store = new ConnectorHealthStore(file, () => 1);
      store.mark("owner", "after-crash", "expired", null);
      expect(new ConnectorHealthStore(file).slugs("owner")).toHaveLength(count + 1);
    } finally { removeTempDir(dir); }
  }
  expect(costs[1]).toBe(costs[0]);
});

it("per-account incidents survive restart, recovery and account cooldowns independently", () => {
  const dir = mkdtempSync(join(tmpdir(), "connector-accounts-"));
  try {
    const file = join(dir, "health.json");
    let store = new ConnectorHealthStore(file, () => 1);
    store.batch(() => {
      store.mark("owner", "buffer", "expired", "A,B");
      store.update("owner", "buffer", { accounts: [{ id: "A" }, { id: "B" }] });
      store.delivered("owner", "buffer", "A");
    });
    const before = store.get("owner", "buffer")!.accountIncidents!;
    store = new ConnectorHealthStore(file, () => 2);
    expect(store.get("owner", "buffer")!.accountIncidents).toEqual(before);
    expect(store.due("owner", "buffer", "A")).toBe(false);
    expect(store.due("owner", "buffer", "B")).toBe(true);
    store.update("owner", "buffer", { accounts: [{ id: "B" }] });
    expect(store.get("owner", "buffer")!.accountIncidents!.B!.incidentId).toBe(before.B!.incidentId);
    store.update("owner", "buffer", { accounts: [{ id: "A" }, { id: "B" }] });
    expect(store.due("owner", "buffer", "A")).toBe(false);
    expect(store.due("owner", "buffer", "B")).toBe(true);
  } finally { removeTempDir(dir); }
});

it("upgrading a legacy incident keeps its UUID and delivery mark", () => {
  const dir = mkdtempSync(join(tmpdir(), "connector-upgrade-"));
  try {
    const file = join(dir, "health.json");
    writeFileSync(file, JSON.stringify({ v: 1, marks: { owner: { buffer: { at: 1, cause: "expired", accountKey: "A", incidentId: "original-uuid", notifiedAt: 2, accounts: [{ id: "A" }] } } }, cooldowns: { "owner:buffer": 2 }, revisions: {} }));
    const store = new ConnectorHealthStore(file, () => 3);
    store.update("owner", "buffer", { accounts: [{ id: "A" }] });
    expect(store.get("owner", "buffer")!.accountIncidents!.A).toEqual({ incidentId: "original-uuid", at: 1, notifiedAt: 2 });
    expect(store.due("owner", "buffer", "A")).toBe(false);
  } finally { removeTempDir(dir); }
});
