// @vitest-environment jsdom
// Settings v10 A9-skills: the Skills page over /api/skills/query and /api/skills/bulk.
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount } from "../../testing/dom-harness";
import { SkillsLibraryV10, CLAUDE_CODE_COPY_NOTE } from "./SkillsLibraryV10";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), state: { bots: [{ id: "b1", name: "Tess" }, { id: "b2", name: "Dax" }], groups: [], instances: [] } }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }), useStoreIfAny: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
vi.mock("../LayerSlot", () => ({ useLayerContainer: () => {}, useLayerOwner: () => null }));
vi.mock("./SkillReader", () => ({ SkillReader: ({ skillRef }: { skillRef: string }) => h("div", { "aria-label": "Read skill" }, skillRef) }));

const row = (i: number) => ({ ref: `library:skill-${String(i).padStart(3, "0")}`, name: `skill-${String(i).padStart(3, "0")}`, description: "Plan tasks", kind: "library", verdict: "clean", source: "Library", usedBy: [], category: "Writing", isNew: false });
const rows = Array.from({ length: 75 }, (_, i) => row(i));
const facets = [{ category: "Writing", count: 2247 }];
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  vi.useFakeTimers();
  fixture.api.mockImplementation(async (path: string) => {
    const url = new URL(path, "http://fixture");
    if (url.pathname === "/api/skills") return { yours: [], library: [], builtins: [{}, {}, {}, {}], categories: [], libraryReady: true };
    if (url.pathname === "/api/skills/query") {
      const rid = url.searchParams.get("rid") ?? "";
      if (url.searchParams.get("show") === "onBots") return { rid, rows: [], yours: [], total: 31, facets, next: null };
      if (url.searchParams.get("q") === "zebra") return { rid, rows: [], yours: [], total: 0, facets: [], next: null, widen: { all: 4 } };
      const yours = Array.from({ length: 11 }, (_, i) => ({ ...row(900 + i), kind: "collection", ref: `collection:mine-${i}`, name: `mine-${i}` }));
      return { rid, rows: rows.slice(0, 60), yours: url.searchParams.get("show") === "mine" || !url.searchParams.has("q") ? yours : [], total: 2247, facets, next: "cursor" };
    }
    throw new Error(`Unexpected request ${path}`);
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(250); }); }
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text) || b.getAttribute("aria-label") === text);
async function click(text: string) { const b = button(text); expect(b, text).toBeDefined(); await act(async () => { b!.click(); }); await flush(); }
async function check(label: string) { const box = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); expect(box, label).not.toBeNull(); await act(async () => { box!.click(); }); await flush(); }
function type(value: string) {
  const input = document.querySelector('input[aria-label="Search skills"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

it("A9: counts the tabs from the index, states the total, says what Claude Code copies do, and opens a row's own sheet", async () => {
  const app = mount(h(SkillsLibraryV10, { advanced: false })); await flush();
  const text = document.body.textContent ?? "";
  expect(text).toContain("All 2,262");
  expect(text).toContain("On a bot 31");
  expect(text).toContain("Yours 11");
  expect(text).toContain("2,258 skills · 4 built in");
  expect(text).toContain(CLAUDE_CODE_COPY_NOTE);
  expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  await click("skill-003");
  expect(document.querySelector('[aria-label="Read skill"]')?.textContent).toBe("library:skill-003");
  app.unmount?.();
});

it("A9: the header box selects exactly the first 60 rows shown and says so", async () => {
  mount(h(SkillsLibraryV10, { advanced: true })); await flush();
  const boxes = () => [...document.querySelectorAll<HTMLInputElement>('input[aria-label^="Select skill-"], input[aria-label^="Select mine-"]')];
  expect(boxes()).toHaveLength(71);
  await check("Select the first 60 shown");
  expect(document.body.textContent).toContain("60 selected");
  // the first 60 rows shown, in order; the 11 after them stay unticked and the label never claims them
  expect(boxes().map((box) => box.checked)).toEqual([...Array(60).fill(true), ...Array(11).fill(false)]);
});

it("A9: a bulk result says Saved, Not saved with the recorded reason, and Could not check; only the unknown one offers Try again with the same id", async () => {
  const pairs = [
    { skill: "library:skill-001", botId: "b1", botName: "Tess", state: "on" },
    { skill: "library:skill-001", botId: "b2", botName: "Dax", state: "refused", reason: "Dax already has 40 skills on." },
    { skill: "library:skill-002", botId: "b1", botName: "Tess", state: "unknown" },
  ];
  let sent: { opId: string } | null = null;
  const inner = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/skills/bulk") { sent = JSON.parse(String(init?.body)); return { op: { opId: sent!.opId, on: true, skills: ["library:skill-001"], target: { botIds: ["b1"] }, pairs } }; }
    return inner(path, init);
  });
  mount(h(SkillsLibraryV10, { advanced: true })); await flush();
  await check("Select skill-001");
  await check("Tess");
  await click("Apply to 1 bot");
  const firstId = sent!.opId;
  const lines = [...document.querySelectorAll("[data-pair-state]")].map((li) => [li.getAttribute("data-pair-state"), li.textContent]);
  expect(lines.map(([state]) => state)).toEqual(["Saved", "Not saved", "Could not check"]);
  expect(lines[1]![1]).toContain("Dax already has 40 skills on.");
  expect(lines[2]![1]).not.toContain("Dax already has");
  expect(button("Try again")).toBeDefined();
  expect(button("Undo")).toBeDefined();
  await click("Try again");
  expect(fixture.api.mock.calls.filter(([path]) => path === "/api/skills/bulk")).toHaveLength(2);
  const bulkBodies = fixture.api.mock.calls.filter(([path]) => path === "/api/skills/bulk").map(([, init]) => JSON.parse(String(init.body)));
  expect(bulkBodies[1]).toEqual(bulkBodies[0]);
  expect(bulkBodies[1].opId).toBe(firstId);
});

it("A9: a search with no match in this view offers the library-wide count, and an older answer never replaces a newer one", async () => {
  const slow: Array<() => void> = [];
  const inner = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation((path: string, init?: RequestInit) => {
    const url = new URL(path, "http://fixture");
    if (url.pathname === "/api/skills/query" && url.searchParams.get("q") === "old") return new Promise((resolve) => slow.push(() => resolve({ rid: url.searchParams.get("rid"), rows: [row(7)], yours: [], total: 1, facets, next: null })));
    return inner(path, init);
  });
  mount(h(SkillsLibraryV10, { advanced: false })); await flush();
  type("old"); await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  type("zebra"); await flush();
  expect(document.body.textContent).toContain("4 in the whole library");
  slow.forEach((release) => release()); await flush();
  expect(document.body.textContent).toContain("4 in the whole library");
  expect(document.body.textContent).not.toContain("skill-007");
});

it("A9: a lost reply is sent again as the same act (same id, same choices); an owner's browser refusal offers no retry", async () => {
  const inner = fixture.api.getMockImplementation()!;
  let calls = 0;
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/skills/bulk")) {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      if (calls === 1) throw new Error("network lost");
      if (calls === 2) return { op: { opId: body.opId, on: true, skills: body.skills, target: body.target, pairs: [{ skill: body.skills[0], botId: "b1", botName: "Tess", state: "on" }] } };
      throw Object.assign(new Error("Change several bots at once from the desktop app."), { body: { code: "bulk-needs-desktop" } });
    }
    return inner(path, init);
  });
  mount(h(SkillsLibraryV10, { advanced: true })); await flush();
  await check("Select skill-001"); await check("Tess");
  await click("Apply to 1 bot");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("network lost");
  await click("Try again");
  const bodies = fixture.api.mock.calls.filter(([path]) => path === "/api/skills/bulk").map(([, init]) => JSON.parse(String(init.body)));
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(document.querySelector("[data-pair-state]")?.getAttribute("data-pair-state")).toBe("Saved");
  await click("Undo");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("desktop app");
  expect(button("Try again")).toBeUndefined();
});

it("A9: Try again after a failed Undo, and after an Undo that left a pair unknown, goes to the undo route with the same undo id", async () => {
  const inner = fixture.api.getMockImplementation()!;
  const seen: Array<{ path: string; body: { opId: string } }> = [];
  let origin = "";
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (!path.startsWith("/api/skills/bulk")) return inner(path, init);
    const body = JSON.parse(String(init?.body));
    seen.push({ path, body });
    const pair = (state: string) => ({ skill: "library:skill-001", botId: "b1", botName: "Tess", state });
    if (path === "/api/skills/bulk") origin = body.opId;
    if (path === "/api/skills/bulk") return { op: { opId: body.opId, on: true, skills: body.skills, target: body.target, pairs: [pair("on")] } };
    const undos = seen.filter((call) => call.path !== "/api/skills/bulk").length;
    if (undos === 1) throw new Error("network lost");
    if (undos === 2) return { op: { opId: body.opId, on: false, skills: ["library:skill-001"], target: {}, undoOf: origin, pairs: [pair("unknown")] } };
    return { op: { opId: body.opId, on: false, skills: ["library:skill-001"], target: {}, undoOf: origin, pairs: [pair("off")] } };
  });
  mount(h(SkillsLibraryV10, { advanced: true })); await flush();
  await check("Select skill-001"); await check("Tess");
  await click("Apply to 1 bot");
  await click("Undo");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("network lost");
  await click("Try again");
  expect(document.querySelector("[data-pair-state]")?.getAttribute("data-pair-state")).toBe("Could not check");
  await click("Try again");
  const undoCalls = seen.filter((call) => call.path !== "/api/skills/bulk");
  expect(undoCalls.map((call) => call.path)).toHaveLength(3);
  expect(new Set(undoCalls.map((call) => call.path)).size).toBe(1);
  expect(undoCalls[0]!.path).toMatch(/^\/api\/skills\/bulk\/.+\/undo$/);
  expect(new Set(undoCalls.map((call) => call.body.opId)).size).toBe(1);
  expect(seen.filter((call) => call.path === "/api/skills/bulk")).toHaveLength(1);
  expect(document.querySelector("[data-pair-state]")?.getAttribute("data-pair-state")).toBe("Saved");
});
