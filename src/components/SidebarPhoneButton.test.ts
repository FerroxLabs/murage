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
    expect(deriveSidebarPhoneStatus({ enabled: true, devices: [], connectedDeviceIds: [] }, now)).toEqual({
      kind: "unpaired",
      label: "Pair a phone",
      pairedCount: 0,
      connectedCount: 0,
    });
  });

  it("reports off and failed sidecars before offering to pair an empty device list", () => {
    expect(deriveSidebarPhoneStatus({
      enabled: false,
      devices: [],
      connectedDeviceIds: [],
    }, now)).toEqual({
      kind: "unavailable",
      label: "Phone access off",
      pairedCount: 0,
      connectedCount: 0,
    });
    expect(deriveSidebarPhoneStatus({
      enabled: true,
      devices: [],
      connectedDeviceIds: [],
      error: "sidecar unavailable",
    }, now)).toEqual({
      kind: "unavailable",
      label: "Phone status unavailable",
      pairedCount: 0,
      connectedCount: 0,
    });
  });

  it("turns green only for a paired phone with a live authenticated stream", () => {
    const recent = device(now - SIDEBAR_PHONE_RECENT_MS);
    expect(deriveSidebarPhoneStatus({
      enabled: true,
      devices: [recent],
      connectedDeviceIds: ["phone-1"],
    }, now)).toMatchObject({ kind: "connected", label: "Phone connected", connectedCount: 1 });
    expect(
      deriveSidebarPhoneStatus({ enabled: true, devices: [recent], connectedDeviceIds: [] }, now),
    ).toMatchObject({ kind: "disconnected", label: "Phone paired: not connected" });
    expect(deriveSidebarPhoneStatus({
      enabled: false,
      devices: [recent],
      connectedDeviceIds: ["phone-1"],
    }, now).kind).toBe("unavailable");
    expect(deriveSidebarPhoneStatus({
      enabled: true,
      devices: [recent],
      connectedDeviceIds: ["phone-1"],
      error: "not responding",
    }, now).kind).toBe("unavailable");
  });

  it("reports partial live connectivity without implying every paired phone is online", () => {
    expect(deriveSidebarPhoneStatus({
      enabled: true,
      devices: [device(now - 1_000), { ...device(now - SIDEBAR_PHONE_RECENT_MS - 1), id: "phone-2" }],
      connectedDeviceIds: ["phone-1"],
    }, now)).toMatchObject({
      kind: "connected",
      label: "1 of 2 phones connected",
      pairedCount: 2,
      connectedCount: 1,
    });
  });

  it("keeps the older last-seen compatibility status neutral", () => {
    expect(deriveSidebarPhoneStatus({
      enabled: true,
      devices: [device(now - 1_000)],
    }, now)).toMatchObject({
      kind: "recent",
      label: "Phone active recently",
      connectedCount: 0,
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
      kind: "connected",
      label: "Phone connected",
      pairedCount: 1,
      connectedCount: 1,
    });

    expect(markup).toContain('aria-label="Phone connected"');
    expect(markup).toContain('title="Phone connected"');
    expect(markup).toContain('data-sidebar-density="comfortable"');
    expect(markup).toContain('data-phone-status="connected"');
    expect(markup).toContain("data-phone-connected");
    expect(markup).toContain("text-success");
    expect(markup).not.toMatch(/192\.168|\.local|\.ts\.net|Pairing address/);
  });

  it("stays a centered compact control and shows the plus only when unpaired", () => {
    const unpaired = render("icons", {
      kind: "unpaired",
      label: "Pair a phone",
      pairedCount: 0,
      connectedCount: 0,
    });
    const stale = render("icons", {
      kind: "stale",
      label: "Phone paired: not recently active",
      pairedCount: 1,
      connectedCount: 0,
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
      label: "Phone paired: not recently active",
      pairedCount: 1,
      connectedCount: 0,
    });

    expect(markup).toContain('data-sidebar-density="compact"');
    expect(markup).toContain("size-10");
    expect(markup).toContain("shrink-0");
  });
});

describe("TENJOBS-APP-GAPS job 9: the ten-jobs walk finds the phone button under every label", () => {
  const now = 1_900_000_000_000;
  const at = (id: string, lastSeenAt: number) => ({ ...device(lastSeenAt), id });
  const snapshots = [
    undefined,
    null,
    { enabled: true, devices: [], connectedDeviceIds: [], error: "down" },
    { enabled: false, devices: [], connectedDeviceIds: [] },
    { enabled: true, devices: [], connectedDeviceIds: [] },
    { enabled: true, devices: [at("a", now)], connectedDeviceIds: ["a"] },
    { enabled: true, devices: [at("a", now), at("b", now)], connectedDeviceIds: ["a", "b"] },
    { enabled: true, devices: [at("a", now), at("b", now)], connectedDeviceIds: ["a"] },
    { enabled: true, devices: [at("a", now)], connectedDeviceIds: [] },
    { enabled: true, devices: [at("a", now), at("b", now)], connectedDeviceIds: [] },
    { enabled: true, devices: [at("a", now)] },
    { enabled: true, devices: [at("a", now), at("b", now)] },
    { enabled: true, devices: [at("a", now), at("b", 1)] },
    { enabled: true, devices: [at("a", 1)] },
    { enabled: true, devices: [at("a", 1), at("b", 1)] },
  ] as Parameters<typeof deriveSidebarPhoneStatus>[0][];

  it("matches each label the button can carry, and the walk uses that pattern", async () => {
    const pathsUrl = new URL("../../scripts/ten-jobs/paths.mjs", import.meta.url).href;
    const { PATHS, PHONE_BUTTON } = (await import(/* @vite-ignore */ pathsUrl)) as {
      PATHS: { id: number; path: { name?: unknown }[] }[];
      PHONE_BUTTON: RegExp;
    };
    expect(PATHS.find((job) => job.id === 9)?.path[0]?.name).toBe(PHONE_BUTTON);
    const labels = new Set(snapshots.map((snapshot) => deriveSidebarPhoneStatus(snapshot, now).label));
    expect(labels.size).toBe(14);
    for (const label of labels) expect(label).toMatch(PHONE_BUTTON);
    expect("Phone and other devices").not.toMatch(PHONE_BUTTON);
  });
});
