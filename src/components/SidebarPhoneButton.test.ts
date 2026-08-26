import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  deriveSidebarPhoneStatus,
  phoneSettingsAction,
  SIDEBAR_PHONE_RECENT_MS,
  SidebarPhoneStatusButton,
  type SidebarPhoneStatus,
} from "./SidebarPhoneButton";

const device = (lastSeenAt: number) => ({
  id: "phone-1",
  name: "iPhone",
  createdAt: lastSeenAt,
  lastSeenAt,
  cloudDesktopAccess: false,
});

describe("sidebar phone status", () => {
  const now = 1_900_000_000_000;

  it("uses neutral plus semantics when no phone is paired", () => {
    expect(deriveSidebarPhoneStatus({ enabled: true, devices: [] }, now)).toEqual({
      kind: "unpaired",
      label: "Pair a phone",
      pairedCount: 0,
      recentCount: 0,
    });
  });

  it("turns green only for a phone that reached an enabled healthy sidecar recently", () => {
    const recent = device(now - SIDEBAR_PHONE_RECENT_MS);
    expect(deriveSidebarPhoneStatus({ enabled: true, devices: [recent] }, now).kind).toBe("recent");
    expect(
      deriveSidebarPhoneStatus({ enabled: true, devices: [device(now - SIDEBAR_PHONE_RECENT_MS - 1)] }, now),
    ).toMatchObject({ kind: "stale", label: "Phone paired — not recently active" });
    expect(deriveSidebarPhoneStatus({ enabled: false, devices: [recent] }, now).kind).toBe("stale");
    expect(deriveSidebarPhoneStatus({ enabled: true, devices: [recent], error: "not responding" }, now).kind).toBe("stale");
  });

  it("reports partial recent activity without implying every paired phone is online", () => {
    expect(deriveSidebarPhoneStatus({
      enabled: true,
      devices: [device(now - 1_000), { ...device(now - SIDEBAR_PHONE_RECENT_MS - 1), id: "phone-2" }],
    }, now)).toMatchObject({
      kind: "recent",
      label: "1 of 2 phones active recently",
      pairedCount: 2,
      recentCount: 1,
    });
  });

  it("opens Settings directly on the internal Phone section", () => {
    expect(phoneSettingsAction()).toEqual({
      type: "toggleAppSettings",
      open: true,
      section: "companion",
    });
  });
});

describe("SidebarPhoneStatusButton", () => {
  const render = (density: "comfortable" | "compact" | "icons", status: SidebarPhoneStatus) =>
    renderToStaticMarkup(createElement(SidebarPhoneStatusButton, {
      density,
      status,
      onOpen: vi.fn(),
    }));

  it("keeps its plain status accessible in the full sidebar without exposing connection details", () => {
    const markup = render("comfortable", {
      kind: "recent",
      label: "Phone active recently",
      pairedCount: 1,
      recentCount: 1,
    });

    expect(markup).toContain('aria-label="Phone active recently"');
    expect(markup).toContain('title="Phone active recently"');
    expect(markup).toContain('data-sidebar-density="comfortable"');
    expect(markup).toContain('data-phone-status="recent"');
    expect(markup).toContain("text-success");
    expect(markup).not.toMatch(/192\.168|\.local|\.ts\.net|Pairing address/);
  });

  it("stays a centered compact control and shows the plus only when unpaired", () => {
    const unpaired = render("icons", {
      kind: "unpaired",
      label: "Pair a phone",
      pairedCount: 0,
      recentCount: 0,
    });
    const stale = render("icons", {
      kind: "stale",
      label: "Phone paired — not recently active",
      pairedCount: 1,
      recentCount: 0,
    });

    expect(unpaired).toContain('data-sidebar-density="icons"');
    expect(unpaired).toContain("mx-auto");
    expect(unpaired).toContain("data-phone-plus");
    expect(stale).not.toContain("data-phone-plus");
    expect(stale).not.toContain("text-success");
  });

  it("uses the same fixed-size control in the compact text sidebar", () => {
    const markup = render("compact", {
      kind: "stale",
      label: "Phone paired — not recently active",
      pairedCount: 1,
      recentCount: 0,
    });

    expect(markup).toContain('data-sidebar-density="compact"');
    expect(markup).toContain("size-10");
    expect(markup).toContain("shrink-0");
  });
});
