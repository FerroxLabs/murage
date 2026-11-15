// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, press, settle } from "../../testing/dom-harness";
import { activeTrapCount } from "../../lib/focus-trap";
import { SkillsBrowser } from "./SkillsBrowser";

const mock = vi.hoisted(() => ({ fetchTopics: vi.fn(), fetchSkills: vi.fn(), detail: vi.fn() }));
vi.mock("@/lib/skillsLibrary", () => ({ fetchTopics: mock.fetchTopics, fetchSkills: mock.fetchSkills }));
vi.mock("./SkillDetailPane", () => ({ SkillDetailPane: (props: {skillId: string; compact: boolean; bots: {id: string; name: string}[]; onChanged(replacementId?: string): void}) => {
  mock.detail(props);
  return h("div", null, h("p", null, `Instructions for ${props.skillId}`), h("button", { onClick: () => props.onChanged() }, "Refresh skill"), h("button", { onClick: () => props.onChanged("collection:saved-copy") }, "Select saved copy"), h("button", { onClick: () => props.onChanged("library:original") }, "Select library original"));
} }));
type Skill = Awaited<ReturnType<typeof import("@/lib/skillsLibrary").fetchSkills>>["items"][number];
type Query = Parameters<typeof import("@/lib/skillsLibrary").fetchSkills>[0];
const topics = Array.from({ length: 141 }, (_, i) => ({ term: `topic-${i}`, label: `Topic ${String(i).padStart(3, "0")}`, count: 300 - i }));
let skills: Skill[];
let restore: () => void;
const bots = [{ id: "growth", name: "Growth" }, { id: "qa", name: "Web QA" }];
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); expect(activeTrapCount()).toBe(0); vi.restoreAllMocks(); });
beforeEach(() => {
  vi.clearAllMocks();
  skills = Array.from({ length: 237 }, (_, i) => ({ id: `skill-${i}`, name: `Skill ${String(i).padStart(3, "0")}`, description: `**Description** ${i}. Second sentence.`, topics: [`topic-${i % 141}`], bots: i === 0 ? [bots[0]] : i === 1 ? bots : [], mine: i === 2 }));
  mock.fetchTopics.mockImplementation(async () => ({ topics: [...topics].reverse(), totalSkills: skills.length }));
  mock.fetchSkills.mockImplementation(async ({ term, q, filter = "all", offset = 0, limit = 100 }: Query) => {
    const result = skills.filter(item => (!term || item.topics.includes(term)) && (!q || `${item.name} ${item.description}`.toLowerCase().includes(q.toLowerCase())) && (filter === "all" || (filter === "mine" ? item.mine : item.bots.length > 0)));
    return { items: result.slice(offset, offset + limit), total: result.length, offset };
  });
});
function render(compact = false) { return mount(h(SkillsBrowser, { compact, bots, onClose: vi.fn() })); }
function button(text: string, root: ParentNode = document) {
  const result = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(node => node.textContent?.trim() === text || node.getAttribute("aria-label") === text);
  expect(result, `button ${text}`).toBeTruthy(); return result!;
}
function topicButton(index: number) { return Array.from(document.querySelectorAll<HTMLButtonElement>('nav button')).find(node => node.textContent?.startsWith(topics[index].label))!; }
function input(label: string) { return Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(node => node.closest("label")?.textContent?.includes(label))!; }
async function type(label: string, value: string) {
  const field = input(label); expect(field).toBeTruthy();
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
}
async function click(node: HTMLElement) { act(() => node.click()); await settle(); }
function rows() { return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-skill-index]")); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

describe("Skills browser", () => {
  it.each([['Select saved copy', 'collection:saved-copy'], ['Select library original', 'library:original']])('keeps the replacement detail across filtered refreshes: %s', async (action, id) => {
    render(); await settle();
    await click(button(action));
    expect(document.body.textContent).toContain(`Instructions for ${id}`);
    await click(button('Refresh skill'));
    expect(document.body.textContent).toContain(`Instructions for ${id}`);
    await click(rows()[1]);
    await click(button('Refresh skill'));
    expect(document.body.textContent).toContain('Instructions for skill-1');
  });

  it("shows all 141 alphabetized topics, eight biggest topics, and the three library views", async () => {
    render(); await settle();
    const rail = document.querySelector('nav')!;
    expect(rail.textContent).toContain("Find a topic");
    expect(rail.textContent).toContain("All skills"); expect(rail.textContent).toContain("On your bots"); expect(rail.textContent).toContain("Your copies");
    expect(rail.textContent).toContain("Biggest topics"); expect(rail.textContent).toContain("All 141 topics, A to Z");
    const labels = Array.from(rail.querySelectorAll("button")).map(node => node.firstElementChild?.textContent);
    expect(labels.slice(3, 11)).toEqual(topics.slice(0, 8).map(item => item.label));
    expect(labels.slice(11)).toEqual(topics.map(item => item.label));
    expect(labels.at(-1)).toBe("Topic 140");
  });
  it("selects the first row and passes the exact detail seam props", async () => {
    render(); await settle();
    expect(rows()[0].getAttribute("aria-current")).toBe("true");
    expect(mock.detail).toHaveBeenLastCalledWith(expect.objectContaining({ skillId: "skill-0", bots, compact: false, onChanged: expect.any(Function) }));
    expect(rows()[0].textContent).toContain("Description 0. Second sentence.");
    expect(rows()[0].textContent).toContain("On Growth"); expect(rows()[1].textContent).toContain("On 2 bots"); expect(rows()[2].textContent).toContain("Your copy");
  });
  it("loads beyond 200 skills and reaches the final skill with no cap", async () => {
    render(); await settle(); expect(rows()).toHaveLength(100);
    await click(button("Show more")); expect(rows()).toHaveLength(200);
    await click(button("Show more")); expect(rows()).toHaveLength(237);
    expect(document.body.textContent).toContain("Skill 236");
    expect(Array.from(document.querySelectorAll("button")).some(node => node.textContent === "Show more")).toBe(false);
    expect(mock.fetchSkills).toHaveBeenCalledWith({ filter: "all", offset: 200, limit: 100 });
    await click(rows()[236]); expect(document.body.textContent).toContain("Instructions for skill-236");
  });
  it("keeps keyboard focus on the newly reached rows, including the final page", async () => {
    render(); await settle();
    button("Show more").focus(); await click(button("Show more"));
    expect(document.activeElement).toBe(rows()[100]); expect(rows()[100].getAttribute("aria-current")).toBe("true");
    button("Show more").focus(); await click(button("Show more"));
    expect(document.activeElement).toBe(rows()[200]); press("End");
    expect(document.activeElement).toBe(rows()[236]); expect(document.body.textContent).toContain("Instructions for skill-236");
  });
  it("pages search results past 200 just like topic browsing", async () => {
    render(); await settle(); await click(topicButton(140)); await type("Search all", "Description");
    await click(button("Show more")); await click(button("Show more"));
    expect(rows()).toHaveLength(237); expect(rows()[236].textContent).toContain("Skill 236");
    expect(mock.fetchSkills).toHaveBeenLastCalledWith({ q: "Description", filter: "all", offset: 200, limit: 100 });
  });
  it("can reach and select every topic, including the last alphabetic entry", async () => {
    render(); await settle();
    for (let i = 0; i < topics.length; i++) {
      await click(topicButton(i));
      expect(mock.fetchSkills).toHaveBeenCalledWith({ filter: "all", term: topics[i].term, offset: 0, limit: 100 });
      expect(rows().every(row => skills[Number(row.dataset.skillIndex) * 141 + i] !== undefined)).toBe(true);
    }
    expect(rows()[0].textContent).toContain("Skill 140");
  });
  it("finds a topic without hiding the rest behind a cap, and explains a miss", async () => {
    render(); await settle(); await type("Find a topic", " 140 ");
    expect(document.querySelectorAll('nav button')).toHaveLength(1);
    expect(topicButton(140)).toBeTruthy();
    await type("Find a topic", "no such topic");
    expect(document.querySelector('nav')!.textContent).toContain("No topic has that name. Try the skill search instead.");
    await type("Find a topic", ""); expect(document.querySelectorAll('nav button')).toHaveLength(152);
  });
  it("searches all topics even from a selected topic and restores browsing when cleared", async () => {
    render(); await settle(); await click(topicButton(140));
    await type("Search all", "Skill 001");
    expect(mock.fetchSkills).toHaveBeenLastCalledWith({ q: "Skill 001", filter: "all", offset: 0, limit: 100 });
    expect(rows()).toHaveLength(1); expect(rows()[0].textContent).toContain("Skill 001");
    expect(document.body.textContent).toContain("1 skill, all topics");
    expect(document.querySelector('nav [aria-current="true"]')).toBeNull();
    await click(button("Clear")); expect(rows()[0].textContent).toContain("Skill 140");
  });
  it("search also escapes On your bots and Your copies filters", async () => {
    render(); await settle();
    for (const label of ["On your bots", "Your copies"]) {
      const rail = document.querySelector('nav')!;
      await click(Array.from(rail.querySelectorAll<HTMLButtonElement>('button')).find(node => node.firstElementChild?.textContent === label)!);
      await type("Search all", "Skill 236"); expect(rows()[0].textContent).toContain("Skill 236");
      expect(mock.fetchSkills).toHaveBeenLastCalledWith({ q: "Skill 236", filter: "all", offset: 0, limit: 100 });
    }
  });
  it("filters by bot usage and copies using the API", async () => {
    render(); await settle();
    const rail = document.querySelector('nav')!;
    await click(Array.from(rail.querySelectorAll<HTMLButtonElement>('button')).find(node => node.firstElementChild?.textContent === "On your bots")!);
    expect(rows()).toHaveLength(2); expect(document.body.textContent).toContain("2 skills");
    await click(Array.from(rail.querySelectorAll<HTMLButtonElement>('button')).find(node => node.firstElementChild?.textContent === "Your copies")!);
    expect(rows()).toHaveLength(1); expect(rows()[0].textContent).toContain("Your copy");
    await type("Search all", "missing"); await click(topicButton(140));
    expect(input("Search all").value).toBe(""); expect(rows()[0].textContent).toContain("Skill 140");
  });
  it("explains an empty search and clears it with one button", async () => {
    render(); await settle(); await type("Search all", "missing");
    expect(rows()).toHaveLength(0); expect(document.body.textContent).toContain('Nothing matches “missing”');
    expect(document.body.textContent).toContain("Search looks at every skill in every topic. Try a shorter word.");
    expect(document.body.textContent).not.toContain("Instructions for skill-");
    await click(button("Clear search")); expect(rows()).toHaveLength(100);
  });
  it("does not blank the list on an unchanged topic or whitespace-only query edit", async () => {
    render(); await settle(); await click(topicButton(140)); await click(topicButton(140)); expect(rows()).toHaveLength(1);
    await type("Search all", "Skill 001"); await type("Search all", "Skill 001 "); expect(rows()).toHaveLength(1);
    await type("Search all", ""); await type("Search all", " "); expect(rows()).toHaveLength(1);
  });
  it("moves selection and focus with arrows, Home and End, and enters the detail pane", async () => {
    render(); await settle(); rows()[0].focus();
    press("ArrowDown"); expect(document.activeElement).toBe(rows()[1]); expect(rows()[1].getAttribute("aria-current")).toBe("true");
    press("End"); expect(document.activeElement).toBe(rows()[99]);
    press("ArrowDown"); expect(document.activeElement).toBe(rows()[99]);
    press("ArrowUp"); expect(document.activeElement).toBe(rows()[98]);
    press("Home"); expect(document.activeElement).toBe(rows()[0]);
    press("ArrowUp"); expect(document.activeElement).toBe(rows()[0]);
    expect(rows().filter(row => row.tabIndex === 0)).toHaveLength(1);
    expect(rows()[0].className).toContain("focus-visible:outline-focus");
    press("ArrowRight"); expect(document.activeElement).toBe(button("Refresh skill"));
  });
  it("keeps composition and modified arrow shortcuts untouched", async () => {
    render(); await settle(); rows()[0].focus();
    expect(press("ArrowDown", rows()[0], { isComposing: true }).defaultPrevented).toBe(false);
    expect(press("ArrowDown", rows()[0], { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(rows()[0]);
  });
  it("uses the same complete topic list in compact mode, trapping and returning focus", async () => {
    render(true); await settle(); expect(document.querySelector('nav')).toBeNull();
    const change = document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
    expect(change.textContent).toContain("Topic"); expect(change.textContent).toContain("Change");
    change.focus(); await click(change); expect(change.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(input("Find a topic")); expect(activeTrapCount()).toBe(1);
    const dialog = document.querySelector('nav[role="dialog"]')!; expect(dialog.getAttribute("aria-modal")).toBe("true");
    topicButton(140).focus(); press("Tab"); expect(document.activeElement).toBe(button("Close", dialog));
    await click(topicButton(140)); expect(document.querySelector('nav')).toBeNull(); expect(document.activeElement).toBe(change);
    expect(rows()[0].textContent).toContain("Skill 140");
    expect(mock.detail).toHaveBeenLastCalledWith(expect.objectContaining({ compact: true }));
    await click(change); await type("Find a topic", "140"); press("Escape"); await settle();
    expect(document.querySelector('nav')).toBeNull(); expect(document.activeElement).toBe(change);
    await click(change); expect(input("Find a topic").value).toBe(""); await click(button("Close this menu"));
    expect(document.querySelector('nav')).toBeNull(); expect(document.activeElement).toBe(change);
  });
  it("closes the compact picker with its Close button and switches layouts on resize", async () => {
    const app = render(true); await settle();
    await click(document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!); await click(button("Close"));
    expect(document.querySelector('nav')).toBeNull();
    await click(document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!);
    app.rerender(h(SkillsBrowser, { compact: false, bots, onClose: vi.fn() })); await settle();
    expect(document.querySelector('nav[role="dialog"]')).toBeNull(); expect(document.querySelector('nav')).toBeTruthy(); expect(activeTrapCount()).toBe(0);
    expect(document.querySelector('[aria-haspopup="dialog"]')).toBeNull();
  });
  it("refreshes edited rows and counts while retaining the selected page and skill", async () => {
    render(); await settle(); await click(button("Show more")); await click(button("Show more")); await click(rows()[236]);
    skills[236] = { ...skills[236], name: "Edited last skill", mine: true, bots: [bots[0]] };
    await click(button("Refresh skill"));
    expect(rows()).toHaveLength(237); expect(rows()[236].textContent).toContain("Edited last skill"); expect(rows()[236].textContent).toContain("Your copy");
    expect(rows()[236].getAttribute("aria-current")).toBe("true");
    expect(mock.fetchSkills).toHaveBeenCalledWith({ filter: "mine", offset: 0, limit: 1 });
    expect(mock.fetchTopics).toHaveBeenCalledTimes(2);
  });
  it("removes a changed skill from a filtered list when it no longer belongs", async () => {
    render(); await settle(); await click(Array.from(document.querySelectorAll<HTMLButtonElement>('nav button')).find(node => node.firstElementChild?.textContent === "Your copies")!);
    skills[2].mine = false; await click(button("Refresh skill"));
    expect(rows()).toHaveLength(0); expect(document.body.textContent).toContain("No skills here yet.");
  });
  it("retries failed topics without blocking the skill list", async () => {
    mock.fetchTopics.mockRejectedValueOnce(new Error("offline")); render(); await settle();
    expect(rows()).toHaveLength(100); expect(document.querySelector('nav [role="alert"]')!.textContent).toContain("Topics couldn’t load.");
    await click(button("Try again", document.querySelector('nav')!)); expect(document.querySelector('nav')!.textContent).toContain("All 141 topics, A to Z");
  });
  it("retries an initial skill failure", async () => {
    const original = mock.fetchSkills.getMockImplementation()!;
    mock.fetchSkills.mockImplementation((params: Query) => params.limit === 1 ? original(params) : Promise.reject(new Error("offline")));
    render(); await settle(); expect(document.querySelector('[role="alert"]')!.textContent).toContain("Skills couldn’t load.");
    mock.fetchSkills.mockImplementation(original); await click(button("Try again")); expect(rows()).toHaveLength(100);
  });
  it("retries a failed detail refresh while keeping the existing rows", async () => {
    render(); await settle(); const original = mock.fetchSkills.getMockImplementation()!;
    mock.fetchSkills.mockImplementation((params: Query) => params.limit === 1 ? original(params) : Promise.reject(new Error("offline")));
    await click(button("Refresh skill")); expect(rows()).toHaveLength(100);
    mock.fetchSkills.mockImplementation(original); skills[0].name = "Refreshed name";
    await click(button("Try again")); expect(rows()[0].textContent).toContain("Refreshed name");
  });
  it("retries a failed next page without losing or duplicating rows", async () => {
    render(); await settle(); mock.fetchSkills.mockRejectedValueOnce(new Error("offline")); await click(button("Show more"));
    expect(rows()).toHaveLength(100); expect(document.querySelector('[role="alert"]')!.textContent).toContain("More skills couldn’t load.");
    await click(button("Try again")); expect(rows()).toHaveLength(200);
    expect(new Set(rows().map(row => row.textContent)).size).toBe(200);
  });
  it("rejects an empty intermediate page instead of silently hiding remaining skills", async () => {
    render(); await settle(); mock.fetchSkills.mockResolvedValueOnce({ items: [], total: 237, offset: 100 }); await click(button("Show more"));
    expect(rows()).toHaveLength(100); expect(document.querySelector('[role="alert"]')).toBeTruthy();
    await click(button("Try again")); expect(rows()).toHaveLength(200);
  });
  it("ignores stale searches, including errors arriving after the latest results", async () => {
    render(); await settle();
    const old = deferred<{items: Skill[]; total: number; offset: number}>(); mock.fetchSkills.mockReturnValueOnce(old.promise);
    await type("Search all", "Skill 001"); await type("Search all", "Skill 236"); expect(rows()[0].textContent).toContain("Skill 236");
    await act(async () => old.reject(new Error("late failure"))); expect(rows()[0].textContent).toContain("Skill 236"); expect(document.querySelector('[role="alert"]')).toBeNull();
    const stale = deferred<{items: Skill[]; total: number; offset: number}>(); mock.fetchSkills.mockReturnValueOnce(stale.promise);
    await type("Search all", "Skill 001"); await type("Search all", "Skill 235");
    await act(async () => stale.resolve({ items: [skills[1]], total: 1, offset: 0 })); expect(rows()[0].textContent).toContain("Skill 235");
  });
  it("deduplicates paging requests and ignores an old page after a topic change", async () => {
    render(); await settle(); const next = deferred<{items: Skill[]; total: number; offset: number}>(); mock.fetchSkills.mockReturnValueOnce(next.promise);
    const more = button("Show more"); act(() => { more.click(); more.click(); }); await settle();
    expect(mock.fetchSkills.mock.calls.filter(([params]) => params.offset === 100)).toHaveLength(1);
    await click(topicButton(140)); await act(async () => next.resolve({ items: skills.slice(100, 200), total: 237, offset: 100 }));
    expect(rows()).toHaveLength(1); expect(rows()[0].textContent).toContain("Skill 140");
  });
  it("ignores pending results after unmount", async () => {
    const pending = deferred<{items: Skill[]; total: number; offset: number}>(); const original = mock.fetchSkills.getMockImplementation()!;
    mock.fetchSkills.mockImplementation((params: Query) => params.limit === 1 ? original(params) : pending.promise);
    const app = render(); app.unmount(); await act(async () => pending.resolve({items: skills.slice(0, 100), total: 237, offset: 0}));
    expect(document.querySelector('[data-skills-browser]')).toBeNull();
  });
});
