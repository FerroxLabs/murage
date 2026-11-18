// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/settings-copy";
import { sw as t } from "@/lib/settings-words";
import { sourceCodeLink, sourceVersionLabel } from "@/lib/source-code";
import type { UpdaterState } from "@/lib/updater";
import { APP_VERSION, changelogUrl } from "@/lib/whats-new";
import { OPEN_WHATS_NEW_EVENT } from "@/lib/app-events";
import { cleanup, installDOMHarness, mount, settle } from "../../../testing/dom-harness";
import { PreviousVersionRow } from "../../PreviousVersionRow";
import { PageCards } from "../PageCards";
import { aboutCards } from "./AboutPage";
import { DiagnosticsRow } from "./about-rows";

const fixture = vi.hoisted(() => ({
  desktop: true as boolean | undefined,
  updater: null as UpdaterState | null,
  dispatch: vi.fn(),
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: {}, dispatch: fixture.dispatch }),
  api: vi.fn(async () => { throw new Error("No network in the About fixture"); }),
}));
vi.mock("@/lib/use-surface", async (original) => ({
  ...await original<typeof import("@/lib/use-surface")>(),
  useDesktopSurface: () => fixture.desktop,
}));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => fixture.updater }));

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  fixture.desktop = true;
  fixture.updater = null;
  fixture.dispatch.mockClear();
  vi.stubGlobal("muragebox", undefined);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function card(id: string, cloud = false, mode: "simple" | "advanced" = "advanced") {
  return h(PageCards, { cards: aboutCards({ desktop: fixture.desktop, cloud }).filter((entry) => entry.id === id), mode });
}
const diagnosticsButton = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('[data-setting-control="diagnostics-heading"]');

describe("What's new on every surface", () => {
  it.each([false, undefined])("opens public release notes without desktop actions (desktop=%s)", (desktop) => {
    fixture.desktop = desktop;
    const { container } = mount(card("about.whats-new", false, "simple"));
    expect(container.textContent).toContain(t("settings.about.whatsNewTitle"));
    expect(container.textContent).toContain(t("settings.about.whatsNewNote"));
    const link = container.querySelector<HTMLAnchorElement>('a[data-setting-control="whats-new-heading"]')!;
    expect(link.getAttribute("href")).toBe(changelogUrl(APP_VERSION));
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(link.textContent).toBe(t("settings.about.whatsNewOpen"));
    expect(container.querySelector("button, [data-settings-stub]")).toBeNull();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("keeps the desktop button closing Settings and opening What's new", () => {
    const opened = vi.fn();
    window.addEventListener(OPEN_WHATS_NEW_EVENT, opened);
    try {
      const { container } = mount(card("about.whats-new"));
      expect(container.querySelector("a")).toBeNull();
      const button = container.querySelector<HTMLButtonElement>('button[data-setting-control="whats-new-heading"]')!;
      act(() => button.click());
      expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: false });
      expect(opened).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(OPEN_WHATS_NEW_EVENT, opened);
    }
  });
});

describe("About diagnostics bridge capability", () => {
  it.each([undefined, false, true])("shows the titled desktop stub without an export bridge (desktop=%s)", (desktop) => {
    fixture.desktop = desktop;
    const { container } = mount(card("about.diagnostics"));
    expect(container.querySelectorAll("#diagnostics-heading")).toHaveLength(1);
    expect(container.querySelector('[data-testid="settings-stub-diagnostics-heading"]')).not.toBeNull();
    expect(container.textContent).toContain(t("settings.l1.card.about.diagnostics"));
    expect(container.textContent).toContain(t("settings.stub.copyPath"));
    expect(diagnosticsButton(container)).toBeNull();
  });

  it("also stubs an older bridge without exportDiagnostics, even when rendered directly", () => {
    vi.stubGlobal("muragebox", { platform: "linux" });
    const { container } = mount(h(DiagnosticsRow));
    expect(container.querySelector('[data-settings-stub="other-surface"]')).not.toBeNull();
    expect(diagnosticsButton(container)).toBeNull();
  });

  it("keeps the Cloud gate even if a local export bridge is present", () => {
    const exportDiagnostics = vi.fn(async () => null);
    vi.stubGlobal("muragebox", { exportDiagnostics });
    const { container } = mount(card("about.diagnostics", true));
    expect(container.querySelector('[data-testid="settings-stub-diagnostics-heading"]')).not.toBeNull();
    expect(diagnosticsButton(container)).toBeNull();
    expect(exportDiagnostics).not.toHaveBeenCalled();
  });

  it("exports once while pending, and cancellation never claims a saved file", async () => {
    let finish!: (path: string | null) => void;
    const exportDiagnostics = vi.fn(() => new Promise<string | null>((resolve) => { finish = resolve; }));
    vi.stubGlobal("muragebox", { exportDiagnostics });
    const { container } = mount(card("about.diagnostics"));
    const button = diagnosticsButton(container)!;
    expect(button.disabled).toBe(false);
    act(() => button.click());
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Exporting");
    act(() => button.click());
    expect(exportDiagnostics).toHaveBeenCalledTimes(1);
    expect(exportDiagnostics).toHaveBeenCalledWith();
    await act(async () => { finish(null); });
    expect(button.disabled).toBe(false);
    expect(container.querySelector('[role="status"], [role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain("Saved to");
  });

  it("keeps saved-path and failure feedback with the live export action", async () => {
    const exportDiagnostics = vi.fn<() => Promise<string | null>>()
      .mockResolvedValueOnce("/fixture/report.txt")
      .mockRejectedValueOnce(new Error("Fixture export failed"));
    vi.stubGlobal("muragebox", { exportDiagnostics });
    const { container } = mount(card("about.diagnostics"));
    act(() => diagnosticsButton(container)!.click());
    await settle();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Saved to /fixture/report.txt");
    act(() => diagnosticsButton(container)!.click());
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Fixture export failed");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(diagnosticsButton(container)!.disabled).toBe(false);
  });
});

describe("one Version and updates card", () => {
  it.each(["simple", "advanced"] as const)("keeps one box, the source offer and each old anchor on a browser in %s", (mode) => {
    fixture.desktop = false;
    const { container } = mount(card("about.version", false, mode));
    expect(container.querySelectorAll(".bg-card")).toHaveLength(1);
    expect(container.textContent).toContain(t("settings.about.versionUpdatesTitle"));
    expect(container.textContent).not.toContain(t("settings.about.sourceNote"));
    expect(container.textContent).toContain(t("settings.about.versionTitle", { version: APP_VERSION }));
    for (const anchor of ["about-version-heading", "updates-heading", "previous-version-heading"]) {
      expect(container.querySelectorAll(`#${anchor}`)).toHaveLength(1);
    }
    for (const anchor of ["updates-heading", "previous-version-heading"]) {
      expect(container.querySelector(`#${anchor} [data-settings-stub="other-surface"]`)).not.toBeNull();
      expect(container.querySelector(`#${anchor} .bg-card`)).toBeNull();
    }
    const copy = container.querySelector<HTMLButtonElement>('[data-setting-control="about-version-heading"]')!;
    expect(copy.disabled).toBe(false);
    expect(copy.textContent).toBe(t("settings.about.versionCopy"));
  });

  it("keeps the source offer and unboxed unavailable rows on Cloud", () => {
    fixture.desktop = false;
    const { container } = mount(card("about.version", true));
    expect(container.querySelectorAll(".bg-card")).toHaveLength(1);
    expect(container.querySelectorAll('[data-settings-stub="other-surface"]')).toHaveLength(2);
  });

  it("keeps the previous-version action and confirmation feedback inside the single card", async () => {
    const preparePreviousVersion = vi.fn(async () => ({ started: true }));
    vi.stubGlobal("muragebox", { updater: { preparePreviousVersion } });
    fixture.updater = { status: "idle", currentVersion: "1.0.19" };
    const { container } = mount(card("about.version"));
    expect(container.querySelectorAll(".bg-card")).toHaveLength(1);
    expect(container.textContent).toContain("Murage 1.0.19");
    expect(container.textContent).toContain("Go back to the previous version, chats and memories kept");
    const button = container.querySelector<HTMLButtonElement>('[data-setting-control="previous-version-heading"]')!;
    act(() => button.click());
    await settle();
    expect(preparePreviousVersion).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Murage is asking you to confirm.");
  });

  it("leaves the standalone previous-version card boxed for its existing callers", () => {
    vi.stubGlobal("muragebox", { updater: { preparePreviousVersion: vi.fn() } });
    const { container } = mount(h(PreviousVersionRow));
    expect(container.querySelectorAll(".bg-card")).toHaveLength(1);
    expect(container.textContent).toContain("Go back to the previous version, chats and memories kept");
    expect(container.querySelector('[data-setting-control="previous-version-heading"]')).not.toBeNull();
  });

  it.each([
    ["idle", "check", "updates.check"],
    ["available", "download", "updates.download"],
    ["downloaded", "install", "updates.restartInstall"],
    ["error", "retry", "updates.retry"],
  ] as const)("preserves the %s updater action inside the merged card", async (status, method, label) => {
    const updater = { check: vi.fn(), download: vi.fn(), install: vi.fn(), retry: vi.fn() };
    vi.stubGlobal("muragebox", { updater });
    fixture.updater = { status, version: "1.0.20", message: "Fixture check failed" };
    const { container } = mount(card("about.version"));
    expect(container.querySelectorAll(".bg-card")).toHaveLength(1);
    const button = container.querySelector<HTMLButtonElement>('#updates-heading [data-setting-control="updates-heading"]')!;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe(t(label));
    act(() => button.click());
    await settle();
    expect(updater[method]).toHaveBeenCalledTimes(1);
    for (const other of ["check", "download", "install", "retry"] as const) {
      if (other !== method) expect(updater[other]).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["checking", "Checking…"],
    ["downloading", "Downloading 42%"],
    ["installing", "Preparing the update…"],
  ] as const)("keeps the %s updater state and disables its action", (status, line) => {
    vi.stubGlobal("muragebox", { updater: {} });
    fixture.updater = { status, percent: 42 };
    const { container } = mount(card("about.version"));
    expect(container.querySelector("#updates-heading")?.textContent).toContain(line);
    expect(container.querySelector<HTMLButtonElement>('[data-setting-control="updates-heading"]')!.disabled).toBe(true);
    expect(container.querySelectorAll(".bg-card")).toHaveLength(1);
  });

  it("keeps the deferred update explanation without offering an action", () => {
    vi.stubGlobal("muragebox", { updater: {} });
    fixture.updater = { status: "deferred" };
    const { container } = mount(card("about.version"));
    expect(container.querySelector("#updates-heading")?.textContent).toContain("pre-upgrade backup flow");
    expect(container.querySelector('[data-setting-control="updates-heading"]')).toBeNull();
  });
});

describe("the source offer sits at the bottom of the page", () => {
  it("is a card after Shortcuts with the AGPL line, and not in the Version card", () => {
    fixture.desktop = false;
    const { container } = mount(card("about.shortcuts", false, "advanced"));
    expect(container.textContent).toContain(t("settings.about.sourceNote"));
    const source = container.querySelector<HTMLAnchorElement>("a[target=_blank]")!;
    expect(source.getAttribute("href")).toBe(sourceCodeLink());
    expect(source.rel).toBe("noopener noreferrer");
    expect(container.textContent).toContain(sourceVersionLabel(APP_VERSION));
    expect(source.textContent).toBe(t("settings.about.sourceOpen"));
  });
});
