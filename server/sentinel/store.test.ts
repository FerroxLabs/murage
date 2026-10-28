// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { HEALTH_LIMITS } from "../../shared/health-protocol.mjs";
import { T0 } from "./detectors/fixtures.ts";
import { INST, cleanupFixtures, issueRecord as record, makeInstall } from "./scan-fixtures.ts";
import { MIGRATIONS, STORE_FILE, STORE_PREVIOUS_FILE, SentinelStore } from "./store.ts";

const posixOnly = process.platform === "win32" ? it.skip : it;
afterEach(() => cleanupFixtures());

const open = (root: string) => {
  const opened = SentinelStore.open(root, { installationId: INST });
  if (opened.status !== "ok") throw new Error(opened.status);
  return opened.store;
};

describe("scanner store", () => {
  posixOnly("creates an owner-only state file with the current schema version", () => {
    const fx = makeInstall();
    const store = open(fx.descriptor.outputRoot);
    store.close();
    const file = join(fx.descriptor.outputRoot, STORE_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const db = new DatabaseSync(file, { readOnly: true });
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
    db.close();
  });

  it("commits issues, cursors, states, intents and metadata in one transaction and bumps the revision", () => {
    const fx = makeInstall();
    const store = open(fx.descriptor.outputRoot);
    const r = record(1);
    const revision = store.commit({
      meta: { heartbeat_at: T0 }, issues: [r], detectorStates: { extraction: { version: 1, state: { a: 1 } } },
      intents: [{ id: "a".repeat(32), fingerprint: r.issue.fingerprint, episode: 1, delivery: "digest", reason: "opened", titleKey: "x", createdAt: T0 }],
    });
    expect(revision).toBe(1);
    expect(store.issue(r.issue.fingerprint)).toEqual(r);
    expect(store.detectorStates()).toEqual({ extraction: { version: 1, state: { a: 1 } } });
    expect(store.meta("heartbeat_at")).toBe(T0);
    store.close();
  });

  it("rolls the whole commit back when any part fails (nothing half-written)", () => {
    const fx = makeInstall();
    const store = open(fx.descriptor.outputRoot);
    store.commit({ meta: { heartbeat_at: T0 } });
    const bad = record(2);
    expect(() => store.commit({ meta: { heartbeat_at: T0 + 1 }, issues: [bad], detectorStates: { extraction: { version: 1, state: undefined as never } } })).toThrow();
    expect(store.revision()).toBe(1);
    expect(store.meta("heartbeat_at")).toBe(T0);
    expect(store.issue(bad.issue.fingerprint)).toBeNull();
    store.close();
  });

  it("keeps the intent table to its fixed ceiling and drops intents past retention", () => {
    const fx = makeInstall();
    const store = open(fx.descriptor.outputRoot);
    const intents = Array.from({ length: 600 }, (_, i) => ({ id: i.toString(16).padStart(32, "0"), fingerprint: "f".repeat(64), episode: 1, delivery: "digest" as const, reason: "opened" as const, titleKey: "x", createdAt: T0 + i }));
    store.commit({ intents });
    expect(Number((store.db.prepare("SELECT count(*) AS n FROM intents").get() as { n: number }).n)).toBe(512);
    store.commit({ pruneIntentsBefore: T0 + 590 });
    expect(Number((store.db.prepare("SELECT count(*) AS n FROM intents").get() as { n: number }).n)).toBe(10);
    store.close();
  });

  it("an unknown (newer) schema opens read-only and reports upgrade-needed without writing", () => {
    const fx = makeInstall();
    open(fx.descriptor.outputRoot).close();
    const file = join(fx.descriptor.outputRoot, STORE_FILE);
    const db = new DatabaseSync(file);
    db.exec("PRAGMA user_version=7");
    db.close();
    const before = readFileSync(file);
    const opened = SentinelStore.open(fx.descriptor.outputRoot, { installationId: INST });
    expect(opened.status).toBe("upgrade-needed");
    expect(opened.store?.readOnly).toBe(true);
    expect(() => opened.store!.commit({})).toThrow();
    opened.store?.close();
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("a corrupt file is preserved untouched and reported, never discarded", () => {
    const fx = makeInstall();
    const file = join(fx.descriptor.outputRoot, STORE_FILE);
    writeFileSync(file, "this is not a database, ".repeat(400), { mode: 0o600 });
    const before = readFileSync(file);
    const opened = SentinelStore.open(fx.descriptor.outputRoot, { installationId: INST });
    expect(opened.status).toBe("corrupt");
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("a store from another installation is not inherited", () => {
    const fx = makeInstall();
    SentinelStore.open(fx.descriptor.outputRoot, { installationId: "f".repeat(32) }).store?.close();
    expect(SentinelStore.open(fx.descriptor.outputRoot, { installationId: INST }).status).toBe("foreign");
  });

  it("migrates a known older schema transactionally after one previous checkpoint", () => {
    const fx = makeInstall();
    const root = fx.descriptor.outputRoot;
    const store = open(root);
    store.commit({ issues: [record(1)] });
    store.close();
    const v2 = { ...MIGRATIONS, 2: (db: DatabaseSync) => db.exec("CREATE TABLE extra(x INTEGER)") };
    const migrated = SentinelStore.open(root, { installationId: INST, migrations: v2, targetVersion: 2 });
    expect(migrated.status).toBe("ok");
    expect(migrated.store!.issueCount()).toBe(1);
    migrated.store!.close();
    expect(existsSync(join(root, STORE_PREVIOUS_FILE))).toBe(true);
    const previous = new DatabaseSync(join(root, STORE_PREVIOUS_FILE), { readOnly: true });
    expect((previous.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
    previous.close();
  });

  it("a failing migration leaves the old schema and data in place", () => {
    const fx = makeInstall();
    const root = fx.descriptor.outputRoot;
    const store = open(root);
    store.commit({ issues: [record(1)] });
    store.close();
    const broken = { ...MIGRATIONS, 2: (db: DatabaseSync) => { db.exec("CREATE TABLE extra(x INTEGER)"); throw new Error("boom"); } };
    expect(SentinelStore.open(root, { installationId: INST, migrations: broken, targetVersion: 2 })).toMatchObject({ status: "unavailable", reason: "migration" });
    const again = open(root);
    expect(again.issueCount()).toBe(1);
    expect(again.db.prepare("SELECT name FROM sqlite_master WHERE name = 'extra'").get()).toBeUndefined();
    again.close();
  });

  it("orders the view rows by unresolved, severity and recency, hiding presentation-group members", () => {
    const fx = makeInstall();
    const store = open(fx.descriptor.outputRoot);
    const high = record(1, { severity: "high" });
    const resolved = record(2, { state: "resolved", resolution: "observed-recovery", resolvedAt: T0 + 10 });
    const member = record(3, { presentedBy: high.issue.fingerprint });
    const recent = record(4);
    store.commit({ issues: [high, resolved, member, recent] });
    expect(store.viewIssues(HEALTH_LIMITS.viewRows).map(r => r.issue.fingerprint)).toEqual([high.issue.fingerprint, recent.issue.fingerprint, resolved.issue.fingerprint]);
    expect(store.unresolvedCounts().open).toBe(2);
    store.close();
  });

  it("a presentation-group member gets its own row once its presenter is resolved or absent", () => {
    const fx = makeInstall();
    const store = open(fx.descriptor.outputRoot);
    const presenter = record(1, { state: "resolved", resolution: "observed-recovery", resolvedAt: T0 + 10 });
    const member = record(2, { severity: "high", presentedBy: presenter.issue.fingerprint });
    const orphan = record(3, { presentedBy: "f".repeat(64) });
    store.commit({ issues: [presenter, member, orphan] });
    const rows = store.viewIssues(HEALTH_LIMITS.viewRows);
    expect(rows.map(r => r.issue.fingerprint)).toEqual([member.issue.fingerprint, orphan.issue.fingerprint, presenter.issue.fingerprint]);
    expect(rows.every(r => r.issue.presentedBy === undefined)).toBe(true);
    expect(store.unresolvedCounts().open).toBe(2);
    // The presenter opens again: the member folds back under it.
    store.commit({ issues: [record(1)] });
    expect(store.viewIssues(HEALTH_LIMITS.viewRows).map(r => r.issue.fingerprint)).not.toContain(member.issue.fingerprint);
    expect(store.unresolvedCounts().open).toBe(2);
    store.close();
  });

  it("estimates a commit's charge as journal plus database bytes", () => {
    const one = SentinelStore.estimateCharge({ issues: [record(1)] });
    const two = SentinelStore.estimateCharge({ issues: [record(1), record(2)] });
    expect(two - one).toBe(one - SentinelStore.estimateCharge({}));
    expect(SentinelStore.estimateCharge({})).toBe(3 * 4096);
  });
});
