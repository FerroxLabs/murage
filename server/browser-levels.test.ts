// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { classifyFloor } from "./browser-floor.ts";
import type { FloorFacts } from "./browser-floor.ts";
import { classifyLevel } from "./browser-levels.ts";
import type { ApprovalMode, BrowserLevel, LevelFacts, LevelInput, SiteCategory } from "./browser-levels.ts";

const MODES: ApprovalMode[] = ["step", "task", "full"];
const CATEGORIES: SiteCategory[] = ["handover", "neverDefault", "askEveryStep", "normal"];

/** Build an input; the floor is computed from the facts exactly as the caller would. */
function mk(facts: LevelFacts, over: Partial<LevelInput> = {}): LevelInput {
  return {
    operation: facts.operation,
    key: facts.key,
    facts,
    floor: classifyFloor(facts).floor ? classifyFloor(facts) : null,
    category: "normal",
    mode: "task",
    routine: false,
    // The site is allowed for this task (site card answered) unless a test says otherwise.
    grants: { l1: true, l2: false },
    siteAllowedAlways: false,
    ...over,
  };
}

const click = (name: string, extra: Partial<LevelFacts> = {}): LevelFacts => ({ operation: "click", tag: "button", role: "button", name, ...extra });
const link = (name: string, extra: Partial<LevelFacts> = {}): LevelFacts => ({ operation: "click", tag: "a", role: "link", name, ...extra });
const typing = (name: string, extra: Partial<LevelFacts> = {}): LevelFacts => ({ operation: "type", tag: "input", type: "text", role: "textbox", name, ...extra });
const press = (key: string, extra: Partial<LevelFacts> = {}): LevelFacts => ({ operation: "press", key, tag: "input", type: "text", role: "textbox", name: "Search", ...extra });
const op = (operation: string, extra: Partial<LevelFacts> = {}): LevelFacts => ({ operation, ...extra });

type Row = [label: string, facts: LevelFacts, level: BrowserLevel];

function runRows(rows: Row[]) {
  for (const [label, facts, level] of rows) {
    const got = classifyLevel(mk(facts));
    expect(got.level, `${label} -> ${got.reason}`).toBe(level);
    expect(got.reason.length).toBeGreaterThan(0);
  }
}

describe("F3 levels by effect", () => {
  it("L1: reads, looking around, history, tabs", () => {
    runRows([
      ["snapshot", op("snapshot"), "L1"],
      ["read", op("read"), "L1"],
      ["screenshot", op("screenshot"), "L1"],
      ["status", op("status"), "L1"],
      ["tab_list", op("tab_list"), "L1"],
      ["get_text", op("get_text"), "L1"],
      ["get_url", op("get_url"), "L1"],
      ["is_visible", op("is_visible"), "L1"],
      ["scroll", op("scroll"), "L1"],
      ["scroll_into_view", op("scroll_into_view"), "L1"],
      ["hover", op("hover", { tag: "button", name: "Menu" }), "L1"],
      ["focus", op("focus", { tag: "input" }), "L1"],
      ["wait", op("wait"), "L1"],
      ["wait_for_text", op("wait_for_text"), "L1"],
      ["back", op("back"), "L1"],
      ["forward", op("forward"), "L1"],
      ["reload", op("reload"), "L1"],
      ["navigate", op("navigate", { navigationCarriesNovelData: false }), "L1"],
      ["tab_new", op("tab_new", { navigationCarriesNovelData: false }), "L1"],
      ["tab_switch", op("tab_switch"), "L1"],
      ["stop", op("stop"), "L1"],
      ["pause", op("pause"), "L1"],
    ]);
  });

  it("L1: free keys on a plain page element", () => {
    runRows([
      ["Tab on a button", press("Tab", { tag: "button", type: undefined, role: "button" }), "L1"],
      ["Shift+Tab on a link", press("Shift+Tab", { tag: "a", type: undefined, role: "link" }), "L1"],
      ["Tab in a single-line input", press("Tab"), "L1"],
      ["Escape", press("Escape"), "L1"],
      ["PageDown on the body", press("PageDown", { tag: "body", type: undefined, role: undefined, name: undefined }), "L1"],
      ["Home in a text input", press("Home"), "L1"],
      ["End in a textarea", press("End", { tag: "textarea", type: undefined }), "L1"],
      ["ArrowDown on a plain div", press("ArrowDown", { tag: "div", type: undefined, role: undefined }), "L1"],
    ]);
  });

  it("L2: type, fill, select, check, click on a plain control, alert", () => {
    runRows([
      ["type", typing("Search"), "L2"],
      ["fill", { ...typing("Name"), operation: "fill" }, "L2"],
      ["select", op("select", { tag: "select", role: "combobox", name: "Country" }), "L2"],
      ["check", op("check", { tag: "input", type: "checkbox", role: "checkbox", name: "Remember me" }), "L2"],
      ["uncheck", op("uncheck", { tag: "input", type: "checkbox", role: "checkbox", name: "Remember me" }), "L2"],
      ["click a button", click("Next"), "L2"],
      ["click a link", link("Pricing"), "L2"],
      ["click a tab", click("Details", { role: "tab" }), "L2"],
      ["accept an alert", op("dialog_accept", { dialog: { kind: "alert", text: "Saved" } }), "L2"],
      ["printable key in a field", press("a"), "L2"],
      ["Enter in a field with no submit", press("Enter", { submits: false }), "L2"],
      ["Space on a checkbox", press(" ", { tag: "input", type: "checkbox", role: "checkbox", name: "Remember me" }), "L2"],
      ["Space on a button that does not submit", press("Space", { tag: "button", type: "button", role: "button", name: "Menu", submits: false }), "L2"],
      ["Enter on a link", press("Enter", { tag: "a", type: undefined, role: "link", name: "Pricing" }), "L2"],
      ["ArrowDown on a radio", press("ArrowDown", { tag: "input", type: "radio", role: "radio", name: "Plan" }), "L2"],
      ["ArrowUp on a select", press("ArrowUp", { tag: "select", type: undefined, role: "combobox", name: "Country" }), "L2"],
      ["ArrowRight on a slider", press("ArrowRight", { tag: "div", type: undefined, role: "slider", name: "Volume" }), "L2"],
    ]);
  });

  it("L3: send, post, delete, buy and the other irreversible steps by name", () => {
    runRows([
      ["Send", click("Send"), "L3"],
      ["Send message", click("Send message"), "L3"],
      ["Post", click("Post"), "L3"],
      ["Publish", click("Publish"), "L3"],
      ["Reply", click("Reply"), "L3"],
      ["Comment", click("Comment"), "L3"],
      ["Share", click("Share"), "L3"],
      ["Invite", click("Invite"), "L3"],
      ["Delete", click("Delete"), "L3"],
      ["Remove", click("Remove"), "L3"],
      ["Cancel subscription", click("Cancel subscription"), "L3"],
      ["Add to cart", click("Add to cart"), "L3"],
      ["Proceed to checkout", click("Proceed to checkout"), "L3"],
      ["Buy", click("Buy"), "L3"],
      ["Spanish Enviar", click("Enviar mensaje"), "L3"],
      ["German Löschen", click("Löschen"), "L3"],
      ["French Supprimer", click("Supprimer"), "L3"],
      ["Chinese delete", click("删除"), "L3"],
      ["by aria-label", click("", { ariaLabel: "Delete forever" }), "L3"],
      ["by button value", { operation: "click", tag: "input", type: "button", role: "button", buttonValue: "Send" }, "L3"],
    ]);
  });

  it("L3: effects from facts, not names", () => {
    runRows([
      ["submits", click("Go", { submits: true }), "L3"],
      ["submit-type button with no submits fact", click("Go", { type: "submit", form: { method: "get" } }), "L3"],
      ["untyped button in a form", click("Go", { type: undefined, form: { method: "get" } }), "L3"],
      ["POST form submit", click("Go", { submits: true, form: { method: "POST" } }), "L3"],
      ["cross-origin form action", click("Go", { submits: true, pageOrigin: "https://a.example", form: { action: "https://b.example/x", method: "get" } }), "L3"],
      ["absolute action, unknown page origin", click("Go", { submits: true, form: { action: "https://b.example/x", method: "get" } }), "L3"],
      ["file upload", op("upload", { tag: "input", type: "file" }), "L3"],
      ["file_upload", op("file_upload", { tag: "input", type: "file" }), "L3"],
      ["download flag", link("Report", { download: true }), "L3"],
      ["download by name", link("Download PDF"), "L3"],
      ["accept confirm", op("dialog_accept", { dialog: { kind: "confirm", text: "Continue?" } }), "L3"],
      ["accept prompt", op("dialog_accept", { dialog: { kind: "prompt", text: "Name?" } }), "L3"],
      ["beforeunload with typed data, navigate", op("navigate", { discardsTypedData: true }), "L3"],
      ["beforeunload with typed data, reload", op("reload", { discardsTypedData: true }), "L3"],
      ["beforeunload with typed data, back", op("back", { discardsTypedData: true }), "L3"],
      ["beforeunload accept with typed data", op("dialog_accept", { dialog: { kind: "beforeunload", text: "" }, discardsTypedData: true }), "L3"],
      ["navigation carrying novel data", op("navigate", { navigationCarriesNovelData: true }), "L3"],
      ["Enter in a field with a default submit", press("Enter", { submits: true, form: { method: "get" } }), "L3"],
      ["Enter in a field, submit unknown, in a form", press("Enter", { form: { method: "get" } }), "L3"],
      ["Space on a submit button", press("Space", { tag: "button", type: "submit", role: "button", name: "Go", submits: true }), "L3"],
      ["typing that submits", typing("Search", { submits: true }), "L3"],
    ]);
  });

  it("L3: unknown effect", () => {
    runRows([
      ["unknown operation", op("frobnicate"), "L3"],
      ["cdp", op("cdp"), "L3"],
      ["drag", op("drag", { tag: "div" }), "L3"],
      ["click with no facts about the target", op("click"), "L3"],
      // Round 8 (SEC-01): failed facts on a click are the owner's, whatever the page called the control.
      ["click with failed facts", click("Next", { factsFailed: true }), "floor"],
      ["label with no resolved control", { operation: "click", tag: "label", name: "Newsletter" }, "L3"],
      ["printable key with nothing focused", press("c", { tag: "div", type: undefined, role: undefined, name: undefined }), "L3"],
      ["modified shortcut", press("Control+Enter"), "L3"],
      ["Meta+s", press("Meta+s"), "L3"],
    ]);
  });

  it("a label click is classified as its control", () => {
    const check = { tag: "input", type: "checkbox", role: "checkbox", name: "Remember me" } as const;
    expect(classifyLevel(mk({ operation: "click", tag: "label", name: "Remember me", labelControl: { ...check } })).level).toBe("L2");
    const submit = { tag: "button", type: "submit", role: "button", name: "Send", submits: true } as const;
    expect(classifyLevel(mk({ operation: "click", tag: "label", name: "Go", labelControl: { ...submit } })).level).toBe("L3");
    const fileControl = { tag: "input", type: "file", role: undefined, name: "Attach" } as const;
    expect(classifyLevel(mk({ operation: "click", tag: "label", name: "Attach", labelControl: { ...fileControl } })).level).toBe("L3");
  });

  it("a label whose control is a password field is floor", () => {
    const facts: LevelFacts = { operation: "type", tag: "input", type: "password", role: "textbox", name: "Password" };
    expect(classifyLevel(mk(facts)).level).toBe("floor");
  });
});

describe("L7 keys by effect", () => {
  it("Tab is L2 in a textarea, contenteditable, a non-native textbox or a code editor", () => {
    runRows([
      ["Tab in textarea", press("Tab", { tag: "textarea", type: undefined }), "L2"],
      ["Shift+Tab in textarea", press("Shift+Tab", { tag: "textarea", type: undefined }), "L2"],
      ["Tab in contenteditable", press("Tab", { tag: "div", type: undefined, role: undefined, contentEditable: true }), "L2"],
      ["Tab in role=textbox div", press("Tab", { tag: "div", type: undefined, role: "textbox" }), "L2"],
      ["Tab in a code editor", press("Tab", { tag: "div", type: undefined, role: undefined, codeEditor: true }), "L2"],
      ["Tab in a code editor by role", press("Tab", { tag: "div", type: undefined, role: "code" }), "L2"],
      ["tab lower-case", press("tab", { tag: "textarea", type: undefined }), "L2"],
    ]);
  });

  it("Tab stays L1 where it only moves focus", () => {
    runRows([
      ["Tab on a button", press("Tab", { tag: "button", type: undefined, role: "button" }), "L1"],
      ["Tab on a single-line input", press("Tab"), "L1"],
      ["Tab on a link", press("Tab", { tag: "a", type: undefined, role: "link" }), "L1"],
    ]);
  });

  it("Home, End, PageUp, PageDown are L2 on listbox, combobox, grid, menu, tree and SELECT", () => {
    const roles = ["listbox", "combobox", "grid", "menu", "tree"];
    for (const role of roles) {
      for (const key of ["Home", "End", "PageUp", "PageDown", "Page Up", "pagedown"]) {
        const got = classifyLevel(mk(press(key, { tag: "div", type: undefined, role })));
        expect(got.level, `${key} on ${role}`).toBe("L2");
      }
    }
    for (const key of ["Home", "End", "PageUp", "PageDown"]) {
      expect(classifyLevel(mk(press(key, { tag: "select", type: undefined, role: undefined }))).level, `${key} on SELECT`).toBe("L2");
      expect(classifyLevel(mk(press(key, { tag: "SELECT", type: undefined, role: "combobox" }))).level, `${key} on SELECT upper`).toBe("L2");
    }
  });

  it("paging keys stay L1 on the page and in text", () => {
    for (const key of ["Home", "End", "PageUp", "PageDown"]) {
      expect(classifyLevel(mk(press(key, { tag: "body", type: undefined, role: undefined, name: undefined }))).level).toBe("L1");
      expect(classifyLevel(mk(press(key))).level).toBe("L1");
    }
  });

  it("an L2 key still needs the L2 card in step mode and none under a task grant", () => {
    const facts = press("Tab", { tag: "textarea", type: undefined });
    expect(classifyLevel(mk(facts, { mode: "step" })).needsCard).toBe(true);
    expect(classifyLevel(mk(facts, { mode: "task" })).needsCard).toBe(true);
    expect(classifyLevel(mk(facts, { mode: "task", grants: { l1: true, l2: true } })).needsCard).toBe(false);
  });
});

describe("floor first (F7)", () => {
  const floorFacts: LevelFacts[] = [
    { operation: "type", tag: "input", type: "password", role: "textbox", name: "Password" },
    { operation: "click", tag: "input", type: "checkbox", role: "checkbox", name: "I agree to the Terms of Service" },
    { operation: "click", tag: "button", role: "button", name: "I'm not a robot" },
    { operation: "click", tag: "button", role: "button", name: "Place order" },
    { operation: "type", tag: "input", type: "text", role: "textbox", name: "Card number", autocomplete: "cc-number" },
  ];

  it("each floor fact is floor with no card, in every mode and category", () => {
    for (const facts of floorFacts) {
      expect(classifyFloor(facts).floor, JSON.stringify(facts)).not.toBeNull();
      for (const mode of MODES) {
        for (const category of CATEGORIES) {
          const got = classifyLevel(mk(facts, { mode, category }));
          expect(got.level).toBe("floor");
          expect(got.needsCard).toBe(false);
        }
      }
    }
  });

  it("a caller floor result alone is enough, whatever the facts say", () => {
    const got = classifyLevel(mk(click("Next"), { floor: { floor: "consent", reason: "x", rule: "r" } }));
    expect(got.level).toBe("floor");
    expect(got.needsCard).toBe(false);
  });

  it("floor in the facts wins even when the caller passes no floor", () => {
    const got = classifyLevel(mk(floorFacts[0]!, { floor: null }));
    expect(got.level).toBe("floor");
  });

  it("a missing or broken floor value is floor (unsure means floor)", () => {
    const base = mk(click("Next"));
    expect(classifyLevel({ ...base, floor: undefined as never }).level).toBe("floor");
    expect(classifyLevel({ ...base, facts: undefined as never }).level).toBe("floor");
    expect(classifyLevel(undefined as never).level).toBe("floor");
    expect(classifyLevel({ ...base, operation: 5 as never }).level).toBe("floor");
  });

  it("property: random mode x category x grants x routine x intent x checker with floor facts is always floor", () => {
    const rnd = prng(7);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)]!;
    for (let i = 0; i < 4000; i++) {
      const facts = pick(floorFacts);
      const got = classifyLevel(mk(facts, randomContext(pick, rnd)));
      expect(got.level).toBe("floor");
      expect(got.needsCard).toBe(false);
    }
  });

  it("property: checker block never leaves L2 or L3 without a card", () => {
    const rnd = prng(11);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)]!;
    const actions: LevelFacts[] = [click("Next"), typing("Search"), click("Send"), click("Delete"), press("Enter", { submits: true }), op("upload", { tag: "input", type: "file" })];
    for (let i = 0; i < 4000; i++) {
      const got = classifyLevel(mk(pick(actions), { ...randomContext(pick, rnd), checker: "block" }));
      if (got.level === "L2" || got.level === "L3") expect(got.needsCard).toBe(true);
    }
  });

  it("property: intent card or refuse and checker ask or block only tighten", () => {
    const rnd = prng(23);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)]!;
    const actions: LevelFacts[] = [op("snapshot"), click("Next"), typing("Search"), click("Send"), press("Enter", { submits: true }), press("Tab", { tag: "textarea", type: undefined })];
    for (let i = 0; i < 4000; i++) {
      const ctx = randomContext(pick, rnd);
      const facts = pick(actions);
      const loose = classifyLevel(mk(facts, { ...ctx, intent: "pass", checker: "allow" }));
      const tight = classifyLevel(mk(facts, { ...ctx, intent: pick(["pass", "card", "refuse"] as const), checker: pick(["allow", "ask", "block"] as const) }));
      expect(tight.level).toBe(loose.level);
      if (loose.needsCard) expect(tight.needsCard).toBe(true);
    }
  });

  it("property: the mode value alone never changes a floor outcome and never loosens L3 below full", () => {
    for (const category of CATEGORIES) {
      for (const mode of ["step", "task"] as const) {
        const got = classifyLevel(mk(click("Send"), { mode, category, grants: { l1: true, l2: true }, siteAllowedAlways: true, intent: "pass", checker: "allow" }));
        expect(got.level).toBe("L3");
        expect(got.needsCard).toBe(true);
      }
    }
  });
});

describe("modes table (spec 2.2)", () => {
  const L1 = op("snapshot");
  const L2 = typing("Search");
  const L3 = click("Send");

  it("L1 is free in every mode", () => {
    for (const mode of MODES) expect(classifyLevel(mk(L1, { mode })).needsCard).toBe(false);
  });

  it("L1 is free on an ask-every-step site", () => {
    for (const mode of MODES) expect(classifyLevel(mk(L1, { mode, category: "askEveryStep" })).needsCard).toBe(false);
  });

  it("step: L2 is a card per action even with a grant or Allow always", () => {
    const got = classifyLevel(mk(L2, { mode: "step", grants: { l1: true, l2: true }, siteAllowedAlways: true }));
    expect(got.level).toBe("L2");
    expect(got.needsCard).toBe(true);
  });

  it("step: L3 is a card per action", () => {
    expect(classifyLevel(mk(L3, { mode: "step", intent: "pass" })).needsCard).toBe(true);
  });

  it("task: the first L2 on a site needs the card", () => {
    expect(classifyLevel(mk(L2, { mode: "task" })).needsCard).toBe(true);
  });

  it("task: L2 is silent after the task grant", () => {
    expect(classifyLevel(mk(L2, { mode: "task", grants: { l1: true, l2: true } })).needsCard).toBe(false);
  });

  it("task: an L1 grant alone does not cover L2", () => {
    expect(classifyLevel(mk(L2, { mode: "task", grants: { l1: true, l2: false } })).needsCard).toBe(true);
  });

  it("task: Allow always gives the L2 grant at the start of the task", () => {
    expect(classifyLevel(mk(L2, { mode: "task", siteAllowedAlways: true })).needsCard).toBe(false);
  });

  it("task: L3 is a card per action, whatever the grants", () => {
    const got = classifyLevel(mk(L3, { mode: "task", grants: { l1: true, l2: true }, siteAllowedAlways: true, intent: "pass" }));
    expect(got.level).toBe("L3");
    expect(got.needsCard).toBe(true);
  });

  it("full: L2 and L3 need no card when the intent check passes", () => {
    expect(classifyLevel(mk(L2, { mode: "full", intent: "pass" })).needsCard).toBe(false);
    expect(classifyLevel(mk(L3, { mode: "full", intent: "pass", checker: "allow" })).needsCard).toBe(false);
  });

  it("full: an intent card, a refusal, a missing intent or a checker ask brings the card back", () => {
    for (const facts of [L2, L3]) {
      expect(classifyLevel(mk(facts, { mode: "full", intent: "card" })).needsCard).toBe(true);
      expect(classifyLevel(mk(facts, { mode: "full", intent: "refuse" })).needsCard).toBe(true);
      expect(classifyLevel(mk(facts, { mode: "full" })).needsCard).toBe(true);
      expect(classifyLevel(mk(facts, { mode: "full", intent: "pass", checker: "ask" })).needsCard).toBe(true);
      expect(classifyLevel(mk(facts, { mode: "full", intent: "pass", checker: "block" })).needsCard).toBe(true);
      expect(classifyLevel(mk(facts, { mode: "full", intent: "pass", checker: "allow" })).needsCard).toBe(false);
    }
  });

  it("ask-every-step sites: card for L2 and L3 in every mode, grants and Allow always notwithstanding", () => {
    for (const mode of MODES) {
      for (const facts of [L2, L3]) {
        const got = classifyLevel(mk(facts, { mode, category: "askEveryStep", grants: { l1: true, l2: true }, siteAllowedAlways: true, intent: "pass", checker: "allow" }));
        expect(got.needsCard, `${mode} ${facts.operation}`).toBe(true);
      }
    }
  });

  it("handover-only and never sites are never silently allowed", () => {
    for (const category of ["handover", "neverDefault"] as const) {
      for (const mode of MODES) {
        for (const facts of [L1, L2, L3]) {
          const got = classifyLevel(mk(facts, { mode, category, grants: { l1: true, l2: true }, siteAllowedAlways: true, intent: "pass", checker: "allow" }));
          expect(got.needsCard, `${category} ${mode}`).toBe(true);
        }
      }
    }
  });

  it("an unknown mode or category is treated as the strictest", () => {
    expect(classifyLevel(mk(L2, { mode: "bogus" as never, grants: { l1: true, l2: true }, siteAllowedAlways: true })).needsCard).toBe(true);
    expect(classifyLevel(mk(L2, { category: "bogus" as never, grants: { l1: true, l2: true }, siteAllowedAlways: true })).needsCard).toBe(true);
  });

  it("intent card and refuse, checker ask and block tighten an otherwise silent L2", () => {
    const silent = { mode: "task", grants: { l1: true, l2: true } } as const;
    expect(classifyLevel(mk(L2, { ...silent })).needsCard).toBe(false);
    expect(classifyLevel(mk(L2, { ...silent, intent: "card" })).needsCard).toBe(true);
    expect(classifyLevel(mk(L2, { ...silent, intent: "refuse" })).needsCard).toBe(true);
    expect(classifyLevel(mk(L2, { ...silent, checker: "ask" })).needsCard).toBe(true);
    expect(classifyLevel(mk(L2, { ...silent, checker: "block" })).needsCard).toBe(true);
    expect(classifyLevel(mk(L2, { ...silent, intent: "pass", checker: "allow" })).needsCard).toBe(false);
  });

  it("intent and checker are ignored for L1 reads", () => {
    expect(classifyLevel(mk(L1, { intent: "refuse", checker: "block" })).needsCard).toBe(false);
  });
});

describe("routine rules (spec 2.6)", () => {
  const L1 = op("snapshot");
  const L2 = typing("Search");
  const L3 = click("Send");

  it("a site that is not Allow always is skipped, at every level", () => {
    for (const facts of [L1, L2, L3]) {
      const got = classifyLevel(mk(facts, { routine: true, siteAllowedAlways: false }));
      expect(got.skip).toBe(true);
      expect(got.reason.startsWith("skip")).toBe(true);
      expect(got.needsCard).toBe(true);
    }
  });

  it("routine grants are never honoured", () => {
    const got = classifyLevel(mk(L2, { routine: true, siteAllowedAlways: false, grants: { l1: true, l2: true } }));
    expect(got.skip).toBe(true);
  });

  it("on an Allow-always site L1 and L2 run without a card in task mode", () => {
    expect(classifyLevel(mk(L1, { routine: true, siteAllowedAlways: true })).needsCard).toBe(false);
    const l2 = classifyLevel(mk(L2, { routine: true, siteAllowedAlways: true }));
    expect(l2.needsCard).toBe(false);
    expect(l2.skip).toBeFalsy();
  });

  it("on an Allow-always site L3 is a card", () => {
    const got = classifyLevel(mk(L3, { routine: true, siteAllowedAlways: true, intent: "pass" }));
    expect(got.needsCard).toBe(true);
    expect(got.skip).toBeFalsy();
  });

  it("step mode keeps asking in a routine", () => {
    expect(classifyLevel(mk(L2, { routine: true, siteAllowedAlways: true, mode: "step" })).needsCard).toBe(true);
  });

  it("ask-every-step sites: every L2 and L3 is a card in a routine, L1 needs Allow always", () => {
    expect(classifyLevel(mk(L2, { routine: true, siteAllowedAlways: true, category: "askEveryStep" })).needsCard).toBe(true);
    expect(classifyLevel(mk(L3, { routine: true, siteAllowedAlways: true, category: "askEveryStep", mode: "full", intent: "pass" })).needsCard).toBe(true);
    expect(classifyLevel(mk(L1, { routine: true, siteAllowedAlways: true, category: "askEveryStep" })).needsCard).toBe(false);
    expect(classifyLevel(mk(L1, { routine: true, siteAllowedAlways: false, category: "askEveryStep" })).skip).toBe(true);
  });

  it("full permissive in a routine: only on Allow-always sites, intent check still applies", () => {
    expect(classifyLevel(mk(L3, { routine: true, siteAllowedAlways: true, mode: "full", intent: "pass", checker: "allow" })).needsCard).toBe(false);
    expect(classifyLevel(mk(L3, { routine: true, siteAllowedAlways: true, mode: "full", intent: "card" })).needsCard).toBe(true);
    expect(classifyLevel(mk(L3, { routine: true, siteAllowedAlways: false, mode: "full", intent: "pass" })).skip).toBe(true);
  });

  it("floor in a routine is still floor", () => {
    const got = classifyLevel(mk({ operation: "type", tag: "input", type: "password", role: "textbox", name: "Password" }, { routine: true, siteAllowedAlways: false }));
    expect(got.level).toBe("floor");
    expect(got.needsCard).toBe(false);
    expect(got.skip).toBeFalsy();
  });
});

describe("Opus gate fixes", () => {
  const consentBox: LevelFacts = { operation: "press", tag: "input", type: "checkbox", role: "checkbox", name: "I agree to the Terms of Service" };
  const robot: LevelFacts = { operation: "press", tag: "button", role: "button", name: "I'm not a robot" };
  const placeOrder: LevelFacts = { operation: "press", tag: "button", role: "button", name: "Place order" };
  const allowed = { grants: { l1: true, l2: true }, mode: "task" } as const;

  it("H1: a key spelled in any accepted form reaches the floor (space on a consent checkbox)", () => {
    const input: LevelInput = { operation: "press", key: "space", facts: { operation: "press", tag: "input", type: "checkbox", name: "I agree to the Terms of Service" }, floor: null, mode: "task", category: "normal", routine: false, grants: { l1: true, l2: true }, siteAllowedAlways: false };
    expect(classifyLevel(input).level).toBe("floor");
  });

  it("F7 property: key variants on floor-named targets are always floor, whatever the context", () => {
    const variants = ["enter", "ENTER", "Return", "space", "Spacebar", "Shift+Space", "Shift+Enter", "NumpadEnter", "Ctrl+Enter", "ControlOrMeta+Enter", "Mod+Enter", "⌘+Enter"];
    const rnd = prng(31);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)]!;
    for (const key of variants) {
      for (const target of [consentBox, robot, placeOrder]) {
        const facts = { ...target, key };
        expect(classifyLevel({ ...mk(facts), floor: null }).level, `${key} on ${target.name}`).toBe("floor");
      }
    }
    for (let i = 0; i < 3000; i++) {
      const facts = { ...pick([consentBox, robot, placeOrder]), key: pick(variants) };
      const got = classifyLevel({ ...mk(facts, randomContext(pick, rnd)), floor: null });
      expect(got.level, `${facts.key} on ${facts.name}`).toBe("floor");
      expect(got.needsCard).toBe(false);
    }
  });

  it("H2: a label click is floor when its control is floor, even if the label alone is not", () => {
    const facts: LevelFacts = { operation: "click", tag: "label", text: "Yes", snippets: { after: "I accept the Privacy Policy" }, labelControl: { tag: "input", type: "checkbox" } };
    expect(classifyFloor(facts).floor).toBeNull();
    expect(classifyLevel({ ...mk(facts, allowed), floor: null }).level).toBe("floor");
  });

  it("H3: the floor and the level judge one action; a mismatch between input and facts is floor", () => {
    // Level would read a click; the floor would have looked at a snapshot.
    const mismatch: LevelInput = { ...mk({ operation: "snapshot", tag: "input", type: "checkbox", role: "checkbox", name: "I agree to the Terms of Service" }, allowed), operation: "click", floor: null };
    expect(classifyLevel(mismatch).level).toBe("floor");
    const keyMismatch: LevelInput = { ...mk(press("Tab"), allowed), key: "Enter" };
    expect(classifyLevel(keyMismatch).level).toBe("floor");
    expect(classifyLevel({ ...mk(press("Tab"), allowed), operation: "PRESS" }).level).toBe("L1");
  });

  it("M1: an intent refusal or a checker block is a refusal, before any mode rule", () => {
    const l2 = typing("Search");
    for (const mode of MODES) {
      for (const over of [{ intent: "refuse" }, { checker: "block" }] as const) {
        const got = classifyLevel(mk(l2, { mode, grants: { l1: true, l2: true }, siteAllowedAlways: true, ...over }));
        expect(got.refuse, `${mode} ${JSON.stringify(over)}`).toBe(true);
        expect(got.needsCard).toBe(true);
      }
    }
    expect(classifyLevel(mk(click("Send"), { mode: "step", intent: "refuse" })).refuse).toBe(true);
    expect(classifyLevel(mk(l2, { mode: "step", intent: "card" })).refuse).toBeFalsy();
  });

  it("M2: Enter in a text entry with no form is L3 unless the page says it does not submit", () => {
    runRows([
      ["input, no form", press("Enter"), "L3"],
      ["textarea, no form", press("Enter", { tag: "textarea", type: undefined }), "L3"],
      ["contenteditable, no form", press("Enter", { tag: "div", type: undefined, role: undefined, contentEditable: true, name: "Message" }), "L3"],
      ["role textbox, no form", press("Enter", { tag: "div", type: undefined, role: "textbox", name: "Message" }), "L3"],
      ["input, no form, submits false", press("Enter", { submits: false }), "L2"],
      ["textarea, no form, submits false", press("Enter", { tag: "textarea", type: undefined, submits: false }), "L2"],
    ]);
  });

  it("M3: any modifier other than Shift makes a shortcut (L3)", () => {
    for (const mod of ["ControlOrMeta", "Mod", "⌘", "CmdOrCtrl", "Win", "OS", "Super", "Hyper", "Fn", "AltGraph"]) {
      const got = classifyLevel(mk(press(`${mod}+a`), allowed));
      expect(got.level, mod).toBe("L3");
      expect(got.reason).toMatch(/shortcut/i);
    }
    expect(classifyLevel(mk(press("Shift+a"), allowed)).level).toBe("L2");
  });

  it("M4: novel data, typed-data loss and downloads raise clicks and keys to L3; navigation needs an explicit no", () => {
    runRows([
      ["link click with novel data", link("Results", { navigationCarriesNovelData: true }), "L3"],
      ["button click with novel data", click("Go on", { navigationCarriesNovelData: true }), "L3"],
      ["link click that discards typed data", link("Home", { discardsTypedData: true }), "L3"],
      ["Enter on a link with novel data", press("Enter", { tag: "a", type: undefined, role: "link", name: "Results", navigationCarriesNovelData: true }), "L3"],
      ["Enter on a download link", press("Enter", { tag: "a", type: undefined, role: "link", name: "Report", download: true }), "L3"],
      ["Enter on a link that discards typed data", press("Enter", { tag: "a", type: undefined, role: "link", name: "Home", discardsTypedData: true }), "L3"],
      ["Space on a download button", press(" ", { tag: "button", type: "button", role: "button", name: "Report", submits: false, download: true }), "L3"],
      ["navigate, novel data unknown", op("navigate"), "L3"],
      ["open, novel data unknown", op("open"), "L3"],
      ["tab_new, novel data unknown", op("tab_new"), "L3"],
      ["navigate, no novel data", op("navigate", { navigationCarriesNovelData: false }), "L1"],
      ["back, no fact needed", op("back"), "L1"],
      ["plain link click, unknown novel data", link("Pricing"), "L2"],
    ]);
  });

  it("M5: a new site needs the site card in step and task mode, at every level, and is allowed in full mode on a normal site", () => {
    const fresh = { grants: { l1: false, l2: false }, siteAllowedAlways: false } as const;
    for (const facts of [op("snapshot"), typing("Search"), click("Send")]) {
      for (const mode of ["step", "task"] as const) {
        const got = classifyLevel(mk(facts, { ...fresh, mode, intent: "pass", checker: "allow" }));
        expect(got.needsCard, `${mode} ${facts.operation}`).toBe(true);
        expect(got.siteCard).toBe(true);
      }
      const full = classifyLevel(mk(facts, { ...fresh, mode: "full", intent: "pass", checker: "allow" }));
      expect(full.siteCard, `full ${facts.operation}`).toBeFalsy();
      expect(full.needsCard).toBe(false);
      const restricted = classifyLevel(mk(facts, { ...fresh, mode: "full", category: "askEveryStep", intent: "pass", checker: "allow" }));
      expect(restricted.siteCard, `full askEveryStep ${facts.operation}`).toBe(true);
    }
    expect(classifyLevel(mk(op("snapshot"), { ...fresh, mode: "task", siteAllowedAlways: true })).needsCard).toBe(false);
    expect(classifyLevel(mk(op("snapshot"), { mode: "task", grants: { l1: true, l2: false } })).needsCard).toBe(false);
  });

  it("M6: typed text with a newline follows the Enter rule", () => {
    expect(classifyLevel({ ...mk(typing("Message"), allowed), textHasNewline: true }).level).toBe("L3");
    expect(classifyLevel({ ...mk({ ...typing("Message"), operation: "fill", form: { method: "get" } }, allowed), textHasNewline: true }).level).toBe("L3");
    expect(classifyLevel({ ...mk(typing("Notes", { submits: false }), allowed), textHasNewline: true }).level).toBe("L2");
    expect(classifyLevel({ ...mk(typing("Message"), allowed), textHasNewline: false }).level).toBe("L2");
  });

  it("Low: arrow keys change the value of number, date, time and range inputs and of listbox, combobox, slider, spinbutton", () => {
    runRows([
      ...["number", "date", "time", "range", "datetime-local", "month", "week"].map((type): Row => [`ArrowUp on input ${type}`, press("ArrowUp", { type, role: undefined }), "L2"]),
      ...["listbox", "combobox", "slider", "spinbutton"].map((role): Row => [`ArrowDown on ${role}`, press("ArrowDown", { tag: "div", type: undefined, role, name: "Choice" }), "L2"]),
    ]);
  });

  it("Low: accepting beforeunload is L3 unless the page is known to hold no typed data", () => {
    runRows([
      ["unknown", op("dialog_accept", { dialog: { kind: "beforeunload", text: "" } }), "L3"],
      ["known empty", op("dialog_accept", { dialog: { kind: "beforeunload", text: "" }, discardsTypedData: false }), "L2"],
    ]);
  });

  it("Low: a malformed floor value is floor", () => {
    const base = mk(click("Next"), allowed);
    for (const bad of ["consent", 1, true, [], {}, { floor: undefined }, { floor: 0 }]) {
      expect(classifyLevel({ ...base, floor: bad as never }).level, JSON.stringify(bad)).toBe("floor");
    }
  });

  it("Low: handover sites hand to the owner, never sites refuse; both are refusals", () => {
    const handover = classifyLevel(mk(op("snapshot"), { category: "handover" }));
    expect(handover.refuse).toBe(true);
    expect(handover.rule).toBe("category-handover");
    expect(handover.reason).toMatch(/owner/i);
    const never = classifyLevel(mk(op("snapshot"), { category: "neverDefault" }));
    expect(never.refuse).toBe(true);
    expect(never.rule).toBe("category-never");
  });

  it("Low: only known read tools are L1; unknown get_, is_ and wait_ names are L3", () => {
    runRows([
      ["get_text", op("get_text"), "L1"],
      ["get_url", op("get_url"), "L1"],
      ["is_visible", op("is_visible"), "L1"],
      ["wait_for_text", op("wait_for_text"), "L1"],
      ["wait_for_function", op("wait_for_function"), "L3"],
      ["get_cookies", op("get_cookies"), "L3"],
      ["is_anything", op("is_anything"), "L3"],
      ["wait_and_click", op("wait_and_click"), "L3"],
    ]);
  });

  it("Low: full mode L3 needs the checker to allow; a missing checker is a card", () => {
    const L3 = click("Send");
    expect(classifyLevel(mk(L3, { mode: "full", intent: "pass" })).needsCard).toBe(true);
    expect(classifyLevel(mk(L3, { mode: "full", intent: "pass", checker: "allow" })).needsCard).toBe(false);
    expect(classifyLevel(mk(typing("Search"), { mode: "full", intent: "pass" })).needsCard).toBe(false);
  });
});

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomContext(pick: <T>(items: readonly T[]) => T, rnd: () => number): Partial<LevelInput> {
  return {
    mode: pick(MODES),
    category: pick(CATEGORIES),
    routine: rnd() < 0.4,
    grants: { l1: rnd() < 0.5, l2: rnd() < 0.5 },
    siteAllowedAlways: rnd() < 0.5,
    intent: pick([undefined, "pass", "card", "refuse"] as const),
    checker: pick([undefined, "allow", "ask", "block"] as const),
  };
}

// Keep the FloorFacts import used for the LevelFacts compatibility check.
const _compatible: FloorFacts = { operation: "click" } satisfies LevelFacts;
void _compatible;

describe("Opus gate round 2: line-break keys", () => {
  const login = { tag: "input", type: "email", role: "textbox", name: "Email", form: { hasPasswordField: true } } as Partial<LevelFacts>;
  it.each(["\n", "\r", "\r\n"])("press %j in a login form's email field is floor", (key) => {
    const facts = { operation: "press", key, ...login } as LevelFacts;
    expect(classifyLevel(mk(facts, { floor: null })).level).toBe("floor");
  });
  it("another control or whitespace key is never a free Space", () => {
    for (const key of ["\u000b", " ", "\t\t"]) {
      const r = classifyLevel(mk(press(key), { floor: null }));
      expect(["L3", "floor"], JSON.stringify(key)).toContain(r.level);
    }
  });
});
