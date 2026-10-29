// A backup downgrade drops phone_revocations; the rows are set aside beside messages.db so a removed phone stays barred after the next upgrade.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { downgradePhoneObjectsTo108 } from "../installation-app-schema-downgrade.ts";
import { phoneRoute } from "../routes/phones.ts";
import { PhoneAuthorities } from "./authority.ts";
import { PhoneJobs } from "./jobs.ts";
import { PhoneRegistry, PhoneRevocations, initializePhones } from "./registry.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const CONTRACT = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "apps", "mobile", "contract", "phone-jobs.json"), "utf8"));
const REGISTRATION = CONTRACT.registration.valid;
const SCRATCH = mkdtempSync(join(tmpdir(), "murage-phone-tombstone-"));
/** Every file database a test opens, closed before the folder goes: Windows will not remove a file that is still open. */
const openedDbs: DatabaseSync[] = [];
const openDb = (file: string) => { const db = new DatabaseSync(file); openedDbs.push(db); return db; };
const closeOpenedDbs = () => { for (const db of openedDbs.splice(0)) { try { db.close(); } catch { /* already closed by the test */ } } };
afterAll(() => { closeOpenedDbs(); removeTempDirSync(SCRATCH); });
let n = 0;
const newDir = () => { const dir = join(SCRATCH, `d${++n}`); return dir; };
const TOMBSTONE = "phone-revocations.tombstone.json";

function open(dir: string) {
  mkdirSync(dir, { recursive: true });
  const db = openDb(join(dir, "messages.db"));
  initializePhones(db);
  const registry = new PhoneRegistry(db, () => 1000);
  const revocations = new PhoneRevocations(db, () => 1000);
  const jobs = new PhoneJobs({ now: () => 1000, setTimer: () => () => {}, push: { park: () => {}, withdraw: () => {} }, ids: () => "00000000-0000-4000-8000-000000000001", leaseToken: () => "x".repeat(43) });
  const deps = { registry, revocations, jobs, authorities: new PhoneAuthorities(), grant: () => ({}) as never, askOffered: () => true, activity: () => {} };
  const call = (method: string, path: string, o: { device?: string | null; companion?: boolean; body?: unknown } = {}) => phoneRoute({
    method, path, query: new URLSearchParams(), deviceId: o.device === undefined ? "dev-a" : o.device, companion: o.companion === true, desktop: false,
    readBody: async () => o.body, signal: new AbortController().signal,
  }, deps as never);
  return { db, registry, revocations, call };
}

describe("the revocation tombstone", () => {
  it("a revoked phone stays barred through downgrade and re-upgrade until a jobs mint; then stays accepted after another restart", async () => {
    const dir = newDir();
    let h = open(dir);
    h.registry.revoke("dev-a", "removed");
    expect((await h.call("PUT", "/api/phones/self", { body: REGISTRATION }))?.status).toBe(403);
    downgradePhoneObjectsTo108(h.db);
    expect(h.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='phone_revocations'").get()).toBeUndefined();
    const file = join(dir, TOMBSTONE);
    expect(existsSync(file)).toBe(true);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    h.db.close();
    h = open(dir);
    const barred = await h.call("PUT", "/api/phones/self", { body: REGISTRATION });
    expect(barred?.status).toBe(403);
    expect(JSON.stringify(barred?.body)).toContain("revoked");
    expect((await h.call("POST", "/api/phones/minted", { device: null, companion: true, body: { deviceId: "dev-a", scope: "jobs" } }))?.status).toBe(200);
    expect((await h.call("PUT", "/api/phones/self", { body: REGISTRATION }))?.status).toBe(200);
    h.db.close();
    h = open(dir);
    expect((await h.call("PUT", "/api/phones/self", { body: REGISTRATION }))?.status).toBe(200);
    h.db.close();
  });

  it("merges with an existing tombstone and never shrinks it", () => {
    const dir = newDir();
    const h = open(dir);
    writeFileSync(join(dir, TOMBSTONE), JSON.stringify([{ device_id: "old", revoked_at: 5, reason: "switch-off" }]));
    h.revocations.bar("dev-a", "removed");
    downgradePhoneObjectsTo108(h.db);
    const rows = JSON.parse(readFileSync(join(dir, TOMBSTONE), "utf8")) as Array<{ device_id: string }>;
    expect(rows.map((r) => r.device_id).sort()).toEqual(["dev-a", "old"]);
    h.db.close();
  });

  it("an unreadable tombstone is kept and the downgrade that would overwrite it stops with the table intact", () => {
    const dir = newDir();
    const h = open(dir);
    writeFileSync(join(dir, TOMBSTONE), "{not json");
    h.revocations.bar("dev-a", "removed");
    expect(() => downgradePhoneObjectsTo108(h.db)).toThrow();
    expect(readFileSync(join(dir, TOMBSTONE), "utf8")).toBe("{not json");
    expect(h.db.prepare("SELECT COUNT(*) AS c FROM phone_revocations").get()).toEqual({ c: 1 });
    h.db.close();
  });

  it("initializePhones with an unreadable tombstone throws and keeps the file", () => {
    const dir = newDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, TOMBSTONE), "garbage");
    const db = openDb(join(dir, "messages.db"));
    expect(() => initializePhones(db)).toThrow();
    expect(readFileSync(join(dir, TOMBSTONE), "utf8")).toBe("garbage");
    db.close();
  });
});
