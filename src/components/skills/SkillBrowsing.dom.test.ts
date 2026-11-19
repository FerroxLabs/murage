// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount } from "../../testing/dom-harness";
import { SkillPicker } from "./SkillPicker";
import { SkillsSettings } from "./SkillsSettings";
import { TeamLibraryPanel } from "../TeamLibraryPanel";
const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), state: { bots: [], groups: [], instances: [] } }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }), useStoreIfAny: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
vi.mock("../LayerSlot", () => ({ useLayerContainer: () => {}, useLayerOwner: () => null }));
vi.mock("./SkillReader", () => ({ SkillReader: ({ skillRef }: { skillRef: string }) => h("div", { "aria-label": "Read skill" }, skillRef) }));
vi.mock("../library/SkillDetailPane", () => ({ SkillDetailPane: ({ skillId }: { skillId: string }) => h("div", { "aria-label": "Skill detail fixture" }, skillId) }));
const topics = Array.from({ length: 141 }, (_, i) => ({ name: i ? `topic-${i}` : "planning", count: i ? 12 : 600 }));
const skills = Array.from({ length: 600 }, (_, i) => ({ id: `planning-${String(i).padStart(3, "0")}`, name: `Skill ${String(i).padStart(3, "0")}`, description: i === 599 ? "Unique tail marker" : "Plan tasks", terms: ["planning"] }));
const summary = (s: typeof skills[number]) => ({ ...s, ref: `library:${s.id}`, kind: "library", verdict: "clean", usedBy: [], source: "Library" });
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  vi.useFakeTimers();
  fixture.api.mockImplementation(async (path: string) => {
    const url = new URL(path, "http://fixture");
    if (url.pathname === "/api/team-library/catalog") return { teams: [], repositoryUrl: "" };
    if (url.pathname === "/api/library/browse") return { totalSkills: 2247, facets: topics.map(t => ({ term: t.name, count: t.count })) };
    if (url.pathname === "/api/library/topics") return { totalSkills: 2247, topics: topics.map((t, i) => ({ term: t.name, label: i ? `Topic ${i}` : "Planning", count: t.count })) };
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 60);
    const q = url.searchParams.get("q")?.toLowerCase() ?? "";
    const term = url.searchParams.get("term") ?? url.searchParams.get("category");
    const hits = term === "planning" || (!term && q) ? skills.filter(s => !q || `${s.name} ${s.description}`.toLowerCase().includes(q)) : [];
    const pagination = { offset, limit, total: hits.length };
    if (url.pathname === "/api/library/skills") return { items: hits.slice(offset, offset + limit).map(s => ({ ...s, topics: s.terms, bots: [], mine: false })), total: hits.length, offset };
    if (url.pathname === "/api/library/search") return { skills: hits.slice(offset, offset + limit), teams: [], pagination };
    if (url.pathname === "/api/skills") return { yours: [], library: hits.slice(offset, offset + limit).map(summary), categories: topics, libraryReady: true, pagination };
    throw new Error(`Unexpected request ${path}`);
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(250); }); }
async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === text || b.getAttribute("aria-label") === text);
  expect(button, text).toBeDefined(); await act(async () => { button!.focus(); button!.click(); }); await flush();
}
function type(value: string) {
  const input = document.querySelector('input[aria-label^="Search"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
function typeTemplateSearch(value: string) {
  const input = document.querySelector('input[placeholder^="Search all"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
function templateRows() {
  return [...document.querySelectorAll('[aria-label="Skill results"] [data-skill-index]')];
}
for (const surface of ["templates", "settings", "new bot"] as const) {
  it(`FB${surface === "new bot" ? 3 : 2} DOM ${surface}: all 600 skills reachable, bounded pages, topic search and all 141 topics`, async () => {
    const app = mount(surface === "templates" ? h(TeamLibraryPanel, { initialView: "skills", onClose: () => {}, onImported: () => {}, returnFocusRef: { current: null } }) : surface === "settings" ? h(SkillsSettings) : h(SkillPicker, { botId: "new-bot", botName: "Sable", onDone: () => {} }));
    await flush();
    const container = surface === "templates" ? document.body : app.container;
    if (surface === "templates") {
      // MAIN RULING 2026-11-14 Skills v2 (Sean lock 11-13): templates = SkillsBrowser, 100-row Show more + cross-topic search; reachability and stale-response proofs kept
      typeTemplateSearch("Unique"); await flush();
      expect(container.textContent).toContain("Skill 599");
      await click("Teams"); await click("Skills");
      typeTemplateSearch("Unique"); await flush();
      expect(container.textContent).toContain("Skill 599");
      typeTemplateSearch(""); await flush();
      const rail = container.querySelector('nav[aria-label="Topics"]')!;
      expect(rail.textContent).toContain("All 141 topics, A to Z");
      for (const [i, topic] of topics.entries()) {
        await click(`${i ? `Topic ${i}` : "Planning"}${topic.count}`);
        expect(rail.querySelector('[aria-current="true"]')?.textContent).toBe(`${i ? `Topic ${i}` : "Planning"}${topic.count}`);
        const request = new URL(fixture.api.mock.calls.at(-1)![0], "http://fixture");
        expect(request.pathname).toBe("/api/library/skills");
        expect(request.searchParams.get("term")).toBe(topic.name);
      }
      await click("Planning600");
      const seen = new Set<string>();
      for (let page = 0; page < 6; page++) {
        const rows = templateRows();
        expect(rows).toHaveLength((page + 1) * 100);
        for (const row of rows) seen.add(row.querySelector("span.truncate")!.textContent!);
        const request = new URL(fixture.api.mock.calls.at(-1)![0], "http://fixture");
        expect(request.searchParams.get("offset")).toBe(String(page * 100));
        expect(request.searchParams.get("limit")).toBe("100");
        if (page < 5) await click("Show more");
      }
      expect(seen.size).toBe(600);
      expect(container.textContent).toContain("Unique tail marker");
      expect([...container.querySelectorAll("button")].some(b => b.textContent === "Show more")).toBe(false);
      // Search while a different topic is selected must still find the planning tail.
      await click("Topic 14012");
      typeTemplateSearch("Unique"); await flush();
      expect(templateRows()).toHaveLength(1);
      expect(container.textContent).toContain("Skill 599");
      expect(container.textContent).toContain("1 skill, all topics");
      const search = new URL(fixture.api.mock.calls.at(-1)![0], "http://fixture");
      expect(search.pathname).toBe("/api/library/skills");
      expect(search.searchParams.get("q")).toBe("Unique");
      expect(search.searchParams.has("term")).toBe(false);
      expect(search.searchParams.get("filter")).toBe("all");
      const pages = fixture.api.mock.calls.map(([path]) => new URL(path, "http://fixture")).filter(url => url.pathname === "/api/library/skills");
      expect(pages.length).toBeGreaterThan(6);
      expect(pages.every(url => Number(url.searchParams.get("limit")) > 0 && Number(url.searchParams.get("limit")) <= 100)).toBe(true);
      expect(fixture.api.mock.calls.every(([, init]) => !init)).toBe(true);
      return;
    }
    const select = container.querySelector("select")!;
    expect(select.options).toHaveLength(142);
    await act(async () => { select.value = "planning"; select.dispatchEvent(new Event("change", { bubbles: true })); }); await flush();
    const seen: string[] = [];
    for (let page = 0; page < 10; page++) {
      const names = [...container.querySelectorAll("h4,li button div.truncate")].map(n => n.textContent ?? "").filter(n => /^Skill \d{3}$/.test(n));
      expect(names).toHaveLength(60); seen.push(...names);
      expect(container.textContent).toContain(`${page * 60 + 1}–${(page + 1) * 60} of 600 skills`);
      if (page < 9) {
        await click("Next page");
        expect(document.activeElement).toBe(container.querySelector('[aria-label="Next page"]'));
      }
    }
    expect(new Set(seen).size).toBe(600);
    expect((container.querySelector('[aria-label="Next page"]') as HTMLButtonElement).disabled).toBe(true);
    await click("Previous page");
    expect(container.textContent).toContain("481–540 of 600 skills");
    type("Unique"); await flush();
    expect(container.textContent).toContain("Skill 599");
    expect(container.textContent).toContain("1–1 of 1 skill");
    const last = fixture.api.mock.calls.at(-1)![0];
    expect(last).toContain("category=planning");
    expect(last).toContain("q=Unique");
    const row = [...container.querySelectorAll<HTMLButtonElement>("li button")].find(b => b.textContent?.includes("Skill 599"))!;
    await act(async () => row.click());
    expect(container.querySelector('[aria-label="Read skill"]')?.textContent).toBe("library:planning-599");
    expect(fixture.api.mock.calls.every(([, init]) => !init)).toBe(true);
  });
}

for (const surface of ["templates", "new bot"] as const) it("FB2/FB3 DOM " + surface + ": a late page cannot replace a newer topic search", async () => {
  const app = mount(surface === "templates" ? h(TeamLibraryPanel, { initialView: "skills", onClose: () => {}, onImported: () => {}, returnFocusRef: { current: null } }) : h(SkillPicker, { botId: "new-bot", botName: "Sable", onDone: () => {} }));
  await flush();
  if (surface === "templates") {
    // MAIN RULING 2026-11-14 Skills v2 (Sean lock 11-13): templates = SkillsBrowser, 100-row Show more + cross-topic search; reachability and stale-response proofs kept
    const request = fixture.api.getMockImplementation()!;
    const old = await request("/api/library/skills?term=planning&offset=100&limit=100");
    let release!: (page: unknown) => void;
    fixture.api.mockImplementation((path: string) => {
      const url = new URL(path, "http://fixture");
      return url.pathname === "/api/library/skills" && url.searchParams.get("q") === "Skill" && url.searchParams.get("offset") === "100"
        ? new Promise(resolve => { release = resolve; }) : request(path);
    });
    typeTemplateSearch("Skill"); await flush();
    expect(templateRows()).toHaveLength(100);
    await click("Show more");
    expect(release).toBeTypeOf("function");
    typeTemplateSearch("Unique"); await flush();
    expect(templateRows()).toHaveLength(1);
    expect(document.body.textContent).toContain("Skill 599");
    const last = fixture.api.mock.calls.at(-1)![0];
    expect(last).toContain("q=Unique");
    expect(last).not.toContain("term=");
    await act(async () => release(old));
    await flush();
    expect(templateRows()).toHaveLength(1);
    expect(document.body.textContent).toContain("Skill 599");
    expect(document.body.textContent).not.toContain("Skill 100");
    expect(document.body.textContent).not.toContain("Skill 000");
    app.unmount();
    return;
  }
  const request = fixture.api.getMockImplementation()!;
  const old = await request("/api/skills?category=planning");
  let release!: (page: unknown) => void;
  fixture.api.mockImplementation((path: string) => new URL(path, "http://fixture").searchParams.get("q") === "slow" ? new Promise(resolve => { release = resolve; }) : request(path));
  type("slow"); await flush();
  // The old response lands during the new query's debounce window.
  type("Unique");
  await act(async () => release(old));
  expect(document.body.textContent).not.toContain("Skill 000");
  await flush();
  const last = fixture.api.mock.calls.at(-1)![0];
  expect(last).toContain("q=Unique");
  app.unmount();
});

it("FB3 DOM: a failed later page has a retry and never shows the previous page as current", async () => {
  const app = mount(h(SkillPicker, { botId: "new-bot", botName: "Sable", onDone: () => {} }));
  await flush();
  const select = app.container.querySelector("select")!;
  await act(async () => { select.value = "planning"; select.dispatchEvent(new Event("change", { bubbles: true })); }); await flush();
  fixture.api.mockRejectedValueOnce(new Error("Skills couldn't be loaded."));
  await click("Next page");
  expect(app.container.querySelector('[role="alert"]')?.textContent).toContain("Skills couldn't be loaded.");
  expect(app.container.textContent).not.toContain("Skill 000");
  await click("Try again");
  expect(app.container.textContent).toContain("61–120 of 600 skills");
  expect(app.container.textContent).toContain("Skill 060");
});
