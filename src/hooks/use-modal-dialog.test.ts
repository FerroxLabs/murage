import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { modalKeyAction, tabReachable } from "./use-modal-dialog";

describe("modal dialog keys", () => {
  it("Escape closes from anywhere outside a field", () => {
    for (const position of ["first", "last", "middle", "outside", "empty"] as const) {
      expect(modalKeyAction("Escape", false, position)).toBe("close");
    }
  });
  it("Escape inside an input, textarea or editable field leaves the draft alone", () => {
    expect(modalKeyAction("Escape", false, "middle", { editable: true })).toBe("none");
    expect(modalKeyAction("Escape", false, "first", { editable: true, dirty: true })).toBe("none");
  });
  it("Escape with unsaved edits asks before closing", () => {
    expect(modalKeyAction("Escape", false, "middle", { dirty: true })).toBe("confirm-close");
    expect(modalKeyAction("Escape", false, "middle", { dirty: false })).toBe("close");
  });
  it("Tab wraps from the last control to the first", () => {
    expect(modalKeyAction("Tab", false, "last")).toBe("wrap-to-first");
    expect(modalKeyAction("Tab", false, "middle")).toBe("none");
  });
  it("Shift+Tab wraps from the first control to the last", () => {
    expect(modalKeyAction("Tab", true, "first")).toBe("wrap-to-last");
    expect(modalKeyAction("Tab", true, "middle")).toBe("none");
  });
  it("Tab with focus outside the controls pulls it back in", () => {
    expect(modalKeyAction("Tab", false, "outside")).toBe("wrap-to-first");
    expect(modalKeyAction("Tab", true, "empty")).toBe("wrap-to-first");
  });
  it("other keys are left alone", () => {
    expect(modalKeyAction("a", false, "first")).toBe("none");
  });
});

describe("which controls Tab can reach (upstream 9ee83332e)", () => {
  const el = (attrs: Record<string, string>, insideHiddenOrInert = false) => ({
    hasAttribute: (name: string) => name in attrs,
    getAttribute: (name: string) => attrs[name] ?? null,
    closest: (selector: string) => (selector === "[hidden], [inert]" && insideHiddenOrInert ? ({} as Element) : null),
  });
  it("reaches an ordinary control", () => {
    expect(tabReachable(el({}))).toBe(true);
  });
  it("skips a control inside a hidden or inert part of the dialog", () => {
    expect(tabReachable(el({}, true))).toBe(false);
  });
  it("skips a button or link taken out of the tab order", () => {
    expect(tabReachable(el({ tabindex: "-1" }))).toBe(false);
  });
  it("skips disabled and aria-hidden controls", () => {
    expect(tabReachable(el({ disabled: "" }))).toBe(false);
    expect(tabReachable(el({ "aria-hidden": "true" }))).toBe(false);
  });
});

describe("dialog focus follows what is drawn (U19 follow-ups)", () => {
  type Node = { hasAttribute: (n: string) => boolean; getAttribute: (n: string) => string | null; closest: () => null; parentElement: Node | null; style: { display: string; visibility: string } };
  const node = (style: Partial<Node["style"]> = {}, parentElement: Node | null = null): Node => ({
    hasAttribute: () => false, getAttribute: () => null, closest: () => null, parentElement,
    style: { display: "block", visibility: "visible", ...style },
  });
  const styleOf = (n: unknown) => (n as { style?: Node["style"] }).style ?? null;
  it("skips a control hidden by a style on it or on a parent, which the browser skips too", () => {
    expect(tabReachable(node({ display: "none" }), styleOf)).toBe(false);
    expect(tabReachable(node({}, node({ display: "none" }, node())), styleOf)).toBe(false);
    expect(tabReachable(node({ visibility: "hidden" }), styleOf)).toBe(false);
    expect(tabReachable(node({}, node({}, node())), styleOf)).toBe(true);
  });
  it("stops at the dialog: a parent it cannot style does not hide the control", () => {
    const outside = { hasAttribute: () => false, getAttribute: () => null, closest: () => null, parentElement: null };
    expect(tabReachable(node({}, outside as unknown as Node), styleOf)).toBe(true);
  });
  it("with one control, Shift+Tab and Tab both stay on it", () => {
    expect(modalKeyAction("Tab", true, "only")).toBe("wrap-to-first");
    expect(modalKeyAction("Tab", false, "only")).toBe("wrap-to-first");
  });
  it("the trap reads computed styles and names the one-control case", () => {
    const source = readFileSync(fileURLToPath(new URL("./use-modal-dialog.ts", import.meta.url)), "utf8");
    expect(source).toContain("filter((el) => tabReachable(el, styleOf))");
    expect(source).toContain('items.length === 1 && current === items[0] ? "only"');
  });
});
