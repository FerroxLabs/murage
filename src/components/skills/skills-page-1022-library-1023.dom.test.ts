// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 ships the 1.0.22 Settings (Settings v10 moves whole to 1.0.24, MAIN-RULING 2026-11-26T17:34Z): Settings >
// Skills, opened through the shell's page loader, draws the 1.0.22 library (Your skills, Built-in, Library, its search
// box, its rows and the topic prompt), not the v10 library whose index routes and bulk actions do not ship.
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount } from "../../testing/dom-harness";
import { SETTINGS_PAGE_LOADERS } from "../settings/page-registry";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), state: { bots: [], groups: [], instances: [], workspaceFeatures: {} } }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }), useStoreIfAny: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
vi.mock("../LayerSlot", () => ({ useLayerContainer: () => {}, useLayerOwner: () => null }));
vi.mock("./SkillReader", () => ({ SkillReader: ({ skillRef }: { skillRef: string }) => h("div", { "aria-label": "Read skill" }, skillRef) }));
vi.mock("../library/SkillDetailPane", () => ({ SkillDetailPane: ({ skillId }: { skillId: string }) => h("div", { "aria-label": "Skill detail fixture" }, skillId) }));

const library = Array.from({ length: 3 }, (_, i) => ({ id: `fixture-${i}`, name: `Library skill ${i}`, description: "Plan tasks", terms: ["planning"], ref: `library:fixture-${i}`, kind: "library", verdict: "clean", usedBy: [], source: "Library" }));
const yours = [{ id: "mine-1", name: "My own skill", description: "Mine", terms: [], ref: "local:mine-1", kind: "local", verdict: "clean", usedBy: [], source: "You" }];

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  vi.useFakeTimers();
  // Every route answers: a page that asks for something else renders what it renders, never a thrown fixture error.
  fixture.api.mockImplementation(async (path: string) => {
    const url = new URL(path, "http://fixture");
    if (url.pathname === "/api/skills") return { yours, library, categories: [{ name: "planning", count: 3 }], libraryReady: true, pagination: { offset: 0, limit: 60, total: library.length } };
    return {};
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
async function flush() { for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(250); }); }

it("Settings > Skills from the page loader draws the 1.0.22 library: its section, search box, Your skills rows and the Library topic prompt", async () => {
  const Page = (await SETTINGS_PAGE_LOADERS.skills!()).default;
  const app = mount(h(Page, { page: "skills", mode: "advanced", desktop: true, cloud: false, anchor: null } as never));
  await flush();
  const section = app.container.querySelector('section[aria-labelledby="skills-library-title"]');
  expect(section, app.container.textContent ?? "").not.toBeNull();
  expect(section!.querySelector('input[aria-label="Search skills"]')).not.toBeNull();
  const headings = [...section!.querySelectorAll("h3")].map(each => each.textContent?.trim());
  expect(headings).toEqual(expect.arrayContaining(["Your skills", "Library"]));
  expect(section!.textContent).toContain("My own skill");
  expect(section!.textContent).toContain("Search, or choose a topic.");
});
