// B92 (upstream #2067): the sidebar edge drags to a width that is kept on this computer.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { clampSidebarWidth, loadSidebarWidth, saveSidebarWidth, SIDEBAR_WIDTH_KEY } from "./sidebar-preferences";

const memory = (seed: Record<string, string> = {}) => {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
};

describe("sidebar width", () => {
  it("stays between 240 and 480px and always leaves the chat 320px", () => {
    expect(clampSidebarWidth(100, 1600)).toBe(240);
    expect(clampSidebarWidth(900, 1600)).toBe(480);
    expect(clampSidebarWidth(333.6, 1600)).toBe(334);
    expect(clampSidebarWidth(460, 800)).toBe(460);
    expect(clampSidebarWidth(460, 700)).toBe(380);
    expect(clampSidebarWidth(460, 500)).toBe(240);
    expect(clampSidebarWidth(Number.NaN, 1600)).toBe(240);
  });

  it("is remembered, and forgetting it brings back the density's own width", () => {
    const store = memory();
    expect(loadSidebarWidth(store)).toBeNull();
    saveSidebarWidth(352, store);
    expect(store.data.get(SIDEBAR_WIDTH_KEY)).toBe("352");
    expect(loadSidebarWidth(store)).toBe(352);
    saveSidebarWidth(null, store);
    expect(loadSidebarWidth(store)).toBeNull();
  });

  it("ignores a stored value it did not write", () => {
    for (const raw of ["abc", "-300", "12.5", "9999", "100"]) expect(loadSidebarWidth(memory({ [SIDEBAR_WIDTH_KEY]: raw }))).toBeNull();
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(loadSidebarWidth(blocked)).toBeNull();
    expect(() => saveSidebarWidth(300, blocked)).not.toThrow();
  });

  it("puts a keyboard-reachable resize edge on the desktop sidebar, never the rail or the phone drawer", () => {
    const source = readFileSync(new URL("../components/Sidebar.tsx", import.meta.url), "utf8");
    expect(source).toContain("const resizable = !narrow && density !== \"icons\";");
    expect(source).toMatch(/role="separator"[\s\S]{0,200}aria-label="Resize sidebar"[\s\S]{0,400}tabIndex=\{0\}/);
    expect(source).toMatch(/onKeyDown=\{\(event\) => \{\s*if \(event\.key !== "ArrowLeft" && event\.key !== "ArrowRight"\) return;/);
  });
});
