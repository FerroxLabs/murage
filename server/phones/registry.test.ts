import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
  });
});
