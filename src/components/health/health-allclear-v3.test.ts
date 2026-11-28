// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ALLCLEAR-V3 (1.0.23 row AC3, designs/ALLCLEAR-V3-1023.md r4): the Health page says "all clear" only after every
// queued Check again / Switch on has finished and the page has read the engines, the Sentinel summary and the open issues
// as one snapshot. Witness ids (W1..W16) are the design's. The real HealthPageBody is mounted; only `api` is faked,
// and W7/W13b route Sentinel reads through the real handleSentinelRead.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineHealthAnswer, EngineHealthRow } from "@/components/shell/shell-contract";
import { t } from "@/lib/i18n";
import * as actions from "@/lib/health-actions";
import * as engineHealth from "@/components/today/use-engine-health";
import { handleSentinelRead } from "../../../server/sentinel/owner-api";
import { HEALTH_COPY, HEALTH_STALE_MS, healthTitle, type HealthIssue, type HealthSummaryResponse } from "../../../shared/sentinel-view";
import { healthGuide } from "./health-guide";
import { HEALTH_ISSUE_PAGES, readHealthIssuesAt } from "./HealthIssues";

const fx = vi.hoisted(() => ({ api: (async () => null) as (path: string, init?: RequestInit) => Promise<unknown>, state: {} as Record<string, unknown>, subs: new Set<() => void>() }));
vi.mock("@/state/store", async (original) => {
  const real = await original<typeof import("@/state/store")>();
  const { useSyncExternalStore: use } = await import("react");
  const sub = (l: () => void) => { fx.subs.add(l); return () => { fx.subs.delete(l); }; };
  const useStoreFx = () => { use(sub, () => fx.state); return { state: fx.state, dispatch: () => {} }; };
  return { ...real, api: (path: string, init?: RequestInit) => fx.api(path, init), useStore: useStoreFx, useStoreIfAny: () => ({ state: fx.state, dispatch: () => {} }) };
});
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));

const { HealthPageBody } = await import("./HealthPageBody");
const { initialState } = await vi.importActual<typeof import("@/state/store")>("@/state/store");

// ---- fixtures ---------------------------------------------------------------------------------------------------
const DAY = 86_400_000;
const ACT_KEY = "health.backup.not-protected";
const WATCH_KEY = "health.backup.overdue";
const NOTE_KEY = "health.deletion.still-pending";
const row = (id: string, state: EngineHealthRow["state"], usedBy = 1): EngineHealthRow => ({ id, label: id === "A" ? "Alpha" : "Beta", state, line: "", usedBy });
const ans = (engines: EngineHealthRow[], flux: EngineHealthAnswer["flux"] = "ok", pct = 10): EngineHealthAnswer =>
  ({ engines, primary: engines[0] ?? null, defaultId: "A", flux, fluxInfo: { spendPct: pct, expires: null }, checkedAt: Date.now() });
const F0 = () => ans([row("A", "off"), row("B", "ready")], "ok", 85); // Switch on card + Check again card
const OK = (pct = 10) => ans([row("A", "ready"), row("B", "ready")], "ok", pct);
const summaryOf = (rev: number, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): HealthSummaryResponse => ({
  status: "ready", ...extra,
  view: { schemaVersion: 1, publishedAt: Date.now(), storeRevision: rev, rows: [], summary: { openCount: 0, highestSeverity: null, topTitleKey: null, lastCheckedAt: Date.now(), lastCompleteCheckAt: Date.now(), coverage: "complete", scanner: "running", recoveredCount: 0, moreCount: 0, ...over } },
} as HealthSummaryResponse);
const issue = (n: number, titleKey: string): HealthIssue => ({ fingerprint: n.toString(16).padStart(64, "0"), titleKey, count: 1, firstSeenAt: Date.now() - 3 * DAY, lastSeenAt: Date.now() - 1000, state: "open", metrics: {} } as HealthIssue);
const pageOf = (rev: number, items: HealthIssue[] = []) => ({ ok: true, storeRevision: rev, items, next: null });
const fail = (status: number) => Object.assign(new Error(`http ${status}`), { status });
const gate = <T = unknown>() => { let res!: (v: T) => void; let rej!: (e: unknown) => void; const p = new Promise<T>((a, b) => { res = a; rej = b; }); return { p, res, rej }; };
const never = () => new Promise<never>(() => {});
/** The real owner route answering `path`, thrown as `api` throws on a non-2xx. */
function viaHandler(path: string, locate: () => never | { ok: false; reason: string }): unknown {
  const [route, query = ""] = path.split("?");
  const out = handleSentinelRead("GET", route!, new URLSearchParams(query), { owner: true, locate: locate as never })!;
  if (out.status >= 400) throw fail(out.status);
  return out.body;
}

// ---- the fake server ------------------------------------------------------------------------------------------------
type Fn = (path: string) => unknown;
const srv = { engine: (() => OK()) as Fn, summary: (() => summaryOf(1)) as Fn, issues: (() => pageOf(1)) as Fn, patch: (() => ({})) as Fn, recheck: (() => ({})) as Fn, noAbort: false };
let calls: string[] = [];
const count = (what: string) => calls.filter((c) => c === what).length;
const SUM = "GET /api/sentinel/summary";
fx.api = (path, init) => {
  const route = path.split("?")[0]!;
  calls.push(`${init?.method ?? "GET"} ${route}`);
  const handler = route === "/api/engine-health" ? srv.engine : route === "/api/engine-health/recheck" ? srv.recheck : route === "/api/sentinel/summary" ? srv.summary
    : route === "/api/sentinel/issues" ? srv.issues : route.startsWith("/api/instances/") ? srv.patch : null;
  if (!handler) return Promise.reject(new Error(`unexpected ${path}`));
  const signal = init?.signal ?? undefined;
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal && !srv.noAbort) { if (signal.aborted) return abort(); signal.addEventListener("abort", abort); }
    Promise.resolve().then(() => handler(path)).then(resolve, reject);
  });
};

// ---- harness --------------------------------------------------------------------------------------------------------
let box: HTMLElement;
let root: Root | null = null;
type Shot = { dot: string | null; head: string; ticks: number; alert: string | null; text: string; switchDisabled: boolean | null };
let steps: Shot[] = [];
const shot = (): Shot => ({
  dot: box.querySelector("[data-health-dot]")?.getAttribute("data-health-dot") ?? null,
  head: box.querySelector("main [role='status']")?.textContent ?? "",
  ticks: (box.textContent?.match(/✓/g) ?? []).length,
  alert: box.querySelector('[role="alert"]')?.textContent ?? null,
  text: box.textContent ?? "",
  switchDisabled: button("Switch on")?.disabled ?? null,
});
const button = (label: string) => Array.from(box.querySelectorAll("button")).find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const micro = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
/** One recorded step: do something inside act, let the microtasks settle, snapshot. */
async function step(fn?: () => unknown, record = true) { await act(async () => { await fn?.(); await micro(); }); if (record) steps.push(shot()); }
const click = (label: string, record = true) => step(() => button(label)!.click(), record);
const advance = (ms: number) => step(async () => { await vi.advanceTimersByTimeAsync(ms); });
const setState = (patch: Record<string, unknown>) => step(() => { fx.state = { ...fx.state, ...patch }; for (const l of [...fx.subs]) l(); });
async function mount(record = false) {
  box = document.createElement("div");
  document.body.append(box);
  root = createRoot(box);
  await act(async () => { root!.render(createElement(HealthPageBody, { onLeave: () => {}, onOpenNeedsYou: () => {} })); await micro(); });
  if (record) steps.push(shot());
}
async function unmount() { await act(async () => { root?.unmount(); }); root = null; box.remove(); }
const OKLINE = () => [t("ux.l2a.health.ok"), HEALTH_COPY.noIssues];
const green = (s: Shot) => s.dot === "ok" || OKLINE().includes(s.head) || s.ticks > 0;
const failedLine = () => t("ux.l2b.health.do.switchOnFailed");
const reset = () => { (actions as unknown as Record<string, (() => void) | undefined>).resetHealthActionsForTests?.(); engineHealth.resetEngineHealthForTests(); };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fx.state = { ...initialState, instances: [], bots: [], groups: [], routineRuns: [], owedRev: 0 };
  Object.assign(srv, { engine: () => OK(), summary: () => summaryOf(1), issues: () => pageOf(1), patch: () => ({}), recheck: () => ({}), noAbort: false });
  calls = []; steps = [];
});
afterEach(async () => { if (root) await unmount(); reset(); vi.useRealTimers(); vi.unstubAllGlobals(); });

// ---- W1..W2d: queued actions ----------------------------------------------------------------------------------------
/** F0, Switch on (PATCH held), then Check again while the engine GET now answers all ready. */
async function queuedActions() {
  srv.engine = () => F0();
  await mount();
  const patch = gate();
  srv.patch = () => patch.p;
  await click("Switch on");
  srv.engine = () => OK();
  await click("Check again");
  return patch;
}

describe("W1/W2: no all-clear from a half-finished action", () => {
  it("W1: while the PATCH is open no step is green, and the page settles green after it ends", async () => {
    const patch = await queuedActions();
    expect(steps.length).toBeGreaterThan(1);
    expect(steps.filter(green)).toEqual([]);
    await step(() => patch.res({}));
    const last = shot();
    expect(last.dot).toBe("ok");
    expect(last.ticks).toBeGreaterThan(0);
  });

  it("W2: a failed Switch on is said even though its card unmounted, and the dot is never green on the way", async () => {
    const patch = await queuedActions();
    srv.engine = () => F0();
    await step(() => patch.rej(fail(500)));
    expect(steps.filter(green)).toEqual([]);
    expect(shot().text).toContain(failedLine());
    expect(shot().dot).toBe("watch");
  });
});

describe("W2b/W2c: the 30 s watchdog", () => {
  it("W2b: a PATCH that never answers ends at +30 s and the page reads again, with no failure line", async () => {
    vi.useFakeTimers();
    srv.engine = () => F0();
    srv.patch = () => never();
    await mount();
    await click("Switch on");
    expect(count(SUM)).toBe(1);
    await advance(30_000);
    expect(count(SUM)).toBe(2);
    expect(shot().text).not.toContain(failedLine());
  });

  it("W2c: the same PATCH failing at +35 s stores its line and starts exactly one more read", async () => {
    vi.useFakeTimers();
    const patch = gate();
    srv.engine = () => F0();
    srv.patch = () => patch.p;
    await mount();
    await click("Switch on");
    await advance(30_000);
    await advance(5_000);
    const before = count(SUM);
    await step(() => patch.rej(fail(500)));
    expect(shot().text).toContain(failedLine());
    expect(count(SUM)).toBe(before + 1);
  });
});

describe("W2d: a result line expires", () => {
  const failOnce = async () => { srv.engine = () => F0(); srv.patch = () => { throw fail(500); }; await mount(); await click("Switch on"); };
  it("(1) leaving and coming back shows no old line", async () => {
    await failOnce();
    expect(shot().text).toContain(failedLine());
    await unmount();
    await mount();
    expect(shot().text).not.toContain(failedLine());
  });
  it("(2) a later independent refresh of a mounted page clears it", async () => {
    await failOnce();
    expect(shot().text).toContain(failedLine());
    await setState({ owedRev: 1 });
    expect(shot().text).not.toContain(failedLine());
  });
  it("(3) an owedRev bump that only restarts the post-action read keeps it", async () => {
    srv.engine = () => F0();
    srv.patch = () => { throw fail(500); };
    await mount();
    const held = gate<HealthSummaryResponse>();
    let calls2 = 0;
    srv.summary = () => (++calls2 === 1 ? held.p : summaryOf(1));
    await click("Switch on");
    await setState({ owedRev: 1 });
    held.res(summaryOf(1));
    await step();
    expect(shot().text).toContain(failedLine());
  });
});

// ---- W3..W7: one snapshot -------------------------------------------------------------------------------------------
describe("W3: the page reads Sentinel again after an action", () => {
  it("an issue that appeared during Check again shows, nothing is green, and the receipt stays", async () => {
    srv.engine = () => OK(85);
    await mount();
    srv.recheck = () => {
      srv.summary = () => summaryOf(2, { openCount: 1, topTitleKey: ACT_KEY });
      srv.issues = () => pageOf(2, [issue(1, ACT_KEY)]);
      return {};
    };
    await click("Check again");
    expect(count(SUM)).toBeGreaterThanOrEqual(2);
    expect(shot().text).toContain(t(healthGuide(ACT_KEY).title));
    expect(shot().text).toContain(t("ux.l2b.health.do.checked"));
    expect(shot().dot).not.toBe("ok");
  });
});

describe("W4: a stale pair never lands after the fresh one", () => {
  it("I-stale is never rendered once the fresh pair is accepted and the stale one is released", async () => {
    srv.noAbort = true;
    srv.engine = () => F0();
    const stale = gate<HealthSummaryResponse>();
    let n = 0;
    srv.summary = () => (++n === 1 ? stale.p : summaryOf(6));
    srv.issues = () => (n <= 1 ? pageOf(5, [issue(1, ACT_KEY)]) : pageOf(6));
    await mount();
    // The "answers running" early return begins and ends in one microtask: the render never sees a pending action, only
    // the moved epoch. Done in one synchronous batch here so that is exactly what the page gets.
    const ledger = actions as unknown as { beginHealthAction?: (key: string) => number; endHealthAction?: (token: number, line?: string) => boolean };
    await step(() => { const token = ledger.beginHealthAction?.("switch:A"); if (token !== undefined) ledger.endHealthAction?.(token, t("ux.l2b.health.do.busy")); }, false);
    await step();
    expect(count(SUM)).toBe(2); // the moved epoch started a fresh read; the first pair is still held
    stale.res(summaryOf(5, { openCount: 1, topTitleKey: ACT_KEY }));
    await step();
    expect(shot().text).not.toContain(t(healthGuide(ACT_KEY).title));
  });
});

describe("W5/W6: summary and issues are one snapshot", () => {
  it("W5: a summary naming an issue the list does not show is never beside a green dot", async () => {
    const first = gate<HealthSummaryResponse>();
    let s = 0; let i = 0;
    srv.summary = () => (++s === 1 ? first.p : summaryOf(9));
    srv.issues = () => (++i === 1 ? pageOf(7) : pageOf(9));
    await mount(true);
    await step(() => first.res(summaryOf(8, { openCount: 1, topTitleKey: WATCH_KEY })));
    expect(steps.filter((x) => x.dot === "ok" && x.head === healthTitle(WATCH_KEY))).toEqual([]);
    expect(steps[0]!.dot).not.toBe("ok");
    expect(shot().dot).toBe("ok");
  });

  it("W6: three mismatched pairs end in Checking., one retry after 10 s reads once more, then nothing", async () => {
    vi.useFakeTimers();
    srv.summary = () => summaryOf(8, { openCount: 1, topTitleKey: WATCH_KEY });
    srv.issues = () => pageOf(7);
    await mount();
    expect(shot().head).toBe(t("ux.l2a.health.unknown"));
    expect(shot().dot).not.toBe("ok");
    expect(shot().alert).toBeNull();
    expect(count(SUM)).toBe(3);
    await advance(10_000);
    expect(count(SUM)).toBe(6);
    await advance(60_000);
    await advance(60_000);
    expect(count(SUM)).toBe(6);
  });
});

describe("W7: a not-set-up desktop (real handleSentinelRead)", () => {
  it("the not-set-up sentence, never green, and no read on unchanged ticks or focus", async () => {
    vi.useFakeTimers();
    const locate = () => ({ ok: false as const, reason: "descriptor-missing" });
    srv.summary = (p) => viaHandler(p, locate);
    srv.issues = (p) => viaHandler(p, locate);
    await mount(true);
    expect(shot().head).toBe(HEALTH_COPY.notSetUp);
    expect(shot().dot).not.toBe("ok");
    expect(shot().ticks).toBe(0);
    const reads = count(SUM);
    await advance(60_000);
    await advance(60_000);
    await step(() => { window.dispatchEvent(new Event("focus")); });
    expect(count(SUM)).toBe(reads);
    expect(shot().head).toBe(HEALTH_COPY.notSetUp);
    expect(steps.filter((x) => x.dot === "ok" || x.ticks > 0)).toEqual([]);
  });
});

// ---- W9: leaving mid-action -----------------------------------------------------------------------------------------
describe("W9: leave Health mid-action and come back", () => {
  it("no green, Switch on is disabled and the open issue is shown before the PATCH ends", async () => {
    srv.engine = () => F0();
    srv.summary = () => summaryOf(1, { openCount: 1, topTitleKey: ACT_KEY });
    srv.issues = () => pageOf(1, [issue(1, ACT_KEY)]);
    const patch = gate();
    srv.patch = () => patch.p;
    await mount();
    await click("Switch on", false);
    // A second open issue appears while the owner is away: only a read taken on the way back can show it.
    srv.summary = () => summaryOf(2, { openCount: 2, topTitleKey: ACT_KEY });
    srv.issues = () => pageOf(2, [issue(1, ACT_KEY), issue(2, WATCH_KEY)]);
    await unmount();
    await mount(true);
    await step();
    expect(steps.filter(green)).toEqual([]);
    expect(shot().switchDisabled).toBe(true);
    expect(shot().text).toContain(t(healthGuide(ACT_KEY).title));
    expect(shot().text).toContain(t(healthGuide(WATCH_KEY).title));
    await step(() => patch.res({}));
  });
});

// ---- W13/W13b/W14: when the page re-reads ----------------------------------------------------------------------------
describe("W13: a real engine change is one read, an unchanged tick none", () => {
  it("the live answer shows red at once, one new summary read, then two ticks cost nothing", async () => {
    vi.useFakeTimers();
    await mount();
    expect(shot().dot).toBe("ok");
    const reads = count(SUM);
    srv.engine = () => ans([row("A", "ready"), row("B", "ready")], "key-problem");
    await advance(60_000);
    expect(shot().dot).toBe("act");
    expect(count(SUM)).toBe(reads + 1);
    await advance(60_000);
    await advance(60_000);
    expect(count(SUM)).toBe(reads + 1);
    expect(shot().dot).toBe("act");
  });
});

describe("W13b: UNAVAILABLE and recovery (real handleSentinelRead for issues)", () => {
  it("case 1: summary ready + issues 503: unavailable headline and alert at every step, one 10 s retry, then 0 reads", async () => {
    vi.useFakeTimers();
    srv.issues = (p) => viaHandler(p, () => ({ ok: false, reason: "store-missing" }) as never);
    await mount(true);
    expect(count(SUM)).toBe(1);
    await advance(10_000);
    expect(count(SUM)).toBe(2);
    await advance(60_000);
    await advance(60_000);
    await step(() => { window.dispatchEvent(new Event("focus")); });
    expect(count(SUM)).toBe(2);
    expect(steps.filter((x) => x.alert === null || x.head !== HEALTH_COPY.unavailable)).toEqual([]);
  });

  it("case 2: an engine blip raises the alert; the next healthy tick re-reads once and it clears", async () => {
    vi.useFakeTimers();
    await mount();
    expect(shot().dot).toBe("ok");
    srv.engine = () => { throw fail(404); };
    await advance(60_000);
    expect(shot().alert).toBe(HEALTH_COPY.unavailable);
    expect(shot().head).toBe(HEALTH_COPY.unavailable);
    const reads = count(SUM);
    srv.engine = () => OK();
    await advance(60_000);
    expect(count(SUM)).toBe(reads + 1);
    expect(shot().alert).toBeNull();
    expect(shot().dot).toBe("ok");
  });
});

describe("W14: unavailable shows the unavailable headline, never green, never Checking.", () => {
  it("case a: the engine read 404s on mount while the app holds an instance", async () => {
    vi.useFakeTimers();
    fx.state = { ...fx.state, instances: [{ instanceId: "i1", displayName: "Alpha", enabled: true, driverKind: "claude", snapshot: { state: "available", authenticated: true } }] };
    srv.engine = () => { throw fail(404); };
    await mount(true);
    await advance(60_000);
    await advance(60_000);
    expect(steps.filter((x) => x.alert === null || x.head !== HEALTH_COPY.unavailable || x.dot === "ok")).toEqual([]);
    srv.engine = () => OK();
    const reads = count(SUM);
    await advance(60_000);
    expect(count(SUM)).toBe(reads + 1);
  });

  it("case b (Cloud/phone): summary and issues 404 with healthy engines: same headline, 0 further reads", async () => {
    vi.useFakeTimers();
    srv.summary = () => { throw fail(404); };
    srv.issues = () => { throw fail(404); };
    await mount(true);
    await advance(60_000);
    await advance(60_000);
    await advance(10_000);
    expect(steps.filter((x) => x.alert === null || x.head !== HEALTH_COPY.unavailable || x.dot === "ok")).toEqual([]);
    expect(count(SUM)).toBe(1);
  });
});

describe("W14 (Fable r3 L1): a kept note-only list", () => {
  it("the base note sentence still leads, but the alert shows and the dot is grey", async () => {
    vi.useFakeTimers();
    srv.summary = () => summaryOf(1, { openCount: 1, topTitleKey: NOTE_KEY });
    srv.issues = () => pageOf(1, [issue(1, NOTE_KEY)]);
    await mount();
    expect(shot().dot).toBe("ok");
    srv.engine = () => { throw fail(404); };
    await advance(60_000);
    expect(shot().alert).toBe(HEALTH_COPY.unavailable);
    expect(shot().head).toBe(t("ux.l2b.health.lineNote"));
    expect(shot().dot).toBe("unknown");
  });
});

describe("W14b: a hung engine read ends in the alert, and a bounded exit is not a poll", () => {
  it("+30 s: alert, dot not green; then +120 s: no further summary read", async () => {
    vi.useFakeTimers();
    await mount();
    srv.engine = () => never();
    await advance(60_000); // the tick's read hangs, the live answer stays the old healthy one
    await setState({ owedRev: 1 });
    expect(count(SUM)).toBe(2);
    await advance(30_000);
    expect(shot().alert).toBe(HEALTH_COPY.unavailable);
    expect(shot().dot).not.toBe("ok");
    await advance(120_000);
    expect(count(SUM)).toBe(2);
    expect(shot().alert).toBe(HEALTH_COPY.unavailable);
  });
});

describe("W14c: one 5xx after Check again recovers by itself, once", () => {
  const setup = async (failures: number) => {
    srv.engine = () => OK(85);
    await mount();
    let left = failures;
    srv.summary = () => { if (left-- > 0) throw fail(500); return summaryOf(1); };
    await click("Check again", false);
  };
  it("the retry 10 s later is accepted and the alert goes, then 0 reads", async () => {
    vi.useFakeTimers();
    await setup(1);
    expect(shot().alert).toBe(HEALTH_COPY.unavailable);
    // The Flux card is a finding, so the counted line (base behaviour) leads; it is never "Checking." or an ok line.
    expect(shot().head).toMatch(/thing to fix/);
    expect(green(shot())).toBe(false);
    const reads = count(SUM);
    await advance(10_000);
    expect(count(SUM)).toBe(reads + 1);
    expect(shot().alert).toBeNull();
    await advance(60_000);
    await advance(60_000);
    expect(count(SUM)).toBe(reads + 1);
  });
  it("a failing retry keeps the alert and arms nothing more", async () => {
    vi.useFakeTimers();
    await setup(2);
    const reads = count(SUM);
    await advance(10_000);
    expect(count(SUM)).toBe(reads + 1);
    await advance(10_000);
    await advance(60_000);
    await advance(60_000);
    expect(count(SUM)).toBe(reads + 1);
    expect(shot().alert).toBe(HEALTH_COPY.unavailable);
  });
});

// ---- W16, W10, W11: what counts as an all-clear ------------------------------------------------------------------------
describe("W16: coverage and watch findings withhold the all-clear; a note does not", () => {
  const settled = async (engine: () => EngineHealthAnswer, summary: HealthSummaryResponse, items: HealthIssue[] = []) => {
    srv.engine = engine; srv.summary = () => summary; srv.issues = () => pageOf(1, items);
    await mount();
  };
  it.each([
    ["(a) a Flux watch card", () => settled(() => OK(85), summaryOf(1))],
    ["(b) partial coverage", () => settled(() => OK(), summaryOf(1, { coverage: "partial" }))],
    ["(c) background checks retired", () => settled(() => OK(), summaryOf(1, {}, { backgroundChecksRetired: true }))],
    ["(e) a stale heartbeat", () => settled(() => OK(), summaryOf(1, { lastCheckedAt: Date.now() - HEALTH_STALE_MS - 60_000 }))],
  ])("%s: grey dot, no tick", async (_name, go) => {
    await go();
    expect(shot().dot).toBe("unknown");
    expect(shot().ticks).toBe(0);
  });
  it("(d) one open note only: green dot, the note sentence and the ticks stay", async () => {
    await settled(() => OK(), summaryOf(1, { openCount: 1, topTitleKey: NOTE_KEY }), [issue(1, NOTE_KEY)]);
    expect(shot().dot).toBe("ok");
    expect(shot().head).toBe(t("ux.l2b.health.lineNote"));
    expect(shot().ticks).toBeGreaterThan(0);
  });
});

describe("W10/W11: controls", () => {
  it("W10: during an action an act finding keeps its card, its button and the red dot", async () => {
    srv.engine = () => ans([row("A", "off"), row("B", "ready")], "key-problem");
    srv.patch = () => never();
    await mount();
    await click("Switch on");
    expect(shot().dot).toBe("act");
    expect(shot().text).toContain(t("ux.l2b.health.doc.fluxKey.title"));
  });
  it("W11: an unseen failed routine run keeps a settled page amber", async () => {
    fx.state = { ...fx.state, routineRuns: [{ id: "r1", status: "failed", seenAt: null, scheduledFor: 1 }] };
    await mount();
    expect(shot().dot).toBe("watch");
  });
});

// ---- W17: a truncated issue list never certifies an all-clear (ASTRA db38269392 High 1) -----------------------------
/** `pages` pages of issues linked by a cursor; page n holds `items(n)`, the last one's cursor is `last`. */
const paged = (pages: number, items: (n: number) => HealthIssue[], last: string | null = null) => (path: string) => {
  const n = Number(new URLSearchParams(path.split("?")[1]).get("after") ?? 0) + 1;
  return { ok: true, storeRevision: 7, items: items(n), next: n < pages ? String(n) : last };
};
describe("W17: pagination is read to the end or fails closed", () => {
  it("W17a: a watch finding on page 5 of 5 is read and shown, not green", async () => {
    srv.summary = () => summaryOf(7, { openCount: 5, topTitleKey: WATCH_KEY });
    srv.issues = paged(5, (n) => [issue(n, n === 5 ? WATCH_KEY : NOTE_KEY)]);
    await mount();
    expect(count("GET /api/sentinel/issues")).toBe(5);
    expect(shot().text).toContain(t(healthGuide(WATCH_KEY).title));
    expect(shot().dot, "W17a").not.toBe("ok");
  });
  it("W17b: a list whose cursor never ends is an unavailable answer: alert, never green", async () => {
    srv.summary = () => summaryOf(7, { openCount: 1, topTitleKey: NOTE_KEY });
    srv.issues = paged(HEALTH_ISSUE_PAGES + 1, (n) => [issue(n, NOTE_KEY)]);
    await mount();
    expect(shot().dot, "W17b").not.toBe("ok");
    expect(shot().alert).toBe(HEALTH_COPY.unavailable);
    expect(shot().head).not.toBe(t("ux.l2b.health.lineNote"));
  });
  it("W17c: readHealthIssuesAt returns every page, and rejects with the cursor still set after the last page it may read", async () => {
    const all = await readHealthIssuesAt("open", undefined, (async (path: string) => paged(6, (n) => [issue(n, NOTE_KEY)])(path)) as never);
    expect(all.items).toHaveLength(6);
    await expect(readHealthIssuesAt("open", undefined, (async (path: string) => paged(HEALTH_ISSUE_PAGES + 1, (n) => [issue(n, NOTE_KEY)])(path)) as never)).rejects.toThrow("incomplete");
  });
});
