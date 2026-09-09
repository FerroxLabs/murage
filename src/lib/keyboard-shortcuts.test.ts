import { expect, it } from "vitest";
import { SHORTCUT_GROUPS, filterShortcuts, shortcutKeys } from "./keyboard-shortcuts";
it("lists only the inspected bindings and qualifies context-dependent actions", () => {
  const items = SHORTCUT_GROUPS.flatMap(group => group.items);
  expect(items.map(item => item.id)).toEqual(["palette", "new-bot", "jump-bot", "find", "close", "send", "newline", "edit", "suggestion", "bulletin", "reorder"]);
  expect(new Set(items.map(item => item.id)).size).toBe(items.length); expect(items.every(item => item.context)).toBe(true);
  expect(items.some(item => item.keys.includes("?") || item.keys.includes("/"))).toBe(false);
});
it("renders real platform modifiers and searches actions, keys and context", () => {
  const palette = SHORTCUT_GROUPS[0]!.items[0]!;
  expect(shortcutKeys(palette, true)).toEqual(["⌘", "K"]); expect(shortcutKeys(palette, false)).toEqual(["Ctrl", "K"]);
  expect(filterShortcuts("command", true)[0]!.items.some(item => item.id === "palette")).toBe(true);
  expect(filterShortcuts("ctrl k", false)[0]!.items[0]!.id).toBe("palette");
  expect(filterShortcuts("empty composer", true)[0]!.items[0]!.id).toBe("edit"); expect(filterShortcuts("does-not-exist", false)).toEqual([]);
});
