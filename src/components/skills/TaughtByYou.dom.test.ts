// @vitest-environment jsdom
// W13 (TEACH-ENTRY 1.0.23 D6): Settings -> Skills -> Taught by you over a fake GET of three rows.
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../../testing/dom-harness";

const fixture = vi.hoisted(() => ({ api: vi.fn(), rows: [] as unknown[] }));
vi.mock("@/state/store", () => ({ api: fixture.api }));
const { TaughtByYou } = await import("./TaughtByYou");

const bots = [{ id: "dax", name: "Dax" }, { id: "ember", name: "Ember" }];
const THREE = [
  { id: "only-dax", name: "File receipts", description: "Files receipts.", bots: ["dax"], botNames: ["Dax"], missingBots: 0 },
  { id: "for-all", name: "Close month", description: "Closes the month.", botNames: [], missingBots: 0 },
  { id: "gone", name: "Old task", description: "Old.", bots: ["deleted-bot"], botNames: [], missingBots: 1 },
  { id: "damaged", damaged: true },
];
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  fixture.rows = THREE;
  fixture.api.mockReset().mockImplementation(async (_path: string, init?: { method?: string }) => (init?.method === "PATCH" ? { skills: fixture.rows } : { skills: fixture.rows }));
});
afterEach(() => cleanup());

const render = async () => { mount(h(TaughtByYou, { bots })); await settle(); await settle(); };
const row = (name: string) => [...document.querySelectorAll("li")].find((li) => li.textContent?.includes(name))!;
const saveButton = (li: Element) => [...li.querySelectorAll("button")].find((b) => b.textContent === "Save") as HTMLButtonElement;

describe("W13 Taught by you", () => {
  it("shows each row's scope words", async () => {
    await render();
    expect(document.body.textContent).toContain("Taught by you");
    expect(row("File receipts").textContent).toContain("Only Dax");
    expect(row("Close month").textContent).toContain("All your bots");
    expect(row("Old task").textContent).toContain("No bot can use it: its bot was deleted");
  });
  it("expanding a row, choosing All and Save sends PATCH {bots:null}; Save is disabled while unchanged", async () => {
    await render();
    await act(async () => { row("File receipts").querySelector("button")!.click(); });
    const li = row("File receipts");
    expect(saveButton(li).disabled).toBe(true);
    await act(async () => { li.querySelector<HTMLInputElement>('input[value="all"]')!.click(); });
    expect(saveButton(li).disabled).toBe(false);
    await act(async () => { saveButton(li).click(); });
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/skills/taught/only-dax", { method: "PATCH", body: JSON.stringify({ bots: null }) });
  });
  it("a damaged row has no change control", async () => {
    await render();
    const li = row("damaged");
    expect(li.textContent).toContain("This skill's file is damaged");
    expect(li.querySelector("button")).toBeNull();
  });
  it("no recordings, or no route (404): the group is absent", async () => {
    fixture.rows = [];
    await render();
    expect(document.body.textContent).not.toContain("Taught by you");
    cleanup();
    fixture.api.mockReset().mockRejectedValue(Object.assign(new Error("no such route"), { status: 404 }));
    await render();
    expect(document.body.textContent).not.toContain("Taught by you");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
