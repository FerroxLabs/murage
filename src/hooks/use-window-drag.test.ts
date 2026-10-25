import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { windowDragProps } from "./use-window-drag";

describe("window drag from a header", () => {
  it("marks the header on a Mac window only", () => {
    expect(windowDragProps(true)).toEqual({ "data-window-drag": "" });
    expect(windowDragProps(false)).toEqual({});
  });
  it("turns every kind of control inside a drag header back into a click target", () => {
    const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
    expect(css).toContain("[data-window-drag] { -webkit-app-region: drag; }");
    const rule = /\[data-window-drag\] :is\(([^)]*(?:\([^)]*\)[^)]*)*)\) \{ -webkit-app-region: no-drag; \}/.exec(css)?.[1] ?? "";
    for (const control of ["button", "a", "input", "select", "textarea", "summary", '[role="button"]', '[role="tab"]', '[role="menuitem"]']) {
      expect(rule, control).toContain(control);
    }
  });
});

describe("every view header carries the drag mark", () => {
  const read = (file: string) => readFileSync(fileURLToPath(new URL(`../components/${file}`, import.meta.url)), "utf8");
  it.each(["ChatHeader.tsx", "GroupView.tsx", "ComputerPanel.tsx", "InspectorPanel.tsx", "TeamMapPage.tsx", "NoEngines.tsx"])("%s", (file) => {
    expect(read(file)).toMatch(/useWindowDrag\(\)|WindowDragStrip/);
  });
});

import { isMacInset } from "./use-window-drag";
describe("isMacInset", () => {
  it("is false where there is no window (a node render)", () => {
    expect(isMacInset()).toBe(false);
  });
});

describe("overlays and handles never drag the window", () => {
  const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
  it("marks dialogs, menus and no-drag handles", () => {
    const rule = /\n(dialog, [^{]*)\{ -webkit-app-region: no-drag; \}/.exec(css)?.[1] ?? "";
    for (const part of ["dialog", '[role="dialog"]', '[aria-modal="true"]', '[role="menu"]', "[data-no-window-drag]"]) expect(rule).toContain(part);
  });
  it("keeps the Computer panel resize handle out of the drag region", () => {
    const panel = readFileSync(fileURLToPath(new URL("../components/ComputerPanel.tsx", import.meta.url)), "utf8");
    expect(panel).toMatch(/data-no-window-drag=""\s+className="absolute inset-y-0 left-0[^"]*cursor-col-resize/);
  });
});
