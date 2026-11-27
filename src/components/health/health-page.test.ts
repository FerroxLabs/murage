// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The whole Health page, rendered (1.0.18): the Fuigo card names the installed version (HEALTH-DOCTOR-FUIGO-VERSION),
// and the headline reads only the default and the engines bots use (HEALTH-HEADLINE-FALLBACK).
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineHealthAnswer, EngineHealthRow } from "@/components/shell/shell-contract";
import { setLocale } from "@/lib/i18n";
import type { HealthSummaryResponse } from "../../../shared/sentinel-view";

const fixture: { answer: EngineHealthAnswer | null } = { answer: null };
const read = vi.hoisted(() => vi.fn());

vi.mock("@/state/store", async (original) => {
  const real = await original<typeof import("@/state/store")>();
  return { ...real, api: read, useStore: () => ({ state: real.initialState, dispatch: () => {} }), useStoreIfAny: () => ({ state: real.initialState, dispatch: () => {} }) };
});
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));
vi.mock("@/components/today/use-engine-health", async (original) => {
  const real = await original<typeof import("@/components/today/use-engine-health")>();
  const { healthEngine } = await import("@/lib/today-model");
  return {
    ...real,
    useEngineHealthAnswer: () => fixture.answer,
    useEngineReading: () => fixture.answer
      ? { engine: fixture.answer.primary, health: healthEngine(fixture.answer.engines, real.answerDefaultId(fixture.answer)), flux: fixture.answer.flux, fromServer: true }
      : { engine: null, health: null, flux: "none", fromServer: false },
  };
});

const { HealthPageBody } = await import("./HealthPageBody");

const NOW = Date.now();
const ready = (over: Partial<EngineHealthRow> = {}): EngineHealthRow => ({ id: "claude", label: "Claude", state: "ready", line: "", usedBy: 2, ...over });
const answer = (over: Partial<EngineHealthAnswer> = {}): EngineHealthAnswer => {
  const engines = over.engines ?? [ready()];
  return { engines, primary: engines[0] ?? null, defaultId: "claude", flux: "ok", fluxInfo: { spendPct: 10, expires: null }, checkedAt: NOW, ...over };
};
const page = () => renderToStaticMarkup(createElement(HealthPageBody, { onLeave: () => {}, onOpenNeedsYou: () => {} }));
const headline = (html: string) => html.match(/<p role="status"[^>]*>([^<]*)<\/p>/)?.[1] ?? "";
// Before the page's own reads answer (a static render runs no effect), the headline is the engine level's line.
const ENGINE_OK = "Everything is working.";

beforeEach(() => { fixture.answer = answer(); });

afterEach(() => { vi.unstubAllGlobals(); read.mockReset(); });

describe("the Fuigo card (HEALTH-DOCTOR-FUIGO-VERSION)", () => {
  it("names the version the server read from the install receipt, without a fuigo prefix, and nothing when unknown", () => {
    fixture.answer = answer({ fuigoVersion: "1.0.39" });
    expect(page()).toContain("Fuigo 1.0.39 · Flux Router");
    fixture.answer = answer({ fuigoVersion: "fuigo 1.0.42" });
    expect(page()).toContain("Fuigo 1.0.42 · Flux Router");
    fixture.answer = answer({ fuigoVersion: null });
    expect(page()).toContain("Fuigo and Flux Router");
    expect(page()).not.toMatch(/Fuigo \d/);
  });
});

describe("the headline reads the default and the engines bots use (HEALTH-HEADLINE-FALLBACK)", () => {
  const gemini = (usedBy: number) => ready({ id: "gemini", label: "Gemini", state: "missing", usedBy });
  it("no default and a missing engine no bot uses: no red dot, no finding", () => {
    fixture.answer = answer({ defaultId: null, engines: [gemini(0), ready()] });
    const html = page();
    expect(headline(html)).toBe(ENGINE_OK);
    expect(html).not.toContain("Gemini is not");
    expect(html).not.toContain("bg-danger");
    expect(html).not.toContain("1 thing to fix");
  });

  it("the same engine once a bot uses it is the thing to fix", () => {
    fixture.answer = answer({ defaultId: null, engines: [gemini(1), ready()] });
    const html = page();
    expect(headline(html)).toContain("1 thing to fix");
    expect(html).toContain("bg-danger");
  });
});

describe("background checks in the mounted Health page", () => {
  const partial: HealthSummaryResponse = {
    status: "ready",
    view: {
      schemaVersion: 1, publishedAt: NOW, storeRevision: 1, rows: [],
      summary: { openCount: 0, highestSeverity: null, topTitleKey: null, lastCheckedAt: NOW, lastCompleteCheckAt: NOW, coverage: "partial", scanner: "running", recoveredCount: 0, moreCount: 0 },
    },
  };
  const retired = { backgroundChecksRetired: true } as const;

  it.each([
    ["saved partial summary", { ...partial, ...retired }, "Background health checks have been retired.", "en", null],
    ["unavailable history", { status: "waiting", view: null, ...retired }, "Background health checks have been retired.", "en", "Health information could not be read just now."],
    ["German", { ...partial, ...retired }, "Die Zustandsprüfungen im Hintergrund wurden eingestellt.", "de", null],
    ["active checks with partial results", partial, "Some health checks are waiting for fresh information.", "en", null],
  ])("shows the right headline for %s", async (_name, summary, line, language, historyAlert) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await setLocale(language);
    read.mockImplementation(async (path: string) => {
      if (path === "/api/sentinel/summary") return summary;
      if (path.startsWith("/api/sentinel/issues?")) {
        if (historyAlert) throw Object.assign(new Error("unavailable"), { status: 503 });
        return { ok: true, items: [], next: null, storeRevision: 1 };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(HealthPageBody, { onLeave: () => {}, onOpenNeedsYou: () => {} })));
      expect(container.querySelector('[role="status"]')?.textContent).toBe(line);
      expect(container.textContent?.includes("Last complete check")).toBe(summary === partial);
      expect(container.querySelector('[role="alert"]')?.textContent ?? null).toBe(historyAlert);
      if (historyAlert) {
        const closed = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Recently closed");
        expect(closed).toBeDefined();
        await act(async () => closed!.click());
        expect(Array.from(container.querySelectorAll('[role="alert"]'), (alert) => alert.textContent)).toEqual([historyAlert, historyAlert]);
        expect(container.textContent).not.toContain("Nothing has closed recently.");
      }
    } finally {
      await act(async () => root.unmount());
      await setLocale("en");
    }
  });
});
