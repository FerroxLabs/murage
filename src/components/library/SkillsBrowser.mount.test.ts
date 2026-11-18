// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { beforeAll, afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, press, settle } from "../../testing/dom-harness";
import { activeTrapCount } from "../../lib/focus-trap";
import { initialState, type Bot } from "../../state/store";
import { TeamLibraryPanel } from "../TeamLibraryPanel";
import { LazyOverlay } from "../LazyOverlay";
const fixture = vi.hoisted(() => ({ state: {} as typeof initialState, api: vi.fn(), fetchTopics: vi.fn(), fetchSkills: vi.fn(), detail: vi.fn() }));
vi.mock("@/state/store", async original => ({ ...await original<typeof import("../../state/store")>(), useStore: () => ({ state: fixture.state, dispatch: vi.fn() }), api: fixture.api }));
vi.mock("@/lib/skillsLibrary", () => ({ fetchTopics: fixture.fetchTopics, fetchSkills: fixture.fetchSkills }));
vi.mock("./SkillDetailPane", () => ({ SkillDetailPane: (props: {skillId: string; compact: boolean; bots: {id: string; name: string}[]}) => { fixture.detail(props); return h("p", null, "Skill instructions"); } }));
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); vi.unstubAllGlobals(); vi.restoreAllMocks(); expect(activeTrapCount()).toBe(0); });
beforeEach(() => {
  vi.clearAllMocks();
  fixture.state = { ...initialState, bots: [{ id: "visible", name: "Growth" }, { id: "archived", name: "Archived", hidden: true }] as Bot[] };
  fixture.fetchTopics.mockResolvedValue({ topics: [{ term: "testing", label: "Testing", count: 1 }], totalSkills: 1 });
  fixture.fetchSkills.mockResolvedValue({items: [{ id: "test-skill", name: "Test skill", description: "A skill for the fixture.", bots: [], topics: ["testing"], mine: false }], total: 1, offset: 0});
  fixture.api.mockImplementation(async (path: string) => path.includes("catalog") ? { repositoryUrl: "", teams: [] } : path.includes("browse") ? { facets: [], totalSkills: 1 } : { skills: [] });
});
function render(onClose = vi.fn()) {
  return mount(h(LazyOverlay, { name: "library-fixture", kind: "window", covers: "always", onDismiss: onClose, onRetry: vi.fn() }, h(TeamLibraryPanel, { initialView: "skills", onClose, onImported: vi.fn(), returnFocusRef: { current: null } })));
}
it("mounts the browser in Skills with visible bots and leaves the other tabs usable", async () => {
  render(); await settle();
  expect(document.querySelector('[data-skills-browser]')).toBeTruthy();
  expect(fixture.detail).toHaveBeenLastCalledWith(expect.objectContaining({ skillId: "test-skill", bots: [{ id: "visible", name: "Growth" }], compact: false }));
  expect(document.querySelectorAll('input[placeholder^="Search"]')).toHaveLength(1);
  const teams = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(node => node.textContent === "Teams")!;
  act(() => teams.click()); await settle(); expect(document.querySelector('[data-skills-browser]')).toBeNull();
  const skills = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(node => node.textContent === "Skills")!;
  act(() => skills.click()); await settle(); expect(document.querySelector('[data-skills-browser]')).toBeTruthy();
});
it("uses compact mode below 860px of panel width and reacts to resizing", async () => {
  let matches = true; let changed: (() => void) | undefined;
  vi.stubGlobal("matchMedia", (query: string) => ({ media: query, get matches() { return matches; }, addEventListener: (_: string, callback: () => void) => { changed = callback; }, removeEventListener: vi.fn() }));
  render(); await settle(); expect(document.querySelector('[data-skills-browser]')!.getAttribute("data-compact")).toBe("true");
  expect(document.querySelector('nav[aria-label="Topics"]')).toBeNull();
  act(() => { matches = false; changed?.(); }); await settle();
  expect(document.querySelector('[data-skills-browser]')!.getAttribute("data-compact")).toBe("false");
  expect(document.querySelector('nav[aria-label="Topics"]')).toBeTruthy();
});
it("Escape closes the compact topic picker before the containing Library", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ media: query, matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const close = vi.fn(); render(close); await settle();
  const change = document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
  act(() => { change.focus(); change.click(); }); await settle(); expect(activeTrapCount()).toBe(2);
  press("Escape"); await settle(); expect(close).not.toHaveBeenCalled(); expect(document.activeElement).toBe(change); expect(activeTrapCount()).toBe(1);
  press("Escape"); expect(close).toHaveBeenCalledOnce();
});

it("switches at the actual 860px panel boundary even when the viewport is wide", async () => {
  let width = 859; let resize!: () => void;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, width, 780));
  render(); await settle(); expect(document.querySelector('[data-skills-browser]')!.getAttribute("data-compact")).toBe("true");
  act(() => { width = 860; resize(); }); await settle(); expect(document.querySelector('[data-skills-browser]')!.getAttribute("data-compact")).toBe("false");
});
