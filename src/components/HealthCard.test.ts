// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Health card and details (1.0.9 Sentinel, GAP-SENTINEL-109 section 8.1; SENTINEL-UI): render states, the exact
// copy, the backup notice inside Health, the digest, labels for keyboard and screen readers, where next actions go,
// and where the card is mounted. Renders statically; the copy is checked against the repo's copy rules.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HEALTH_COPY, HEALTH_TITLES, HEALTH_TITLE_FALLBACK, NEXT_ACTION_LABELS, healthStateLine, healthTitle, type HealthInbox, type ViewRow, type ViewSummary } from "../../shared/sentinel-view";
import { HealthCard, HealthDigestView, cardModel, healthDestination } from "./HealthCard";
import { COVERAGE_LABELS, HealthIssueRow, recoveryLabel } from "./HealthDetails";

const NOW = Date.UTC(2026, 9, 27, 12, 0);
const summary = (overrides: Partial<ViewSummary> = {}): ViewSummary => ({ openCount: 0, highestSeverity: null, topTitleKey: null, lastCheckedAt: NOW - 2 * 60_000,
  lastCompleteCheckAt: NOW - 2 * 60_000, coverage: "complete", scanner: "running", recoveredCount: 0, moreCount: 0, ...overrides });
const row = (n: number, overrides: Partial<ViewRow> = {}): ViewRow => ({ fingerprint: n.toString(16).padStart(64, "0"), detectorId: "backup", titleKey: "health.backup.not-protected",
  severity: "high", state: "open", delivery: "page", firstSeenAt: NOW - 3 * 3_600_000, lastSeenAt: NOW - 600_000, count: 4, coverage: "complete", nextAction: "backups", ...overrides });
const health = (s: ViewSummary | null, rows: ViewRow[] = [], status: HealthInbox["status"] = "ready"): HealthInbox => ({ status, summary: s, rows, digest: null });
const html = (props: Parameters<typeof HealthCard>[0]) => renderToStaticMarkup(createElement(HealthCard, { now: NOW, ...props }));

describe("the card's states", () => {
  it("an empty complete check says exactly what was checked", () => {
    const out = html({ health: health(summary()) });
    expect(out).toContain("No issues found in the checked sources.");
    expect(out).toContain("Checked 2 min ago");
    expect(out).not.toContain("open issue");
  });
  it("incomplete coverage says checks are waiting, with the last complete check", () => {
    const out = html({ health: health(summary({ coverage: "partial", lastCompleteCheckAt: NOW - 3 * 3_600_000 })) });
    expect(out).toContain("Some health checks are waiting for fresh information.");
    expect(out).toContain("Last complete check 3 h ago");
  });
  it("a stopped checker says when it last ran", () => {
    expect(healthStateLine("ready", summary({ scanner: "stopped" }), NOW).time).toBe("Health checks last ran 2 min ago");
    expect(healthStateLine("ready", summary({ lastCheckedAt: NOW - 45 * 60_000 }), NOW)).toEqual({ sentence: HEALTH_COPY.waiting, time: "Health checks last ran 45 min ago" });
  });
  it("open issues lead with the highest-impact fixed sentence and the count", () => {
    const out = html({ health: health(summary({ openCount: 2, topTitleKey: "health.backup.not-protected" }), [row(1), row(2, { titleKey: "health.io-pressure.sustained-writes", severity: "medium" })]) });
    expect(out).toContain("No recent verified backup");
    expect(out).toContain("2 open issues");
    expect(out).toContain("Heavy disk writes while Murage was idle");
  });
  it("not set up and unavailable read as plain observations", () => {
    expect(html({ health: health(null, [], "waiting") })).toContain(HEALTH_COPY.notSetUp);
    expect(html({ health: health(null, [], "unavailable") })).toContain(HEALTH_COPY.unavailable);
  });
  it("shows at most five rows and never a resolved one", () => {
    const rows = [...Array.from({ length: 7 }, (_, i) => row(i + 1)), row(9, { state: "resolved" })];
    expect(cardModel({ status: "ready", summary: summary({ openCount: 7 }), rows }, NOW).rows).toHaveLength(5);
  });
  it("an unknown title key falls back to one plain sentence; input text never reaches the screen", () => {
    expect(healthTitle("health.made-up <b>x</b>")).toBe("A health check found something to look at");
    expect(html({ health: health(summary({ openCount: 1, topTitleKey: "<script>alert(1)</script>" }), [row(1, { titleKey: "C:\\Users\\me\\secret" })]) })).not.toMatch(/script|Users|secret/);
  });
});

describe("the backup notice inside Health", () => {
  it("keeps the existing sentence and its Open Backups action", () => {
    const out = html({ health: health(summary({ openCount: 1, topTitleKey: "health.backup.not-protected" }), [row(1)]), backupNotice: { sentence: "The backup folder could not be reached." }, onOpenBackups: () => undefined });
    expect(out).toContain("The last backup didn&#x27;t finish");
    expect(out).toContain("The backup folder could not be reached.");
    expect(out).toContain("Open Backups");
  });
});

describe("the digest", () => {
  it("one heading, grouped rows with counts and duration, one Recovered line, View Health", () => {
    const out = renderToStaticMarkup(createElement(HealthDigestView, { now: NOW, onView: () => undefined, digest: { id: "health-digest-2026-10-27-4", date: "2026-10-27", storeRevision: 4, createdAt: NOW - 3_600_000,
      rows: [{ titleKey: "health.extraction.unusable-replies", severity: "medium", issues: 2, count: 9, firstSeenAt: NOW - 2 * 86_400_000, lastSeenAt: NOW - 3_600_000 }], moreCount: 3, recoveredCount: 2 } }));
    expect(out).toContain("Daily health summary");
    expect(out).toContain("Memory learning got replies it could not use");
    expect(out).toContain("seen 9 times over 47 h, 2 issues");
    expect(out).toContain("3 more in Health");
    expect(out).toContain("Recovered: 2 issues");
    expect(out).toContain("View Health");
    expect(out.match(/<h3/g)).toHaveLength(1);
  });
});

describe("details", () => {
  it("each row names first and last seen, the window, the count, recovery, coverage and the next action", () => {
    const issue = { schemaVersion: 1, fingerprint: "a".repeat(64), detectorVersion: 1, detectorId: "io-pressure", subsystem: "storage", code: "sustained", severity: "high", state: "recovering", episode: 1,
      titleKey: "health.io-pressure.sustained-writes", firstSeenAt: NOW - 86_400_000, lastSeenAt: NOW - 600_000, openedAt: NOW - 86_400_000, count: 12, window: { startAt: NOW - 300_000, endAt: NOW },
      metrics: {}, coverage: { overall: "partial", sources: [] }, delivery: "page", nextAction: "manage-storage", recoveryStartedAt: NOW - 60_000 } as never;
    const out = renderToStaticMarkup(createElement(HealthIssueRow, { issue, now: NOW, onNavigate: () => undefined }));
    for (const text of ["Heavy disk writes while Murage was idle", "Improving, still being checked", "Times seen: </dt><dd class=\"inline\">12", "First seen: </dt><dd class=\"inline\">24 h ago",
      "Last seen: </dt><dd class=\"inline\">10 min ago", "Measured over: </dt><dd class=\"inline\">5 min", COVERAGE_LABELS.partial, "Manage storage"]) expect(out).toContain(text);
    expect(out).toMatch(/<li aria-labelledby="health-issue-a{16}"/);
  });
  it("only an observed recovery is ever Recovered", () => {
    expect(recoveryLabel("resolved", "observed-recovery")).toBe("Recovered");
    expect(recoveryLabel("resolved", "policy-ended")).not.toContain("Recovered");
    expect(recoveryLabel("resolved", "source-retired")).not.toContain("Recovered");
    expect(recoveryLabel("open")).toBe("Open");
  });
});

describe("keyboard, screen readers and narrow screens", () => {
  it("the card is a labelled region with a live status line and a disclosure button", () => {
    const out = html({ health: health(summary()) });
    expect(out).toContain('aria-labelledby="health-card-title"');
    expect(out).toContain('role="status"');
    expect(out).toMatch(/<button type="button"[^>]*aria-expanded="false" aria-controls="health-details"/);
    expect(out).not.toMatch(/tabindex="-1"/);
    expect(out).toContain("flex-wrap");
  });
  it("opened details offer Open and Resolved as pressed toggles", () => {
    const out = html({ health: health(summary()), initiallyOpen: true });
    expect(out).toContain('aria-expanded="true"');
    expect(out).toMatch(/aria-pressed="true"[^>]*>Open</);
    expect(out).toContain(">Resolved<");
  });
});

describe("where next actions go", () => {
  it("only to existing Settings pages", () => {
    expect(healthDestination("backups")).toEqual({ section: "backups" });
    expect(healthDestination("manage-storage")).toEqual({ section: "storage" });
    expect(healthDestination("memory-settings")).toEqual({ section: "memory" });
    expect(healthDestination("diagnostics")).toEqual({ section: "about", anchor: "diagnostics-heading" });
    expect(healthDestination("none")).toBeNull();
    expect(NEXT_ACTION_LABELS.none).toBeNull();
  });
});

describe("copy rules", () => {
  it("no em dash and none of the forbidden words in any Health sentence", () => {
    const words = [...Object.values(HEALTH_TITLES), ...Object.values(HEALTH_COPY), ...Object.values(COVERAGE_LABELS), ...Object.values(NEXT_ACTION_LABELS).filter(Boolean) as string[]];
    expect(words.length).toBeGreaterThan(25);
    for (const text of words) expect(text).not.toMatch(/\u2014|\b(safe|safely|safety|unsafe)\b/i);
    expect(HEALTH_COPY.noIssues).toBe("No issues found in the checked sources.");
    expect(HEALTH_COPY.waiting).toBe("Some health checks are waiting for fresh information.");
  });
  it("every detector title key has a sentence", () => {
    const detectors = readFileSync(new URL("../../server/sentinel/detectors/backup.ts", import.meta.url), "utf8");
    expect(detectors).toContain('"not-protected", "overdue", "capture-stalled"');
    for (const key of ["health.backup.not-protected", "health.backup.overdue", "health.backup.capture-stalled", "health.io-pressure.sustained-writes", "health.extraction.unusable-replies",
      "health.engine-holds.home-held", "health.deletion.still-pending", "health.send-fence.rebuilding", "health.dispatch.exhausted-turns", "health.resets.loop", "health.isolation-noise.fallback",
      "health.coverage.producer-silent-server", "health.coverage.producer-silent-desktop", "health.coverage.stats-stale", "health.coverage.scan-failing"]) expect(HEALTH_TITLES[key]).toBeTruthy();
  });

  it("every source the coverage check can report as unavailable has its own sentence", () => {
    const coverage = readFileSync(new URL("../../server/sentinel/detectors/coverage.ts", import.meta.url), "utf8");
    expect(coverage).toContain("`source-unavailable-${role}`");
    for (const role of ["server", "desktop", "backup", "db-stats"]) {
      const title = healthTitle(`health.coverage.source-unavailable-${role}`);
      expect(title, role).not.toBe(HEALTH_TITLE_FALLBACK);
    }
  });
});

describe("where the card is mounted", () => {
  const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
  it("in the Inbox, with the stopped backup shown once", () => {
    const inbox = read("./Inbox.tsx");
    expect(inbox).toContain("<HealthCard health={health} backupNotice={backupInHealth ? backupFailed : null}");
    expect(inbox).toContain("{backupFailed && !backupInHealth && (");
  });
  it("in Settings beside Diagnostics, outside every desktop-only guard", () => {
    const settings = read("./SettingsModal.tsx");
    const line = settings.split("\n").find(text => text.includes("<SettingsHealthRow />"))!;
    expect(line).toBeTruthy();
    expect(line).not.toContain("desktop === true");
    const at = settings.indexOf("<SettingsHealthRow />");
    expect(settings.indexOf('id="diagnostics-heading"', at)).toBeGreaterThan(at);
  });
});
