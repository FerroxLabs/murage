// @vitest-environment jsdom
import { act, createElement, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bots, detail, reviewed } from "./skillDetail.fixture";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), set: vi.fn(), revert: vi.fn(), save: vi.fn(), copy: vi.fn(), assign: vi.fn(), changed: vi.fn(), topics: vi.fn(), skills: vi.fn() }));
vi.mock("@/lib/skillsLibrary", () => ({ fetchSkill: mocks.fetch, setSkillOnBot: mocks.set, revertSkill: mocks.revert, fetchTopics: mocks.topics, fetchSkills: mocks.skills }));
vi.mock("@/lib/skills-api", async (load) => ({ ...await load<typeof import("@/lib/skills-api")>(), saveSkill: mocks.save, duplicateSkill: mocks.copy, setSkillForBot: mocks.assign }));
vi.mock("../editor/RichMarkdownEditor", () => ({ RichMarkdownEditor: (props: { value: string; ariaLabel: string; onChange(value: string): void }) => createElement("textarea", { "aria-label": props.ariaLabel, "data-rich-editor": true, defaultValue: props.value, onChange: (event: { target: { value: string } }) => props.onChange(event.target.value) }) }));
import { SkillsBrowser } from "./SkillsBrowser";
import { useFocusTrap } from "@/lib/focus-trap";
import { SkillDetailPane, type SkillDetailPaneProps } from "./SkillDetailPane";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
let props: SkillDetailPaneProps;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text)!;
const click = async (text: string) => { expect(button(text), text).toBeTruthy(); await act(async () => button(text).click()); };
const input = async (node: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  expect(node).toBeTruthy();
  const prototype = node instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); });
};
const render = async (overrides: Partial<SkillDetailPaneProps> = {}) => {
  props = { ...props, ...overrides };
  await act(async () => root.render(createElement(SkillDetailPane, props)));
};
const mount = async (overrides: Partial<SkillDetailPaneProps> = {}) => {
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  props = { skillId: "library:testing", bots, compact: false, onChanged: mocks.changed }; await render(overrides);
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
  mocks.fetch.mockImplementation(async (id: string) => ({ ...detail(), ref: id, name: id === "library:other" ? "Another skill" : detail().name, mine: id.startsWith("collection:"), originalRef: id.startsWith("collection:") ? "library:testing" : undefined }));
  mocks.set.mockResolvedValue({});
  mocks.assign.mockResolvedValue({});
  mocks.revert.mockResolvedValue({ id: "library:testing", reverted: true, movedBots: bots });
  mocks.copy.mockResolvedValue({ skill: detail({ ref: "collection:testing-copy", kind: "collection" }) });
  mocks.save.mockResolvedValue({ skill: detail({ ref: "collection:testing-copy", kind: "collection" }), needsLook: [], failed: [] });
});
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("the skill detail pane", () => {

  // These are the existing parent's exits: Close on click, backdrop on
  // mousedown, a library tab that unmounts the skills view, and layer Escape.
  it.each(["Close library", "Teams", "Escape", "backdrop"])("guards parent dismissal through %s and resumes only after discard", async (exit) => {
    function Parent() {
      const [open, setOpen] = useState(true);
      const dialog = useRef<HTMLDivElement>(null);
      useFocusTrap(dialog, open, { name: "library-fixture", onEscape: () => setOpen(false) });
      return open ? createElement("div", { "data-backdrop": true, onMouseDown: (event) => { if (event.target === event.currentTarget) setOpen(false); } },
        createElement("div", { ref: dialog, role: "dialog", "aria-modal": true },
          createElement("button", { onClick: () => setOpen(false) }, "Close library"),
          createElement("button", { role: "tab", onClick: () => setOpen(false) }, "Teams"),
          createElement(SkillDetailPane, { skillId: "library:testing", bots, compact: false, onChanged: mocks.changed }))) : createElement("p", null, "Library closed");
    }
    const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
    await act(async () => root.render(createElement(Parent)));
    await click("Edit"); await input(document.querySelector<HTMLInputElement>("input")!, "Keep this draft");
    const leave = async () => act(async () => {
      if (exit === "Escape") document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      else if (exit === "backdrop") document.querySelector('[data-backdrop]')!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      else button(exit).click();
    });
    await leave();
    expect(document.querySelector('[role="alertdialog"]'), "parent must not unmount the draft").toBeTruthy();
    await click("Keep editing");
    expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("Keep this draft");
    await leave(); await click("Discard edits");
    expect(document.body.textContent).toBe("Library closed");
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([false, true])("H2 actual browser retains dirty drafts across Search and filter resets (compact=%s)", async (compact) => {
    mocks.topics.mockResolvedValue({ topics: [{ term: "testing", label: "Testing", count: 1 }], totalSkills: 1 });
    mocks.skills.mockImplementation(async (options: { q?: string; filter?: string }) => ({
      items: [{ id: options.q ? "library:other" : "library:testing", name: options.q ? "Another skill" : "A/B Testing Specialist", description: "Fixture skill", bots: [], topics: ["testing"], mine: false }], total: 1, offset: 0,
    }));
    const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
    await act(async () => root.render(createElement("div", { role: "dialog" }, createElement(SkillsBrowser, { bots, compact, onClose: vi.fn() }))));
    await click("Edit");
    const name = document.querySelector<HTMLInputElement>('[data-skill-editor] input')!;
    await input(name, "Keep this browser draft");
    const search = document.querySelector<HTMLInputElement>('input[placeholder^="Search all"]')!;
    const calls = mocks.skills.mock.calls.length;
    await input(search, "another");
    expect(document.querySelector('[role="alertdialog"]'), "Search must ask before resetting the selected dirty editor").toBeTruthy();
    expect(document.querySelector('[data-skill-editor] input')).toBe(name);
    expect(name.value).toBe("Keep this browser draft");
    expect(mocks.skills.mock.calls).toHaveLength(calls);
    await click("Keep editing");
    expect(search.value).toBe("");
    expect(name.value).toBe("Keep this browser draft");
    await input(search, "another"); await click("Discard edits");
    expect(search.value).toBe("another");
    expect(mocks.skills).toHaveBeenLastCalledWith(expect.objectContaining({ q: "another", filter: "all" }));
    expect(document.querySelector('[data-skill-editor] h2')?.textContent).toBe("Another skill");
    expect(mocks.save).not.toHaveBeenCalled();
    // Filter changes use the same browser-owned reset boundary.
    await click("Edit"); await input(document.querySelector<HTMLInputElement>('[data-skill-editor] input')!, "Another draft");
    if (compact) {
      // The containing library also guards opening its topic menu.
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-controls][aria-haspopup="dialog"]')!.click());
    } else {
      const filter = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.startsWith("Your copies"))!;
      await act(async () => filter.click());
    }
    expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
    await click("Keep editing");
    expect(document.querySelector<HTMLInputElement>('[data-skill-editor] input')?.value).toBe("Another draft");
  });
  it("uses the design's active bot status", async () => {
    await mount(); await click("Bots using it (1)");
    expect(document.body.textContent).toContain("Uses this skill");
    expect(document.body.textContent).not.toContain("Using this skill");
  });
  it("matches the actual API lane's explicit revert acknowledgement signature", async () => {
    const client = await vi.importActual<typeof import("@/lib/skillsLibrary")>("@/lib/skillsLibrary");
    const request = vi.fn().mockResolvedValue({ id: "library:testing", reverted: true, movedBots: [] });
    await client.revertSkill("collection:testing-copy", "b".repeat(64), request);
    expect(request).toHaveBeenCalledWith("/api/skills/collection%3Atesting-copy/revert", { method: "POST", body: JSON.stringify({ acknowledged: "b".repeat(64) }) });
  });
  it("moves existing bots onto a saved library copy before switching off their original", async () => {
    await mount(); await click("Edit"); await click("Save as my copy");
    expect(mocks.assign.mock.calls).toEqual([["collection:testing-copy", "growth", true], ["library:testing", "growth", false]]);
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.assign.mock.invocationCallOrder[0]);
    expect(mocks.assign).not.toHaveBeenCalledWith(expect.anything(), "builder", expect.anything());
  });
  it("keeps the original on and reports a refused copy assignment without acknowledging it", async () => {
    mocks.assign.mockRejectedValueOnce(Object.assign(new Error("Needs review"), { body: { code: "needs-review", scan: reviewed().scan } }));
    await mount(); await click("Edit"); await click("Save as my copy");
    expect(mocks.assign.mock.calls).toEqual([["collection:testing-copy", "growth", true]]);
    expect(document.body.textContent).toContain("Growth still uses the original");
    expect(document.body.textContent).not.toContain("Your bots use it in place of the library original.");
  });
  it("finishes copy migration only after the owner explicitly reviews a refused assignment", async () => {
    mocks.assign.mockRejectedValueOnce(Object.assign(new Error("Needs review"), { body: { code: "needs-review", scan: reviewed().scan } }));
    mocks.fetch.mockImplementation(async (id: string) => id.startsWith("collection:") ? { ...reviewed(), ref: id, kind: "collection", mine: true, source: "Copied from testing", bots: [] } : detail());
    await mount(); await click("Edit"); await click("Save as my copy");
    expect(document.body.textContent).toContain("Growth still uses the original");
    await click("Add or remove bots"); await click("Add to Growth");
    expect(mocks.set).not.toHaveBeenCalled();
    await click("Use it anyway");
    expect(mocks.assign).toHaveBeenLastCalledWith("collection:testing-copy", "growth", true, "b".repeat(64));
    expect(mocks.set).toHaveBeenCalledWith("library:testing", "growth", false);
  });
  it("respects assignments already migrated by the API, including bots awaiting review", async () => {
    mocks.save.mockResolvedValueOnce({ skill: detail({ ref: "collection:testing-copy", kind: "collection", verdict: "review", usedBy: [{ botId: "growth", botName: "Growth", enabled: false }] }), needsLook: ["Growth"], failed: [] });
    await mount(); await click("Edit"); await click("Save as my copy");
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Saved. Switched off on Growth until you confirm it.");
  });
  it("does not claim a blocked copy is being used by bots", async () => {
    mocks.save.mockResolvedValueOnce({ skill: detail({ ref: "collection:testing-copy", kind: "collection", verdict: "blocked", usedBy: [{ botId: "growth", botName: "Growth", enabled: false }] }), needsLook: [], failed: [] });
    await mount(); await click("Edit"); await click("Save as my copy");
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("It’s blocked by the skill check and can’t be used by bots.");
    expect(document.body.textContent).not.toContain("Your bots use it in place of the library original.");
  });
  it("shows both failed updates and bots awaiting review when a save has mixed results", async () => {
    mocks.save.mockResolvedValueOnce({ skill: detail({ ref: "collection:testing-copy", kind: "collection", verdict: "review", usedBy: [{ botId: "growth", botName: "Growth", enabled: false }] }), needsLook: ["Growth"], failed: ["Builder"] });
    await mount({ skillId: "collection:testing-copy" }); await click("Edit"); await click("Save");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t update Builder");
    expect(document.body.textContent).toContain("Switched off on Growth until you confirm it.");
  });
  it("preserves and displays nonempty failed bot updates from saving", async () => {
    mocks.save.mockResolvedValueOnce({ skill: detail({ ref: "collection:testing-copy", kind: "collection" }), needsLook: [], failed: ["Builder"] });
    await mount(); await click("Edit"); await click("Save as my copy");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t update Builder");
    expect(document.body.textContent).not.toContain("Saved. This is your copy. Your bots use it in place of the library original.");
  });
  it("reports when switching off the original fails after installing the copy", async () => {
    mocks.assign.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Could not switch off original"));
    await mount(); await click("Edit"); await click("Save as my copy");
    expect(mocks.assign.mock.calls).toHaveLength(2);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t update Growth");
  });
  it("limits the file-reading promise to available content and uses the design's file label", async () => {
    await mount(); await click("Files (2)");
    expect(document.body.textContent).not.toContain("Click a file to read it.");
    expect(document.body.textContent).toContain("Extra files are listed here; their contents aren’t available.");
    expect(document.body.textContent).toContain("The instructions the bot follows");
    const extra = document.querySelectorAll<HTMLButtonElement>('[role="tabpanel"] li button')[1];
    expect(extra.textContent).toContain("Details"); expect(extra.textContent).not.toContain("Read");
  });

  it("loads the selected skill, header, source and tab counts", async () => {
    await mount(); expect(mocks.fetch).toHaveBeenCalledWith("library:testing");
    expect(document.querySelector("h2")?.textContent).toBe("A/B Testing Specialist");
    expect(document.body.textContent).toContain("Design, run and read A/B tests.");
    expect(document.body.textContent).toContain("From the Murage library · 2 files · on 1 bot");
    expect(button("Files (2)")).toBeTruthy(); expect(button("Bots using it (1)")).toBeTruthy();
    expect(button("Instructions").getAttribute("aria-selected")).toBe("true");
  });
  it("renders full Markdown via the shared reader, beyond its Settings preview limit", async () => {
    const text = "---\nname: hidden-header\n---\n# Complete instructions\n\n" + "A long paragraph. ".repeat(4000) + "\n\n**The very last instruction.**";
    mocks.fetch.mockResolvedValueOnce({ ...detail(), text }); await mount();
    expect(document.querySelector("article h1")?.textContent).toBe("Complete instructions");
    expect(document.querySelector("article strong")?.textContent).toBe("The very last instruction.");
    expect(document.querySelector("article")?.textContent).not.toContain("hidden-header");
    expect(button("Show all")).toBeUndefined(); expect(button("All skills")).toBeUndefined();
  });
  it("shows empty instructions and the no-bots summary in plain words", async () => {
    mocks.fetch.mockResolvedValueOnce(detail({ text: "", bots: [] })); await mount({ bots: [] });
    expect(document.body.textContent).toContain("This skill is empty."); expect(document.body.textContent).toContain("not on any bot yet");
    await click("Bots using it (0)"); expect(document.body.textContent).toContain("No bot uses this skill yet."); expect(document.body.textContent).toContain("You have no bots yet.");
  });
  it("shows loading, a failed read, and a working retry", async () => {
    let reject!: (reason: Error) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    await mount(); expect(document.querySelector('[role="status"]')?.textContent).toBe("Loading skill…");
    await act(async () => reject(new Error("The library is unavailable")));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("The library is unavailable");
    await click("Try again"); expect(document.querySelector("h2")?.textContent).toBe(detail().name);
  });
  it("never lets a slower old selection overwrite a newer one", async () => {
    let resolve!: (value: unknown) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await mount(); await render({ skillId: "library:other" });
    expect(document.querySelector("h2")?.textContent).toBe("Another skill");
    await act(async () => resolve(detail())); expect(document.querySelector("h2")?.textContent).toBe("Another skill");
  });
  it("does not let a completed old bot change cancel the next skill's pending read", async () => {
    let mutation!: (value: unknown) => void; let read!: (value: unknown) => void;
    mocks.set.mockImplementationOnce(() => new Promise((done) => { mutation = done; }));
    await mount(); await click("Add or remove bots"); await click("Add to Builder");
    mocks.fetch.mockImplementationOnce(() => new Promise((done) => { read = done; }));
    await render({ skillId: "library:other" }); await act(async () => mutation({}));
    expect(mocks.changed).toHaveBeenCalledOnce(); expect(mocks.fetch).toHaveBeenCalledTimes(2);
    await act(async () => read(detail({ ref: "library:other", name: "Another skill" })));
    expect(document.querySelector("h2")?.textContent).toBe("Another skill");
  });
  it("switches tabs with arrows, Home and End, preserving one tab stop", async () => {
    await mount(); button("Instructions").focus();
    const key = async (value: string) => act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));
    await key("ArrowRight"); expect(document.activeElement).toBe(button("Files (2)"));
    expect(document.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe(button("Files (2)").id);
    await key("End"); expect(document.activeElement).toBe(button("Bots using it (1)"));
    await key("ArrowRight"); expect(document.activeElement).toBe(button("Instructions"));
    await key("ArrowLeft"); expect(document.activeElement).toBe(button("Bots using it (1)"));
    await key("Home"); expect(document.activeElement).toBe(button("Instructions"));
    expect([...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
  });
  it("lists enriched file metadata, opens and hides extra content, and reads SKILL.md", async () => {
    mocks.fetch.mockResolvedValueOnce({ ...detail(), files: [{ path: "SKILL.md", size: 4096 }, { path: "sample-size.md", size: 256, content: "# Sample sizes\n14,300 per variant" }] });
    await mount(); await click("Files (2)");
    const files = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tabpanel"] li button')];
    expect(files()[0].textContent).toContain("4 KB"); expect(files()[1].textContent).toContain("256 B");
    await act(async () => files()[1].click()); expect(document.querySelector('[aria-label="File contents"] pre')?.textContent).toContain("14,300 per variant");
    expect(files()[1].getAttribute("aria-expanded")).toBe("true");
    await act(async () => files()[1].click()); expect(document.querySelector('[aria-label="File contents"]')).toBeNull();
    await act(async () => files()[0].click()); expect(button("Instructions").getAttribute("aria-selected")).toBe("true"); expect(document.activeElement).toBe(button("Instructions"));
  });
  it("does not invent content when the API supplies only extra-file metadata", async () => {
    await mount(); await click("Files (2)");
    await act(async () => document.querySelectorAll<HTMLButtonElement>('[role="tabpanel"] li button')[1].click());
    expect(document.querySelector('[aria-label="File contents"]')?.textContent).toContain("Its contents aren’t available here.");
  });
  it("reaches the final file in a detail with more than 200 files", async () => {
    mocks.fetch.mockResolvedValueOnce({ ...detail(), files: Array.from({ length: 211 }, (_, i) => ({ path: `reference-${i}.md`, size: i, content: `File ${i}` })) });
    await mount(); await click("Files (211)");
    const entries = document.querySelectorAll<HTMLButtonElement>('[role="tabpanel"] li button'); expect(entries).toHaveLength(211);
    await act(async () => entries[210].click()); expect(document.querySelector('[aria-label="File contents"] pre')?.textContent).toBe("File 210");
  });
  it("accepts contract-shaped bot assignments and refreshes both counts after a change", async () => {
    const enriched = { ...detail(), bots: [{ id: "growth", name: "Growth" }], files: [{ path: "SKILL.md", size: 4096 }] };
    mocks.fetch.mockResolvedValueOnce(enriched).mockResolvedValueOnce({ ...enriched, bots });
    await mount(); await click("Bots using it (1)");
    expect(button("Add to Builder")).toBeTruthy(); expect(button("Remove from Growth")).toBeTruthy();
    await click("Add to Builder"); expect(mocks.set).toHaveBeenCalledWith("library:testing", "builder", true);
    expect(button("Bots using it (2)")).toBeTruthy(); expect(mocks.changed).toHaveBeenCalledOnce();
  });
  it("keeps an assigned bot controllable even if it is absent from the browser's bot list", async () => {
    await mount({ bots: [bots[0]] }); await click("Bots using it (1)"); expect(button("Remove from Growth")).toBeTruthy();
  });
  it("mounts SkillEditor with its rich editor, copy note and Save as my copy", async () => {
    await mount(); await click("Edit");
    expect(document.querySelector('[data-rich-editor]')).toBeTruthy(); expect(document.activeElement).toBe(document.querySelector("input"));
    expect(document.querySelector('[role="note"]')?.textContent).toContain("Library skills can’t be changed, so saving makes your own copy.");
    expect(button("Save as my copy")).toBeTruthy(); expect(mocks.copy).not.toHaveBeenCalled();
    await click("Cancel"); expect(document.querySelector('[role="alertdialog"]')).toBeNull(); expect(button("Edit")).toBeTruthy();
  });
  it("preserves the shared editor's plain-text fallback and guards unsaved fallback edits", async () => {
    mocks.fetch.mockResolvedValueOnce(detail({ text: "A line of instructions.\n".repeat(3000) }));
    await mount(); await click("Edit"); expect(document.querySelector('[data-rich-editor]')).toBeNull();
    const plain = document.querySelector<HTMLTextAreaElement>('[aria-labelledby="skill-editor-instructions"]')!;
    await input(plain, "# Plain instructions\n\nKeep every byte of this edit.");
    await click("Cancel"); expect(document.querySelector('[role="alertdialog"]')).toBeTruthy(); await click("Keep editing");
    await click("Save as my copy"); expect(mocks.save.mock.calls[0][1].body).toBe("# Plain instructions\n\nKeep every byte of this edit.");
  });
  it.each(["name", "description", "instructions"])("confirms before discarding changed %s", async (field) => {
    await mount(); await click("Edit");
    const node = field === "name" ? document.querySelector<HTMLInputElement>("input")! : field === "description" ? document.querySelector<HTMLTextAreaElement>("label textarea")! : document.querySelector<HTMLTextAreaElement>('[data-rich-editor]')!;
    await input(node, "Changed words"); await click("Back to the skill");
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Discard unsaved edits?");
    expect(document.activeElement).toBe(button("Keep editing"));
    await click("Keep editing"); expect(document.querySelector('[data-rich-editor]')).toBeTruthy();
    await click("Cancel"); await click("Discard edits"); expect(document.querySelector('[data-rich-editor]')).toBeNull(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("clears dirty state when all changed fields return to their original values", async () => {
    await mount(); await click("Edit"); const name = document.querySelector<HTMLInputElement>("input")!;
    await input(name, "Changed name"); await input(name, detail().name); await click("Cancel");
    expect(document.querySelector('[role="alertdialog"]')).toBeNull(); expect(button("Edit")).toBeTruthy();
  });
  it("keeps unsaved edits mounted when another skill is picked, until explicitly discarded", async () => {
    await mount(); await click("Edit"); await input(document.querySelector<HTMLInputElement>("input")!, "My draft name");
    await render({ skillId: "library:other" }); expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
    expect(mocks.fetch).not.toHaveBeenCalledWith("library:other"); await click("Keep editing");
    expect(document.querySelector<HTMLInputElement>("input")!.value).toBe("My draft name");
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await click("Cancel"); await click("Discard edits"); expect(document.querySelector("h2")?.textContent).toBe("Another skill");
  });
  it("switches away from an unchanged editor without a discard prompt", async () => {
    await mount(); await click("Edit"); await render({ skillId: "library:other" });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull(); expect(document.querySelector("h2")?.textContent).toBe("Another skill");
  });
  it("protects unsaved edits on window close and dismisses the confirmation with Escape", async () => {
    await mount(); await click("Edit"); await input(document.querySelector<HTMLInputElement>("input")!, "Draft");
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    await click("Cancel"); await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull(); expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("Draft");
  });
  it("copies only on save, saves the actual edited fields, then opens the saved copy", async () => {
    await mount(); await click("Edit"); await input(document.querySelector<HTMLInputElement>("input")!, "My testing skill");
    await input(document.querySelector<HTMLTextAreaElement>('[data-rich-editor]')!, "# Changed instructions");
    await click("Save as my copy");
    expect(mocks.copy).toHaveBeenCalledWith("library:testing");
    expect(mocks.save).toHaveBeenCalledWith("collection:testing-copy", { displayName: "My testing skill", description: detail().description, body: "# Changed instructions" });
    expect(mocks.fetch).toHaveBeenLastCalledWith("collection:testing-copy"); expect(mocks.changed).toHaveBeenCalledOnce();
    expect(button("Go back to the original")).toBeTruthy(); expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
  it("edits an existing copy in place with Save and no duplicate request", async () => {
    await mount({ skillId: "collection:testing-copy" }); await click("Edit");
    expect(document.querySelector('[role="note"]')?.textContent).toContain("You are editing your copy.");
    await click("Save"); expect(mocks.copy).not.toHaveBeenCalled(); expect(mocks.save.mock.calls[0][0]).toBe("collection:testing-copy");
  });
  it("keeps failed saves editable and retries the same copy without making duplicates", async () => {
    mocks.save.mockRejectedValueOnce(new Error("Could not save"));
    await mount(); await click("Edit"); await input(document.querySelector<HTMLInputElement>("input")!, "Unsaved name"); await click("Save as my copy");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Could not save");
    expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("Unsaved name"); expect(mocks.changed).not.toHaveBeenCalled();
    await click("Save as my copy"); expect(mocks.copy).toHaveBeenCalledOnce(); expect(mocks.save).toHaveBeenCalledTimes(2);
  });
  it("keeps a copy failure in the editor and validates an empty description before copying", async () => {
    mocks.copy.mockRejectedValueOnce(new Error("Could not copy"));
    await mount(); await click("Edit"); await click("Save as my copy");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Could not copy"); expect(mocks.save).not.toHaveBeenCalled();
    await input(document.querySelector<HTMLTextAreaElement>("label textarea")!, " "); await click("Save as my copy");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Say what this skill is for."); expect(mocks.copy).toHaveBeenCalledOnce();
  });
  it("restores the original with revertSkill and loads the returned original id", async () => {
    await mount({ skillId: "collection:testing-copy" }); await click("Go back to the original");
    expect(mocks.revert).toHaveBeenCalledWith("collection:testing-copy");
    expect(mocks.fetch).toHaveBeenLastCalledWith("library:testing"); expect(mocks.changed).toHaveBeenCalledOnce();
    expect(button("Go back to the original")).toBeUndefined(); expect(document.body.textContent).toContain("From the Murage library");
  });
  it("retains a copy when reverting fails and allows a retry", async () => {
    mocks.revert.mockRejectedValueOnce(new Error("The original is unavailable"));
    await mount({ skillId: "collection:testing-copy" }); await click("Go back to the original");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("The original is unavailable"); expect(button("Go back to the original")).toBeTruthy();
    expect(mocks.changed).not.toHaveBeenCalled(); await click("Go back to the original"); expect(mocks.changed).toHaveBeenCalledOnce();
  });
  it("requires acknowledgement before restoring an original with a new skill-check warning", async () => {
    mocks.revert.mockRejectedValueOnce(Object.assign(new Error("The original needs a look"), { body: { code: "needs-review", scan: reviewed().scan } }));
    await mount({ skillId: "collection:testing-copy" }); await click("Go back to the original");
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Tells the bot to ignore its instructions");
    expect(mocks.changed).not.toHaveBeenCalled(); await click("Cancel"); expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    mocks.revert.mockRejectedValueOnce(Object.assign(new Error("The original needs a look"), { body: { code: "needs-review", scan: reviewed().scan } }));
    await click("Go back to the original"); await click("Use it anyway");
    expect(mocks.revert).toHaveBeenLastCalledWith("collection:testing-copy", "b".repeat(64)); expect(mocks.changed).toHaveBeenCalledOnce();
  });
  it("does not offer a library revert for an imported skill without an original", async () => {
    mocks.fetch.mockResolvedValueOnce({ ...detail({ ref: "collection:imported", kind: "collection", source: "Imported from a zip" }), mine: true });
    await mount({ skillId: "collection:imported" }); expect(button("Go back to the original")).toBeUndefined();
    await click("Edit"); expect(button("Save")).toBeTruthy();
  });
  it("preserves a save warning for bots that need a new acknowledgement", async () => {
    mocks.save.mockResolvedValueOnce({ skill: detail({ ref: "collection:testing-copy", kind: "collection" }), needsLook: ["Growth"], failed: [] });
    await mount(); await click("Edit"); await click("Save as my copy");
    expect(document.body.textContent).toContain("Saved. Switched off on Growth until you confirm it.");
  });
  it("holds selection changes while saving and disables fields and duplicate submits", async () => {
    let resolve!: (value: unknown) => void;
    mocks.save.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await mount(); await click("Edit"); await input(document.querySelector<HTMLInputElement>("input")!, "Draft"); await click("Save as my copy");
    expect(document.querySelector<HTMLInputElement>("input")?.disabled).toBe(true); expect(button("Cancel").disabled).toBe(true);
    await render({ skillId: "library:other" }); expect(mocks.fetch).not.toHaveBeenCalledWith("library:other");
    await act(async () => resolve({ skill: detail({ ref: "collection:testing-copy", kind: "collection" }), needsLook: [] }));
    expect(document.querySelector("h2")?.textContent).toBe("Another skill"); expect(mocks.save).toHaveBeenCalledOnce();
  });
  it("prevents assignment changes and editing while a revert is pending", async () => {
    let resolve!: (value: unknown) => void;
    mocks.revert.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await mount({ skillId: "collection:testing-copy" }); await click("Go back to the original");
    expect(button("Edit").disabled).toBe(true); expect(button("Add or remove bots").disabled).toBe(true);
    await click("Bots using it (1)"); expect(button("Add to Builder").disabled).toBe(true); expect(button("Remove from Growth").disabled).toBe(true);
    await act(async () => resolve({ id: "library:testing", reverted: true, movedBots: bots }));
    expect(button("Edit").disabled).toBe(false);
  });
  it("uses compact spacing and an independently scrolling body and editor at a small window", async () => {
    await mount({ compact: true }); const pane = document.querySelector<HTMLElement>('[aria-label="Skill details"]')!;
    expect(pane.style.getPropertyValue("--skill-pad")).toBe("18px"); expect(pane.getAttribute("data-compact")).toBe("true");
    expect(document.querySelector('[role="tabpanel"]')?.className).toContain("min-h-0");
    await click("Edit"); expect(pane.getAttribute("data-editing")).toBe("true");
    expect(document.querySelector('[data-rich-editor]')?.closest(".overflow-y-auto")).toBeTruthy();
    expect(button("Save as my copy").closest(".overflow-y-auto")).toBeNull();
  });
});
