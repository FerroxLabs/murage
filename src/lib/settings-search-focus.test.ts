// Sean Q-C: Mod+K focuses Settings search while Settings is open; with Settings closed the palette opens as before.
import { describe, expect, it } from "vitest";
import { focusOpenSettingsSearch } from "./settings-search-focus";

const input = (over: Record<string, unknown> = {}) => {
  const state = { focused: false, selected: false };
  return { state, el: { isConnected: true, closest: () => null, focus: () => { state.focused = true; }, select: () => { state.selected = true; }, ...over } };
};

describe("Mod+K in Settings", () => {
  it("focuses and selects #settings-search when Settings is open", () => {
    const { state, el } = input();
    expect(focusOpenSettingsSearch({ getElementById: (id: string) => (id === "settings-search" ? el : null) } as never)).toBe(true);
    expect(state).toEqual({ focused: true, selected: true });
  });
  it("leaves the palette alone when Settings is closed or hidden", () => {
    expect(focusOpenSettingsSearch({ getElementById: () => null } as never)).toBe(false);
    const { state, el } = input({ closest: () => ({}) });
    expect(focusOpenSettingsSearch({ getElementById: () => el } as never)).toBe(false);
    expect(state.focused).toBe(false);
  });
  it("a document with no DOM lookup (a host test stub) means Settings is not open", () => {
    const answers: boolean[] = [];
    expect(() => { answers.push(focusOpenSettingsSearch({} as never), focusOpenSettingsSearch(undefined)); }).not.toThrow();
    expect(answers).toEqual([false, false]);
  });
});
