// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount } from "../testing/dom-harness";
import type { InstanceInfo } from "@/state/store";

const { request, dispatch } = vi.hoisted(() => ({ request: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", async original => ({
  ...await original<typeof import("@/state/store")>(),
  api: request,
  useStore: () => ({ dispatch }),
}));
import { EngineSetup } from "./EngineSetup";

const missing: InstanceInfo = {
  instanceId: "muse", driverKind: "museCode", displayName: "Muse Code",
  models: { default: "", options: [] },
  snapshot: { state: "unavailable", reason: "Muse Code isn't installed on this computer." },
  install: { command: { linux: "npm install -g @muse-code/cli" }, platform: "linux" },
};
const installed: InstanceInfo = { ...missing, snapshot: { state: "available", authenticated: true, version: "1.4.14" } };
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => { request.mockReset(); dispatch.mockReset(); });
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.restoreAllMocks(); });

async function checkAgain() {
  const button = Array.from(document.querySelectorAll("button")).find(node => node.textContent === "Check again");
  expect(button).toBeDefined();
  await act(async () => { button!.click(); });
}
function expectCalmCard() {
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector('[class*="danger"], [class*="warning"], .lucide-triangle-alert, .lucide-circle-alert')).toBeNull();
  expect(document.body.textContent).not.toMatch(/power block|power protection|launch refused/i);
}

describe("missing Muse setup card", () => {
  it("renders a calm not-installed result when Check again still finds no engine", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    request.mockResolvedValue({ instances: [missing] });
    const onReady = vi.fn();
    mount(createElement(EngineSetup, { instance: missing, onReady }));
    expect(document.body.textContent).toContain("Install Muse Code");
    expectCalmCard();
    await checkAgain();
    expect(document.querySelector('[role="status"]')?.textContent).toBe(missing.snapshot.reason);
    expectCalmCard();
    expect(onReady).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("BLOCK 1: the rendered Check again requests fresh discovery and finds an installation immediately", async () => {
    // A background read retains its ten-minute negative result. A fresh read
    // discovers the fake installation that appeared after the card opened.
    request.mockImplementation(async (path: string) => ({ instances: [new URL(path, "http://fixture.invalid").searchParams.get("fresh") === "1" ? installed : missing] }));
    const onReady = vi.fn();
    mount(createElement(EngineSetup, { instance: missing, onReady }));
    expect(request).not.toHaveBeenCalled();
    await checkAgain();
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/instances?fresh=1");
    expect(dispatch).toHaveBeenCalledWith({ type: "instances", instances: [installed] });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Engine detected. Select a model to test it with a task.");
    expectCalmCard();
  });
});
