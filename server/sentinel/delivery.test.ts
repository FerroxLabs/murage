// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sentinel delivery (GAP-SENTINEL-109 sections 8.2 to 8.4; SENTINEL-DELIVERY): the ledger's states and crash cases,
// page cap and cooldown arriving through the lifecycle's intents, preferences and quiet hours, and the digest's timing
// (09:00 local, DST, timezone change, offline catch-up, empty days, stable ids).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HEALTH_PAGE_BODY, HEALTH_PAGE_TITLE, type HealthPageNotification } from "../../shared/notification-preferences.ts";
import type { SentinelView, ViewRow } from "../../shared/sentinel-view.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import {
  DELIVERY_FILE, DIGEST_MIN_GAP_MS, HealthDelivery, LEDGER_ENTRIES_MAX, RECENT_CLAIMS_MAX, buildDigest, deliverPages, digestDue, localDate, localSlot,
  parseLedger, type IntentReader,
} from "./delivery.ts";
import { EMPTY_LEDGER, PAGE_CAP, decidePage, type PageLedger } from "./lifecycle.ts";
import { readPageIntents, type PageIntent } from "./publication.ts";
import { INST, T0, HOUR, DAY, cleanupFixtures, issueRecord, makeInstall } from "./scan-fixtures.ts";
import { INTENTS_MAX, SentinelStore } from "./store.ts";

const dirs: string[] = [];
afterEach(() => { cleanupFixtures(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const dataDir = () => { const dir = mkdtempSync(join(tmpdir(), "murage-sentinel-delivery-")); dirs.push(dir); return dir; };
const fp = (n: number) => n.toString(16).padStart(64, "0");

/** A scanner store stand-in: every page intent it holds with whether its issue episode is open, the same contract as
 * publication.readPageIntents. */
function fakeStore() {
  let intents: PageIntent[] = [];
  const reader: IntentReader = () => ({ ok: true, intents: [...intents] });
  return {
    reader,
    commit(list: Array<Partial<PageIntent> & { n: number }>, at = T0) {
      for (const item of list) intents.push({ id: `i-${item.n}-${item.episode ?? 1}`, fingerprint: item.fingerprint ?? fp(item.n), episode: item.episode ?? 1, titleKey: item.titleKey ?? "health.backup.not-protected", createdAt: item.createdAt ?? at, open: item.open ?? true });
    },
    close(n: number) { for (const intent of intents) if (intent.fingerprint === fp(n)) intent.open = false; },
    drop(n: number) { intents = intents.filter(intent => intent.fingerprint !== fp(n)); },
  };
}

function owner(dir = dataDir(), now = () => T0) {
  const delivery = new HealthDelivery({ dataDir: dir, installationId: INST, now });
  delivery.start();
  return { delivery, dir };
}

const deliverAll = (delivery: HealthDelivery, at: number, sent: unknown[] = []) =>
  deliverPages(delivery, { prefs: () => undefined, now: () => new Date(at), ownerSessionPresent: () => true, send: n => { sent.push(n); return true; } });

describe("the delivery ledger", () => {
  it("fresh install: the server's ledger comes first, so the first scan's intents are delivered once", () => {
    const store = fakeStore();
    const { delivery } = owner();
    store.commit([{ n: 1 }]);
    expect(delivery.sync(store.reader)).toBe(1);
    expect(delivery.claimNextPage()?.titleKey).toBe("health.backup.not-protected");
    expect(delivery.sync(store.reader)).toBe(0);
    expect(delivery.claimNextPage()).toBeNull();
  });

  it("ready -> attempted -> delivered, with the claim persisted before anything is shown", () => {
    const store = fakeStore();
    const { delivery, dir } = owner();
    store.commit([{ n: 1 }]);
    delivery.sync(store.reader);
    const claim = delivery.claimNextPage()!;
    expect(claim).toMatchObject({ installationId: INST, route: "health", bodyKey: "health.page.body" });
    expect(claim.deliveryId).toMatch(/^[0-9a-f]{32}$/);
    const onDisk = parseLedger(readFileSync(join(dir, DELIVERY_FILE), "utf8"), INST)!;
    expect(onDisk.entries[0]).toMatchObject({ state: "attempted", deliveryId: claim.deliveryId, generation: delivery.generation });
    expect(delivery.acknowledge(claim.deliveryId, "delivered")).toBe(true);
    expect(delivery.acknowledge(claim.deliveryId, "delivered")).toBe(false);
    expect(delivery.counts()).toMatchObject({ delivered: 1, ready: 0, attempted: 0 });
  });

  it("a crash after the claim leaves it uncertain on the next start, and it is never sent again", () => {
    const store = fakeStore();
    const first = owner();
    store.commit([{ n: 1 }]);
    first.delivery.sync(store.reader);
    const claim = first.delivery.claimNextPage()!;
    // crash: no acknowledge
    const second = owner(first.dir);
    expect(second.delivery.generation).toBe(first.delivery.generation + 1);
    expect(second.delivery.counts()).toMatchObject({ uncertain: 1, attempted: 0, ready: 0 });
    expect(second.delivery.claimNextPage()).toBeNull();
    expect(second.delivery.sync(store.reader)).toBe(0);
    expect(second.delivery.claimNextPage()).toBeNull();
    // the previous generation's claim can no longer be acknowledged
    expect(second.delivery.acknowledge(claim.deliveryId, "delivered")).toBe(false);
  });

  it("a claim that cannot be recorded stays ready and shows nothing", () => {
    const store = fakeStore();
    let fail = false;
    const delivery = new HealthDelivery({ dataDir: dataDir(), installationId: INST, now: () => T0, write: () => { if (fail) throw new Error("disk"); } });
    delivery.start();
    store.commit([{ n: 1 }]);
    delivery.sync(store.reader);
    fail = true;
    expect(delivery.claimNextPage()).toBeNull();
    expect(delivery.counts().ready).toBe(1);
  });

  it("an owner away for days still gets the page while the issue is open; a closed issue is suppressed, also when it closes while waiting", () => {
    const store = fakeStore();
    let now = T0;
    const { delivery } = owner(dataDir(), () => now);
    now = T0 + 3 * DAY;
    store.commit([{ n: 1, createdAt: T0 }, { n: 2, createdAt: T0, open: false }, { n: 3, createdAt: T0 + HOUR }]);
    expect(delivery.sync(store.reader)).toBe(3);
    expect(delivery.counts()).toMatchObject({ ready: 2, suppressed: 1 });
    store.close(3);
    expect(delivery.sync(store.reader)).toBe(0);
    expect(delivery.counts()).toMatchObject({ ready: 1, suppressed: 2 });
    expect(delivery.claimNextPage()?.deliveryId).toBeTruthy();
    expect(delivery.claimNextPage()).toBeNull();
  });

  it("never skips an intent however many arrive at once", () => {
    const store = fakeStore();
    store.commit(Array.from({ length: 64 }, (_, i) => ({ n: i + 1, createdAt: T0 + i })));
    const { delivery } = owner();
    expect(delivery.sync(store.reader)).toBe(64);
    expect(delivery.counts().ready).toBe(64);
  });

  it("keeps 3 pages per rolling 24 h at claim time: held pages wait, then go out after the window", () => {
    const store = fakeStore();
    let now = T0;
    const { delivery } = owner(dataDir(), () => now);
    now = T0 + 2 * DAY;
    store.commit(Array.from({ length: 5 }, (_, i) => ({ n: i + 1, createdAt: T0 + i })));
    delivery.sync(store.reader);
    expect(deliverAll(delivery, now).delivered).toBe(PAGE_CAP);
    now += 24 * HOUR - 1;
    expect(deliverAll(delivery, now).delivered).toBe(0);
    expect(delivery.counts().ready).toBe(2);
    now += 1;
    expect(deliverAll(delivery, now).delivered).toBe(2);
  });

  it("a second page for the same issue inside 24 h of a shown one is suppressed (cooldown)", () => {
    const store = fakeStore();
    const { delivery } = owner();
    store.commit([{ n: 1, episode: 1 }, { n: 1, episode: 2 }]);
    expect(delivery.sync(store.reader)).toBe(2);
    expect(deliverAll(delivery, T0)).toEqual({ delivered: 1, suppressed: 0, uncertain: 0 });
    expect(delivery.counts()).toMatchObject({ delivered: 1, suppressed: 1, ready: 0 });
  });

  it("a missing (restored), corrupt, foreign, oversize or older-version ledger re-pages nothing already in the store; later intents are delivered", () => {
    const emptyDigest = { lastDate: null, lastSlotAt: null, lastAt: null, current: null };
    const olderVersion = JSON.stringify({ version: 2, installationId: INST, generation: 3, entries: [], digest: emptyDigest });
    const foreign = JSON.stringify({ version: 3, installationId: "f".repeat(32), createdAt: T0 - DAY, generation: 3, entries: [], claims: [], digest: emptyDigest });
    for (const text of [null, "{", olderVersion, foreign, "x".repeat(600 * 1024)]) {
      const store = fakeStore();
      store.commit([{ n: 1, createdAt: T0 - DAY }, { n: 2, createdAt: T0 - 1 }]); // open issues the scanner paged before the ledger was lost
      const dir = dataDir();
      if (text !== null) writeFileSync(join(dir, DELIVERY_FILE), text, { mode: 0o600 });
      let now = T0;
      const { delivery } = owner(dir, () => now);
      expect(delivery.generation).toBe(1);
      expect(delivery.sync(store.reader)).toBe(2);
      expect(delivery.counts()).toMatchObject({ suppressed: 2, ready: 0 });
      expect(delivery.claimNextPage()).toBeNull();
      now = T0 + HOUR;
      store.commit([{ n: 3, createdAt: T0 }]);
      expect(delivery.sync(store.reader)).toBe(1);
      expect(delivery.claimNextPage()).not.toBeNull();
      expect(delivery.claimNextPage()).toBeNull();
      expect(parseLedger(readFileSync(join(dir, DELIVERY_FILE), "utf8"), INST)).toMatchObject({ version: 3, createdAt: T0 });
    }
  });

  it("the cap and the cooldown still count a claim after its intent leaves the store, and the claim list stays bounded", () => {
    const store = fakeStore();
    let now = T0;
    const { delivery, dir } = owner(dataDir(), () => now);
    store.commit([{ n: 1 }, { n: 2 }, { n: 3 }]);
    delivery.sync(store.reader);
    expect(deliverAll(delivery, now).delivered).toBe(3);
    for (const n of [1, 2, 3]) store.drop(n);
    delivery.sync(store.reader);
    expect(delivery.entries()).toHaveLength(0);
    now = T0 + 23 * HOUR;
    store.commit([{ n: 4, createdAt: now }, { n: 5, createdAt: now }]);
    delivery.sync(store.reader);
    expect(deliverAll(delivery, now).delivered).toBe(0); // three claims in the last 24 h
    expect(delivery.counts().ready).toBe(2);
    now = T0 + 24 * HOUR;
    expect(deliverAll(delivery, now)).toEqual({ delivered: 2, suppressed: 0, uncertain: 0 });
    // claims older than 24 h are dropped from the ledger
    const claims = parseLedger(readFileSync(join(dir, DELIVERY_FILE), "utf8"), INST)!.claims;
    expect(claims.map(c => c.at)).toEqual([T0 + 24 * HOUR, T0 + 24 * HOUR]);
    expect(claims.length).toBeLessThanOrEqual(RECENT_CLAIMS_MAX);
  });

  it("a reopened episode inside 24 h of a claim whose intent left the store is suppressed (cooldown)", () => {
    const store = fakeStore();
    let now = T0;
    const { delivery } = owner(dataDir(), () => now);
    store.commit([{ n: 1 }]);
    delivery.sync(store.reader);
    expect(deliverAll(delivery, now).delivered).toBe(1);
    store.drop(1);
    delivery.sync(store.reader);
    now = T0 + 24 * HOUR - 1;
    store.commit([{ n: 1, episode: 2, createdAt: now }]);
    delivery.sync(store.reader);
    expect(deliverAll(delivery, now).delivered).toBe(0);
    expect(delivery.counts()).toMatchObject({ suppressed: 1, ready: 0 });
  });

  it("a page the preferences suppressed does not count toward the cap", () => {
    const store = fakeStore();
    const { delivery } = owner();
    store.commit([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    delivery.sync(store.reader);
    expect(deliverPages(delivery, { prefs: () => ({ failures: false }), now: () => new Date(T0), ownerSessionPresent: () => true, send: () => true }).suppressed).toBe(3);
    expect(deliverAll(delivery, T0).delivered).toBe(1);
  });

  it("forgets settled entries the store no longer holds, and never adds them back", () => {
    const store = fakeStore();
    const { delivery } = owner();
    store.commit([{ n: 1 }, { n: 2 }]);
    delivery.sync(store.reader);
    deliverAll(delivery, T0);
    store.drop(1);
    delivery.sync(store.reader);
    expect(delivery.entries().map(e => e.fingerprint)).toEqual([fp(2)]);
    expect(delivery.sync(store.reader)).toBe(0);
  });

  it("can hold every intent the store can hold", () => {
    expect(LEDGER_ENTRIES_MAX).toBeGreaterThanOrEqual(INTENTS_MAX);
  });
});

describe("page cap and cooldown arrive through the lifecycle's intents", () => {
  it("three pages in a rolling day, the fourth goes to the digest; a reopened episode inside 24 h does not page", () => {
    const fx = makeInstall();
    const opened = SentinelStore.open(fx.descriptor.outputRoot, { installationId: INST });
    if (opened.status !== "ok") throw new Error(opened.status);
    const store = opened.store;
    const reader: IntentReader = () => readPageIntents(fx.descriptor.outputRoot, INST);
    let now = T0;
    const { delivery } = owner(dataDir(), () => now);
    now = T0 + 4 * HOUR;
    const result = { pageEligible: true, triggered: "high" } as never;
    let ledger: PageLedger = EMPTY_LEDGER;
    for (let n = 1; n <= 4; n++) {
      const record = issueRecord(n, { severity: "high" });
      const decision = decidePage(record, result, ledger, T0 + n * HOUR);
      ledger = decision.ledger;
      const intent = decision.intent!;
      store.commit({ issues: [decision.record], intents: [{ id: `p-${n}`, fingerprint: record.issue.fingerprint, episode: 1, delivery: intent.delivery, reason: intent.reason, titleKey: record.issue.titleKey, createdAt: T0 + n * HOUR }] });
    }
    // a reopened episode of the first fingerprint, 2 h after it paged: cooldown
    const reopened = { ...issueRecord(1, { severity: "high", episode: 2 }), lastPagedAt: T0 + HOUR, pageDecidedEpisode: 1 };
    const cooldown = decidePage(reopened, result, { attempts: [] }, T0 + 3 * HOUR).intent!;
    expect(cooldown).toEqual({ delivery: "digest", reason: "cooldown" });
    store.commit({ intents: [{ id: "p-1-2", fingerprint: reopened.issue.fingerprint, episode: 2, delivery: cooldown.delivery, reason: cooldown.reason, titleKey: "k", createdAt: T0 + 3 * HOUR }] });
    expect(delivery.sync(reader)).toBe(PAGE_CAP);
    const sent: HealthPageNotification[] = [];
    expect(deliverAll(delivery, T0 + 4 * HOUR, sent)).toEqual({ delivered: 3, suppressed: 0, uncertain: 0 });
    expect(sent).toHaveLength(3);
    expect(deliverAll(delivery, T0 + 4 * HOUR).delivered).toBe(0);
    store.close();
  });
});

describe("the page loop", () => {
  function ready(count = 1) {
    const store = fakeStore();
    const { delivery } = owner();
    store.commit(Array.from({ length: count }, (_, i) => ({ n: i + 1 })));
    delivery.sync(store.reader);
    return delivery;
  }
  const at = (hhmm: string) => new Date(`2026-10-27T${hhmm}:00Z`);

  it("waits for an owner session: nothing is claimed while no owner stream is connected", () => {
    const delivery = ready();
    expect(deliverPages(delivery, { prefs: () => undefined, now: () => at("12:00"), ownerSessionPresent: () => false, send: () => true })).toEqual({ delivered: 0, suppressed: 0, uncertain: 0 });
    expect(delivery.counts().ready).toBe(1);
  });

  it("the failures switch and quiet hours suppress it; a suppressed page is never replayed", () => {
    const off = ready();
    const sent: unknown[] = [];
    expect(deliverPages(off, { prefs: () => ({ failures: false }), now: () => at("12:00"), ownerSessionPresent: () => true, send: n => { sent.push(n); return true; } }).suppressed).toBe(1);
    expect(deliverPages(off, { prefs: () => undefined, now: () => at("12:00"), ownerSessionPresent: () => true, send: n => { sent.push(n); return true; } }).delivered).toBe(0);
    const quiet = ready();
    const prefs = { quietHours: { enabled: true, start: "22:00", end: "07:00", timeZone: "UTC" } };
    expect(deliverPages(quiet, { prefs: () => prefs, now: () => at("23:30"), ownerSessionPresent: () => true, send: n => { sent.push(n); return true; } }).suppressed).toBe(1);
    expect(deliverPages(quiet, { prefs: () => prefs, now: () => at("08:00"), ownerSessionPresent: () => true, send: n => { sent.push(n); return true; } }).delivered).toBe(0);
    expect(sent).toHaveLength(0);
    expect(quiet.counts()).toMatchObject({ suppressed: 1, ready: 0 });
  });

  it("shows only generic text, and a frame no owner stream received is uncertain, not retried", () => {
    const delivery = ready(2);
    const sent: HealthPageNotification[] = [];
    let first = true;
    const out = deliverPages(delivery, { prefs: () => ({ previewContent: true }), now: () => at("12:00"), ownerSessionPresent: () => true, send: n => { sent.push(n); const ok = !first; first = false; return ok; } });
    expect(out).toEqual({ delivered: 1, suppressed: 0, uncertain: 1 });
    for (const n of sent) {
      expect(n.title).toBe(HEALTH_PAGE_TITLE);
      expect(n.body).toBe(HEALTH_PAGE_BODY);
      expect(n).toMatchObject({ kind: "health-page", installationId: INST, route: "health" });
      expect(Object.keys(n).sort()).toEqual(["body", "bodyKey", "deliveryId", "installationId", "kind", "route", "title", "titleKey"]);
    }
    expect(deliverPages(delivery, { prefs: () => undefined, now: () => at("12:00"), ownerSessionPresent: () => true, send: () => true }).delivered).toBe(0);
  });
});

// ── digest ──────────────────────────────────────────────────────────────────

const row = (n: number, overrides: Partial<ViewRow> = {}): ViewRow => ({ fingerprint: fp(n), detectorId: "extraction", titleKey: `health.k${n}`, severity: "medium", state: "open", delivery: "digest",
  firstSeenAt: T0 - DAY, lastSeenAt: T0 - n * 60_000, count: 2, coverage: "complete", nextAction: "memory-settings", ...overrides });
const view = (rows: ViewRow[], revision = 7, openCount = rows.filter(r => r.state !== "resolved").length): SentinelView => ({ schemaVersion: 1, storeRevision: revision, publishedAt: T0, rows,
  summary: { openCount, highestSeverity: null, topTitleKey: null, lastCheckedAt: T0, lastCompleteCheckAt: T0, coverage: "complete", scanner: "running", recoveredCount: 0, moreCount: 0 } });

describe("digest timing", () => {
  const NY = "America/New_York";
  const BORN = Date.UTC(2026, 0, 1); // a ledger made long before every slot below
  it("is due from 09:00 local, once per local date", () => {
    const slot = localSlot("2026-10-27", 540, NY);
    expect(new Date(slot).toISOString()).toBe("2026-10-27T13:00:00.000Z");
    expect(digestDue(slot - 1, NY, null, slot - 2 * HOUR)).toBeNull();
    expect(digestDue(slot, NY, null, BORN)).toEqual({ date: "2026-10-27", slotAt: slot, catchUp: false });
    expect(digestDue(slot + 10 * HOUR, NY, { date: "2026-10-27", slotAt: slot }, BORN)).toBeNull();
    const next = localSlot("2026-10-28", 540, NY);
    expect(digestDue(next - 1, NY, { date: "2026-10-27", slotAt: slot }, BORN)).toBeNull();
    expect(digestDue(next, NY, { date: "2026-10-27", slotAt: slot }, BORN)).toEqual({ date: "2026-10-28", slotAt: next, catchUp: false });
  });

  it("DST: the 23 h spring-forward day and the 25 h fall-back day each get exactly one digest", () => {
    const before = localSlot("2026-03-07", 540, NY), spring = localSlot("2026-03-08", 540, NY);
    expect(spring - before).toBe(23 * HOUR);
    expect(DIGEST_MIN_GAP_MS).toBe(23 * HOUR);
    expect(digestDue(spring, NY, { date: "2026-03-07", slotAt: before }, BORN)).toEqual({ date: "2026-03-08", slotAt: spring, catchUp: false });
    const fallBefore = localSlot("2026-10-31", 540, NY), fall = localSlot("2026-11-01", 540, NY);
    expect(fall - fallBefore).toBe(25 * HOUR);
    expect(digestDue(fall, NY, { date: "2026-10-31", slotAt: fallBefore }, BORN)).not.toBeNull();
    expect(digestDue(fall + 2 * HOUR, NY, { date: "2026-11-01", slotAt: fall }, BORN)).toBeNull();
  });

  it("a timezone change never makes a second digest within a day", () => {
    const nySlot = localSlot("2026-10-27", 540, NY);
    const last = { date: "2026-10-27", slotAt: nySlot };
    // flying east: Tokyo's 09:00 on the 28th is only 11 h after New York's 09:00 on the 27th
    const tokyo28 = localSlot("2026-10-28", 540, "Asia/Tokyo");
    expect(tokyo28 - nySlot).toBe(11 * HOUR);
    expect(digestDue(tokyo28 + HOUR, "Asia/Tokyo", last, BORN)).toBeNull();
    const tokyo29 = localSlot("2026-10-29", 540, "Asia/Tokyo");
    expect(digestDue(tokyo29, "Asia/Tokyo", last, BORN)).toEqual({ date: "2026-10-29", slotAt: tokyo29, catchUp: false });
    // flying west: the local date goes back, nothing is due until a later date
    const back = { date: "2026-10-29", slotAt: tokyo29 };
    expect(digestDue(localSlot("2026-10-28", 540, NY) + HOUR, NY, back, BORN)).toBeNull();
    expect(digestDue(localSlot("2026-10-29", 540, NY), NY, back, BORN)).toBeNull();
    expect(digestDue(localSlot("2026-10-30", 540, NY), NY, back, BORN)).not.toBeNull();
  });

  it("offline for days: one accumulated digest at the next session, then nothing more that day", () => {
    let now = localSlot("2026-10-20", 540, "UTC");
    const { delivery } = owner(dataDir(), () => now);
    const first = delivery.maybeDigest(view([row(1)]), "UTC");
    expect(first?.date).toBe("2026-10-20");
    now = localSlot("2026-10-25", 540, "UTC") + 6 * HOUR; // the app was closed for four days
    const caughtUp = delivery.maybeDigest(view([row(1, { lastSeenAt: now - HOUR }), row(2, { lastSeenAt: now - 2 * HOUR })], 9), "UTC");
    expect(caughtUp?.date).toBe("2026-10-25");
    expect(caughtUp?.rows).toHaveLength(2);
    now += HOUR;
    expect(delivery.maybeDigest(view([row(3)], 10), "UTC")).toBeNull();
    expect(delivery.currentDigest()?.id).toBe(caughtUp?.id);
  });

  it("a session that ends before 09:00 after a missed day gets the one accumulated digest, and none again that day", () => {
    const mon = localSlot("2026-10-26", 540, "UTC");
    const last = { date: "2026-10-26", slotAt: mon };
    const tue = localSlot("2026-10-27", 540, "UTC");
    expect(digestDue(tue - HOUR, "UTC", last, BORN)).toBeNull(); // Monday was yesterday: nothing missed
    const wed = localSlot("2026-10-28", 540, "UTC");
    expect(digestDue(wed - HOUR, "UTC", last, BORN)).toEqual({ date: "2026-10-28", slotAt: tue, catchUp: true });
    expect(digestDue(wed - HOUR, "UTC", null, BORN)).toEqual({ date: "2026-10-28", slotAt: tue, catchUp: true }); // never a digest, Tuesday 09:00 missed
    expect(digestDue(wed - HOUR, "UTC", null, tue)).toBeNull(); // the ledger was made at Tuesday 09:00, not before it
    let now = mon;
    const { delivery } = owner(dataDir(), () => now);
    expect(delivery.maybeDigest(view([row(1)]), "UTC")?.date).toBe("2026-10-26");
    now = wed - HOUR; // closed all of Tuesday, opened Wednesday 08:00
    expect(delivery.maybeDigest(view([row(1, { lastSeenAt: now - HOUR })], 9), "UTC")?.date).toBe("2026-10-28");
    now = wed + HOUR;
    expect(delivery.maybeDigest(view([row(2, { lastSeenAt: now })], 10), "UTC")).toBeNull();
    now = localSlot("2026-10-29", 540, "UTC");
    expect(delivery.maybeDigest(view([row(2, { lastSeenAt: now - HOUR })], 11), "UTC")?.date).toBe("2026-10-29");
  });

  it("morning catch-up without any earlier digest: the previous 09:00 passed after the ledger was made", () => {
    const tue = localSlot("2026-10-27", 540, "UTC"), wed = localSlot("2026-10-28", 540, "UTC");
    let now = tue - 18 * HOUR; // ledger made Monday 15:00, the app closed all of Tuesday
    const { delivery } = owner(dataDir(), () => now);
    now = wed - HOUR;
    expect(delivery.maybeDigest(view([row(1, { lastSeenAt: now - HOUR })]), "UTC")?.date).toBe("2026-10-28");
    now = wed + HOUR;
    expect(delivery.maybeDigest(view([row(2, { lastSeenAt: now })], 8), "UTC")).toBeNull();
    now = localSlot("2026-10-29", 540, "UTC");
    expect(delivery.maybeDigest(view([row(2, { lastSeenAt: now - HOUR })], 9), "UTC")?.date).toBe("2026-10-29");
  });

  it("no morning catch-up for a 09:00 that passed before the ledger was made, nor when there is nothing to say", () => {
    const tue = localSlot("2026-10-27", 540, "UTC"), wed = localSlot("2026-10-28", 540, "UTC");
    let now = tue + HOUR;
    const late = owner(dataDir(), () => now);
    now = wed - HOUR;
    expect(late.delivery.maybeDigest(view([row(1, { lastSeenAt: now })]), "UTC")).toBeNull();
    now = wed;
    expect(late.delivery.maybeDigest(view([row(1, { lastSeenAt: now })]), "UTC")?.date).toBe("2026-10-28");
    now = tue - 18 * HOUR;
    const quiet = owner(dataDir(), () => now);
    now = wed - HOUR;
    expect(quiet.delivery.maybeDigest(view([]), "UTC")).toBeNull();
    now = wed;
    expect(quiet.delivery.maybeDigest(view([row(1, { lastSeenAt: now })]), "UTC")?.date).toBe("2026-10-28"); // the empty morning left the day open
  });

  it("at most one digest per 24 h of actual publication", () => {
    const mon = localSlot("2026-10-26", 540, "UTC"), tue = localSlot("2026-10-27", 540, "UTC");
    let now = mon - HOUR;
    const { delivery } = owner(dataDir(), () => now);
    now = mon + 14 * HOUR; // first opened Monday 23:00
    expect(delivery.maybeDigest(view([row(1)]), "UTC")?.date).toBe("2026-10-26");
    now = tue;
    expect(delivery.maybeDigest(view([row(1, { lastSeenAt: now })], 8), "UTC")).toBeNull();
    now = mon + 38 * HOUR - 1;
    expect(delivery.maybeDigest(view([row(1, { lastSeenAt: now })], 8), "UTC")).toBeNull();
    now += 1;
    expect(delivery.maybeDigest(view([row(1, { lastSeenAt: now })], 8), "UTC")?.date).toBe("2026-10-27");
  });

  it("skips a day with nothing open, changed or newly resolved, and says nothing else that day", () => {
    let now = localSlot("2026-10-27", 540, "UTC");
    const { delivery } = owner(dataDir(), () => now);
    expect(delivery.maybeDigest(view([]), "UTC")).toBeNull();
    now += HOUR;
    expect(delivery.maybeDigest(view([row(1, { lastSeenAt: now })]), "UTC")).toBeNull();
    expect(delivery.currentDigest()).toBeNull();
    now = localSlot("2026-10-28", 540, "UTC");
    expect(delivery.maybeDigest(view([row(1, { lastSeenAt: now - HOUR })]), "UTC")?.date).toBe("2026-10-28");
  });

  it("waits while there is no published view, without using up the day", () => {
    let now = localSlot("2026-10-27", 540, "UTC");
    const { delivery } = owner(dataDir(), () => now);
    expect(delivery.maybeDigest(null, "UTC")).toBeNull();
    now += HOUR;
    expect(delivery.maybeDigest(view([row(1)]), "UTC")?.date).toBe("2026-10-27");
  });

  it("survives a restart without a second digest the same day", () => {
    const now = localSlot("2026-10-27", 540, "UTC") + HOUR;
    const dir = dataDir();
    const first = owner(dir, () => now);
    expect(first.delivery.maybeDigest(view([row(1)]), "UTC")).not.toBeNull();
    const again = owner(dir, () => now + HOUR);
    expect(again.delivery.maybeDigest(view([row(1)]), "UTC")).toBeNull();
    expect(again.delivery.currentDigest()?.id).toBe(first.delivery.currentDigest()?.id);
  });
});

describe("the digest's content", () => {
  it("at most five grouped rows, ranked by impact then recency, with the rest counted", () => {
    const rows = [
      row(1, { titleKey: "a", severity: "low", lastSeenAt: T0 }),
      row(2, { titleKey: "b", severity: "high", lastSeenAt: T0 - 5 * HOUR }),
      row(3, { titleKey: "b", severity: "medium", lastSeenAt: T0 - HOUR, count: 5 }),
      row(4, { titleKey: "c", severity: "high", lastSeenAt: T0 - 2 * HOUR }),
      row(5, { titleKey: "d", severity: "medium" }), row(6, { titleKey: "e", severity: "medium" }), row(7, { titleKey: "f", severity: "low", lastSeenAt: T0 - DAY }),
    ];
    const digest = buildDigest(view(rows), null, "2026-10-27", T0)!;
    expect(digest.rows.map(r => r.titleKey)).toEqual(["b", "c", "d", "e", "a"]);
    expect(digest.rows[0]).toMatchObject({ issues: 2, count: 7, severity: "high", lastSeenAt: T0 - HOUR });
    expect(digest.moreCount).toBe(1);
    expect(digest.id).toBe("health-digest-2026-10-27-7");
  });

  it("counts observed recoveries only, and keeps a stable id for the same date and revision", () => {
    const rows = [row(1, { state: "resolved", resolution: "observed-recovery", resolvedAt: T0 - HOUR }), row(2, { state: "resolved", resolution: "policy-ended", resolvedAt: T0 - HOUR }),
      row(3, { state: "resolved", resolution: "observed-recovery", resolvedAt: T0 - 3 * DAY })];
    const digest = buildDigest(view(rows), T0 - DAY, "2026-10-27", T0)!;
    expect(digest.recoveredCount).toBe(1);
    expect(digest.rows).toHaveLength(0);
    expect(buildDigest(view(rows), T0 - DAY, "2026-10-27", T0 + HOUR)!.id).toBe(digest.id);
    expect(buildDigest(view([row(3, { state: "resolved", resolution: "observed-recovery", resolvedAt: T0 - 3 * DAY, lastSeenAt: T0 - 4 * DAY })], 7, 0), T0 - DAY, "2026-10-27", T0)).toBeNull();
  });

  it("local dates follow the zone", () => {
    expect(localDate(Date.UTC(2026, 9, 27, 3, 0), "America/New_York")).toBe("2026-10-26");
    expect(localDate(Date.UTC(2026, 9, 27, 3, 0), "Asia/Tokyo")).toBe("2026-10-27");
  });
});
