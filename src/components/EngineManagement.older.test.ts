// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// FUIGOREPOINT-1020: a Fuigo the owner chose outside the managed store stays theirs, and Settings says plainly when it is older
// than the built-in Fuigo, with one action: Use the built-in Fuigo.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.fn();
vi.mock("@/state/store", () => ({ api: (...args: unknown[]) => api(...args), useStore: () => ({ refreshInstances: vi.fn(async () => {}) }) }));
import { EngineManagement } from "./EngineManagement";

const older = { supported: true, updateAvailable: false, installedVersion: "1.0.22", latestVersion: "1.0.43", busy: false, source: "custom", bundledAvailable: true, bundledVersion: "1.0.43", olderThanBundled: true,
  message: "This Fuigo is version 1.0.22, older than the built-in Fuigo 1.0.43. With it, Murage can't confirm your approval settings." };
const instance = { instanceId: "fuigo", driverKind: "fuigoAgent", displayName: "Fuigo", snapshot: { state: "available", version: "fuigo 1.0.22" } } as never;
let root: Root, container: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); api.mockReset(); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const buttons = () => [...container.querySelectorAll("button")].map(node => node.textContent);
async function show(status: Record<string, unknown>) {
  api.mockImplementation(async (_url: string, init?: RequestInit) => init?.body && JSON.parse(String(init.body)).action === "use-bundled" ? { ...status, source: "bundled", olderThanBundled: false, message: "ok" } : status);
  await act(async () => { root.render(createElement(EngineManagement, { instance })); });
  await act(async () => {});
}

it("says an older chosen Fuigo is older than built-in, with one Use the built-in Fuigo action", async () => {
  await show(older);
  expect(container.querySelector('[role="status"]')?.textContent).toBe(older.message);
  expect(buttons().filter(label => label === "Use the built-in Fuigo")).toHaveLength(1);
  expect(buttons()).not.toContain("Use bundled Fuigo");
  await act(async () => { [...container.querySelectorAll("button")].find(node => node.textContent === "Use the built-in Fuigo")!.click(); });
  expect(api).toHaveBeenCalledWith("/api/engine-management/fuigo", { method: "POST", body: JSON.stringify({ action: "use-bundled" }) });
});

it("shows no older notice for a chosen Fuigo at the built-in version", async () => {
  await show({ ...older, installedVersion: "1.0.43", olderThanBundled: false, message: "Your existing Fuigo selection is preserved." });
  expect(buttons()).not.toContain("Use the built-in Fuigo");
  expect(buttons()).toContain("Use bundled Fuigo");
});
