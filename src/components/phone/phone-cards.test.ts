// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX L7 part 2: the Routines tab is a list by day on a phone, the routine and
// Hire sheets rise from the bottom below md, New routine on a phone hands the
// words to the chat only, and the alerts card shows once.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Routine } from "@/lib/routines";
import { PhoneRoutineList } from "./PhoneRoutineList";
import { PhonePayCard } from "./PhonePayCard";
import { PHONE_ALERTS_SEEN_KEY, markPhoneAlertsSeen, phoneAlertsOffer, phoneAlertsSeen } from "./PhoneAlertsCard";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const HOUR = 3_600_000;
// Wednesday 4 Nov 2026 09:00 local
const NOW = new Date(2026, 10, 4, 9, 0, 0).getTime();
const routine = (id: string, nextRunAt: number | null, extra: Partial<Routine> = {}): Routine => ({
  id, name: `Routine ${id}`, prompt: "p", target: "bot", botId: "nova", runOn: "local", enabled: true,
  schedule: { type: "once", at: nextRunAt ?? NOW - HOUR }, durationMinutes: 30, nextRunAt: nextRunAt ?? undefined, ...extra,
} as unknown as Routine);

const list = (routines: Routine[], onNew: (() => void) | null = vi.fn()) =>
  renderToStaticMarkup(createElement(PhoneRoutineList, { routines, botName: (id: string) => (id === "nova" ? "Nova" : undefined), now: NOW, onOpen: vi.fn(), onNew }));

describe("PhoneRoutineList", () => {
  it("groups the week's runs as Today, Tomorrow and Later this week, in time order", () => {
    const html = list([
      routine("later", NOW + 3 * 24 * HOUR),
      routine("today2", NOW + 5 * HOUR),
      routine("today1", NOW + 1 * HOUR),
      routine("tomorrow", NOW + 24 * HOUR),
      routine("paused", NOW + 2 * HOUR, { enabled: false }),
      routine("nextMonth", NOW + 20 * 24 * HOUR),
    ]);
    const days = [...html.matchAll(/data-phone-routine-day="(\w+)"/g)].map((match) => match[1]);
    expect(days).toEqual(["today", "tomorrow", "later"]);
    const rows = [...html.matchAll(/data-phone-routine-row="(\w+)"/g)].map((match) => match[1]);
    expect(rows).toEqual(["today1", "today2", "tomorrow", "later"]);
    expect(html).toContain(">Later this week</h2>");
    expect(html).toContain("Nova · ");
    expect(html).not.toContain("data-phone-routine-empty");
  });

  it("says so when nothing runs this week, and drops New routine when no bot can be asked", () => {
    const html = list([], null);
    expect(html).toContain("Nothing is set to run this week.");
    expect(html).not.toContain("data-phone-routine-new");
    expect(list([])).toContain("data-phone-routine-new");
  });

  it("scrolls inside the page, so a full week reaches its last row and New routine", () => {
    const html = list(Array.from({ length: 30 }, (_, i) => routine(`r${i}`, NOW + (i + 1) * 60_000)));
    // React renders the bare data attribute as data-phone-routine-list="true";
    // find the list's own opening tag whatever its attribute order, then its class.
    const tag = html.match(/<div\b[^>]*\sdata-phone-routine-list(?=[\s=>])[^>]*>/)?.[0] ?? "";
    expect(tag).not.toBe("");
    const root = tag.match(/\bclass="([^"]*)"/)?.[1].split(/\s+/) ?? [];
    for (const name of ["min-h-0", "flex-1", "overflow-y-auto"]) expect(root).toContain(name);
  });

  it("replaces the week grid below md on a phone and opens the Run-now-only sheet", () => {
    const page = read("../RoutineCalendarPage.tsx");
    expect(page).toContain('{!canEdit && section === "calendar" && <PhoneRoutineList');
    expect(page).toContain('onOpen={(routine) => setSheetRoutineId(routine.id)}');
    expect(page).toContain('className={canEdit ? "flex min-h-0 flex-1" : "hidden min-h-0 flex-1 md:flex"}');
    expect(page).toContain("{newOpen && <NewRoutineSheet lifecycle={lifecycle} chatOnly={!canEdit}");
    expect(page).toContain("<RoutineSheet lifecycle={lifecycle} routine={sheetRoutine} canEdit={canEdit}");
  });
});

describe("phone sheets", () => {
  it("New routine on a phone offers the chat only, never Pick a time", () => {
    const sheet = read("../routines/NewRoutineSheet.tsx");
    expect(sheet).toContain('{!chatOnly && <button type="button" disabled={!hasWords} onClick={pickTime}');
  });

  it("Hire, New routine and the routine sheet rise from the bottom below md", () => {
    for (const file of ["../hire/HireBotDialog.tsx", "../routines/NewRoutineSheet.tsx", "../routines/RoutineSheet.tsx"]) {
      const source = read(file);
      expect(source, file).toContain("data-phone-bottom-sheet");
      expect(source, file).toMatch(/max-md:items-end|items-end justify-center bg-black\/50 p-0/);
      expect(source, file).toMatch(/max-h-\[(?:min\()?85dvh/);
    }
  });

  it("the two sheets with a text field take the visual viewport, so the keyboard never covers them", () => {
    for (const file of ["../hire/HireBotDialog.tsx", "../routines/NewRoutineSheet.tsx"]) {
      const source = read(file);
      expect(source, file).toMatch(/BACKDROP = "overlay-inset fixed inset-x-0 top-0 flex h-\[var\(--vvh,100dvh\)\]/);
      expect(source, file).toContain('<LayerSurface handle={layer}>');
      expect(source, file).toContain("max-h-[min(85dvh,calc(var(--vvh,100dvh)-0.5rem))]");
      expect(source, file).not.toContain("max-h-[85dvh]");
      expect(source, file).not.toMatch(/overlay-inset fixed inset-0/);
    }
  });
});

describe("PhoneAlertsCard", () => {
  const status = (enrolled: boolean, permission = "prompt") => ({ permission, enrolled, expiresAt: NOW + 24 * HOUR });

  it("offers alerts only when this phone can push and alerts are off", () => {
    expect(phoneAlertsOffer(true, status(false), NOW)).toBe(true);
    expect(phoneAlertsOffer(false, null, NOW)).toBe(false);
    expect(phoneAlertsOffer(true, status(false, "denied"), NOW)).toBe(false);
    expect(phoneAlertsOffer(true, { permission: "granted", enrolled: true, expiresAt: NOW + 24 * HOUR }, NOW)).toBe(false);
  });

  it("shows once: either button marks it seen, and a storage that throws never breaks Today", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    expect(phoneAlertsSeen(storage)).toBe(false);
    markPhoneAlertsSeen(storage);
    expect(store.get(PHONE_ALERTS_SEEN_KEY)).toBe("1");
    expect(phoneAlertsSeen(storage)).toBe(true);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(phoneAlertsSeen(broken)).toBe(false);
    expect(() => markPhoneAlertsSeen(broken)).not.toThrow();
    const card = read("./PhoneAlertsCard.tsx");
    expect(card).toContain("const done = () => { markPhoneAlertsSeen(local()); setOffer(false); };");
    expect(card).toContain('onClick={done}');
  });

  it("loads in its own chunk on a phone's Today only", () => {
    const today = read("../today/TodayView.tsx");
    expect(today).toContain('retryableLazy(() => import("@/components/phone/PhoneAlertsCard")');
    expect(today).toContain("{remote && <div className=\"mt-5 empty:hidden md:hidden\">");
    expect(today).not.toMatch(/import \{[^}]*PhoneAlertsCard[^}]*\} from/);
  });
});

describe("PhonePayCard", () => {
  it("says billing lives on the computer, with an Open on desktop hint and no purchase link", () => {
    const html = renderToStaticMarkup(createElement(PhonePayCard));
    expect(html).toContain("Billing lives on your computer for now. Open Murage on desktop to see it.");
    expect(html).toContain("Open on desktop");
    expect(html).toContain('data-settings-stub="other-surface"');
    expect(html).not.toMatch(/<a\b|href=|<button/);
    expect(html).not.toMatch(/\b(buy|purchase|upgrade|subscribe|price|\$)/i);
  });

  it("shows on a confirmed remote surface only", () => {
    expect(read("../settings/pages/GeneralPage.tsx")).toContain("{desktop === false && <PhonePayCard />}");
  });
});
