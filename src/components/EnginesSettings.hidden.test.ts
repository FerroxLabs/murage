// 1.0.18 U22 G20 (upstream f4fe7cb06, #4159): an engine row offers Hide (never on Fuigo), and the engines someone hid
// are listed apart, under Advanced (Settings has no other fold), each with Unhide. The renderer suite has no DOM to click in, so the list is pinned through
// its presentational half (HiddenEnginesList) and the row through the Engines panel's markup.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";

const { store } = vi.hoisted(() => ({
  store: { instances: [] as unknown[], refreshInstances: async () => {}, dispatch: () => {} },
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, instances: store.instances, shellEnvironment: null }, dispatch: store.dispatch, refreshInstances: store.refreshInstances }),
    api: async () => { throw new Error("no network in this test"); },
  };
});
import { EnginesSettings, HiddenEnginesList } from "./EnginesSettings";

const instance = (instanceId: string, driverKind: string, displayName: string): InstanceInfo => ({
  instanceId, driverKind, displayName, enabled: true, cliDefault: driverKind,
  snapshot: { state: "available", authenticated: true, version: "1.0.0" },
  models: { default: "m", options: [{ id: "m", label: "Model" }] },
} as InstanceInfo);

afterEach(() => { store.instances = []; });

describe("hiding an engine in Settings", () => {
  it("offers Hide on every engine but Fuigo, and Fuigo stays first", () => {
    store.instances = [instance("fuigo", "fuigoAgent", "Fuigo"), instance("hermes", "hermesAgent", "Hermes")];
    const markup = renderToStaticMarkup(createElement(EnginesSettings));
    expect(markup).toContain('data-hide-engine="hermes"');
    expect(markup).not.toContain('data-hide-engine="fuigo"');
    expect(markup.indexOf("Fuigo")).toBeLessThan(markup.indexOf("Hermes"));
    expect(markup).toContain("Leave this engine out of every model list.");
  });

  it("shows nothing while no engine is hidden", () => {
    expect(renderToStaticMarkup(createElement(HiddenEnginesList, { hidden: [], busy: null, error: null, onUnhide: () => {} }))).toBe("");
  });

  it("lists hidden engines apart, under Advanced, each with Unhide", () => {
    const markup = renderToStaticMarkup(createElement(HiddenEnginesList, {
      hidden: [{ instanceId: "hermes", displayName: "Hermes" }, { instanceId: "pi", displayName: "pi" }], busy: "pi", error: null, onUnhide: () => {},
    }));
    expect(markup).toMatch(/<section data-hidden-engines[^>]*><p data-hidden-engines-title[^>]*>Hidden \(2\)<\/p>/);
    expect(markup).not.toContain("<details");
    expect(markup).toContain("Hermes");
    expect(markup).toContain('data-unhide-engine="hermes"');
    expect(markup).toMatch(/data-unhide-engine="hermes"[^>]*>Unhide</);
    expect(markup).toMatch(/data-unhide-engine="pi"[^>]*>Unhiding…</);
  });
});
