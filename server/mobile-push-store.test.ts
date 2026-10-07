import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PushStore, initializeMobilePush, type PushEventRow } from "./mobile-push-store.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function open(file = ":memory:") {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys=ON");
  initializeMobilePush(db);
  return new PushStore(db);
}
const B = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3";
function row(overrides: Partial<PushEventRow> = {}): PushEventRow {
  return {
    eventRef: "a".repeat(64), bindingId: B, kind: "approval", category: "approval", botId: "scout", threadId: "t1",
    requestId: "req-1", messageId: "m1", collapseKey: "be753ac14d84299e2b22e52b6dba3a17", threadGroup: "46af17e29b1130f0",
    revision: 1, timeSensitive: true, resolvedBy: null, createdAt: 1000, expiresAt: 100_000, holdUntil: 1000,
    state: "pending", attempts: 0, nextAttemptAt: 1000, ...overrides,
  };
}

describe("PushStore", () => {
  it("migrates a binding without a preview choice to off, persists opt-in, and defaults replacements to off", () => {
    const dir = mkdtempSync(join(tmpdir(), "push-preview-")); dirs.push(dir);
    const file = join(dir, "messages.db");
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE push_bindings (binding_id TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE, publisher_token TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    db.prepare("INSERT INTO push_bindings VALUES (?, 'd1', 'token', 1)").run(B);
    initializeMobilePush(db);
    initializeMobilePush(db);
    const store = new PushStore(db);
    expect(store.binding(B)?.previewContent).toBe(false);
    store.setPreviewContent(B, true);
    db.close();
    const reopened = new DatabaseSync(file);
    initializeMobilePush(reopened);
    const persisted = new PushStore(reopened);
    expect(persisted.binding(B)?.previewContent).toBe(true);
    persisted.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "new", createdAt: 2 });
    expect(persisted.binding(B)?.previewContent).toBe(false);
    reopened.close();
  });

  it("adds an idempotent collapse lookup index to an existing database and uses it in the actual reconcile query", () => {
    const db = new DatabaseSync(":memory:");
    initializeMobilePush(db);
    db.exec("DROP INDEX IF EXISTS push_events_collapse");
    initializeMobilePush(db);
    initializeMobilePush(db);
    expect(db.prepare("PRAGMA index_info(push_events_collapse)").all().map(r => r.name)).toEqual(["binding_id", "collapse_key", "revision"]);
    const prepare = vi.spyOn(db, "prepare");
    new PushStore(db).pendingFor(B, 1000);
    const query = prepare.mock.calls.find(([sql]) => sql.includes("SELECT e.*"))![0];
    prepare.mockRestore();
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(B, 1000).map(r => r.detail).join("\n");
    expect(plan).toMatch(/SEARCH x USING COVERING INDEX push_events_collapse \(binding_id=\? AND collapse_key=\?\)/);
    db.close();
  });

  it("keeps reconciliation results and order across the index migration for mixed revisions and bindings", () => {
    const db = new DatabaseSync(":memory:");
    initializeMobilePush(db);
    db.exec("DROP INDEX IF EXISTS push_events_collapse");
    const store = new PushStore(db);
    store.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "token", createdAt: 1 });
    store.putBinding({ bindingId: "other", deviceId: "d2", publisherToken: "token", createdAt: 1 });
    for (let i = 0; i < 5000; i++) {
      const group = Math.floor(i / 5), revision = i % 5 + 1;
      store.insertEvent(row({ eventRef: String(i).padStart(64, "0"), collapseKey: String(group), revision,
        category: group % 4 === 0 && revision === 5 ? "resolved" : group % 4 === 1 ? "done" : "approval",
        state: group % 4 === 2 ? "dropped" : "sent", expiresAt: group % 8 === 7 ? 500 : 100_000 }));
    }
    store.insertEvent(row({ eventRef: "f".repeat(64), bindingId: "other", collapseKey: "3", revision: 6 }));
    const before = store.pendingFor(B, 1000);
    expect(before).toHaveLength(125);
    expect(before.every(r => r.revision === 5 && r.bindingId === B && Number(r.collapseKey) % 8 === 3)).toBe(true);
    initializeMobilePush(db);
    expect(store.pendingFor(B, 1000)).toEqual(before);
    db.close();
  });
  it("keeps one binding per device and hands back the one it replaced", () => {
    const store = open();
    expect(store.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 })).toBeNull();
    const other = "a1b2c3d4-e5f6-4a1b-8c2d-9e0f1a2b3c4d";
    expect(store.putBinding({ bindingId: other, deviceId: "d1", publisherToken: "murage_pt_y", createdAt: 2 })?.bindingId).toBe(B);
    expect(store.bindings().map((b) => b.bindingId)).toEqual([other]);
  });

  it("gives each binding its own host-only key secret, and one made before secrets existed gets one on first use", () => {
    const store = open();
    store.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
    const other = "a1b2c3d4-e5f6-4a1b-8c2d-9e0f1a2b3c4d";
    store.putBinding({ bindingId: other, deviceId: "d2", publisherToken: "murage_pt_y", createdAt: 2 });
    const secret = store.keySecret(B);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(store.keySecret(B)).toBe(secret);
    expect(store.keySecret(other)).not.toBe(secret);
    // Never part of the binding handed to the relay client.
    expect(JSON.stringify(store.bindings())).not.toContain(secret);
    // A binding written before the upgrade has none yet: it gets one, kept.
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE push_bindings (
      binding_id TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE, publisher_token TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    db.exec(`INSERT INTO push_bindings VALUES ('${B}','d1','murage_pt_x',1)`);
    initializeMobilePush(db);
    initializeMobilePush(db);
    const upgraded = new PushStore(db);
    const minted = upgraded.keySecret(B);
    expect(minted).toMatch(/^[0-9a-f]{64}$/);
    expect(upgraded.keySecret(B)).toBe(minted);
    expect(upgraded.keySecret(other)).toBeNull();
  });

  it("removing a device takes its events with it", () => {
    const store = open();
    store.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
    store.insertEvent(row());
    expect(store.removeDevice("d1")?.bindingId).toBe(B);
    expect(store.event(B, "a".repeat(64))).toBeNull();
    expect(store.removeDevice("d1")).toBeNull();
  });

  it("finds the latest revision for a request, and due work in order", () => {
    const store = open();
    store.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
    store.insertEvent(row());
    store.insertEvent(row({ eventRef: "b".repeat(64), revision: 2, state: "held", holdUntil: 5000, nextAttemptAt: 5000 }));
    expect(store.latestForRequest(B, "req-1")?.revision).toBe(2);
    expect(store.due(2000, 10).map((r) => r.eventRef)).toEqual(["a".repeat(64)]);
    expect(store.due(6000, 10).map((r) => r.eventRef)).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(store.bindingsWithRequest("req-1")).toEqual([B]);
  });

  it("an unrated request is unrated, and a rating survives a new store on the same file", () => {
    const dir = mkdtempSync(join(tmpdir(), "push-store-")); dirs.push(dir);
    const file = join(dir, "messages.db");
    const first = open(file);
    expect(first.risk("t1", "req-1")).toBe("unrated");
    first.rateRisk("t1", "req-1", "low", 1);
    expect(open(file).risk("t1", "req-1")).toBe("low");
  });

  it("a rating is tied to the revision it was made for (H9 fix round 1)", () => {
    const store = open();
    store.rateRisk("t1", "req-1", "low", 1, 1);
    expect(store.risk("t1", "req-1", 1)).toBe("low");
    expect(store.risk("t1", "req-1", 2)).toBe("unrated");
    store.rateRisk("t1", "req-1", "risky", 2, 2);
    expect(store.risk("t1", "req-1", 2)).toBe("risky");
    expect(store.risk("t1", "req-1", 1)).toBe("unrated");
    // Without a revision the rating is stored as for none: unrated for every revision.
    store.rateRisk("t1", "req-1", "low", 3);
    expect(store.risk("t1", "req-1", 2)).toBe("unrated");
    expect(store.risk("t1", "req-1")).toBe("low");
  });

  it("upgrades an H2-era push_risk in place, idempotently, to the same schema a fresh one gets", () => {
    const H2_PUSH_RISK = `CREATE TABLE push_risk (
      request_key TEXT PRIMARY KEY, risk TEXT NOT NULL CHECK (risk IN ('low','risky')), rated_at INTEGER NOT NULL)`;
    const old = new DatabaseSync(":memory:");
    old.exec(H2_PUSH_RISK);
    old.exec("INSERT INTO push_risk VALUES ('t1:req-1','low',1)");
    initializeMobilePush(old);
    initializeMobilePush(old);
    const fresh = new DatabaseSync(":memory:");
    initializeMobilePush(fresh);
    const shape = (db: DatabaseSync) => ({
      sql: String((db.prepare("SELECT sql FROM sqlite_schema WHERE name='push_risk'").get() as { sql: string }).sql).replace(/\s+/g, " "),
      columns: db.prepare("PRAGMA table_xinfo(push_risk)").all(),
    });
    expect(shape(old)).toEqual(shape(fresh));
    expect(shape(fresh).columns.map((c) => c.name)).toEqual(["request_key", "risk", "rated_at", "revision"]);
    // The pre-upgrade row has no revision, so it never allows from the lock screen.
    expect(new PushStore(old).risk("t1", "req-1", 1)).toBe("unrated");
  });

  it("requestRevision is the newest revision of a request across every binding (H10)", () => {
    const store = open();
    const other = "a1b2c3d4-e5f6-4a1b-8c2d-9e0f1a2b3c4d";
    store.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
    store.putBinding({ bindingId: other, deviceId: "d2", publisherToken: "murage_pt_y", createdAt: 2 });
    expect(store.requestRevision("req-1")).toBe(0);
    store.insertEvent(row({ revision: 2 }));
    store.insertEvent(row({ eventRef: "b".repeat(64), bindingId: other, revision: 5 }));
    store.insertEvent(row({ eventRef: "c".repeat(64), requestId: "req-2", revision: 9 }));
    expect(store.requestRevision("req-1")).toBe(5);
    expect(store.requestRevision("req-2")).toBe(9);
  });

  it("nextRevision is past every stored event and the rating's own revision, so a rated number never comes round again (H10 fix round 1)", () => {
    const store = open();
    expect(store.nextRevision("t1", "req-1")).toBe(1);
    // Rated at 4 with no event left (none sent, cascaded away, or pruned).
    store.rateRisk("t1", "req-1", "low", 1, 4);
    expect(store.nextRevision("t1", "req-1")).toBe(5);
    store.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
    store.insertEvent(row({ revision: 7 }));
    expect(store.nextRevision("t1", "req-1")).toBe(8);
    // A base rating with no revision counts as none.
    store.rateRisk("t2", "req-9", "low", 1);
    expect(store.nextRevision("t2", "req-9")).toBe(1);
    const plan = store["db"].prepare("EXPLAIN QUERY PLAN SELECT MAX(revision) FROM push_events WHERE request_id=?").all("req-1") as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(" ")).toContain("push_events_request_id");
  });

  it("decide is first-wins", () => {
    const store = open();
    expect(store.decide("t1", "req-1", "deny", "d1", 1, 1)).toBe(true);
    expect(store.decide("t1", "req-1", "allow", "d2", 1, 2)).toBe(false);
  });

  it("pendingFor lists live attention that is not resolved", () => {
    const store = open();
    store.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
    store.insertEvent(row({ state: "sent" }));
    store.insertEvent(row({ eventRef: "c".repeat(64), kind: "done", category: "done", requestId: null, state: "sent" }));
    store.insertEvent(row({ eventRef: "d".repeat(64), requestId: "req-2", collapseKey: "3ecb0ea09a2136f16314b919767a4aab", expiresAt: 500 }));
    expect(store.pendingFor(B, 1000).map((r) => r.eventRef)).toEqual(["a".repeat(64)]);
    store.insertEvent(row({ eventRef: "e".repeat(64), revision: 2, category: "resolved", resolvedBy: "desktop" }));
    expect(store.pendingFor(B, 1000)).toEqual([]);
  });

  it("updateIfState only writes when the stored state still matches, so a concurrent drop sticks", () => {
    const store = open();
    store.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
    store.insertEvent(row({ attempts: 1 }));
    store.update("a".repeat(64), { state: "dropped" });
    expect(store.updateIfState("a".repeat(64), "pending", { state: "sent" })).toBe(false);
    expect(store.event(B, "a".repeat(64))?.state).toBe("dropped");
    expect(store.updateIfState("a".repeat(64), "dropped", { state: "sent" })).toBe(true);
    expect(store.event(B, "a".repeat(64))?.state).toBe("sent");
  });

  it("prune removes expired events and old ratings", () => {
    const store = open();
    store.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
    store.insertEvent(row({ expiresAt: 10 }));
    store.rateRisk("t1", "req-1", "risky", 0);
    store.prune(8 * 24 * 3600_000);
    expect(store.event(B, "a".repeat(64))).toBeNull();
    expect(store.risk("t1", "req-1")).toBe("unrated");
  });

  describe("relay removals", () => {
    const other = "a1b2c3d4-e5f6-4a1b-8c2d-9e0f1a2b3c4d";
    const DAY = 24 * 3600_000;

    it("a displaced binding is queued for removal at the relay, with its token", () => {
      const store = open();
      store.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
      expect(store.dueRelayRemovals(10, 10)).toEqual([]);
      store.putBinding({ bindingId: other, deviceId: "d1", publisherToken: "murage_pt_y", createdAt: 2 });
      expect(store.dueRelayRemovals(10, 10)).toEqual([{ bindingId: B, publisherToken: "murage_pt_x", attempts: 0, nextAttemptAt: 2, createdAt: 2 }]);
    });

    it("removing a device, or a binding, queues it; a binding the relay already forgot does not", () => {
      const store = open();
      store.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
      store.putBinding({ bindingId: other, deviceId: "d2", publisherToken: "murage_pt_y", createdAt: 1 });
      expect(store.removeDevice("d9", 5)).toBeNull();
      store.removeDevice("d1", 5);
      store.removeBinding(other, { atRelay: false });
      expect(store.dueRelayRemovals(10, 10).map((r) => r.bindingId)).toEqual([B]);
      store.putBinding({ bindingId: other, deviceId: "d2", publisherToken: "murage_pt_y", createdAt: 6 });
      store.removeBinding(other);
      expect(store.dueRelayRemovals(Date.now(), 10).map((r) => r.bindingId).sort()).toEqual([B, other].sort());
    });

    it("putBinding is atomic: a failed insert keeps the old binding and queues nothing", () => {
      const store = open();
      store.putBinding({ bindingId: B, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
      store.putBinding({ bindingId: other, deviceId: "d2", publisherToken: "murage_pt_y", createdAt: 1 });
      expect(() => store.putBinding({ bindingId: other, deviceId: "d1", publisherToken: "murage_pt_z", createdAt: 2 })).toThrow();
      expect(store.bindingForDevice("d1")?.bindingId).toBe(B);
      expect(store.dueRelayRemovals(10, 10)).toEqual([]);
    });

    it("backs off on failure, forgets on success, and gives up after thirty days", () => {
      const store = open();
      store.enqueueRelayRemoval({ bindingId: B, publisherToken: "murage_pt_x" }, 1000);
      store.enqueueRelayRemoval({ bindingId: B, publisherToken: "murage_pt_x" }, 9999);
      expect(store.relayRemovalFailed(B, 1000)).toBe("retry");
      expect(store.dueRelayRemovals(1999, 10)).toEqual([]);
      expect(store.dueRelayRemovals(2000, 10)).toMatchObject([{ bindingId: B, attempts: 1, nextAttemptAt: 2000 }]);
      expect(store.relayRemovalFailed(B, 2000)).toBe("retry");
      expect(store.dueRelayRemovals(4000, 10)).toMatchObject([{ attempts: 2, nextAttemptAt: 4000 }]);
      for (let i = 0; i < 30; i++) store.relayRemovalFailed(B, 5000);
      expect(store.dueRelayRemovals(5000 + 3600_000, 10)).toMatchObject([{ nextAttemptAt: 5000 + 3600_000 }]);
      expect(store.relayRemovalFailed(B, 1000 + 30 * DAY)).toBe("abandoned");
      expect(store.dueRelayRemovals(Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
      store.enqueueRelayRemoval({ bindingId: other, publisherToken: "murage_pt_y" }, 1);
      store.relayRemovalDone(other);
      expect(store.dueRelayRemovals(Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
      expect(store.relayRemovalFailed(other, 2)).toBe("gone");
    });
  });
});
