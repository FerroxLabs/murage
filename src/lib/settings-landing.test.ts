// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SETTINGS-UX-1011 S4 and S5: a search lands on the control the card marks as its own, a closed fold around it opens,
// and no hits is never a bare "Nothing matches". designs/UX-L3A2-LANDING-1017.md: the landing never guesses.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LANDED_ATTRIBUTE, LANDED_MS, controlSelector, landOnSetting, landingControl, openFoldsAround, type LandingElement } from "./settings-landing";

interface Node extends LandingElement {
  children: Node[];
  attrs: Map<string, string>;
  focused: number;
  classes: Set<string>;
}

let focusedNode: Node | null = null;

function el(tagName: string, attrs: Record<string, string> = {}, children: Node[] = [], open?: boolean): Node {
  const node: Node = {
    tagName,
    parentElement: null,
    id: attrs.id,
    open,
    children,
    attrs: new Map(Object.entries(attrs)),
    focused: 0,
    classes: new Set(),
    hasAttribute: (name) => node.attrs.has(name),
    getAttribute: (name) => node.attrs.get(name) ?? null,
    setAttribute: (name, value) => { node.attrs.set(name, value); },
    removeAttribute: (name) => { node.attrs.delete(name); },
    focus: () => { node.focused += 1; focusedNode = node; },
    scrollIntoView: () => {},
    classList: { add: (...tokens) => tokens.forEach((token) => node.classes.add(token)), remove: (...tokens) => tokens.forEach((token) => node.classes.delete(token)) },
  };
  children.forEach((child) => { child.parentElement = node; });
  return node;
}

/** A document stand-in that answers only the one selector the landing may ask: [data-setting-control="<id>"]. */
function rootOf(top: Node) {
  const asked: string[] = [];
  return {
    asked,
    querySelectorAll(selector: string): Node[] {
      asked.push(selector);
      const match = /^\[data-setting-control="([\w-]+)"\]$/.exec(selector);
      if (!match) throw new Error(`unexpected selector ${selector}`);
      const out: Node[] = [];
      const walk = (from: Node) => { if (from.attrs.get("data-setting-control") === match[1]) out.push(from); from.children.forEach(walk); };
      walk(top);
      return out;
    },
  };
}

const deps = (top: Node, timers: Array<() => void> = []) => ({ root: rootOf(top), afterPaint: (run: () => void) => run(), later: (run: () => void) => { timers.push(run); }, activeElement: () => focusedNode });
const sw = (anchor?: string, attrs: Record<string, string> = {}) => el("BUTTON", { role: "switch", ...(anchor ? { "data-setting-control": anchor } : {}), ...attrs });

describe("a search lands on the card's marked control", () => {
  it("opens the folds, focuses the marked switch and marks the card for two seconds", () => {
    const toggle = sw("startup-heading");
    const row = el("DIV", { id: "startup-heading", tabindex: "-1" }, [el("H3"), el("P"), toggle]);
    const inner = el("DETAILS", {}, [el("SUMMARY"), row], false);
    const outer = el("DETAILS", {}, [el("SUMMARY"), inner], false);
    const top = el("SECTION", {}, [outer]);
    const timers: Array<() => void> = [];

    const landed = landOnSetting(row, deps(top, timers));

    expect(outer.open).toBe(true);
    expect(inner.open).toBe(true);
    expect(landed).toBe(toggle);
    expect(focusedNode).toBe(toggle);
    expect(row.focused).toBe(0);
    expect(row.hasAttribute(LANDED_ATTRIBUTE)).toBe(true);
    expect(row.classes.has("ring-2")).toBe(true);
    expect(LANDED_MS).toBe(2000);
    timers.forEach((run) => run());
    expect(row.hasAttribute(LANDED_ATTRIBUTE)).toBe(false);
    expect(row.classes.has("ring-2")).toBe(false);
  });

  it("opens a fold around the control itself, not only around the card", () => {
    const field = el("INPUT", { "data-setting-control": "memory-heading" });
    const fold = el("DETAILS", {}, [el("SUMMARY"), field], false);
    const heading = el("H3", { id: "memory-heading" });
    const top = el("SECTION", {}, [heading, fold]);
    expect(landOnSetting(heading, deps(top))).toBe(field);
    expect(fold.open).toBe(true);
  });

  it("opens only closed folds and reports how many", () => {
    const row = el("DIV");
    const open = el("DETAILS", {}, [row], true);
    const closed = el("DETAILS", {}, [open], false);
    el("DIV", {}, [closed]);
    expect(openFoldsAround(row)).toBe(1);
    expect(closed.open).toBe(true);
    expect(openFoldsAround(row)).toBe(0);
  });
});

describe("the landing never guesses", () => {
  it("asks for this card's mark and nothing else", () => {
    const top = el("SECTION", {}, [el("H3", { id: "local-models-heading" })]);
    const root = rootOf(top);
    landingControl(top.children[0], root);
    expect(root.asked).toEqual(['[data-setting-control="local-models-heading"]']);
    expect(controlSelector('x"] , *')).toBeNull();
  });

  it("Starter profiles lands on its own control, never on the next card's Use house rules switch", () => {
    const own = el("BUTTON", { "data-setting-control": "starter-profiles-heading" });
    const starter = el("DIV", { id: "starter-profiles-heading" }, [el("H3"), own]);
    const houseRules = el("DIV", {}, [el("H3", { id: "house-rules-heading" }), sw("house-rules-heading")]);
    const top = el("DIV", {}, [starter, houseRules]);
    expect(landingControl(starter, rootOf(top))).toBe(own);
    // With its mark missing it lands on the card, still never on the neighbour's switch.
    own.attrs.delete("data-setting-control");
    expect(landingControl(starter, rootOf(top))).toBe(starter);
  });

  it("takes a marked disclosure button (Memory import opens its own panel), ignoring unmarked controls first in line", () => {
    const heading = el("H3", { id: "memory-import-heading" });
    const opener = el("BUTTON", { "aria-expanded": "false", "data-setting-control": "memory-import-heading" });
    const panel = el("DIV", { hidden: "" }, [sw()]);
    const top = el("SECTION", {}, [el("DIV", {}, [sw(), heading]), opener, panel]);
    expect(landingControl(heading, rootOf(top))).toBe(opener);
  });

  it("lands on the card when its mark is disabled or hidden, never on another control", () => {
    const heading = el("H3", { id: "local-models-heading" });
    const disabled = el("BUTTON", { disabled: "", "data-setting-control": "local-models-heading" });
    const top = el("SECTION", {}, [heading, disabled, sw()]);
    expect(landingControl(heading, rootOf(top))).toBe(heading);
    disabled.attrs.delete("disabled");
    const hidden = el("DIV", { hidden: "" }, [disabled]);
    expect(landingControl(heading, rootOf(el("SECTION", {}, [heading, hidden, sw()])))).toBe(heading);
  });

  it("lands on the card when its mark sits in a disabled fieldset (Memory audience while saving)", () => {
    const heading = el("H3", { id: "memory-people-heading" });
    const select = el("SELECT", { "data-setting-control": "memory-people-heading" });
    const fieldset = el("FIELDSET", { disabled: "" }, [select]);
    const top = el("SECTION", {}, [heading, fieldset]);
    expect(landingControl(heading, rootOf(top))).toBe(heading);
    fieldset.attrs.delete("disabled");
    expect(landingControl(heading, rootOf(top))).toBe(select);
  });

  it("looks up the mark in the card's own document, not the global one", () => {
    const heading = el("H3", { id: "storage-heading" });
    const check = el("BUTTON", { "data-setting-control": "storage-heading" });
    const top = el("SECTION", {}, [heading, check]);
    const own = rootOf(top);
    heading.ownerDocument = { ...own, activeElement: null } as unknown as Document;
    const landed = landOnSetting(heading, { afterPaint: () => {}, later: () => {}, activeElement: () => null });
    expect(landed).toBe(check);
    expect(own.asked).toEqual(['[data-setting-control="storage-heading"]']);
  });

  it("two marks for one card never let DOM order decide: the card takes the landing", () => {
    const heading = el("H3", { id: "starter-profiles-heading" });
    const top = el("SECTION", {}, [heading, el("BUTTON", { "data-setting-control": "starter-profiles-heading" }), el("BUTTON", { "data-setting-control": "starter-profiles-heading" })]);
    expect(landingControl(heading, rootOf(top))).toBe(heading);
  });

  it("a read-only card that marks its anchor lands there, with no waiting", () => {
    const timers: Array<() => void> = [];
    const card = el("DIV", { id: "about-version-heading", "data-setting-control": "about-version-heading" });
    expect(landOnSetting(card, deps(el("SECTION", {}, [card]), timers))).toBe(card);
    expect(card.getAttribute("tabindex")).toBe("-1");
    expect(timers).toHaveLength(1); // only the ring's removal
  });

  it("moves focus to a mark that renders late (a lazy page), within the retry bound", () => {
    const timers: Array<() => void> = [];
    const row = el("DIV", { id: "memory-heading", tabindex: "-1" }, []);
    const top = el("SECTION", {}, [row]);
    expect(landOnSetting(row, deps(top, timers))).toBe(row);
    const late = sw("memory-heading");
    row.children.push(late); late.parentElement = row;
    timers.shift()!();
    expect(focusedNode).toBe(late);
  });

  it("stops waiting once the person moves focus", () => {
    const timers: Array<() => void> = [];
    const row = el("DIV", { id: "memory-heading", tabindex: "-1" }, []);
    const top = el("SECTION", {}, [row]);
    landOnSetting(row, deps(top, timers));
    const elsewhere = el("INPUT"); elsewhere.focus();
    const late = sw("memory-heading"); row.children.push(late); late.parentElement = row;
    timers.shift()!();
    expect(focusedNode).toBe(elsewhere);
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, path), "utf8");

describe("Settings uses the landing", () => {
  it("lands every opener (search result, deep link, palette) through landOnSetting", () => {
    const modal = read("../components/SettingsModal.tsx");
    const reveal = modal.slice(modal.indexOf("function revealAnchor"), modal.indexOf("/** Reopens the guided first run."));
    expect(reveal).toContain("landOnSetting(");
    expect(reveal).not.toContain("element.focus(");
  });

  it("shows Ask the Chief and the help when nothing matches, never a bare Nothing matches", () => {
    const results = read("../components/SettingsSearchResults.tsx");
    expect(results).not.toContain('t("settings.noMatch"');
    expect(results).toContain("<SettingsNoResults");
    // The live line says only the count, so it stays quiet while the words change and the count does not.
    expect(results.match(/role="status"/g)).toHaveLength(1);
    expect(results).toContain("askYourBot(query");
    expect(results).toContain("openHelp()");
    const ask = results.slice(results.indexOf("const ask = () =>"));
    expect(ask.indexOf("settingsDrafts.anyUnsaved()")).toBeLessThan(ask.indexOf('type: "toggleAppSettings", open: false'));
  });
});
