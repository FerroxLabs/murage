import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SHORTCUT_GROUPS, filterShortcuts, modShortcut, shortcutKeys } from "./keyboard-shortcuts";
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

// A Windows tooltip read "Find in conversation (⌘F)". The label follows the
// machine: the Command glyphs on a Mac, Ctrl+ elsewhere.
it("labels a Mod shortcut for the machine it is on", () => {
  expect(modShortcut("F", { mac: true })).toBe("⌘F");
  expect(modShortcut("F", { mac: false })).toBe("Ctrl+F");
  expect(modShortcut("Z", { shift: true, mac: true })).toBe("⌘⇧Z");
  expect(modShortcut("Z", { shift: true, mac: false })).toBe("Ctrl+Shift+Z");
});

it("writes no Command glyph straight into a tooltip", () => {
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const file of ["../components/GroupView.tsx", "../components/ChatHeader.tsx", "../components/editor/RichMarkdownEditor.tsx"]) {
    const source = strip(readFileSync(new URL(file, import.meta.url), "utf8"));
    expect.soft(source, file).not.toMatch(/title=["{][^\n]*⌘/);
    expect.soft(source, file).not.toContain("chatHeader.findTitle");
    expect.soft(source, file).not.toContain("chatHeader.findShortcut");
  }
});
