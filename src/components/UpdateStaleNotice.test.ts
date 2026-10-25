import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdaterState } from "../types/muragebox";
const current = vi.hoisted(() => ({ value: null as UpdaterState | null }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => current.value }));
import { UpdateStaleNotice, staleNoticeText } from "./UpdateStaleNotice";
afterEach(() => { vi.unstubAllGlobals(); current.value = null; });

it("names when checks stopped working, with no em dash", () => {
  const text = staleNoticeText("2026-10-01T10:00:00.000Z", "en-US");
  expect(text).toMatch(/^Murage couldn't check for updates since .+\.$/);
  expect(text).not.toContain("—");
  expect(staleNoticeText("not a date")).toContain("since a while");
});

it("renders only while a stale streak is reported, with Check now and Dismiss", () => {
  vi.stubGlobal("window", { muragebox: { updater: { check: vi.fn() } }, localStorage: { getItem: () => null, setItem: vi.fn() } });
  current.value = { status: "idle" };
  expect(renderToStaticMarkup(createElement(UpdateStaleNotice))).toBe("");
  current.value = { status: "idle", staleCheckSince: "2026-10-01T10:00:00.000Z" };
  const html = renderToStaticMarkup(createElement(UpdateStaleNotice));
  expect(html).toContain("Check now");
  expect(html).toContain('aria-label="Dismiss"');
});

it("stays hidden once that streak was dismissed", () => {
  vi.stubGlobal("window", { muragebox: { updater: {} }, localStorage: { getItem: () => "2026-10-01T10:00:00.000Z", setItem: vi.fn() } });
  current.value = { status: "idle", staleCheckSince: "2026-10-01T10:00:00.000Z" };
  expect(renderToStaticMarkup(createElement(UpdateStaleNotice))).toBe("");
});

it("yields the corner to the update banner while it is open", () => {
  vi.stubGlobal("window", { muragebox: { updater: { check: vi.fn() } }, localStorage: { getItem: () => null, setItem: vi.fn() } });
  current.value = { status: "available", staleCheckSince: "2026-10-01T10:00:00.000Z" };
  expect(renderToStaticMarkup(createElement(UpdateStaleNotice))).toBe("");
});
