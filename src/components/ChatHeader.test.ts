// The header's folder chip names the folder a person would recognise. A
// Murage-made task folder is named by an id ("84b0ad57-0be6-…"), which told
// the person nothing, so the chip says Files and keeps the full location in
// its title and accessible name.
import { expect, it, vi } from "vitest";

Object.assign(globalThis, { window: (globalThis as { window?: unknown }).window ?? {} });
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {}, initAnalytics: () => {}, track: () => {} }));
const { workspaceChipLabel } = await import("./ChatHeader");

it("never shows a raw id as the folder's name", () => {
  expect(workspaceChipLabel({ path: "/Users/me/.murage/workspaces/b1/84b0ad57-0be6-4853-9c1e-5a3f0e7d2b11", origin: "task" })).toBe("Files");
  expect(workspaceChipLabel({ path: "C:\\Users\\Maus\\.murage\\workspaces\\84B0AD57-0BE6-4853-9C1E-5A3F0E7D2B11\\", origin: "bot" })).toBe("Files");
});

it("keeps a folder the person chose under its own name", () => {
  expect(workspaceChipLabel({ path: "/Users/me/projects/site/", origin: "task" })).toBe("site");
  expect(workspaceChipLabel({ path: "D:\\Work\\Q3 report", origin: "bot" })).toBe("Q3 report");
  expect(workspaceChipLabel({ origin: "default" })).toBe("Files");
});
