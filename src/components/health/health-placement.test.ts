// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Health placement (Sean 11-01): the Inbox shows what needs the owner first, identical issues fold, every issue answers
// what happened, does it matter and what can I do, and a note never counts or adds a red dot.
import { readFileSync, readdirSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { en } from "@/locales";
import { HEALTH_ISSUE_LEVELS, foldHealthRows, healthIssueLevel, strongestHealthLevel } from "../../../shared/health-levels";
import { HEALTH_COPY, HEALTH_TITLES, HEALTH_TITLE_FALLBACK, NEXT_ACTION_LABELS, healthStateLine, type HealthIssue, type ViewSummary } from "../../../shared/sentinel-view";
import { HEALTH_GUIDES, HEALTH_GUIDE_FALLBACK, foldTimeLine, goLabel, healthDestination, healthGuide } from "./health-guide";
import { HealthDigestView, HealthFoldRow, deletionCanRetry, deletionFigures, deletionHolders, healthFolds, readHealthIssues, recoveryLabel } from "./HealthIssues";
import { EngineNeedCard, HealthNeedCard } from "./HealthNeedCard";
import { healthFromEngines, healthWithChecks } from "./health-status";
import { engineNeed } from "@/lib/engine-need";

const NOW = Date.UTC(2026, 10, 1, 12, 0);
const DAY = 86_400_000;
const issue = (n: number, titleKey: string, overrides: Partial<HealthIssue> = {}): HealthIssue => ({
  fingerprint: n.toString(16).padStart(64, "0"), titleKey, count: 1, firstSeenAt: NOW - 3 * DAY, lastSeenAt: NOW - 2 * DAY, state: "open", metrics: {}, ...overrides,
} as HealthIssue);
const DELETION = "health.deletion.still-pending";
const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const source = (name: string) => read(`../${name}`);

describe("identical issues fold", () => {
  it("Sean's five rows become one line with a count and the time", () => {
    const folds = foldHealthRows([1, 2, 3, 4, 5].map((n) => issue(n, DELETION)));
    expect(folds).toHaveLength(1);
    expect(folds[0]).toMatchObject({ titleKey: DELETION, issues: 5, count: 5, lastSeenAt: NOW - 2 * DAY });
    const out = renderToStaticMarkup(createElement(HealthFoldRow, { fold: { ...folds[0]!, titleKey: "health.resets.loop" }, now: NOW }));
    expect(out).toContain("5 of these, last seen 2 days ago");
  });
  it("adds counts, keeps the widest time, and puts what needs the owner first", () => {
    const folds = foldHealthRows([
      issue(1, "health.resets.loop", { count: 3, firstSeenAt: 5, lastSeenAt: 50 }), issue(2, "health.resets.loop", { count: 4, firstSeenAt: 2, lastSeenAt: 90 }),
      issue(3, "health.extraction.unusable-replies"), issue(4, "health.backup.not-protected"),
    ]);
    expect(folds.map((fold) => fold.level)).toEqual(["act", "watch", "note"]);
    expect(folds[2]).toMatchObject({ issues: 2, count: 7, firstSeenAt: 2, lastSeenAt: 90 });
  });
  it("one issue shows no count; an issue shown under another adds no line", () => {
    expect(foldTimeLine(1, "1 h ago")).toBe("Last seen 1 h ago");
    expect(healthFolds([issue(1, DELETION), issue(2, "health.engine-holds.home-held", { presentedBy: "x".repeat(64) })]).map((fold) => fold.titleKey)).toEqual([DELETION]);
  });
});

describe("every issue answers three questions", () => {
  const titles = Object.keys(HEALTH_TITLES);
  it("the title, level and guide tables list the same issues", () => {
    expect(Object.keys(HEALTH_ISSUE_LEVELS).sort()).toEqual([...titles].sort());
    expect(Object.keys(HEALTH_GUIDES).sort()).toEqual([...titles].sort());
  });
  it("every title a detector can raise is in the tables", () => {
    const dir = new URL("../../../server/sentinel/detectors/", import.meta.url);
    const named = readdirSync(dir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "fixtures.ts")
      .flatMap((file) => [...readFileSync(new URL(file, dir), "utf8").matchAll(/["`](health\.[a-z-]+\.[a-z-]+)["`]/g)].map((match) => match[1]!));
    expect(named.length).toBeGreaterThan(9);
    for (const key of named) expect(titles, key).toContain(key);
    for (const key of ["not-protected", "overdue", "capture-stalled"]) expect(titles).toContain(`health.backup.${key}`);
    for (const key of ["server", "desktop", "backup", "db-stats"]) expect(titles).toContain(`health.coverage.source-unavailable-${key}`);
  });
  it("every sentence exists, follows the copy rules, and a title matches the catalogue", () => {
    for (const [key, guide] of Object.entries(HEALTH_GUIDES)) {
      expect(en[guide.title], key).toBe(HEALTH_TITLES[key]);
      for (const field of [guide.happened, guide.matters, guide.canDo]) {
        expect(en[field], `${key} ${field}`).toBeTruthy();
        expect(en[field]).not.toMatch(/—|\s-\s|\b(safe|safely|safety|unsafe)\b/i);
      }
    }
    expect(en[HEALTH_GUIDE_FALLBACK.title]).toBe(HEALTH_TITLE_FALLBACK);
    expect(healthGuide("health.newer.unknown")).toBe(HEALTH_GUIDE_FALLBACK);
  });
  it("no dead ends: a row is a button, a retry, or says plainly there is nothing to do", () => {
    for (const [key, guide] of Object.entries(HEALTH_GUIDES)) {
      if (guide.action.kind === "go") { expect(goLabel(guide.action.to), key).toBeTruthy(); expect(healthDestination(guide.action.to), key).not.toBeNull(); }
      else expect(en[guide.canDo], key).toMatch(/^Nothing to do/);
    }
  });
  it("an issue with nothing to do drops its alarm: only an issue with a real button is above a note", () => {
    for (const [key, guide] of Object.entries(HEALTH_GUIDES)) expect(healthIssueLevel(key) === "note", key).toBe(guide.action.kind !== "go");
  });
  it("the server's next action agrees with the button", () => {
    const table = source("../../server/sentinel/publication.ts");
    expect(table).toContain('backup: "backups", "io-pressure": "manage-storage", extraction: "memory-settings", "dispatch-exhausted": "engines"');
    expect(table).toContain('"engine-holds": "none", deletion: "none", "send-fence": "none", resets: "none", "isolation-noise": "none", coverage: "none"');
    expect(NEXT_ACTION_LABELS.none).toBeNull();
  });
  it("a row shows all three answers and its button", () => {
    const [fold] = foldHealthRows([issue(1, "health.backup.not-protected")]);
    const out = renderToStaticMarkup(createElement(HealthFoldRow, { fold: fold!, now: NOW, onGo: () => undefined }));
    for (const words of ["What happened", "Does it matter", "What you can do", "Backups are on", "Open Backups"]) expect(out).toContain(words);
  });
  it("a row with nothing to do has no button but More", () => {
    const [fold] = foldHealthRows([issue(1, "health.resets.loop")]);
    const out = renderToStaticMarkup(createElement(HealthFoldRow, { fold: fold!, now: NOW, onGo: () => undefined }));
    expect(out).toContain("Nothing to do, Murage is on it.");
    expect(out.match(/<button/g)).toHaveLength(1);
  });
});

describe("what reaches Needs you", () => {
  it("only a problem the owner must act on is act, and an unknown title can never raise an alarm", () => {
    expect(Object.entries(HEALTH_ISSUE_LEVELS).filter(([, level]) => level === "act").map(([key]) => key)).toEqual(["health.backup.not-protected"]);
    expect(healthIssueLevel("health.newer.unknown")).toBe("note");
    expect(strongestHealthLevel([])).toBeNull();
    expect(strongestHealthLevel([{ titleKey: DELETION }, { titleKey: "health.extraction.unusable-replies" }])).toBe("watch");
  });
  it("the need card is one action, with no Dismiss", () => {
    let opened = "";
    const out = renderToStaticMarkup(createElement(HealthNeedCard, { need: { titleKey: "health.backup.not-protected", issues: 1, lastSeenAt: NOW - 60_000 }, now: NOW, onOpen: (section) => { opened = section; } }));
    expect(out.match(/<button/g)).toHaveLength(1);
    expect(out).toContain("Open Backups");
    expect(out).toContain("No recent verified backup");
    expect(opened).toBe("");
    expect(renderToStaticMarkup(createElement(EngineNeedCard, { title: "t", detail: "d", label: "Open Engines", onOpen: () => undefined }))).toContain("Open Engines");
  });
  it("the Inbox body carries no Health card, and the link sits above the scrolling list", () => {
    const inbox = source("Inbox.tsx");
    expect(inbox).not.toContain("HealthCard");
    expect(inbox).not.toContain("inHealth");
    const page = read("../shell/stubs/needs-page.tsx");
    const link = page.indexOf("data-needs-health-link");
    expect(link).toBeGreaterThan(0);
    expect(link).toBeLessThan(page.indexOf("<Inbox"));
    expect(inbox).toContain('const healthNeeds = view === "decisions" || view === "all" ? result?.health?.needs ?? [] : [];');
  });
  it("an engine or Flux problem is an item, so a red dot never stands alone, and is not said twice", () => {
    const signedOut = { id: "claude", label: "Claude", state: "signed-out" as const, line: "" };
    expect(engineNeed({ engine: null, flux: "allowance-used-up" }, [], false)?.section).toBe("models");
    expect(engineNeed({ engine: null, flux: "key-problem" }, [], false)?.section).toBe("models");
    expect(engineNeed({ engine: { ...signedOut, state: "missing" }, flux: "none" }, [], false)?.section).toBe("engines");
    expect(engineNeed({ engine: signedOut, flux: "none" }, [{ id: "claude" }], false)).toBeNull();
    expect(engineNeed({ engine: signedOut, flux: "none" }, [], false)?.key).toBe("engine:claude");
    expect(engineNeed({ engine: null, flux: "key-problem" }, [], true)).toBeNull();
    expect(engineNeed({ engine: { ...signedOut, state: "ready" }, flux: "ok" }, [], false)).toBeNull();
  });
});

describe("the Health level", () => {
  const ok = healthFromEngines({ id: "a", label: "A", state: "ready", line: "" }, "ok", true);
  it("a note adds no colour; watch is amber; act is red, and an engine's own words win", () => {
    expect(ok.level).toBe("ok");
    expect(healthWithChecks(ok, "note")).toBe(ok);
    expect(healthWithChecks(ok, null)).toBe(ok);
    expect(healthWithChecks(ok, "watch").level).toBe("watch");
    expect(healthWithChecks(ok, "act").level).toBe("act");
    const signedOut = healthFromEngines({ id: "a", label: "A", state: "signed-out", line: "" }, "ok", true);
    expect(healthWithChecks(signedOut, "act")).toBe(signedOut);
  });
  it("the red dot on your name is for act alone", () => {
    expect(source("Sidebar.tsx")).toContain('{health.level === "act" && <StatusDot level="act"');
  });
  it("the Health notification opens the Health screen", () => {
    expect(source("../state/store.tsx")).toContain('showHealthPage(frame.notification, () => dispatch({ type: "showHealth" }))');
  });
  it("Settings has one line to the Health screen, outside every desktop-only guard", () => {
    const settings = source("SettingsModal.tsx");
    const line = settings.split("\n").find((text) => text.includes("<SettingsHealthRow />"))!;
    expect(line).toBeTruthy();
    expect(line).not.toContain("desktop === true");
    expect(settings).toContain('dispatch({ type: "showHealth" })');
  });
});

describe("deleted conversations: real state and retry", () => {
  const line = (overrides = {}) => ({ text: "x", tryAgain: true, covers: [], ...overrides });
  it("offers Try again now only where it can change something", () => {
    expect(deletionCanRetry({ lines: [line()] }, true)).toBe(true);
    expect(deletionCanRetry({ lines: [line()] }, false)).toBe(false);
    expect(deletionCanRetry({ lines: [line({ byItself: true as const })] }, true)).toBe(false);
    expect(deletionCanRetry({ lines: [line({ waitsForUpdate: true as const })] }, true)).toBe(false);
    expect(deletionCanRetry({ lines: [line({ tryAgain: false })] }, true)).toBe(false);
    expect(deletionCanRetry(null, true)).toBe(false);
  });
  it("engines share a deletion, so the figures take the largest, never the sum", () => {
    expect(deletionFigures([issue(1, DELETION, { metrics: { pending: 3, oldestPendingHours: 50 } }), issue(2, DELETION, { metrics: { pending: 5 } })])).toEqual({ pending: 5, oldestHours: 50 });
    expect(deletionFigures([issue(1, DELETION)])).toEqual({ pending: 0, oldestHours: null });
  });
  it("says which engine is holding it up", () => {
    expect(deletionHolders({ lines: [line({ byItself: true as const, label: "Claude Code" }), line({ byItself: true as const, label: "Grok" }), line({ label: "Codex" })] })).toBe("Claude Code and Grok");
    expect(deletionHolders({ lines: [line({ label: "Codex" })] })).toBe("");
    expect(deletionHolders(null)).toBe("");
  });
  it("uses the startup lane's fixed names", () => {
    expect(HEALTH_GUIDES[DELETION]?.action.kind).toBe("retry-deletions");
    expect(read("./HealthIssues.tsx")).toContain('"/api/deletions/retry"');
  });
});

describe("the Health screen's reads", () => {
  const page = (items: HealthIssue[], next: string | null = null) => ({ ok: true as const, storeRevision: 1, items, next });
  it("reads every page, and starts again when Health moves between pages", async () => {
    const calls: string[] = [];
    let conflicted = false;
    const fake = (async (url: string) => {
      calls.push(url);
      if (url.includes("after=")) { if (!conflicted) { conflicted = true; throw Object.assign(new Error("moved"), { status: 409 }); } return page([issue(2, DELETION)]); }
      return page([issue(1, DELETION)], "cursor");
    }) as never;
    expect((await readHealthIssues("open", undefined, fake)).map((item) => item.titleKey)).toEqual([DELETION, DELETION]);
    expect(calls).toHaveLength(4);
  });
  it("a refused read throws, so the screen says so instead of showing all clear", async () => {
    await expect(readHealthIssues("open", undefined, (async () => ({ ok: false, reason: "unavailable" })) as never)).rejects.toThrow("unavailable");
  });
});

describe("words carried over", () => {
  const summary = (overrides: Partial<ViewSummary> = {}): ViewSummary => ({ openCount: 0, highestSeverity: null, topTitleKey: null, lastCheckedAt: NOW - 120_000, lastCompleteCheckAt: NOW - 120_000, coverage: "complete", scanner: "running", recoveredCount: 0, moreCount: 0, ...overrides });
  it("states say exactly what was checked", () => {
    expect(healthStateLine("ready", summary(), NOW)).toEqual({ sentence: HEALTH_COPY.noIssues, time: "Checked 2 min ago" });
    expect(healthStateLine("ready", summary({ scanner: "stopped" }), NOW).time).toBe("Health checks last ran 2 min ago");
    expect(healthStateLine("waiting", null, NOW).sentence).toBe(HEALTH_COPY.notSetUp);
    expect(healthStateLine("unavailable", null, NOW).sentence).toBe(HEALTH_COPY.unavailable);
  });
  it("only an observed recovery is Recovered", () => {
    expect(recoveryLabel("resolved", "observed-recovery")).toBe(HEALTH_COPY.recovered);
    expect(recoveryLabel("resolved", "policy-ended")).toBe("Closed after the setting changed");
    expect(recoveryLabel("resolved", "source-retired")).toBe("Closed, the source is no longer in use");
  });
  it("the daily summary keeps its rows and the Recovered line", () => {
    const out = renderToStaticMarkup(createElement(HealthDigestView, { now: NOW, digest: { id: "d", date: "2026-11-01", storeRevision: 1, createdAt: NOW - 60_000, moreCount: 2, recoveredCount: 1,
      rows: [{ titleKey: "health.extraction.unusable-replies", severity: "medium", issues: 1, count: 82, firstSeenAt: NOW - 40 * 3_600_000, lastSeenAt: NOW }] } }));
    expect(out).toContain("seen 82 times over 40 h");
    expect(out).toContain("2 more in Health");
    expect(out).toContain("Recovered: 1 issue");
  });
});
