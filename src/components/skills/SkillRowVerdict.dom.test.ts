// @vitest-environment jsdom
// G9 Krug review (MURAGE-UX-BAR section 4: status visible at a glance with a word, and it works at phone width): a skill
// that needs a look or is blocked says so on a phone too; only the quiet clean check gives way at narrow widths.
import { act } from "react";
import { createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount } from "../../testing/dom-harness";
import { SkillsSettings } from "./SkillsSettings";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), state: { bots: [], groups: [], instances: [] } }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }), useStoreIfAny: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
vi.mock("../LayerSlot", () => ({ useLayerContainer: () => {}, useLayerOwner: () => null }));

const skill = (id: string, verdict: string) => ({ id, ref: `own:${id}`, name: `Skill ${id}`, description: "Fixture", kind: "collection", verdict, usedBy: [{ botId: "b1", botName: "Ada", enabled: true }], source: "Yours" });
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  vi.useFakeTimers();
  fixture.api.mockImplementation(async (path: string) => {
    const url = new URL(path, "http://fixture");
    if (url.pathname === "/api/skills") return { yours: [{ ...skill("review", "review"), reason: "Pressures the bot not to say no" }, { ...skill("blocked", "blocked"), reason: "Reads passwords, keys or tokens" }, skill("clean", "clean"), skill("unexplained", "review")], library: [], categories: [], libraryReady: true, pagination: { offset: 0, limit: 60, total: 0 } };
    return {};
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

const rowFor = (name: string) => [...document.querySelectorAll("li")].find((li) => li.textContent?.includes(name))!;
const hiddenOnPhone = (el: Element | null) => { for (let at = el; at && at !== document.body; at = at.parentElement) if (at.classList.contains("hidden")) return true; return false; };

it("keeps a needs-a-look or blocked verdict word on a phone and lets only the clean check give way", async () => {
  mount(h(SkillsSettings));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  for (const name of ["Skill review", "Skill blocked"]) {
    const word = [...rowFor(name).querySelectorAll("span")].find((span) => span.querySelector("svg") && span.className.includes("font-medium"));
    expect(word, name).toBeTruthy();
    expect(hiddenOnPhone(word!), `${name}: verdict word hidden at phone width`).toBe(false);
  }
  const clean = rowFor("Skill clean").querySelector('[role="img"]');
  expect(clean).toBeTruthy();
  expect(hiddenOnPhone(clean)).toBe(true);
});

// polish-1021 (d2): "Needs a look" alone left the owner guessing. The row says what was found and what to do next.
it("says what a needs-a-look or blocked skill was flagged for and what to do, in the row", async () => {
  mount(h(SkillsSettings));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(rowFor("Skill review").textContent).toContain("Pressures the bot not to say no. Open it to read what was found, then decide.");
  expect(rowFor("Skill blocked").textContent).toContain("Reads passwords, keys or tokens. It can't be switched on.");
  expect(rowFor("Skill unexplained").textContent).toContain("Open it to read what was found, then decide.");
  expect(rowFor("Skill clean").textContent).not.toContain("Open it to read");
});
