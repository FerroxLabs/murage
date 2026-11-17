// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bots, detail, reviewed } from "./skillDetail.fixture";
const mocks = vi.hoisted(() => ({ set: vi.fn(), acknowledged: vi.fn(), changed: vi.fn() }));
vi.mock("@/lib/skillsLibrary", () => ({ setSkillOnBot: mocks.set }));
vi.mock("@/lib/skills-api", async (load) => ({ ...await load<typeof import("@/lib/skills-api")>(), setSkillForBot: mocks.acknowledged }));
import { BotsPicker, type BotsPickerProps } from "./BotsPicker";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text)!;
const click = async (text: string) => { expect(button(text), text).toBeTruthy(); await act(async () => button(text).click()); };
const mount = async (props: Partial<BotsPickerProps> = {}) => {
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root.render(createElement(BotsPicker, { skillId: "library:testing", skill: detail(), bots, onChanged: mocks.changed, ...props })));
};
beforeEach(() => {
  vi.clearAllMocks(); mocks.set.mockResolvedValue({}); mocks.acknowledged.mockResolvedValue({});
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
});
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("the library bot picker", () => {
  it("keeps a newly installed copy checked and reports a failure to switch off its original", async () => {
    mocks.set.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Could not switch off"));
    await mount({ skillId: "collection:testing-copy", originalSkillId: "library:testing" });
    await click("Add or remove bots"); await click("Add to Builder");
    expect(mocks.set.mock.calls).toEqual([["collection:testing-copy", "builder", true], ["library:testing", "builder", false]]);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Remove from Builder"]')?.checked).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("the original couldn’t be switched off");
    expect(mocks.changed).toHaveBeenCalledOnce();
  });
  it("holds the original until the owner acknowledges the copy's displayed scan", async () => {
    await mount({ skillId: "collection:testing-copy", originalSkillId: "library:testing", skill: reviewed() });
    await click("Add or remove bots"); await click("Add to Builder");
    expect(mocks.set).not.toHaveBeenCalled(); expect(mocks.acknowledged).not.toHaveBeenCalled();
    await click("Use it anyway");
    expect(mocks.acknowledged).toHaveBeenCalledWith("collection:testing-copy", "builder", true, "b".repeat(64));
    expect(mocks.set).toHaveBeenCalledWith("library:testing", "builder", false);
    expect(mocks.acknowledged.mock.invocationCallOrder[0]).toBeLessThan(mocks.set.mock.invocationCallOrder[0]);
  });
  it("opens with labelled, checked checkboxes and plain Add to / Remove from actions", async () => {
    await mount(); await click("Add or remove bots");
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Which bots should use this skill?");
    expect(document.querySelector<HTMLInputElement>('[aria-label="Add to Builder"]')?.checked).toBe(false);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Remove from Growth"]')?.checked).toBe(true);
    expect(button("Add to Builder")).toBeTruthy(); expect(button("Remove from Growth")).toBeTruthy();
    await click("Done"); expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("adds and removes with the contract client and refreshes after each successful PUT", async () => {
    await mount(); await click("Add or remove bots"); await click("Add to Builder");
    expect(mocks.set).toHaveBeenLastCalledWith("library:testing", "builder", true);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Remove from Builder"]')?.checked).toBe(true);
    await click("Remove from Builder"); expect(mocks.set).toHaveBeenLastCalledWith("library:testing", "builder", false);
    expect(mocks.changed).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Removed from Builder");
  });
  it("uses the same action when a checkbox is clicked", async () => {
    await mount(); await click("Add or remove bots");
    await act(async () => document.querySelector<HTMLInputElement>('[aria-label="Add to Builder"]')!.click());
    expect(mocks.set).toHaveBeenCalledWith("library:testing", "builder", true);
  });
  it("makes the bot name a clickable checkbox label", async () => {
    await mount(); await click("Add or remove bots");
    const label = [...document.querySelectorAll("label")].find((node) => node.textContent === "Builder")!;
    await act(async () => label.click()); expect(mocks.set).toHaveBeenCalledWith("library:testing", "builder", true);
  });
  it("refreshes the library when an already-sent change finishes after the picker unmounts", async () => {
    let resolve!: (value: unknown) => void; mocks.set.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await mount(); await click("Add or remove bots"); await click("Add to Builder");
    await act(async () => root.unmount()); await act(async () => resolve({})); expect(mocks.changed).toHaveBeenCalledOnce();
  });
  it("shows findings and requires an explicit acknowledgement of the displayed hash", async () => {
    await mount({ skill: reviewed() }); await click("Add or remove bots"); await click("Add to Builder");
    expect(mocks.set).not.toHaveBeenCalled(); expect(mocks.acknowledged).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Tells the bot to ignore its instructions");
    await click("Cancel"); expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await click("Add to Builder"); await click("Use it anyway");
    expect(mocks.acknowledged).toHaveBeenCalledWith("library:testing", "builder", true, "b".repeat(64));
    expect(mocks.changed).toHaveBeenCalledOnce();
  });
  it("reviews a newer server scan rather than silently retrying it", async () => {
    mocks.set.mockRejectedValueOnce(Object.assign(new Error("Needs a look"), { body: { code: "needs-review", scan: reviewed().scan } }));
    await mount(); await click("Add or remove bots"); await click("Add to Builder");
    expect(document.querySelector('[role="alertdialog"]')).toBeTruthy(); expect(mocks.changed).not.toHaveBeenCalled();
    await click("Use it anyway"); expect(mocks.acknowledged.mock.calls[0][3]).toBe("b".repeat(64));
  });
  it("keeps a failed change unchecked and lets the owner try it again", async () => {
    mocks.set.mockRejectedValueOnce(new Error("Owner approval is required"));
    await mount(); await click("Add or remove bots"); await click("Add to Builder");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Owner approval is required");
    expect(document.querySelector<HTMLInputElement>('[aria-label="Add to Builder"]')?.checked).toBe(false);
    expect(mocks.changed).not.toHaveBeenCalled(); await click("Add to Builder"); expect(mocks.changed).toHaveBeenCalledOnce();
  });
  it("prevents duplicate writes and dismissal while a change is pending", async () => {
    let resolve!: (value: unknown) => void; mocks.set.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await mount(); await click("Add or remove bots"); await click("Add to Builder");
    expect(button("Done").disabled).toBe(true); expect(button("Add to Builder").disabled).toBe(true);
    await click("Add to Builder"); expect(mocks.set).toHaveBeenCalledOnce();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    await act(async () => resolve({})); expect(button("Done").disabled).toBe(false);
  });
  it("does not enable blocked skills or unsupported engines, but permits removing an enabled skill", async () => {
    await mount({ skill: detail({ verdict: "blocked", bots: detail().bots.map((bot) => ({ ...bot, canUseSkills: false })) }) });
    await click("Add or remove bots"); expect(button("Add to Builder").disabled).toBe(true);
    expect(button("Remove from Growth").disabled).toBe(false); expect(document.body.textContent).toContain("can't be switched on");
    await click("Remove from Growth"); expect(mocks.set).toHaveBeenCalledWith("library:testing", "growth", false);
  });
  it("disables Add for an unsupported engine on a clean skill", async () => {
    await mount({ skill: detail({ bots: [{ botId: "builder", botName: "Builder", canUseSkills: false, enabled: false }] }) });
    await click("Add or remove bots"); expect(button("Add to Builder").disabled).toBe(true);
  });
  it("handles an empty workspace in both presentations", async () => {
    await mount({ bots: [] }); await click("Add or remove bots"); expect(document.body.textContent).toContain("You have no bots yet.");
    await act(async () => root.render(createElement(BotsPicker, { skillId: "x", skill: detail(), bots: [], onChanged: mocks.changed, view: "list" })));
    expect(document.body.textContent).toBe("You have no bots yet.");
  });
  it("exposes every bot beyond 200, including the last action", async () => {
    const many = Array.from({ length: 241 }, (_, index) => ({ id: `b${index}`, name: `Bot ${index}` }));
    await mount({ bots: many }); await click("Add or remove bots");
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(241);
    await click("Add to Bot 240"); expect(mocks.set).toHaveBeenCalledWith("library:testing", "b240", true);
  });
  it("supports Escape, outside dismissal, focus return, and visible focus styles", async () => {
    await mount(); button("Add or remove bots").focus(); await click("Add or remove bots");
    expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(button("Add or remove bots"));
    await click("Add or remove bots");
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close this menu"]')!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(button("Add or remove bots").className).toContain("focus-visible:outline");
  });
  it("lets the Bots tab change assignments with the same review flow", async () => {
    await mount({ view: "list", skill: reviewed() }); expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    await click("Add to Builder"); await click("Use it anyway"); expect(mocks.acknowledged).toHaveBeenCalledOnce();
    expect(button("Remove from Builder")).toBeTruthy();
  });
});
