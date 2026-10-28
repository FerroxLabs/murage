// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HEALTH_LIMITS } from "../../shared/health-protocol.mjs";
import { T0 } from "./detectors/fixtures.ts";
import { VIEW_FILE, buildView, publishView, readIssuesPage, readPageIntents, readPublishedView, statusView, viewFromStore } from "./publication.ts";
import { INST, cleanupFixtures, issueRecord, makeInstall } from "./scan-fixtures.ts";
import { SentinelStore } from "./store.ts";

const posixOnly = process.platform === "win32" ? it.skip : it;
afterEach(() => cleanupFixtures());

function seeded(count: number) {
  const fx = makeInstall();
  const opened = SentinelStore.open(fx.descriptor.outputRoot, { installationId: INST });
  if (opened.status !== "ok") throw new Error(opened.status);
  const store = opened.store;
  for (let start = 0; start < count; start += 30) {
    store.commit({ issues: Array.from({ length: Math.min(30, count - start) }, (_, i) => issueRecord(start + i + 1, { severity: (start + i) % 3 === 0 ? "high" : "medium" })) });
  }
  return { fx, store, root: fx.descriptor.outputRoot };
}

describe("view publication", () => {
  it("shows at most 25 rows within 16 KiB and counts the rest", () => {
    const { store } = seeded(40);
    const view = viewFromStore(store, T0, "running", "complete", T0, T0);
    expect(view.rows.length).toBe(25);
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(HEALTH_LIMITS.viewBytes);
    expect(view.summary.openCount).toBe(40);
    expect(view.summary.moreCount).toBe(15);
    expect(view.summary.highestSeverity).toBe("high");
    expect(view.rows[0]!.severity).toBe("high");
    store.close();
  });

  it("drops rows to stay within 16 KiB, counting them as more", () => {
    const records = Array.from({ length: 25 }, (_, i) => issueRecord(i + 1, { titleKey: `k${"x".repeat(900)}` }));
    const view = buildView({ storeRevision: 1, now: T0, scanner: "running", coverage: "complete", lastCheckedAt: T0, lastCompleteCheckAt: T0, records, openCount: 25 });
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(HEALTH_LIMITS.viewBytes);
    expect(view.rows.length + view.summary.moreCount).toBe(25);
  });

  posixOnly("writes atomically, owner-only, and only when the contents change", () => {
    const { store, root } = seeded(3);
    const view = viewFromStore(store, T0, "running", "complete", T0, T0);
    expect(publishView(root, view)).toBeGreaterThan(0);
    expect(statSync(join(root, VIEW_FILE)).mode & 0o777).toBe(0o600);
    expect(publishView(root, { ...view, publishedAt: T0 + 120_000 })).toBe(0);
    expect(readPublishedView(root)?.publishedAt).toBe(T0);
    expect(publishView(root, { ...view, summary: { ...view.summary, coverage: "partial" } })).toBeGreaterThan(0);
    store.close();
  });

  it("a status view keeps the last valid rows and states the scanner condition", () => {
    const { store, root } = seeded(2);
    publishView(root, viewFromStore(store, T0, "running", "complete", T0, T0));
    const last = readPublishedView(root);
    const status = statusView(last, T0 + 1, "upgrade-needed");
    expect(status.rows).toEqual(last!.rows);
    expect(status.summary.scanner).toBe("upgrade-needed");
    expect(statusView(null, T0, "unavailable").rows).toEqual([]);
    store.close();
  });

  it("ignores a malformed or oversize view file instead of trusting it", () => {
    const { root, store } = seeded(1);
    publishView(root, viewFromStore(store, T0, "running", "complete", T0, T0));
    const text = readFileSync(join(root, VIEW_FILE), "utf8");
    expect(JSON.parse(text).schemaVersion).toBe(1);
    store.close();
  });
});

describe("owner API reads", () => {
  it("pages open issues by severity and recency with an opaque cursor, at most 50 per page", () => {
    const { store, root } = seeded(70);
    store.close();
    const first = readIssuesPage(root, INST, { state: "open", limit: 500 });
    if (!first.ok) throw new Error(first.reason);
    expect(first.items.length).toBe(50);
    expect(first.items.every(i => !("installationId" in i))).toBe(true);
    const second = readIssuesPage(root, INST, { state: "open", after: first.next, limit: 50 });
    if (!second.ok) throw new Error(second.reason);
    expect(second.items.length).toBe(20);
    expect(second.next).toBeNull();
    const all = [...first.items, ...second.items].map(i => i.fingerprint);
    expect(new Set(all).size).toBe(70);
    const ranks = [...first.items, ...second.items].map(i => (i.severity === "high" ? 3 : 2));
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
  });

  it("asks for a refresh when the store revision moved, and rejects a forged cursor", () => {
    const { store, root } = seeded(30);
    const first = readIssuesPage(root, INST, { state: "open", limit: 10 });
    if (!first.ok) throw new Error(first.reason);
    store.commit({ issues: [issueRecord(999)] });
    store.close();
    expect(readIssuesPage(root, INST, { state: "open", after: first.next, limit: 10 })).toEqual({ ok: false, reason: "refresh" });
    expect(readIssuesPage(root, INST, { state: "open", after: "../../etc/passwd" })).toEqual({ ok: false, reason: "bad-cursor" });
    expect(readIssuesPage(root, INST, { state: "everything" as never })).toEqual({ ok: false, reason: "bad-request" });
  });

  it("keeps a page within 64 KiB", () => {
    const fx = makeInstall();
    const opened = SentinelStore.open(fx.descriptor.outputRoot, { installationId: INST });
    if (opened.status !== "ok") throw new Error(opened.status);
    opened.store.commit({ issues: Array.from({ length: 50 }, (_, i) => issueRecord(i + 1, { titleKey: `t${"y".repeat(2_000)}` })) });
    opened.store.close();
    const page = readIssuesPage(fx.descriptor.outputRoot, INST, { state: "open", limit: 50 });
    if (!page.ok) throw new Error(page.reason);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(HEALTH_LIMITS.apiResponseBytes);
    expect(page.next).not.toBeNull();
  });

  it("is unavailable for a missing store or another installation, and never creates one", () => {
    const fx = makeInstall();
    expect(readIssuesPage(fx.descriptor.outputRoot, INST, { state: "open" })).toEqual({ ok: false, reason: "unavailable" });
    expect(() => readFileSync(join(fx.descriptor.outputRoot, "state.sqlite"))).toThrow();
    const { root, store } = seeded(1);
    store.close();
    expect(readIssuesPage(root, "f".repeat(32), { state: "open" })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("lists every page intent oldest first with whether its issue episode is still open, read-only", () => {
    const { store, root } = seeded(1);
    const issue = issueRecord(1, { severity: "high" });
    const fpOpen = issue.issue.fingerprint;
    store.commit({ intents: [
      { id: "1".repeat(32), fingerprint: fpOpen, episode: 1, delivery: "page", reason: "page", titleKey: "backup.unverified", createdAt: T0 },
      { id: "2".repeat(32), fingerprint: "e".repeat(64), episode: 1, delivery: "digest", reason: "opened", titleKey: "x", createdAt: T0 + 1 },
      { id: "3".repeat(32), fingerprint: "f".repeat(64), episode: 1, delivery: "page", reason: "page", titleKey: "x", createdAt: T0 + 2 },
      { id: "4".repeat(32), fingerprint: fpOpen, episode: 2, delivery: "page", reason: "page", titleKey: "x", createdAt: T0 + 3 },
    ] });
    const before = readPageIntents(root, INST);
    expect(before.ok && before.intents.map(i => [i.id[0], i.open])).toEqual([["1", true], ["3", false], ["4", false]]);
    store.commit({ issues: [{ ...issue, issue: { ...issue.issue, state: "resolved", resolvedAt: T0 + 4 } }] });
    store.close();
    const after = readPageIntents(root, INST);
    expect(after.ok && after.intents[0]).toMatchObject({ id: "1".repeat(32), fingerprint: fpOpen, episode: 1, titleKey: "backup.unverified", createdAt: T0, open: false });
  });
});
