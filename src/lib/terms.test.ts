// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The renderer's side of the terms screen, driven against the real server
// module (server/terms.ts) in a temp data folder: first run asks, Accept
// records, a restart (a new session over the same folder) does not ask again,
// and a newer terms version asks once more. The vitest suite runs under
// `environment: "node"` with no DOM, so the screen's own wiring is proven as a
// source contract at the bottom.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTermsApi } from "../../server/terms";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandFrame } from "../components/BrandFrame";
import { canAccept, createTermsChecker, isTermsRefusal, watchDelayMs, watchTermsAcceptance, fetchTermsStatus, termsDeadlineMs, retryDelayMs, sendTermsAcceptance, termsPhase, TERMS_VERSION } from "./terms";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "murage-terms-ui-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** What a renderer session talks to: the real route handler over one data folder. */
const server = (env: NodeJS.ProcessEnv = {}) => async (path: string, init?: RequestInit): Promise<unknown> => {
  const answer = await handleTermsApi({ method: init?.method ?? "GET", path, readBody: async () => JSON.parse(String(init?.body ?? "{}")) }, dir, env);
  if (!answer || answer.status >= 300) throw new Error(`HTTP ${answer?.status}`);
  return answer.body;
};

describe("terms screen state", () => {
  it("shows on first run, then not after Accept, and not after a restart", async () => {
    const firstSession = server();
    expect(termsPhase(await fetchTermsStatus(firstSession))).toBe("needed");
    await sendTermsAcceptance(firstSession);
    expect(termsPhase(await fetchTermsStatus(firstSession))).toBe("clear");
    // restart: a new session, nothing carried over but the data folder
    expect(termsPhase(await fetchTermsStatus(server()))).toBe("clear");
  });

  it("re-prompts an existing install once after the terms version changes", async () => {
    writeFileSync(join(dir, "terms-acceptance.json"), JSON.stringify({ accepted: [{ version: "2025-01-01", acceptedAt: "2025-01-02T00:00:00.000Z" }] }));
    const status = await fetchTermsStatus(server());
    expect(termsPhase(status)).toBe("needed");
    expect(status?.acceptedVersion).toBe("2025-01-01");
    await sendTermsAcceptance(server());
    expect(termsPhase(await fetchTermsStatus(server()))).toBe("clear");
  });

  it("records the app version with the acceptance", async () => {
    await sendTermsAcceptance(server());
    const saved = JSON.parse(readFileSync(join(dir, "terms-acceptance.json"), "utf8")).accepted[0];
    expect(saved).toMatchObject({ version: TERMS_VERSION });
    expect(saved.appVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("the headless declaration clears the screen without a record", async () => {
    expect(termsPhase(await fetchTermsStatus(server({ MURAGE_TERMS_ACCEPTED: TERMS_VERSION })))).toBe("clear");
  });

  it("is loading before the answer, and a failed check never clears the gate", async () => {
    expect(termsPhase(undefined)).toBe("loading");
    // network error, HTTP failure, a malformed body and a hidden route all mean "could not check"
    expect(await fetchTermsStatus(async () => { throw new Error("offline"); })).toBeNull();
    expect(await fetchTermsStatus(async () => { throw new Error("HTTP 404"); })).toBeNull();
    expect(await fetchTermsStatus(async () => ({ nonsense: true }))).toBeNull();
    expect(await fetchTermsStatus(async () => null)).toBeNull();
    expect(termsPhase(null)).toBe("unreachable");
    expect(termsPhase(null)).not.toBe("clear");
  });

  it("once the server answers after a failure, the gate behaves normally", async () => {
    let calls = 0;
    const flaky = async (path: string, init?: RequestInit) => { if (calls++ < 2) throw new Error("offline"); return server()(path, init); };
    expect(termsPhase(await fetchTermsStatus(flaky))).toBe("unreachable");
    expect(termsPhase(await fetchTermsStatus(flaky))).toBe("unreachable");
    expect(termsPhase(await fetchTermsStatus(flaky))).toBe("needed");
    await sendTermsAcceptance(server());
    expect(termsPhase(await fetchTermsStatus(flaky))).toBe("clear");
  });

  it("retries back off from 2s up to a 30s ceiling", () => {
    expect([0, 1, 2, 3, 4, 10].map(retryDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it("Accept stays disabled until the box is ticked, and while saving", () => {
    expect(canAccept(false, false)).toBe(false);
    expect(canAccept(true, false)).toBe(true);
    expect(canAccept(true, true)).toBe(false);
  });

  it("a refused acceptance throws so the screen can say it did not save", async () => {
    await expect(sendTermsAcceptance(server(), "2025-01-01")).rejects.toThrow();
  });
});

describe("stalled checks and signed-out recovery", () => {
  it("a request that never answers ends as unreachable after the deadline, and is aborted", async () => {
    let aborted = false;
    const stalled = (_path: string, init?: RequestInit) => new Promise<unknown>(() => { init?.signal?.addEventListener("abort", () => { aborted = true; }); });
    expect(await fetchTermsStatus(stalled, 20)).toBeNull();
    expect(aborted).toBe(true);
  });
});

describe("terms screen wiring (source contract)", () => {
  it("keeps Retry always enabled and shows the sign-in path from the gate", () => {
    const screens = readFileSync(new URL("../components/TermsScreens.tsx", import.meta.url), "utf8");
    const gateSrc = readFileSync(new URL("../components/TermsGate.tsx", import.meta.url), "utf8");
    expect(screens).not.toContain("disabled={checking}");
    expect(gateSrc).toContain("SignedOutCard");
    expect(gateSrc).toMatch(/state\.signedOut/);
  });

  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  const gate = read("../components/TermsGate.tsx") + read("../components/TermsScreens.tsx");
  const app = read("../App.tsx");

  it("wraps the whole shell, so nothing behind it mounts until accepted", () => {
    expect(app).toMatch(/<TermsGate>\s*<Shell \/>\s*<\/TermsGate>/);
  });

  it("starts unticked, disables Accept through canAccept, and links open the system browser", () => {
    expect(gate).toContain("useState(false)");
    expect(gate).toContain("disabled={!canAccept(ticked, saving)}");
    expect(gate).toContain("openAnnouncementLink(href)");
    expect(gate).toContain("TERMS_URL");
    expect(gate).toContain("PRIVACY_URL");
  });

  it("keeps the gate up on a failed check, with Retry, and focuses the first control", () => {
    expect(gate).toMatch(/phase === "unreachable"\) return <Suspense fallback=\{blank\}><TermsUnreachable/);
    expect(gate).toContain("onClick={onRetry}");
    expect(gate).toContain("useTerms(api)");
    // the screens load on demand: a static import would put them back in the first-paint budget
    expect(read("../components/TermsGate.tsx")).toContain('import("./TermsScreens")');
    expect(read("../components/TermsGate.tsx")).not.toMatch(/^import .* from "\.\/TermsScreens"/m);
    expect(gate).toContain("boxRef.current?.focus()");
    expect(gate).toContain("retryRef.current?.focus()");
    expect(read("./terms.ts")).toContain("retryDelayMs(backoff)");
  });

  it("offers Quit on the desktop only and never keeps the answer in browser storage", () => {
    expect(gate).toContain("window.muragebox?.quit");
    expect(gate + read("./terms.ts")).not.toMatch(/localStorage|sessionStorage/);
  });
});

describe("escalating deadline and coalesced retry", () => {
  afterEach(() => { vi.useRealTimers(); });
  const ok = { accepted: false, version: TERMS_VERSION };

  it("the deadline climbs 10s, 20s, 40s, 60s and a slow valid answer eventually succeeds", async () => {
    expect([0, 1, 2, 3, 9].map(termsDeadlineMs)).toEqual([10_000, 20_000, 40_000, 60_000, 60_000]);
    vi.useFakeTimers();
    // every answer takes 15s: fails the first 10s deadline, passes the second (20s)
    const slow = (_p: string, init?: RequestInit) => new Promise<unknown>((resolve) => {
      const t = setTimeout(() => resolve(ok), 15_000);
      init?.signal?.addEventListener("abort", () => clearTimeout(t));
    });
    const seen: Array<unknown> = [];
    const checker = createTermsChecker(slow, { checking: () => {}, status: (s) => seen.push(s) });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(seen).toEqual([null]);
    await vi.advanceTimersByTimeAsync(2_000 + 15_001);
    expect(seen).toEqual([null, ok]);
    checker.dispose();
  });

  it("Retry while a check is in flight starts no second request; unmount aborts the one in flight", async () => {
    vi.useFakeTimers();
    let started = 0;
    let aborted = 0;
    const hang = (_p: string, init?: RequestInit) => new Promise<unknown>(() => { started += 1; init?.signal?.addEventListener("abort", () => { aborted += 1; }); });
    const checker = createTermsChecker(hang, { checking: () => {}, status: () => {} });
    checker.retry(); checker.retry(); checker.retry();
    expect(started).toBe(1);
    checker.dispose();
    expect(aborted).toBe(1);
  });

  it("a stale answer never overwrites a newer state", async () => {
    vi.useFakeTimers();
    let release: (v: unknown) => void = () => {};
    const late = () => new Promise<unknown>((resolve) => { release = resolve; });
    const seen: Array<unknown> = [];
    const checker = createTermsChecker(late, { checking: () => {}, status: (s) => seen.push(s) });
    const accepted = { accepted: true, version: TERMS_VERSION };
    checker.settle(accepted);
    release(ok);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([accepted]);
    checker.dispose();
  });
});

describe("a stalled acceptance recovers without a reload", () => {
  const accepted = { accepted: true, version: TERMS_VERSION };
  const notYet = { accepted: false, version: TERMS_VERSION };
  /** POST never answers (aborted by the deadline); GET answers with `status`. */
  const stalledPost = (status: unknown) => (_path: string, init?: RequestInit) => {
    if (init?.method === "POST") return new Promise<unknown>(() => {});
    return Promise.resolve(status);
  };

  it("landed: the POST stalls, the recheck says accepted, so Accept succeeds", async () => {
    await expect(sendTermsAcceptance(stalledPost(accepted), TERMS_VERSION, 20)).resolves.toEqual(accepted);
  });

  it("not landed: the POST stalls, the recheck says not accepted, so it throws and the button can come back", async () => {
    await expect(sendTermsAcceptance(stalledPost(notYet), TERMS_VERSION, 20)).rejects.toThrow();
  });

  it("not landed and the recheck cannot answer either: still settles with an error", async () => {
    const dead = (_p: string, init?: RequestInit) => new Promise<unknown>(() => { void init; });
    await expect(sendTermsAcceptance(dead, TERMS_VERSION, 20)).rejects.toThrow();
  });

  it("a network error on the POST is rechecked the same way", async () => {
    let posted = false;
    const flaky = async (_p: string, init?: RequestInit) => { if (init?.method === "POST") { posted = true; throw new Error("offline"); } return accepted; };
    await expect(sendTermsAcceptance(flaky, TERMS_VERSION, 50)).resolves.toEqual(accepted);
    expect(posted).toBe(true);
  });

  it("a recheck that names another version does not count", async () => {
    await expect(sendTermsAcceptance(stalledPost({ accepted: true, version: "1999-01-01" }), TERMS_VERSION, 20)).rejects.toThrow();
  });

  it("a deliberate refusal is reported as a refusal, with no recheck", async () => {
    let gets = 0;
    const refused = async (_p: string, init?: RequestInit) => {
      if (init?.method === "POST") throw Object.assign(new Error("no such route"), { status: 404 });
      gets += 1; return notYet;
    };
    const error = await sendTermsAcceptance(refused).catch((e: unknown) => e);
    expect(isTermsRefusal(error)).toBe(true);
    expect(gets).toBe(0);
    expect(isTermsRefusal(new Error("offline"))).toBe(false);
  });

  it("the screen resets the button on any failure and says where to accept after a refusal", () => {
    const screens = readFileSync(new URL("../components/TermsScreens.tsx", import.meta.url), "utf8");
    expect(screens).toContain("setSaving(false)");
    expect(screens).toContain("isTermsRefusal(error)");
    expect(screens).toContain('t("terms.desktopOnly")');
  });
});

describe("loading shows the brand frame, not a blank div", () => {
  it("renders the app icon on the app background, busy", () => {
    const html = renderToStaticMarkup(createElement(BrandFrame));
    expect(html).toContain("data-brand-frame");
    expect(html).toContain('src="/app-icon.svg"');
    expect(html).toContain('aria-busy="true"');
  });
  it("the gate uses it for loading and for the lazy fallback", () => {
    const gate = readFileSync(new URL("../components/TermsGate.tsx", import.meta.url), "utf8");
    expect(gate).toContain("const blank = <BrandFrame />");
    expect(gate).not.toContain('<div className="h-full bg-app"');
  });
});

describe("the screen notices an acceptance made elsewhere", () => {
  afterEach(() => { vi.useRealTimers(); });
  const accepted = { accepted: true, version: TERMS_VERSION };
  const notYet = { accepted: false, version: TERMS_VERSION };

  it("after a refusal, the server flips to accepted and the gate lifts on the next timed check, no reload", async () => {
    vi.useFakeTimers();
    let answer: unknown = notYet;
    const request = async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST") throw Object.assign(new Error("no such route"), { status: 404 });
      return answer;
    };
    const lifted: unknown[] = [];
    const watch = watchTermsAcceptance(request, (status) => lifted.push(status), null, null);
    await expect(sendTermsAcceptance(request)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(lifted).toEqual([]);
    answer = accepted;
    await vi.advanceTimersByTimeAsync(15_001);
    expect(lifted).toEqual([accepted]);
    watch.stop();
  });

  it("returning to the window rechecks at once, and the button rechecks too", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const doc = { visibilityState: "visible" as const, addEventListener: (n: string, f: () => void) => { listeners.set(n, f); }, removeEventListener: (n: string) => { listeners.delete(n); } };
    let answer: unknown = notYet;
    const seen: unknown[] = [];
    const watch = watchTermsAcceptance(async () => answer, (status) => seen.push(status), doc as never, null);
    answer = accepted;
    listeners.get("visibilitychange")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([accepted]);
    watch.stop();
    expect(listeners.size).toBe(0);
    const again: unknown[] = [];
    answer = accepted;
    const w2 = watchTermsAcceptance(async () => answer, (status) => again.push(status), null, null);
    w2.recheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(again).toEqual([accepted]);
  });

  it("an older or unaccepted answer never lifts the gate, and the wait backs off to 30s", async () => {
    vi.useFakeTimers();
    const seen: unknown[] = [];
    const watch = watchTermsAcceptance(async () => ({ accepted: true, version: "1999-01-01" }), (status) => seen.push(status), null, null);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(seen).toEqual([]);
    watch.stop();
    expect([0, 1, 2, 3, 9].map(watchDelayMs)).toEqual([10_000, 15_000, 22_500, 30_000, 30_000]);
  });

  it("100 focus events in one second cause at most one extra GET, and the button still works", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const win = { addEventListener: (n: string, f: () => void) => { listeners.set(n, f); }, removeEventListener: (n: string) => { listeners.delete(n); } };
    let gets = 0;
    const watch = watchTermsAcceptance(async () => { gets += 1; return notYet; }, () => {}, null, win as never);
    await vi.advanceTimersByTimeAsync(6_000);
    const base = gets;
    for (let i = 0; i < 100; i++) { listeners.get("focus")!(); await vi.advanceTimersByTimeAsync(10); }
    expect(gets - base).toBeLessThanOrEqual(2);
    const afterBurst = gets;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gets - afterBurst).toBeLessThanOrEqual(1);
    const before = gets;
    watch.recheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(gets).toBe(before + 1);
    watch.stop();
  });

  it("stop aborts the in-flight GET, and recheck does not run beside it", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let gets = 0;
    const request = (_p: string, init?: RequestInit) => { gets += 1; signal = init?.signal ?? undefined; return new Promise<never>(() => {}); };
    const watch = watchTermsAcceptance(request, () => {}, null, null);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(gets).toBe(1);
    watch.recheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(gets).toBe(1);
    expect(signal?.aborted).toBe(false);
    watch.stop();
    expect(signal?.aborted).toBe(true);
  });

  it("the screen offers the recheck action after a refusal", () => {
    const screens = readFileSync(new URL("../components/TermsScreens.tsx", import.meta.url), "utf8");
    expect(screens).toContain("data-terms-recheck");
    expect(readFileSync(new URL("../components/TermsGate.tsx", import.meta.url), "utf8")).toContain("onRecheck={recheck}");
  });
});
