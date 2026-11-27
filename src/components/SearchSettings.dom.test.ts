// @vitest-environment jsdom
// polish-1021 (c): with Flux Router as the search provider, Sean's Settings still showed three key fields for search
// services he never chose. Connectors are optional and stay out of sight unless used: a key field shows only for the
// provider in use or a key already saved; the rest sit behind one "Other search services" row.
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { SearchSettings } from "./SearchSettings";

const fixture = vi.hoisted(() => ({ state: { config: null as any }, dispatch: vi.fn(), api: vi.fn(async () => ({})) }));
vi.mock("@/state/store", async original => ({ ...(await original<typeof import("@/state/store")>()), useStore: () => fixture, api: fixture.api }));

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); });

const keyFields = () => ["tavily", "exa", "firecrawl"].filter(p => document.getElementById(`${p}-search-key`));
const more = () => [...document.querySelectorAll("button")].find(b => b.textContent === "Other search services");
const show = (webSearch: Record<string, unknown>) => {
  fixture.state.config = { webSearch: { tavilyConfigured: false, exaConfigured: false, firecrawlConfigured: false, fluxConfigured: true, ...webSearch } };
  mount(h(SearchSettings));
};

it("shows no search service key field while Flux Router searches, only one closed Other search services row", async () => {
  show({ provider: "flux" });
  expect(keyFields()).toEqual([]);
  expect(more()?.getAttribute("aria-expanded")).toBe("false");
  await act(async () => { more()!.click(); });
  expect(keyFields()).toEqual(["tavily", "exa", "firecrawl"]);
});

it("shows the key field for the chosen provider and for a key already saved, and nothing else up front", () => {
  show({ provider: "tavily", exaConfigured: true });
  expect(keyFields()).toEqual(["tavily", "exa"]);
  expect(more()).toBeTruthy();
});

it("has no Other search services row when every service is already shown", () => {
  show({ provider: "exa", tavilyConfigured: true, firecrawlConfigured: true });
  expect(keyFields()).toEqual(["tavily", "exa", "firecrawl"]);
  expect(more()).toBeUndefined();
});

it("shows that Search Off turns off page reading", () => {
  show({ provider: "off", readEnabled: false });
  const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]');
  expect(toggle?.getAttribute("aria-checked")).toBe("false");
  expect(toggle?.disabled).toBe(true);
  expect(document.body.textContent).toContain("Page reading is off while web search is off.");
});

it("saves the independent page reading setting through the server", async () => {
  const config = { webSearch: { provider: "engine", readEnabled: false } };
  fixture.api.mockResolvedValueOnce(config);
  show({ provider: "engine", readEnabled: true });
  const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]');
  expect(toggle?.getAttribute("aria-checked")).toBe("true");
  await act(async () => { toggle!.click(); });
  expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ webSearch: { readEnabled: false } }) });
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config });
});
