import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { PhoneRegistry, PhoneRevocations, initializePhones } from "./registry.ts";

const fx = JSON.parse(readFileSync(new URL("../../apps/mobile/contract/phone-jobs.json", import.meta.url), "utf8"));
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function mem(): { db: DatabaseSync; clock: { t: number }; reg: PhoneRegistry; rev: PhoneRevocations } {
  const db = new DatabaseSync(":memory:");
  initializePhones(db);
  const clock = { t: 1000 };
  const now = () => clock.t;
  return { db, clock, reg: new PhoneRegistry(db, now), rev: new PhoneRevocations(db, now) };
}

describe("PhoneRegistry", () => {
  it("stores a valid body and reads it back", () => {
    const { reg } = mem();
    const r = reg.put(A, fx.registration.valid);
    expect(r.ok).toBe(true);
    const got = reg.get(A)!;
    expect(got.deviceId).toBe(A);
    expect(got.name).toBe(fx.registration.valid.name);
    expect(got.capabilities).toEqual(fx.registration.valid.capabilities);
    expect(got.updatedAt).toBe(1000);
    expect(reg.list()).toHaveLength(1);
    expect(reg.get(B)).toBeNull();
    for (const ok of fx.registration.alsoValid) expect(reg.put(B, ok).ok).toBe(true);
  });

  it("refuses every invalid fixture with 400 and stores nothing", () => {
    const { reg } = mem();
    for (const bad of fx.registration.invalid) {
      const r = reg.put(A, bad.body);
      expect(r.ok, bad.why).toBe(false);
      if (!r.ok) expect(r.status, bad.why).toBe(400);
    }
    expect(reg.get(A)).toBeNull();
    expect(reg.put(A, "nope").ok).toBe(false);
    expect(reg.put(A, null).ok).toBe(false);
    expect(reg.put(A, { ...fx.registration.valid, workspaces: [] }).ok).toBe(false);
  });

  it("returns the capabilities a re-registration drops", () => {
    const { reg } = mem();
    expect(reg.put(A, fx.registration.valid)).toMatchObject({ ok: true, dropped: [] });
    const narrower = { ...fx.registration.valid, capabilities: { calendar: "write-only", location: "approximate" } };
    const r = reg.put(A, narrower);
    expect(r.ok && [...r.dropped].sort()).toEqual(["alarms", "calls", "contacts", "location", "messages", "reminders"]);
    expect(reg.get(A)!.capabilities).toEqual(narrower.capabilities);
  });

  it("reports location as dropped when precision narrows from precise to approximate, and only then", () => {
    const { reg } = mem();
    const withLocation = (location: string) => ({ ...fx.registration.valid, capabilities: { ...fx.registration.valid.capabilities, location } });
    reg.put(A, withLocation("precise"));
    const narrowed = reg.put(A, withLocation("approximate"));
    expect(narrowed.ok && narrowed.dropped).toEqual(["location"]);
    const same = reg.put(A, withLocation("approximate"));
    expect(same.ok && same.dropped).toEqual([]);
    const widened = reg.put(A, withLocation("precise"));
    expect(widened.ok && widened.dropped).toEqual([]);
  });

  it("chooseFor prefers the named or last-used phone among those reporting the capability", () => {
    const { reg, clock } = mem();
    reg.put(A, fx.registration.valid);
    clock.t = 2000;
    reg.put(B, fx.registration.valid);
    expect(reg.chooseFor("calendar")?.deviceId).toBe(B);
    expect(reg.chooseFor("calendar", A)?.deviceId).toBe(A);
    reg.put(A, { ...fx.registration.valid, capabilities: { reminders: true } });
    expect(reg.chooseFor("calendar", A)?.deviceId).toBe(B);
    expect(reg.chooseFor("alarms")?.deviceId).toBe(B);
    expect(reg.chooseFor("calls", "nobody")?.deviceId).toBe(B);
    reg.remove(B);
    expect(reg.chooseFor("calendar")).toBeNull();
  });

  it("revoke removes the registration and the next put answers 403 revoked, also after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "phones-"));
    const file = join(dir, "messages.db");
    const db = new DatabaseSync(file);
    initializePhones(db);
    const reg = new PhoneRegistry(db, () => 5);
    reg.put(A, fx.registration.valid);
    reg.revoke(A, "removed");
    expect(reg.get(A)).toBeNull();
    expect(reg.put(A, fx.registration.valid)).toEqual({ ok: false, status: 403, error: "revoked" });
    expect(reg.get(A)).toBeNull();
    db.close();
    const db2 = new DatabaseSync(file);
    initializePhones(db2);
    const reg2 = new PhoneRegistry(db2, () => 6);
    const rev2 = new PhoneRevocations(db2, () => 6);
    expect(rev2.barred(A)).toBe(true);
    expect(reg2.put(A, fx.registration.valid)).toEqual({ ok: false, status: 403, error: "revoked" });
    expect(reg2.get(A)).toBeNull();
    rev2.clear(A);
    expect(rev2.barred(A)).toBe(false);
    expect(reg2.put(A, fx.registration.valid).ok).toBe(true);
    db2.close();
  });

  it("revoke is one transaction: a failing bar leaves the registration in place", () => {
    const { db, reg } = mem();
    reg.put(A, fx.registration.valid);
    expect(() => reg.revoke(A, "bogus" as never)).toThrow();
    expect(reg.get(A)).not.toBeNull();
    db.close();
  });
});

describe("PhoneRevocations", () => {
  it("bar twice keeps the first revoked_at and reason is a closed set", () => {
    const { db, clock, rev } = mem();
    rev.bar(A, "removed");
    clock.t = 9000;
    rev.bar(A, "switch-off");
    expect((db.prepare("SELECT revoked_at AS t, reason AS r FROM phone_revocations WHERE device_id = ?").get(A) as { t: number; r: string })).toEqual({ t: 1000, r: "removed" });
    expect(rev.barred(B)).toBe(false);
    expect(() => rev.bar(B, "other" as never)).toThrow();
  });

  it("an older messages.db without the tables opens and gains them, repeatedly", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY)");
    initializePhones(db);
    initializePhones(db);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(names).toContain("phone_registrations");
    expect(names).toContain("phone_revocations");
    expect(names).toContain("phone_ask_optins");
  });

  it("keeps the ask opt-in across re-registration, survives a reopen of the file, and never shows it in the registration", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-registry-optin-"));
    const file = join(dir, "m.db");
    const db = new DatabaseSync(file);
    initializePhones(db);
    const reg = new PhoneRegistry(db, () => 1000);
    expect(reg.deviceIdOptedIn(A)).toBe(false);
    reg.put(A, fx.registration.valid);
    reg.setDeviceIdOptIn(A, true);
    reg.put(A, fx.registration.valid);
    expect(reg.deviceIdOptedIn(A)).toBe(true);
    expect(Object.keys(reg.get(A)!)).not.toContain("deviceIdOptIn");
    db.close();
    const again = new DatabaseSync(file);
    expect(new PhoneRegistry(again, () => 1000).deviceIdOptedIn(A)).toBe(true);
    again.close();
    removeTempDirSync(dir);
  });

  it("keeps the ask opt-in when the server restarts between the mint and the registration", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-registry-optin2-"));
    const file = join(dir, "m.db");
    const db = new DatabaseSync(file);
    initializePhones(db);
    new PhoneRegistry(db, () => 1000).setDeviceIdOptIn(A, true);
    db.close();
    const again = new DatabaseSync(file);
    initializePhones(again);
    const fresh = new PhoneRegistry(again, () => 1000);
    expect(fresh.put(A, fx.registration.valid).ok).toBe(true);
    expect(fresh.deviceIdOptedIn(A)).toBe(true);
    expect(Object.keys(fresh.get(A)!)).not.toContain("deviceIdOptIn");
    again.close();
    removeTempDirSync(dir);
  });

  describe("upgrade from a database that stored the opt-in inside the registration", () => {
    // A registration body exactly as the earlier build wrote it: the registration plus a boolean deviceIdOptIn.
    const legacyDb = (file: string, rows: Array<[string, Record<string, unknown> | string]>): void => {
      const seed = new DatabaseSync(file);
      seed.exec("CREATE TABLE phone_registrations (device_id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at INTEGER NOT NULL)");
      rows.forEach(([id, extra], i) => seed.prepare("INSERT INTO phone_registrations VALUES (?, ?, ?)").run(id, typeof extra === "string" ? extra : JSON.stringify({ ...fx.registration.valid, ...extra }), 10 + i));
      seed.close();
    };
    const C = "33333333-3333-4333-8333-333333333333";
    const D = "44444444-4444-4444-8444-444444444444";

    it("backfills stored booleans, then list, re-register and restart keep the state and never leak the old field", () => {
      const dir = mkdtempSync(join(tmpdir(), "murage-registry-upgrade-"));
      const file = join(dir, "m.db");
      legacyDb(file, [[A, { deviceIdOptIn: true }], [B, { deviceIdOptIn: false }], [C, {}], [D, { deviceIdOptIn: "yes" }]]);
      let db = new DatabaseSync(file);
      initializePhones(db);
      let reg = new PhoneRegistry(db, () => 2000);
      expect([A, B, C, D].map((id) => reg.deviceIdOptIn(id))).toEqual([true, false, undefined, undefined]);
      for (const p of reg.list()) expect(Object.keys(p)).not.toContain("deviceIdOptIn");
      expect(Object.keys(reg.get(A)!)).not.toContain("deviceIdOptIn");
      // re-register: the table keeps the state the body no longer carries
      for (const id of [A, B, C, D]) expect(reg.put(id, fx.registration.valid).ok).toBe(true);
      expect([A, B, C, D].map((id) => reg.deviceIdOptIn(id))).toEqual([true, false, undefined, undefined]);
      // restart: initializePhones runs again over the rewritten bodies and changes nothing
      db.close();
      db = new DatabaseSync(file);
      initializePhones(db);
      reg = new PhoneRegistry(db, () => 3000);
      expect([A, B, C, D].map((id) => reg.deviceIdOptIn(id))).toEqual([true, false, undefined, undefined]);
      for (const p of reg.list()) expect(Object.keys(p)).not.toContain("deviceIdOptIn");
      db.close();
      removeTempDirSync(dir);
    });

    it("never overwrites a newer table row with the older stored boolean, on the first start or any later one", () => {
      const dir = mkdtempSync(join(tmpdir(), "murage-registry-upgrade2-"));
      const file = join(dir, "m.db");
      legacyDb(file, [[A, { deviceIdOptIn: false }], [B, { deviceIdOptIn: true }]]);
      let db = new DatabaseSync(file);
      initializePhones(db);
      const reg = new PhoneRegistry(db, () => 2000);
      reg.setDeviceIdOptIn(A, true); // a mint after the upgrade
      db.close();
      db = new DatabaseSync(file);
      initializePhones(db); // the body of A still says false
      const again = new PhoneRegistry(db, () => 3000);
      expect(again.deviceIdOptIn(A)).toBe(true);
      expect(again.deviceIdOptIn(B)).toBe(true);
      db.close();
      removeTempDirSync(dir);
    });

    it("an unreadable stored body is skipped and does not stop the upgrade", () => {
      const dir = mkdtempSync(join(tmpdir(), "murage-registry-upgrade3-"));
      const file = join(dir, "m.db");
      legacyDb(file, [[C, "{not json"], [A, { deviceIdOptIn: true }]]);
      const db = new DatabaseSync(file);
      initializePhones(db);
      const reg = new PhoneRegistry(db, () => 2000);
      expect(reg.deviceIdOptIn(A)).toBe(true);
      expect(reg.deviceIdOptIn(C)).toBeUndefined();
      db.close();
      removeTempDirSync(dir);
    });
  });

  it("a phone that registers first and mints later, or never opts in, reads as expected", () => {
    const { reg } = mem();
    reg.put(A, fx.registration.valid);
    expect(reg.deviceIdOptedIn(A)).toBe(false);
    reg.setDeviceIdOptIn(A, true);
    expect(reg.deviceIdOptedIn(A)).toBe(true);
    reg.put(B, fx.registration.valid);
    reg.setDeviceIdOptIn(B, false);
    expect(reg.deviceIdOptedIn(B)).toBe(false);
  });
});
