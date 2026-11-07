import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const hooks = vi.hoisted(() => ({ set: vi.fn(), dispatch: vi.fn(), effects: [] as Array<() => unknown> }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
  useRef: (value: unknown) => ({ current: value }),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useState: (value: unknown) => [value, hooks.set],
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { bots: [], groups: [] }, dispatch: hooks.dispatch }), api: vi.fn() }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));
vi.mock("@/lib/focus-message", () => ({ landOnSearchHit: vi.fn() }));

import { ChatFindBar } from "./ChatFindBar";
import { CommandPalette } from "./CommandPalette";
import { CommandPaletteHost } from "./CommandPaletteHost";

type Element = ReactElement<{ children?: unknown; onKeyDown?: (event: unknown) => void }>;
function inputIn(value: unknown): Element | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return value.map(inputIn).find(Boolean);
  const element = value as Element;
  return element.type === "input" ? element : inputIn(element.props?.children);
}

beforeEach(() => { vi.clearAllMocks(); hooks.effects.length = 0; });
afterEach(() => vi.unstubAllGlobals());

describe("IME candidate keys stay in search inputs", () => {
  it.each([CommandPaletteHost, CommandPalette])("ignores composing open chords before and after lazy loading", (Component) => {
    const listeners = new Map<string, (event: unknown) => void>();
    vi.stubGlobal("window", { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener), removeEventListener: vi.fn() });
    Component({});
    hooks.effects[0]();
    const onKey = listeners.get("keydown")!;
    for (const composition of [{ isComposing: true, keyCode: 75 }, { isComposing: false, keyCode: 229 }]) {
      const event = { key: "k", ctrlKey: true, ...composition, preventDefault: vi.fn() };
      onKey(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(hooks.set).not.toHaveBeenCalled();
    onKey({ key: "k", ctrlKey: true, isComposing: false, keyCode: 75, preventDefault: vi.fn() });
    expect(hooks.set).toHaveBeenCalledOnce();
  });
  for (const key of ["Enter", "Escape", "ArrowDown", "ArrowUp"]) {
    for (const nativeEvent of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
      it(`${key} with ${JSON.stringify(nativeEvent)} does not navigate or close`, () => {
        const close = vi.fn();
        const find = ChatFindBar({ threadId: "thread", onClose: close });
        const palette = CommandPalette({ initialOpen: true }) as Element;
        const event = { key, nativeEvent, preventDefault: vi.fn(), stopPropagation: vi.fn() };
        inputIn(find)!.props.onKeyDown!(event);
        palette.props.onKeyDown!(event);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        expect(hooks.set).not.toHaveBeenCalled();
        expect(hooks.dispatch).not.toHaveBeenCalled();
      });
    }
  }
  it("plain Escape still closes both surfaces", () => {
    const close = vi.fn();
    const event = { key: "Escape", nativeEvent: { isComposing: false, keyCode: 27 }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    inputIn(ChatFindBar({ threadId: "thread", onClose: close }))!.props.onKeyDown!(event);
    (CommandPalette({ initialOpen: true }) as Element).props.onKeyDown!(event);
    expect(close).toHaveBeenCalledOnce();
    expect(hooks.set).toHaveBeenCalledWith(false);
  });
});
