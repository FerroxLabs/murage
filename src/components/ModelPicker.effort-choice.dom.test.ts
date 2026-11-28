// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { initialState, type Bot } from "../state/store";
import { cleanup, installDOMHarness, mount } from "../testing/dom-harness";
import { ModelPicker } from "./ModelPicker";

const fixture = vi.hoisted(() => ({ state: {} as typeof initialState, dispatch: vi.fn() }));
vi.mock("@/state/store", async original => ({
  ...await original<typeof import("../state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch, refreshInstances: async () => {} }),
  api: async () => ({ connections: [] }),
}));

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); fixture.dispatch.mockClear(); });

const route = { instanceId: "fixture", model: "fixture/a" };
async function openPicker() {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  const bot = { id: "fixture-bot", name: "Fixture", threadId: "fixture-thread", busy: false, tasks: [],
    modelSelection: { ...route, effort: "high", variant: "native-a" } } as unknown as Bot;
  fixture.state = {
    ...initialState,
    bots: [bot],
    instances: [{
      instanceId: route.instanceId, displayName: "Fixture", driverKind: "custom",
      snapshot: { state: "available", authenticated: true },
      capabilities: { effortLevels: ["low", "high"] },
      models: { default: route.model, options: [
        { id: route.model, label: "Fixture A", variants: [{ id: "native-a", label: "Native A" }, { id: "native-b", label: "Native B" }] },
        { id: "fixture/b", label: "Fixture B" },
      ] },
    }] as unknown as typeof initialState.instances,
  };
  const app = mount(h(ModelPicker, { bot, threadId: bot.threadId, contained: true }));
  await act(async () => { app.container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.click(); });
  await act(async () => { await vi.dynamicImportSettled(); });
  return app.container;
}

it.each([
  ["Thinking", "native-b", { variant: "native-b" }],
  ["Thread effort", "low", { effort: "low" }],
] as const)("saving %s replaces the other saved effort field", async (label, value, expected) => {
  const container = await openPicker();
  const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  expect(select).not.toBeNull();
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(fixture.dispatch).toHaveBeenCalledOnce();
  expect(fixture.dispatch.mock.calls[0][0].selection).toEqual({ ...route, ...expected });
});

it("a new model on the same engine clears both saved effort fields", async () => {
  const container = await openPicker();
  const choice = [...container.querySelectorAll<HTMLButtonElement>("[data-model-choice]")]
    .find(button => button.textContent?.includes("Fixture B"));
  expect(choice).toBeDefined();
  await act(async () => { choice!.click(); });
  expect(fixture.dispatch).toHaveBeenCalledOnce();
  expect(fixture.dispatch.mock.calls[0][0].selection).toEqual({ ...route, model: "fixture/b" });
});
